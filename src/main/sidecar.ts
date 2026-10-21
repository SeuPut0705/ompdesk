/**
 * Sidecar lifecycle manager: spawns the system `omp --mode rpc-ui` with the
 * gui-bridge extension, handles restart, routes frames to RpcClient and
 * EventBatcher, and answers GUI-side commands (src/main/local) in-process.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { McpLiveChange } from "../../resources/gui-bridge/extensions/mcp-contracts";
import { type AutoTitleSettings, titleSuppressedByEnv } from "../../resources/gui-bridge/modes/auto-title-contracts";
import type { DelegationMode } from "../../resources/gui-bridge/modes/delegation-contracts";
import { JUDGE_ASSIST_ENV, JUDGE_ASSIST_SET } from "../../resources/gui-bridge/modes/judge-assist-contracts";
import { MEMORY_ENV } from "../../resources/gui-bridge/modes/memory-recall-contracts";
import type { NextPromptSettings } from "../../resources/gui-bridge/modes/next-prompt-contracts";
import type { UserProfile } from "../../resources/gui-bridge/modes/user-profile-contracts";
import { OMPDESK_ROLES_ENV } from "../../resources/gui-bridge/ompdesk-role-contracts";
import type { PromptOriginEnv } from "../../resources/gui-bridge/prompt-origin-contracts";
import type { AccountRotationMode } from "../shared/account-rotation";
import { parseLaunchProfile, profileToFlags, stripDenylistedFlags } from "../shared/launch-profile";
import { DEFAULT_ROLE_MODEL_SELECTOR, parseModelRestoreFailure } from "../shared/model-restore";
import type {
	AgentMessage,
	AgentSessionEvent,
	RpcCommand,
	RpcReadyFrame,
	RpcResponse,
	SidecarRestartProgress,
	SidecarStatus,
	SidecarStatusPayload,
} from "../shared/rpc-types";
import { BTW_FRAME_TYPES, LIVE_FRAME_TYPES } from "../shared/rpc-types";
import { AGENT_CONTROL_DEFINITIONS } from "./agent-control/tools";
import { isNoModelBootFailure } from "./boot-model";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";
import { EventBatcher } from "./event-batcher";
import { withoutFrameBookkeeping } from "./frame-bookkeeping";
import { localHandlerFor, runLocalCommand } from "./local";
import { projectQueueUpdate } from "./local/queue";
import type { BridgeClient, LocalCommandContext, OmpRuntime } from "./local/types";
import { OMP_TELEMETRY_OFF, type OmpResolution, ompBunDefaults, ompPathEnv } from "./omp-runtime";
import { VISUALIZE_DEFINITION } from "./preview/visuals";
import { MAX_RESTART_ATTEMPTS, restartDelay, WINDOWS_SESSION_END_EXIT_CODE } from "./restart-policy";
import { attachNdjsonParser, supportsRpcProtocolV2 } from "./rpc-bridge";
import { RpcClient } from "./rpc-client";
import { completeRunMessages } from "./run-messages";
import { needsShell, spawnArgs, spawnCommand } from "./spawn";
import { TERMINAL_READ_DEFINITION } from "./terminal/agent-tool";

/** stderr lines kept per spawn for the crash report. */
const STDERR_TAIL_LINES = 20;
/** Cap on the stderr excerpt appended to the user-visible restart reason. */
const STDERR_REASON_CHARS = 240;
/** `ctx.send` from GUI-side handlers: stock commands such as `get_entries` on a long session. */
const LOCAL_SEND_TIMEOUT_MS = 120_000;
/** How long `agent_end` (and every frame behind it) may wait for its entry ids. */
const ENTRY_ID_TIMEOUT_MS = 5_000;
/** Longest wait after `exit` for the child's stderr to finish draining (a shim's grandchild may hold it open). */
const STDERR_DRAIN_MS = 1_000;
/** Pause between re-probes while a failed health check holds a live child in `error`. */
const HEALTH_RECOVERY_PROBE_MS = 5_000;

/** Files inside the gui-bridge directory (resources/gui-bridge). */
const BRIDGE_ENTRY = "index.ts";
/** `--config` overlay pinning `autoResume: false` so a fresh tab never reopens the last session. */
const FRESH_LAUNCH_CONFIG = "fresh-launch.yml";

/**
 * The variables this sidecar (and sidecar-factory's `builtinMcp.env`) sets per spawn from its own options. One
 * inherited from the environment OMPdesk was started in (a dev or test run launched from an OMPdesk session's shell)
 * describes that other app's session: its bridge socket, delegation, memory file. So none is ever passed through;
 * each spawn sets only its own.
 */
const SESSION_OWNED_ENV = [
	"OMP_GUI_BRIDGE",
	"OMP_GUI_REPLY_LANGUAGE",
	"OMP_GUI_USER_PROFILE",
	"OMP_GUI_NEXT_PROMPT",
	"OMP_GUI_AUTO_TITLE",
	JUDGE_ASSIST_ENV,
	"OMP_GUI_PROMPT_ORIGIN",
	"OMP_GUI_DELEGATION",
	"OMP_GUI_ACCOUNT_ROTATION",
	"OMP_GUI_ACCOUNT_ROTATION_STATE",
	OMPDESK_ROLES_ENV,
	"OMP_GUI_REA_ROOT",
	"OMP_GUI_PSTACK",
	"OMP_GUI_ECC",
	MEMORY_ENV,
] as const;

function withoutSessionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const own = { ...env };
	for (const key of SESSION_OWNED_ENV) delete own[key];
	return own;
}

/** Stock commands after which the sidecar's session identity is unknown until the next `get_state`. */
const SESSION_CHANGING_COMMANDS: Record<string, true> = {
	new_session: true,
	switch_session: true,
	fork: true,
	branch: true,
	handoff: true,
};

/**
 * Leading stderr line of the crashed spawn: a fatal message comes first
 * (`dyld: Library not loaded …`, `error: ENOENT …`) and whatever follows is
 * stack or warning noise. The full tail rides on the runtime-log report.
 */
function stderrExcerpt(lines: string[]): string {
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		return trimmed.length > STDERR_REASON_CHARS ? `${trimmed.slice(0, STDERR_REASON_CHARS - 1)}…` : trimmed;
	}
	return "";
}

/** Resolves once `child`'s stderr has closed, or after STDERR_DRAIN_MS. */
function stderrDrained(child: ChildProcess): Promise<void> {
	const stream = child.stderr;
	if (!stream || stream.closed) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, STDERR_DRAIN_MS);
	stream.once("close", () => {
		clearTimeout(timer);
		resolve();
	});
	return promise;
}

/** `ctx.send` over the stock path: resolves with `response.data`, rejects with `response.error`. */
function stockSender(client: RpcClient, timeoutMs: number): LocalCommandContext["send"] {
	return async <T>(command: { type: string; [k: string]: unknown }): Promise<T> => {
		// GUI-side handlers speak stock command names; RpcCommand only types the renderer's set.
		const stockCommand = command as RpcCommand;
		const response = await client.stock(stockCommand, timeoutMs);
		if (!response.success) throw new Error(response.error);
		// The caller names the stock response shape it asked for.
		return response.data as T;
	};
}

/** Event types routed to the EventBatcher. Hoisted: one lookup table for the
 * process, not one allocation per frame. */
