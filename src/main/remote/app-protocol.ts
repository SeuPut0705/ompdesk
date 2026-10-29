/**
 * Application protocol between a client device (A) and the host it runs tabs
 * on (B), carried by RemoteClient/RemoteHost requests and events. `rtab` is
 * A's tabId; the host scopes it to the calling peer.
 *
 * Requests (A → B), served by host-services.ts:
 * - `tab.open {rtab, cwd?, kind?, fresh, sessionPath?}` → TabOpenResult
 * - `tab.start {rtab}`, `tab.restart {rtab, cwd?, sessionPath?}`, `tab.adoptCwd {rtab, cwd}`, `tab.close {rtab}`
 * - `tab.command {rtab, command, timeoutMs?}` → RpcResponse
 * - `tabs.kept {}` → `{tabs: KeptTab[]}`: the tabs the host keeps for the asking device that no live connection holds
 *   and that are running a turn, settling, waiting on an ask or held for the host's connection (a relaunched device
 *   opens the ones its layout lost, `readopt.ts`); an older host answers `unsupported`
 * - `tab.sideChannel {rtab, frame}`, `tab.syncImageGeneration {rtab}`
 * - `sessions.list|search|kindFor|delete|rename|move`, `fs.list|read|readImage|readPlan|listDirs`,
 *   `workspace.default`, `launchProfile.get|update`
 * - `host.fs.readBinary {rtab?, cwd?, path, maxBytes?}` → HostFsReadBinaryReply: the file
 *   viewer's bytes, base64 on the link, capped at FS_BINARY_REMOTE_MAX_BYTES by the host
 * - `host.fs.readRange {rtab?, cwd?, path, offset, length}` → HostFsReadBinaryReply: one slice of a file for a
 *   download in parts (`HostFsReadRangeParams`: `length` at most HOST_DOWNLOAD_PART_BYTES), `size` the whole file's,
 *   `truncated` while bytes remain past the slice; an older host answers `unsupported`
 * - `host.files.upload {name, dataBase64}` → `{path}`: a file attached to a prompt of a tab the host runs (a .docx,
 *   a PDF: anything not inlined as text), stored in the host's upload folder (`UploadStore.store`, 24 h); an older
 *   host answers `unsupported`
 * - `host.files.uploadPart {upload, index, last, name, dataBase64}` → `{received}`, the last `{path}`: the same for
 *   a file past one frame (`HOST_UPLOAD_FRAME_BYTES`), in parts sent in order; a host from before 0.69.0 answers
 *   `unsupported`
 * - Settings, Usage and Stats of a remote tab read the host's own machine
 *   (machine-services.ts): `host.models.list {}` → CustomProvidersConfig (providers + stock options),
 *   `host.models.upsert {input: CustomProviderInput}`, `host.models.delete {id}`,
 *   `host.models.override {provider, modelId, override: ModelOverrideInput | null}`,
 *   `host.stats.fetch {path, params?}` → the stats reply,
 *   `host.bench.run {rtab?, cwd?, options}` → IpcBenchmarkRunResult, `host.bench.abort {}` → boolean,
 *   `host.modelSetup.run {request: ModelSetupRequest}` → IpcModelSetupRunResult,
 *   `host.modelSetup.status {}` → ModelSetupStatus, `host.modelSetup.abort {}` → boolean,
 *   `host.accountRotation.get {}` / `host.accountRotation.set {mode}` → AccountRotationState
 *   (the host's own pref; its sessions follow it)
 * - OMPdesk on the host: `host.desktop.get {}` → HostDesktopState (version, updater state,
 *   theme and language), `host.desktop.update {action: "check"|"download"|"install"}` → HostDesktopState
 *   (install restarts the host; refused with `host_busy` while anything runs there)
 * - omp on the host updates itself (omp-updater.ts): `host.ompUpdate.get {}` → OmpUpdateState,
 *   `host.ompUpdate.now {}` → OmpUpdateState (starts the host's own check and update in the
 *   background and answers at once); the host pushes every state change as the `host.ompUpdate.changed` event
 * - The host's scheduled runs (schedules.ts): `host.schedules.command {request: SchedulesRequest}` →
 *   SchedulesState (the host's own ScheduleService validates every draft and runs them there),
 *   `host.schedules.log {runId}` → string, `host.schedules.create {draft}` → ScheduleCreated (the new
 *   schedule's id from the save that made it, so concurrent creates never swap ids); the host pushes every
 *   change as the `host.schedules.changed` event
 * - The host's sidebar project list (sidebar-projects.ts): `host.projects.command {request: SidebarProjectsRequest}`
 *   → SidebarProjectsState (get, add a folder the person opened there, remove one from the sidebar); the host pushes
 *   every change as the `host.projects.changed` event
 * - Agent control on a session the host runs (agent-control/branches.ts and local/git/worktree.ts on the host's
 *   own checkout; `worktree` = `{path, branch, baseCwd}` of the tab's binding): `host.git.facts {worktree}` →
 *   BranchFacts, `host.git.evidence {worktree, diffChars}` → BranchEvidence (the child's diff cut to `diffChars`
 *   and a `merge-tree` prediction of its merge), `host.git.landing {worktree}` → LandingFacts, `host.git.merge
 *   {worktree, label}` → MergeOutcome (never pushed), `host.git.removeWorktree {worktree}` → WorktreeRemoval,
 *   `host.git.discardWorktree {worktree}` → WorktreeRemoval (a failed open's unused worktree and branch),
 *   `host.git.worktreeCreate {baseCwd, name, branchPrefix?, baseRef}` → RpcWorktreeCreateResult. Free: no model
 *   call, no quota.
 * - Memory shared between the person's computers (ai-memory/sync.ts; durable pages only, `isDurablePath`):
 *   `host.memory.pull {since}` → MemoryPullReply (the host's pages changed after the cursor, none the asking
 *   device itself sent), `host.memory.push {pages}` → MemoryPushReply (written through the host's own server, each
 *   only while the host still holds the version the device last saw). A host with memory off answers
 *   `{memory: false}` and reads or writes nothing; a device no longer allowed here is refused `remote_blocked`.
 * - Session conclusions (a turn's final-answer excerpt, `MEMORY_CONCLUSION_MAX_BYTES`, redacted; same sync, same
 *   gate): `host.memory.conclusions.pull {since: {native, synced}}` → MemoryConclusionPullReply (the host's own
 *   conclusions then those it holds from other computers, none the asking device itself sent),
 *   `host.memory.conclusions.push {conclusions}` → MemoryConclusionPushReply (insert-if-absent on the host's
 *   server: `written`, `same`, `skipped`, or `failed`). A host with memory off answers `{memory: false}`.
 *
 * - The sessions the host works on now (any of its windows' tabs, the tabs it runs for any device):
 *   `sessions.live {}` → LiveSessionsReply; the host pushes every change as the `host.liveSessions` event.
 *
 * Events (B → A): `tab.event` (TabEventMessage), `sessions.changed` (no data), `host.ompUpdate.changed`,
 * `host.schedules.changed`, `host.projects.changed` and `host.liveSessions`.
 * Both sides parse what crosses the link with the schemas below.
 */
