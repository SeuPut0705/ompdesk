/**
 * Composer and one-shot session actions answered GUI-side.
 *
 * Stock omp covers some of these through its builtin slash commands, driven
 * headlessly via `prompt` (`/retry`, `/fresh`, `/shake`, `/reload-plugins`,
 * `/prewalk`); their text reply rides `command_output`. The rest read or mutate
 * live session state through the gui-bridge (`resources/gui-bridge/composer.ts`).
 * `get_state` wraps stock's own state with the fields the renderer's
 * `RpcSessionState` adds; stock stays the source of the session identity.
 */
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type {
	RpcActiveTool,
	RpcActiveToolsResult,
	RpcAsyncJobItem,
	RpcJobsResult,
	RpcReloadPluginsResult,
	RpcSessionState,
	RpcThinkingLevelState,
	RpcToolSource,
	ThinkingLevel,
} from "../../shared/rpc-types";
import { runSlashCommand } from "./slash";
import { type LocalCommandContext, LocalCommandError, type LocalHandler } from "./types";

/** `get_state` runs on every hydrate: a stalled bridge must not hold it up. */
const STATE_EXTRAS_TIMEOUT_MS = 2_000;

const BUSY_MESSAGE = "Session is busy (streaming or foreground execution in flight)";

/** `composer.state` (bridge): what stock `get_state` omits. */
interface StateExtras {
	cwd: string;
	autoRetryEnabled: boolean;
	thinkingConfigured: ThinkingLevel | "auto" | undefined;
	planModeEnabled: boolean;
	prewalkArmed: boolean;
	agentsPaused: boolean;
	agentsPausedAt?: number;
	ultrafastSupported: boolean;
	ultrafastEnabled: boolean;
}

/** One `AgentSession.getAsyncJobSnapshot` item as stock reports it. */
interface StockJobItem {
	id: string;
	type: RpcAsyncJobItem["type"];
	status: RpcAsyncJobItem["status"];
	label: string;
	startTime: number;
	endTime?: number;
	agentId?: string;
	cancellationPending?: boolean;
	resultPreview?: string;
	errorPreview?: string;
	previewTruncated?: boolean;
}

/** Bridge extras, or undefined when the bridge is down, fails or stalls. */
async function stateExtras(ctx: LocalCommandContext): Promise<StateExtras | undefined> {
	if (!ctx.bridge.connected) return undefined;
	const stop = new AbortController();
	const timeout = delay(STATE_EXTRAS_TIMEOUT_MS, undefined, { signal: stop.signal }).catch(() => undefined);
	try {
		return await Promise.race([ctx.bridge.request<StateExtras>("composer.state").catch(() => undefined), timeout]);
	} finally {
		stop.abort();
	}
}

/** Stock's `levels` lead with `off`; the renderer's list is the reasoning efforts only (empty = no reasoning). */
function reasoningLevels(levels: readonly string[] | undefined): ThinkingLevel[] {
	return (levels ?? []).filter((level): level is ThinkingLevel => level !== "off");
}

/** `omp plugin list --json` → installed plugin count; 0 when the CLI fails. */
async function pluginCount(ctx: LocalCommandContext): Promise<number> {
	const { code, stdout } = await ctx.omp.run(["plugin", "list", "--json"], { cwd: ctx.cwd, timeoutMs: 30_000 });
	if (code !== 0) return 0;
	try {
		const parsed: unknown = JSON.parse(stdout);
		if (typeof parsed !== "object" || parsed === null) return 0;
		let count = 0;
		for (const list of Object.values(parsed)) if (Array.isArray(list)) count += list.length;
		return count;
	} catch {
		return 0;
	}
}

const evalCommand = z.object({
	code: z.string(),
	language: z.enum(["python", "js", "ruby", "julia"]).optional(),
	excluded: z.boolean().optional(),
});
const bashCommand = z.object({ command: z.string(), excluded: z.boolean().optional() });
const forceToolCommand = z.object({ tool: z.string().optional(), clear: z.boolean().optional() });
const ultrafastCommand = z.object({ enabled: z.boolean() });

