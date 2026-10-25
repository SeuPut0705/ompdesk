/**
 * The host role's application services (B side): what a paired device may do
 * on this computer once its connection is authenticated.
 *
 * Tabs: each `(peer.deviceId, rtab)` gets a real SidecarManager from the same
 * factory local tabs use, so the session runs with this machine's omp, files,
 * git and credentials. Every lookup is scoped by the CALLING peer, so one
 * device can never address another device's tabs. The allowlisted sidecar
 * events go back as `tab.event`; host tool calls (gui_open_url, notify,
 * clipboard) are among them and are answered by the client device — nothing
 * here executes them. When a connection drops, its tabs keep running for a
 * grace period; a reconnect re-attaches by rtab and gets the status again.
 * Whether each tab is running a turn is tracked here too (the same rules as
 * the local pool's "running"), so the host can keep this computer awake, and
 * the tabs are this computer's resume coordinator's (turn-resume.ts): their
 * markers, the continuation after a crash or quit, and the wait for this
 * computer's connection are the host's; the device only shows that wait.
 * A relaunched device reopens its tabs under new rtabs: the open takes over
 * the tab its previous connection left on that session instead of a second omp.
 *
 * This computer's own windows see those tabs too: `hostedSessions` lists each
 * session a tab runs with its live state (their sidebar rows), and
 * `viewSession` hands a window a HostedTabView of the tab (hosted-view.ts), so
 * opening the session there views the device's omp instead of starting a
 * second one. The first answer to an ask, from the device or such a window,
 * wins; the device's close, delete or revoke ends the views first, and a tab a
 * window shows outlives the device's grace period.
 *
 * Host-level calls: session listing/search/kind/delete/rename against this
 * machine's session index, the workspace fs reads (same confinement and caps
 * as the local handlers; the file viewer's `host.fs.readBinary` is capped to
 * fit one link frame), the folder picker listing, the default workspace and
 * launch profiles. Session index changes are pushed as `sessions.changed`.
 * The other `host.*` calls are what a device's Settings, Usage and Stats show for a
 * tab here: this machine's models.yml providers, stats server, `omp bench`, model
 * setup research and account-rotation pref (machine-services.ts), one benchmark and
 * one research run per device, aborted when it drops.
 */
import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { PROMPT_ORIGIN_HOST_ID, type PromptOriginEnv } from "../../../resources/gui-bridge/prompt-origin-contracts";
import { ACCOUNT_ROTATION_MODES } from "../../shared/account-rotation";
import { codedError } from "../../shared/ipc-error-codes";
import { HOST_UPLOAD_MAX_BYTES, type HostLiveSession, type IpcHostedSession } from "../../shared/ipc-types";
import { ModelSetupRequestSchema } from "../../shared/model-setup";
import type { OmpUpdateState } from "../../shared/omp-update";
import { MAX_RPC_COMMAND_TIMEOUT_MS } from "../../shared/rpc-client";
import {
	type AgentSessionEvent,
	BLOCKING_UI_METHODS,
	type ExtensionUIRequest,
	type PromptResultFrame,
	type RpcCommand,
	type RpcResponse,
	type SessionInfoUpdateFrame,
	type SidecarStatusPayload,
	type SubagentFrame,
} from "../../shared/rpc-types";
import type { SchedulesState } from "../../shared/schedules";
import type { SidebarProjectsState } from "../../shared/sidebar-projects";
import type { TerminalOperation } from "../../shared/terminal-types";
import { branchEvidence, branchFacts, landingFacts, mergeBranch, removeSafeWorktree } from "../agent-control/branches";
import type { BridgeConnectResult } from "../bridge-health";
import { canonicalCwd } from "../canonical-cwd";
import type { CheckoutMember } from "../checkout-peers";
import { deletedSessions } from "../deleted-sessions";
import { discardOpenedWorktree, savedWorktreesForSpawn } from "../disk/saved-worktrees";
import { type ExtensionApplyPlan, extensionApplyDecision, mergeApplyPlans } from "../extension-reload";
import { type LaunchProfilePrefs, readLaunchProfile, updateLaunchProfile } from "../launch-profile-store";
import { createWorktree, tablessWorktreeBridge } from "../local/git/worktree";
import { noteTypedPrompt } from "../local/prompt-origin";
import type { BridgeClient } from "../local/types";
import type { MachineServices } from "../machine-services";
import { noteOmpExit } from "../omp-exits";
import { ompRestartDecision } from "../omp-restart";
import type { SessionIndex } from "../session-index";
import { deleteSession, moveSession, recordSessionDelete, renameSession } from "../session-mutations";
import type { SidecarSessionIdentity } from "../sidecar";
import { type SidecarPool, STOP_SESSION_WAIT_MS } from "../sidecar-pool";
import {
	idleRun,
	type RunState,
	type RunTracking,
	runBusy,
	runFromReading,
	runReading,
	runSettling,
	settleRun,
	trackRunEvent,
} from "../sidecar-run-state";
import { type SidecarLike, VIEW_ENDED_EVENT } from "../sidecar-types";
import { stockHelperRequest } from "../stock-helper";
import { MAX_FORMER_TAB_IDS } from "../tab-layout";
import { sessionFolderState } from "../tab-spawn";
import { disposeTerminals, terminalRequest } from "../terminal/requests";
import { detectShells } from "../terminal/shells";
import type { ResumeFact, ResumeMarker, TurnResume } from "../turn-resume";
import { dispatchedCommand, recordTurnStop, STOP_COMMANDS } from "../turn-stop-log";
import { UploadError, type UploadStore } from "../web/uploads";
import {
	FS_BINARY_REMOTE_MAX_BYTES,
	listDirectories,
	listWorkspace,
	mutateWorkspace,
	readPlanFile,
	readWorkspaceBinary,
	readWorkspaceFile,
	readWorkspaceImage,
	readWorkspaceRange,
	statWorkspacePath,
} from "../workspace-fs";
import { searchWorkspace } from "../workspace-search";
import { sessionOpenFolders } from "../worktree-orphans";
import { removalHolds } from "../worktree-removals";
import {
	AGENT_REVIEW_EVENT,
	AUTOPILOT_NOTICE_EVENT,
	type AutopilotNoticeEvent,
	BenchmarkOptionsSchema,
	CustomProviderInputSchema,
	encodeBinaryRead,
	GIT_METHODS,
	HostFsReadRangeParams,
	HostUploadParams,
	HostUploadPartParams,
	KEPT_TABS_METHOD,
	type KeptTab,
	LIVE_SESSIONS_EVENT,
	LIVE_SESSIONS_METHOD,
	MEMORY_METHODS,
	MemoryConclusionPullParams,
	type MemoryConclusionPullReply,
	MemoryConclusionPushParams,
	type MemoryConclusionPushReply,
	MemoryPullParams,
	type MemoryPullReply,
	MemoryPushParams,
	type MemoryPushReply,
	MOBILE_WEB_LINK_EVENT,
	MOBILE_WEB_LINK_METHOD,
	ModelOverrideInputSchema,
	OMP_UPDATE_EVENT,
	PROJECTS_EVENT,
	ProjectsCommandParams,
	SCHEDULES_EVENT,
	SchedulesCommandParams,
	SchedulesCreateParams,
	SchedulesLogParams,
	SESSIONS_CHANGED_EVENT,
	TAB_EVENT,
	TAB_EVENT_NAMES,
	type TabBridgeArg,
	type TabEventMessage,
	type TabEventName,
	type TabOpenResult,
	type TabSignInArg,
	type TabStatusArg,
} from "./app-protocol";
import type { HostConnection, HostServices } from "./host-server";
import { HostedTabView, labelForHost } from "./hosted-view";
import { createLinkEventSender, createReadEncoder, encodedReadKey, type LinkEventSender } from "./link-events";
import type { PeerQuota } from "./peer-quota";
import type { PeerInfo } from "./peers-store";
import { commandUsesModel } from "./quota-commands";
import { readJson, writeSecureJson } from "./secure-file";
import { FrameTooLargeError } from "./wire";

/** How long a disconnected device's tabs keep running, waiting for it to come back. */
export const HOST_TAB_GRACE_MS = 10 * 60_000;
/** Session-index changes come in bursts while an agent writes; one push per burst. */
const SESSIONS_CHANGED_DEBOUNCE_MS = 300;
/** Parts of a file that wait this long for the next one are dropped (the sender gave up or went away). */
export const UPLOAD_PART_IDLE_MS = 2 * 60_000;
/** Files one device may be sending in parts at once (each up to HOST_UPLOAD_MAX_BYTES held until its last part). */
export const UPLOAD_PARTS_PER_DEVICE = 2;
/** A turn's start, its tool calls' asks and its end come in bursts: one push of the live sessions per burst. */
export const LIVE_SESSIONS_DEBOUNCE_MS = 250;
/** Answers kept per tab to refuse the other side's late one (`already_answered`); the oldest go first. */
const ANSWERED_KEPT = 256;

/**
 * The memory pages and session conclusions this computer shares with the devices that use it (ai-memory/sync.ts
 * `servePull`/`servePush`, `serveConclusionPull`/`serveConclusionPush`).
 */
export interface HostMemory {
	pull(peerId: string, params: MemoryPullParams): Promise<MemoryPullReply>;
	push(peerId: string, params: MemoryPushParams): Promise<MemoryPushReply>;
	conclusionsPull(peerId: string, params: MemoryConclusionPullParams): Promise<MemoryConclusionPullReply>;
	conclusionsPush(peerId: string, params: MemoryConclusionPushParams): Promise<MemoryConclusionPushReply>;
	/** The device may still use this computer: paired, its node not blocked. */
	allows(peerId: string): boolean;
}

export interface HostServicesDeps {
	/**
	 * This machine's sidecar factory — the one the local pool uses. `origin`
	 * names the device the tab runs for, so its prompts are journalled as that
	 * device's (A85, resources/gui-bridge/prompt-origin.ts).
	 */
	createSidecar: (cwd: string, kind: "agent" | "chat", fresh: boolean, origin: PromptOriginEnv) => SidecarLike;
	/** This computer's device name (Settings › Devices), for prompts typed on it. */
	hostName: () => string;
	sessionIndex: Pick<
		SessionIndex,
		| "list"
		| "searchContent"
		| "kindFor"
		| "recordedCwd"
		| "deleteSession"
		| "moveSession"
		| "sessionsDir"
		| "readMessages"
	>;
	/** Session files this computer's user hid from agents (Sidebar › Hide from other agents); a device's agent never reads them. */
	agentHidden?: () => ReadonlySet<string>;
	/** Stored-file rename for a session no live tab holds (`omp` on this machine). */
	renameStoredSession: (sessionPath: string, name: string) => Promise<void>;
	/** The GUI-owned Work workspace, created on demand. */
	defaultWorkspace: () => string;
	launchProfiles: LaunchProfilePrefs;
	/** This machine's models.yml, stats server and `omp bench`. */
	machine: MachineServices;
	/**
	 * This machine's own tabs (the local pool): a session file one of them
	 * holds is changed through that tab (a delete closes it), and a credential
	 * change reaches them.
	 */
	localTabs: Pick<
		SidecarPool,
		| "sessionOwner"
		| "sessionOwnerIsLive"
		| "sessionRunning"
		| "commandForSession"
		| "closeSessionTab"
		| "allSidecars"
		| "viewForDevice"
		| "stopSession"
	>;
	/** Moves a path to this machine's trash (Electron `shell.trashItem`). */
	trashItem: (abs: string) => Promise<void>;
	graceMs?: number;
	/** Names a worktree a device's agent makes here (`host.git.worktreeCreate`); default the stock helper's. */
	worktreeLocation?: Pick<BridgeClient, "request">;
	/**
	 * Where the Autopilot runs devices started here are kept (run worktree root → deviceId), so a run that resumes
	 * after this computer restarts still spends its device's quota. Absent: kept in memory only.
	 */
	runChargesFile?: string;
	/** The sessions this computer's own windows work on now (`SidecarPool.liveSessions`), for `liveSessions`. */
	windowLiveSessions?: () => HostLiveSession[];
	/**
	 * Who opened each of this computer's sessions, as far as it knows (child file → opener's file: its windows' tabs,
	 * its records of children it closed), so a device's list nests them as this computer's own sidebar does.
	 */
	sessionOpeners?: () => ReadonlyMap<string, string>;
	/** This computer's Mobile web address while it serves phones (`MobileWebState.url`), else null. */
	mobileWebUrl?: () => string | null;
	/** Where a device's attached files land (`host.files.upload`): the phones' upload folder, same limits and lifetime. */
	uploads?: Pick<UploadStore, "store">;
}

/** A call of the omp's that a device answers; `delivered` once a connection was handed it. */
interface PendingHostCall {
	name: "hostToolCall" | "hostUriRequest";
	request: { id: string };
	delivered: boolean;
}