import { z } from "zod";
import { ACCOUNT_ROTATION_MODES, type AccountRotationState } from "../../shared/account-rotation";
import type { BuiltinReaState } from "../../shared/builtin-mcp";
import { codedError, isIpcErrorCode } from "../../shared/ipc-error-codes";
import type {
	CustomModelEffort,
	CustomModelThinkingMode,
	CustomProviderApi,
	CustomProviderDiscoveryType,
	CustomProviderInput,
	HostDesktopState,
	IpcBenchmarkRunOptions,
	IpcFsReadBinaryResult,
	ModelOverrideInput,
	UpdateStatus,
} from "../../shared/ipc-types";
import {
	HOST_DOWNLOAD_MAX_BYTES,
	HOST_DOWNLOAD_PART_BYTES,
	HOST_UPLOAD_FRAME_BYTES,
	HOST_UPLOAD_PART_BYTES,
} from "../../shared/ipc-types";
import type { ModelSetupStatus } from "../../shared/model-setup";
import { OMP_UPDATE_FAILURE_REASONS, type OmpUpdateState } from "../../shared/omp-update";
import { BLOCKING_UI_METHODS, type ExtensionUIRequest } from "../../shared/rpc-types";
import type { ScheduleCreated, ScheduleFrequency, SchedulesRequest, SchedulesState } from "../../shared/schedules";
import type { SidebarProjectsRequest, SidebarProjectsState } from "../../shared/sidebar-projects";

/**
 * Events a host sends for a remote tab: the SidecarManager events it forwards (everything else
 * stays on the host), plus the ones the host derives, re-sent on every `tab.open` of a tab it
 * still holds: `awaitingConnection` (boolean): the host holds the tab's turn until its own
 * internet connection is back (turn-resume.ts; for a tab that views a window, that window's tab's
 * wait); `scheduledRetry` (below); `openAsks` (TabOpenAsksArg): every ask and approval the tab's
 * omp still waits on, the whole list, so the device replaces its own; `signIn` (TabSignInArg): the
 * provider sign-ins the tab is running.
 */
export const TAB_EVENT_NAMES = [
	"status",
	"events",
	"extensionUi",
	"hostToolCall",
	"hostUriRequest",
	"subagentFrame",
	"liveFrame",
	"btwFrame",
	"modelCatalogUpdate",
	"commandsUpdate",
	"configUpdate",
	"promptResult",
	"sessionSettled",
	"commandOutput",
	"sessionInfoUpdate",
	"extensionError",
	"session",
	"bridge",
	"awaitingConnection",
	"openAsks",
	"signIn",
	// The tab views a window of the host (`TabOpenResult.viewing`) and that window closed it: the device's tab goes quietly.
	"viewEnded",
	// The host's own person deleted the tab's session (arg: its path): the device drops the tab and remembers the delete.
	// An older device does not know the name and drops it; the "exited" status sent after it still ends its tab.
	"sessionDeleted",
	// The turn the tab's omp runs (TabRunArg), sent just before the status on every re-attach: a device that lost the
	// link meanwhile saw none of the turn's start or end. An older device drops the name and keeps its old reading.
	"run",
	// The review list of the window's session the tab views (AgentReviewResult): the sessions its agent opened are the
	// host's tabs, which the device's work board lists from this. An older device drops the name.
	"agentReview",
	// The retry this computer scheduled for the turn of the window's tab the device views (TabScheduledRetryArg, null when
	// none), sent as it changes and on every `tab.open`. An older device drops the name; an older host never sends it.
	"scheduledRetry",
] as const;

export type TabEventName = (typeof TAB_EVENT_NAMES)[number];

