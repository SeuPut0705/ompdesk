/**
 * The `ompdesk_app` action registry: everything an agent may do to OMPdesk itself, one `AppAction` each (id, area,
 * description, argument schema, tier, how to run it). Which tier a call needs and whether it may touch a given
 * preference, stock setting, RPC command or IPC channel is decided centrally (`app-guard.ts`, `app-channels.ts`,
 * `app-control.ts`); an action here only says what it wants to do through `ActionContext`.
 *
 * The risk table `AGENT_CHANNELS` (app-channels.ts) names, per IPC channel, the actions that call it.
 */

import type { AgentAppEvent, AppUndo } from "../../shared/agent-control";
import { AGENT_PANEL_TABS, AGENT_VIEW_SHEETS } from "../../shared/agent-control";
import type { DiagnosticBundleResult } from "../../shared/diagnostic-bundle";
import type { DiskCareState } from "../../shared/disk-care";
import { type HostView, IPC_COMMANDS, type RemoteState, type TailnetComputer } from "../../shared/ipc-types";
import {
	MOBILE_WEB_COMMAND,
	MOBILE_WEB_GET_STATE,
	WEB_BLOCKS_LIST,
	WEB_BLOCKS_REMOVE,
	WEB_DEVICES_LIST,
	WEB_DEVICES_RENAME,
	type WebBlockedInfo,
	type WebDeviceInfo,
} from "../../shared/mobile-web";
import type { RpcCommand } from "../../shared/rpc-types";
import { APPROVAL_MODES } from "../../shared/tool-approval";
import { AppRefusal, type Tier } from "./app-guard";
import { type ArgsSchema, NO_ARGS, objectSchema } from "./app-schema";
import { type ManageRule, SETTINGS, type Setting, settingActionId } from "./app-settings";

/** What an action returns: text for the agent, and, when it changed something, what to journal and toast. */
export interface ActionResult {
	text: string;
	change?: AppChange;
}

export interface AppChange {
	en: string;
	ko: string;
	/** The new value as shown to the person. */
	value: string;
	/** One step back, present only when there was a previous value to restore. */
	undo?: AppUndo;
}

/**
 * The only things an action can do. Each method runs the central checks first (the action's granted tier against
 * the tier the preference, setting, command or channel needs; `never` always refuses), so a route through another
 * command meets the same rule as a direct call.
 */
export interface ActionContext {
	readonly callerTabId: string;
	/**
	 * The paired host the calling session's tab runs on; undefined = this computer. The Settings UI acts on that
	 * host for its `host` sections (`SECTION_SCOPE`), so an action that has a host route takes it from here.
	 */
	readonly device: string | undefined;
	/** A preference's value: this computer's, or the paired host's for a row its Settings control sends there. */
	getPref(key: string): Promise<unknown>;
	/** Write a stored preference through the same handler Settings uses (the host's own for a `HOST_PREFS` row), then tell the window to apply it. */
	setPref(key: string, value: unknown): Promise<void>;
	/** Send an RPC command to the calling session; resolves with the response data and throws on failure. */
	rpc(command: RpcCommand): Promise<unknown>;
	/** Call an invoke channel's handler (`channel` must list the running action in `AGENT_CHANNELS`). */
	invoke(channel: string, ...args: unknown[]): Promise<unknown>;
	/** Call a fire-and-forget channel's handler. */
	fire(channel: string, ...args: unknown[]): void;
	ui(event: AgentAppEvent): void;
	/** Run `ompdesk_autopilot` with these arguments: its confirmation card and folder rules apply. */
	autopilot(args: Record<string, unknown>): Promise<string>;
	/** Restore the last change this session's agent made (asks again when that change needed a card). */
	undoLast(): Promise<ActionResult>;
}

export interface AppAction {
	id: string;
	area: string;
	description: string;
	args: ArgsSchema;
	tier: Tier;
	/** Why a `never` action exists: shown to the agent so it does not try another route. */
	neverReason?: string;
	/** Required on a `sensitive` action: whether `agentControlManage` lifts its card, or it always asks, and why. */
	manage?: ManageRule;
	/** Present on an action that runs only while the person gave agents full control (`agentControlFull`); why it is refused otherwise. */
	fullOnly?: string;
	/** What the confirmation card says is about to happen, in full (exact command, url, arguments). */
	describe?: (args: Record<string, unknown>) => string;
	/** Absent for a `never` action. */
	run?: (ctx: ActionContext, args: Record<string, unknown>) => Promise<ActionResult>;
}

const SETTINGS_SECTIONS = [
	"general",
	"appearance",
	"keyboard",
	"models",
	"agent",
	"memory",
	"tools",
	"permissions",
	"workspace",
	"schedules",
	"connections",
	"updates",
	"advanced",
] as const;

export { SETTINGS_SECTIONS };

const C = IPC_COMMANDS;

const diskSize = (bytes: number): string =>
	bytes >= 1_073_741_824 ? `${(bytes / 1_073_741_824).toFixed(1)} GB` : `${(bytes / 1_048_576).toFixed(1)} MB`;

/** The disk care state as one short report for the agent. */
function diskText(state: DiskCareState): string {
	const lines: string[] = [];
	if (state.usage) {
		lines.push(
			`OMPdesk uses ${diskSize(state.usage.total)}: ${state.usage.parts.map(part => `${part.id} ${diskSize(part.bytes)}`).join(", ")}.`,
		);
	} else lines.push("Disk use is not measured yet.");
	const run = state.lastRun;
	if (run) {
		const actions = run.actions
			.map(action => `${action.kind} ${action.count} (${diskSize(action.bytes)})`)
			.join(", ");
		lines.push(
			`Last cleanup (${run.trigger}, ${new Date(run.endedAt).toISOString()}) freed ${diskSize(run.freedBytes)}${actions ? `: ${actions}` : ""}; ${run.kept} idle worktrees kept, ${run.failed} failed.`,
		);
	} else lines.push("No cleanup has run yet.");
	if (state.running) lines.push("A cleanup is running now.");
	return lines.join(" ");
}

