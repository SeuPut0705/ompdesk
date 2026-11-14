/**
 * Sidecar lifecycle manager: main's client of a tab's lane in the core (`native/ompdesk/crates/core/src/sidecar`, which
 * spawns the system `omp --mode rpc-ui` with the gui-bridge extension, owns its stdio and bridge socket and handles
 * ready, restart and stop) and the mirror of what the lane says. Main keeps how a spawn is made, the routing of
 * frames to the EventBatcher and the pool's events, and the GUI-side commands (src/main/local) it answers in-process.
 */

import { EventEmitter } from "node:events";
import type { McpLiveChange } from "../../resources/gui-bridge/extensions/mcp-contracts";
import { type AutoTitleSettings, titleSuppressedByEnv } from "../../resources/gui-bridge/modes/auto-title-contracts";
import type { DelegationMode } from "../../resources/gui-bridge/modes/delegation-contracts";
import { JUDGE_ASSIST_SET } from "../../resources/gui-bridge/modes/judge-assist-contracts";
import type { NextPromptSettings } from "../../resources/gui-bridge/modes/next-prompt-contracts";
import type { UserProfile } from "../../resources/gui-bridge/modes/user-profile-contracts";
import type { PromptOriginEnv } from "../../resources/gui-bridge/prompt-origin-contracts";
import type { AccountRotationMode } from "../shared/account-rotation";
import type { AgentBrowser } from "../shared/default-browser";
import { parseLaunchProfile, profileToFlags } from "../shared/launch-profile";
import { parseModelRestoreFailure } from "../shared/model-restore";
import type {
	AgentSessionEvent,
	RpcCommand,
	RpcResponse,
	SidecarStatus,
	SidecarStatusPayload,
} from "../shared/rpc-types";
import { BTW_FRAME_TYPES, LIVE_FRAME_TYPES } from "../shared/rpc-types";
import { AGENT_CONTROL_DEFINITIONS } from "./agent-control/tools";
import { type LowerAgentPriority, lowerAgentPriority } from "./agent-priority";
import { isNoModelBootFailure } from "./boot-model";
import { withoutControlEnv } from "./control-socket/env";
import { CoreError, core } from "./core/process";
import { EventBatcher } from "./event-batcher";
import { withoutFrameBookkeeping } from "./frame-bookkeeping";
import { localHandlerFor, runLocalCommand } from "./local";
import { projectQueueUpdate } from "./local/queue";
import { type BridgeClient, type LocalCommandContext, LocalCommandError, type OmpRuntime } from "./local/types";
import {
	type BuiltinLaunch,
	type OmpLaunch,
	ompArgs,
	type SessionOpen,
	type SessionSettings,
	sessionEnv,
	withoutSessionEnv,
} from "./omp-launch";
import { ompLogTail } from "./omp-log-tail";
import { OMP_TELEMETRY_OFF, type OmpResolution, ompBunDefaults, ompPathEnv } from "./omp-runtime";
import { VISUALIZE_DEFINITION } from "./preview/definition";
import { createLinkEventDecoder } from "./remote/link-events";
import { RpcClient, RpcTimeoutError } from "./rpc-client";
import type { SessionProcesses, SessionProcessHandle } from "./session-processes";
import { needsShell, spawnArgs, spawnCommand } from "./spawn";
import { TERMINAL_READ_DEFINITION } from "./terminal/agent-tool";

/** `ctx.send` from GUI-side handlers: stock commands such as `get_entries` on a long session. */
const LOCAL_SEND_TIMEOUT_MS = 120_000;
/** A request the core answers when it is done (the longest a timer may be set for): the call has no deadline of its own. */
const NO_DEADLINE_MS = 2 ** 31 - 1;
/** The lane's own deadline of a bridge request, and what main's wait for its answer sits behind it. */
const CORE_ANSWER_SLACK_MS = 10_000;
/**
 * How long a started omp may stay silent before its tab says so. Stock omp answers `get_state` within seconds; past this
 * the tab reads `starting` with `slow` and the omp's stderr tail, its place in the start queue goes to the next tab, and
 * the omp is still waited for. A live omp is never stopped or failed for being slow (the owner's rule, 9 Nov 2026: the
 * 45 s stop-and-retry of 0.119.7 killed every omp of a MacBook before it could answer); only Restart stops it.
 */
const START_SLOW_MS = 20_000;

/**
 * The environment a spawn gets, as node's `spawn` hands it to the child: values that are undefined are left out and,
 * on Windows, where names are case-insensitive, the first of a name's spellings in sorted order is the only one.
 */
function childEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const out: Record<string, string> = {};
	const seen = new Set<string>();
	for (const key of Object.keys(env).sort()) {
		if (process.platform === "win32") {
			const name = key.toUpperCase();
			if (seen.has(name)) continue;
			seen.add(name);
		}
		const value = env[key];
		if (value !== undefined) out[key] = value;
	}
	return out;
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
	// The main loop's provider request went out / was answered (bridge turn-stages.ts): the working cue's model wait.
	model_request: true,
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

/**
 * Frames that settle a run: the pool turns them into the tab's status, which a window reads as the run's end. Agent
 * events batched before one leave first, so a window has the run's agent_end (and its committed messages) by then.
 */