/** The tab event with the review list of a window's session a device views (`agentReview`, AgentReviewResult). */
export const AGENT_REVIEW_EVENT = "agentReview" satisfies TabEventName;

export const TAB_EVENT = "tab.event";
export const SESSIONS_CHANGED_EVENT = "sessions.changed";
/** The host's omp update changed (data: OmpUpdateState); sent to every connected device. */
export const OMP_UPDATE_EVENT = "host.ompUpdate.changed";
/** The host's scheduled runs changed (data: SchedulesState); sent to every connected device. */
export const SCHEDULES_EVENT = "host.schedules.changed";
/** The host's sidebar project list changed (data: SidebarProjectsState); sent to every connected device. */
export const PROJECTS_EVENT = "host.projects.changed";
/**
 * The sessions this computer works on now changed (data: {@link LiveSessionsReply}): its windows' tabs and the tabs it
 * runs for any device, sent to every connected device so a row no tab of theirs holds still shows the work. An older
 * device drops the name. `sessions.live {}` answers the same list (a device reads it as its link comes up).
 */
export const LIVE_SESSIONS_EVENT = "host.liveSessions";
export const LIVE_SESSIONS_METHOD = "sessions.live";
export const HostLiveSessionSchema = z.object({
	sessionPath: z.string().min(1),
	state: z.enum(["turn", "background", "waiting"]),
});
export const LiveSessionsReply = z.object({ sessions: z.array(z.unknown()) });
/**
 * This computer's Mobile web address (data: {@link MobileWebLinkReply}): `https://<MagicDNS name>:<port>` while it serves
 * phones, else null. A paired device shows it to its own phone page, so a phone can go to this computer's page directly
 * (the address holds no secret: serve adds its path itself, and Tailscale identity still decides who gets in).
 * `host.mobileWeb.link {}` answers it as the link comes up; the event tells every connected device of a change.
 */
export const MOBILE_WEB_LINK_EVENT = "host.mobileWeb.changed";
export const MOBILE_WEB_LINK_METHOD = "host.mobileWeb.link";
export const MobileWebLinkReply = z.object({ url: z.string().url().startsWith("https://").nullable() });
/** This computer's device name changed (data: `{name}`); sent to every connected device. */
export const HOST_NAME_EVENT = "host.name";
/**
 * An Autopilot run of the host stopped, ended or released (data: {@link AutopilotNoticeEvent}): sent to the device that
 * started it and to every device with a tab on the run's session, so its person hears of it like of the host's own.
 */
export const AUTOPILOT_NOTICE_EVENT = "host.autopilotNotice";
export const AutopilotNoticeEvent = z.object({
	kind: z.enum(["completion", "error"]),
	title: z.string().max(200),
	body: z.string().max(2000),
	/** The run's session on the host, so the device can name the tab that shows it. */
	sessionPath: z.string().max(4096).optional(),
});
export type AutopilotNoticeEvent = z.infer<typeof AutopilotNoticeEvent>;
/** The host asks this connected device to rename itself (data: `{name}`). */
export const DEVICE_RENAME_EVENT = "device.rename";
/** Device-name requests the host serves itself: the device names itself, or renames the host. */
export const NAME_METHODS = { peerName: "peer.name", hostRename: "host.rename" } as const;
export const MAX_DEVICE_NAME = 64;
/** Git the host runs for an agent of the device on the host's own checkouts (`host.git.*` above). */
export const GIT_METHODS = {
	facts: "host.git.facts",
	evidence: "host.git.evidence",
	landing: "host.git.landing",
	merge: "host.git.merge",
	removeWorktree: "host.git.removeWorktree",
	discardWorktree: "host.git.discardWorktree",
	worktreeCreate: "host.git.worktreeCreate",
} as const;
/** A merge or a removal runs git for up to two minutes a step on the host: more than the link's default 30 s. */
export const GIT_REQUEST_TIMEOUT_MS = 300_000;
/** `host.git.worktreeCreate` reply: the checkout the device's tab opens in (the rest is the seed and setup report). */
export const WorktreeCreateReply = z
	.object({ path: z.string().min(1), branch: z.string().min(1), baseCwd: z.string().min(1) })
	.passthrough();
/** A device name on the link: trimmed, 1–64 characters. */
export const DeviceNameSchema = z.string().trim().min(1).max(MAX_DEVICE_NAME);
export const NameParams = z.object({ name: DeviceNameSchema });

/** Memory sync (ai-memory/sync.ts): the device drives both directions over its link to the host. */
export const MEMORY_METHODS = {
	pull: "host.memory.pull",
	push: "host.memory.push",
	conclusionsPull: "host.memory.conclusions.pull",
	conclusionsPush: "host.memory.conclusions.push",
} as const;
/** A pull or push batch reads and writes pages on both servers: more than the link's default 30 s. */
export const MEMORY_REQUEST_TIMEOUT_MS = 120_000;
/**
 * The page folders that cross between computers: decisions, rules, gotchas, procedures, preferences and the
 * profile, of any project (`_global` included). Never `sessions/`, never raw observations: those stay on the
 * computer that captured them.
 */
export const DURABLE_MEMORY_FOLDERS = [
	"decisions",
	"_rules",
	"gotchas",
	"procedures",
	"preferences",
	"profile",
] as const;
/** A page body larger than this stays on its computer (a durable page is a few KB). */
export const MEMORY_PAGE_MAX_BYTES = 256 * 1024;
/** A session conclusion's body: the Stop excerpt cap (`conclusionExcerpt`), UTF-8 bytes. */
export const MEMORY_CONCLUSION_MAX_BYTES = 2000;