const shown = (value: unknown): string =>
	typeof value === "string" ? value : typeof value === "boolean" ? (value ? "on" : "off") : JSON.stringify(value);

function stockValue(data: unknown, path: string): unknown {
	if (data && typeof data === "object" && "values" in data && data.values && typeof data.values === "object")
		return (data.values as Record<string, unknown>)[path];
	return undefined;
}

async function readStock(ctx: ActionContext, path: string): Promise<unknown> {
	return stockValue(await ctx.rpc({ type: "get_settings", paths: [path] }), path);
}

async function writeSetting(ctx: ActionContext, row: Setting, value: unknown): Promise<ActionResult> {
	const label = `${row.en}`;
	if (row.kind === "stock") {
		const previous = await readStock(ctx, row.path);
		await ctx.rpc({ type: "set_setting", path: row.path, value });
		return {
			text: `${row.en} is now ${shown(value)}.`,
			change: {
				en: label,
				ko: row.ko,
				value: shown(value),
				...(previous === undefined || previous === null
					? {}
					: { undo: { kind: "setting", path: row.path, value: previous } }),
			},
		};
	}
	const previous = row.redact ? undefined : await ctx.getPref(row.key);
	const stored = value === "" ? null : value;
	await ctx.setPref(row.key, stored);
	for (const [key, derive] of Object.entries(row.mirror ?? {})) await ctx.setPref(key, derive(value));
	return {
		text: `${row.en} is now ${row.redact ? "set" : shown(value)}.`,
		change: {
			en: label,
			ko: row.ko,
			value: row.redact ? "…" : shown(value),
			...(previous === undefined || previous === null
				? {}
				: { undo: { kind: "pref", key: row.key, value: previous } }),
		},
	};
}

function settingAction(row: Setting): AppAction {
	const hint =
		row.schema.type === "string" && row.schema.enum
			? ` One of: ${row.schema.enum.join(", ")}.`
			: row.schema.type === "boolean"
				? " true or false."
				: "";
	return {
		id: settingActionId(row.id),
		area: `settings/${row.area}`,
		description: `Set "${row.en}".${hint}`,
		args: objectSchema({ value: row.schema }, ["value"]),
		tier: row.tier,
		...(row.manage ? { manage: row.manage } : {}),
		run: (ctx, args) => writeSetting(ctx, row, args.value),
	};
}

function describeUsage(data: unknown): string {
	const reports =
		data && typeof data === "object" && "reports" in data && Array.isArray(data.reports) ? data.reports : [];
	if (reports.length === 0) return "No provider usage reports yet (no signed-in account reports a quota).";
	return reports
		.map((report: { provider?: string; account?: string; limits?: Array<Record<string, unknown>> }) => {
			const limits = (report.limits ?? []).map(limit => {
				const used =
					typeof limit.usedFraction === "number" ? `${Math.round(limit.usedFraction * 100)}% used` : "n/a";
				return `${String(limit.windowLabel ?? limit.label ?? limit.id)} ${used}`;
			});
			return `- ${report.provider ?? "?"}${report.account ? ` (${report.account})` : ""}: ${limits.join("; ") || "no windows"}`;
		})
		.join("\n");
}

function lines(values: readonly unknown[], pick: (value: Record<string, unknown>) => string, empty: string): string {
	const rows = values.filter((value): value is Record<string, unknown> => value !== null && typeof value === "object");
	return rows.length === 0 ? empty : rows.map(pick).join("\n");
}

const text = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);

const never = (id: string, area: string, description: string, neverReason: string): AppAction => ({
	id,
	area,
	description,
	args: NO_ARGS,
	tier: "never",
	neverReason,
});

const SESSION_PATH = {
	type: "string",
	minLength: 1,
	maxLength: 4096,
	description: "Session file path (.jsonl) from sessions.saved.",
} as const;

/**
 * What `agent_power.set` can switch under full control: the switches that bound an agent's own power. A pref goes
 * through `PREFS_SET`, a stock setting through `set_setting`, and the two memory switches through ai-memory's own
 * channel (they start or stop its service, which a bare pref write would not).
 */
const POWER_SWITCHES: Record<
	string,
	{ en: string; ko: string } & (
		| { kind: "pref"; key: string }
		| { kind: "stock"; path: string }
		| { kind: "channel"; channel: string; key: string }
	)
> = {
	agentControl: { en: "OMPdesk control tools", ko: "OMPdesk 제어 도구", kind: "pref", key: "agentControl" },
	agentControlFull: {
		en: "Give agents full control of OMPdesk",
		ko: "에이전트에게 OMPdesk 모든 권한",
		kind: "pref",
		key: "agentControlFull",
	},
	agentControlManage: {
		en: "Let agents manage other sessions",
		ko: "에이전트가 다른 세션 관리하기",
		kind: "pref",
		key: "agentControlManage",
	},
	agentControlApprove: {
		en: "Let agents approve for other sessions",
		ko: "에이전트가 다른 세션 승인 대신하기",
		kind: "pref",
		key: "agentControlApprove",
	},
	pstack: { en: "Engineering mode (pstack)", ko: "엔지니어링 모드 (pstack)", kind: "pref", key: "pstack" },
	ecc: { en: "ECC skills", ko: "ECC 스킬", kind: "pref", key: "ecc" },
	aiMemoryLearn: { en: "Learn from conversations", ko: "대화에서 배우기", kind: "pref", key: "aiMemoryLearn" },
	aiMemory: {
		en: "Memory",
		ko: "메모리",
		kind: "channel",
		channel: IPC_COMMANDS.AI_MEMORY_SET_ENABLED,
		key: "aiMemory",
	},
	aiMemoryTerminal: {
		en: "Memory in the terminal omp",
		ko: "터미널 omp에서도 메모리 쓰기",
		kind: "channel",
		channel: IPC_COMMANDS.AI_MEMORY_SET_TERMINAL,
		key: "aiMemoryTerminal",
	},
	"computer.enabled": { en: "Computer use", ko: "컴퓨터 사용", kind: "stock", path: "computer.enabled" },
	"tools.approvalMode": { en: "Tool approval", ko: "도구 승인", kind: "stock", path: "tools.approvalMode" },
};