export const handlers: Record<string, LocalHandler> = {
	get_state: async (_command, ctx) => {
		const [state, levels, extras] = await Promise.all([
			ctx.send<RpcSessionState>({ type: "get_state" }),
			ctx.send<{ levels?: string[] }>({ type: "get_available_thinking_levels" }).catch(() => undefined),
			stateExtras(ctx),
		]);
		const result: RpcSessionState = {
			...state,
			cwd: extras?.cwd ?? ctx.cwd,
			autoRetryEnabled: extras?.autoRetryEnabled ?? true,
			thinkingConfigured: extras?.thinkingConfigured ?? state.thinkingLevel,
			availableThinkingLevels: reasoningLevels(levels?.levels),
			planModeEnabled: extras?.planModeEnabled ?? false,
			prewalkArmed: extras?.prewalkArmed ?? false,
			agentsPaused: extras?.agentsPaused ?? false,
			ultrafastSupported: extras?.ultrafastSupported ?? false,
			ultrafastEnabled: extras?.ultrafastEnabled ?? false,
		};
		if (extras?.agentsPausedAt !== undefined) result.agentsPausedAt = extras.agentsPausedAt;
		return result;
	},

	// Same user-eval path as the TUI `$`/`$$` modes: the execution is recorded in session history.
	eval: async (command, ctx) => {
		const { code, language = "python", excluded = false } = evalCommand.parse(command);
		if (language !== "python") {
			throw new Error(
				`Interactive eval supports only "python" today (got "${language}"); other backends are agent-tool-only`,
			);
		}
		const result = await ctx.bridge.request<{
			output: string;
			exitCode: number | undefined;
			cancelled: boolean;
			truncated: boolean;
		}>("composer.eval", { code, excluded });
		return { language, code, ...result, excluded };
	},

	abort_eval: async (_command, ctx) => {
		await ctx.bridge.request("composer.abort_eval");
		return undefined;
	},

	// Stock `/fast ultra` / off (no RPC command of its own).
	set_ultrafast_mode: async (command, ctx) =>
		ctx.bridge.request("composer.set_ultrafast", { enabled: ultrafastCommand.parse(command).enabled }),

	// Esc during a manual /compact or handoff (stock's serial queue holds a plain `abort` behind it).
	abort_maintenance: (_command, ctx) => ctx.bridge.request("composer.abort_maintenance"),

	// Stock `bash` ignores `excluded`; only the context-excluded (`!!`) form needs the session.
	bash: async (command, ctx) => {
		const { command: line, excluded } = bashCommand.parse(command);
		if (excluded === true) return ctx.bridge.request("composer.bash_excluded", { command: line });
		return ctx.send({ type: "bash", command: line });
	},

	// Stock /retry acks agentInvoked exactly when a failed turn was re-attempted.
	retry: async (_command, ctx) => {
		const { agentInvoked } = await runSlashCommand(ctx, "/retry");
		return { retried: agentInvoked };
	},

	clear_context: async (_command, ctx) => {
		const result = await ctx.bridge.request<{ droppedCount: number } | null>("composer.clear_context");
		if (!result) throw new LocalCommandError(BUSY_MESSAGE, "busy");
		return { cleared: true, droppedCount: result.droppedCount };
	},

	// Stock /fresh only prints its mid-stream refusal; keep the fork's `busy` code for the renderer's warning toast.
	fresh: async (_command, ctx) => {
		const state = await ctx.send<{ isStreaming?: boolean }>({ type: "get_state" });
		if (state.isStreaming) throw new LocalCommandError(BUSY_MESSAGE, "busy");
		await runSlashCommand(ctx, "/fresh");
		return {};
	},

	// The one-line summary arrives as `command_output`; the renderer toasts its generic success.
	shake_context: async (command, ctx) => {
		const mode = z.enum(["elide", "images", "thinking"]).parse(command.mode);
		await runSlashCommand(ctx, `/shake ${mode}`);
		return {};
	},

	reload_plugins: async (_command, ctx) => {
		await runSlashCommand(ctx, "/reload-plugins");
		const [commands, skills, plugins] = await Promise.all([
			ctx.send<{ commands?: unknown[] }>({ type: "get_available_commands" }),
			ctx.bridge.request<{ skills: number }>("composer.skill_count"),
			pluginCount(ctx),
		]);
		const result: RpcReloadPluginsResult = {
			plugins,
			skills: skills.skills,
			commands: commands.commands?.length ?? 0,
		};
		return result;
	},

	set_force_tool: async (command, ctx) => {
		const { tool, clear } = forceToolCommand.parse(command);
		if ((clear === true) === (tool !== undefined))
			throw new Error("set_force_tool takes exactly one of tool or clear.");
		return ctx.bridge.request("composer.set_force_tool", clear === true ? { clear: true } : { tool });
	},

	get_force_tool: async (_command, ctx) => ctx.bridge.request("composer.get_force_tool"),

	// Arming is stock /prewalk (its resolution/auth failures print as command output); disarming needs the session.
	set_prewalk: async (command, ctx) => {
		const enabled = z.boolean().parse(command.enabled);
		if (!enabled) return ctx.bridge.request("composer.disarm_prewalk");
		await runSlashCommand(ctx, "/prewalk");
		const { armed } = await ctx.bridge.request<{ armed: boolean }>("composer.prewalk_armed");
		if (!armed) throw new Error("Prewalk was not armed; omp reported the reason in the session.");
		return { enabled: true };
	},

	get_active_tools: async (_command, ctx): Promise<RpcActiveToolsResult> => {
		const [state, extras] = await Promise.all([
			ctx.send<RpcSessionState>({ type: "get_state" }),
			ctx.bridge.request<{ sources: Record<string, RpcToolSource>; mounted: RpcActiveTool[] }>(
				"composer.tool_extras",
			),
		]);
		return {
			tools: [
				...(state.dumpTools ?? []).map(tool => ({
					name: tool.name,
					description: tool.description,
					source: extras.sources[tool.name] ?? "extension",
				})),
				...extras.mounted,
			],
		};
	},

	get_context_report: async (_command, ctx) => ctx.bridge.request("composer.context_report"),

	// Context inspector (bridge context-inspect.ts): every entry of the live context with its tokens.
	get_context_inspect: async (command, ctx) =>
		ctx.bridge.request("context.inspect", { entries: z.boolean().optional().parse(command.entries) !== false }),

	get_context_entry: async (command, ctx) =>
		ctx.bridge.request("context.entry", { id: z.string().min(1).parse(command.entryId) }),

	get_jobs: async (_command, ctx) => {
		const items = await ctx.bridge.request<StockJobItem[]>("composer.jobs");
		const result: RpcJobsResult = {
			jobs: items.map(item => ({
				id: item.id,
				type: item.type,
				status: item.status,
				label: item.label,
				startTime: item.startTime,
				...(item.endTime === undefined ? {} : { endedAt: item.endTime }),
				...(item.agentId === undefined ? {} : { agentId: item.agentId }),
				cancellationPending: item.cancellationPending,
				resultPreview: item.resultPreview,
				errorPreview: item.errorPreview,
				previewTruncated: item.previewTruncated,
			})),
		};
		return result;
	},

	cancel_job: async (command, ctx) =>
		ctx.bridge.request("composer.cancel_job", { id: z.string().min(1).parse(command.jobId) }),

	preview_share_session: async (_command, ctx) => ctx.bridge.request("composer.share_preview"),

	share_session: async (command, ctx) =>
		ctx.bridge.request("composer.share", { snapshotId: z.string().optional().parse(command.snapshotId) }),

	// Stock RPC `cycle_model` is forward-only; the session's own cycle (scoped models included) takes a direction.
	cycle_model: async (command, ctx) => {
		const direction = z.enum(["forward", "backward"]).optional().parse(command.direction);
		if (direction === "backward") return ctx.bridge.request("composer.cycle_model_backward");
		return ctx.send({ type: "cycle_model" });
	},

	// Stock acks with no data; the renderer applies the authoritative selector/effective pair.
	set_thinking_level: async (command, ctx) => {
		const level = z.string().min(1).parse(command.level);
		await ctx.send({ type: "set_thinking_level", level });
		const [state, extras] = await Promise.all([ctx.send<RpcSessionState>({ type: "get_state" }), stateExtras(ctx)]);
		const result: RpcThinkingLevelState = {
			thinkingLevel: state.thinkingLevel,
			thinkingConfigured: extras?.thinkingConfigured ?? (level === "auto" ? "auto" : state.thinkingLevel),
		};
		return result;
	},
};