export function isDurablePath(path: string): boolean {
	const parts = path.split("/");
	return (
		parts.length >= 2 &&
		(DURABLE_MEMORY_FOLDERS as readonly string[]).includes(parts[0] ?? "") &&
		path.endsWith(".md") &&
		!parts.some(part => part === "" || part === "." || part === "..") &&
		!path.includes("\\")
	);
}

const MemoryName = z.string().min(1).max(200);
const MemoryHash = z.string().regex(/^[0-9a-f]{64}$/);
const MemoryTime = z.string().max(64);
/** Where a pull goes on: the last page it examined, by the host's `updated_at` then key. */
export const MemoryCursor = z.object({ at: MemoryTime, key: z.string().max(1200) });
export type MemoryCursor = z.infer<typeof MemoryCursor>;
/**
 * The repository identity of the sender's project (`github.com/owner/repo`): two computers may name one repository's
 * project differently, and the receiver files the item under its own project for it. Absent: the name alone. A peer
 * that predates it drops the field and keeps the name rule.
 */
const MemoryIdentity = z.string().min(1).max(512);
/** One durable page on the link, whole, with its content hash (sync.ts `pageHash`) and the computer it came from. */
export const MemoryPageWire = z.object({
	workspace: MemoryName,
	project: MemoryName,
	identity: MemoryIdentity.optional(),
	/** Which rung produced `identity` (`git_remote`, `explicit`); with it the receiver's write path files the item by identity. */
	identitySource: z.string().min(1).max(32).optional(),
	path: z.string().min(1).max(512).refine(isDurablePath, "not a durable page"),
	title: z.string().max(1000),
	kind: z.string().max(64).optional(),
	tier: z.string().min(1).max(32),
	body: z.string().max(MEMORY_PAGE_MAX_BYTES),
	tags: z.array(z.string().max(200)).max(64),
	pinned: z.boolean(),
	metadata: z.object({
		entities: z.array(z.string().max(200)).max(32).optional(),
		abstract: z.string().max(4000).optional(),
		relations: z.record(z.array(z.string().max(1024)).max(64)).optional(),
		applies_to: z.array(z.string().max(64)).max(32).optional(),
		enforced_by: z.string().max(1000).optional(),
	}),
	/** Frontmatter `expires_at`: a retired (superseded) page carries the moment it left recall. */
	expiresAt: MemoryTime.optional(),
	/** The OMPdesk device id of the computer the page was made or last edited on. */
	origin: MemoryName,
	updatedAt: MemoryTime,
	hash: MemoryHash,
});
export type MemoryPageWire = z.infer<typeof MemoryPageWire>;
export const MemoryPullParams = z.object({ since: MemoryCursor.nullable() });
export type MemoryPullParams = z.infer<typeof MemoryPullParams>;
export const MemoryPullReply = z.object({
	memory: z.boolean(),
	pages: z.array(MemoryPageWire),
	/** Pull again from here; null when nothing was examined. */
	next: MemoryCursor.nullable(),
	more: z.boolean(),
});
export type MemoryPullReply = z.infer<typeof MemoryPullReply>;
export const MemoryPushParams = z.object({
	pages: z
		.array(
			z.object({
				page: MemoryPageWire,
				/** The host's hash of this page as the device last saw it; null when it saw none. */
				expect: MemoryHash.nullable(),
			}),
		)
		.max(100),
});
export type MemoryPushParams = z.infer<typeof MemoryPushParams>;
export const MemoryPushResult = z.object({
	/** `written`: saved here; `same`: already held; `conflict`: changed here since the device looked; `failed`. */
	status: z.enum(["written", "same", "conflict", "failed"]),
	/** The host's hash of the page after the call; null when it holds none. */
	hash: MemoryHash.nullable(),
	/** With `conflict`: the host's version, so the device settles it at once (the later change wins). */
	page: MemoryPageWire.optional(),
});
export const MemoryPushReply = z.object({ memory: z.boolean(), results: z.array(MemoryPushResult) });
export type MemoryPushReply = z.infer<typeof MemoryPushReply>;

/** One session conclusion on the link; `origin` is the OMPdesk device id of the computer that captured it. */
export const MemoryConclusionWire = z.object({
	workspace: MemoryName,
	project: MemoryName,
	identity: MemoryIdentity.optional(),
	/** Which rung produced `identity` (`git_remote`, `explicit`); with it the receiver's write path files the item by identity. */
	identitySource: z.string().min(1).max(32).optional(),
	id: z.string().min(1).max(128),
	sessionId: z.string().min(1).max(64),
	title: z.string().max(1000),
	body: z.string().refine(body => Buffer.byteLength(body) <= MEMORY_CONCLUSION_MAX_BYTES, "conclusion too long"),
	at: MemoryTime,
	origin: z.string().min(1).max(128),
});
export type MemoryConclusionWire = z.infer<typeof MemoryConclusionWire>;
/**
 * Where a conclusion pull goes on: the host's own stream, then the stream it holds from other computers. `store` is the
 * id of the database the two positions were read from; they mean nothing in another (delete all memory and a restored
 * backup renumber the streams), so a cursor naming another store, or past the end of its stream, restarts from 0.
 */