async function setPowerSwitch(ctx: ActionContext, args: Record<string, unknown>): Promise<ActionResult> {
	const name = String(args.switch);
	const entry = POWER_SWITCHES[name];
	if (!entry) throw new AppRefusal(`Unknown switch ${name}.`);
	const value = name === "tools.approvalMode" ? args.mode : args.on;
	if (name === "tools.approvalMode" ? typeof value !== "string" : typeof value !== "boolean")
		throw new AppRefusal(name === "tools.approvalMode" ? "tools.approvalMode needs mode." : `${name} needs on.`);
	const previous =
		entry.kind === "stock"
			? await readStock(ctx, entry.path)
			: entry.kind === "pref"
				? await ctx.getPref(entry.key)
				: undefined;
	if (entry.kind === "pref") await ctx.setPref(entry.key, value);
	else if (entry.kind === "stock") await ctx.rpc({ type: "set_setting", path: entry.path, value });
	else await ctx.invoke(entry.channel, value);
	const undo =
		previous === undefined || previous === null || entry.kind === "channel"
			? undefined
			: entry.kind === "pref"
				? ({ kind: "pref", key: entry.key, value: previous } as const)
				: ({ kind: "setting", path: entry.path, value: previous } as const);
	return {
		text: `${entry.en} is now ${shown(value)}.`,
		change: { en: entry.en, ko: entry.ko, value: shown(value), ...(undo ? { undo } : {}) },
	};
}

const HOST_ARGS = objectSchema({
	host: {
		type: "boolean",
		description:
			"true: the paired host this session runs on, not this computer. Refused for a session on this computer.",
	},
});

/** The paired host a `host: true` call acts on, as the Settings › Updates host rows do; a session on this computer has none. */
function updateHost(ctx: ActionContext, args: Record<string, unknown>): string | undefined {
	if (args.host !== true) return undefined;
	if (!ctx.device) throw new AppRefusal("This session runs on this computer, not on a paired host: leave host out.");
	return ctx.device;
}

/** The caller's paired host goes into a `sessions:*` payload the way the sidebar's does; a session on this computer sends none. */
const onCallerDevice = (ctx: ActionContext): { device?: string } => (ctx.device ? { device: ctx.device } : {});

const SCOPE = {
	type: "string",
	enum: ["local", "global"],
	description: "local: this folder's sessions; global (default): all.",
} as const;

const SIGN_IN_NOTE =
	"Only starts the existing sign-in flow (a browser page or a code the person completes); it never reads or stores a credential.";