const RUN_SETTLE_FRAMES: Record<string, true> = { prompt_result: true, session_settled: true };

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
	builtinMcp?: () => Promise<BuiltinLaunch>;
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
	 * metadata (session-kinds.ts) for the sidebar's Chats section.
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
	 * Waits until no other live omp owns the stored session this start opens (session-free.ts): one that still owns it
	 * would make the new omp move the session to another file. `owned` (still held when the wait ran out) opens
	 * nothing: the tab is `error` with `sessionOwnedText`, and Restart waits again. Absent (tests): no wait.
	 */
	sessionFree?: (sessionPath: string) => Promise<"free" | "owned">;
	/** The localized reason a start gave up on a session another omp holds. */
	sessionOwnedText?: () => string;
	/**
	 * The reply language's English name (`Korean`; the Settings choice, else the
	 * device language), passed to omp as `OMP_GUI_REPLY_LANGUAGE` for the
	 * gui-bridge's reply-language instruction. Same point-of-use pattern as
	 * proxyEnv: read on every spawn, and by `syncReplyLanguage()` for the live
	 * session. Undefined: no instruction.
	 */
	replyLanguage?: () => string | undefined;
	/**
	 * The browser agents use (`ego` or `builtin`: the Default browser pref met with whether ego-browser is
	 * installed), passed to omp as `OMP_GUI_BROWSER` for the gui-bridge's browser section. Resolved on every
	 * `start()` (a restart after an exit reuses it) and by `syncDefaultBrowser()` for the live session. Absent: no
	 * variable, the section stays off.
	 */
	defaultBrowser?: () => Promise<AgentBrowser> | AgentBrowser;
	/**
	 * ego-browser's folder when it is installed (null when not): added to the session's PATH, since the browser
	 * section has agents run a bare `ego-browser` and it is also found where the login shell's PATH may not look
	 * (`~/.local/bin`). Added whatever the choice, so a live switch to ego-browser finds it too.
	 */
	egoBrowserDir?: () => Promise<string | null>;
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
	 * What this tab's omp is told about the control socket (`controlEnvFor`, src/main/control-socket/env.ts): this
	 * computer's own tabs get its address, a tab run for a paired device or the phone page only `OMPDESK_CONTROL_OFF`.
	 * Read on every spawn. Absent: nothing.
	 */
	controlEnv?: () => Record<string, string>;
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
	/**
	 * Settings › Models & accounts › Credit use (prefs `creditSpend`, default off), passed as `OMP_GUI_CREDIT_SPEND` on
	 * every spawn and pushed by `syncCreditSpend()`. Absent: the bridge's default (off).
	 */
	creditSpend?: () => boolean;
	/** The OMPdesk model-role picks every local omp shares (`OMP_GUI_OMPDESK_ROLES`, ompdesk-role-contracts.ts). */
	ompdeskRolesFile?: string;
	/**
	 * The stored per-workspace launch profiles (prefs `launchProfiles`), read at
	 * every spawn and mapped to the tab cwd's agent flags. Absent: no profile
	 * flags, and no prefs file is touched.
	 */
	launchProfiles?: () => unknown;
	/** How long a closed tab's omp gets to end on its own (stdin closed) before its stop's SIGTERM; 0 or absent: none. */
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
	/** Logs a start that has not answered after `START_SLOW_MS`, with what it said so far; once per spawn. */
	reportSlowStart?: (report: SlowStartReport) => void;
	/** The last lines omp `pid` wrote to its own log (default `ompLogTail`; tests inject). */
	readOmpLog?: (pid: number, spawnedAt: Date) => Promise<string[]>;
	/**
	 * Lowers a spawned omp's CPU priority below the app's own (agent-priority.ts); the tools it starts inherit it.
	 * Default: `lowerAgentPriority`. The factory injects one that logs the first failure to gui-runtime.jsonl.
	 */
	lowerPriority?: LowerAgentPriority;
	/**
	 * A catalog `provider/model` selector for `runtime` (src/main/boot-model.ts).
	 * Absent: a spawn that exits for lack of a usable model just crash-loops.
	 */
	bootModel?: (runtime: OmpRuntime) => Promise<string>;
	/**
	 * The app's one queue of omp starts (the core's, `sidecar/queue.rs`: two at once, a place held 15 s at most). Present:
	 * this tab's starts go through it, and a field here reconfigures it for the starts after (tests). Absent (tests):
	 * every start goes at once.
	 */
	startQueue?: { startsAtOnce?: number; startSlotCapMs?: number };
	/** The file that names the omps the app runs for the next launch's reap (`omp-processes.ts`); the lane writes it. Absent (tests): none kept. */
	ledgerFile?: string;
	/** How long `agent_end` (and every frame behind it) may wait for its entry ids (the lane's default: 5 s). */
	entryIdTimeoutMs?: number;
	/** Test seam, the lane's clocks: `stopGraceMs`, `killWaitMs`, `stderrDrainMs`, `restartDelaysMs`. */
	tuning?: { stopGraceMs?: number; killWaitMs?: number; stderrDrainMs?: number; restartDelaysMs?: number[] };
	/**
	 * Whose the processes this tab's omps start are (`session-processes.ts`): the tab's tag goes into every spawn's
	 * environment, and what still carries it ends once the tab is disposed. Absent (tests): no tag.
	 */
	sessionProcesses?: Pick<SessionProcesses, "open">;
	/** How long a started omp may stay silent before its tab reads slow (`START_SLOW_MS`; tests shorten it). */
	startSlowMs?: number;
}

/** A start past `START_SLOW_MS`, as handed to `reportSlowStart`. */
export interface SlowStartReport {
	waitedMs: number;
	stderr: string[];
	/** The omp's own log tail (`ompLogTail`): what it said when stderr says nothing. */
	ompLog: string[];
	/** omp printed `ready` (it reached its RPC loop's setup), so the wait is in what follows. */
	ready: boolean;
	/** The stock commands sent and not answered, oldest first: the one omp is held in leads. */
	unanswered: string[];
	cwd: string;
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

/**
 * What a lane of the core says (`native/ompdesk/crates/core/src/sidecar`): every event names its tab and `cmd`, the
 * highest message of that tab the lane had applied when it sent the event. An ask also names itself (`ask`) and is
 * answered by the request of the same name in the past tense, carrying that number.
 */
interface LaneEvent {
	tab: string;
	cmd: number;
}
interface LaneAsk extends LaneEvent {
	ask: number;
	/** The generation of the core that asked (`CoreProcess.generation`), added when the ask is taken from the listener. */
	generation: number;
}
interface ResolveAsk extends LaneAsk {
	sessionPath: string | null;
}
interface LaunchAsk extends LaneAsk {
	open: SessionOpen;
	model?: string;
	bridgeAddress?: string | null;
}
interface ExitAsk extends LaneAsk {
	stderr: string;
	booted: boolean;
	/** This spawn already carried `--model @default` / a catalog model: the matching recovery is spent (one respawn each). */
	fallbackArmed: boolean;
	noModelArmed: boolean;
}
interface SlowAsk extends LaneAsk {
	pid: number;
	spawnedAt: number | string;
}
interface SessionWaitAsk extends LaneAsk {
	sessionPath: string;
}
interface StatusEvent extends LaneEvent {
	payload: SidecarStatusPayload;
}
interface PidEvent extends LaneEvent {
	pid: number;
}
interface SessionEvent extends LaneEvent {
	identity: SidecarSessionIdentity | null;
}
interface TabSessionEvent extends LaneEvent {
	sessionPath: string | null;
	isNew: boolean;
}
interface BridgeStateEvent extends LaneEvent {
	connected: boolean;
	error?: string;
}
interface TextEvent extends LaneEvent {
	text: string;
}
interface FailureEvent extends LaneEvent {
	report: SidecarFailureReport;
}
interface SlowReportEvent extends LaneEvent {
	report: SlowStartReport;
}

interface AnswerEvent extends LaneEvent {
	/** The number of the message (`sidecar.command`, `sidecar.barrier`) this answers. */
	seq: number;
}

type LaneListener = (name: string, data: LaneEvent, bin: Uint8Array | null, generation: number) => void;

/** Every live manager by its tab id: the core's events name the tab they are for. */
const lanes = new Map<string, LaneListener>();
let tabCount = 0;
let listening = false;

const LANE_EVENTS = [
	"resolve",
	"launch",
	"exit",
	"gateAsk",
	"slow",
	"sessionWait",
	"status",
	"spawned",
	"exited",
	"frame",
	"answer",
	"session",
	"tabSession",
	"bridgeState",
	"bridgeLost",
	"stderr",
	"failure",
	"slowReport",
	"disposed",
] as const;

/** Subscribes once, across every core this app starts: the listeners belong to the process object, not to a start. */
function listen(): void {
	if (listening) return;
	listening = true;
	for (const name of LANE_EVENTS) {
		core().on(`sidecar.${name}`, (data, bin, generation) => {
			const event = data as LaneEvent;
			lanes.get(event.tab)?.(name, event, bin, generation);
		});
	}
}

/** The core's own failures: a request it could not answer. The lane's and the bridge's faults are told apart by code. */
const CORE_CODES: Record<string, true> = { core_exited: true, core_unavailable: true, timeout: true };

/**
 * Rebuilds what `GuiBridgeClient.request` rejected with from the lane's fault: a bridge that sent a code gives a
 * `LocalCommandError` of it (the codes the GUI explains: `unsupported_omp`), one that sent none a plain error.
 */
function bridgeError(error: unknown): unknown {
	if (!(error instanceof CoreError) || CORE_CODES[error.code] === true) return error;
	if (error.code === "bridge_error") return new Error(error.message);
	if (error.code === "bridge_disconnected")
		return new LocalCommandError("GUI bridge is not connected", "bridge_unavailable");
	return new LocalCommandError(error.message, error.code);
}

/** The tab's omp's gui-bridge, as main's code knows it: each request goes through the tab's lane in the core. */
class BridgeRelay implements BridgeClient {
	connected = false;
	#closed = false;
	readonly #tab: string;
	readonly #nextSeq: () => number;