export const MemoryConclusionCursor = z.object({
	native: z.number().int().min(0),
	synced: z.number().int().min(0),
	store: z.string().max(64).optional(),
});
export type MemoryConclusionCursor = z.infer<typeof MemoryConclusionCursor>;
export const MemoryConclusionPullParams = z.object({ since: MemoryConclusionCursor });
export type MemoryConclusionPullParams = z.infer<typeof MemoryConclusionPullParams>;
export const MemoryConclusionPullReply = z.object({
	memory: z.boolean(),
	conclusions: z.array(MemoryConclusionWire).max(200),
	next: MemoryConclusionCursor,
	more: z.boolean(),
});
export type MemoryConclusionPullReply = z.infer<typeof MemoryConclusionPullReply>;
export const MemoryConclusionPushParams = z.object({
	conclusions: z.array(MemoryConclusionWire).min(1).max(200),
});
export type MemoryConclusionPushParams = z.infer<typeof MemoryConclusionPushParams>;
export const MemoryConclusionPushReply = z.object({
	memory: z.boolean(),
	results: z.array(z.object({ status: z.enum(["written", "same", "skipped", "failed"]) })),
});
export type MemoryConclusionPushReply = z.infer<typeof MemoryConclusionPushReply>;

const SessionKind = z.enum(["agent", "chat"]);

export const TabEventMessage = z.object({
	rtab: z.string().min(1),
	name: z.enum(TAB_EVENT_NAMES),
	arg: z.unknown(),
});
export type TabEventMessage = z.infer<typeof TabEventMessage>;

/** `status` event argument: the payload plus what A cannot observe itself. */
export const TabStatusArg = z.object({
	status: z.enum(["asleep", "starting", "ready", "exited", "error", "restarting"]),
	statusPayload: z.object({
		message: z.string().optional(),
		restart: z.object({ attempt: z.number(), maxAttempts: z.number() }).optional(),
		modelFallback: z.string().optional(),
		/** The host's tab waits for another omp there to let go of its session, and opens it by itself then. */
		sessionHeld: z.literal(true).optional(),
	}),
	processAlive: z.boolean(),
	cwd: z.string(),
	kind: SessionKind,
	/**
	 * The omp process this status comes from, new with each one the host's tab starts. A device re-attaching after a
	 * lost link keeps what it shows when this is the one it last saw; absent (an older host): treated as new.
	 */
	omp: z.string().optional(),
});
export type TabStatusArg = z.infer<typeof TabStatusArg>;

/** `run` event argument: the host's reading of the tab's turn (sidecar-run-state.ts), re-sent on every re-attach. */
export const TabRunArg = z.object({
	/** A run is on: a turn in front, or background work (subagents, async jobs) that keeps the session unsettled. */
	running: z.boolean(),
	/** A turn runs in front (`running` without it is background work). */
	turn: z.boolean(),
	compacting: z.boolean().optional(),
	/** How long ago the run started, by the host's clock (no clock between the two computers is shared). */
	elapsedMs: z.number().nonnegative().optional(),
});
export type TabRunArg = z.infer<typeof TabRunArg>;

/** `session` event argument (SidecarSessionIdentity). */
export const TabSessionArg = z.object({
	sessionId: z.string().optional(),
	sessionFile: z.string().optional(),
	sessionName: z.string().optional(),
});

/**
 * `bridge` event argument. The live bridge client never crosses: the host
 * runs the `capabilities` probe itself and sends its `unavailable` list.
 */
export const TabBridgeArg = z.discriminatedUnion("connected", [
	z.object({ connected: z.literal(true), ompVersion: z.string(), unavailable: z.unknown().optional() }),
	z.object({ connected: z.literal(false), ompVersion: z.string(), error: z.string() }),
]);
export type TabBridgeArg = z.infer<typeof TabBridgeArg>;

/**
 * `openAsks` event argument: the blocking extension-UI requests (`BLOCKING_UI_METHODS`) the
 * host tab's omp has open, whole, as it raised them. The body stays unchecked like a forwarded
 * `extensionUi` frame's; only what the device keys its open set on is.
 */
export const TabOpenAsksArg = z.array(
	z.custom<ExtensionUIRequest>(value => {
		if (typeof value !== "object" || value === null) return false;
		const { type, id, method } = value as Record<string, unknown>;
		return (
			type === "extension_ui_request" &&
			typeof id === "string" &&
			typeof method === "string" &&
			BLOCKING_UI_METHODS[method] === true
		);
	}),
);

/**
 * `signIn` event argument: the provider sign-ins (`login` commands) the host's tab is running now, by
 * provider id. Sent when one starts, when one answers (`ended`, with its error or null when it
 * connected) and on every `tab.open` of a held tab: a device that lost the link mid-`login` learns from
 * it whether that sign-in still runs, which decides if its re-sent code paste is the login panel's or a
 * leftover.
 */
export const TabSignInArg = z.object({
	active: z.array(z.string()),
	ended: z.object({ providerId: z.string(), error: z.string().nullable() }).optional(),
});
export type TabSignInArg = z.infer<typeof TabSignInArg>;

/**
 * `scheduledRetry` event argument: the retry the host's TurnResume armed for a failed turn of the window's tab a device
 * views, or null when none holds. Time left, not the host's clock (no clock between the two computers is shared): the
 * device puts it on its own (`at` = its now + `remainingMs`).
 */