const AGENT_EVENT_TYPES: Record<string, true> = {
	agent_start: true,
	agent_end: true,
	turn_start: true,
	turn_end: true,
	message_start: true,
	message_update: true,
	message_end: true,
	tool_execution_start: true,
	tool_execution_update: true,
	tool_execution_end: true,
	auto_compaction_start: true,
	auto_compaction_end: true,
	auto_retry_start: true,
	auto_retry_end: true,
	retry_fallback_applied: true,
	retry_fallback_succeeded: true,
	model_changed: true,
	ttsr_triggered: true,
	todo_reminder: true,
	todo_auto_clear: true,
	irc_message: true,
	notice: true,
	thinking_level_changed: true,
	goal_updated: true,
	// The bridge's goal time limit (modes/goal.ts): the renderer toasts it, main pauses (sidecar-factory.ts).
	goal_time_limit_reached: true,
	// The bridge's autopilot status (modes/autopilot.ts), overlaid by main's coordinator first (`frameTransform`).
	// Its other frames (`autopilot_cycle_end`, `autopilot_stop_requested`, `autopilot_settled`) are for main only:
	// they leave through `frame` and reach no window.
	autopilot_update: true,
	// The built-in prompt suggestions (bridge modes/next-prompt.ts): candidates, and the feature's state/availability.
	next_prompt_update: true,
	next_prompt_config: true,
	plan_proposal: true,
	// The proposal no longer waits (answered anywhere, or a prompt replied to it): every window drops its card.
	plan_proposal_resolved: true,
	// The other live sessions in this session's worktree or repository (modes/checkout-peers.ts): the board's row.
	checkout_peers: true,
	queue_update: true,
	token_rate: true,
	read_group_metadata: true,
};

/**
 * Stock frame type → the event that re-emits the frame itself (pool wiring,
 * remote hosts). Every frame also goes out as `frame`; `ready`, `response`,
 * `available_commands_update` (emits its `commands`) and the batched agent
 * events are dispatched on their own.
 */
const FRAME_EVENTS: Record<string, string> = {
	extension_ui_request: "extensionUi",
	host_tool_call: "hostToolCall",
	host_uri_request: "hostUriRequest",
	subagent_lifecycle: "subagentFrame",
	subagent_progress: "subagentFrame",
	subagent_event: "subagentFrame",
	model_catalog_update: "modelCatalogUpdate",
	config_update: "configUpdate",
	prompt_result: "promptResult",
	session_settled: "sessionSettled",
	command_output: "commandOutput",
	session_info_update: "sessionInfoUpdate",
	extension_error: "extensionError",
	...Object.fromEntries([...LIVE_FRAME_TYPES].map(type => [type, "liveFrame"])),
	...Object.fromEntries(Object.keys(BTW_FRAME_TYPES).map(type => [type, "btwFrame"])),
};

type Frame = Record<string, unknown>;

/** The live session's identity as last reported by `get_state`. */
export interface SidecarSessionIdentity {
	sessionId?: string;
	sessionFile?: string;
	/** The session's name; read only when the id changes, since a rename arrives as session_info_update. */
	sessionName?: string;
}

export interface SidecarOptions {
	/** Resolves the system omp (path + version gate); consulted on every start(). */
	omp: () => Promise<OmpResolution>;
	/** The gui-bridge extension directory. Absent: no `-e`, no bridge (tests). */
	bridgeDir?: string;
	/** Optional app-only MCP root, resolved before a spawn; never touches stock config. */
	builtinMcp?: () => Promise<{ args: string[]; root?: string; env?: Record<string, string> }>;
	/** Whether the OMPdesk control tools are registered with the GUI's host tools (Settings switch); default off. */
	hostTools?: () => boolean;
	cwd: string;
	extraFlags?: string[];
	/** Fresh GUI tabs must not inherit the CLI's persistent autoResume setting. */
	fresh?: boolean;
	/**
	 * Session kind: "agent" (default) or "chat" (a conversation outside any
	 * project). Both spawn the same argv with omp's full tool set; omp itself
	 * has no notion of the kind, so the GUI records chat sessions in its own
	 * metadata (session-kinds.ts) for the sidebar's Chat lane.
	 */
	kind?: "agent" | "chat";
	/**
	 * Resolves proxy env vars (PI_PROXY / HTTPS_PROXY / …) injected at spawn —
	 * the GUI proxy pref or the macOS system proxy. Finder-launched apps have
	 * no shell env, so without this a proxy-only network (e.g. codex's
	 * chatgpt.com backend behind a firewall) hangs every provider request.
	 * Called on every start()/restart(); crash-loop respawns reuse the last
	 * result. Resolution failure degrades to no proxy env, never a spawn block.
	 */
	proxyEnv?: () => Promise<Record<string, string>>;
	/**
	 * Resolves the login-shell PATH overlay injected at spawn. Finder-launched
	 * apps inherit launchd's bare PATH, so agent-spawned tools configured by
	 * bare name (MCP servers, CLI helpers) die with ENOENT while the terminal
	 * TUI works. Same point-of-use pattern as proxyEnv: called on every
	 * start()/restart(), failure degrades to the inherited PATH.
	 */
	shellEnv?: () => Promise<Record<string, string>>;
	/**
	 * The reply language's English name (`Korean`; the Settings choice, else the
	 * device language), passed to omp as `OMP_GUI_REPLY_LANGUAGE` for the
	 * gui-bridge's reply-language instruction. Same point-of-use pattern as
	 * proxyEnv: read on every spawn, and by `syncReplyLanguage()` for the live
	 * session. Undefined: no instruction.
	 */
	replyLanguage?: () => string | undefined;
	/**
	 * Settings › General › Profile (how the agent addresses the user, their
	 * development experience), passed to omp as JSON in `OMP_GUI_USER_PROFILE`
	 * and pushed by `syncUserProfile()` (same point-of-use pattern as
	 * replyLanguage). Absent or empty: no profile section.
	 */
	userProfile?: () => UserProfile;
	/**
	 * The prompt-suggestion switches (prefs `nextPromptSuggestions`,
	 * `nextPromptInline`), passed to omp as JSON in `OMP_GUI_NEXT_PROMPT` on
	 * every spawn and pushed by `syncNextPrompt()` (same point-of-use pattern as
	 * replyLanguage). Absent: the bridge's default (on).
	 */
	nextPrompt?: () => NextPromptSettings;
	/**
	 * The automatic-title switches (prefs `autoTitle`, `autoTitleEvolve`), passed to omp as JSON in
	 * `OMP_GUI_AUTO_TITLE` on every spawn and pushed by `syncAutoTitle()` (same point-of-use pattern as
	 * nextPrompt). The spawn adds `suppressed`, read from the environment omp is started with.
	 * Absent: the bridge's default (on).
	 */
	autoTitle?: () => AutoTitleSettings;
	/**
	 * Whether judge-model assists are on (pref `judgeAssist`, default on), passed as `OMP_GUI_JUDGE_ASSIST` ("0" or
	 * "1") on every spawn and pushed by `syncJudgeAssist()`. The bridge still asks the judge only while stock's
	 * `hasNativeJudge` holds. Absent: the bridge's default (on).
	 */
	judgeAssist?: () => boolean;
	/**
	 * The paired device a host tab runs for (and this host's name), passed as
	 * JSON in `OMP_GUI_PROMPT_ORIGIN`: the bridge journals it per user message
	 * (prompt-origin.ts). Absent for this machine's own tabs.
	 */
	promptOrigin?: PromptOriginEnv;
	/**
	 * The delegation strength this tab starts with (prefs `delegationMode`, the
	 * composer chip's last choice), passed as `OMP_GUI_DELEGATION` on every
	 * spawn; a live change goes straight to the tab's bridge. Absent or
	 * `default`: the user's own task settings.
	 */
	delegation?: () => DelegationMode;
	/**
	 * The Settings › Models & providers account-rotation mode, passed to omp as
	 * `OMP_GUI_ACCOUNT_ROTATION` and pushed by `syncAccountRotation()` (same
	 * point-of-use pattern as replyLanguage). Absent: stock selection.
	 */
	accountRotation?: () => AccountRotationMode;
	/** The even-rotation ledger every local omp shares (`OMP_GUI_ACCOUNT_ROTATION_STATE`). */
	accountRotationLedger?: string;
	/** The OMPdesk model-role picks every local omp shares (`OMP_GUI_OMPDESK_ROLES`, ompdesk-role-contracts.ts). */
	ompdeskRolesFile?: string;
	/**
	 * The stored per-workspace launch profiles (prefs `launchProfiles`), read at
	 * every spawn and mapped to the tab cwd's agent flags. Absent: no profile
	 * flags, and no prefs file is touched.
	 */
	launchProfiles?: () => unknown;
	/** How long a closed tab's omp gets to shut down on its own (stdin closed) before SIGTERM; 0 or absent: SIGTERM at once. */
	gracefulStopMs?: () => number;
	/**
	 * Rewrites a frame before anything sees it (Autopilot's coordinator adds the children and the ship queue to
	 * `autopilot_update`). Must be synchronous and return a frame of the same type.
	 */
	frameTransform?: (frame: Record<string, unknown>) => Record<string, unknown>;
	/**
	 * Persists a crash report (reason + stderr tail) for post-mortem diagnosis.
	 * Same point-of-use injection as `proxyEnv`/`shellEnv`: the real
	 * implementation is `writeRuntimeLog`, which resolves its path through
	 * Electron's `app`, so the manager must keep working without it.
	 */
	reportFailure?: (report: SidecarFailureReport) => void;
	/**
	 * A catalog `provider/model` selector for `runtime` (src/main/boot-model.ts).
	 * Absent: a spawn that exits for lack of a usable model just crash-loops.
	 */
	bootModel?: (runtime: OmpRuntime) => Promise<string>;
	/** Re-probe interval after a failed health check (tests shorten it). */
	healthRecoveryProbeMs?: number;
}