	constructor(tab: string, nextSeq: () => number) {
		this.#tab = tab;
		this.#nextSeq = nextSeq;
	}

	/** The omp this relay was made for is gone: a request no longer reaches the tab's next omp. */
	close(): void {
		this.#closed = true;
		this.connected = false;
	}

	/**
	 * `options.timeoutMs`: a request the bridge has not answered by then rejects (`bridge_timeout`). Without it a
	 * request waits as long as the bridge takes (a user prompt, a login).
	 */
	async request<T = unknown>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T> {
		if (this.#closed) throw new LocalCommandError("GUI bridge closed", "bridge_unavailable");
		const timeoutMs = options?.timeoutMs;
		try {
			// `seq` is taken before the first await: messages leave in the order main makes them.
			const { result } = await core().call<{ result: T }>(
				"sidecar.bridge",
				{ tab: this.#tab, seq: this.#nextSeq(), method, params, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
				{ timeoutMs: timeoutMs === undefined ? NO_DEADLINE_MS : timeoutMs + CORE_ANSWER_SLACK_MS },
			);
			return result.result;
		} catch (error) {
			throw bridgeError(error);
		}
	}
}

/** Which of the lane's messages change what the mirror predicts at once (see the fences in `SidecarManager`). */
interface Fences {
	/** The omp is gone from the mirror's view: what the lane says of an omp before it applied this is of the old one. */
	life?: boolean;
	/** The status is predicted: a status the lane sent before it applied this describes what came before. */
	status?: boolean;
	/** The cwd is predicted. */
	cwd?: boolean;
}

/**
 * One tab's omp: the client of its lane in the core (`native/ompdesk/crates/core/src/sidecar`, which spawns omp,
 * owns its stdio and its bridge socket and runs the ready/restart/stop state machine) and the mirror of what the lane
 * says, written from its events and, for the few calls whose effect the TypeScript always had at once, from the call.
 *
 * What stays here is main's: how a spawn is made (the lane asks, `#onLaunch`), the frames' routing (`#onFrame`), the
 * GUI-side commands (`RpcClient`) and everything a caller reads synchronously.
 *
 * Mirror and predictions: `start()` and `restart()` read `starting`, `restart()`/`kill()`/`sleep()`/`dispose()` read
 * the omp gone, `sleep()` of a live omp reads `asleep`, `restart(cwd)`/`adoptCwd(cwd)` the cwd, all before the lane
 * answers. The lane's own event for one of those is kept out by a fence (`cmd` lower than the message's number: it
 * describes the state before it), and the status it echoes is not emitted a second time.
 */
export class SidecarManager extends EventEmitter {
	readonly #tab = `${process.pid}-${++tabCount}`;
	/** The number of the last message main sent the lane; each message of the tab takes the next one. */
	#seq = 0;
	/** The lane exists in the core (`sidecar.open` was sent and has not ended). */
	#opened = false;
	#alive = false;
	#pid: number | undefined;
	#rpcClient: RpcClient | null = null;
	/** The running omp's bridge; null while none runs. */
	#bridge: BridgeRelay | null = null;
	/** The last omp's bridge, kept until the next spawn: frames the lane releases after a stop still project their queues by it. */
	#spawnRelay: BridgeRelay | null = null;
	#batcher: EventBatcher | null = null;
	/**
	 * The lane sends every `message_update` after the first of its message reduced (`sidecar/stream.rs`); this rebuilds
	 * them whole, as a paired device rebuilds a host's. The lane sends whole again wherever this may lack the base.
	 */
	readonly #rebuild = createLinkEventDecoder();
	/** What waits for the lane's answer event of a message (`seq`): a stock command's response, a barrier. */
	readonly #answers = new Map<number, (bin: Uint8Array | null) => void>();
	#lifeFence = 0;
	#statusFence = 0;
	#cwdFence = 0;
	/** The JSON of the status last predicted: the lane's echo of it is not emitted again. */
	#echo: string | null = null;
	/**
	 * `asleep` until something calls start(): a restored background tab costs nothing until it is shown. start() flips
	 * to `starting` at once, so "is a spawn already under way?" is answerable from this field alone.
	 */
	#status: SidecarStatus = "asleep";
	/**
	 * The last `status` event's detail. An early failure (e.g. omp not found) fires before the window subscribes; the
	 * renderer's boot snapshot (SIDECAR_STATUS_GET) reads this so the reason is not lost.
	 */
	#statusDetail: Omit<SidecarStatusPayload, "status" | "cwd"> = {};
	#options: SidecarOptions;
	#runtime: OmpRuntime | null = null;
	#proxyEnvVars: Record<string, string> = {};
	#builtinMcp: BuiltinLaunch = { args: [] };
	#defaultBrowser: AgentBrowser | undefined;
	#egoBrowserDir: string | null = null;
	#shellEnvVars: Record<string, string> = {};
	/** The session this tab is on, for every spawn of it: the lane's, told by `sidecar.tabSession` (a lost core opens a lane on it). */
	#sessionPath: string | null = null;
	#isNew: boolean;
	/** The user's own environment turned stock's automatic titles off for this spawn (see AutoTitleSettings). */
	#titleSuppressed = false;
	/** Last session identity `get_state` reported; null when a session change made it unknown. */
	#session: SidecarSessionIdentity | null = null;
	#disposed = false;
	/** One-shot gate held until the first spawn's `ready` (see SidecarStartGate). */
	#startGate: SidecarStartGate | null = null;
	/** The tab's process tag, made at its first spawn and kept for every later one. */
	#processes: SessionProcessHandle | null = null;

	constructor(options: SidecarOptions) {
		super();
		this.#options = options;
		this.#isNew = options.fresh === true;
		lanes.set(this.#tab, (name, data, bin, generation) => this.#onLane(name, data, bin, generation));
		listen();
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

	/** Non-null exactly while an omp runs (as the child and its client were set together). */
	get rpcClient(): RpcClient | null {
		return this.#rpcClient;
	}

	/** A child process is running (whatever `status` says — a failed health check reports `error` over a live child). */
	get processAlive(): boolean {
		return this.#alive;
	}

	/** The running omp's pid, for its process tree's measured footprint (memory-sampler.ts). */
	get pid(): number | undefined {
		return this.#pid;
	}

	start(): void {
		if (this.#disposed) return;
		this.#ensureOpen();
		this.#tell("sidecar.start", {}, { status: true });
		this.#predict("starting");
	}

	/** Creates the tab's lane in the core: at the first call that needs it, so a restored tab that is never shown costs nothing. */
	#ensureOpen(): void {
		if (this.#opened) return;
		this.#opened = true;
		const options = this.#options;
		const stops = core().stops;
		const tuning = { ...(options.startQueue ?? { startsAtOnce: 0 }), ...options.tuning };
		core()
			.call(
				"sidecar.open",
				{
					tab: this.#tab,
					seq: ++this.#seq,
					cwd: options.cwd,
					kind: this.kind,
					fresh: options.fresh === true,
					isNew: this.#isNew,
					sessionPath: this.#sessionPath,
					eventFilter: Object.keys(AGENT_EVENT_TYPES),
					bridge: Boolean(options.bridgeDir),
					...(options.ledgerFile ? { ledgerFile: options.ledgerFile } : {}),
					startSlowMs: options.startSlowMs ?? START_SLOW_MS,
					...(options.entryIdTimeoutMs === undefined ? {} : { entryIdTimeoutMs: options.entryIdTimeoutMs }),
					tuning,
				},
				// The lane answers when the tab is disposed and every omp it started has exited: this request is how main
				// learns of a core that ended with omps running.
				{ timeoutMs: NO_DEADLINE_MS },
			)
			.then(
				() => {
					this.#opened = false;
					lanes.delete(this.#tab);
				},
				(error: unknown) => this.#laneLost(error, stops),
			);
	}

	/**
	 * The core ended while this tab's lane lived (its omps went with it: stdin's end on POSIX, the job on Windows): a
	 * lane opens again on the session the tab is on, and starts, unless the tab slept or was closed. A core that
	 * `stop()` ended on purpose (the quit) is not started again.
	 */
	#laneLost(error: unknown, stops: number): void {
		this.#opened = false;
		this.#markGone();
		this.#batcher?.dispose();
		this.#batcher = null;
		const message = error instanceof Error ? error.message : String(error);
		if (this.#disposed) {
			this.#closeProcesses();
			lanes.delete(this.#tab);
			return;
		}
		if (error instanceof CoreError && error.code === "core_exited") {
			if (core().stops !== stops) return;
			const asleep = this.#status === "asleep";
			console.warn(`[sidecar] ${message}: opening the tab's lane again`);
			this.#setStatus("restarting", { message });
			this.#ensureOpen();
			if (!asleep) this.start();
			return;
		}
		this.#setStatus("error", { message });
	}

	/** One message to the tab's lane, numbered in the order main sends them; the lane applies them in that order. */
	#send(method: string, params: object = {}, fences: Fences = {}, timeoutMs?: number): Promise<unknown> {
		const seq = ++this.#seq;
		if (fences.life) this.#lifeFence = seq;
		if (fences.status) this.#statusFence = seq;
		if (fences.cwd) this.#cwdFence = seq;
		return core()
			.call(method, { tab: this.#tab, seq, ...params }, timeoutMs === undefined ? {} : { timeoutMs })
			.then(answer => answer.result);
	}

	/** `#send` that nobody waits for: a failure is a note (a lane that is gone has nothing left to do). */
	#tell(method: string, params: object = {}, fences: Fences = {}): void {
		this.#send(method, params, fences).catch((error: unknown) =>
			console.warn(`[sidecar] ${method}: ${error instanceof Error ? error.message : String(error)}`),
		);
	}

	/**
	 * An answer to one of the lane's asks (it drops one it no longer waits for). It goes only to the core that asked:
	 * the next core numbers its asks from 1 again, and the tab may have a lane there.
	 */
	#answer(method: string, { ask, generation }: LaneAsk, params: object = {}): void {
		core()
			.call(method, { tab: this.#tab, ask, ...params }, { generation })
			.catch(() => {
				// A core that ended meanwhile took the lane with it.
			});
	}

	/** The mirror's own status, emitted at once; `echoes`: the lane's event of the same payload is not emitted again. */
	#setStatus(status: SidecarStatus, detail: Omit<SidecarStatusPayload, "status" | "cwd"> = {}, echoes = false): void {
		this.#status = status;
		this.#statusDetail = detail;
		const payload = { status, cwd: this.#options.cwd, ...detail };
		this.#echo = echoes ? JSON.stringify(payload) : null;
		this.emit("status", payload);
	}

	#predict(status: SidecarStatus): void {
		this.#setStatus(status, {}, true);
	}

	/** The omp is gone from the mirror's view (stopped, or the core that ran it ended). */
	#markGone(): void {
		this.#alive = false;
		this.#pid = undefined;
		this.#rpcClient?.retire();
		this.#rpcClient = null;
		this.#bridge?.close();
		this.#bridge = null;
		// Frames the lane releases after the stop (an `agent_end` held for its entry ids) still go through the batcher.
		this.#batcher?.flushNow();
	}

	// ---- What the lane says -------------------------------------------------------------------------------------

	#onLane(name: string, data: LaneEvent, bin: Uint8Array | null, generation: number): void {
		switch (name) {
			case "resolve":
				return this.#onResolve({ ...(data as ResolveAsk), generation });
			case "launch":
				return this.#onLaunch({ ...(data as LaunchAsk), generation });
			case "exit":
				return this.#onExit({ ...(data as ExitAsk), generation });
			case "gateAsk":
				return this.#onGate({ ...(data as LaneAsk), generation });
			case "slow":
				return this.#onSlow({ ...(data as SlowAsk), generation });
			case "sessionWait":
				return this.#onSessionWait({ ...(data as SessionWaitAsk), generation });
			case "status":
				return this.#onStatus(data as StatusEvent);
			case "spawned":
				return this.#onSpawned(data as PidEvent);
			case "exited":
				return this.#onExited(data);
			case "frame":
				return this.#onFrame(data, bin);
			case "answer":
				return this.#onAnswer(data as AnswerEvent, bin);
			case "session":
				return this.#onSession(data as SessionEvent);
			case "tabSession":
				return this.#onTabSession(data as TabSessionEvent);
			case "bridgeState":
				return this.#onBridgeState(data as BridgeStateEvent);
			case "bridgeLost":
				if (!this.#staleOmp(data.cmd) && this.#bridge) this.#bridge.connected = false;
				return;
			case "stderr":
				return this.#onStderr(data as TextEvent);
			case "failure":
				if (!this.#disposed) this.#options.reportFailure?.((data as FailureEvent).report);
				return;
			case "slowReport":
				if (!this.#disposed) this.#options.reportSlowStart?.((data as SlowReportEvent).report);
				return;
			case "disposed":
				this.#closeProcesses();
				lanes.delete(this.#tab);
				return;
		}
	}

	/** What the tab's omps started ends once they have exited, so an omp's own cleanup of its tools comes first. */
	#closeProcesses(): void {
		const processes = this.#processes;
		this.#processes = null;
		void processes?.close();
	}

	/** What the lane says of the omp it ran before a later `restart`/`kill`/`sleep`/`dispose` is of that omp, gone. */
	#staleOmp(cmd: number): boolean {
		return this.#disposed || cmd < this.#lifeFence;
	}

	/** An ask a later start, restart, stop or close superseded needs no answer: the lane has dropped it. */
	#staleAsk(cmd: number): boolean {
		return this.#staleOmp(cmd) || cmd < this.#statusFence;
	}

	#onStatus(event: StatusEvent): void {
		if (this.#staleAsk(event.cmd)) return;
		const { status, cwd, ...detail } = event.payload;
		this.#status = status;
		this.#statusDetail = detail;
		// A cwd the lane sent before it applied a predicted one (`restart(cwd)`, `adoptCwd`) is the old one.
		if (cwd !== undefined && event.cmd >= this.#cwdFence && cwd !== this.#options.cwd)
			this.#options = { ...this.#options, cwd };
		const payload = { status, cwd: this.#options.cwd, ...detail };
		const echo = this.#echo === JSON.stringify(payload);
		this.#echo = null;
		if (!echo) this.emit("status", payload);
	}

	#onSpawned(event: PidEvent): void {
		if (this.#staleOmp(event.cmd)) return;
		const { pid } = event;
		this.#markGone();
		this.#batcher?.dispose();
		const runtime = this.#runtime;
		// Right after the spawn, before omp starts a tool: what a process starts inherits its priority. A failure
		// is logged once by the injected lowerer and never fails the start.
		(this.#options.lowerPriority ?? lowerAgentPriority)(pid);
		this.#alive = true;
		this.#pid = pid;
		this.#session = null;
		this.#processes?.setPid(pid);
		const relay = new BridgeRelay(this.#tab, () => ++this.#seq);
		this.#bridge = relay;
		this.#spawnRelay = relay;
		this.#batcher = new EventBatcher(events => {
			this.emit("events", events);
		});
		const client: RpcClient = new RpcClient({
			send: (command, timeoutMs) => this.#command(command, timeoutMs),
			local: command => {
				const handler = localHandlerFor(command.type);
				if (!handler || !runtime) return undefined;
				return this.#localContext(client, runtime, relay)
					.then(ctx => runLocalCommand(handler, command, ctx))
					.then(async response => {
						// Same as an omp response: the frames omp sent before it go first, an `agent_end` held for its
						// entry ids and its tail included.
						await this.#barrier();
						return response;
					});
			},
		});
		this.#rpcClient = client;
		this.emit("spawned");
	}

	/**
	 * A stock command to the tab's lane: the lane writes it to omp and answers with an event (`sidecar.answer`), in order
	 * with the frames omp wrote before and after the response, so the frames before it have been delivered when the
	 * caller gets it and none behind it has. The request settles behind that event.
	 */
	async #command(command: RpcCommand, timeoutMs: number): Promise<RpcResponse> {
		// `seq` is taken before the first await: messages leave in the order main makes them.
		const seq = ++this.#seq;
		const answered = Promise.withResolvers<RpcResponse>();
		this.#answers.set(seq, bin => {
			if (!bin) return;
			const frame = JSON.parse(Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength).toString("utf8")) as Frame;
			const response = this.#transform(withoutFrameBookkeeping(frame));
			this.#flushBeforeResponse();
			answered.resolve(response as unknown as RpcResponse);
		});
		const finite = Number.isFinite(timeoutMs);
		const call = core().call(
			"sidecar.command",
			{ tab: this.#tab, seq, command, ...(finite ? { timeoutMs } : {}) },
			{ timeoutMs: finite ? timeoutMs : NO_DEADLINE_MS },
		);
		try {
			// Settled by the answer event, in its place among the frames: the request's own reply comes from another task
			// of the core and may overtake a later command's answer.
			return await Promise.race([answered.promise, call.then(() => answered.promise)]);
		} catch (error) {
			if (!(error instanceof CoreError)) throw error;
			if (error.code === "timeout") throw new RpcTimeoutError(timeoutMs, command.type);
			// The lane's own refusals (`sidecar_disconnected`: "Sidecar disconnected") are plain errors with its message.
			throw new Error(error.message);
		} finally {
			this.#answers.delete(seq);
		}
	}

	/** Resolves once every frame omp sent before now, an `agent_end` held for its entry ids and its tail included, was delivered. */
	async #barrier(): Promise<void> {
		const seq = ++this.#seq;
		const released = Promise.withResolvers<void>();
		this.#answers.set(seq, () => {
			this.#flushBeforeResponse();
			released.resolve();
		});
		const call = core().call("sidecar.barrier", { tab: this.#tab, seq }, { timeoutMs: NO_DEADLINE_MS });
		try {
			await Promise.race([released.promise, call]);
		} catch {
			this.#flushBeforeResponse();
		} finally {
			this.#answers.delete(seq);
		}
	}

	/** The answer to a message of main's, in its place among the frames: what waits for it takes it as it is read. */
	#onAnswer(event: AnswerEvent, bin: Uint8Array | null): void {
		this.#answers.get(event.seq)?.(bin);
	}

	#onExited(event: LaneEvent): void {
		if (this.#staleOmp(event.cmd)) return;
		this.#markGone();
		this.#batcher?.dispose();
		this.#batcher = null;
	}

	#onStderr(event: TextEvent): void {
		// omp's own words, also those of an omp that was stopped meanwhile.
		console.error(`[sidecar stderr] ${event.text}`);
		if (!this.#disposed) this.emit("stderr", event.text);
	}

	#onSession(event: SessionEvent): void {
		if (this.#staleOmp(event.cmd)) return;
		const previous = this.#session;
		const next = event.identity;
		this.#session = next;
		if (!next) return;
		if (next.sessionFile) this.#processes?.update({ sessionPath: next.sessionFile });
		if (previous?.sessionId !== next.sessionId || previous?.sessionFile !== next.sessionFile) {
			this.emit("session", next);
		}
	}

	#onTabSession(event: TabSessionEvent): void {
		if (this.#disposed) return;
		this.#sessionPath = event.sessionPath;
		this.#isNew = event.isNew;
	}

	#onBridgeState(event: BridgeStateEvent): void {
		if (this.#staleOmp(event.cmd)) return;
		const relay = this.#bridge;
		if (!relay) return;
		const ompVersion = this.#runtime?.version ?? "unknown";
		if (!event.connected) {
			const error = event.error ?? "GUI bridge is not connected";
			console.warn(`[sidecar] gui-bridge unavailable: ${error}`);
			this.emit("bridge", { connected: false, ompVersion, error });
			return;
		}
		relay.connected = true;
		this.emit("bridge", { connected: true, ompVersion, bridge: relay });
		// generate_image is off in stock; the bridge turns it on while the user
		// hasn't decided and a connected account can make images.
		this.syncImageGeneration();
		// The setting may have changed between spawn (env) and connect.
		this.syncReplyLanguage();
		this.syncDefaultBrowser();
		this.syncUserProfile();
		this.syncNextPrompt();
		this.syncAutoTitle();
		this.syncJudgeAssist();
		this.syncAccountRotation();
		this.syncCreditSpend();
		void relay.request("stream_metadata.start").catch(error => {
			// An omp that ended or restarted meanwhile closed its bridge: nothing is missing.
			if (this.#bridge === relay) console.warn("[sidecar] stock stream metadata unavailable:", error);
		});
	}

	/** A frame omp wrote, or the bridge pushed, as the lane delivers it: after its hold, in order. */
	#onFrame(event: LaneEvent, bin: Uint8Array | null): void {
		if (this.#staleOmp(event.cmd) || !bin) return;
		let frame: unknown;
		try {
			frame = JSON.parse(Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength).toString("utf8"));
		} catch {
			return;
		}
		if (typeof frame !== "object" || frame === null) return;
		// Request bookkeeping no window reads leaves here, before any copy of the frame is made (frame-bookkeeping.ts).
		let obj = withoutFrameBookkeeping(frame as Frame);
		// Before anything in main reads it.
		if (obj.type === "message_update")
			[obj] = this.#rebuild.events([obj as unknown as AgentSessionEvent]) as unknown as Frame[];
		// Stock queue lanes are bare text; ids are assigned on arrival, in stream order.
		if (obj.type === "queue_update" && this.#spawnRelay) obj = projectQueueUpdate(this.#spawnRelay, obj);
		this.#dispatchFrame(obj);
	}

	#transform(frame: Frame): Frame {
		return this.#options.frameTransform?.(frame) ?? frame;
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
		const obj = this.#transform(frame);
		const type = obj.type as string;
		// A response nobody waits for (its caller timed out) is a frame, as it always was.
		if (type === "response") this.#flushBeforeResponse();
		if (AGENT_EVENT_TYPES[type] === true) {
			this.#batcher?.push(obj as AgentSessionEvent);
		} else if (type === "available_commands_update") {
			this.emit("commandsUpdate", obj.commands);
		} else if (Object.hasOwn(FRAME_EVENTS, type)) {
			if (RUN_SETTLE_FRAMES[type] === true) this.#batcher?.flushNow();
			this.emit(FRAME_EVENTS[type], obj);
		}
		this.emit("frame", obj);
	}

	// ---- What the lane asks -------------------------------------------------------------------------------------

	/**
	 * omp + env resolution takes up to a few seconds: the lane asks, main runs what a start has always resolved and
	 * keeps the results for the spawn's launch ask.
	 */
	#onResolve(ask: ResolveAsk): void {
		const { omp, proxyEnv, shellEnv } = this.#options;
		const fallback = () => ({}) as Record<string, string>;
		void Promise.all([
			omp().catch(
				(err: unknown): OmpResolution => ({ ok: false, error: err instanceof Error ? err.message : String(err) }),
			),
			proxyEnv ? proxyEnv().catch(fallback) : Promise.resolve({}),
			shellEnv ? shellEnv().catch(fallback) : Promise.resolve({}),
			this.#options.builtinMcp?.().catch(() => ({ args: [] })) ?? Promise.resolve({ args: [] }),
			ask.sessionPath && this.#options.sessionFree
				? this.#options.sessionFree(ask.sessionPath).catch(() => "free" as const)
				: ("free" as const),
			Promise.resolve(this.#options.defaultBrowser?.()).catch(() => undefined),
			this.#options.egoBrowserDir?.().catch(() => null) ?? Promise.resolve(null),
		]).then(([resolution, proxyVars, shellVars, builtinMcp, session, defaultBrowser, egoBrowserDir]) => {
			// A start that a restart or a stop superseded while this resolved must not spawn.
			if (this.#staleAsk(ask.cmd)) return;
			if (session === "owned") {
				this.#answer("sidecar.resolved", ask, {
					outcome: "owned",
					message: this.#options.sessionOwnedText?.() ?? "This session is still open in another omp process.",
				});
				return;
			}
			if (!resolution.ok) {
				// No usable omp: nothing ran, nothing failed. Machine setup installs it and main starts this tab then.
				this.#answer("sidecar.resolved", ask, { outcome: "waiting", message: resolution.error });
				return;
			}
			this.#runtime = resolution.runtime;
			this.#proxyEnvVars = proxyVars;
			this.#shellEnvVars = shellVars;
			this.#builtinMcp = builtinMcp;
			this.#defaultBrowser = defaultBrowser;
			this.#egoBrowserDir = egoBrowserDir;
			this.#answer("sidecar.resolved", ask, { outcome: "ok" });
		});
	}