export const TabScheduledRetryArg = z
	.object({
		remainingMs: z.number().nonnegative(),
		attempt: z.number().int().positive(),
		max: z.number().int().positive(),
	})
	.nullable();
export type TabScheduledRetryArg = z.infer<typeof TabScheduledRetryArg>;

export const TabOpenResult = z.object({
	/** Canonical cwd on the host. */
	cwd: z.string(),
	kind: SessionKind,
	/**
	 * The host still held this tab (a reconnect inside the grace period): it
	 * re-sent `status` and `openAsks`, and the sidecar keeps running — no `tab.start` needed.
	 */
	attached: z.boolean(),
	/** The device views a tab a window of the host owns (one omp, shared): closing it only leaves. */
	viewing: z.boolean().optional(),
});
export type TabOpenResult = z.infer<typeof TabOpenResult>;

/** Request: the tabs this host keeps for the asking device that no live connection holds and that still have work (`KeptTab`). */
export const KEPT_TABS_METHOD = "tabs.kept";

/**
 * A host tab that outlived its device's connection, still running a turn, settling (background work), waiting on an
 * ask, or held for the host's own connection. `rtab` is the id the device last gave it; `formerRtabs` the ones before
 * (a relaunched device's adoption re-keys it), newest first: the ids an agent of the device may still name it by.
 */
export const KeptTab = z.object({
	rtab: z.string().min(1).max(128),
	formerRtabs: z.array(z.string().min(1).max(128)),
	sessionPath: z.string().min(1),
	cwd: z.string(),
	kind: SessionKind,
	state: z.enum(["running", "settling", "asking", "waiting"]),
	title: z.string().optional(),
});
export type KeptTab = z.infer<typeof KeptTab>;

export const KeptTabsReply = z.object({ tabs: z.array(z.unknown()) });

/** RpcClient's default command timeout; the client waits this plus slack for `tab.command`. */
export const HOST_COMMAND_TIMEOUT_MS = 8_000;
/** Extra wait on top of a command's own timeout, covering the link round trip. */
export const LINK_SLACK_MS = 5_000;

const StringRecord = z.record(z.string());
// Transport shape only: host ModelsConfigSchema is the authority for option values.
const ProviderApi = z.custom<CustomProviderApi>(value => typeof value === "string");
const Effort = z.custom<CustomModelEffort>(value => typeof value === "string");
const OptionalNumber = z.number().finite().optional();

const CustomProviderModelInputSchema = z.object({
	id: z.string().min(1),
	name: z.string().optional(),
	api: ProviderApi.optional(),
	baseUrl: z.string().optional(),
	reasoning: z.boolean().optional(),
	thinking: z
		.object({
			mode: z.custom<CustomModelThinkingMode>(value => typeof value === "string"),
			efforts: z.array(Effort),
			defaultLevel: Effort.optional(),
			supportsDisplay: z.boolean().optional(),
		})
		.optional(),
	input: z.array(z.enum(["text", "image"])).optional(),
	supportsTools: z.boolean().optional(),
	cost: z
		.object({ input: OptionalNumber, output: OptionalNumber, cacheRead: OptionalNumber, cacheWrite: OptionalNumber })
		.optional(),
	premiumMultiplier: OptionalNumber,
	contextWindow: OptionalNumber,
	maxTokens: OptionalNumber,
	omitMaxOutputTokens: z.boolean().optional(),
	headers: StringRecord.optional(),
});

/** `host.models.upsert` input: the Settings form's provider, checked before it touches the host's models.yml. */
export const CustomProviderInputSchema: z.ZodType<CustomProviderInput> = z.object({
	id: z.string().min(1).max(200),
	api: ProviderApi,
	baseUrl: z.string(),
	apiKey: z.string().optional(),
	clearApiKey: z.boolean().optional(),
	auth: z.custom<NonNullable<CustomProviderInput["auth"]>>(value => typeof value === "string").optional(),
	authHeader: z.boolean().optional(),
	headers: StringRecord.optional(),
	discovery: z
		.object({
			type: z.custom<CustomProviderDiscoveryType>(value => typeof value === "string"),
			timeoutMs: OptionalNumber,
		})
		.optional(),
	disableStrictTools: z.boolean().optional(),
	transport: z.literal("pi-native").optional(),
	extraBody: z.record(z.unknown()).optional(),
	models: z.array(CustomProviderModelInputSchema),
});

/** `host.models.override` entry: one model's overrides, checked before it touches the host's models.yml. */
export const ModelOverrideInputSchema: z.ZodType<ModelOverrideInput> = z.object({
	name: z.string().optional(),
	api: ProviderApi.optional(),
	reasoning: z.boolean().optional(),
	thinking: z
		.object({
			mode: z.custom<CustomModelThinkingMode>(value => typeof value === "string"),
			efforts: z.array(Effort).min(1),
			effortMap: z.record(z.string()).optional(),
		})
		.optional(),
	contextWindow: OptionalNumber,
	maxTokens: OptionalNumber,
	replayReasoning: z.boolean().optional(),
});

/** `host.bench.run` options; benchmarkArgs bounds the numbers and selectors. */
export const BenchmarkOptionsSchema: z.ZodType<IpcBenchmarkRunOptions> = z.object({
	models: z.array(z.string()).max(8),
	profile: z.enum(["mix", "chat", "prefill", "generation"]),
	runs: z.number().int(),
	parallel: z.number().int(),
	maxTokens: z.number().int().optional(),
});