/** `run`, `lastRun`, `stopped` and `retry` follow the sidecar's events (`trackRunEvent`), like a local tab's. */
interface HostTab extends RunTracking {
	peerId: string;
	rtab: string;
	/** The tab's id for this computer's resume coordinator; kept when a relaunched device re-keys the tab. */
	resumeId: string;
	sidecar: SidecarLike;
	/**
	 * Names the omp process the tab's statuses come from, new with each one the sidecar starts: a device that
	 * re-attaches after a lost link compares it with the last it saw to tell the same omp from a new one.
	 */
	omp: string;
	/** The connection events go to; null while the device is away (grace period). */
	conn: HostConnection | null;
	/** Resumed by the first `tab.start`. */
	resumeSessionPath: string | undefined;
	/** Session file the sidecar last reported (live-owner checks for delete/rename). */
	sessionFile: string | undefined;
	graceTimer: NodeJS.Timeout | undefined;
	/** The rtabs this tab had before a relaunched device adopted it under a new one, newest first (`tabs.kept`). */
	formerRtabs: string[];
	run: RunState;
	/**
	 * Open asks and approvals the device has not answered, by request id, as the omp raised them:
	 * every `tab.open` re-sends them (`openAsks`), since the device missed whatever changed while away.
	 */
	asks: Map<string, ExtensionUIRequest>;
	/**
	 * Host tool calls and URI reads the omp waits on, by request id: stock never times one out, so a call that reached
	 * no device (made while it was away, or held by a device process that quit) would hold the turn for good. `tab.open`
	 * re-sends the ones this connection never had, and every one to a relaunched device that adopts the tab.
	 */
	hostCalls: Map<string, PendingHostCall>;
	/** The turn waits for this computer's internet connection (turn-resume.ts). */
	awaitingConnection?: boolean;
	/** Provider ids of the `login` commands running on this tab (a device's sign-in, even if its link dropped). */
	signIns?: string[];
	/** `omp update` landed during a turn: the tab restarts on the new omp when it ends. */
	ompRestartPending?: boolean;
	/** An extension update landed during a turn: applied one tick after it ends. */
	extensionPending?: ExtensionApplyPlan;
	/** The prompt origin its omp was spawned with: the device it serves and this computer's name. */
	origin: PromptOriginEnv;
	/** Windows of this computer that show the tab (`viewSession`). */
	views: Set<HostedTabView>;
	/**
	 * The tab shows a window of this computer's own tab (`localTabs.viewForDevice`): its sidecar is that omp's view,
	 * so its resume, updates and sidebar row are the window's, and its close only leaves.
	 */
	viewsWindow?: true;
	/** Asks answered, by request id → who answered first; the other side's late answer is refused. */
	answered: Map<string, "device" | "host">;
	/** What the connection last got of `events`/`subagentFrame`, when its device asked for slim ones. */
	linkEvents?: { conn: HostConnection; sender: LinkEventSender };
	/**
	 * Answers to a device that reads them as deltas (`encodedReadKey`): one encoder per read, kept across the device's
	 * reconnects while it reads the same way (`slim`, as JSON). Its first read after a drop is then a delta of the copy
	 * it kept, not the whole status again (about 1 MB of settings, Autopilot and transcript reads a reconnect, 25 a day
	 * on a link on 22 Oct 2026); a device that lost the copy asks `fresh`.
	 */
	reads?: { slim: string; encoders: Map<string, (status: unknown, fresh: boolean) => unknown> };
	/** The last `commandsUpdate` list a connection got (JSON): stock repeats an unchanged list, which goes no further. */
	sentCommands?: { conn: HostConnection; json: string };
	/** The session's id and name as its omp last reported them (this computer's sidebar row). */
	sessionId?: string;
	title?: string;
}

/** A device's tab here as this computer's Autopilot coordinator sees it (`attachAutopilot`). */
export interface HostedAutopilotTarget {
	/** The tab's resume id: the coordinator's tab id for a run started from it. */
	tabId: string;
	/** The device the tab runs for: a run started from it is charged to it. */
	peer: string;
	sidecar: SidecarLike;
	/** The session file the tab is on, if any. */
	sessionPath?: string;
	/** The tab views a window's tab of this computer (`viewForDevice`): that tab is the coordinator's. */
	viewsWindow: boolean;
}

/** This computer's Autopilot coordinator answering `get_autopilot` / `set_autopilot` for a device's tab. */
export type HostedAutopilot = (
	target: HostedAutopilotTarget,
	command: { type: "get_autopilot" | "set_autopilot" } & Record<string, unknown>,
) => Promise<RpcResponse>;

/**
 * This computer's OMPdesk control tools answering a device's `agent_control_review` / `agent_control_family_edits` for
 * a tab that views a window's session here (`viewForDevice`): the sessions that session's agent opened are this
 * computer's tabs, which only its own control tools know (`attachAgentReview`).
 */
export type HostedAgentReview = (
	target: HostedAutopilotTarget,
	command: { type: "agent_control_review" | "agent_control_family_edits" } & Record<string, unknown>,
) => Promise<RpcResponse>;

const Rtab = z.string().min(1).max(128);
const AbsolutePath = z.string().min(1).refine(isAbsolute, "absolute path required");
const SessionPath = z.string().endsWith(".jsonl");
const Scope = z.enum(["local", "global"]);

const RtabParams = z.object({ rtab: Rtab });
const OpenParams = z.object({
	rtab: Rtab,
	cwd: AbsolutePath.optional(),
	kind: z.enum(["agent", "chat"]).optional(),
	fresh: z.boolean().optional(),
	sessionPath: SessionPath.optional(),
});
const RestartParams = z.object({ rtab: Rtab, cwd: AbsolutePath.optional(), sessionPath: SessionPath.optional() });
const AdoptCwdParams = z.object({ rtab: Rtab, cwd: AbsolutePath });
const CommandParams = z.object({
	rtab: Rtab,
	command: z.object({ type: z.string().min(1) }).passthrough(),
	// Up to the longest window the GUI itself gives a command (a login waits on
	// the browser, a bash or a PR checkout runs long): every command a device sends fits.
	timeoutMs: z.number().int().positive().max(MAX_RPC_COMMAND_TIMEOUT_MS).optional(),
	/** A read the device asks again: its answer goes whole (`encodedReadKey`). */
	fresh: z.boolean().optional(),
});
const SideChannelParams = z.object({ rtab: Rtab, frame: z.object({}).passthrough() });
const SessionsListParams = z.object({ scope: Scope, cwd: AbsolutePath.optional() });
const SessionsSearchParams = z.object({ query: z.string(), scope: Scope, cwd: AbsolutePath.optional() });
const SessionPathParams = z.object({ sessionPath: SessionPath });
const SessionFolderParams = z.object({ sessionPath: SessionPath, restore: z.boolean().optional() });
const RenameParams = z.object({ sessionPath: SessionPath, name: z.string() });
const MoveParams = z.object({ sessionPath: SessionPath, cwd: AbsolutePath });
/** fs reads root at the tab's cwd; `cwd` covers a tab the host has not opened yet. */
const FsRoot = { rtab: Rtab.optional(), cwd: AbsolutePath.optional() };
const FsListParams = z.object({
	...FsRoot,
	path: z.string().optional(),
	maxDepth: z.number().optional(),
	maxEntries: z.number().optional(),
});
const FsReadParams = z.object({ ...FsRoot, path: z.string(), maxBytes: z.number().optional() });
const FsReadRangeParams = HostFsReadRangeParams.extend(FsRoot);
const FsReadImageParams = z.object({ ...FsRoot, path: z.string() });
const FsMutateParams = z.object({ ...FsRoot, mutation: z.unknown() });
const FsSearchParams = z.object({ ...FsRoot, request: z.unknown() });
const FsReadPlanParams = z.object({ ...FsRoot, fsPath: z.string(), localRoot: z.string().nullable() });
const ListDirsParams = z.object({ path: z.string().optional(), query: z.string().max(255).optional() });
const LaunchProfileGetParams = z.object({ cwd: AbsolutePath });
const LaunchProfileUpdateParams = z.object({ cwd: AbsolutePath, patch: z.record(z.unknown()) });
const ModelsUpsertParams = z.object({ input: CustomProviderInputSchema });
const ModelsDeleteParams = z.object({ id: z.string().min(1) });
const ModelsOverrideParams = z.object({
	provider: z.string().min(1).max(200),
	modelId: z.string().min(1).max(400),
	override: ModelOverrideInputSchema.nullable(),
});
const StatsFetchParams = z.object({ path: z.string().min(1).max(512), params: z.record(z.string()).optional() });
const BenchRunParams = z.object({ ...FsRoot, options: BenchmarkOptionsSchema });
const ModelSetupRunParams = z.object({ request: ModelSetupRequestSchema });
const AccountRotationSetParams = z.object({ mode: z.enum(ACCOUNT_ROTATION_MODES) });
const BuiltinReaSetParams = z.object({ enabled: z.boolean() });
const TerminalParams = z.object({ rtab: Rtab, operation: z.object({ action: z.string() }).passthrough() });
const DesktopUpdateParams = z.object({ action: z.enum(["check", "download", "install"]) });
/** A session's worktree binding (`IpcTabWorktree`), as the device's agent names it for `host.git.*`. */
const GitWorktree = z.object({
	path: AbsolutePath,
	branch: z.string().min(1).max(255),
	baseCwd: AbsolutePath,
});
const GitWorktreeParams = z.object({ worktree: GitWorktree });
/** `diffChars` mirrors what `ompdesk_compare` may ask for; a bigger number would only ship more diff than it reads. */
const GitEvidenceParams = z.object({ worktree: GitWorktree, diffChars: z.number().int().min(0).max(200_000) });
const GitMergeParams = z.object({ worktree: GitWorktree, label: z.string().max(500) });
const GitWorktreeCreateParams = z.object({
	baseCwd: AbsolutePath,
	// createWorktree checks the name's and the prefix's own shape and says why it refuses one.
	name: z.string().min(1).max(64),
	branchPrefix: z.string().max(200).optional(),
	baseRef: z.enum(["HEAD", "default"]),
});
/** `runChargesFile`: Autopilot runs devices started here, by worktree root (the run's session, when known). */
const RunChargesSchema = z.record(z.object({ device: z.string().min(1), session: z.string().optional() }).strict());
type RunCharge = z.infer<typeof RunChargesSchema>[string];

function parse<T extends z.ZodTypeAny>(schema: T, method: string, params: unknown): z.infer<T> {
	const parsed = schema.safeParse(params ?? {});
	if (!parsed.success) throw new Error(`Invalid ${method} parameters: ${parsed.error.issues[0]?.message ?? ""}`);
	return parsed.data;
}

async function directory(cwd: string): Promise<string> {
	try {
		if ((await fsp.stat(cwd)).isDirectory()) return canonicalCwd(cwd);
	} catch {
		throw codedError("file_not_found", `Directory not found: ${cwd}`);
	}
	throw codedError("not_a_directory", `Not a directory: ${cwd}`);
}

/** Tokens one assistant reply used (its `message_end` usage), for the device's daily count. */
function assistantTokens(event: AgentSessionEvent): number {
	if (event.type !== "message_end") return 0;
	const { message } = event;
	if (message.role !== "assistant" || !("usage" in message)) return 0;
	const usage: unknown = message.usage;
	if (typeof usage !== "object" || usage === null || !("totalTokens" in usage)) return 0;
	const total = usage.totalTokens;
	return typeof total === "number" && Number.isFinite(total) && total > 0 ? total : 0;
}

export class LocalHostServices implements HostServices {
	readonly #deps: HostServicesDeps;
	readonly #graceMs: number;
	readonly #tabs = new Map<string, HostTab>();
	/** Files a device sends in parts (`host.files.uploadPart`), by device and upload id, until the last part lands. */
	readonly #parts = new Map<string, { chunks: Buffer[]; bytes: number; next: number; timer?: NodeJS.Timeout }>();
	/** Live connections that have talked to us; `sessions.changed` goes to each. */
	readonly #conns = new Set<HostConnection>();
	/** Each connected device's latest connection, for events meant for one device. */
	readonly #connOf = new Map<string, HostConnection>();
	#sessionsTimer: NodeJS.Timeout | undefined;
	/**
	 * Session file → the exit of the omp a device tab closed here ran it in: the device closes its tab
	 * before it deletes the session, and the delete waits for that omp to let go of the file.
	 */
	readonly #exiting = new Map<string, Promise<void>>();
	/**
	 * Tabs whose `tab.open` is still awaiting (folder, session kind), and those of them the device closed meanwhile:
	 * that close found no tab, so the open must not make one, or it would hold its session with nobody to close it.
	 */
	readonly #opening = new Map<string, number>();
	readonly #closedWhileOpening = new Set<string>();
	readonly #runningListeners = new Set<() => void>();
	readonly #hostedListeners = new Set<() => void>();
	/** `hostedSessions` as last announced: a listener hears only a real change. */
	#hostedSnapshot = "[]";
	/** `liveSessions` as last sent to the devices, and the timer that batches a burst of changes into one push. */
	#liveSnapshot = "[]";
	#liveTimer: NodeJS.Timeout | undefined;
	#quota: PeerQuota | null = null;
	#memory: HostMemory | null = null;
	#resume: Pick<TurnResume, "sync" | "cancelWait"> | null = null;
	#autopilot: HostedAutopilot | null = null;
	#agentReview: HostedAgentReview | null = null;
	/** Autopilot runs a device started here (worktree root → deviceId), read once from `runChargesFile`. */
	#runCharges: Map<string, RunCharge> | null = null;
	/** The run (worktree root) a window tab holding a session belongs to: the run itself or one of its children. */
	#runRootOfSession: ((sessionPath: string) => string | undefined) | null = null;