	/** The OMPdesk settings this spawn starts with, each read now (the same closures the `sync*` pushes read). */
	#settings(): SessionSettings {
		const options = this.#options;
		this.#titleSuppressed = titleSuppressedByEnv({ ...process.env, ...this.#shellEnvVars });
		const autoTitle = options.autoTitle?.();
		return {
			replyLanguage: options.replyLanguage?.(),
			userProfile: options.userProfile?.(),
			nextPrompt: options.nextPrompt?.(),
			autoTitle: autoTitle ? { ...autoTitle, suppressed: this.#titleSuppressed } : undefined,
			judgeAssist: options.judgeAssist?.(),
			delegation: options.delegation?.(),
			accountRotation: options.accountRotation?.(),
			accountRotationLedger: options.accountRotationLedger,
			creditSpend: options.creditSpend?.(),
			ompdeskRolesFile: options.ompdeskRolesFile,
			browser: this.#defaultBrowser,
		};
	}

	/** How the next omp starts: what `ompArgs`/`sessionEnv` and the spawn's environment make of the settings read now. */
	#onLaunch(ask: LaunchAsk): void {
		if (this.#staleAsk(ask.cmd)) return;
		const runtime = this.#runtime;
		try {
			if (!runtime) throw new Error("omp is not resolved");
			const { bridgeDir, cwd, extraFlags } = this.#options;
			const whose = {
				cwd,
				sessionPath: this.#sessionPath ?? undefined,
				...(this.#options.promptOrigin ? { device: this.#options.promptOrigin.name } : {}),
			};
			if (this.#processes) this.#processes.update(whose);
			else this.#processes = this.#options.sessionProcesses?.open(whose) ?? null;
			const launch: OmpLaunch = {
				open: ask.open,
				...(bridgeDir && ask.bridgeAddress ? { bridge: { dir: bridgeDir, address: ask.bridgeAddress } } : {}),
				...(ask.model ? { model: ask.model } : {}),
				builtin: this.#builtinMcp,
				userFlags: [...(extraFlags ?? []), ...loadLaunchProfileFlags(this.#options.launchProfiles, cwd)],
				settings: this.#settings(),
				...(this.#options.promptOrigin ? { origin: this.#options.promptOrigin } : {}),
				...(this.#processes ? { processTag: this.#processes.tag } : {}),
				...(this.#processes?.scratch ? { scratchDir: this.#processes.scratch } : {}),
			};
			const args = ompArgs(launch);
			const bin = runtime.bin;
			console.log(`[sidecar] spawning omp ${runtime.version} (${args.length} args, cwd: ${cwd})`);
			const env = childEnv({
				// Bun's own defaults for omp first, so the user's environment still wins (`ompBunDefaults`).
				...ompBunDefaults(),
				// Login-shell env over the app's own, then the GUI proxy pref (and inherited proxy env) over
				// rc-file proxy exports. What another OMPdesk session left in either is never this tab's
				// (`SESSION_OWNED_ENV`), nor another OMPdesk's control socket (`withoutControlEnv`).
				...withoutControlEnv(withoutSessionEnv({ ...process.env, ...this.#shellEnvVars })),
				...this.#proxyEnvVars,
				PATH: ompPathEnv(
					bin,
					this.#shellEnvVars.PATH ?? process.env.PATH ?? "",
					this.#egoBrowserDir ? [this.#egoBrowserDir] : [],
				),
				...sessionEnv(launch),
				...this.#options.controlEnv?.(),
				PI_RPC_EMIT_TITLE: "1",
				PI_NO_PTY: "1",
				PI_NOTIFICATIONS: "off",
				...OMP_TELEMETRY_OFF,
			});
			this.#answer("sidecar.launched", ask, {
				start: { bin: spawnCommand(bin), args: spawnArgs(bin, args), env, cwd, shell: needsShell(bin) },
				hostTools: this.#hostTools(),
			});
		} catch (err) {
			this.#answer("sidecar.launched", ask, { error: err instanceof Error ? err.message : String(err) });
		}
	}

	/**
	 * An omp exited before `ready` for a reason that is no clean exit: a session whose saved model cannot be restored
	 * would fail identically on every retry (one respawn on `--model @default`, outside the crash budget); stock exits
	 * for lack of a usable model when none has credentials (one respawn on an explicit catalog model, so onboarding can
	 * connect a provider). Anything else is a crash.
	 */
	#onExit(ask: ExitAsk): void {
		if (this.#staleAsk(ask.cmd)) return;
		const answer = (plan: "restart" | { fallback: string } | { bootModel: string }) =>
			this.#answer("sidecar.exitPlan", ask, { plan });
		if (ask.booted) return answer("restart");
		const missing = ask.fallbackArmed ? null : parseModelRestoreFailure(ask.stderr);
		if (missing) {
			console.warn(`[sidecar] session model ${missing} unavailable at boot — resuming on the default model`);
			return answer({ fallback: missing });
		}
		const resolve = this.#options.bootModel;
		const runtime = this.#runtime;
		if (!resolve || !runtime || ask.noModelArmed || !isNoModelBootFailure(ask.stderr)) return answer("restart");
		resolve(runtime).then(
			selector => {
				console.warn(`[sidecar] omp has no usable model — booting on ${selector} so onboarding can connect one`);
				answer({ bootModel: selector });
			},
			(error: unknown) => {
				console.warn("[sidecar] no catalog model to boot on:", error);
				answer("restart");
			},
		);
	}

	/** Runs the tab's start gate between the first bridge connect and `ready` (worktree-lifecycle.ts). */
	#onGate(ask: LaneAsk): void {
		if (this.#staleAsk(ask.cmd)) return;
		const gate = this.#startGate;
		this.#startGate = null;
		const bridge = this.#bridge;
		const run = gate && bridge?.connected ? gate(bridge, this.#options.cwd).catch(() => null) : Promise.resolve(null);
		void run.then(cwd => this.#answer("sidecar.gated", ask, { cwd }));
	}

	/** The omp's own log tail, for a start that has not answered (`reportSlowStart`, the slow tab's message). */
	#onSlow(ask: SlowAsk): void {
		if (this.#staleAsk(ask.cmd)) return;
		const read = this.#options.readOmpLog ?? ompLogTail;
		void read(ask.pid, new Date(ask.spawnedAt))
			.catch(() => [] as string[])
			.then(lines => this.#answer("sidecar.slowLog", ask, { lines }));
	}

	/**
	 * A tab left `error` because another omp keeps its session starts by itself once that omp lets go (it may close
	 * minutes later: a terminal, or a last launch still finishing a long tool), so the person never has to notice and
	 * press Restart. Each round is another `sessionFree` wait.
	 */
	#onSessionWait(ask: SessionWaitAsk): void {
		if (this.#staleAsk(ask.cmd)) return;
		const sessionFree = this.#options.sessionFree;
		void (
			sessionFree ? sessionFree(ask.sessionPath).catch(() => "free" as const) : Promise.resolve("free" as const)
		).then(outcome => this.#answer("sidecar.sessionFreed", ask, { outcome }));
	}

	/** Context for one GUI-side command; learns the session identity first when a session change left it unknown. */
	async #localContext(client: RpcClient, runtime: OmpRuntime, bridge: BridgeRelay): Promise<LocalCommandContext> {
		const send = stockSender(client, LOCAL_SEND_TIMEOUT_MS);
		if (!this.#session) await client.stock({ type: "get_state" }).catch(() => undefined);
		return {
			cwd: this.#options.cwd,
			sessionFile: this.#session?.sessionFile,
			omp: runtime,
			send,
			bridge,
		};
	}

	// ---- Pushes to the live omp ---------------------------------------------------------------------------------

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
	 * protocol is negotiated (the lane sends the launch answer's set), and again here when the switch changes on a
	 * ready omp; one that is not ready yet gets the current set from its own spawn.
	 */
	syncHostTools(): void {
		if (!this.#rpcClient || this.#status !== "ready") return;
		void this.#rpcClient.command({ type: "set_host_tools", tools: this.#hostTools() }).catch(() => {});
	}

	/** The GUI-executed tools: the lane registers them with the omp's protocol negotiation (the launch answer), before its first `get_state`. */
	#hostTools() {
		return [
			TERMINAL_READ_DEFINITION,
			VISUALIZE_DEFINITION,
			...(this.#options.hostTools?.() ? AGENT_CONTROL_DEFINITIONS : []),
		];
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
	 * Push the resolved default browser to this omp (gui-bridge `default_browser_set`); its next turn's system
	 * prompt follows. Fire-and-forget like syncReplyLanguage: an unconnected bridge syncs on connect.
	 */
	syncDefaultBrowser(): void {
		const bridge = this.#bridge;
		const resolve = this.#options.defaultBrowser;
		if (!bridge || !resolve) return;
		void Promise.resolve(resolve())
			.then(browser => bridge.request("default_browser_set", { browser }))
			.catch(() => {});
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
	bridgeRequest(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
		return this.#bridge
			? this.#bridge.request(method, params, timeoutMs === undefined ? undefined : { timeoutMs })
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

	/** Push the credit-use switch to this omp (gui-bridge `credit_spend_set`); its next request follows. */
	syncCreditSpend(): void {
		const enabled = this.#options.creditSpend?.();
		if (enabled !== undefined) void this.#bridge?.request("credit_spend_set", { enabled }).catch(() => {});
	}

	/** Send a side-channel frame (bypasses command queue). */
	sendSideChannel(frame: object): void {
		if (this.#alive) this.#tell("sidecar.send", { frame });
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
		if (this.#opened) this.#tell("sidecar.cwd", { cwd }, { cwd: true });
		return true;
	}

	/** Hold the first spawn at `starting` until `gate` settles (set before that spawn's `ready`). */
	setStartGate(gate: SidecarStartGate): void {
		this.#startGate = gate;
		this.#ensureOpen();
		this.#tell("sidecar.gate");
	}

	/** Resolves once the current omp and every one this tab stopped before it have exited (at once when none runs). */
	whenExited(): Promise<void> {
		if (!this.#opened) return Promise.resolve();
		return this.#send("sidecar.whenExited", {}, {}, NO_DEADLINE_MS).then(
			() => undefined,
			() => undefined,
		);
	}

	/**
	 * Stop the tab's omp and start it again: in `cwd` when given (a session there, `resumeSessionPath` or a new one),
	 * else on `resumeSessionPath` or the session the tab is on.
	 */
	restart(cwd?: string, resumeSessionPath?: string): void {
		if (cwd) this.#options = { ...this.#options, cwd };
		if (this.#disposed) return;
		this.#ensureOpen();
		this.#tell(
			"sidecar.restart",
			{ ...(cwd ? { cwd } : {}), ...(resumeSessionPath ? { resumeSessionPath } : {}) },
			{ life: true, status: true, cwd: cwd !== undefined },
		);
		this.#markGone();
		this.#predict("starting");
	}

	kill(): void {
		if (!this.#opened || this.#disposed) return;
		this.#tell("sidecar.kill", {}, { life: true });
		this.#markGone();
	}

	/**
	 * Stop the omp of an idle tab and read `asleep`, as a restored tab reads before its first start: the pool restarts it
	 * on its session file when it is shown or messaged (`idle-release.ts`). The omp stops as a restart stops it.
	 */
	sleep(): void {
		if (this.#disposed || !this.#alive) return;
		this.#tell("sidecar.sleep", {}, { life: true, status: true });
		this.#markGone();
		this.#predict("asleep");
	}

	dispose(): void {
		if (!this.#disposed) {
			this.#disposed = true;
			if (this.#opened) {
				// Stock omp emits `session_shutdown` (ai-memory's `session-end` hook, which makes the handoff) only when its
				// stdin ends; SIGTERM kills it before. With a grace period its stdin closes first.
				this.#tell("sidecar.dispose", { stdinGraceMs: this.#options.gracefulStopMs?.() ?? 0 }, { life: true });
			} else {
				lanes.delete(this.#tab);
			}
			this.#markGone();
			this.#batcher?.dispose();
			this.#batcher = null;
		}
		this.removeAllListeners();
	}
}