/** `host.accountRotation.*` reply: the host's pref and whether its omp can rotate evenly. */
export const AccountRotationStateSchema: z.ZodType<AccountRotationState> = z.object({
	mode: z.enum(ACCOUNT_ROTATION_MODES),
	evenSupported: z.boolean().nullable(),
});

export const BuiltinReaStateSchema: z.ZodType<BuiltinReaState> = z.object({
	enabled: z.boolean(),
	available: z.boolean(),
	nodeVersion: z.string().optional(),
	reason: z.enum(["node-missing", "npx-missing", "node-version", "node-failed", "npx-failed"]).optional(),
});

/** `host.modelSetup.status` reply: whether this device's research runs on the host, and its last tool call. */
export const ModelSetupStatusSchema: z.ZodType<ModelSetupStatus> = z.object({
	running: z.boolean(),
	startedAt: z.number().optional(),
	activity: z.object({ tool: z.string(), detail: z.string().optional() }).optional(),
});

const Mode = z.enum(["automatic", "relaunch", "manual"]);
const UpdateStatusSchema: z.ZodType<UpdateStatus> = z.discriminatedUnion("state", [
	z.object({ state: z.literal("idle") }),
	z.object({ state: z.literal("checking") }),
	z.object({ state: z.literal("available"), version: z.string(), notes: z.string().optional(), mode: Mode }),
	z.object({ state: z.literal("downloading"), version: z.string(), mode: Mode, percent: z.number() }),
	z.object({
		state: z.literal("downloaded"),
		version: z.string(),
		mode: Mode,
		installing: z.literal(true).optional(),
	}),
	z.object({ state: z.literal("not-available"), version: z.string() }),
	z.object({
		state: z.literal("error"),
		message: z.string(),
		detail: z.string().optional(),
		showInBanner: z.boolean().optional(),
	}),
	z.object({ state: z.literal("auth-required"), reason: z.enum(["missing", "invalid", "denied"]) }),
]);

/** `host.desktop.*` reply: the host's OMPdesk version, updater state and appearance prefs. */
export const HostDesktopStateSchema: z.ZodType<HostDesktopState> = z.object({
	version: z.string(),
	update: UpdateStatusSchema,
	appearance: z.object({ themeName: z.string().nullable(), language: z.string().nullable() }),
});

/** `host.ompUpdate.*` reply and `host.ompUpdate.changed` event: the host's own OmpUpdater state. */
export const OmpUpdateStateSchema: z.ZodType<OmpUpdateState> = z.object({
	enabled: z.boolean(),
	scheduled: z.boolean(),
	phase: z.enum(["idle", "checking", "updating"]),
	installed: z.string().nullable(),
	latest: z.string().nullable(),
	checkedAt: z.number().nullable(),
	updatedTo: z.string().nullable(),
	failure: z.object({ reason: z.enum(OMP_UPDATE_FAILURE_REASONS), detail: z.string().optional() }).nullable(),
});

const ScheduleFrequencySchema: z.ZodType<ScheduleFrequency> = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("interval"), minutes: z.number().int() }),
	z.object({ kind: z.literal("daily"), time: z.string().max(5), days: z.array(z.number().int()).max(7) }),
]);

const ScheduleDraftSchema = z.object({
	name: z.string().max(200),
	prompt: z.string().max(200_000),
	cwd: z.string().max(4096),
	frequency: ScheduleFrequencySchema,
	model: z.string().max(200).nullable(),
	autoApprove: z.boolean(),
	enabled: z.boolean(),
});

const ScheduleId = z.string().min(1).max(200);

/** `host.schedules.command` params: one Settings › Schedules action on the host's own service. */
export const SchedulesCommandParams: z.ZodType<{ request: SchedulesRequest }> = z.object({
	request: z.discriminatedUnion("action", [
		z.object({ action: z.literal("get") }),
		z.object({ action: z.literal("save"), id: ScheduleId.optional(), draft: ScheduleDraftSchema }),
		z.object({ action: z.literal("delete"), id: ScheduleId }),
		z.object({ action: z.literal("setEnabled"), id: ScheduleId, enabled: z.boolean() }),
		z.object({ action: z.literal("setPaused"), paused: z.boolean() }),
		z.object({ action: z.literal("runNow"), id: ScheduleId }),
		z.object({ action: z.literal("stop"), runId: ScheduleId }),
	]),
});

export const SchedulesLogParams = z.object({ runId: ScheduleId });
export const SchedulesCreateParams = z.object({ draft: ScheduleDraftSchema });

/** `host.schedules.command` reply and `host.schedules.changed` event: the host's schedules, runs and next starts. */
export const SchedulesStateSchema: z.ZodType<SchedulesState> = z.object({
	paused: z.boolean(),
	schedules: z.array(
		ScheduleDraftSchema.extend({ id: z.string(), createdAt: z.string(), device: z.string().optional() }),
	),
	runs: z.array(
		z.object({
			id: z.string(),
			scheduleId: z.string(),
			trigger: z.enum(["schedule", "manual"]),
			startedAt: z.string(),
			endedAt: z.string().nullable(),
			status: z.enum(["running", "succeeded", "failed", "stopped", "skipped"]),
			exitCode: z.number().nullable(),
			error: z.string().nullable(),
		}),
	),
	nextRuns: z.record(z.string(), z.string().nullable()),
});