/** One crash-loop step, as handed to `reportFailure`. */
export interface SidecarFailureReport {
	/** Exit/signal reason with the leading stderr line appended. */
	reason: string;
	/** Respawn about to be scheduled, or the exhausted count on the final error. */
	attempt: number;
	maxAttempts: number;
	/** stderr tail captured from this spawn (up to STDERR_TAIL_LINES). */
	stderr: string[];
	cwd: string;
}

/**
 * Map the workspace's launch profile (`launchProfiles.<cwd>`) to agent CLI
 * flags. Any failure — prefs unreadable, malformed JSON — degrades to no
 * flags, never a spawn block. Profile changes require a sidecar restart:
 * flags are spawn-time argv, there is no live apply.
 */
function loadLaunchProfileFlags(read: (() => unknown) | undefined, cwd: string): string[] {
	if (!read) return [];
	try {
		const profiles = read();
		if (typeof profiles !== "object" || profiles === null) return [];
		return profileToFlags(parseLaunchProfile((profiles as Record<string, unknown>)[cwd]));
	} catch {
		return [];
	}
}

/**
 * Runs once, between a fresh tab's first bridge connect and its `ready`, while
 * the tab still reports `starting` (src/main/worktree-lifecycle.ts). Resolves
 * the cwd the tab must restart in as a fresh session, or null to report ready
 * where it is. A rejection counts as null.
 */
export type SidecarStartGate = (bridge: BridgeClient, cwd: string) => Promise<string | null>;

/** How long the fallback of `terminate` lets an omp finish on its own after its stdin ended, before the shim is killed. */
const TASKKILL_FALLBACK_GRACE_MS = 5_000;

/**
 * Stop an omp. SIGTERM where signals exist. Windows has none: `kill` is TerminateProcess of the direct child only, and
 * omp starts through a `.cmd` or `.exe` shim whose real omp would be left running, so the whole tree goes (`taskkill
 * /T /F`, as the setup supervisor does). taskkill finds the tree through WMI and, with WMI down, exits 1 and kills
 * nothing: the omp would then run on until the app exits, holding its folder. So a taskkill that failed while the child
 * still runs falls back to ending its stdin (omp exits when it ends). The shim waits for the omp, so its exit means
 * the omp is gone: a callback waiting for that exit (a session delete, a folder removal) never runs while the omp
 * still writes its session file on the way out. Only an omp that ignores the closed stdin gets TerminateProcess of the
 * shim, after a grace period.
 */
function terminate(child: ChildProcess): void {
	if (process.platform === "win32" && child.pid !== undefined) {
		const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		const fallBack = () => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			child.stdin?.end();
			const timer = setTimeout(() => child.kill(), TASKKILL_FALLBACK_GRACE_MS);
			timer.unref();
			child.once("exit", () => clearTimeout(timer));
		};
		killer.once("error", fallBack);
		killer.once("exit", code => {
			if (code !== 0) fallBack();
		});
		return;
	}
	child.kill("SIGTERM");
}