export const APP_ACTIONS: readonly AppAction[] = [
	{
		id: "settings.get",
		area: "settings",
		description:
			'Read the current value of settings rows (ids as ompdesk_app_list shows after "settings."); all rows when ids is omitted. Secrets are never shown.',
		args: objectSchema({ ids: { type: "array", items: { type: "string", maxLength: 100 }, maxItems: 80 } }),
		tier: "read",
		run: async (ctx, args) => {
			const wanted = Array.isArray(args.ids) ? new Set(args.ids as string[]) : null;
			const rows = SETTINGS.filter(row => !wanted || wanted.has(row.id));
			const stockRows = rows.filter(row => row.kind === "stock");
			const stockData =
				stockRows.length > 0
					? await ctx.rpc({ type: "get_settings", paths: stockRows.map(row => row.id) }).catch(() => undefined)
					: undefined;
			const out = await Promise.all(
				rows.map(async row => {
					const redact = row.kind === "pref" && row.redact === true;
					let display: string;
					try {
						const value = row.kind === "stock" ? stockValue(stockData, row.path) : await ctx.getPref(row.key);
						display = redact ? (value ? "(set)" : "(unset)") : value === undefined ? "(default)" : shown(value);
					} catch {
						// A row the host holds fails to read while the host is offline; the other rows still answer.
						display = "(unreachable)";
					}
					return `- ${row.id}: ${display}${row.tier === "sensitive" ? " [asks the user]" : ""}`;
				}),
			);
			return { text: out.length > 0 ? out.join("\n") : "No settings row matches." };
		},
	},
	{
		id: "usage.read",
		area: "usage",
		description:
			"Provider usage and quota windows of the signed-in accounts (what the Usage view shows). refresh asks the providers now.",
		args: objectSchema({ refresh: { type: "boolean" } }),
		tier: "read",
		run: async (ctx, args) => ({
			text: describeUsage(await ctx.rpc({ type: "get_usage", refresh: args.refresh === true })),
		}),
	},
	{
		id: "models.list",
		area: "models",
		description: "Models this session can use (provider and id).",
		args: NO_ARGS,
		tier: "read",
		run: async ctx => {
			const data = await ctx.rpc({ type: "get_available_models" });
			const models =
				data && typeof data === "object" && "models" in data && Array.isArray(data.models) ? data.models : [];
			return { text: lines(models, model => `- ${text(model.provider)}/${text(model.id)}`, "No models available.") };
		},
	},
	{
		id: "models.set",
		area: "models",
		description: "Switch this session's model.",
		args: objectSchema(
			{
				provider: { type: "string", minLength: 1, maxLength: 100 },
				modelId: { type: "string", minLength: 1, maxLength: 200 },
			},
			["provider", "modelId"],
		),
		tier: "change",
		run: async (ctx, args) => {
			await ctx.rpc({ type: "set_model", provider: String(args.provider), modelId: String(args.modelId) });
			const value = `${String(args.provider)}/${String(args.modelId)}`;
			return { text: `This session now uses ${value}.`, change: { en: "Model", ko: "모델", value } };
		},
	},
	{
		id: "models.set_role",
		area: "models",
		description:
			"Assign a model to a model role (default, slow, smol, plan, task, ...); omit modelId to clear the role.",
		args: objectSchema(
			{
				role: { type: "string", minLength: 1, maxLength: 60 },
				modelId: { type: "string", minLength: 1, maxLength: 200 },
			},
			["role"],
		),
		tier: "change",
		run: async (ctx, args) => {
			const modelId = typeof args.modelId === "string" ? args.modelId : null;
			await ctx.rpc({ type: "set_model_role", role: String(args.role), modelId });
			return {
				text: modelId ? `Role ${String(args.role)} now uses ${modelId}.` : `Role ${String(args.role)} cleared.`,
				change: {
					en: `Model role ${String(args.role)}`,
					ko: `모델 역할 ${String(args.role)}`,
					value: modelId ?? "(cleared)",
				},
			};
		},
	},
	{
		id: "ui.panel",
		area: "ui",
		description:
			"Open a side panel view (terminal, diff, preview, files), open a session view as a sheet (jobs = background tasks, plan = the plan document, logs, tree = the session tree, work = the work tree), or close the panel.",
		args: objectSchema({ tab: { type: "string", enum: [...AGENT_PANEL_TABS, ...AGENT_VIEW_SHEETS, "close"] } }, [
			"tab",
		]),
		tier: "change",
		run: async (ctx, args) => {
			const tab = args.tab as (typeof AGENT_PANEL_TABS)[number] | (typeof AGENT_VIEW_SHEETS)[number] | "close";
			ctx.ui({ kind: "panel", tab: tab === "close" ? null : tab });
			const sheet = (AGENT_VIEW_SHEETS as readonly string[]).includes(tab);
			return {
				text:
					tab === "close"
						? "Side panel closed."
						: sheet
							? `The ${tab} sheet is open.`
							: `Side panel shows ${tab}.`,
			};
		},
	},
	{
		id: "ui.settings_open",
		area: "ui",
		description: "Open Settings at a section (for the user to look at or to finish a step only they may do).",
		args: objectSchema(
			{ section: { type: "string", enum: [...SETTINGS_SECTIONS] }, sub: { type: "string", maxLength: 60 } },
			["section"],
		),
		tier: "change",
		run: async (ctx, args) => {
			ctx.ui({
				kind: "settings",
				section: String(args.section),
				...(typeof args.sub === "string" ? { sub: args.sub } : {}),
			});
			return { text: `Settings opened at ${String(args.section)}.` };
		},
	},
	{
		id: "sessions.saved",
		area: "sessions",
		description:
			"Saved sessions on the computer this session runs on (a paired host's own when it runs there): title, folder, last change, path.",
		args: objectSchema({ scope: SCOPE }),
		tier: "read",
		run: async (ctx, args) => {
			const sessions = await ctx.invoke(C.SESSIONS_LIST, {
				scope: args.scope === "local" ? "local" : "global",
				...onCallerDevice(ctx),
			});
			const rows = Array.isArray(sessions) ? sessions.slice(0, 50) : [];
			return {
				text: lines(
					rows,
					row =>
						`- ${text(row.title, "(untitled)")} · ${text(row.cwd)} · ${text(row.modified)} · ${text(row.path)}`,
					"No saved sessions.",
				),
			};
		},
	},
	{
		id: "sessions.search",
		area: "sessions",
		description: "Search the text of saved sessions.",
		args: objectSchema({ query: { type: "string", minLength: 1, maxLength: 200 }, scope: SCOPE }, ["query"]),
		tier: "read",
		run: async (ctx, args) => {
			const hits = await ctx.invoke(C.SESSIONS_SEARCH, {
				query: String(args.query),
				scope: args.scope === "local" ? "local" : "global",
				...onCallerDevice(ctx),
			});
			const rows = Array.isArray(hits) ? hits.slice(0, 30) : [];
			return { text: lines(rows, row => `- ${text(row.path)}: ${text(row.snippet)}`, "No matches.") };
		},
	},
	{
		id: "sessions.rename",
		area: "sessions",
		description: "Rename a saved session.",
		args: objectSchema({ sessionPath: SESSION_PATH, name: { type: "string", minLength: 1, maxLength: 200 } }, [
			"sessionPath",
			"name",
		]),
		tier: "change",
		run: async (ctx, args) => {
			await ctx.invoke(C.SESSIONS_RENAME, {
				sessionPath: String(args.sessionPath),
				name: String(args.name),
				...onCallerDevice(ctx),
			});
			return { text: "Renamed.", change: { en: "Session name", ko: "세션 이름", value: String(args.name) } };
		},
	},
	{
		id: "sessions.delete",
		area: "sessions",
		description: "Delete a saved session file for good.",
		args: objectSchema({ sessionPath: SESSION_PATH }, ["sessionPath"]),
		tier: "sensitive",
		manage: { always: "deleting a saved session is irreversible" },
		run: async (ctx, args) => {
			await ctx.invoke(C.SESSIONS_DELETE, { sessionPath: String(args.sessionPath), ...onCallerDevice(ctx) });
			return {
				text: "Deleted.",
				change: { en: "Deleted a saved session", ko: "저장된 세션 삭제", value: String(args.sessionPath) },
			};
		},
	},
	{
		id: "sessions.dump_bundle",
		area: "sessions",
		description:
			"Save a diagnostic bundle as a zip file and return its path: stock's /dump archive of an open session plus OMPdesk's own diagnostics text. Anonymized by default (message contents redacted); pass anonymized:false only when the person asked for the raw transcript. Writes to path, else the Downloads folder. Needs the session open in a tab; defaults to this session.",
		args: objectSchema({
			session: {
				...SESSION_PATH,
				description:
					"Session file path (.jsonl) of an open session, from sessions.saved. Default: this session. A session the person hid from agents is refused.",
			},
			anonymized: {
				type: "boolean",
				description: "Default true: stock's /dump anon. false: /dump all, the raw transcript.",
			},
			path: {
				type: "string",
				minLength: 1,
				maxLength: 4096,
				description:
					"Absolute path of the zip to write (.zip is added when missing). Default: the Downloads folder.",
			},
		}),
		tier: "change",
		run: async (ctx, args) => {
			const result = (await ctx.invoke(C.SESSIONS_DUMP_BUNDLE, {
				...(typeof args.session === "string"
					? { sessionPath: args.session, ...(ctx.device ? { device: ctx.device } : {}) }
					: { tabId: ctx.callerTabId }),
				anonymized: args.anonymized !== false,
				destination: typeof args.path === "string" ? { kind: "path", path: args.path } : { kind: "downloads" },
				forAgent: true,
			})) as DiagnosticBundleResult;
			if (!result.ok) throw new AppRefusal(result.cancelled ? "The save was cancelled." : result.error);
			return {
				text: `Saved the ${result.anonymized ? "anonymized " : ""}diagnostic bundle (${result.files.join(", ")}) to ${result.path}.`,
				change: { en: "Saved a diagnostic bundle", ko: "진단 묶음 저장", value: result.path },
			};
		},
	},
	{
		id: "updates.status",
		area: "updates",
		description:
			"The state of OMPdesk's own update (idle, available, downloaded, ...). host: true reads the paired host this session runs on instead of this computer.",
		args: HOST_ARGS,
		tier: "read",
		run: async (ctx, args) => {
			const device = updateHost(ctx, args);
			const answer = device ? await ctx.invoke(C.HOST_DESKTOP_GET, device) : await ctx.invoke(C.UPDATER_GET_STATUS);
			const host = device && answer && typeof answer === "object" ? (answer as Record<string, unknown>) : null;
			const status = host ? host.update : answer;
			const state = status && typeof status === "object" && "state" in status ? String(status.state) : "unknown";
			const version =
				status && typeof status === "object" && "version" in status ? ` ${String(status.version)}` : "";
			return {
				text: `${host ? `The paired host runs OMPdesk ${text(host.version, "?")}. ` : ""}Update state: ${state}${version}.`,
			};
		},
	},
	{
		id: "updates.check",
		area: "updates",
		description:
			"Check for a new OMPdesk version now (contacts the release server). host: true asks the paired host this session runs on to check its own.",
		args: HOST_ARGS,
		tier: "sensitive",
		manage: {
			lifts: "only contacts the release server; nothing is downloaded into use or applied (updates.apply asks)",
		},
		run: async (ctx, args) => {
			const device = updateHost(ctx, args);
			if (device) await ctx.invoke(C.HOST_DESKTOP_UPDATE, "check", device);
			else await ctx.invoke(C.UPDATER_CHECK);
			return {
				text: `Update check ${device ? "ran on the paired host" : "started"}; read updates.status${device ? " with host: true" : ""} for the result.`,
			};
		},
	},
	{
		id: "updates.apply",
		area: "updates",
		description:
			"Install the downloaded OMPdesk update and restart the app (every running turn ends). host: true asks the paired host this session runs on to install and restart its own; it refuses while work runs there.",
		args: HOST_ARGS,
		tier: "sensitive",
		manage: { always: "installs new code and restarts, ending every running turn" },
		describe: args =>
			args.host === true
				? "Install the downloaded OMPdesk update on the paired host this session runs on and restart that computer's app (its running turns end)"
				: "Install the downloaded OMPdesk update and restart the app (every running turn ends).",
		run: async (ctx, args) => {
			const device = updateHost(ctx, args);
			if (device) await ctx.invoke(C.HOST_DESKTOP_UPDATE, "install", device);
			else await ctx.invoke(C.UPDATER_APPLY);
			return { text: `Applying the update; ${device ? "the paired host's " : ""}OMPdesk restarts.` };
		},
	},
	{
		id: "disk.status",
		area: "updates",
		description:
			"How much disk OMPdesk uses on this computer (worktrees, sessions, logs, stats, app data, Bun cache) and what the last disk cleanup freed.",
		args: NO_ARGS,
		tier: "read",
		run: async ctx => ({ text: diskText((await ctx.invoke(C.DISK_CARE_GET_STATE)) as DiskCareState) }),
	},
	{
		id: "disk.clean",
		area: "updates",
		description:
			"Run disk care now on this computer and wait for it: drops build output and dependencies from worktrees idle 3+ days (the project makes them again) and saves then removes worktrees idle 14+ days (restorable from the Work tree view). Nothing the user could lose is deleted.",
		args: NO_ARGS,
		tier: "change",
		run: async ctx => ({ text: diskText((await ctx.invoke(C.DISK_CARE_RUN)) as DiskCareState) }),
	},
	{
		id: "app.quit",
		area: "app",
		description: "Quit OMPdesk (every running turn ends).",
		args: NO_ARGS,
		tier: "sensitive",
		manage: { always: "quitting ends every running turn" },
		run: async ctx => {
			ctx.fire(C.APP_QUIT);
			return { text: "Quitting OMPdesk." };
		},
	},
	{
		id: "accounts.github_status",
		area: "accounts",
		description: "Whether GitHub CLI is signed in and as which login.",
		args: NO_ARGS,
		tier: "read",
		run: async ctx => {
			const state = await ctx.invoke(C.GITHUB_AUTH_REFRESH, false);
			const status = state && typeof state === "object" && "status" in state ? state.status : null;
			if (!status || typeof status !== "object") return { text: "GitHub status is not known yet." };
			const record = status as Record<string, unknown>;
			return {
				text: record.authenticated
					? `Signed in to GitHub as ${text(record.login, "?")}.`
					: "Not signed in to GitHub.",
			};
		},
	},
	{
		id: "accounts.github_sign_in",
		area: "accounts",
		description: `Start GitHub sign-in. ${SIGN_IN_NOTE}`,
		args: NO_ARGS,
		tier: "sensitive",
		manage: { always: "signing in connects the person's account (a credential)" },
		run: async ctx => {
			await ctx.invoke(C.GITHUB_AUTH_LOGIN_START);
			return { text: "GitHub sign-in started: the person finishes it in the window." };
		},
	},
	{
		id: "accounts.provider_sign_in",
		area: "accounts",
		description: `Start sign-in for a model provider. ${SIGN_IN_NOTE}`,
		args: objectSchema({ providerId: { type: "string", minLength: 1, maxLength: 100 } }, ["providerId"]),
		tier: "sensitive",
		manage: { always: "signing in connects the person's account (a credential)" },
		run: async (ctx, args) => {
			await ctx.rpc({ type: "login", providerId: String(args.providerId) });
			return { text: `Sign-in for ${String(args.providerId)} started: the person finishes it in the window.` };
		},
	},
	{
		id: "mobile_web.status",
		area: "mobile_web",
		description: "Whether the phone page is on and its state (the link is not shown).",
		args: NO_ARGS,
		tier: "read",
		run: async ctx => {
			const state = await ctx.invoke(MOBILE_WEB_GET_STATE);
			const record = state && typeof state === "object" ? (state as Record<string, unknown>) : {};
			return { text: `Mobile web: ${record.enabled ? "on" : "off"}, phase ${text(record.phase, "unknown")}.` };
		},
	},
	{
		id: "mobile_web.set_enabled",
		area: "mobile_web",
		description: "Turn the phone page on or off (it exposes this computer's sessions to the person's tailnet).",
		args: objectSchema({ enabled: { type: "boolean" } }, ["enabled"]),
		tier: "sensitive",
		manage: {
			always: "turning it on exposes this computer's sessions on the network (turning it off exposes nothing)",
			when: args => args.enabled === true,
		},
		run: async (ctx, args) => {
			await ctx.invoke(MOBILE_WEB_COMMAND, { action: args.enabled === true ? "enable" : "disable" });
			return {
				text: `Mobile web ${args.enabled === true ? "enabled" : "disabled"}.`,
				change: { en: "Mobile web", ko: "모바일 웹", value: shown(args.enabled === true) },
			};
		},
	},
	{
		id: "extensions.install_plugin",
		area: "extensions",
		description: "Install a plugin from a marketplace the person already added (it runs code in every session).",
		args: objectSchema(
			{
				marketplace: { type: "string", minLength: 1, maxLength: 200 },
				plugin: { type: "string", minLength: 1, maxLength: 200 },
			},
			["marketplace", "plugin"],
		),
		tier: "sensitive",
		manage: { always: "a plugin is arbitrary code that runs in every session" },
		run: async (ctx, args) => {
			await ctx.rpc({
				type: "marketplace_action",
				action: "install",
				marketplace: String(args.marketplace),
				plugin: String(args.plugin),
			});
			return {
				text: `Installed ${String(args.plugin)}.`,
				change: { en: "Installed plugin", ko: "플러그인 설치", value: String(args.plugin) },
			};
		},
	},
	{
		id: "memory.purge",
		area: "memory",
		description: "Erase the user's memory for good: every page, handoff and recorded session.",
		args: NO_ARGS,
		tier: "sensitive",
		manage: { always: "erasing the memory is irreversible" },
		run: async ctx => {
			await ctx.invoke(C.AI_MEMORY_PURGE);
			return { text: "Memory erased.", change: { en: "Memory", ko: "메모리", value: "erased" } };
		},
	},
	{
		id: "memory.delete_page",
		area: "memory",
		description: "Delete one memory page (the Memory page's Restore can bring it back).",
		args: objectSchema(
			{
				workspace: { type: "string", minLength: 1, maxLength: 200 },
				project: { type: "string", minLength: 1, maxLength: 200 },
				path: { type: "string", minLength: 1, maxLength: 500 },
			},
			["workspace", "project", "path"],
		),
		tier: "sensitive",
		manage: { always: "deleting a memory page erases the person's data" },
		describe: args =>
			`Delete the memory page ${String(args.path)} of ${String(args.workspace)}/${String(args.project)}`,
		run: async (ctx, args) => {
			await ctx.invoke(C.AI_MEMORY_DELETE_PAGE, {
				workspace: String(args.workspace),
				project: String(args.project),
				path: String(args.path),
			});
			return {
				text: `Deleted ${String(args.path)}.`,
				change: { en: "Memory page", ko: "메모리 페이지", value: `deleted ${String(args.path)}` },
			};
		},
	},
	{
		id: "memory.sweep",
		area: "memory",
		description: "Run the memory retention sweep for one project (evicts pages the aging rules let go).",
		args: objectSchema(
			{
				workspace: { type: "string", minLength: 1, maxLength: 200 },
				project: { type: "string", minLength: 1, maxLength: 200 },
			},
			["workspace", "project"],
		),
		tier: "sensitive",
		manage: { always: "the sweep evicts memory pages: it erases the person's data" },
		run: async (ctx, args) => {
			const result = await ctx.invoke(
				C.AI_MEMORY_SWEEP,
				{ workspace: String(args.workspace), project: String(args.project) },
				false,
			);
			const evicted = result && typeof result === "object" ? (result as { evicted?: unknown }).evicted : 0;
			return {
				text: `Memory sweep done: ${typeof evicted === "number" ? evicted : 0} evicted.`,
				change: { en: "Memory", ko: "메모리", value: "swept" },
			};
		},
	},
	{
		id: "app.undo",
		area: "app",
		description: "Undo the last change you made with ompdesk_app, when it had a previous value.",
		args: NO_ARGS,
		tier: "change",
		run: ctx => ctx.undoLast(),
	},
	{
		id: "agent_power.set",
		area: "permissions",
		description:
			"Change what agents may do: OMPdesk control tools, full control, managing or approving for other sessions, tool approval mode, memory, engineering mode or computer use. Booleans take on; tools.approvalMode takes mode.",
		args: objectSchema(
			{
				switch: { type: "string", enum: Object.keys(POWER_SWITCHES) },
				on: { type: "boolean" },
				mode: { type: "string", enum: [...APPROVAL_MODES] },
			},
			["switch"],
		),
		tier: "sensitive",
		fullOnly:
			"These switches bound the agent's own power. Only the person changes them, in Settings, unless they give agents full control of OMPdesk.",
		manage: { always: "these switches bound what every agent may do; only full control lets an agent change them" },
		run: setPowerSwitch,
	},
	never(
		"cards.answer",
		"permissions",
		"Answer an [OMPdesk] confirmation card or a tool approval.",
		"A card exists to ask the person. ompdesk_session_answer refuses it too.",
	),
	never(
		"credentials.read",
		"accounts",
		"Read an API key, token, password, proxy credential or the sign-in state of an account.",
		"Secrets never reach an agent. Use accounts.*_status for who is signed in.",
	),
	{
		id: "extensions.install_mcp",
		area: "extensions",
		description:
			"Add an MCP server (stdio: it starts a program; http/sse: it reaches a service). The user sees the exact command or url first. No env or headers: secrets are never set by an agent.",
		args: objectSchema(
			{
				name: { type: "string", minLength: 1, maxLength: 80 },
				transport: { type: "string", enum: ["stdio", "http", "sse"] },
				command: { type: "string", minLength: 1, maxLength: 500 },
				args: { type: "array", items: { type: "string", maxLength: 500 }, maxItems: 30 },
				url: { type: "string", minLength: 8, maxLength: 1000 },
				scope: { type: "string", enum: ["user", "project"] },
			},
			["name", "transport"],
		),
		tier: "sensitive",
		manage: { always: "an MCP server is arbitrary code (stdio) or a network reach (http/sse) for every session" },
		describe: args => {
			const where =
				args.transport === "stdio"
					? `runs: ${[args.command, ...((args.args as string[]) ?? [])].join(" ")}`
					: `connects to: ${String(args.url)}`;
			return `add the MCP server "${String(args.name)}" (${String(args.transport)}, ${String(args.scope ?? "user")} scope), which ${where}`;
		},
		run: async (ctx, args) => {
			const stdio = args.transport === "stdio";
			if (stdio && typeof args.command !== "string") throw new AppRefusal("stdio needs command.");
			if (!stdio && (typeof args.url !== "string" || !/^https?:\/\//.test(args.url)))
				throw new AppRefusal("http and sse need an http(s) url.");
			const config = stdio
				? {
						transport: "stdio" as const,
						command: String(args.command),
						...(Array.isArray(args.args) ? { args: args.args as string[] } : {}),
					}
				: { transport: args.transport as "http" | "sse", url: String(args.url) };
			await ctx.rpc({
				type: "mcp_add",
				name: String(args.name),
				config,
				scope: args.scope === "project" ? "project" : "user",
			});
			return {
				text: `Added MCP server ${String(args.name)}.`,
				change: { en: "Added MCP server", ko: "MCP 서버 추가", value: String(args.name) },
			};
		},
	},
	{
		id: "remote.list_tailnet",
		area: "connections",
		description:
			"List the computers on the person's tailnet as this one sees them (node id, name, login, whether OMPdesk shares it and lets this computer in, and whether this computer already uses it).",
		args: NO_ARGS,
		tier: "read",
		run: async ctx => {
			const computers = (await ctx.invoke(C.REMOTE_WATCH_TAILNET, true)) as TailnetComputer[];
			await ctx.invoke(C.REMOTE_WATCH_TAILNET, false);
			if (computers.length === 0) return { text: "No other computer of the tailnet is online." };
			return {
				text: computers
					.map(
						computer =>
							`node ${computer.nodeId}: ${computer.name}${computer.login ? ` (${computer.login})` : ""}, ${computer.state}${computer.refusal ? ` (${computer.refusal})` : ""}${computer.connected ? ", connected" : ""}`,
					)
					.join("\n"),
			};
		},
	},
	{
		id: "remote.connect",
		area: "connections",
		description:
			"Connect this computer to another computer of the tailnet that shares OMPdesk (nodeId from remote.list_tailnet), so sessions can run there.",
		args: objectSchema({ nodeId: { type: "string", minLength: 1, maxLength: 128 } }, ["nodeId"]),
		tier: "sensitive",
		manage: { always: "connecting gives this computer's sessions a way onto another computer" },
		describe: args => `connect to the tailnet computer ${String(args.nodeId)}`,
		run: async (ctx, args) => {
			const host = (await ctx.invoke(C.REMOTE_CONNECT, String(args.nodeId))) as HostView;
			return {
				text: `Connected to ${host.name} (${host.deviceId}).`,
				change: { en: "Connected computer", ko: "연결한 컴퓨터", value: host.name },
			};
		},
	},
	{
		id: "remote.block",
		area: "connections",
		description:
			"Keep a device that uses this computer out for good (deviceId from remote.devices): its Tailscale node is blocked and it is forgotten. Unblock with remote.unblock.",
		args: objectSchema({ deviceId: { type: "string", minLength: 1, maxLength: 64 } }, ["deviceId"]),
		tier: "sensitive",
		manage: { lifts: "it only takes access away, and remote.unblock undoes it" },
		describe: args => `block the device ${String(args.deviceId)}`,
		run: async (ctx, args) => {
			await ctx.invoke(C.REMOTE_BLOCK_PEER, String(args.deviceId));
			return { text: "Blocked.", change: { en: "Blocked device", ko: "차단한 기기", value: String(args.deviceId) } };
		},
	},
	{
		id: "remote.unblock",
		area: "connections",
		description:
			"Let a blocked device (a computer or a phone) connect again while its Tailscale account is allowed, by its block id or name.",
		args: objectSchema({ block: { type: "string", minLength: 1, maxLength: 200 } }, ["block"]),
		tier: "sensitive",
		manage: { always: "unblocking lets a device the person kept out reach this computer again" },
		describe: args => `unblock ${String(args.block)}`,
		run: async (ctx, args) => {
			const blocks = (await ctx.invoke(WEB_BLOCKS_LIST)) as WebBlockedInfo[];
			const wanted = String(args.block);
			const entry = blocks.find(block => block.id === wanted) ?? blocks.find(block => block.name === wanted);
			if (!entry) throw new AppRefusal(`No block named ${wanted}.`);
			await ctx.invoke(WEB_BLOCKS_REMOVE, entry.id);
			return { text: "Unblocked.", change: { en: "Unblocked device", ko: "차단 해제", value: entry.name } };
		},
	},
	{
		id: "remote.set_allowed_users",
		area: "connections",
		description:
			"Set the Tailscale accounts allowed to use this computer, from other computers and from the phone page alike (logins; this computer's own stays allowed when the list is empty).",
		args: objectSchema({ users: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 50 } }, [
			"users",
		]),
		tier: "sensitive",
		manage: { always: "an allowed account can use this computer's sessions from any of its devices" },
		describe: args => `allow the Tailscale accounts ${(args.users as string[]).join(", ")}`,
		run: async (ctx, args) => {
			const users = (args.users as unknown[]).map(String);
			await ctx.invoke(MOBILE_WEB_COMMAND, { action: "set-allowed-users", users });
			return {
				text: "Allowed accounts saved.",
				change: { en: "Allowed accounts", ko: "허용 계정", value: users.join(", ") },
			};
		},
	},
	{
		id: "remote.devices",
		area: "connections",
		description:
			"List this computer's device name, the paired computers it connects to (hosts) and the devices that use it (peers), with ids and online state.",
		args: NO_ARGS,
		tier: "read",
		run: async ctx => {
			const state = (await ctx.invoke(C.REMOTE_GET_STATE)) as RemoteState;
			return {
				text: [
					`This computer: ${state.host.name}`,
					...state.hosts.map(host => `host ${host.deviceId}: ${host.name} (${host.state})`),
					...state.host.peers.map(
						peer => `device ${peer.deviceId}: ${peer.name} (${peer.online ? "online" : "offline"})`,
					),
				].join("\n"),
			};
		},
	},
	{
		id: "remote.rename_this_computer",
		area: "connections",
		description: "Change this computer's device name; every paired computer and device sees it at once.",
		args: objectSchema({ name: { type: "string", minLength: 1, maxLength: 64 } }, ["name"]),
		tier: "change",
		run: async (ctx, args) => {
			await ctx.invoke(C.REMOTE_SET_DEVICE_NAME, String(args.name));
			return { text: "Renamed.", change: { en: "Device name", ko: "기기 이름", value: String(args.name) } };
		},
	},
	{
		id: "remote.rename_host",
		area: "connections",
		description:
			"Rename a paired computer this one connects to (deviceId from remote.devices): it changes its own device name. It must be online.",
		args: objectSchema(
			{
				deviceId: { type: "string", minLength: 1, maxLength: 64 },
				name: { type: "string", minLength: 1, maxLength: 64 },
			},
			["deviceId", "name"],
		),
		tier: "change",
		run: async (ctx, args) => {
			await ctx.invoke(C.REMOTE_RENAME_HOST, { deviceId: String(args.deviceId), name: String(args.name) });
			return { text: "Renamed.", change: { en: "Computer name", ko: "컴퓨터 이름", value: String(args.name) } };
		},
	},
	{
		id: "remote.rename_device",
		area: "connections",
		description:
			"Rename a device that uses this computer (deviceId from remote.devices): it is asked to rename itself, so it must be connected.",
		args: objectSchema(
			{
				deviceId: { type: "string", minLength: 1, maxLength: 64 },
				name: { type: "string", minLength: 1, maxLength: 64 },
			},
			["deviceId", "name"],
		),
		tier: "change",
		run: async (ctx, args) => {
			await ctx.invoke(C.REMOTE_RENAME_PEER, { deviceId: String(args.deviceId), name: String(args.name) });
			return { text: "Renamed.", change: { en: "Device name", ko: "기기 이름", value: String(args.name) } };
		},
	},
	{
		id: "mobile_web.rename_device",
		area: "mobile_web",
		description: "Rename a phone or tablet that uses the phone page, by its current name or id.",
		args: objectSchema(
			{
				device: { type: "string", minLength: 1, maxLength: 128 },
				name: { type: "string", minLength: 1, maxLength: 64 },
			},
			["device", "name"],
		),
		tier: "change",
		run: async (ctx, args) => {
			const devices = (await ctx.invoke(WEB_DEVICES_LIST)) as WebDeviceInfo[];
			const wanted = String(args.device);
			const device = devices.find(entry => entry.id === wanted) ?? devices.find(entry => entry.name === wanted);
			if (!device) throw new AppRefusal(`No phone-page device named ${wanted}.`);
			await ctx.invoke(WEB_DEVICES_RENAME, device.id, String(args.name));
			return { text: "Renamed.", change: { en: "Device name", ko: "기기 이름", value: String(args.name) } };
		},
	},
	{
		id: "autopilot.status",
		area: "autopilot",
		description: "Read an Autopilot run you started (state, cycle, branch): ompdesk_autopilot status.",
		args: objectSchema({ session: { type: "string", minLength: 1, maxLength: 200 } }, ["session"]),
		tier: "read",
		run: async (ctx, args) => ({ text: await ctx.autopilot({ action: "status", session: args.session }) }),
	},
	{
		id: "autopilot.start",
		area: "autopilot",
		description:
			"Start an Autopilot run: ompdesk_autopilot start, with its own confirmation card (commit, push or release) and its folder rules. ship defaults to the user's stored level; device runs it on a paired device (default the device your session runs on).",
		args: objectSchema({
			folder: { type: "string", minLength: 1, maxLength: 4096 },
			device: { type: "string", minLength: 1, maxLength: 200 },
			ship: { type: "string", enum: ["commit", "push", "release"] },
		}),
		tier: "change",
		run: async (ctx, args) => ({
			text: await ctx.autopilot({
				action: "start",
				...(args.folder === undefined ? {} : { folder: args.folder }),
				...(args.device === undefined ? {} : { device: args.device }),
				...(args.ship === undefined ? {} : { ship: args.ship }),
			}),
		}),
	},
	{
		id: "autopilot.stop",
		area: "autopilot",
		description:
			"End an Autopilot run after the cycle in flight, or with now: true stop it at once (the turn is aborted and the run paused): ompdesk_autopilot stop.",
		args: objectSchema({ session: { type: "string", minLength: 1, maxLength: 200 }, now: { type: "boolean" } }, [
			"session",
		]),
		tier: "change",
		run: async (ctx, args) => ({
			text: await ctx.autopilot({
				action: "stop",
				session: args.session,
				...(args.now === undefined ? {} : { now: args.now }),
			}),
		}),
	},
	...SETTINGS.map(settingAction),
];

export const ACTION_BY_ID: Readonly<Record<string, AppAction>> = Object.fromEntries(
	APP_ACTIONS.map(action => [action.id, action]),
);
