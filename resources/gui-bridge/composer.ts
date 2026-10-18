/**
 * Composer / session-action state stock RPC does not expose: user eval and
 * excluded bash, in-place context reset, the pending forced tool, prewalk
 * disarm, report data (/context, /tools, /jobs, /share) and the get_state
 * extras. Each method reads the same AgentSession surface the TUI command
 * drives; modules beyond the session are imported lazily so one moved internal
 * fails its own method, not the whole bridge.
 */
import { createHash } from "node:crypto";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { RestoreOptions } from "@oh-my-pi/pi-coding-agent/task/restore";
import type { AgentMessage } from "../../src/shared/rpc-types";
import { requireFn } from "./capabilities";
import { buildCopyTargets } from "./copy-targets";
import { guard } from "./health";
import {
	goalActiveAtExit,
	interruptedJobs,
	type JournalEntry,
	restartFollowUp,
	revivedSubagents,
} from "./restart-core";
import type { BridgeMethods } from "./types";

type Session = AgentSession & Record<string, unknown>;

function record(params: unknown): Record<string, unknown> {
	return typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
}

// ── Forced tool ──────────────────────────────────────────────────────────────
// Stock `setForcedToolChoice` keeps no readable record of the tool it forced, so
// the GUI's force (it never routes /force through the prompt) pushes the same
// [forced, "none"] sequence itself and tracks the name until the forced call is
// served or dropped — the fork's getForcedToolChoice/clearForcedToolChoice.
const USER_FORCE_LABEL = "user-force";
const pendingForce = new WeakMap<object, string>();

function forcedTool(session: Session): string | null {
	const tool = pendingForce.get(session);
	if (tool === undefined) return null;
	const labels: readonly string[] = session.toolChoiceQueue?.inspect?.() ?? [];
	if (labels.some(label => label.startsWith(USER_FORCE_LABEL))) return tool;
	// Served or dropped through a path that skipped our callbacks.
	pendingForce.delete(session);
	return null;
}

async function setForcedTool(session: Session, tool: string): Promise<{ tool: string | null }> {
	requireFn(session, "getActiveToolNames", "composer");
	requireFn(session, "toolChoiceQueue.pushSequence", "composer");
	const queue = session.toolChoiceQueue;
	if (!session.getActiveToolNames().includes(tool)) throw new Error(`Tool "${tool}" is not currently active.`);
	const toolChoice = await import("@oh-my-pi/pi-coding-agent/utils/tool-choice");
	requireFn(toolChoice, "buildNamedToolChoice", "composer", "utils/tool-choice");
	const forced = toolChoice.buildNamedToolChoice(tool, session.model);
	if (!forced || typeof forced === "string")
		throw new Error("Current model does not support forcing a specific tool.");
	const settle = (choice: unknown) => {
		if (choice === forced && pendingForce.get(session) === tool) pendingForce.delete(session);
	};
	pendingForce.set(session, tool);
	queue.pushSequence([forced, "none"], {
		label: USER_FORCE_LABEL,
		// The forced call ran: the force is spent (the trailing "none" is bookkeeping).
		onResolved: info => settle(info.choice),
		// Explicit removals drop the force; aborted/errored turns replay it.
		onRejected: info => {
			if (info.reason === "unavailable" || info.reason === "removed" || info.reason === "cleared") {
				settle(info.choice);
				return "drop_sequence";
			}
			return "requeue";
		},
	});
	return { tool: forcedTool(session) };
}

function clearForcedTool(session: Session): { tool: null } {
	pendingForce.delete(session);
	requireFn(session, "toolChoiceQueue.removeByLabel", "composer");
	const queue = session.toolChoiceQueue;
	// Removing an in-flight force requeues it under the `-requeued` label first.
	queue.removeByLabel(USER_FORCE_LABEL);
	queue.removeByLabel(`${USER_FORCE_LABEL}-requeued`);
	return { tool: null };
}

// ── Share ────────────────────────────────────────────────────────────────────
async function shareContext(session: Session) {
	const share = await import("@oh-my-pi/pi-coding-agent/export/share");
	const { cfgShareServerUrl, cfgShareStore, cfgShareRedactSecrets } = await import(
		"@oh-my-pi/pi-coding-agent/commands/settings"
	);
	const redactionEnabled = cfgShareRedactSecrets.get(session.settings) === true;
	const options = {
		serverUrl: cfgShareServerUrl.get(session.settings),
		store: cfgShareStore.get(session.settings),
		state: session.state,
		obfuscator: redactionEnabled ? session.obfuscator : undefined,
	};
	return { share, options, redactionEnabled };
}