export class SidecarManager extends EventEmitter {
	#child: ChildProcess | null = null;
	#rpcClient: RpcClient | null = null;
	#bridge: GuiBridgeClient | null = null;
	#bridgeAddress: string | null = null;
	#batcher: EventBatcher | null = null;
	#detachParser: (() => void) | null = null;
	#restartCount = 0;
	#restartTimer: NodeJS.Timeout | null = null;
	/**
	 * A failed health check marked this live child `error`. Re-probed until a
	 * command succeeds, which sets it `ready` again (see markUnhealthy).
	 */
	#unhealthy = false;
	#recoveryTimer: NodeJS.Timeout | null = null;
	/**
	 * Spawn-cycle counter, bumped whenever a cycle is torn down or started.
	 * Every continuation that outlives the synchronous spawn (protocol
	 * negotiation, env resolution) captures it and drops itself when it no
	 * longer matches, so a dead child can never report `ready` or reset the
	 * crash-loop counter.
	 */
	#generation = 0;
	/** `start()` calls in flight; a superseded env resolution must not spawn. */
	#startSeq = 0;
	#lastStderr: string[] = [];
	/**
	 * `asleep` until something calls start(): a restored background tab costs
	 * nothing until it is shown. start() flips to `starting` synchronously, so
	 * "is a spawn already under way?" is answerable from this field alone.
	 */
	#status: SidecarStatus = "asleep";
	/**
	 * The last `status` event's detail. An early failure (e.g. omp not found)
	 * fires before the window subscribes; the renderer's boot snapshot
	 * (SIDECAR_STATUS_GET) reads this so the reason is not lost.
	 */
	#statusDetail: Pick<SidecarStatusPayload, "message" | "restart" | "modelFallback" | "sessionEnded"> = {};
	#options: SidecarOptions;
	#runtime: OmpRuntime | null = null;
	#proxyEnvVars: Record<string, string> = {};
	#builtinMcp: { args: string[]; root?: string; env?: Record<string, string> } = { args: [] };
	#shellEnvVars: Record<string, string> = {};
	#resumeSessionPath: string | null = null;
	#freshLaunchPending: boolean;
	/** Whether the current spawn cycle reached `ready`. */
	#bootedThisSpawn = false;
	/** The user's own environment turned stock's automatic titles off for this spawn (see AutoTitleSettings). */
	#titleSuppressed = false;
	/**
	 * Saved session model that failed to restore at boot. The next spawn adds
	 * `--model @default` so the session opens on the configured default model
	 * instead of exiting (upstream resumes fail closed), and the ready status
	 * carries it so the renderer can say so.
	 */
	#bootModelFallback: string | null = null;
	/**
	 * Catalog model the next spawns pass as `--model` after one exited for lack
	 * of a usable model (no credentials yet): booting is what lets the renderer
	 * open onboarding to connect a provider. Cleared on `ready` and restart().
	 */
	#noModelBoot: string | null = null;
	/** Last session identity `get_state` reported; null when a session change made it unknown. */
	#session: SidecarSessionIdentity | null = null;
	/** When the current omp child was spawned (epoch ms): a slow command's breakdown names the sidecar's age. */
	#spawnedAt = 0;
	/**
	 * An `agent_end` waiting for its entry ids, and every frame that arrived behind
	 * it, responses included. Holding the tail keeps the renderer's frame order
	 * (`agent_end` before `prompt_result`/`session_settled`) intact, and a response
	 * (`get_state`, a transcript page) never overtakes the run it already reports.
	 * The entry ids come over the bridge socket, so no held response is awaited.
	 * `released` settles once the frames have gone out.
	 */
	#held: { event: Frame; frames: Frame[]; released: PromiseWithResolvers<void> } | null = null;
	/** Messages delivered by `message_end` since the last `agent_end`; completes that end's commit. */
	#runMessages: AgentMessage[] = [];
	#disposed = false;
	/** One-shot gate held until the first spawn's `ready` (see SidecarStartGate). */
	#startGate: SidecarStartGate | null = null;

	constructor(options: SidecarOptions) {
		super();
		this.#options = options;
		this.#freshLaunchPending = options.fresh === true;
	}

	get status(): SidecarStatus {
		return this.#status;
	}