	constructor(deps: HostServicesDeps) {
		this.#deps = deps;
		this.#graceMs = deps.graceMs ?? HOST_TAB_GRACE_MS;
	}

	/** Paired devices with a host tab running a turn here (connected or in their grace period). */
	runningPeers(): string[] {
		const peers = new Set<string>();
		for (const tab of this.#tabs.values()) if (runBusy(tab.run)) peers.add(tab.peerId);
		return [...peers];
	}

	/** Called whenever a host tab starts or stops running a turn; returns the unsubscribe. */
	onRunningChange(listener: () => void): () => void {
		this.#runningListeners.add(listener);
		return () => {
			this.#runningListeners.delete(listener);
		};
	}

	/** Per-device daily model limits (RemoteDevices owns the peer store they live in). */
	attachQuota(quota: PeerQuota): void {
		this.#quota = quota;
	}

	/** Memory shared with the devices that use this computer (set in index.ts once memory exists). */
	attachMemory(memory: HostMemory): void {
		this.#memory = memory;
	}

	/**
	 * This computer's resume coordinator (turn-resume.ts), which takes the tabs here as its own:
	 * it keeps their markers, continues them after a crash or quit, and holds a network failure
	 * until this computer's connection is back. Its hosted-tab ids are {@link resumeId}s.
	 */
	attachResume(resume: Pick<TurnResume, "sync" | "cancelWait">): void {
		this.#resume = resume;
	}

	/**
	 * This computer's Autopilot coordinator (built after this service, with the IPC handlers): a device's
	 * `get_autopilot` / `set_autopilot` are its, never the omp's, so a run of a folder here is this computer's run
	 * (worktree, guard, shipping, restart) whichever device asked; a start counts as one of the device's requests.
	 */
	attachAutopilot(autopilot: HostedAutopilot): void {
		this.#autopilot = autopilot;
	}

	/** This computer's control tools for a device viewing a window's session (see {@link HostedAgentReview}). */
	attachAgentReview(review: HostedAgentReview): void {
		this.#agentReview = review;
	}

	/**
	 * The review list of the session `sessionPath` changed on this computer: every device tab viewing it hears it (a
	 * device's own tab is its own opener, so its list is the device's).
	 */
	agentReviewChanged(sessionPath: string, review: unknown): void {
		for (const tab of this.#tabs.values())
			if (tab.viewsWindow && tab.sessionFile === sessionPath) this.#emit(tab, AGENT_REVIEW_EVENT, review);
	}

	/** A device tab's sidecar by its resume id (the coordinator reads a start's source tab through it). */
	sidecarOf(id: string): SidecarLike | null {
		return this.#byResumeId(id)?.sidecar ?? null;
	}

	#charges(): Map<string, RunCharge> {
		if (this.#runCharges) return this.#runCharges;
		const file = this.#deps.runChargesFile;
		const stored = RunChargesSchema.safeParse(file ? readJson(file) : undefined);
		this.#runCharges = new Map(stored.success ? Object.entries(stored.data) : []);
		return this.#runCharges;
	}

	#saveCharges(): void {
		const file = this.#deps.runChargesFile;
		if (file) writeSecureJson(file, Object.fromEntries(this.#charges()));
	}

	/**
	 * A device started an Autopilot run here (hosted-autopilot.ts). The run is a tab of this computer's window, not
	 * the device's tab, so its turns would spend this computer's models outside the device's quota: until it ends,
	 * every reply of the run and its children counts against the device (`runEvents`), whether or not the device
	 * still shows it. A device tab viewing the run's session (`session`) counts nothing of it, so no reply counts twice.
	 */
	chargeRun(root: string, deviceId: string, session?: string): void {
		this.#charges().set(root, { device: deviceId, ...(session ? { session } : {}) });
		this.#saveCharges();
	}

	/** Events of a tab of the Autopilot run at `root` (the run or one of its children): its replies' tokens. */
	runEvents(root: string, events: readonly AgentSessionEvent[]): void {
		const charge = this.#charges().get(root);
		if (!charge) return;
		let tokens = 0;
		for (const event of events) tokens += assistantTokens(event);
		if (tokens > 0) this.#quota?.record(charge.device, { tokens });
	}

	/**
	 * An Autopilot notice of a run here (a stop, its end, a release): the device that started it (its charge, whether
	 * or not it still shows the run) and every device with a tab on the run's session hear it once each.
	 */
	autopilotNotice(
		run: { root?: string; sessionPath?: string },
		notice: Omit<AutopilotNoticeEvent, "sessionPath">,
	): void {
		const charge = run.root ? this.#charges().get(run.root) : undefined;
		const sessionPath = run.sessionPath ?? charge?.session;
		const devices = new Set<string>(charge ? [charge.device] : []);
		if (sessionPath)
			for (const tab of this.#tabs.values())
				if ((tab.sessionFile ?? tab.resumeSessionPath) === sessionPath) devices.add(tab.peerId);
		const event: AutopilotNoticeEvent = { ...notice, ...(sessionPath ? { sessionPath } : {}) };
		for (const deviceId of devices) {
			const conn = this.#connOf.get(deviceId);
			if (conn) emitSafely(conn, AUTOPILOT_NOTICE_EVENT, event);
		}
	}

	/** The run at `root` ended: nothing of it counts any more. */
	endRun(root: string): void {
		if (this.#charges().delete(root)) this.#saveCharges();
	}

	/**
	 * Which run a window tab holding a session belongs to (the coordinator's `runRootOf` for that session's owner, set
	 * with the IPC handlers like `attachAutopilot`): a device viewing a charged run's child is deduped too.
	 */
	attachRunLookup(lookup: (sessionPath: string) => string | undefined): void {
		this.#runRootOfSession = lookup;
	}

	/** A session of a charged run (the run or a child): its replies count through `runEvents`, never through a view. */
	#chargedSession(sessionPath: string | undefined): boolean {
		if (!sessionPath) return false;
		const charges = this.#charges();
		const root = this.#runRootOfSession?.(sessionPath);
		if (root !== undefined && charges.has(root)) return true;
		for (const charge of charges.values()) if (charge.session === sessionPath) return true;
		return false;
	}

	/** A tab this computer runs for a paired device compacts its context: an automatic update restart waits for it. */
	compacting(): boolean {
		return [...this.#tabs.values()].some(tab => !tab.viewsWindow && tab.run.compacting === true);
	}

	/** The resume rules' inputs for the tabs this computer runs for paired devices. */
	resumeFacts(): ResumeFact[] {
		return [...this.#tabs.values()].flatMap(tab => {
			if (tab.viewsWindow) return [];
			const fact: ResumeFact = {
				tabId: tab.resumeId,
				winId: 0,
				peer: tab.peerId,
				cwd: tab.sidecar.cwd,
				kind: tab.sidecar.kind,
				running: tab.run.running,
				stopped: tab.stopped === true,
				awaitingUi: tab.asks.size > 0,
				awaitingConnection: tab.awaitingConnection === true,
			};
			if (tab.sessionFile) fact.sessionFile = tab.sessionFile;
			if (tab.lastRun) fact.lastRun = tab.lastRun;
			if (tab.retry) fact.retry = tab.retry;
			return [fact];
		});
	}

	/** Hold or release the tab's turn for this computer's connection; the device shows the wait. */
	setAwaitingConnection(id: string, awaiting: boolean): void {
		const tab = this.#byResumeId(id);
		if (!tab || (tab.awaitingConnection === true) === awaiting) return;
		tab.awaitingConnection = awaiting;
		this.#emit(tab, "awaitingConnection", awaiting);
		for (const view of tab.views) view.emit("awaitingConnection", awaiting);
	}

	/** Spawn a hosted tab's omp if it has not run yet (a revived tab); its sidecar, or null when it is gone. */
	startTab(id: string): SidecarLike | null {
		const tab = this.#byResumeId(id);
		if (!tab) return null;
		this.#start(tab);
		return tab.sidecar;
	}

	noteStopped(id: string): void {
		const tab = this.#byResumeId(id);
		if (!tab) return;
		tab.stopped = true;
		this.#resume?.sync();
	}

	/** The tab this computer runs for `peerId` on `sessionPath`, if any. */
	tabForSession(sessionPath: string, peerId: string): string | null {
		for (const tab of this.#tabs.values())
			if (tab.peerId === peerId && tab.sessionFile === sessionPath) return tab.resumeId;
		return null;
	}

	/** The sessions the tabs here run for paired devices, with their live state: this computer's sidebar rows. */
	hostedSessions(): IpcHostedSession[] {
		const sessions: IpcHostedSession[] = [];
		for (const tab of this.#tabs.values()) {
			if (tab.sessionFile === undefined || tab.viewsWindow) continue;
			const { sidecar } = tab;
			const session: IpcHostedSession = {
				sessionPath: tab.sessionFile,
				cwd: sidecar.cwd,
				kind: sidecar.kind,
				status: tab.run.running && sidecar.status === "ready" ? "running" : sidecar.status,
				device: tab.origin.name,
			};
			if (session.status === "running" && runSettling(tab.run)) session.settling = true;
			if (session.status === "error" && sidecar.statusPayload?.sessionHeld) session.sessionHeld = true;
			if (tab.sessionId !== undefined) session.sessionId = tab.sessionId;
			if (tab.title) session.title = tab.title;
			if (tab.asks.size > 0) session.awaitingInput = true;
			sessions.push(session);
		}
		return sessions;
	}

	/** The omps here that run for paired devices, as members of a shared checkout (`checkout-peers.ts`). */
	checkoutMembers(): CheckoutMember[] {
		return [...this.#tabs].flatMap(([key, tab]) => {
			const { sidecar } = tab;
			const request = sidecar.bridgeRequest?.bind(sidecar);
			if (tab.viewsWindow || !request || sidecar.status !== "ready") return [];
			return [
				{
					key: `hosted:${key}`,
					// Its control tools answer on the device, which knows nothing of this computer's checkouts.
					id: null,
					title: tab.title ?? "",
					cwd: sidecar.cwd,
					...(tab.sessionFile ? { sessionPath: tab.sessionFile } : {}),
					device: tab.origin.name,
					canMessage: false,
					request,
				},
			];
		});
	}

	/** Called whenever `hostedSessions` changed; returns the unsubscribe. */
	onHostedSessionsChange(listener: () => void): () => void {
		this.#hostedListeners.add(listener);
		return () => {
			this.#hostedListeners.delete(listener);
		};
	}

	/**
	 * The sessions this computer works on now, from its windows' tabs and the tabs it runs for every device: what a
	 * device's section of this computer lights for rows no tab of the device holds. Waiting beats a turn, a turn beats
	 * background work, when a window and a device's tab name the same file.
	 */
	liveSessions(): HostLiveSession[] {
		const rank = { waiting: 3, turn: 2, background: 1 } as const;
		const live = new Map<string, HostLiveSession["state"]>();
		const add = (sessionPath: string, state: HostLiveSession["state"]) => {
			const known = live.get(sessionPath);
			if (!known || rank[state] > rank[known]) live.set(sessionPath, state);
		};
		for (const session of this.#deps.windowLiveSessions?.() ?? []) add(session.sessionPath, session.state);
		for (const tab of this.#tabs.values()) {
			if (tab.sessionFile === undefined || tab.viewsWindow) continue;
			if (tab.asks.size > 0) add(tab.sessionFile, "waiting");
			else if (tab.run.running) add(tab.sessionFile, runSettling(tab.run) ? "background" : "turn");
		}
		return [...live].map(([sessionPath, state]) => ({ sessionPath, state }));
	}

	/**
	 * Something a session's work hangs on changed (a turn, background work, an ask, here or in a window): every
	 * connected device hears the new list once a burst settles (`LIVE_SESSIONS_DEBOUNCE_MS`), and only when it differs.
	 */
	/** This computer's Mobile web address changed: every connected device hears it (`host.mobileWeb.changed`). */
	mobileWebLinkChanged(url: string | null): void {
		for (const conn of this.#conns) emitSafely(conn, MOBILE_WEB_LINK_EVENT, { url });
	}

	liveSessionsChanged(): void {
		if (this.#liveTimer) return;
		this.#liveTimer = setTimeout(() => {
			this.#liveTimer = undefined;
			const sessions = this.liveSessions();
			const snapshot = JSON.stringify(sessions);
			if (snapshot === this.#liveSnapshot) return;
			this.#liveSnapshot = snapshot;
			for (const conn of this.#conns) emitSafely(conn, LIVE_SESSIONS_EVENT, { sessions });
		}, LIVE_SESSIONS_DEBOUNCE_MS);
		this.#liveTimer.unref?.();
	}

	#hostedChanged(): void {
		this.liveSessionsChanged();
		const snapshot = JSON.stringify(this.hostedSessions());
		if (snapshot === this.#hostedSnapshot) return;
		this.#hostedSnapshot = snapshot;
		for (const listener of this.#hostedListeners) listener();
	}

	/**
	 * A window of this computer opens `sessionPath`, which a paired device's tab here runs: the tab as that
	 * window's sidecar (hosted-view.ts), so one omp serves both. Null when no tab here holds the session.
	 */
	viewSession(sessionPath: string): HostedTabView | null {
		const tab = this.#holder(sessionPath);
		if (!tab) return null;
		const view: HostedTabView = new HostedTabView({
			sidecar: tab.sidecar,
			promptOrigin: { deviceId: PROMPT_ORIGIN_HOST_ID, name: tab.origin.hostName },
			labelTranscript: data => labelForHost(data, tab.origin),
			start: () => this.#start(tab),
			answer: frame => this.#answer(tab, frame, "host", view),
			stopped: () => this.noteStopped(tab.resumeId),
			cancelWait: () => this.#resume?.cancelWait(tab.resumeId),
			snapshot: () => ({
				asks: [...tab.asks.values()],
				...(tab.sessionId === undefined ? {} : { sessionId: tab.sessionId }),
				...(tab.title ? { title: tab.title } : {}),
				...(tab.awaitingConnection ? { awaitingConnection: true } : {}),
				run: runReading(tab.run),
			}),
			leave: left => {
				tab.views.delete(left);
			},
		});
		tab.views.add(view);
		return view;
	}

	/**
	 * Deliver a side-channel frame from the device or a window here. The first answer to an ask wins: the
	 * other side's cards close as answered elsewhere (`answered:<id>`, the pool's synthetic cancel), and its
	 * later answer is refused (`already_answered`) instead of reaching the omp.
	 */
	#answer(tab: HostTab, frame: { type?: unknown; id?: unknown }, side: "device" | "host", from?: HostedTabView): void {
		if ((frame.type === "host_tool_result" || frame.type === "host_uri_result") && typeof frame.id === "string")
			tab.hostCalls.delete(frame.id);
		const id = frame.type === "extension_ui_response" && typeof frame.id === "string" ? frame.id : undefined;
		const first = id === undefined ? undefined : tab.answered.get(id);
		if (first !== undefined && first !== side)
			throw codedError("already_answered", "Another device already answered this request");
		tab.sidecar.sendSideChannel(frame);
		// An answer to an ask or approval: the turn no longer waits on a person.
		if (id === undefined || !tab.asks.delete(id)) return;
		tab.answered.set(id, side);
		const oldest = tab.answered.keys().next().value;
		if (tab.answered.size > ANSWERED_KEPT && oldest !== undefined) tab.answered.delete(oldest);
		const cancel: ExtensionUIRequest = {
			type: "extension_ui_request",
			id: `answered:${id}`,
			method: "cancel",
			targetId: id,
		};
		if (side === "host") this.#emit(tab, "extensionUi", cancel);
		for (const view of tab.views) if (view !== from) view.emit("extensionUi", cancel);
		this.#resume?.sync();
		this.#hostedChanged();
	}

	/**
	 * After a crash or quit: the tab a marker names, again, not yet started and waiting for its
	 * device like a dropped connection's (grace period). The device's `tab.open` re-attaches it.
	 * Null when the marker's id is not a tab of `peer`'s.
	 */
	reviveTab(peer: PeerInfo, marker: Pick<ResumeMarker, "tab" | "cwd" | "kind" | "sessionPath">): string | null {
		const prefix = resumeId(peer.deviceId, "");
		const rtab = marker.tab.startsWith(prefix) ? marker.tab.slice(prefix.length) : "";
		if (!Rtab.safeParse(rtab).success) return null;
		const existing = this.#tabs.get(this.#key(peer.deviceId, rtab));
		if (existing) return existing.resumeId;
		const tab = this.#createTab(peer, rtab, marker.cwd, marker.kind, false, marker.sessionPath, null);
		this.#startGrace(tab);
		return tab.resumeId;
	}

	async call(peer: PeerInfo, method: string, params: unknown, conn: HostConnection): Promise<unknown> {
		this.#conns.add(conn);
		this.#connOf.set(peer.deviceId, conn);
		switch (method) {
			case "tab.open":
				return this.#open(peer, parse(OpenParams, method, params), conn);
			case "tab.start":
				this.#start(this.#tab(peer, parse(RtabParams, method, params).rtab));
				return null;
			case "tab.restart": {
				const { rtab, cwd, sessionPath } = parse(RestartParams, method, params);
				const tab = this.#tab(peer, rtab);
				const target = cwd ? await directory(cwd) : undefined;
				tab.resumeSessionPath = undefined;
				tab.sidecar.restart(target, sessionPath);
				return null;
			}
			case "tab.adoptCwd": {
				const { rtab, cwd } = parse(AdoptCwdParams, method, params);
				return this.#tab(peer, rtab).sidecar.adoptCwd(cwd);
			}
			case "tab.close": {
				const key = this.#key(peer.deviceId, parse(RtabParams, method, params).rtab);
				if (!this.#tabs.has(key) && this.#opening.has(key)) this.#closedWhileOpening.add(key);
				this.#closeTab(key);
				return null;
			}
			case "tab.command":
				return this.#command(peer, parse(CommandParams, method, params));
			case "tab.sideChannel": {
				const { rtab, frame } = parse(SideChannelParams, method, params);
				this.#answer(this.#tab(peer, rtab), frame, "device");
				return null;
			}
			case KEPT_TABS_METHOD:
				return { tabs: this.#keptTabs(peer) };
			case LIVE_SESSIONS_METHOD:
				return { sessions: this.liveSessions() };
			case MOBILE_WEB_LINK_METHOD:
				return { url: this.#deps.mobileWebUrl?.() ?? null };
			case "tab.cancelWait":
				this.#resume?.cancelWait(this.#tab(peer, parse(RtabParams, method, params).rtab).resumeId);
				return null;
			case "tab.syncImageGeneration":
				this.#tab(peer, parse(RtabParams, method, params).rtab).sidecar.syncImageGeneration();
				return null;
			case "sessions.list": {
				const { scope, cwd } = parse(SessionsListParams, method, params);
				const rows = await this.#deps.sessionIndex.list(scope, cwd);
				const openers = this.#deps.sessionOpeners?.() ?? new Map<string, string>();
				// Every row says, even `null` for none: an older host's rows say nothing, and a device lists those as before.
				return rows.map(row => ({ ...row, openedBySession: openers.get(row.path) ?? null }));
			}
			case "sessions.search": {
				const { query, scope, cwd } = parse(SessionsSearchParams, method, params);
				const candidates = await this.#deps.sessionIndex.list(scope, cwd);
				return this.#deps.sessionIndex.searchContent(
					query,
					candidates.map(info => info.path),
				);
			}
			case "sessions.messages": {
				// A paired device's agent reads a stored session here (`ompdesk_session_read`), never one this computer's user hid.
				const { sessionPath } = parse(SessionPathParams, method, params);
				if (this.#deps.agentHidden?.().has(sessionPath))
					throw codedError("session_hidden", "The user hid that session from agents.");
				return this.#deps.sessionIndex.readMessages(sessionPath);
			}
			case "sessions.kindFor":
				return this.#deps.sessionIndex.kindFor(parse(SessionPathParams, method, params).sessionPath);
			// Where a device's open of a stored session lands, read here (tab-spawn.ts `sessionFolderState`); `restore`
			// puts back the worktree this computer's disk care saved, as the Restore the device's toast offers.
			case "sessions.folder": {
				const { sessionPath, restore } = parse(SessionFolderParams, method, params);
				return sessionFolderState(
					{
						recordedCwd: path => this.#deps.sessionIndex.recordedCwd(path),
						savedWorktrees: savedWorktreesForSpawn,
					},
					sessionPath,
					restore === true,
				);
			}
			case "sessions.delete":
				return this.#deleteSession(peer, parse(SessionPathParams, method, params).sessionPath);
			case "sessions.stop":
				await this.stopSessionTurns(parse(SessionPathParams, method, params).sessionPath, peer.deviceId);
				return null;
			case "sessions.rename": {
				const { sessionPath, name } = parse(RenameParams, method, params);
				return this.#renameSession(sessionPath, name);
			}
			case "sessions.move": {
				const { sessionPath, cwd } = parse(MoveParams, method, params);
				if (this.#liveOwner(sessionPath)) throw codedError("session_open_in_tab", "Session is open on the host");
				return moveSession(this.#deps.localTabs, sessionPath, undefined, () =>
					this.#deps.sessionIndex.moveSession(sessionPath, cwd),
				);
			}
			// C114: the tab's terminals run here, in the tab's folder, with this machine's shells.
			case "terminal.shells":
				return detectShells();
			case "terminal.request": {
				const { rtab, operation } = parse(TerminalParams, method, params);
				const tab = this.#tab(peer, rtab);
				return terminalRequest(terminalOwner(peer.deviceId, rtab), tab.sidecar.cwd, operation as TerminalOperation);
			}
			case "fs.list": {
				const { rtab, cwd, ...payload } = parse(FsListParams, method, params);
				return listWorkspace(this.#fsRoot(peer, rtab, cwd), payload);
			}
			case "fs.read": {
				const { rtab, cwd, ...payload } = parse(FsReadParams, method, params);
				return readWorkspaceFile(this.#fsRoot(peer, rtab, cwd), payload);
			}
			case "fs.stat": {
				const { rtab, cwd, path } = parse(FsReadImageParams, method, params);
				return statWorkspacePath(this.#fsRoot(peer, rtab, cwd), path);
			}
			case "fs.mutate": {
				const { rtab, cwd, mutation } = parse(FsMutateParams, method, params);
				return mutateWorkspace(this.#fsRoot(peer, rtab, cwd), mutation, this.#deps.trashItem);
			}
			case "fs.search": {
				const { rtab, cwd, request } = parse(FsSearchParams, method, params);
				return searchWorkspace(this.#fsRoot(peer, rtab, cwd), request, stockHelperRequest);
			}
			case "fs.readImage": {
				const { rtab, cwd, ...payload } = parse(FsReadImageParams, method, params);
				return readWorkspaceImage(this.#fsRoot(peer, rtab, cwd), payload);
			}
			case "host.files.upload": {
				const { name, dataBase64 } = parse(HostUploadParams, method, params);
				return this.#storeUpload(peer, name, Buffer.from(dataBase64, "base64"));
			}
			case "host.files.uploadPart": {
				const part = parse(HostUploadPartParams, method, params);
				return this.#uploadPart(peer, part);
			}
			case "host.fs.readBinary": {
				const { rtab, cwd, ...payload } = parse(FsReadParams, method, params);
				const result = await readWorkspaceBinary(
					this.#fsRoot(peer, rtab, cwd),
					payload,
					FS_BINARY_REMOTE_MAX_BYTES,
				);
				return encodeBinaryRead(result);
			}
			case "host.fs.readRange": {
				const { rtab, cwd, ...payload } = parse(FsReadRangeParams, method, params);
				return encodeBinaryRead(await readWorkspaceRange(this.#fsRoot(peer, rtab, cwd), payload));
			}
			case "fs.readPlan": {
				const { rtab, cwd, ...payload } = parse(FsReadPlanParams, method, params);
				return readPlanFile(this.#fsRoot(peer, rtab, cwd), this.#deps.sessionIndex.sessionsDir, payload);
			}
			case "fs.listDirs": {
				const listing = parse(ListDirsParams, method, params);
				return listDirectories(listing.path, listing.query);
			}
			case "workspace.default":
				return this.#deps.defaultWorkspace();
			case "launchProfile.get":
				return readLaunchProfile(this.#deps.launchProfiles, parse(LaunchProfileGetParams, method, params).cwd);
			case "launchProfile.update": {
				const { cwd, patch } = parse(LaunchProfileUpdateParams, method, params);
				return updateLaunchProfile(this.#deps.launchProfiles, cwd, patch);
			}
			case "host.models.list":
				return this.#deps.machine.listProviders();
			case "host.models.upsert":
				await this.#deps.machine.upsertProvider(parse(ModelsUpsertParams, method, params).input);
				return null;
			case "host.models.delete":
				await this.#deps.machine.deleteProvider(parse(ModelsDeleteParams, method, params).id);
				return null;
			case "host.models.override": {
				const { provider, modelId, override } = parse(ModelsOverrideParams, method, params);
				await this.#deps.machine.setModelOverride(provider, modelId, override);
				return null;
			}
			case "host.stats.fetch": {
				const { path, params: query } = parse(StatsFetchParams, method, params);
				return this.#deps.machine.fetchStats(path, query);
			}
			case "host.bench.run": {
				const { rtab, cwd, options } = parse(BenchRunParams, method, params);
				const root = this.#fsRoot(peer, rtab, cwd) ?? this.#deps.defaultWorkspace();
				// Every model runs `runs` times: that many requests on this computer's credentials.
				return this.#metered(
					peer.deviceId,
					Math.max(1, options.models.length * options.runs),
					() => this.#deps.machine.runBenchmark(benchCaller(peer.deviceId), options, root),
					result => result.success,
				);
			}
			case "host.bench.abort":
				return this.#deps.machine.abortBenchmark(benchCaller(peer.deviceId));
			case "host.modelSetup.run": {
				const { request } = parse(ModelSetupRunParams, method, params);
				return this.#metered(
					peer.deviceId,
					1,
					() => this.#deps.machine.runModelSetup(benchCaller(peer.deviceId), request),
					result => result.success,
				);
			}
			case "host.modelSetup.status":
				return this.#deps.machine.modelSetupStatus(benchCaller(peer.deviceId));
			case "host.modelSetup.abort":
				return this.#deps.machine.abortModelSetup(benchCaller(peer.deviceId));
			case "host.accountRotation.get":
				return this.#deps.machine.accountRotation();
			case "host.accountRotation.set":
				return this.#deps.machine.setAccountRotation(parse(AccountRotationSetParams, method, params).mode);
			case "host.builtinRea.get":
				return this.#deps.machine.builtinRea();
			case "host.builtinRea.set":
				return this.#deps.machine.setBuiltinRea(parse(BuiltinReaSetParams, method, params).enabled);
			case "host.desktop.get":
				return this.#deps.machine.desktop();
			case "host.desktop.update":
				return this.#deps.machine.desktopUpdate(parse(DesktopUpdateParams, method, params).action);
			case "host.ompUpdate.get":
				return this.#deps.machine.ompUpdate();
			case "host.ompUpdate.now":
				return this.#deps.machine.startOmpUpdate();
			// Settings › Schedules and `ompdesk_schedule` of a device: this computer's own service checks the draft
			// (folder, interval, time) and runs the schedule here, while this OMPdesk is open. A schedule the device
			// saves is the device's: each of its runs, timed or run now, counts against its daily model limit here.
			case "host.schedules.command":
				return this.#deps.machine.schedules(parse(SchedulesCommandParams, method, params).request, peer.deviceId);
			case "host.schedules.log":
				return this.#deps.machine.scheduleLog(parse(SchedulesLogParams, method, params).runId);
			case "host.schedules.create":
				return this.#deps.machine.createSchedule(parse(SchedulesCreateParams, method, params).draft, peer.deviceId);
			// The device's sidebar section for this computer: this computer's own project list, the one its windows show.
			case "host.projects.command":
				return this.#deps.machine.sidebarProjects(parse(ProjectsCommandParams, method, params).request);
			// Agent control of a session this computer runs for the device: the git it would run on its own checkout.
			case GIT_METHODS.facts:
				return branchFacts(parse(GitWorktreeParams, method, params).worktree);
			case GIT_METHODS.evidence: {
				const { worktree, diffChars } = parse(GitEvidenceParams, method, params);
				return branchEvidence(worktree, diffChars);
			}
			case GIT_METHODS.landing:
				return landingFacts(parse(GitWorktreeParams, method, params).worktree);
			case GIT_METHODS.removeWorktree:
				return removeSafeWorktree(parse(GitWorktreeParams, method, params).worktree);
			case GIT_METHODS.discardWorktree:
				return discardOpenedWorktree(parse(GitWorktreeParams, method, params).worktree, {
					openFolders: sessionOpenFolders,
				});
			case GIT_METHODS.merge: {
				const { worktree, label } = parse(GitMergeParams, method, params);
				return mergeBranch(worktree, label);
			}
			case GIT_METHODS.worktreeCreate: {
				const input = parse(GitWorktreeCreateParams, method, params);
				return createWorktree(input.baseCwd, input, this.#deps.worktreeLocation ?? tablessWorktreeBridge);
			}
			// Memory: durable pages and session conclusions, through this computer's own server; a device no longer
			// allowed gets nothing.
			case MEMORY_METHODS.pull:
				return this.#memoryFor(peer).pull(peer.deviceId, parse(MemoryPullParams, method, params));
			case MEMORY_METHODS.push:
				return this.#memoryFor(peer).push(peer.deviceId, parse(MemoryPushParams, method, params));
			case MEMORY_METHODS.conclusionsPull:
				return this.#memoryFor(peer).conclusionsPull(
					peer.deviceId,
					parse(MemoryConclusionPullParams, method, params),
				);
			case MEMORY_METHODS.conclusionsPush:
				return this.#memoryFor(peer).conclusionsPush(
					peer.deviceId,
					parse(MemoryConclusionPushParams, method, params),
				);
			default:
				throw codedError("unsupported", `Unknown method ${method}`);
		}
	}

	disconnected(peer: PeerInfo, conn: HostConnection): void {
		this.#conns.delete(conn);
		if (this.#connOf.get(peer.deviceId) === conn) this.#connOf.delete(peer.deviceId);
		// Nobody is left to read the result.
		void this.#deps.machine.abortBenchmark(benchCaller(peer.deviceId));
		void this.#deps.machine.abortModelSetup(benchCaller(peer.deviceId));
		for (const tab of this.#tabs.values())
			if (tab.peerId === peer.deviceId && tab.conn === conn) this.#startGrace(tab);
	}

	/** This machine's session index changed: tell every connected device (debounced). */
	sessionsChanged(): void {
		if (this.#sessionsTimer) return;
		this.#sessionsTimer = setTimeout(() => {
			this.#sessionsTimer = undefined;
			for (const conn of this.#conns) emitSafely(conn, SESSIONS_CHANGED_EVENT, null);
		}, SESSIONS_CHANGED_DEBOUNCE_MS);
		this.#sessionsTimer.unref?.();
	}

	/** This machine's own OmpUpdater changed state: every connected device shows it like the computer's own row. */
	ompUpdateChanged(state: OmpUpdateState): void {
		for (const conn of this.#conns) emitSafely(conn, OMP_UPDATE_EVENT, state);
	}

	/** This machine's scheduled runs changed: every connected device showing them follows. */
	schedulesChanged(state: SchedulesState): void {
		for (const conn of this.#conns) emitSafely(conn, SCHEDULES_EVENT, state);
	}

	/** This machine's sidebar project list changed: every connected device's section for it follows. */
	sidebarProjectsChanged(state: SidebarProjectsState): void {
		for (const conn of this.#conns) emitSafely(conn, PROJECTS_EVENT, state);
	}

	/** This machine's reply-language setting changed: the tabs it runs for paired devices follow it. */
	syncReplyLanguage(): void {
		for (const tab of this.#tabs.values()) tab.sidecar.syncReplyLanguage();
	}

	/** This machine's profile setting changed: the tabs it runs for paired devices follow it. */
	syncUserProfile(): void {
		for (const tab of this.#tabs.values()) tab.sidecar.syncUserProfile();
	}

	/** This machine's prompt-suggestion switches changed: the tabs it runs for paired devices follow them. */
	syncNextPrompt(): void {
		for (const tab of this.#tabs.values()) tab.sidecar.syncNextPrompt();
	}

	/** This machine's automatic-title switches changed: the tabs it runs for paired devices follow them. */
	syncAutoTitle(): void {
		for (const tab of this.#tabs.values()) tab.sidecar.syncAutoTitle();
	}

	/** This machine's judge-assist switch changed: the tabs it runs for paired devices follow it. */
	syncJudgeAssist(): void {
		for (const tab of this.#tabs.values()) tab.sidecar.syncJudgeAssist();
	}

	/** This machine's account-rotation setting changed: the tabs it runs for paired devices follow it. */
	syncAccountRotation(): void {
		for (const tab of this.#tabs.values()) tab.sidecar.syncAccountRotation();
	}

	/** Memory for a device that may still use this computer; a revoked or blocked one is refused. */
	#memoryFor(peer: PeerInfo): HostMemory {
		const memory = this.#memory;
		if (!memory) throw codedError("unsupported", "Memory is not shared from this computer");
		if (!memory.allows(peer.deviceId)) throw codedError("remote_blocked", "This device may not use this computer");
		return memory;
	}

	/** A revoked device's tabs, benchmark and research stop now, grace or not. */
	dropPeer(deviceId: string): void {
		void this.#deps.machine.abortBenchmark(benchCaller(deviceId));
		void this.#deps.machine.abortModelSetup(benchCaller(deviceId));
		for (const [key, tab] of this.#tabs) if (tab.peerId === deviceId) this.#closeTab(key);
	}

	disposeAll(): void {
		for (const key of [...this.#tabs.keys()]) this.#closeTab(key);
		clearTimeout(this.#sessionsTimer);
		this.#sessionsTimer = undefined;
		clearTimeout(this.#liveTimer);
		this.#liveTimer = undefined;
		this.#conns.clear();
	}

	#key(peerId: string, rtab: string): string {
		return `${peerId}\u0000${rtab}`;
	}

	#tab(peer: PeerInfo, rtab: string): HostTab {
		const tab = this.#tabs.get(this.#key(peer.deviceId, rtab));
		if (!tab) throw codedError("unknown_tab", "Unknown tab");
		return tab;
	}

	#byResumeId(id: string): HostTab | undefined {
		for (const tab of this.#tabs.values()) if (tab.resumeId === id) return tab;
		return undefined;
	}

	/** Spawn the tab's omp unless it already runs: on the session it was opened or revived with, else a new one. */
	#start(tab: HostTab): void {
		if (tab.sidecar.status !== "asleep") return;
		const resume = tab.resumeSessionPath;
		tab.resumeSessionPath = undefined;
		if (resume) tab.sidecar.restart(undefined, resume);
		else tab.sidecar.start();
	}

	/**
	 * The device is away: a grace period that runs out on an idle tab closes it. One that runs out during a
	 * turn (a revived one, continued after this computer's crash or quit, included), a hold for this
	 * computer's connection or while a window here shows the tab starts another, so none loses its work,
	 * its resume marker or the person working in it at this computer to the timer.
	 */
	#startGrace(tab: HostTab): void {
		tab.conn = null;
		clearTimeout(tab.graceTimer);
		tab.graceTimer = setTimeout(() => {
			if (runBusy(tab.run) || tab.awaitingConnection || tab.views.size > 0) this.#startGrace(tab);
			else this.#closeTab(this.#key(tab.peerId, tab.rtab));
		}, this.#graceMs);
		tab.graceTimer.unref?.();
	}

	async #open(peer: PeerInfo, params: z.infer<typeof OpenParams>, conn: HostConnection): Promise<TabOpenResult> {
		const key = this.#key(peer.deviceId, params.rtab);
		const held = this.#tabs.get(key);
		const existing = held ?? this.#adopt(peer, params, conn);
		if (existing) {
			clearTimeout(existing.graceTimer);
			existing.graceTimer = undefined;
			existing.conn = conn;
			// Re-attach: the device missed every event while it was away, so it
			// gets the live status first. A never-started tab is not attached:
			// the device still has to `tab.start` it.
			const attached = existing.sidecar.status !== "asleep";
			// The turn first: the device kept its reading through the lost link and checks it against this.
			if (attached) this.#emit(existing, "run", runReading(existing.run));
			if (attached) this.#emit(existing, "status", this.#statusArg(existing, existing.sidecar.statusPayload));
			// Which sign-ins still run decides whether a re-sent code paste is the login panel's or a leftover,
			// so it goes first.
			this.#emit(existing, "signIn", { active: [...(existing.signIns ?? [])] } satisfies TabSignInArg);
			// The asks the device still shows may be gone (the omp restarted or withdrew them meanwhile),
			// and the omp may have raised others: the whole open list replaces the device's.
			this.#emit(existing, "openAsks", [...existing.asks.values()]);
			// The device's waiting row may date from before it lost this computer.
			this.#emit(existing, "awaitingConnection", existing.awaitingConnection === true);
			// The calls the omp still waits on: a relaunched device (it adopts the tab under a new rtab) lost every one
			// its last process held; the same device back from a lost link lacks only those made while it was away.
			for (const call of existing.hostCalls.values()) {
				if (held && call.delivered) continue;
				// One an earlier connection was handed may have run on that device already: it says so (`resent`), and the
				// device answers from its record of the call instead of running it blindly (agent-control/call-journal.ts).
				const request =
					call.delivered && call.name === "hostToolCall" ? { ...call.request, resent: true } : call.request;
				call.delivered = true;
				this.#emit(existing, call.name, request);
			}
			return { cwd: existing.sidecar.cwd, kind: existing.sidecar.kind, attached };
		}
		// A session deleted on this computer is never reopened for a device whose layout still names it.
		if (deletedSessions().has(params.sessionPath)) throw codedError("session_deleted", "Session was deleted");
		// A window of this computer runs the session: the device views that omp, never a second one on the file.
		const view = params.sessionPath
			? this.#deps.localTabs.viewForDevice(
					params.sessionPath,
					{ deviceId: peer.deviceId, name: peer.name },
					this.#deps.hostName(),
				)
			: null;
		if (view && params.sessionPath) {
			const tab = this.#createTab(peer, params.rtab, view.cwd, view.kind, false, params.sessionPath, conn, view);
			this.#emit(tab, "run", runReading(tab.run));
			this.#emit(tab, "status", this.#statusArg(tab, view.statusPayload));
			this.#emit(tab, "signIn", { active: [] } satisfies TabSignInArg);
			this.#emit(tab, "awaitingConnection", false);
			return { cwd: view.cwd, kind: view.kind, attached: true, viewing: true };
		}
		if (!params.cwd) throw codedError("no_workspace", "No workspace");
		this.#opening.set(key, (this.#opening.get(key) ?? 0) + 1);
		let cwd: string;
		let kind: "agent" | "chat";
		try {
			kind =
				params.kind ?? (params.sessionPath ? await this.#deps.sessionIndex.kindFor(params.sessionPath) : "agent");
			// A stored agent session runs in the folder its file records here, never in the folder the device guessed
			// (tab-spawn.ts does the same for this computer's own windows); a folder that is gone is refused.
			const recorded =
				params.sessionPath && kind === "agent"
					? await this.#deps.sessionIndex.recordedCwd(params.sessionPath)
					: null;
			cwd = recorded
				? await directory(recorded).catch(async () => {
						const saved = await savedWorktreesForSpawn.find(recorded).catch(() => null);
						throw codedError(
							"session_folder_missing",
							saved
								? `The folder this session belongs in no longer exists: ${recorded}. ${this.#deps.hostName()}'s disk care saved it (saved worktree ${saved.id}); restore it there from Work tree › Saved worktrees, then open the session again.`
								: `The folder this session belongs in no longer exists: ${recorded}`,
						);
					})
				: await directory(params.cwd);
		} finally {
			const left = (this.#opening.get(key) ?? 1) - 1;
			if (left > 0) this.#opening.set(key, left);
			else this.#opening.delete(key);
		}
		if (this.#closedWhileOpening.delete(key)) throw codedError("unknown_tab", "The device closed this tab");
		// A concurrent open for the same rtab, or for the same session under another rtab, may have
		// finished while this one awaited: take that tab (or its refusal) instead of a second omp.
		const raced = this.#tabs.get(key);
		if (raced || (params.sessionPath && this.#holder(params.sessionPath))) return this.#open(peer, params, conn);
		// A worktree being removed (worktree-orphans.ts) is not opened until git is done with it.
		if (removalHolds(cwd)) throw codedError("worktree_removing", "That worktree is being removed");
		const tab = this.#createTab(peer, params.rtab, cwd, kind, params.fresh === true, params.sessionPath, conn);
		// The device's sign-in state may come from a tab of this rtab that is gone (closed after its grace, or
		// this computer restarted mid-login): a new omp runs none.
		this.#emit(tab, "signIn", { active: [] } satisfies TabSignInArg);
		this.#emit(tab, "awaitingConnection", false);
		return { cwd: tab.sidecar.cwd, kind, attached: false };
	}

	/**
	 * One session file, one host tab, one omp. A relaunched device reopens its tabs under new rtabs,
	 * each with the session it showed: the tab an earlier connection of that device left on the
	 * session (running out its grace period, or revived after this computer restarted) is taken
	 * over under the new rtab. A tab this same connection still shows under another rtab, or
	 * another device's tab, is refused `session_open_in_tab`: never a second omp on that file.
	 */
	#adopt(peer: PeerInfo, params: z.infer<typeof OpenParams>, conn: HostConnection): HostTab | undefined {
		if (!params.sessionPath) return undefined;
		// This device's own tab on the file first (one it left, or one it still shows); another device's view of a
		// window's tab holds no omp of its own, so this device views the window too.
		const holders = [...this.#tabs.values()].filter(entry => entry.sessionFile === params.sessionPath);
		const tab =
			holders.find(entry => entry.peerId === peer.deviceId) ??
			holders.find(entry => !(entry.viewsWindow && entry.peerId !== peer.deviceId));
		if (!tab) return undefined;
		if (tab.peerId !== peer.deviceId || tab.conn === conn)
			throw codedError("session_open_in_tab", "Session is already open in another tab on the host");
		this.#tabs.delete(this.#key(tab.peerId, tab.rtab));
		// Terminals are owned by rtab; the device lost the old one with its previous launch.
		disposeTerminals(terminalOwner(tab.peerId, tab.rtab));
		tab.formerRtabs = [tab.rtab, ...tab.formerRtabs].slice(0, MAX_FORMER_TAB_IDS);
		tab.rtab = params.rtab;
		this.#tabs.set(this.#key(peer.deviceId, params.rtab), tab);
		return tab;
	}

	/**
	 * The tabs `peer`'s last connection left that still have work (`tabs.kept`): in their grace period, on a session
	 * file (a fresh tab with none cannot be opened again by its path), running a turn, settling, waiting on an ask
	 * or held for this computer's connection. An idle one is left to its grace.
	 */
	#keptTabs(peer: PeerInfo): KeptTab[] {
		const kept: KeptTab[] = [];
		for (const tab of this.#tabs.values()) {
			if (tab.peerId !== peer.deviceId || tab.conn !== null || tab.viewsWindow || !tab.sessionFile) continue;
			const state = keptState(tab);
			if (!state) continue;
			kept.push({
				rtab: tab.rtab,
				formerRtabs: [...tab.formerRtabs],
				sessionPath: tab.sessionFile,
				cwd: tab.sidecar.cwd,
				kind: tab.sidecar.kind,
				state,
				...(tab.title ? { title: tab.title } : {}),
			});
		}
		return kept;
	}

	/** The host tab whose omp is on `sessionPath` (or will be, once started). */
	#holder(sessionPath: string): HostTab | undefined {
		for (const tab of this.#tabs.values()) if (tab.sessionFile === sessionPath) return tab;
		return undefined;
	}

	/**
	 * A tab's omp moved onto a file another host tab already holds (a switch, a restart onto that
	 * session): two omps would append diverging turns to one conversation. The one running a turn
	 * stays, else the one that just moved; the other's omp is stopped and its device sees it exited.
	 */
	#dedupe(tab: HostTab): void {
		const file = tab.sessionFile;
		if (file === undefined) return;
		for (const [key, other] of this.#tabs) {
			if (other === tab || other.sessionFile !== file) continue;
			const loser = runBusy(other.run) && !runBusy(tab.run) ? tab : other;
			this.#emit(loser, "status", this.#goneStatus(loser, "This session is open in another tab on the host"));
			this.#closeTab(loser === tab ? this.#key(tab.peerId, tab.rtab) : key);
			if (loser === tab) return;
		}
	}

	#createTab(
		peer: PeerInfo,
		rtab: string,
		cwd: string,
		kind: "agent" | "chat",
		fresh: boolean,
		sessionPath: string | undefined,
		conn: HostConnection | null,
		/** A window's tab the device views (`localTabs.viewForDevice`) instead of an omp of its own. */
		view?: SidecarLike,
	): HostTab {
		const origin: PromptOriginEnv = { deviceId: peer.deviceId, name: peer.name, hostName: this.#deps.hostName() };
		const sidecar = view ?? this.#deps.createSidecar(cwd, kind, fresh, origin);
		const tab: HostTab = {
			peerId: peer.deviceId,
			rtab,
			resumeId: resumeId(peer.deviceId, rtab),
			sidecar,
			omp: randomUUID(),
			conn,
			resumeSessionPath: sessionPath,
			sessionFile: sessionPath,
			formerRtabs: [],
			graceTimer: undefined,
			// A window's tab may be mid-turn as the device joins it: its events so far reached nobody here.
			run: view instanceof HostedTabView ? runFromReading(view.runReading()) : idleRun(),
			asks: new Map(),
			hostCalls: new Map(),
			origin,
			views: new Set(),
			answered: new Map(),
		};
		this.#tabs.set(this.#key(peer.deviceId, rtab), tab);
		// The resume rules first: a failure they turn into a connection wait reaches the device
		// already waiting, so it never shows there as a failure first.
		this.#trackRun(tab);
		this.#wire(tab);
		this.#trackForWindows(tab);
		if (view) {
			tab.viewsWindow = true;
			// The window's omp may hold asks already: the device's tab gets them as its open set.
			sidecar.on("openAsks", (asks: ExtensionUIRequest[]) => {
				for (const ask of asks) tab.asks.set(ask.id, ask);
				this.#emit(tab, "openAsks", asks);
			});
			// The window closed its tab: the device heard `viewEnded` (#wire), and its tab here goes.
			sidecar.on(VIEW_ENDED_EVENT, () => this.#closeTab(this.#key(tab.peerId, tab.rtab)));
		}
		return tab;
	}

	/**
	 * What this computer's windows read of the tab (`hostedSessions`): its session's id and name, and a
	 * change notice after the tab's own listeners above have updated its state.
	 */
	#trackForWindows(tab: HostTab): void {
		const { sidecar } = tab;
		sidecar.on("session", (identity: SidecarSessionIdentity) => {
			if (identity.sessionId) tab.sessionId = identity.sessionId;
			if (identity.sessionName !== undefined) tab.title = identity.sessionName;
		});
		sidecar.on("sessionInfoUpdate", (frame: SessionInfoUpdateFrame) => {
			if (typeof frame.sessionId === "string") tab.sessionId = frame.sessionId;
			if (frame.title !== undefined) tab.title = frame.title ?? undefined;
		});
		for (const name of [
			"status",
			"session",
			"sessionInfoUpdate",
			"events",
			"extensionUi",
			"promptResult",
			"sessionSettled",
		])
			sidecar.on(name, () => this.#hostedChanged());
	}

	#wire(tab: HostTab): void {
		const { sidecar } = tab;
		for (const name of TAB_EVENT_NAMES) {
			switch (name) {
				case "status":
					sidecar.on(name, (payload: SidecarStatusPayload) => {
						if (payload.status === "starting" || payload.status === "restarting") tab.omp = randomUUID();
						this.#emit(tab, name, this.#statusArg(tab, payload));
					});
					break;
				case "session":
					sidecar.on(name, (identity: SidecarSessionIdentity) => {
						const changed = tab.sessionFile !== identity.sessionFile;
						tab.sessionFile = identity.sessionFile;
						if (changed && tab.run.running) this.#resume?.sync();
						this.#emit(tab, name, identity);
						if (changed) this.#dedupe(tab);
					});
					break;
				case "bridge":
					sidecar.on(name, (result: BridgeConnectResult) => {
						void serializeBridge(result).then(arg => this.#emit(tab, name, arg));
					});
					break;
				case "awaitingConnection":
				case "openAsks":
					// Not the sidecar's: this computer's resume coordinator sets the wait, and `tab.open` sends the asks.
					break;
				default:
					sidecar.on(name, (arg: unknown) => this.#emit(tab, name, arg));
			}
		}
		// A response the omp is about to give can follow frames held back for a batch: they leave first, as in the pool.
		sidecar.on("beforeResponse", () => tab.linkEvents?.sender.flush());
	}

	/**
	 * Keep `tab.run` and the resume facts current from the sidecar's own events: a busy flip
	 * notifies the listeners, and every change the resume rules read reaches the coordinator.
	 */
	#trackRun(tab: HostTab): void {
		const { sidecar } = tab;
		/** `apply` says whether it changed a resume fact beyond busy (a run's end, a retry, an ask). */
		const change = (apply: () => boolean): void => {
			const was = runBusy(tab.run);
			const news = apply();
			const busyChanged = runBusy(tab.run) !== was;
			if (busyChanged) {
				this.#runningChanged();
				this.#scheduleOmpRestart(tab);
				this.#scheduleExtensionApply(tab);
			}
			if (busyChanged || news) this.#resume?.sync();
		};
		// "Running" only means something on a live connection: a restart or crash ends the run,
		// and the asks it had open: the next process never heard of them. Windows ending the session
		// cut the turn off for the next launch to continue (its marker), so those stay as they were.
		sidecar.on("status", (payload: SidecarStatusPayload) => {
			if (payload.status !== "ready" && !payload.sessionEnded)
				change(() => {
					tab.run = idleRun();
					const asked = tab.asks.size > 0;
					tab.asks.clear();
					return asked;
				});
		});
		sidecar.on("promptResult", (frame: PromptResultFrame) => {
			const settled = frame.sessionSettled;
			if (typeof settled === "boolean")
				change(() => {
					settleRun(tab.run, settled);
					return false;
				});
		});
		sidecar.on("sessionSettled", () =>
			change(() => {
				settleRun(tab.run, true);
				return false;
			}),
		);
		sidecar.on("events", (events: AgentSessionEvent[]) => {
			change(() => {
				// A fast turn can start and end inside one batch: busy never changes, yet its outcome is news.
				let news = false;
				for (const event of events) if (trackRunEvent(tab, event) || event.type === "auto_retry_start") news = true;
				return news;
			});
			// A device's view of an Autopilot run it started here counts nothing: the run itself is charged (`runEvents`).
			if (tab.viewsWindow && this.#chargedSession(tab.sessionFile)) return;
			let tokens = 0;
			for (const event of events) tokens += assistantTokens(event);
			if (tokens > 0) this.#quota?.record(tab.peerId, { tokens });
		});
		sidecar.on("extensionUi", (request: ExtensionUIRequest) => {
			const asks = BLOCKING_UI_METHODS[request.method] === true;
			if (asks) tab.asks.set(request.id, request);
			// omp withdrew the request (timeout, abort): no answer will follow.
			if (asks || (request.method === "cancel" && tab.asks.delete(request.targetId))) this.#resume?.sync();
		});
		// The calls a device answers: the omp withdraws one only through a cancel frame, and a process that ends takes its own.
		const pending = (name: PendingHostCall["name"]) => (request: { id: string }) => {
			tab.hostCalls.set(request.id, { name, request, delivered: tab.conn !== null });
		};
		sidecar.on("hostToolCall", pending("hostToolCall"));
		sidecar.on("hostUriRequest", pending("hostUriRequest"));
		sidecar.on("frame", (frame: { type?: unknown; targetId?: unknown }) => {
			if (
				(frame.type === "host_tool_cancel" || frame.type === "host_uri_cancel") &&
				typeof frame.targetId === "string"
			)
				tab.hostCalls.delete(frame.targetId);
		});
		sidecar.on("status", (payload: SidecarStatusPayload) => {
			if (payload.status !== "ready") tab.hostCalls.clear();
		});
	}

	#runningChanged(): void {
		for (const listener of this.#runningListeners) listener();
	}

	/**
	 * omp on this computer was updated: tabs it hosts for paired devices move to it like the
	 * computer's own (omp-restart.ts). The device's composer draft lives on the device.
	 */
	restartOnNewOmp(): void {
		for (const tab of this.#tabs.values()) {
			const decision = ompRestartDecision({ status: tab.sidecar.status, busy: runBusy(tab.run) });
			if (decision === "skip" || tab.viewsWindow) continue;
			if (decision === "wait") tab.ompRestartPending = true;
			else tab.sidecar.restart(undefined, tab.sessionFile);
		}
	}

	/** A hosted turn ended on a tab that waits for the new omp (a tick later: see SidecarPool). */
	#scheduleOmpRestart(tab: HostTab): void {
		if (!tab.ompRestartPending || runBusy(tab.run)) return;
		setImmediate(() => {
			if (!tab.ompRestartPending || runBusy(tab.run) || tab.sidecar.status !== "ready") return;
			if (![...this.#tabs.values()].includes(tab)) return;
			tab.ompRestartPending = false;
			tab.sidecar.restart(undefined, tab.sessionFile);
		});
	}

	/** Working directories of the tabs hosted for paired devices, distinct, in order. */
	workspaceDirs(): string[] {
		return [...new Set([...this.#tabs.values()].map(tab => tab.sidecar.cwd))];
	}

	/** An extension update landed on this computer: hosted tabs apply it like the computer's own (extension-reload.ts). */
	applyExtensionUpdate(plan: ExtensionApplyPlan): number {
		let waiting = 0;
		for (const tab of this.#tabs.values()) {
			const decision = extensionApplyDecision({ status: tab.sidecar.status, busy: runBusy(tab.run) });
			if (decision === "skip" || tab.viewsWindow) continue;
			if (decision === "wait") {
				tab.extensionPending = tab.extensionPending ? mergeApplyPlans(tab.extensionPending, plan) : plan;
				waiting++;
				continue;
			}
			this.#applyExtensionPlan(tab, plan);
		}
		return waiting;
	}

	#applyExtensionPlan(tab: HostTab, plan: ExtensionApplyPlan): void {
		if (plan.restart) {
			tab.extensionPending = undefined;
			tab.sidecar.restart(undefined, tab.sessionFile);
			return;
		}
		void tab.sidecar.reloadExtensions?.(plan)?.catch(() => {});
	}

	#scheduleExtensionApply(tab: HostTab): void {
		if (!tab.extensionPending || runBusy(tab.run)) return;
		setImmediate(() => {
			const plan = tab.extensionPending;
			if (!plan || runBusy(tab.run) || tab.sidecar.status !== "ready") return;
			if (![...this.#tabs.values()].includes(tab)) return;
			tab.extensionPending = undefined;
			if (tab.ompRestartPending) return;
			this.#applyExtensionPlan(tab, plan);
		});
	}

	#statusArg(tab: HostTab, payload: SidecarStatusPayload): TabStatusArg {
		const { sidecar } = tab;
		const { status, cwd: _cwd, ...detail } = payload;
		return {
			// A paired device has no setup screen for this computer: a tab waiting for omp here is its failure to show.
			status: status === "waiting" ? "error" : status,
			statusPayload: detail,
			processAlive: sidecar.processAlive,
			cwd: sidecar.cwd,
			kind: sidecar.kind,
			omp: tab.omp,
		};
	}

	#emit(tab: HostTab, name: TabEventName, arg: unknown): void {
		const { conn } = tab;
		if (!conn) return;
		if (name === "commandsUpdate" && !this.#newCommands(tab, conn, arg)) return;
		if (!conn.slim?.events) {
			this.#send(tab, conn, name, arg);
			return;
		}
		const { sender } = this.#sender(tab, conn);
		if (name === "events") sender.events(arg as AgentSessionEvent[]);
		else if (name === "subagentFrame") sender.subagentFrame(arg as SubagentFrame);
		else {
			// The subagent frames held back for a batch came first and leave first.
			sender.flush();
			this.#send(tab, conn, name, arg);
		}
	}

	/**
	 * Whether a `commandsUpdate` says something the connection has not heard: stock sends the whole list at start and
	 * again on every change of command metadata, often the same list (about 100 KB), and the device replaces its list
	 * with each, so a repeat changes nothing there.
	 */
	#newCommands(tab: HostTab, conn: HostConnection, commands: unknown): boolean {
		const json = JSON.stringify(commands);
		if (tab.sentCommands?.conn === conn && tab.sentCommands.json === json) return false;
		tab.sentCommands = { conn, json };
		return true;
	}

	/** One tab event on `conn`; false when some of it did not go out. A tab whose device has another connection by now sends nothing. */
	#send(tab: HostTab, conn: HostConnection, name: TabEventName, arg: unknown): boolean {
		return tab.conn !== conn || sendTabEvent(conn, tab.rtab, name, arg);
	}

	/** How `events` and `subagentFrame` reach a device that asked for slim ones (`link-events.ts`); one sender per tab and connection. */
	#sender(tab: HostTab, conn: HostConnection): NonNullable<HostTab["linkEvents"]> {
		if (tab.linkEvents?.conn === conn) return tab.linkEvents;
		tab.linkEvents?.sender.dispose();
		const sender = createLinkEventSender({
			slim: conn.slim ?? {},
			send: (name, arg) => this.#send(tab, conn, name, arg),
		});
		tab.linkEvents = { conn, sender };
		return tab.linkEvents;
	}

	async #command(peer: PeerInfo, params: z.infer<typeof CommandParams>): Promise<RpcResponse> {
		const tab = this.#tab(peer, params.rtab);
		const client = tab.sidecar.rpcClient;
		if (!client) throw codedError("sidecar_not_connected", "Sidecar not connected");
		// The client device forwards its renderer's RpcCommand verbatim; omp and
		// the local handlers validate the command itself. A Stop is logged with the device and the control it named,
		// and reaches omp without that origin.
		const command = dispatchedCommand(params.command as unknown as RpcCommand, {
			tab: tab.resumeId,
			session: tab.sessionFile ?? tab.resumeSessionPath,
			peer: peer.deviceId,
		});
		// The user's Stop: nothing continues this turn after a crash (ipc.ts does the same for a local tab).
		if (STOP_COMMANDS[command.type]) this.noteStopped(tab.resumeId);
		// A provider sign-in runs here whether or not the device keeps its link: the device is told what is
		// in flight (`signIn`), so its re-sent code paste is the login panel's while it runs.
		const login = command.type === "login" ? command.providerId : null;
		if (login !== null && (tab.signIns?.length ?? 0) > 0)
			throw codedError("login_in_progress", "A provider sign-in is already in progress in this tab");
		if (login !== null) this.#noteSignIn(tab, login);
		let signInError: string | null = null;
		try {
			const response = commandUsesModel(command)
				? await this.#metered(
						peer.deviceId,
						1,
						() => this.#run(tab, client, command, params.timeoutMs),
						result => result.success,
					)
				: await this.#run(tab, client, command, params.timeoutMs);
			if (!response.success) signInError = response.error ?? "";
			if (response.success) {
				const read = encodedReadKey(command as { type: string });
				if (read) return this.#encodedRead(tab, read, response, params.fresh);
			}
			// A login or logout rewrote this machine's credential store: every tab
			// running here re-reads it — this machine's own and every device's.
			if (response.success && (command.type === "login" || command.type === "logout")) {
				for (const other of this.#tabs.values()) other.sidecar.syncImageGeneration();
				for (const local of this.#deps.localTabs.allSidecars()) if (!local.device) local.syncImageGeneration();
			}
			return response;
		} catch (error) {
			signInError = error instanceof Error ? error.message : String(error);
			throw error;
		} finally {
			if (login !== null) this.#noteSignIn(tab, login, signInError);
		}
	}

	/** An answer as the asking connection reads it: a delta against its last one of that read when it asked for that. */
	#encodedRead(
		tab: HostTab,
		read: NonNullable<ReturnType<typeof encodedReadKey>>,
		response: RpcResponse,
		fresh: boolean | undefined,
	): RpcResponse {
		const { conn } = tab;
		if (!conn?.slim?.[read.needs] || !response.success) return response;
		const slim = JSON.stringify(conn.slim);
		if (tab.reads?.slim !== slim) tab.reads = { slim, encoders: new Map() };
		let encode = tab.reads.encoders.get(read.key);
		if (!encode) {
			encode = createReadEncoder(conn.slim.shiftedReads, read.needs === "rosterReads" || read.needs === "jobsReads");
			tab.reads.encoders.set(read.key, encode);
		}
		return { ...response, data: encode(response.data, fresh === true) };
	}

	/** The tab's omp answers a command, except Autopilot's, which this computer's coordinator answers. */
	async #run(
		tab: HostTab,
		client: NonNullable<SidecarLike["rpcClient"]>,
		command: RpcCommand,
		timeoutMs: number | undefined,
	): Promise<RpcResponse> {
		const target: HostedAutopilotTarget = {
			tabId: tab.resumeId,
			peer: tab.peerId,
			sidecar: tab.sidecar,
			...(tab.sessionFile ? { sessionPath: tab.sessionFile } : {}),
			viewsWindow: tab.viewsWindow === true,
		};
		if (this.#autopilot && (command.type === "get_autopilot" || command.type === "set_autopilot"))
			return this.#autopilot(target, command);
		// The sessions a window's session opened are this computer's: its control tools answer for a device viewing it.
		if (
			this.#agentReview &&
			tab.viewsWindow &&
			(command.type === "agent_control_review" || command.type === "agent_control_family_edits")
		)
			return this.#agentReview(target, command);
		// A device's prompt is typed there: memory recall runs for it here, even in an Autopilot run's tab. Only for a
		// prompt that goes in (one past the device's daily limit never reaches this).
		await noteTypedPrompt(client, command);
		return client.command(command, timeoutMs);
	}

	/** A `login` started (`ended` undefined) or answered on the tab: the device learns what still runs. */
	#noteSignIn(tab: HostTab, providerId: string, ended?: string | null): void {
		const signIns = tab.signIns ?? [];
		if (ended === undefined) signIns.push(providerId);
		else {
			const at = signIns.indexOf(providerId);
			if (at >= 0) signIns.splice(at, 1);
		}
		tab.signIns = signIns;
		this.#emit(tab, "signIn", {
			active: signIns,
			...(ended === undefined ? {} : { ended: { providerId, error: ended } }),
		} satisfies TabSignInArg);
	}

	/**
	 * Run work that spends `requests` of the device's daily model requests. The request is
	 * reserved before the first await and given back when the work throws or reports failure,
	 * so parallel callers at limit - 1 cannot all pass the check.
	 */
	async #metered<T>(
		deviceId: string,
		requests: number,
		work: () => Promise<T>,
		succeeded: (result: T) => boolean,
	): Promise<T> {
		const reservation = this.#quota?.reserve(deviceId, requests);
		if (reservation && !reservation.ok) {
			throw codedError(
				"remote_limit_reached",
				reservation.refusal === "requests" && requests > 1
					? `This needs ${requests} of this device's daily requests on this computer's models, more than are left today.`
					: `This device's ${reservation.refusal === "requests" ? "request" : "token"} limit for today on this computer's models is used up.`,
			);
		}
		try {
			const result = await work();
			if (!succeeded(result)) reservation?.refund();
			return result;
		} catch (error) {
			reservation?.refund();
			throw error;
		}
	}

	/** The host tab holding `sessionPath` with a process that has it in memory. */
	#liveOwner(sessionPath: string): HostTab | undefined {
		for (const tab of this.#tabs.values()) {
			if (tab.sessionFile === sessionPath && tab.sidecar.processAlive) return tab;
		}
		return undefined;
	}

	/**
	 * "Stop and delete" (session-mutations.ts): stop every turn on `sessionPath` here, a window's tab of this computer
	 * (`SidecarPool.stopSession`) and the tabs it runs for paired devices, and resolve once each of those runs has
	 * ended (the tab's run events, never a timer). `by` is the paired device that asked, if any.
	 */
	async stopSessionTurns(sessionPath: string, by?: string): Promise<void> {
		const busy = () =>
			[...this.#tabs.values()].filter(
				tab => tab.sessionFile === sessionPath && !tab.viewsWindow && runBusy(tab.run),
			);
		const window = this.#deps.localTabs.stopSession(sessionPath);
		const held = busy();
		for (const tab of held) {
			this.noteStopped(tab.resumeId);
			recordTurnStop({
				command: "abort_and_restore_queue",
				tab: tab.resumeId,
				by: "session-delete",
				...(by ? { device: by } : {}),
			});
			void tab.sidecar.rpcClient?.command({ type: "abort_and_restore_queue" }).catch(() => undefined);
		}
		const devices = (async () => {
			if (busy().length === 0) return;
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			const timer = setTimeout(() => {
				off();
				reject(codedError("session_running", "The session's turn did not end after Stop"));
			}, STOP_SESSION_WAIT_MS);
			const off = this.onRunningChange(() => {
				if (busy().length > 0) return;
				clearTimeout(timer);
				off();
				resolve();
			});
			return promise;
		})();
		await Promise.all([window, devices]);
	}

	/**
	 * This computer's own delete of `sessionPath` (ipc.ts, session-mutations.ts): the paired devices' tabs on it here
	 * close as another window's tab does for a delete. Refused (`session_running`), with nothing closed, while one of
	 * them runs a turn or compacts; otherwise their tabs end (`exited`) and this resolves, once their omps have
	 * exited, to the notice that the file is gone: the caller runs it only after the stored delete succeeded, so a
	 * device never records a delete of a file still there. Then each device drops the tab and its saved layout entry
	 * and records the delete. A device off the link learns it at its next `tab.open` (`session_deleted`).
	 */
	async closeSessionTabs(sessionPath: string): Promise<() => void> {
		const held = [...this.#tabs.values()].filter(tab => tab.sessionFile === sessionPath);
		if (held.some(tab => runBusy(tab.run)))
			throw codedError("session_running", "A paired device is running this session");
		// `#closeTab` forgets each tab's link: keep where to tell it.
		const told = held.flatMap(tab => (tab.conn ? [{ conn: tab.conn, rtab: tab.rtab }] : []));
		for (const tab of held) {
			this.#emit(tab, "status", this.#goneStatus(tab, "This session was closed on the host"));
			this.#closeTab(this.#key(tab.peerId, tab.rtab));
		}
		await this.#exiting.get(sessionPath);
		return () => {
			for (const { conn, rtab } of told)
				emitSafely(conn, TAB_EVENT, { rtab, name: "sessionDeleted", arg: sessionPath } satisfies TabEventMessage);
		};
	}

	/**
	 * A device's delete takes this computer's own path (session-mutations.ts `deleteSession` with the device tabs): every
	 * idle tab on the file closes, the asking device's leftovers from an earlier connection, another device's tab (told
	 * `sessionDeleted` once the file is gone) and a window's tab here, as closing a tab does; it is refused only while
	 * one of them runs a turn or compacts. Before (21 Oct 2026), a window here or another device holding the session,
	 * idle, refused the delete for good ("Session is open on the host") with nothing the device could close.
	 */
	async #deleteSession(peer: PeerInfo, sessionPath: string): Promise<null> {
		await recordSessionDelete({ sessionPath, by: peer.deviceId }, () =>
			deleteSession(
				this.#deps.localTabs,
				sessionPath,
				undefined,
				() => this.#deps.sessionIndex.deleteSession(sessionPath),
				this,
			),
		);
		return null;
	}

	#goneStatus(tab: HostTab, message: string): TabStatusArg {
		return {
			status: "exited",
			statusPayload: { message },
			processAlive: false,
			cwd: tab.sidecar.cwd,
			kind: tab.sidecar.kind,
		};
	}

	/** This machine's sidebar policy, with a device tab holding the session as the first live owner. */
	async #renameSession(sessionPath: string, name: string): Promise<null> {
		await renameSession(this.#deps.localTabs, sessionPath, name, {
			renameStored: name => this.#deps.renameStoredSession(sessionPath, name),
			otherOwner: () => {
				const owner = this.#liveOwner(sessionPath);
				if (!owner) return undefined;
				return owner.sidecar.status === "ready" ? owner.sidecar.rpcClient : null;
			},
		});
		return null;
	}

	async #storeUpload(peer: PeerInfo, name: string, bytes: Buffer): Promise<{ path: string }> {
		if (!this.#deps.uploads) throw codedError("unsupported", "This computer does not take attached files");
		try {
			return { path: (await this.#deps.uploads.store(peer.deviceId, name, bytes)).path };
		} catch (error) {
			if (error instanceof UploadError)
				throw codedError(error.status === 413 ? "file_too_large" : "upload_refused", error.message);
			throw error;
		}
	}

	/**
	 * One part of a file past a link frame: parts come in order and are held until the last, which stores the whole
	 * file as `host.files.upload` does. A file past the attached-file limit, a part out of order, or parts left
	 * waiting for `UPLOAD_PART_IDLE_MS` are dropped.
	 */
	async #uploadPart(
		peer: PeerInfo,
		part: { upload: string; index: number; last: boolean; name: string; dataBase64: string },
	): Promise<{ path: string } | { received: number }> {
		const key = `${peer.deviceId}\n${part.upload}`;
		const held = this.#parts.get(key);
		const drop = () => {
			const entry = this.#parts.get(key);
			if (entry) clearTimeout(entry.timer);
			this.#parts.delete(key);
		};
		if ((held?.next ?? 0) !== part.index) {
			drop();
			throw codedError("invalid_path", "A part of this file arrived out of order; attach it again");
		}
		// Parts wait in memory: a device builds at most a few files at once, so what it holds stays bounded.
		if (!held && !part.last) {
			const prefix = `${peer.deviceId}\n`;
			const open = [...this.#parts.keys()].filter(other => other.startsWith(prefix)).length;
			if (open >= UPLOAD_PARTS_PER_DEVICE)
				throw codedError("upload_refused", "Too many files are on their way from this device; try again later");
		}
		const chunk = Buffer.from(part.dataBase64, "base64");
		const entry = held ?? { chunks: [], bytes: 0, next: 0 };
		clearTimeout(entry.timer);
		entry.chunks.push(chunk);
		entry.bytes += chunk.byteLength;
		entry.next += 1;
		if (entry.bytes > HOST_UPLOAD_MAX_BYTES) {
			drop();
			throw codedError("file_too_large", "file too large");
		}
		if (!part.last) {
			entry.timer = setTimeout(drop, UPLOAD_PART_IDLE_MS);
			entry.timer.unref?.();
			this.#parts.set(key, entry);
			return { received: entry.bytes };
		}
		drop();
		return this.#storeUpload(peer, part.name, Buffer.concat(entry.chunks));
	}

	#fsRoot(peer: PeerInfo, rtab: string | undefined, cwd: string | undefined): string | null {
		const tab = rtab ? this.#tabs.get(this.#key(peer.deviceId, rtab)) : undefined;
		return tab?.sidecar.cwd ?? cwd ?? null;
	}

	#closeTab(key: string): void {
		const tab = this.#tabs.get(key);
		if (!tab) return;
		this.#tabs.delete(key);
		clearTimeout(tab.graceTimer);
		tab.conn = null;
		// The windows here that show it close their tab first, quietly, while its omp still runs.
		for (const view of [...tab.views]) view.end();
		tab.sidecar.removeAllListeners();
		// Taken before dispose(), which forgets the child it kills.
		const exited = tab.sidecar.whenExited?.() ?? Promise.resolve();
		if (!tab.viewsWindow) noteOmpExit(tab.sidecar.cwd, exited);
		tab.sidecar.dispose();
		const { sessionFile } = tab;
		if (sessionFile !== undefined) {
			// Every omp closing on this file (duplicates included) must exit before a delete removes it.
			const pending = this.#exiting.get(sessionFile);
			const all = pending ? Promise.all([pending, exited]).then(() => undefined) : exited;
			this.#exiting.set(sessionFile, all);
			void all.finally(() => {
				if (this.#exiting.get(sessionFile) === all) this.#exiting.delete(sessionFile);
			});
		}
		disposeTerminals(terminalOwner(tab.peerId, tab.rtab));
		if (runBusy(tab.run)) this.#runningChanged();
		this.#resume?.sync();
		this.#hostedChanged();
	}
}

/** Terminal owner of a paired device's tab here; local windows use `<webContentsId>:<tabId>`. */
function terminalOwner(deviceId: string, rtab: string): string {
	return `peer:${deviceId}:${rtab}`;
}

/** A hosted tab's id for this computer's resume coordinator, beside the local tabs' ids (its first rtab). */
function resumeId(deviceId: string, rtab: string): string {
	return `peer:${deviceId}:${rtab}`;
}

/** Why a tab left in its grace period is worth bringing back to its device (`tabs.kept`); null when it is idle. */
function keptState(tab: HostTab): KeptTab["state"] | null {
	if (tab.asks.size > 0) return "asking";
	if (runSettling(tab.run)) return "settling";
	if (runBusy(tab.run)) return "running";
	return tab.awaitingConnection ? "waiting" : null;
}

/** The benchmark and research slot of a paired device on this machine (windows here use `window:<id>`). */
function benchCaller(deviceId: string): string {
	return `peer:${deviceId}`;
}

/**
 * Push one event. The emit runs inside the sidecar's own listener chain, so
 * an event over the frame cap must not throw into it: drop it and say so.
 */
function emitSafely(conn: HostConnection, event: string, data: unknown): void {
	try {
		conn.emit(event, data);
	} catch (error) {
		console.warn(`[remote-host] dropped ${event}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Push a tab event; false when some of it did not go out. An `events` batch (or, for a device that asked for
 * `slimProgress`, a flush of subagent frames) over the frame cap goes as several frames, in order: an older device gets
 * every `message_update` whole, so a burst of a long reply (an omp catching up, a fast provider) passed 16 MiB in one
 * 32 ms batch, and dropping it lost the turn's `agent_end` with it (the device's tab never left "running"). The
 * halves leave in order, so a decoder that rebuilds from deltas sees the items in the order they were encoded.
 */
function sendTabEvent(conn: HostConnection, rtab: string, name: TabEventName, arg: unknown): boolean {
	try {
		conn.emit(TAB_EVENT, { rtab, name, arg } satisfies TabEventMessage);
		return true;
	} catch (error) {
		const splittable = name === "events" || name === "subagentFrame";
		if (error instanceof FrameTooLargeError && splittable && Array.isArray(arg) && arg.length > 1) {
			const half = Math.ceil(arg.length / 2);
			const first = sendTabEvent(conn, rtab, name, arg.slice(0, half));
			const second = sendTabEvent(conn, rtab, name, arg.slice(half));
			return first && second;
		}
		console.warn(`[remote-host] dropped ${TAB_EVENT}: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

/** The bridge result without the live client: the capabilities probe runs here. */
async function serializeBridge(result: BridgeConnectResult): Promise<TabBridgeArg> {
	if (!result.connected) return result;
	try {
		const capabilities = await result.bridge.request<{ unavailable?: unknown }>("capabilities");
		return { connected: true, ompVersion: result.ompVersion, unavailable: capabilities?.unavailable };
	} catch {
		return { connected: true, ompVersion: result.ompVersion };
	}
}