/** `host.schedules.create` reply: the id this save made and the state after it. */
export const ScheduleCreatedSchema: z.ZodType<ScheduleCreated> = z.object({
	id: z.string(),
	state: SchedulesStateSchema,
});

const ProjectPath = z.string().min(1).max(4096);

/** `host.projects.command` params: the device's sidebar reads or edits the host's project list. */
export const ProjectsCommandParams: z.ZodType<{ request: SidebarProjectsRequest }> = z.object({
	request: z.discriminatedUnion("action", [
		z.object({ action: z.literal("get") }),
		z.object({ action: z.literal("add"), path: ProjectPath }),
		z.object({ action: z.literal("remove"), path: ProjectPath }),
	]),
});

/** `host.projects.command` reply and `host.projects.changed` event. */
export const SidebarProjectsStateSchema: z.ZodType<SidebarProjectsState, z.ZodTypeDef, unknown> = z.object({
	projects: z.array(z.object({ path: ProjectPath, addedAt: z.number(), missing: z.literal(true).optional() })),
	removed: z.array(ProjectPath),
	// An older host sends none: its sessions then group by their own folder, as before.
	worktrees: z.record(ProjectPath, ProjectPath).default({}),
	worktreeKinds: z.record(ProjectPath, z.enum(["autopilot", "agent", "other"])).optional(),
	gone: z.array(ProjectPath).optional(),
});

/** A host-level stats read waits for the host's own stats request (15 s) plus the link. */
export const HOST_STATS_TIMEOUT_MS = 20_000;

/** A file viewer read moves up to ~15 MB of base64 over the link; give it longer than a plain request. */
export const HOST_FS_READ_BINARY_TIMEOUT_MS = 60_000;

/** Standard base64 (what Buffer emits); a plain character class stays linear on a 15 MB string. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * A file this device attaches to a prompt of a tab the host runs (`host.files.upload`): its bytes cross the link
 * once, base64 in one frame (`HOST_UPLOAD_FRAME_BYTES`), and land in the host's upload folder, where the agent reads it
 * by path. A larger file crosses in parts (`host.files.uploadPart`), in order, the last answering the path. Text files
 * go inline in the prompt instead and need none of this.
 */
export const HOST_UPLOAD_TIMEOUT_MS = 120_000;
export const HostUploadParams = z.object({
	name: z.string().min(1).max(1024),
	dataBase64: z
		.string()
		.max(Math.ceil(HOST_UPLOAD_FRAME_BYTES / 3) * 4)
		.regex(BASE64),
});
export const HostUploadReply = z.object({ path: z.string().min(1) });
export const HostUploadPartParams = z.object({
	/** Names the file the parts build, the sender's own random id. */
	upload: z.string().min(8).max(64),
	index: z.number().int().min(0),
	last: z.boolean(),
	name: z.string().min(1).max(1024),
	dataBase64: z
		.string()
		.max(Math.ceil(HOST_UPLOAD_PART_BYTES / 3) * 4)
		.regex(BASE64),
});
/** A part that is not the last answers how many bytes the host holds so far; the last one answers the path. */
export const HostUploadPartReply = z.union([HostUploadReply, z.object({ received: z.number().int() })]);

/** `host.fs.readRange` params beyond the fs root (`rtab?`, `cwd?`, which host-services adds): one bounded slice of a file. */
export const HostFsReadRangeParams = z.object({
	path: z.string().min(1),
	offset: z.number().int().min(0).max(HOST_DOWNLOAD_MAX_BYTES),
	length: z.number().int().min(0).max(HOST_DOWNLOAD_PART_BYTES),
});

/** `host.fs.readBinary` reply: IpcFsReadBinaryResult with `data` as base64, since the link carries JSON. */
export const HostFsReadBinaryReply = z.object({
	ok: z.boolean(),
	data: z
		.string()
		.regex(BASE64)
		.refine(data => data.length % 4 === 0, "base64 length"),
	mime: z.string().max(255),
	size: z.number().int().nonnegative(),
	truncated: z.boolean(),
	error: z.string().optional(),
	// A newer host may send a code this build does not know: keep the reply, drop the code.
	code: z.string().optional(),
});
export type HostFsReadBinaryReply = z.infer<typeof HostFsReadBinaryReply>;

/** Host side: the bytes go out as base64 without copying them first. */
export function encodeBinaryRead(result: IpcFsReadBinaryResult): HostFsReadBinaryReply {
	const { data, ...rest } = result;
	return { ...rest, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64") };
}

/**
 * Client side: parse the host's reply and decode the base64 straight into an
 * exact-size Uint8Array (its own ArrayBuffer, so IPC clones only these bytes).
 * A malformed reply throws `remote_protocol` naming `method` (the readBinary shape serves `host.fs.readRange` too).
 */
export function decodeBinaryRead(raw: unknown, method = "host.fs.readBinary"): IpcFsReadBinaryResult {
	const parsed = HostFsReadBinaryReply.safeParse(raw);
	if (!parsed.success) throw codedError("remote_protocol", `Malformed ${method} reply`);
	const { data, code, ...rest } = parsed.data;
	const bytes = new Uint8Array(Buffer.byteLength(data, "base64"));
	Buffer.from(bytes.buffer).write(data, "base64");
	return { ...rest, data: bytes, ...(isIpcErrorCode(code) ? { code } : {}) };
}