	/** Last status with its message/restart detail, for late subscribers. */
	get statusPayload(): SidecarStatusPayload {
		return { status: this.#status, cwd: this.#options.cwd, ...this.#statusDetail };
	}

	get cwd(): string {
		return this.#options.cwd;
	}

	get kind(): "agent" | "chat" {
		return this.#options.kind ?? "agent";
	}

	get rpcClient(): RpcClient | null {
		return this.#rpcClient;
	}

	/** A child process is running (whatever `status` says — a failed health check reports `error` over a live child). */
	get processAlive(): boolean {
		return this.#child !== null;
	}

	start(): void {
		if (this.#disposed) return;
		this.#setStatus("starting");
		const { omp, proxyEnv, shellEnv } = this.#options;
		const fallback = () => ({}) as Record<string, string>;
		// omp + env resolution takes up to a few seconds. A restart()/start()
		// landing inside that window supersedes this pending spawn — it already
		// killed whatever child existed (nothing yet) — so spawning here would
		// orphan the newer child and tear it down with the session it just opened.
		const seq = ++this.#startSeq;
		void Promise.all([
			omp().catch(
				(err: unknown): OmpResolution => ({ ok: false, error: err instanceof Error ? err.message : String(err) }),
			),
			proxyEnv ? proxyEnv().catch(fallback) : Promise.resolve({}),
			shellEnv ? shellEnv().catch(fallback) : Promise.resolve({}),
			this.#options.builtinMcp?.().catch(() => ({ args: [] })) ?? Promise.resolve({ args: [] }),
		]).then(([resolution, proxyVars, shellVars, builtinMcp]) => {
			if (this.#disposed || seq !== this.#startSeq) return;
			if (!resolution.ok) {
				// No usable omp: nothing ran, nothing failed. Machine setup installs it and main starts this tab then.
				this.#setStatus("waiting", resolution.error);
				return;
			}
			this.#runtime = resolution.runtime;
			this.#proxyEnvVars = proxyVars;
			this.#shellEnvVars = shellVars;
			this.#builtinMcp = builtinMcp;
			this.#spawn();
		});
	}

	#spawn(): void {
		this.#spawnedAt = Date.now();
		// One live child per manager. `#child` is only ever set here, so anything
		// still attached means a previous spawn was never retired — kill it through
		// the normal teardown instead of letting it run parser-less and unkillable.
		const superseded = this.#child;
		if (superseded) {
			this.#cleanup();
			terminate(superseded);
		}
		const runtime = this.#runtime;
		if (!runtime) return;
		this.#generation++;
		this.#lastStderr = [];
		this.#bootedThisSpawn = false;
		this.#session = null;
		const { bridgeDir, cwd, extraFlags } = this.#options;
		const replyLanguage = this.#options.replyLanguage?.();
		const userProfile = this.#options.userProfile?.();
		const nextPrompt = this.#options.nextPrompt?.();
		const delegation = this.#options.delegation?.();
		const accountRotation = this.#options.accountRotation?.();
		const { accountRotationLedger, ompdeskRolesFile } = this.#options;

		// Stock writes a new session's file at its first assistant message. A path learned before that (a restored
		// tab, a first turn a restart cut off, an omp restart on a tab never used) opens nothing, and `--session` on
		// it only fails ("Session not found"): the tab starts a fresh session in its folder instead.
		if (this.#resumeSessionPath && !existsSync(this.#resumeSessionPath)) {
			this.#resumeSessionPath = null;
			this.#freshLaunchPending = true;
		}
		const args = ["--mode", "rpc-ui"];
		if (this.#resumeSessionPath) args.push("--session", this.#resumeSessionPath);
		else if (this.#freshLaunchPending && bridgeDir) args.push("--config", join(bridgeDir, FRESH_LAUNCH_CONFIG));
		if (this.#noModelBoot) args.push("--model", this.#noModelBoot);
		else if (this.#bootModelFallback) args.push("--model", DEFAULT_ROLE_MODEL_SELECTOR);
		const bridgeAddress = bridgeDir ? newBridgeAddress() : null;
		if (bridgeDir) args.push("-e", join(bridgeDir, BRIDGE_ENTRY));
		args.push(...this.#builtinMcp.args);
		// User-controllable flags ride the extraFlags seam + the launch profile.
		// Strip the code-controlled-flag denylist (pair-aware) over BOTH, then
		// append: neither can override the code-controlled argv above, while a
		// profile value that merely looks like a protected flag survives intact.
		const userFlags = [...(extraFlags ?? []), ...loadLaunchProfileFlags(this.#options.launchProfiles, cwd)];
		args.push(...stripDenylistedFlags(userFlags));
		this.#titleSuppressed = titleSuppressedByEnv({ ...process.env, ...this.#shellEnvVars });
		const autoTitle = this.#options.autoTitle?.();
		const judgeAssist = this.#options.judgeAssist?.();

		const bin = runtime.bin;
		console.log(`[sidecar] spawning omp ${runtime.version} (${args.length} args, cwd: ${cwd})`);

		let child: ChildProcess;
		try {
			child = spawn(spawnCommand(bin), spawnArgs(bin, args), {
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					// Bun's own defaults for omp first, so the user's environment still wins (`ompBunDefaults`).
					...ompBunDefaults(),
					// Login-shell env over the app's own, then the GUI proxy pref (and inherited proxy env) over
					// rc-file proxy exports. What another OMPdesk session left in either is never this tab's
					// (`SESSION_OWNED_ENV`).
					...withoutSessionEnv({ ...process.env, ...this.#shellEnvVars }),
					...this.#proxyEnvVars,
					PATH: ompPathEnv(bin, this.#shellEnvVars.PATH ?? process.env.PATH ?? ""),
					...(bridgeAddress ? { OMP_GUI_BRIDGE: bridgeAddress } : {}),
					...(replyLanguage ? { OMP_GUI_REPLY_LANGUAGE: replyLanguage } : {}),
					...(userProfile && (userProfile.name || userProfile.experience)
						? { OMP_GUI_USER_PROFILE: JSON.stringify(userProfile) }
						: {}),
					...(nextPrompt ? { OMP_GUI_NEXT_PROMPT: JSON.stringify(nextPrompt) } : {}),
					...(autoTitle
						? { OMP_GUI_AUTO_TITLE: JSON.stringify({ ...autoTitle, suppressed: this.#titleSuppressed }) }
						: {}),
					...(judgeAssist === undefined ? {} : { [JUDGE_ASSIST_ENV]: judgeAssist ? "1" : "0" }),
					...(this.#options.promptOrigin
						? { OMP_GUI_PROMPT_ORIGIN: JSON.stringify(this.#options.promptOrigin) }
						: {}),
					...(delegation && delegation !== "default" ? { OMP_GUI_DELEGATION: delegation } : {}),
					...(accountRotation ? { OMP_GUI_ACCOUNT_ROTATION: accountRotation } : {}),
					...(accountRotationLedger ? { OMP_GUI_ACCOUNT_ROTATION_STATE: accountRotationLedger } : {}),
					...(ompdeskRolesFile ? { [OMPDESK_ROLES_ENV]: ompdeskRolesFile } : {}),
					...(this.#builtinMcp.root ? { OMP_GUI_REA_ROOT: this.#builtinMcp.root } : {}),
					...this.#builtinMcp.env,
					PI_RPC_EMIT_TITLE: "1",
					PI_NO_PTY: "1",
					PI_NOTIFICATIONS: "off",
					...OMP_TELEMETRY_OFF,
				},
				cwd,
				shell: needsShell(bin),
				windowsHide: true,
			});
		} catch (err) {
			// spawn() throws synchronously (EBADF/ENOENT) — surface it as a
			// sidecar failure + retry, never an uncaught main-process exception.
			this.#attemptRestart(err instanceof Error ? err.message : String(err));
			return;
		}

		this.#child = child;
		this.#bridgeAddress = bridgeAddress;
		const bridge = new GuiBridgeClient(bridgeAddress ?? "");
		bridge.onEvent(event => this.#routeFrame(event));
		this.#bridge = bridge;

		// Set up RPC client with stdin writer. A write racing the child's death
		// fails with EPIPE on the stream, not the write() call; without a listener
		// that `error` is an uncaught exception in main. The child's own `exit`
		// already drives the restart.
		child.stdin?.on("error", err => {
			console.warn(`[sidecar] stdin: ${err.message}`);
		});
		const send = (frame: object) => {
			if (child.stdin?.writable) {
				child.stdin.write(`${JSON.stringify(frame)}\n`);
			}
		};
		const rpcClient: RpcClient = new RpcClient(send, {
			local: command => {
				const handler = localHandlerFor(command.type);
				if (!handler) return undefined;
				return this.#localContext(rpcClient, runtime, bridge)
					.then(ctx => runLocalCommand(handler, command, ctx))
					.then(async response => {
						// Same as an omp response (#routeFrame): the frames omp sent before it go first,
						// an `agent_end` held for its entry ids and its tail included.
						while (this.#held) await this.#held.released.promise;
						this.#flushBeforeResponse();
						return response;
					});
			},
			observe: (command, response) => {
				this.#observeResponse(command, response);
				// Any successful answer proves the command loop is alive again.
				if (response.success) this.#recoverHealth();
			},
		});
		this.#rpcClient = rpcClient;

		// Set up event batcher
		this.#batcher = new EventBatcher(events => {
			this.emit("events", events);
		});

		// Parse stdout NDJSON
		if (child.stdout) {
			this.#detachParser = attachNdjsonParser(child.stdout, frame => this.#routeFrame(frame));
		}

		// Log stderr to main process console for diagnostics, and keep a per-spawn
		// tail: a sidecar that dies before it can log anywhere only speaks through
		// this pipe, so without the ring the crash report is just an exit code.
		child.stderr?.on("data", (chunk: Buffer) => {
			// omp colors fatal lines; the tail feeds UI text and the boot-failure parsers.
			const text = stripVTControlCharacters(chunk.toString("utf-8")).trim();
			if (text) {
				console.error(`[sidecar stderr] ${text}`);
				for (const line of text.split("\n")) {
					this.#lastStderr.push(line);
					if (this.#lastStderr.length > STDERR_TAIL_LINES) this.#lastStderr.shift();
				}
				this.emit("stderr", text);
			}
		});

		child.on("exit", (code, signal) => {
			if (this.#child !== child) return;
			this.#cleanup();
			if (this.#disposed) return;
			if (code === 0) {
				this.#setStatus("exited", "Normal shutdown");
				return;
			}
			if (code === WINDOWS_SESSION_END_EXIT_CODE) {
				this.#setStatus("exited", "The Windows session ended", undefined, undefined, true);
				return;
			}
			// `exit` can fire before stderr has drained, and the boot-failure
			// parsers below read it; a restart() meanwhile advances the generation.
			const generation = this.#generation;
			void stderrDrained(child).then(() => {
				if (!this.#isLive(generation)) return;
				if (this.#recoverBootModelRestore()) {
					this.#spawn();
				} else if (!this.#recoverNoModelBoot()) {
					this.#attemptRestart(`Exit code ${code}${signal ? ` (signal: ${signal})` : ""}`);
				}
			});
		});

		child.on("error", err => {
			if (this.#child !== child) return;
			this.#cleanup();
			if (this.#disposed) return;
			this.#attemptRestart(err.message);
		});
	}

	/** Context for one GUI-side command; learns the session identity first when a session change left it unknown. */
	async #localContext(client: RpcClient, runtime: OmpRuntime, bridge: GuiBridgeClient): Promise<LocalCommandContext> {
		const send = stockSender(client, LOCAL_SEND_TIMEOUT_MS);
		const started = Date.now();
		if (!this.#session) await client.stock({ type: "get_state" }).catch(() => undefined);
		return {
			cwd: this.#options.cwd,
			sessionFile: this.#session?.sessionFile,
			omp: runtime,
			send,
			bridge,
			sidecar: { spawnedAt: this.#spawnedAt, contextWaitMs: Date.now() - started },
		};
	}

	/** Track the session identity through the responses every hydrate already requests. */
	#observeResponse(command: RpcCommand, response: RpcResponse): void {
		if (!response.success) return;
		if (command.type === "get_state") {
			const data = response.data;
			if (typeof data !== "object" || data === null) return;
			const next: SidecarSessionIdentity = {
				sessionId: "sessionId" in data && typeof data.sessionId === "string" ? data.sessionId : undefined,
				sessionFile: "sessionFile" in data && typeof data.sessionFile === "string" ? data.sessionFile : undefined,
				sessionName: "sessionName" in data && typeof data.sessionName === "string" ? data.sessionName : undefined,
			};
			const previous = this.#session;
			this.#session = next;
			if (previous?.sessionId !== next.sessionId || previous?.sessionFile !== next.sessionFile) {
				this.emit("session", next);
			}
		} else if (SESSION_CHANGING_COMMANDS[command.type] === true) {
			this.#session = null;
			this.#runMessages = [];
		}
	}

	#routeFrame(frame: unknown): void {
		if (typeof frame !== "object" || frame === null) return;
		// Request bookkeeping no window reads leaves here, before any copy of the frame is made (frame-bookkeeping.ts).
		let obj = withoutFrameBookkeeping(frame as Frame);
		// Stock queue lanes are bare text; ids are assigned on arrival, in stream order.
		if (obj.type === "queue_update" && this.#bridge) obj = projectQueueUpdate(this.#bridge, obj);
		if (this.#held) {
			this.#held.frames.push(obj);
			return;
		}
		if (obj.type !== "response") {
			if (obj.type === "message_end" && typeof obj.message === "object" && obj.message !== null) {
				this.#runMessages.push(obj.message as AgentMessage);
			}
			if (obj.type === "agent_end") {
				const delivered = this.#runMessages;
				this.#runMessages = [];
				// Stock's agent_end can omit part of the run it already streamed (run-messages.ts).
				if (Array.isArray(obj.messages) && this.#rpcClient) {
					this.#holdForEntryIds({ ...obj, messages: completeRunMessages(delivered, obj.messages) });
					return;
				}
			}
			if (obj.type === "session_info_update") this.#session = null;
		}
		this.#dispatchFrame(obj);
	}

	/**
	 * Stock `agent_end` messages carry no `entryId`, which the renderer needs to
	 * reconcile committed messages. Let the bridge match persisted ids with stock
	 * persistence helpers, then release the event and everything behind it.
	 */
	#holdForEntryIds(event: Frame): void {
		const held = { event, frames: [] as Frame[], released: Promise.withResolvers<void>() };
		this.#held = held;
		const generation = this.#generation;
		const timeout = Promise.withResolvers<never>();
		const timer = setTimeout(() => timeout.reject(new Error("entry id fetch timed out")), ENTRY_ID_TIMEOUT_MS);
		const enrich = this.#bridge?.request<{ messages: AgentMessage[] }>("sessions.attach_entry_ids", {
			messages: event.messages,
		});
		void Promise.race([enrich ?? Promise.reject(new Error("Bridge is disconnected")), timeout.promise])
			.then(
				result => ({ ...event, messages: result.messages }),
				() => event,
			)
			.then(enriched => {
				clearTimeout(timer);
				if (!this.#isLive(generation) || this.#held !== held) return;
				this.#held = null;
				this.#dispatchFrame(enriched);
				for (const frame of held.frames) this.#routeFrame(frame);
				held.released.resolve();
			});
	}

	/** Release a held `agent_end` and its tail unchanged (the spawn is going away). */
	#releaseHeld(): void {
		const held = this.#held;
		if (!held) return;
		this.#held = null;
		this.#dispatchFrame(held.event);
		for (const frame of held.frames) this.#dispatchFrame(frame);
		held.released.resolve();
	}

	/**
	 * Frames omp sent before a response go out first: it can be a snapshot
	 * (`get_state`, a transcript page, a subagent's messages) that already holds
	 * them, and a batch would deliver them after it, replayed on top of that
	 * snapshot in the renderer. Agent events leave the batcher here;
	 * `beforeResponse` lets the pool send the subagent frames it batches.
	 */
	#flushBeforeResponse(): void {
		this.#batcher?.flushNow();
		this.emit("beforeResponse");
	}

	#dispatchFrame(frame: Frame): void {
		const obj = this.#options.frameTransform?.(frame) ?? frame;
		const type = obj.type as string;
		if (type === "ready") {
			this.#handleReady(obj as unknown as RpcReadyFrame);
			return;
		}
		if (type === "response") {
			this.#flushBeforeResponse();
			if (this.#rpcClient?.onResponse(obj as unknown as RpcResponse)) return;
		}
		if (AGENT_EVENT_TYPES[type] === true) {
			this.#batcher?.push(obj as AgentSessionEvent);
		} else if (type === "available_commands_update") {
			this.emit("commandsUpdate", obj.commands);
		} else if (Object.hasOwn(FRAME_EVENTS, type)) {
			this.emit(FRAME_EVENTS[type], obj);
		}
		this.emit("frame", obj);
	}

	#handleReady(ready: RpcReadyFrame): void {
		this.#resumeSessionPath = null;
		this.#bootedThisSpawn = true;
		const modelFallback = this.#bootModelFallback ?? undefined;
		this.#bootModelFallback = null;
		this.#noModelBoot = null;
		// Freshness is a creation contract, not a restart policy. Once the new
		// tab has booted successfully, later crash/manual restarts may auto-resume
		// the session it has since created or opened.
		this.#freshLaunchPending = false;
		// Negotiation settles after this frame — and when the sidecar dies on boot,
		// `#cleanup()` rejects the pending command on a generation that is already
		// gone. Unguarded, that rejection announced "ready" and zeroed the restart
		// counter, so a broken binary respawned forever behind a healthy UI.
		// Stay on v1 when an older/malformed sidecar omits the negotiation fields
		// or advertises limits this decoder cannot safely honor.
		const generation = this.#generation;
		// The extension listens before omp prints `ready`; connecting first means
		// GUI-side commands can use the bridge from the first renderer request.
		const bridge = this.#bridge;
		const ompVersion = this.#runtime?.version ?? "unknown";
		const bridgeReady =
			this.#options.bridgeDir && bridge
				? bridge.connect().then(
						() => {
							if (!this.#isLive(generation)) return;
							this.emit("bridge", { connected: true, ompVersion, bridge });
							// generate_image is off in stock; the bridge turns it on while the user
							// hasn't decided and a connected account can make images.
							this.syncImageGeneration();
							// The setting may have changed between spawn (env) and connect.
							this.syncReplyLanguage();
							this.syncUserProfile();
							this.syncNextPrompt();
							this.syncAutoTitle();
							this.syncJudgeAssist();
							this.syncAccountRotation();
							void bridge
								.request("stream_metadata.start")
								.catch(error => console.warn("[sidecar] stock stream metadata unavailable:", error));
						},
						(err: unknown) => {
							const error = err instanceof Error ? err.message : String(err);
							console.warn(`[sidecar] gui-bridge unavailable: ${error}`);
							if (this.#isLive(generation)) this.emit("bridge", { connected: false, ompVersion, error });
						},
					)
				: Promise.resolve();
		const announceReady = (): void => {
			void bridgeReady.then(async () => {
				if (!this.#isLive(generation)) return;
				const gate = this.#startGate;
				this.#startGate = null;
				if (gate && bridge?.connected) {
					const cwd = await gate(bridge, this.#options.cwd).catch(() => null);
					if (this.#disposed) return;
					if (cwd) {
						// The tab's session begins in `cwd`: a fresh one, never an autoResume.
						this.#freshLaunchPending = true;
						this.restart(cwd);
						return;
					}
					if (!this.#isLive(generation)) return;
				}
				this.#setStatus("ready", undefined, undefined, modelFallback);
				this.#restartCount = 0;
			});
		};
		const announceReadyWithEventFilter = (): void => {
			if (this.#isLive(generation) && this.#rpcClient) {
				void this.#rpcClient
					.command({ type: "set_event_filter", events: Object.keys(AGENT_EVENT_TYPES) })
					.catch(() => {});
				// Opt into upstream's `ask` protocol — the GUI renders ask dialogs.
				void this.#rpcClient.command({ type: "set_ask_dialog", enabled: true }).catch(() => {});
				// GUI-executed tools: the tab's terminals, read-only (C115), visuals in the Preview (C135) and,
				// while their switch is on, the OMPdesk control tools (src/main/agent-control); ipc.ts executes the calls.
				this.syncHostTools(true);
			}
			announceReady();
		};
		if (supportsRpcProtocolV2(ready)) {
			this.#rpcClient
				?.command({ type: "negotiate_protocol", protocolVersion: 2 })
				.then(announceReadyWithEventFilter, announceReady);
		} else {
			announceReady();
		}
	}

	/** Continuation guard: false once the spawn cycle that captured `generation`
	 *  has been torn down or replaced. */
	#isLive(generation: number): boolean {
		return !this.#disposed && generation === this.#generation;
	}

	#attemptRestart(reason: string): void {
		// The exit code alone is never the diagnosis; the spawn's stderr carries it.
		const excerpt = stderrExcerpt(this.#lastStderr);
		const detail = excerpt ? `${reason} — ${excerpt}` : reason;
		const exhausted = this.#restartCount >= MAX_RESTART_ATTEMPTS;
		const attempt = exhausted ? MAX_RESTART_ATTEMPTS : this.#restartCount + 1;
		this.#options.reportFailure?.({
			reason: detail,
			attempt,
			maxAttempts: MAX_RESTART_ATTEMPTS,
			stderr: [...this.#lastStderr],
			cwd: this.#options.cwd,
		});
		if (exhausted) {
			this.#setStatus("error", detail, { attempt, maxAttempts: MAX_RESTART_ATTEMPTS });
			return;
		}

		const delay = restartDelay(attempt);
		this.#restartCount = attempt;
		this.#setStatus("restarting", detail, { attempt, maxAttempts: MAX_RESTART_ATTEMPTS });

		this.#restartTimer = setTimeout(() => {
			this.#restartTimer = null;
			if (!this.#disposed) {
				this.#spawn();
			}
		}, delay);
	}

	/**
	 * A spawn that died before `ready` because its saved session model could not
	 * be restored would fail identically on every retry. Arm one `--model @default`
	 * respawn instead (outside the crash budget); true when armed.
	 */
	#recoverBootModelRestore(): boolean {
		if (this.#bootedThisSpawn || this.#bootModelFallback) return false;
		const missing = parseModelRestoreFailure(this.#lastStderr.join("\n"));
		if (!missing) return false;
		console.warn(`[sidecar] session model ${missing} unavailable at boot — resuming on the default model`);
		this.#bootModelFallback = missing;
		return true;
	}

	/**
	 * Stock omp exits before `ready` when no model has credentials, and would on
	 * every retry. Arm one respawn with an explicit catalog model instead
	 * (outside the crash budget); true when armed. A spawn that already carried
	 * it falls through to the crash-loop path.
	 */
	#recoverNoModelBoot(): boolean {
		const resolve = this.#options.bootModel;
		const runtime = this.#runtime;
		if (!resolve || !runtime || this.#bootedThisSpawn || this.#noModelBoot) return false;
		if (!isNoModelBootFailure(this.#lastStderr.join("\n"))) return false;
		// kill()/restart() while the selector resolves advance the generation.
		const generation = this.#generation;
		void resolve(runtime).then(selector => {
			if (!this.#isLive(generation) || this.#child) return;
			console.warn(`[sidecar] omp has no usable model — booting on ${selector} so onboarding can connect one`);
			this.#noModelBoot = selector;
			this.#spawn();
		});
		return true;
	}

	#setStatus(
		status: SidecarStatus,
		message?: string,
		restart?: SidecarRestartProgress,
		modelFallback?: string,
		sessionEnded?: true,
	): void {
		this.#status = status;
		this.#statusDetail = { message, restart, modelFallback, sessionEnded };
		this.emit("status", { status, message, cwd: this.#options.cwd, restart, modelFallback, sessionEnded });
	}

	#cleanup(): void {
		// Any async continuation of the current cycle (pending negotiation) is
		// stale from here on, even before the replacement spawns.
		this.#generation++;
		this.#unhealthy = false;
		clearTimeout(this.#recoveryTimer ?? undefined);
		this.#recoveryTimer = null;
		this.#detachParser?.();
		this.#detachParser = null;
		this.#releaseHeld();
		this.#runMessages = [];
		this.#batcher?.flushNow();
		this.#batcher?.dispose();
		this.#batcher = null;
		this.#rpcClient?.rejectAll("Sidecar disconnected");
		this.#rpcClient = null;
		this.#bridge?.close();
		this.#bridge = null;
		if (this.#bridgeAddress) removeBridgeAddress(this.#bridgeAddress);
		this.#bridgeAddress = null;
		this.#child = null;
	}

	/**
	 * Ask this omp to re-read credentials and switch its image tool to match
	 * (gui-bridge `image_generation_sync`). Fire-and-forget: a tab without a
	 * connected bridge simply catches up on its next connect.
	 */
	syncImageGeneration(): void {
		void this.#bridge?.request("image_generation_sync").catch(() => {});
	}

	/**
	 * An extension update landed or another session changed MCP servers: the live session reloads plugin state,
	 * stock reconnects the MCP servers whose package changed, and the bridge's `mcp_sync` follows the MCP
	 * configuration and credentials on disk. Rejects on a bridge failure (the caller ignores it).
	 */
	async reloadExtensions(plan: { reload: boolean; reconnect: string[]; mcp?: McpLiveChange }): Promise<void> {
		const bridge = this.#bridge;
		if (!bridge) throw new Error("Bridge is disconnected");
		if (plan.reload) await bridge.request("extension_update.reload");
		if (plan.reconnect.length > 0) await bridge.request("extension_update.reconnect", { names: plan.reconnect });
		if (plan.mcp) await bridge.request("mcp_sync", plan.mcp.all ? {} : { names: plan.mcp.names });
	}

	/**
	 * (Re-)register the GUI-executed host tools on this omp (stock `set_host_tools` replaces the set): the
	 * terminals and visuals always, the OMPdesk control tools while their Settings switch is on. Sent once the
	 * protocol is negotiated (`initial`), and again when the switch changes on a ready omp; one that is not ready
	 * yet gets the current set from its own initial send.
	 */
	syncHostTools(initial = false): void {
		if (!this.#rpcClient || (!initial && this.#status !== "ready")) return;
		const tools = [
			TERMINAL_READ_DEFINITION,
			VISUALIZE_DEFINITION,
			...(this.#options.hostTools?.() ? AGENT_CONTROL_DEFINITIONS : []),
		];
		void this.#rpcClient.command({ type: "set_host_tools", tools }).catch(() => {});
	}

	/**
	 * Push the current reply language to this omp (gui-bridge
	 * `reply_language_set`); its next turn's system prompt follows. Fire-and-
	 * forget like syncImageGeneration: an unconnected bridge syncs on connect.
	 */
	syncReplyLanguage(): void {
		const language = this.#options.replyLanguage?.() ?? null;
		void this.#bridge?.request("reply_language_set", { language }).catch(() => {});
	}

	/**
	 * Push the current profile to this omp (gui-bridge `user_profile_set`);
	 * its next turn's system prompt follows. Fire-and-forget like
	 * syncReplyLanguage: an unconnected bridge syncs on connect.
	 */
	syncUserProfile(): void {
		const profile = this.#options.userProfile?.();
		if (profile) void this.#bridge?.request("user_profile_set", profile).catch(() => {});
	}

	/**
	 * Push the current prompt-suggestion switches to this omp (gui-bridge
	 * `next_prompt_set`); the bridge starts or stops suggesting and answers
	 * with a `next_prompt_config` frame. Fire-and-forget like syncReplyLanguage:
	 * an unconnected bridge syncs on connect, and an omp without the feature
	 * refuses it and stays stock.
	 */
	syncNextPrompt(): void {
		const settings = this.#options.nextPrompt?.();
		if (settings) {
			void this.#bridge
				?.request("next_prompt_set", { suggestions: settings.suggestions, inline: settings.inline })
				.catch(() => {});
		}
	}

	/**
	 * Push the current automatic-title switches to this omp (gui-bridge `auto_title_set`); it also hands the
	 * bridge the live session to watch. Fire-and-forget like syncNextPrompt: an unconnected bridge syncs on
	 * connect, and an omp without the feature refuses it and stays stock.
	 */
	syncAutoTitle(): void {
		const settings = this.#options.autoTitle?.();
		if (settings) {
			void this.#bridge
				?.request("auto_title_set", {
					enabled: settings.enabled,
					evolve: settings.evolve,
					suppressed: this.#titleSuppressed,
				})
				.catch(() => {});
		}
	}

	/**
	 * Push the judge-assist switch to this omp (gui-bridge `judge_assist_set`). Fire-and-forget like syncAutoTitle:
	 * an unconnected bridge syncs on connect, and an omp without the feature refuses it and stays stock.
	 */
	syncJudgeAssist(): void {
		const enabled = this.#options.judgeAssist?.();
		if (enabled !== undefined) void this.#bridge?.request(JUDGE_ASSIST_SET, { enabled }).catch(() => {});
	}

	/**
	 * A direct request to this omp's own bridge, not through the RPC client: main-side assists that must not meter a
	 * paired device's quota or name it the tab's driver (notify-triage.ts). Rejects while no bridge is connected.
	 */
	bridgeRequest(method: string, params?: unknown): Promise<unknown> {
		return this.#bridge
			? this.#bridge.request(method, params)
			: Promise.reject(new Error("gui-bridge not connected"));
	}

	/**
	 * Push the current account-rotation mode to this omp (gui-bridge
	 * `account_rotation_set`); its next prompt follows. Fire-and-forget like
	 * syncReplyLanguage: an unconnected bridge syncs on connect, and an omp
	 * without the feature refuses it (`unsupported_omp`) and stays stock.
	 */
	syncAccountRotation(): void {
		const mode = this.#options.accountRotation?.();
		if (mode) void this.#bridge?.request("account_rotation_set", { mode }).catch(() => {});
	}

	/** Send a side-channel frame (bypasses command queue). */
	sendSideChannel(frame: object): void {
		if (this.#child?.stdin?.writable) {
			this.#child.stdin.write(`${JSON.stringify(frame)}\n`);
		}
	}

	/**
	 * Mark the sidecar unhealthy: a health check failed after ready. The child
	 * may be wedged or merely busy (a slow discovery await on the serial
	 * command queue), so it is neither killed nor restarted — that would throw
	 * away a live session. Instead it reports `error` and is re-probed with a
	 * `get_state` every few seconds; the first successful command (the probe or
	 * anything else) sets it `ready` again. A verdict that lands after the child
	 * already crashed or restarted is stale and ignored.
	 */
	markUnhealthy(reason: string): void {
		if (this.#status !== "ready" || !this.#child) return;
		this.#unhealthy = true;
		this.#setStatus("error", reason);
		this.#scheduleRecoveryProbe();
	}

	#scheduleRecoveryProbe(): void {
		const generation = this.#generation;
		this.#recoveryTimer = setTimeout(() => {
			this.#recoveryTimer = null;
			const client = this.#rpcClient;
			if (!this.#unhealthy || !this.#isLive(generation) || !client) return;
			const retry = () => {
				if (this.#unhealthy && this.#isLive(generation)) this.#scheduleRecoveryProbe();
			};
			client.stock({ type: "get_state" }).then(response => {
				if (!response.success) retry();
			}, retry);
		}, this.#options.healthRecoveryProbeMs ?? HEALTH_RECOVERY_PROBE_MS);
	}

	#recoverHealth(): void {
		if (!this.#unhealthy) return;
		this.#unhealthy = false;
		clearTimeout(this.#recoveryTimer ?? undefined);
		this.#recoveryTimer = null;
		this.#setStatus("ready");
	}

	/**
	 * Adopt a new logical cwd WITHOUT a respawn. `switch_session` onto a file
	 * rooted in another workspace re-roots the agent with no main-observable
	 * event, leaving `get cwd()` (and the tab chip reading it) frozen at the
	 * spawn cwd. The RPC passthrough reports the post-switch cwd here so every
	 * consumer — status payloads, future plain `restart()` spawns,
	 * launch-profile lookup — follows the live session. Project switch goes
	 * through `restart(cwd)` instead (explicit re-root). Returns true when the
	 * cwd actually changed.
	 */
	adoptCwd(cwd: string): boolean {
		if (cwd === this.#options.cwd) return false;
		this.#options = { ...this.#options, cwd };
		return true;
	}

	/** Hold the first spawn at `starting` until `gate` settles (set before that spawn's `ready`). */
	setStartGate(gate: SidecarStartGate): void {
		this.#startGate = gate;
	}

	/** Resolves once the current child process has exited (at once when there is none). */
	whenExited(): Promise<void> {
		const child = this.#child;
		if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		child.once("exit", () => resolve());
		return promise;
	}

	restart(cwd?: string, resumeSessionPath?: string): void {
		this.kill();
		if (cwd) this.#options = { ...this.#options, cwd };
		this.#resumeSessionPath = resumeSessionPath ?? null;
		this.#bootModelFallback = null;
		this.#noModelBoot = null;
		this.#restartCount = 0;
		this.start();
	}

	kill(): void {
		if (this.#restartTimer) {
			clearTimeout(this.#restartTimer);
			this.#restartTimer = null;
		}
		const child = this.#child;
		this.#cleanup();
		if (child) terminate(child);
	}

	dispose(): void {
		this.#disposed = true;
		const grace = this.#options.gracefulStopMs?.() ?? 0;
		const child = this.#child;
		if (grace > 0 && child?.stdin && child.exitCode === null && child.signalCode === null) {
			// Stock omp emits `session_shutdown` (ai-memory's `session-end` hook, which makes the handoff) only when its
			// stdin ends; SIGTERM kills it before. Close stdin first and escalate after the grace period.
			if (this.#restartTimer) clearTimeout(this.#restartTimer);
			this.#restartTimer = null;
			this.#cleanup();
			child.stdin.end();
			const timer = setTimeout(() => terminate(child), grace);
			child.once("exit", () => clearTimeout(timer));
		} else this.kill();
		this.removeAllListeners();
	}
}