/** Local-only preview; the digest binds the snapshot and its upload destination. */
async function sharePreview(session: Session) {
	const { share, options, redactionEnabled } = await shareContext(session);
	const data = share.buildShareSnapshot(session.sessionManager, options);
	const preview = JSON.stringify(data, null, 2);
	const serverUrl = share.normalizeShareServerUrl(options.serverUrl);
	const store = options.store ?? "blob";
	const snapshotId = createHash("sha256")
		.update(JSON.stringify({ preview, serverUrl, store, redactionEnabled }))
		.digest("hex");
	// Stock trims at seal time; a throwaway seal tells whether the server budget will.
	let truncated = false;
	if (store === "blob" && typeof share.sealToFit === "function") {
		const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);
		truncated = (await share.sealToFit(key, data, share.SERVER_MAX_SEALED_BYTES)).truncated;
	}
	return {
		snapshotId,
		preview,
		serverUrl,
		store,
		redactionEnabled,
		...(truncated ? { truncated: true } : {}),
	};
}

// ── Methods ──────────────────────────────────────────────────────────────────
export const methods: BridgeMethods = {
	...guard("composer", {
		/** The get_state fields stock omits. */
		"composer.state": async (_params, env) => {
			const session = env.session() as Session;
			const [{ agentPauseGate }, { serviceTierFamily, shouldSendServiceTier }] = await Promise.all([
				import("@oh-my-pi/pi-agent-core"),
				import("@oh-my-pi/pi-ai"),
			]);
			const model = session.model;
			return {
				cwd: session.sessionManager.getCwd(),
				autoRetryEnabled: session.autoRetryEnabled,
				thinkingConfigured: session.configuredThinkingLevel(),
				planModeEnabled: session.getPlanModeState?.()?.enabled ?? false,
				prewalkArmed: session.getPrewalkState?.() !== undefined,
				agentsPaused: agentPauseGate?.paused === true,
				agentsPausedAt: agentPauseGate?.pausedAt,
				// Stock `setUltrafastMode`'s own precondition (`/fast ultra`).
				ultrafastSupported:
					model !== undefined &&
					serviceTierFamily(model) === "openai" &&
					shouldSendServiceTier("ultrafast", model),
				ultrafastEnabled: session.isUltrafastModeEnabled(),
			};
		},

		/** Stock `/fast ultra` / `/fast off` for the active model; reports the fast state it left. */
		"composer.set_ultrafast": async (params, env) => {
			const session = env.session() as Session;
			const { enabled } = record(params);
			if (typeof enabled !== "boolean") throw new Error("set_ultrafast requires boolean enabled");
			if (!session.setUltrafastMode(enabled)) throw new Error("Ultrafast is unavailable for the current model.");
			return {
				enabled: session.isFastModeEnabled(),
				active: session.isFastModeActive(),
				ultrafast: session.isUltrafastModeEnabled(),
			};
		},

		"composer.eval": async (params, env) => {
			const session = env.session() as Session;
			requireFn(session, "executePython", "composer");
			const { code, excluded } = record(params);
			if (typeof code !== "string") throw new Error("eval requires code");
			const result = await session.executePython(code, undefined, { excludeFromContext: excluded === true });
			return {
				output: result.output,
				exitCode: result.exitCode,
				cancelled: result.cancelled,
				truncated: result.truncated,
			};
		},

		"composer.abort_eval": async (_params, env) => {
			const session = env.session() as Session;
			requireFn(session, "abortEval", "composer");
			session.abortEval();
			return null;
		},

		/**
		 * Esc during a manual `/compact` or handoff, as stock's input-controller does it: stock's
		 * serial RPC queue is still awaiting that command, so a queued `abort` frame would only run
		 * once it finished. `aborted` is false when no maintenance was running.
		 */
		"composer.abort_maintenance": async (_params, env) => {
			const session = env.session() as Session;
			requireFn(session, "abortCompaction", "composer");
			requireFn(session, "abortHandoff", "composer");
			const compacting = session.isCompacting === true;
			const handingOff = session.isGeneratingHandoff === true;
			if (compacting) session.abortCompaction();
			if (handingOff) session.abortHandoff();
			return { aborted: compacting || handingOff };
		},

		/** Bash whose output stays out of model context (`!!`). */
		"composer.bash_excluded": async (params, env) => {
			const session = env.session() as Session;
			requireFn(session, "executeBash", "composer");
			const { command } = record(params);
			if (typeof command !== "string") throw new Error("bash requires command");
			return session.executeBash(command, undefined, { excludeFromContext: true });
		},

		/** Null while streaming or a foreground bash/eval runs (the caller maps it to `busy`). */
		"composer.clear_context": async (_params, env) => {
			const session = env.session() as Session;
			requireFn(session, "resetSessionContext", "composer");
			const result = await session.resetSessionContext();
			return result ? { droppedCount: result.droppedCount } : null;
		},

		"composer.get_force_tool": async (_params, env) => ({ tool: forcedTool(env.session() as Session) }),

		"composer.set_force_tool": async (params, env) => {
			const session = env.session() as Session;
			const { tool, clear } = record(params);
			if (clear === true) return clearForcedTool(session);
			if (typeof tool !== "string" || !tool.trim())
				throw new Error("set_force_tool takes exactly one of tool or clear.");
			return setForcedTool(session, tool.trim());
		},

		"composer.disarm_prewalk": async (_params, env) => {
			const session = env.session() as Session;
			// Stock `/prewalk off`: drops only this session's pending hand-off, settings untouched.
			requireFn(session, "disarmPrewalk", "composer");
			session.disarmPrewalk();
			return { enabled: false };
		},

		"composer.prewalk_armed": async (_params, env) => {
			const session = env.session() as Session;
			requireFn(session, "getPrewalkState", "composer");
			return { armed: session.getPrewalkState() !== undefined };
		},

		/** Stock get_state supplies top-level tool descriptions; only provenance and xd:// entries are extras. */
		"composer.tool_extras": async (_params, env) => {
			const session = env.session() as Session;
			const source = (name: string) =>
				name.startsWith("mcp__") ? "mcp" : session.hasBuiltInTool(name) ? "builtin" : "extension";
			const sources = Object.fromEntries(session.agent.state.tools.map(tool => [tool.name, source(tool.name)]));
			const mounted = session.getXdevToolEntries();
			return {
				sources,
				mounted: mounted.map(entry => ({
					name: entry.name,
					description: entry.summary,
					source: source(entry.name),
				})),
			};
		},

		/** `/context` parity. */
		"composer.context_report": async (_params, env) => {
			const session = env.session() as Session;
			requireFn(session, "getContextBreakdown", "composer");
			const breakdown = session.getContextBreakdown();
			return {
				breakdown,
				contextWindow: breakdown?.contextWindow ?? session.model?.contextWindow ?? 0,
				model: session.model?.id ?? "",
			};
		},

		/** `/jobs` parity: running, then the 5 most recent. */
		"composer.jobs": async (_params, env) => {
			const session = env.session() as Session;
			requireFn(session, "getAsyncJobSnapshot", "composer");
			requireFn(session, "inspectAsyncJob", "composer");
			const snapshot = session.getAsyncJobSnapshot({ recentLimit: 5 });
			return snapshot
				? [...snapshot.running, ...snapshot.recent].map(job => {
						const inspection = session.inspectAsyncJob(job.id);
						return {
							...job,
							resultPreview: inspection?.output,
							previewTruncated: inspection?.artifactId !== undefined,
						};
					})
				: [];
		},

		"composer.cancel_job": async (params, env) => {
			const session = env.session() as Session;
			requireFn(session, "cancelAsyncJob", "composer");
			const { id } = record(params);
			if (typeof id !== "string" || !id) throw new Error("cancel_job requires id");
			return { cancelled: session.cancelAsyncJob(id) };
		},

		/** Stock RPC owns forward cycling; only the missing backward direction needs the bridge. */
		"composer.cycle_model_backward": async (_params, env) => {
			const session = env.session() as Session;
			requireFn(session, "cycleModel", "composer");
			return (await session.cycleModel("backward")) ?? null;
		},

		/**
		 * What `omp --restore` runs (stock's own continue path, TUI-only as a flag): the turn the
		 * last process was cut off in plus the subagents it ran. `turn` is false with nothing left
		 * unfinished, while a turn runs, or without a model. Stock leaves the agent unaware of some of
		 * what the restart did; one follow-up tells it (displayed, shown in the transcript as muted lines
		 * and never as a message, so it carries on without narrating the restart; `followUp` says it went):
		 * `jobs`, the background bash jobs that process started and never finished (stock restores no bash
		 * job), and, when the session's own turn does not go on, the subagents the restore revived (their
		 * results arrive only when they finish, maybe hours later, and until then the session would sit
		 * silent). `goalPausedByExit` is a goal that was active until that process ended and that stock
		 * paused at startup (the host resumes it after the restore).
		 */
		"composer.restore_interrupted": async (_params, env) => {
			const session = env.session() as Session;
			requireFn(session, "restoreInterruptedTurn", "composer");
			requireFn(session, "sessionManager.getBranch", "composer");
			requireFn(session, "promptCustomMessage", "composer");
			requireFn(session, "getToolByName", "composer");
			requireFn(session, "getGoalModeState", "composer");
			const restore = await import("@oh-my-pi/pi-coding-agent/task/restore");
			requireFn(restore, "restoreSession", "composer", "task/restore");
			const branch = session.sessionManager.getBranch() as readonly JournalEntry[];
			// This process's start: the entries before it are the lives of the processes the relaunch replaced.
			const startedAt = performance.timeOrigin;
			const cutOff = interruptedJobs(branch, startedAt);
			const goalPausedByExit =
				goalActiveAtExit(branch, startedAt) && session.getGoalModeState()?.goal.status === "paused";
			// The buses a live `task` run reports its subagents on (the task tool's stock `ToolSession`), as
			// `omp --restore` passes main.ts's own: without them a revived subagent runs unseen, since omp's RPC
			// subagent registry (`get_subagents`, the `subagent_*` frames) listens on `subagentEventBus` only.
			// The cast: TaskTool keeps its ToolSession in a TypeScript-private `session` field.
			const taskTool = session.getToolByName("task") as { session?: RestoreOptions } | undefined;
			const outcome = await restore.restoreSession(session, {
				eventBus: taskTool?.session?.eventBus,
				subagentEventBus: taskTool?.session?.subagentEventBus,
			});
			// A restored turn already goes on with its subagents (a cut-off `wait` reruns and finds them again).
			const followUp = restartFollowUp(cutOff, outcome.turn ? [] : revivedSubagents(branch, outcome.subagents));
			// Not awaited: a dispatched prompt settles with its whole turn; the restore answers at once.
			if (followUp) {
				void session
					.promptCustomMessage({ ...followUp, display: true }, { streamingBehavior: "followUp" })
					.catch((error: unknown) =>
						env.emit({
							type: "notice",
							level: "error",
							message: `Telling the agent what the restart left running failed: ${error instanceof Error ? error.message : String(error)}`,
						}),
					);
			}
			return { ...outcome, jobs: cutOff.map(job => job.id), goalPausedByExit, followUp: followUp !== undefined };
		},

		"composer.skill_count": async (_params, env) => ({ skills: (env.session() as Session).skills?.length ?? 0 }),

		/** Pop the newest user-queued message back to the composer (TUI dequeue). */
		"composer.dequeue": async (_params, env) => {
			const session = env.session() as Session;
			requireFn(session, "popLastQueuedMessage", "composer");
			requireFn(session, "getQueuedMessages", "composer");
			const before = session.getQueuedMessages();
			const popped = session.popLastQueuedMessage();
			if (!popped) return null;
			const after = session.getQueuedMessages();
			const mode = after.steering.length < before.steering.length ? "steer" : "followUp";
			return { text: popped.text, images: popped.images, mode };
		},
	}),
	...guard("share", {
		"composer.share_preview": async (_params, env) => sharePreview(env.session() as Session),

		"composer.share": async (params, env) => {
			const session = env.session() as Session;
			const { snapshotId } = record(params);
			const prepared = await sharePreview(session);
			if (snapshotId !== undefined && snapshotId !== prepared.snapshotId) {
				throw new Error("Session or sharing settings changed. Refresh the local preview before uploading.");
			}
			const { share, options } = await shareContext(session);
			const result = await share.shareSession(session.sessionManager, options);
			return result.truncated || prepared.truncated ? { url: result.url, truncated: true } : { url: result.url };
		},
	}),
	...guard(["composer", "sessionTree"], {
		"composer.copy_targets": async (_params, env) => {
			// Late imports isolate moved stock internals from the other composer adapters.
			const stock = await import("@oh-my-pi/pi-tui/overlays/copy-targets");
			const { buildTranscript } = await import("./session-display");
			const messages = buildTranscript(env.session().sessionManager).messages as unknown as AgentMessage[];
			return {
				targets: buildCopyTargets(messages, {
					extractBlocks: stock.extractBlocks,
					assistantText: message => stock.assistantText(message as Parameters<typeof stock.assistantText>[0]),
					commandFromToolCall: call => stock.commandFromToolCall(call),
				}),
			};
		},
		/** `/open`: stock's TUI command opens the newest http(s) link of an assistant message.
		 * Late imports for the same reason as `composer.copy_targets`. */
		"composer.last_link": async (_params, env) => {
			const stock = await import("@oh-my-pi/pi-tui/overlays/copy-targets");
			const { buildTranscript } = await import("./session-display");
			const messages = buildTranscript(env.session().sessionManager).messages as unknown as Parameters<
				typeof stock.extractLastLink
			>[0];
			return { href: stock.extractLastLink(messages)?.href ?? null };
		},
	}),
};
