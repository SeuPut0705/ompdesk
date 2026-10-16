/**
 * IPC channel definitions shared between main, preload, and renderer.
 * Type-safe contract for the contextBridge API.
 */

import type { AccountRotationMode, AccountRotationState } from "./account-rotation";
import type { BuiltinReaState } from "./builtin-mcp";
import type { GithubAuthState, GithubStarState } from "./github-auth";
import type { IpcErrorCode } from "./ipc-error-codes";
import type { LaunchProfile } from "./launch-profile";
import type { ModelSetupPlan, ModelSetupRequest, ModelSetupStatus } from "./model-setup";
import type { OmpUpdatedNotice, OmpUpdateState } from "./omp-update";
import type { PreviewApi } from "./preview";
import type { SessionRpcClient } from "./rpc-client";
import type {
	AgentSessionEvent,
	AvailableCommand,
	CommandOutputFrame,
	ConfigUpdateFrame,
	ExtensionErrorFrame,
	ExtensionUIRequest,
	ExtensionUIResponse,
	ModelCatalogUpdateFrame,
	PromptResultFrame,
	RpcBtwFrame,
	RpcCommand,
	RpcLiveFrame,
	RpcResponse,
	SessionInfoUpdateFrame,
	SidecarStatus,
	SidecarStatusPayload,
	SubagentFrame,
} from "./rpc-types";
import type { SchedulesApi } from "./schedules";
import type { SetupItemId, SetupState } from "./setup";
import type { SplitLayout } from "./split-layout";
import type { SshToolsApi } from "./ssh-tools";
import type { TerminalApi } from "./terminal-types";
import type { UiLanguage } from "./ui-language";

// ============================================================================
// IPC Channels (main → renderer events)
// ============================================================================

/** A paired host's `OmpUpdateState`, as its own OmpUpdater last reported it. */
export interface IpcHostOmpUpdate {
	device: string;
	state: OmpUpdateState;
}

export const IPC_EVENTS = {
	/** Batched agent session events (16ms cadence) */
	EVENTS_BATCH: "rpc:events",
	/** Sidecar connection status change */
	SIDECAR_STATUS: "sidecar:status",
	/** Per-tab sidecar status push (every tab of the window, foreground or background) */
	TAB_STATUS: "tab:status",
	/** Extension UI request from agent */
	EXTENSION_UI: "extension-ui:request",
	/** A tab's last in-flight provider sign-in answered */
	SIGN_IN_ENDED: "sign-in:ended",
	/** Subagent frames, in order, as one batch per presentation frame (main/subagent-frames.ts) */
	SUBAGENT_FRAMES: "subagent:frames",
	/** Available commands updated */
	COMMANDS_UPDATE: "commands:update",
	/** Agent config changed (set_setting, slash-command config edits) */
	CONFIG_UPDATE: "config:update",
	/** Deferred result for locally handled extension slash commands */
	PROMPT_RESULT: "prompt:result",
	/** Text emitted by text-mode slash commands */
	COMMAND_OUTPUT: "command:output",
	/** Current session title/id changed */
	SESSION_INFO_UPDATE: "session-info:update",
	/** Extension runtime hook failed */
	EXTENSION_ERROR: "extension:error",
	/** Realtime voice session state/levels/transcript update. */
	LIVE_FRAME: "live:frame",
	/** `/btw` side-question answer delta or record update. */
	BTW_FRAME: "btw:frame",
	/** Model/provider discovery completed after a bounded listing response. */
	MODEL_CATALOG_UPDATE: "model-catalog:update",
	/** Session list changed */
	SESSIONS_CHANGED: "sessions:changed",
	/** Log line appended */
	LOG_LINE: "log:line",
	/** Native application menu action */
	MENU_ACTION: "menu:action",
	/** omp:// deep link (new session / switch session) */
	DEEP_LINK: "deep-link",
	/** A click on a desktop notification that named its tab: bring that tab forward */
	NOTIFICATION_CLICK: "notification:click",
	/** Renderer → main fire-and-forget tray-state snapshot */
	TRAY_STATE_PUSH: "tray:state-push",
	/** Renderer → main fire-and-forget run-progress state (dock badge + progress bar) */
	PROGRESS_SET: "progress:set",
	/** Renderer → main fire-and-forget window-controls colors (Windows title-bar overlay follows the theme). */
	WINDOW_CHROME_SET: "window-chrome:set",
	/** Auto-update status machine push (idle/checking/available/downloading/downloaded/not-available/error) */
	UPDATER_STATUS: "updater:status",
	/** New gui-bridge compatibility warnings are waiting; the renderer takes them with BRIDGE_HEALTH_TAKE. */
	BRIDGE_HEALTH: "bridge-health:changed",
	/** Remote devices state changed (host role and paired hosts); payload is the whole RemoteState. */
	REMOTE_STATE: "remote:state",
	/** LAN discovery list changed while discovery runs; payload is the whole RemoteDiscoveredDevice[]. */
	REMOTE_DISCOVERED: "remote:discovered",
	/** The window's open worktree-lifecycle questions changed; payload is the whole IpcWorktreePrompt[]. */
	WORKTREE_PROMPTS: "worktree-lifecycle:prompts",
	/** A worktree-lifecycle step the user should hear about (IpcWorktreeNotice). */
	WORKTREE_NOTICE: "worktree-lifecycle:notice",
	/** This machine's automatic setup changed (src/main/setup/); payload is the whole SetupState. */
	SETUP_STATE: "setup:state",
	/** omp's automatic update changed (src/main/omp-updater.ts); payload is the whole OmpUpdateState. */
	OMP_UPDATE_STATE: "omp-update:state",
	/** omp was just updated on its own; payload is an OmpUpdatedNotice, sent to one window (one quiet toast). */
	OMP_UPDATED: "omp-update:updated",
	/** A paired host's omp update changed (pushed by the host over the link); payload is an IpcHostOmpUpdate. */
	HOST_OMP_UPDATE_STATE: "host-omp-update:state",
	/** This machine's GitHub CLI sign-in changed (src/main/github-auth/); payload is the whole GithubAuthState. */
	GITHUB_AUTH_STATE: "github-auth:state",
} as const;

// ============================================================================
// IPC Channels (renderer → main invoke)
// ============================================================================

export const IPC_COMMANDS = {
	/** Persist a renderer runtime failure in the main-process crash log */
	RUNTIME_ERROR_REPORT: "runtime:error-report",
	/** Absolute path to the main-process crash log */
	RUNTIME_LOG_PATH: "runtime:log-path",
	RUNTIME_LOG_TAIL: "runtime:log-tail",
	LOG_SNAPSHOT: "log:snapshot",
	/** Quit the app through the main-process guard, which confirms while sessions work. */
	APP_QUIT: "app:quit",
	/** Send an RPC command, get response */
	RPC_COMMAND: "rpc:command",
	/** Send an RPC command to a specific tab's sidecar (IpcRpcCommandForTabPayload). */
	RPC_COMMAND_FOR_TAB: "rpc:command-for-tab",
	/** Respond to extension UI request */
	EXTENSION_UI_RESPOND: "extension-ui:respond",
	/** The asks and approvals this window's tabs still wait on (a page that reloaded missed their events) */
	EXTENSION_UI_OPEN: "extension-ui:open",
	/** Get session list */
	SESSIONS_LIST: "sessions:list",
	/** Delete a session file */
	SESSIONS_DELETE: "sessions:delete",
	/** Rename a saved session without switching the active tab */
	SESSIONS_RENAME: "sessions:rename",
	/** Full-content search over session files; returns matching paths with an excerpt */
	SESSIONS_SEARCH: "sessions:search",
	/** Move a stored session (no tab holds it) to another project folder */
	SESSIONS_MOVE: "sessions:move",
	/** Fetch stats endpoint */
	STATS_FETCH: "stats:fetch",
	/** Run/cancel an isolated bundled `omp bench --json` process. */
	BENCH_RUN: "bench:run",
	BENCH_ABORT: "bench:abort",
	/** Run/poll/cancel the model setup assistant's research job. */
	MODEL_SETUP_RUN: "model-setup:run",
	MODEL_SETUP_STATUS: "model-setup:status",
	MODEL_SETUP_ABORT: "model-setup:abort",
	/** Open external URL */
	SYSTEM_INFO: "system:info",
	SYSTEM_OPEN_EXTERNAL: "system:open-external",
	/** Open a file path in the system editor (relative resolves against the workspace) */
	SYSTEM_OPEN_PATH: "system:open-path",
	/** Reveal a file in the file manager (Finder / Explorer); relative paths resolve in the tab's workspace */
	SYSTEM_REVEAL_PATH: "system:reveal-path",
	/** Show save dialog */
	SYSTEM_SAVE_DIALOG: "system:save-dialog",
	/** Ask where to save an image the renderer holds, then write it there */
	SYSTEM_SAVE_IMAGE: "system:save-image",
	/** Show open dialog */
	SYSTEM_OPEN_DIALOG: "system:open-dialog",
	/** Show notification */
	SYSTEM_NOTIFY: "system:notify",
	/** Get GUI preferences */
	PREFS_GET: "prefs:get",
	/** Set GUI preferences */
	PREFS_SET: "prefs:set",
	PREFS_UPDATE_LAUNCH_PROFILE: "prefs:update-launch-profile",
	/** One workspace's launch profile, from the machine that spawns its omp */
	PREFS_GET_LAUNCH_PROFILE: "prefs:get-launch-profile",
	/** Restart sidecar */
	SIDECAR_RESTART: "sidecar:restart",
	/** Get sidecar status */
	SIDECAR_STATUS_GET: "sidecar:status-get",
	/** Choose a project directory and restart the sidecar there */
	SIDECAR_SELECT_PROJECT: "sidecar:select-project",
	SIDECAR_SET_PROJECT: "sidecar:set-project",
	/** Resolve and create the GUI-owned Work-mode workspace. */
	SIDECAR_DEFAULT_WORKSPACE: "sidecar:default-workspace",
	/** List custom models.yml providers */
	MODELS_PROVIDERS_LIST: "models:providers-list",
	/** Upsert a custom provider into models.yml */
	MODELS_PROVIDER_UPSERT: "models:provider-upsert",
	/** Delete a custom provider from models.yml */
	MODELS_PROVIDER_DELETE: "models:provider-delete",
	MODELS_OVERRIDE_SET: "models:override-set",
	/** Open the agent's models.yml in the system editor (created when missing; falls back to revealing it in the file manager) */
	MODELS_CONFIG_OPEN: "models:config-open",
	/** The account-rotation pref of a machine (a paired host, or this device) and whether its omp supports even mode */
	ACCOUNT_ROTATION_GET: "account-rotation:get",
	/** Store the account-rotation pref there; its live sessions follow from their next prompt */
	ACCOUNT_ROTATION_SET: "account-rotation:set",
	BUILTIN_REA_GET: "builtin-rea:get",
	BUILTIN_REA_SET: "builtin-rea:set",
	/** OMPdesk on the focused tab's machine (HostDesktopState); `device` absent = this computer */
	HOST_DESKTOP_GET: "host-desktop:get",
	/** Drive that machine's updater (HostUpdateAction) */
	HOST_DESKTOP_UPDATE: "host-desktop:update",
	/** List workspace files as a tree (main-process readdir, no sidecar needed) */
	FS_LIST: "fs:list",
	/** Read a workspace file with a byte cap */
	FS_READ: "fs:read",
	/** A path's mtime and size (the viewer's disk watch) */
	FS_STAT: "fs:stat",
	/** Files panel writes: new file/folder, rename, move to the trash */
	FS_MUTATE: "fs:mutate",
	/** Text search across the project's files (stock pi-natives grep, .gitignore-aware) */
	FS_SEARCH: "fs:search",
	/** Read the plan-mode document off the RPC bus (with session-local fallback) */
	FS_READ_PLAN: "fs:read-plan",
	/** Read an image file as a data URL for markdown <img> rendering (sniffed mime, size cap) */
	FS_READ_IMAGE: "fs:read-image",
	/** Read a file's bytes for the file viewer (sniffed mime, local/remote size caps) */
	FS_READ_BINARY: "fs:read-binary",
	/** An `omp-media://` stream URL for an audio/video file (range requests; this device's tabs only) */
	FS_MEDIA_STREAM: "fs:media-stream",
	/** Forget a stream URL the renderer no longer plays (send, no reply) */
	FS_MEDIA_RELEASE: "fs:media-release",
	/** Open a session (or a fresh window) in a new parallel window with its own sidecar */
	SESSION_OPEN_NEW_WINDOW: "session:open-new-window",
	/** Fresh window pulls the session it was opened for (one-shot) */
	SESSION_CONSUME_PENDING: "session:consume-pending",
	/** Spawn a tab (own sidecar) bound to the calling window */
	SPAWN_TAB: "tab:spawn",
	/** Close a tab: release its sidecar; last tab leaves the window tab-less */
	CLOSE_TAB: "tab:close",
	/** Move full event forwarding to the window's active tab */
	SET_ACTIVE_TAB: "tab:set-active",
	/** Atomically set the focused tab and the one or two tabs receiving full event streams. */
	SET_TAB_VIEW: "tab:set-view",
	/** Reorder the calling window's tabs (tab overview drag); the saved layout follows */
	REORDER_TABS: "tab:reorder",
	/** List the calling window's tabs (boot reconciliation) */
	GET_TABS: "tab:get-all",
	/** Look up the tab/window currently attached to a session file (F-OWN double-attach guard) */
	GET_SESSION_OWNER: "tab:get-session-owner",
	/** Round-trip a draft through the user's $VISUAL/$EDITOR (temp file, exit-0 read-back) */
	EDITOR_OPEN_EXTERNAL: "editor:open-external",
	/** Manual update check */
	UPDATER_CHECK: "updater:check",
	/** Download the updater-selected payload or architecture-matched macOS installer */
	UPDATER_DOWNLOAD: "updater:download",
	/** Apply an automatic update or reopen a downloaded manual installer */
	UPDATER_APPLY: "updater:apply",
	/** Current updater status (replay for renderer boot) */
	UPDATER_GET_STATUS: "updater:getStatus",
	/** Current app version (settings → updates row) */
	UPDATER_VERSION: "updater:version",
	/** Which GitHub token the updater would use for the private release repo */
	UPDATER_AUTH_INFO: "updater:authInfo",
	/** Probe release-repo access with a pasted token, or the resolved one when omitted */
	UPDATER_AUTH_TEST: "updater:authTest",
	/** Test a pasted token and store it (safeStorage-encrypted) only when it has access */
	UPDATER_AUTH_SAVE: "updater:authSave",
	/** Forget the stored token */
	UPDATER_AUTH_CLEAR: "updater:authClear",
	/** Pending gui-bridge compatibility warnings, handed to exactly one caller */
	BRIDGE_HEALTH_TAKE: "bridge-health:take",
	/** The pending "Continuing N interrupted tasks" notice, handed to exactly one caller (null when none) */
	RESUME_TAKE_NOTICE: "resume:take-notice",
	/** Cancel a tab's wait for the internet connection (payload: tab id) */
	RESUME_CANCEL_WAIT: "resume:cancel-wait",
	/** Stop the turns this launch resumed (the toast's Stop) */
	RESUME_STOP: "resume:stop",
	/** Renderer → main fire-and-forget: the window's `online`/`offline` event (payload: boolean) */
	CONNECTIVITY_REPORT: "connectivity:report",
	/** This machine's automatic setup (src/main/setup/): whole SetupState snapshot */
	SETUP_GET_STATE: "setup:get-state",
	/** Retry one setup item by id (a SetupItemId; anything else is refused). Never takes a command. */
	SETUP_RETRY: "setup:retry",
	/** Cancel the running setup install (kills its process tree) */
	SETUP_CANCEL: "setup:cancel",
	/** omp's automatic update (src/main/omp-updater.ts): whole OmpUpdateState snapshot */
	OMP_UPDATE_GET_STATE: "omp-update:get-state",
	/** Check npm and update omp now, whatever the pref says (runs in the background) */
	OMP_UPDATE_NOW: "omp-update:now",
	/** A paired host's omp update state (OmpUpdateState); `device` names the host */
	HOST_OMP_UPDATE_GET: "host-omp-update:get",
	/** Update the paired host's omp now, whatever its pref says (runs on the host in the background) */
	HOST_OMP_UPDATE_NOW: "host-omp-update:now",
	/** GitHub sign-in on this machine: whole GithubAuthState, re-checked when stale (`force` re-checks now) */
	GITHUB_AUTH_REFRESH: "github-auth:refresh",
	/** Start `gh auth login --web` (ends any live sign-in) */
	GITHUB_AUTH_LOGIN_START: "github-auth:login-start",
	/** The user opened the GitHub page: release gh's "Press Enter to open" pause */
	GITHUB_AUTH_LOGIN_OPEN: "github-auth:login-open",
	GITHUB_AUTH_LOGIN_CANCEL: "github-auth:login-cancel",
	GITHUB_AUTH_LOGOUT: "github-auth:logout",
	/** Make another signed-in account active; only a login `otherAccounts` lists is accepted */
	GITHUB_AUTH_SWITCH: "github-auth:switch",
	/** Fill empty git user.name / user.email from the signed-in account */
	GITHUB_AUTH_FILL_IDENTITY: "github-auth:fill-identity",
	/** The signed-in account's star on OMPdesk's repository: read (`false`) or star it (`true`) */
	GITHUB_PRODUCT_STAR: "github-auth:product-star",
	/** Remote devices: whole RemoteState snapshot */
	REMOTE_GET_STATE: "remote:get-state",
	/** Turn the host role (other devices may use this computer) on or off; persisted in prefs */
	REMOTE_SET_HOST_ENABLED: "remote:set-host-enabled",
	REMOTE_SET_DEVICE_NAME: "remote:set-device-name",
	/** Keep this computer awake while a device uses it; persisted in prefs */
	REMOTE_SET_KEEP_AWAKE: "remote:set-keep-awake",
	/** Mint a fresh pairing code */
	REMOTE_ROTATE_CODE: "remote:rotate-code",
	/** Forget a paired client device and close its live connections */
	REMOTE_REVOKE_PEER: "remote:revoke-peer",
	/** Set a paired client device's daily model-use limits ({deviceId, limits}) */
	REMOTE_SET_PEER_LIMITS: "remote:set-peer-limits",
	/** Start or stop LAN discovery (pushes REMOTE_DISCOVERED) */
	REMOTE_DISCOVER: "remote:discover",
	/** Pair with a host by address and code */
	REMOTE_PAIR: "remote:pair",
	/** Forget a paired host and close its link */
	REMOTE_REMOVE_HOST: "remote:remove-host",
	/** Browse a paired host's directories (remote folder picker) */
	REMOTE_LIST_DIRS: "remote:list-dirs",
	/** The calling window's open worktree-lifecycle questions (IpcWorktreePrompt[]). */
	WORKTREE_PROMPTS_GET: "worktree-lifecycle:prompts-get",
	/** Answer one worktree-lifecycle question (IpcWorktreePromptAnswer). */
	WORKTREE_PROMPT_ANSWER: "worktree-lifecycle:answer",
} as const;

export type RuntimeErrorSource =
	| "react-render"
	| "react-uncaught"
	| "react-recoverable"
	| "window-error"
	| "unhandled-rejection"
	| "renderer-console"
	| "renderer-load"
	| "preload"
	| "renderer-process"
	| "renderer-unresponsive"
	| "application-resources"
	| "child-process"
	| "main-uncaught"
	| "main-unhandled-rejection"
	/** An error toast the user saw (title + raw cause), so a report can be traced afterwards. */
	| "error-toast"
	/** A background task failed without interrupting the user (e.g. saving prompt history). */
	| "background-task"
	| "unknown";

/** Bounded, serializable renderer/main failure payload written as JSONL. */
export interface RuntimeErrorReport {
	source: RuntimeErrorSource;
	message: string;
	stack?: string;
	componentStack?: string;
	url?: string;
	line?: number;
	column?: number;
	details?: Record<string, string | number | boolean | null>;
}

// Update status machine (electron-updater/manual macOS installer → renderer)
// ============================================================================

/**
 * `automatic`: electron-updater/Squirrel (signed macOS, Windows NSIS).
 * `relaunch`: ad-hoc macOS build in a writable location — the verified ZIP is
 * staged in the background and swapped in place on restart or quit.
 * `manual`: ad-hoc build the app cannot replace itself (read-only location) —
 * the verified DMG opens in Finder.
 */
export type UpdateInstallMode = "automatic" | "relaunch" | "manual";

export type UpdateStatus =
	| { state: "idle" }
	| { state: "checking" }
	| { state: "available"; version: string; notes?: string; mode: UpdateInstallMode }
	| { state: "downloading"; version: string; mode: UpdateInstallMode; percent: number }
	| { state: "downloaded"; version: string; mode: UpdateInstallMode }
	| { state: "not-available"; version: string }
	/** `message` is user-facing copy in the UI language; `detail` keeps the raw
	 * technical cause (network/updater error text) for a secondary line or tooltip. */
	| { state: "error"; message: string; detail?: string; showInBanner?: boolean }
	/** No GitHub token, or the token cannot read the private release repo. Settings-only, never a banner. */
	| { state: "auth-required"; reason: "missing" | "invalid" | "denied" };

/**
 * OMPdesk itself on the machine a tab runs on (Settings on a paired host's
 * tab): its version and updater state (B26), and its theme and UI language
 * for "Use the host's theme and language" (B16).
 */
export interface HostDesktopState {
	version: string;
	update: UpdateStatus;
	/** The host's prefs `themeName` (unvalidated name) and `language`; null when unset. */
	appearance: { themeName: string | null; language: string | null };
}

/** What a device asks a host's updater to do; `install` restarts the host into the update. */
export type HostUpdateAction = "check" | "download" | "install";

/** Where the updater's GitHub token came from, in precedence order. */
export type UpdateTokenSource = "env" | "gh" | "stored";

/** Result of probing the release repo with a token. */
export type UpdateAccess = "ok" | "missing" | "invalid" | "denied" | "network";

export interface UpdateAuthInfo {
	/** Source of the token the next check will use; null when none resolves. */
	source: UpdateTokenSource | null;
	hasStoredToken: boolean;
	/** False when the OS cannot encrypt secrets (safeStorage unavailable): pasting is disabled. */
	canStore: boolean;
}

export interface UpdateAuthTestResult {
	access: UpdateAccess;
	source: UpdateTokenSource | null;
}

/**
 * A gui-bridge compatibility problem found at sidecar startup (src/main/bridge-health.ts).
 * `features` are the bridge's feature ids (resources/gui-bridge/capabilities.ts `FEATURES`).
 */
export type BridgeHealthWarning =
	| { kind: "unsupported"; ompVersion: string; features: string[] }
	| { kind: "unavailable"; ompVersion: string; reason: string };

export type MenuAction =
	| "new-session"
	| "new-tab"
	| "new-chat-tab"
	| "close-tab"
	| "open-project"
	| "toggle-sidebar"
	| "toggle-panel"
	| "open-settings"
	| "check-updates"
	| "open-usage"
	| "open-command-center"
	| "open-context-report"
	| "open-jobs"
	| "open-stats"
	| "open-feedback"
	| "open-hotkeys"
	| "open-session-info"
	| "open-share-session"
	| "open-import"
	| "open-branch-picker"
	| "open-session-tree"
	| "open-capabilities"
	| "open-model-picker"
	| "open-git"
	| "restart-sidecar"
	| "open-workspace-dirs"
	| "open-agent-hub"
	| "open-modes"
	| "open-providers"
	| "open-model-roles"
	| "open-extensions"
	| "open-inventory"
	| "open-pr-center"
	| "open-debug"
	| "export-html"
	| "handoff"
	| "toggle-fast"
	| "cycle-thinking"
	| "set-approval"
	| "toggle-language"
	| "switch-project";

/** Action forwarded to the renderer for an omp:// deep link. */
export type DeepLinkPayload = { action: "new-session" } | { action: "switch-session"; sessionId: string };

/** Optional payload carried alongside a MenuAction (approval mode / project cwd). */
export interface MenuActionPayload {
	approvalMode?: "always-ask" | "write" | "yolo";
	cwd?: string;
}

/** Run-progress state pushed by the renderer (terminal.showProgress): dock badge + window progress bar. */
export type RunProgressState = "working" | "waiting" | "idle";

/** Theme colors for the native window controls (Windows title-bar overlay): CSS hex/rgb strings. */
export interface WindowChromeColors {
	/** Background behind the caption buttons (the top bar's surface). */
	color: string;
	/** Glyph color of minimize / maximize / close. */
	symbolColor: string;
}

export type IpcBenchmarkProfile = "mix" | "chat" | "prefill" | "generation";

export interface IpcBenchmarkRunOptions {
	models: string[];
	profile: IpcBenchmarkProfile;
	runs: number;
	parallel: number;
	maxTokens?: number;
}

export interface IpcBenchmarkMetricStats {
	mean: number;
	min: number;
	p50: number;
	p95: number;
	max: number;
}

export interface IpcBenchmarkStats {
	ttftMs: IpcBenchmarkMetricStats;
	durationMs: IpcBenchmarkMetricStats;
	tokensPerSecond: IpcBenchmarkMetricStats;
	generationTps: IpcBenchmarkMetricStats;
	prefillTps: IpcBenchmarkMetricStats;
	inputTokens: number;
	outputTokens: number;
	cost: number;
}

export interface IpcBenchmarkModelReport {
	selector: string;
	model: string;
	stats: IpcBenchmarkStats | null;
	byChallenge: Partial<Record<Exclude<IpcBenchmarkProfile, "mix">, IpcBenchmarkStats>>;
	results: Array<{ ok: boolean; error?: string }>;
}

export interface IpcBenchmarkSummary {
	runs: number;
	profile?: IpcBenchmarkProfile;
	models: IpcBenchmarkModelReport[];
	failures: number;
}

export type IpcBenchmarkRunResult =
	| { success: true; summary: IpcBenchmarkSummary; exitCode: number | null; stderr?: string }
	| { success: false; error: string; stderr?: string; code?: IpcErrorCode };

export type IpcModelSetupRunResult =
	| { success: true; plan: ModelSetupPlan; dropped: string[] }
	| {
			success: false;
			error: string;
			code?: IpcErrorCode;
			stderr?: string;
			/** The research reply when it held no valid plan. */
			reply?: string;
			cancelled?: boolean;
	  };

/** Compact snapshot the renderer pushes to main to build the tray menu. */
export interface TrayState {
	/** `approval`: a tool or plan approval is pending; `input`: any other answer (ask, confirm, …). */
	status: "idle" | "streaming" | "approval" | "input" | "error";
	language: UiLanguage;
	cwd: string | null;
	projectName: string;
	modelId: string | null;
	thinkingLevel: string;
	fastMode: boolean;
	approvalMode: "always-ask" | "write" | "yolo";
	contextPercent: number | null;
	contextTokens: number | null;
	workspaces: { cwd: string; name: string; current: boolean }[];
}

// ============================================================================
// IPC Payload Types
// ============================================================================

export interface IpcRpcCommandPayload {
	command: RpcCommand;
	/** Per-call timeout override (ms) for slow commands (voice STT/TTS model load). */
	timeoutMs?: number;
}

/**
 * RPC addressed at a SPECIFIC tab's sidecar (default RPC_COMMAND resolves the
 * window's ACTIVE tab). Needed by flows that act on a background tab — the
 * worktree close prompt queries/removes on the tab being closed without
 * yanking the user onto it (plan/20).
 */
export interface IpcRpcCommandForTabPayload {
	tabId: string;
	command: RpcCommand;
	timeoutMs?: number;
}

/** The sidecar's `status` event forwarded verbatim (the pool re-stamps `cwd`). */
export type IpcSidecarStatusPayload = SidecarStatusPayload;

export interface IpcExtensionUiRespondPayload {
	response: ExtensionUIResponse;
	tabId?: string;
}

/**
 * Marks a request as a provider sign-in's own (`isSignInRequest` while its `login` ran): the login
 * panel's, never a chat card. `active`: that `login` is still in flight, so the panel shows it again;
 * otherwise the request is a leftover (stock's code paste is never closed) and is answered `cancelled`.
 * `link` is the browser page the sign-in opened, which the panel acknowledged and dropped.
 */
export interface IpcSignIn {
	active: boolean;
	providerId: string | null;
	link?: Extract<ExtensionUIRequest, { method: "open_url" }>;
}

/** `EXTENSION_UI` event payload. */
export interface IpcExtensionUiPayload {
	tabId: string;
	request: ExtensionUIRequest;
	signIn?: IpcSignIn;
	/** A paired host's re-attach sent again an ask this window already showed (its OS notification went out then). */
	resent?: true;
}

/**
 * `SIGN_IN_ENDED` event payload: a tab's last in-flight `login` answered. `error`: null = connected,
 * a message = failed, absent = the outcome went unseen (a paired host's login ended while the link was down).
 */
export interface IpcSignInEndedPayload {
	tabId: string;
	providerId: string | null;
	error?: string | null;
}

/** A blocking extension request still open on a tab, as `EXTENSION_UI_OPEN` lists it. */
export interface IpcOpenExtensionRequest {
	tabId: string;
	request: ExtensionUIRequest;
	signIn?: IpcSignIn;
}

/** DTO types only. Installed stock ModelsConfigSchema supplies all runtime vocabularies. */
export type CustomProviderApi =
	| "openai-completions"
	| "openai-responses"
	| "openai-codex-responses"
	| "azure-openai-responses"
	| "anthropic-messages"
	| "bedrock-converse-stream"
	| "google-generative-ai"
	| "google-gemini-cli"
	| "google-vertex"
	| "openrouter-decisions"
	| "typesafe";

export type CustomModelEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface CustomProviderOptions {
	apis: string[];
	auth: string[];
	discovery: string[];
	thinkingModes: string[];
	efforts: string[];
}

export interface CustomProvidersConfig {
	providers: CustomProviderView[];
	options: CustomProviderOptions;
}

export type CustomModelThinkingMode =
	| "effort"
	| "budget"
	| "google-level"
	| "anthropic-adaptive"
	| "anthropic-budget-effort";

/** Thinking configuration of a model (ModelThinkingSchema, canonical efforts form). */
export interface CustomProviderModelThinking {
	mode: CustomModelThinkingMode;
	efforts: CustomModelEffort[];
	defaultLevel?: CustomModelEffort;
	supportsDisplay?: boolean;
}

/** Per-model pricing in USD per million tokens (all four required when cost is set). */
export interface CustomProviderModelCost {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export type CustomProviderDiscoveryType =
	| "ollama"
	| "llama.cpp"
	| "lm-studio"
	| "openai-models-list"
	| "proxy"
	| "litellm"
	| "apple-foundation-models";

export interface CustomProviderDiscovery {
	type: CustomProviderDiscoveryType;
	timeoutMs?: number;
}

export interface CustomProviderModelInput {
	id: string;
	name?: string;
	/** Per-model protocol override (falls back to the provider's api). */
	api?: CustomProviderApi;
	/** Per-model endpoint override. */
	baseUrl?: string;
	reasoning?: boolean;
	/** Structured thinking config; required `efforts` when present. */
	thinking?: CustomProviderModelThinking;
	/** Input modalities the model accepts. */
	input?: ("text" | "image")[];
	supportsTools?: boolean;
	cost?: CustomProviderModelCost;
	premiumMultiplier?: number;
	contextWindow?: number;
	maxTokens?: number;
	omitMaxOutputTokens?: boolean;
	headers?: Record<string, string>;
}

export interface CustomProviderInput {
	id: string;
	api: CustomProviderApi;
	baseUrl: string;
	apiKey?: string;
	/** Erase the stored key. Blank `apiKey` alone cannot mean "delete": the field
	 * is masked, so an untouched edit submits empty and must keep the secret. */
	clearApiKey?: boolean;
	auth?: "apiKey" | "none" | "oauth";
	/** Send the key in an Authorization header instead of the provider default. */
	authHeader?: boolean;
	headers?: Record<string, string>;
	discovery?: CustomProviderDiscovery;
	disableStrictTools?: boolean;
	/** Route every model through the auth-gateway's /v1/pi/stream endpoint. */
	transport?: "pi-native";
	/** compat.extraBody — extra request-body parameters merged into every call. */
	extraBody?: Record<string, unknown>;
	models: CustomProviderModelInput[];
}

/** A provider entry as shown in the GUI (apiKey masked, never the real value). */
export interface CustomProviderView {
	id: string;
	api: string;
	baseUrl: string;
	hasApiKey: boolean;
	apiKeyPreview?: string;
	auth?: "apiKey" | "none" | "oauth";
	authHeader?: boolean;
	headers?: Record<string, string>;
	discovery?: CustomProviderDiscovery;
	disableStrictTools?: boolean;
	transport?: "pi-native";
	extraBody?: Record<string, unknown>;
	models: CustomProviderModelInput[];
	builtin: boolean;
	/** `modelOverrides` by model id: changes to models this provider already has (B43). */
	modelOverrides?: Record<string, ModelOverrideInput>;
}

/**
 * One models.yml `providers.<provider>.modelOverrides.<modelId>` entry as the
 * GUI edits it (stock ModelOverrideSchema; a field left out inherits the
 * model's own value). Keys the GUI does not render survive an edit.
 */
export interface ModelOverrideInput {
	name?: string;
	/** Wire format (stock `api`). */
	api?: CustomProviderApi;
	reasoning?: boolean;
	/** Reasoning levels and, per level, the value sent on the wire (`thinking.effortMap`). */
	thinking?: {
		mode: CustomModelThinkingMode;
		efforts: CustomModelEffort[];
		effortMap?: Partial<Record<CustomModelEffort, string>>;
	};
	contextWindow?: number;
	maxTokens?: number;
	/** Send earlier reasoning back with tool calls (`compat.requiresReasoningContentForToolCalls`). */
	replayReasoning?: boolean;
}

export interface IpcSessionsListPayload {
	scope: "local" | "global";
	/** Paired host deviceId; absent = this device. */
	device?: string;
}

export interface IpcSessionsDeletePayload {
	sessionPath: string;
	device?: string;
}

export interface IpcSessionsRenamePayload {
	sessionPath: string;
	name: string;
	device?: string;
}

export interface IpcSessionsMovePayload {
	sessionPath: string;
	/** Absolute target project folder on the session's device. */
	cwd: string;
	device?: string;
}

export interface IpcSessionsSearchPayload {
	query: string;
	scope: "local" | "global";
	device?: string;
}

/** One full-content session search hit: the session file and the conversation text around the match. */
export interface SessionContentMatch {
	path: string;
	snippet?: string;
}

export interface IpcStatsFetchPayload {
	path: string;
	params?: Record<string, string>;
	/** Paired host deviceId whose stats server answers; absent = this device. */
	device?: string;
}

export interface IpcNotifyPayload {
	title: string;
	body?: string;
	/** The tab the notification is about; a click on it switches to that tab. */
	tabId?: string;
}

export interface NotificationClickPayload {
	tabId: string;
}

export interface IpcPrefsGetPayload {
	key?: string;
}

export interface IpcPrefsSetPayload {
	key: string;
	value: unknown;
}

export interface IpcUpdateLaunchProfilePayload {
	cwd: string;
	patch: Partial<LaunchProfile>;
	/** Paired host deviceId whose profiles hold `cwd`; absent = this device. */
	device?: string;
}

export interface IpcGetLaunchProfilePayload {
	cwd: string;
	device?: string;
}

// ============================================================================
// Workspace Filesystem Types
// ============================================================================

export interface IpcFsListPayload {
	/** Visible tab whose workspace roots this operation. */
	tabId?: string;
	/** Directory to walk, relative to the workspace root; defaults to the root. */
	path?: string;
	/** Max directory depth to descend into (root level = 0). */
	maxDepth?: number;
	/** Max number of files to include before truncating. */
	maxEntries?: number;
}

export interface FsTreeEntry {
	name: string;
	/** Workspace-relative path using POSIX separators. */
	path: string;
	kind: "file" | "dir";
	/** Directories only; omitted or empty beyond the depth cap. */
	children?: FsTreeEntry[];
}

export interface IpcFsListResult {
	ok: boolean;
	entries: FsTreeEntry[];
	/** True when the file cap stopped the walk early. */
	truncated: boolean;
	error?: string;
	/** Stable failure code for the renderer's localized message (shared/ipc-error-codes). */
	code?: IpcErrorCode;
}

export interface IpcFsReadPayload {
	/** Visible tab whose workspace resolves relative paths. */
	tabId?: string;
	/** Workspace-relative path, or an absolute/~/ path selected for local preview. */
	path: string;
	/** Max bytes to read; hard-capped in main. */
	maxBytes?: number;
}

export interface IpcFsReadResult {
	ok: boolean;
	content: string;
	/** File exceeded maxBytes; content is a prefix. */
	truncated: boolean;
	/** NUL byte found in the read region; content is empty. */
	binary: boolean;
	/** Total file size in bytes. */
	size: number;
	error?: string;
	/** Stable failure code for the renderer's localized message (shared/ipc-error-codes). */
	code?: IpcErrorCode;
}

export interface IpcFsStatResult {
	ok: boolean;
	mtimeMs: number;
	size: number;
	/** The path is a folder (composer and reply file cards). */
	directory?: boolean;
	error?: string;
	/** `file_not_found` once the path is gone. */
	code?: IpcErrorCode;
}

/** A Files panel write; paths are workspace-relative, `name` is one path segment. */
export type IpcFsMutation =
	| { op: "createFile" | "createFolder"; parent: string; name: string }
	| { op: "rename"; path: string; name: string }
	| { op: "trash"; path: string }
	/**
	 * Replace an existing text file's contents (C2, the viewer's Edit). `expectedMtimeMs` is the
	 * modification time the editor loaded; a different one on disk is `changed_on_disk` unless `force`.
	 */
	| { op: "write"; path: string; content: string; expectedMtimeMs: number; force?: boolean };

/** The most a viewer edit may save (UTF-8 bytes); main's text read cap, so an edited file was read whole. */
export const FS_WRITE_MAX_BYTES = 2_000_000;

/** Files panel content search; `query` is plain text unless `regex`. */
export interface IpcFsSearchRequest {
	query: string;
	matchCase: boolean;
	wholeWord: boolean;
	regex: boolean;
	/** Filename glob such as `*.ts`; empty searches every file. */
	glob: string;
}

export interface IpcFsSearchMatch {
	/** Workspace-relative POSIX path. */
	path: string;
	/** 1-based line. */
	line: number;
	/** The line (cut around the match when long). */
	text: string;
}

export interface IpcFsSearchResult {
	ok: boolean;
	matches: IpcFsSearchMatch[];
	/** Files with a match. */
	files: number;
	/** The match cap stopped the search; there are more. */
	limited: boolean;
	error?: string;
	code?: IpcErrorCode;
}

export interface IpcFsMutateResult {
	ok: boolean;
	/** The created, renamed, trashed or written entry's workspace-relative path. */
	path?: string;
	/** After `write`: the file's new modification time, which the next save expects. */
	mtimeMs?: number;
	error?: string;
	code?: IpcErrorCode;
}

export interface IpcOpenPathResult {
	ok: boolean;
	error?: string;
	/** Stable failure code for the renderer's localized message (shared/ipc-error-codes). */
	code?: IpcErrorCode;
}

export interface IpcFsReadPlanPayload {
	/** Visible tab whose workspace is an allowed root. */
	tabId?: string;
	/** Absolute path of the configured plan file. */
	fsPath: string;
	/** Session-local artifacts root for the newest-`*plan.md` fallback (plan under `local://`); null disables the fallback. */
	localRoot: string | null;
}

export interface IpcFsReadImagePayload {
	/** Visible tab whose workspace resolves relative paths. */
	tabId?: string;
	/**
	 * Image path from a markdown `![alt](src)` in model output. Relative paths
	 * resolve against the session workspace; absolute paths (and `~`) are read
	 * as-is — the bytes only ever reach a local <img>, so there is no exfil
	 * channel, but the file must sniff as a real image type.
	 */
	path: string;
}

export interface IpcFsReadImageResult {
	ok: boolean;
	/** `data:<mime>;base64,…` ready for <img src>. */
	dataUrl: string | null;
	mime: string | null;
	/** Total file size in bytes. */
	size: number;
	error?: string;
	/** Stable failure code for the renderer's localized message (shared/ipc-error-codes). */
	code?: IpcErrorCode;
}

export interface IpcFsReadBinaryPayload {
	/** Visible tab whose workspace resolves relative paths (and whose device serves the bytes). */
	tabId?: string;
	/** Workspace-relative path, or an absolute/~/ path; resolved like `fs.read`. */
	path: string;
	/**
	 * Prefix length for a partial view (the hex dump). Below the cap, a bigger
	 * file comes back `truncated` with this many bytes; omitted (or at/above
	 * the cap), a file over the cap fails with `file_too_large`.
	 */
	maxBytes?: number;
}

export interface IpcFsReadBinaryResult {
	ok: boolean;
	/** File bytes (structured-clone Uint8Array over IPC). Empty on failure. */
	data: Uint8Array;
	/** Sniffed/derived MIME (magic numbers first, then extension); "application/octet-stream" when unknown. */
	mime: string;
	/** Total file size in bytes. */
	size: number;
	/** File exceeded an explicit small `maxBytes`; data is a prefix (hex view only — media/pdf/office treat it as too large). */
	truncated: boolean;
	error?: string;
	/** Stable failure code for the renderer's localized message (shared/ipc-error-codes); `file_too_large` over the cap. */
	code?: IpcErrorCode;
}

export interface IpcFsMediaStreamPayload {
	/** Visible tab whose workspace resolves relative paths. */
	tabId?: string;
	/** Workspace-relative path, or an absolute/~/ path; resolved like `fs.readBinary`. */
	path: string;
}

/**
 * `url` streams the file with range requests until released. Fails `unsupported`
 * for anything that does not sniff as audio/video, and `remote_path_native` for
 * a paired host's tab, whose file the renderer reads with `readBinary` instead.
 */
export type IpcFsMediaStreamResult =
	| { ok: true; url: string; mime: string; size: number }
	| { ok: false; error: string; code?: IpcErrorCode };

export interface IpcFsReadPlanResult {
	ok: boolean;
	/** The file actually read (fsPath or the fallback pick); null when no plan file exists. */
	path: string | null;
	/** File content ("" for an empty file); null when no plan file exists. */
	content: string | null;
	error?: string;
	/** Stable failure code for the renderer's localized message (shared/ipc-error-codes). */
	code?: IpcErrorCode;
}

// ============================================================================
// Session Index Types
// ============================================================================

/**
 * Open a session (or a fresh project window) in a new parallel window.
 * `sessionPath` opens that specific session; `cwd` chooses the project for a
 * fresh window. Both optional — omit both for a fresh window in the caller's cwd.
 */
export interface IpcSessionOpenNewWindowPayload {
	sessionPath?: string;
	cwd?: string;
	/** Paired host deviceId the session/cwd lives on; absent = this device. */
	device?: string;
}

// ============================================================================
// Session Tab Types (in-window parallel sessions, one sidecar per tab)
// ============================================================================

/**
 * Tab chip status: the sidecar's connection status plus a main-synthesized
 * "running" (connection ready + agent run in flight, from the event stream).
 */
export type TabStatus = SidecarStatus | "running";

/**
 * Session kind: "agent" (a session in a project folder) or "chat" (the same
 * full agent outside any project, in the GUI's default workspace). Both run
 * omp's full tool set; the kind only decides where the session is listed.
 */
export type SessionKind = "agent" | "chat";

/**
 * A tab's git-worktree binding (tab × worktree, plan/20). Immutable, set at
 * spawn like `kind` (or, for `worktree.onStart`, before the tab's first
 * session reports ready); main-held so it survives renderer reloads. `name` is
 * the user-facing slug (chip label for untitled tabs), `branch` the created
 * omp/gui/<name> (or omp's wt/<timestamp>) ref, `baseCwd` the repo checkout the
 * worktree forked from, `path` the checkout itself — the one directory the
 * close prompt may remove (the tab's cwd follows session switches).
 */
export interface IpcTabWorktree {
	name: string;
	branch: string;
	baseCwd: string;
	path: string;
	/**
	 * Created by omp's `worktree.onStart` for this tab's fresh session during
	 * this launch (src/main/worktree-lifecycle.ts): closing the tab applies
	 * `worktree.onExit` instead of the close prompt. Never persisted; a restored
	 * tab is an ordinary worktree tab, as stock owns only the worktrees its own
	 * launch created.
	 */
	lifecycle?: true;
}

/**
 * A question omp's per-session worktree lifecycle needs answered
 * (src/main/worktree-lifecycle.ts). `start`: `worktree.onStart` = `ask` for a
 * new tab in `cwd`. `exit`: `worktree.onExit` asks before removing the
 * worktree a closed tab created; the flags are what removing it would lose.
 */
export type IpcWorktreePrompt =
	| { id: string; kind: "start"; cwd: string }
	| {
			id: string;
			kind: "exit";
			path: string;
			branch: string;
			/** Uncommitted or untracked changes. */
			dirty: boolean;
			/** The branch has new commits; it is kept either way. */
			moved: boolean;
			/** HEAD is not the branch tip, so commits only HEAD reaches are lost. */
			offBranch: boolean;
	  };

export interface IpcWorktreePromptAnswer {
	id: string;
	accept: boolean;
}

/** A lifecycle step that ended differently than planned. */
export type IpcWorktreeNotice =
	| { kind: "create-failed"; cwd: string; message: string }
	| { kind: "kept-changed"; path: string }
	/** The tab's omp did not exit in time, so it may still be writing into the worktree. */
	| { kind: "kept-running"; path: string }
	| { kind: "remove-failed"; path: string; message: string };

/** One tab of a window: its sidecar's cwd, last status, and cached session meta. */
export interface IpcTabInfo {
	/** Opaque snowflake id minted by main at acquire. */
	tabId: string;
	cwd: string;
	status: TabStatus;
	/** Present on GET_TABS for the tab main currently routes as active. */
	active?: boolean;
	/** Present on GET_TABS for the one or two tabs whose full stream is visible. */
	visible?: boolean;
	/** Restored split geometry for this visible tab. */
	split?: SplitLayout;
	/** GET_TABS: the remembered (off-screen) split this tab belongs to; one tab per split carries the same geometry. */
	rememberedSplit?: SplitLayout;
	/** True while automatic transcript compaction is mutating this session. */
	compacting?: boolean;
	/** Immutable session kind, fixed when the tab's sidecar was spawned. */
	kind: SessionKind;
	/** Disposable untargeted startup tab. Cleared permanently when its first run starts. */
	placeholder?: boolean;
	/** Present when the tab was spawned bound to a git worktree. */
	worktree?: IpcTabWorktree;
	/** Authoritative transcript attached to this tab, available before session_info_update; null clears it. */
	sessionPath?: string | null;
	/** Present once the tab's sidecar reported session_info_update. */
	sessionId?: string;
	/** Null explicitly clears the previous session's cached title. */
	title?: string | null;
	/** How the tab's last finished run ended; absent while a run is in flight or before the first one ends. */
	lastRun?: IpcTabRunOutcome;
	/** Paired host deviceId the tab's omp runs on; absent = this device. */
	device?: string;
	/** The tab's turn waits for the internet connection and continues once it is back (resume, src/main/turn-resume.ts). */
	awaitingConnection?: boolean;
}

/** A launch continued interrupted turns: the toast's text (worded by main) and its count. Its Stop calls `resume.stop`. */
export interface IpcResumeNotice {
	count: number;
	message: string;
	/** The Stop action's label. */
	stop: string;
}

/**
 * Outcome of a finished agent run, from its terminal agent_end (or the failed
 * auto_retry_end closing a retry saga). Rides TAB_STATUS so a background tab,
 * whose full event stream is not forwarded, can still be told apart: done,
 * failed, or aborted.
 */
export interface IpcTabRunOutcome {
	/** The last assistant message's stop reason ("stop", "error", "aborted", …). */
	stopReason: string;
	errorMessage?: string;
	/**
	 * The start of the last assistant reply's text (at most 4000 characters, sidecar-pool.ts), so
	 * a background tab's completion banner reads its opening prose like a visible tab's does.
	 */
	reply?: string;
}

/** TAB_STATUS push payload — a full tab snapshot from any tab, active or background. */
export type IpcTabStatusPayload = IpcTabInfo;

/** Full sidecar event tagged with the tab that emitted it. The preload drops
 * envelopes from a previously active tab after SET_ACTIVE_TAB resolves. */
export interface IpcActiveTabEnvelope<T> {
	tabId: string;
	payload: T;
}

/** Spawn a tab bound to the calling window. Defaults: caller's cwd, fresh session. */
export interface IpcSpawnTabPayload {
	cwd?: string;
	sessionPath?: string;
	/** Session kind for the new tab; omitted = "agent". Immutable once spawned.
	 * A chat tab always runs in the default workspace (its `cwd` is ignored). */
	kind?: SessionKind;
	/** Spawn a full agent in the GUI-owned default Work workspace. */
	defaultWorkspace?: boolean;
	/**
	 * Worktree binding minted by a prior worktree_create RPC: cwd is the
	 * worktree path and the tab carries the binding for chip rendering and
	 * the close-time cleanup prompt.
	 */
	worktree?: IpcTabWorktree;
	/** Paired host deviceId to run the tab on; absent = this device. */
	device?: string;
}

/** Owner of a session file: the tab (and its window) currently attached to it. */
export interface IpcSessionOwner {
	tabId: string;
	/** Owner window's webContents.id. */
	winId: number;
}

export interface IpcSpawnTabResult {
	/**
	 * Minted tab id. Null when the requested sessionPath is already attached
	 * to a tab — the renderer switches to/focuses the owner instead of
	 * spawning a second sidecar for the same file (F-OWN).
	 */
	tabId: string | null;
	/** Resolved cwd when main selected the default workspace (Work or chat tab). */
	cwd?: string;
	/** Present iff tabId is null: the tab/window owning the requested sessionPath. */
	ownerTabId?: string;
	ownerWinId?: number;
	/**
	 * Why the spawn was refused (tabId null). `owned` = the session file is
	 * already attached elsewhere (F-OWN); `kind-mismatch` = the requested kind
	 * disagrees with the target session file's stamped kind.
	 */
	refusal?: "owned" | "kind-mismatch";
}

/** Look up which tab/window owns a session file (F-OWN renderer belt-guards). */
export interface IpcGetSessionOwnerPayload {
	sessionPath: string;
	device?: string;
}

export interface IpcCloseTabPayload {
	tabId: string;
}

export interface IpcSetActiveTabPayload {
	tabId: string;
}

export interface IpcSetTabViewPayload {
	focusedTabId: string;
	visibleTabIds: string[];
	split?: SplitLayout;
	/**
	 * Splits remembered but not on screen. Absent = main keeps what it has
	 * (a plain focus switch); present (even empty) replaces it.
	 */
	rememberedSplits?: SplitLayout[];
}

export interface IpcSidecarRestartPayload {
	/** Omitted for manual active-tab restarts; plugin activation always supplies the origin tab. */
	tabId?: string;
	sessionPath?: string;
}

export interface SessionInfo {
	path: string;
	id: string;
	title: string | null;
	cwd: string;
	created: string;
	modified: string;
	messageCount: number;
	size: number;
	status: "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";
	/** Session kind read from the file header; absent = agent (legacy sessions). */
	kind?: "chat";
	firstMessage: string;
	/** Stock's `parentSessionPath`: the session this one was forked from (its file path, or its id). */
	parentSessionPath?: string;
	/** Paired host deviceId the session file lives on; absent = this device. */
	device?: string;
}

// ============================================================================
// Remote Devices Types
// ============================================================================

/** Link state of a paired host (A role). */
export type RemoteLinkState = "connecting" | "online" | "offline";

/** A paired host this device can run sessions on. */
export interface HostView {
	deviceId: string;
	name: string;
	state: RemoteLinkState;
	/** From the host's hello (`process.platform`); absent until the first connection. */
	platform?: string;
	/** Host home directory (folder picker start); absent until the first connection. */
	home?: string;
}

/** A client device paired with this computer (B role). */
export interface PeerView {
	deviceId: string;
	name: string;
	online: boolean;
	/** Epoch ms of the last live connection; null when it never connected after pairing. */
	lastSeenAt: number | null;
	/** Daily limits on this computer's models for the device; empty = unlimited. */
	limits: PeerLimits;
	/** What the device used today (local date). */
	usage: PeerUsageView;
}

/** Per-device daily model-use limits on a host (D65). An absent field has no limit. */
export interface PeerLimits {
	/** Model requests: prompts, steers, follow-ups, compactions, retries… */
	requestsPerDay?: number;
	tokensPerDay?: number;
}

export interface PeerUsageView {
	requests: number;
	tokens: number;
}

/** Host role of this computer. `port`/`code`/`expiresAt` are null while disabled. */
export interface RemoteHostState {
	enabled: boolean;
	name: string;
	port: number | null;
	/** `ip:port` LAN addresses. */
	addresses: string[];
	code: string | null;
	/** Epoch ms when `code` stops working. */
	expiresAt: number | null;
	peers: PeerView[];
	/** Keep this computer awake while a device uses it (prefs `remote.keepAwake`, default on). */
	keepAwake: boolean;
	/** The sleep blocker is held now: a device uses this computer, or did within the last minute. */
	keepingAwake: boolean;
	/** Names of paired devices connected now or with a turn still running here. */
	usedBy: string[];
}

export interface RemoteState {
	host: RemoteHostState;
	hosts: HostView[];
}

/** A host seen on the LAN by discovery. */
export interface RemoteDiscoveredDevice {
	deviceId: string;
	name: string;
	/** `ip:port`, ready for `remote.pair({address})`. */
	address: string;
	/** True when this device is already paired with it. */
	paired: boolean;
}

export interface RemoteDirEntry {
	name: string;
	/** Absolute path on the host. */
	path: string;
}

/** One directory level of a host's disk (remote folder picker). */
export interface RemoteDirListing {
	/** Absolute path listed (the host's home when none was asked). */
	path: string;
	/** Parent directory; null at a filesystem root. */
	parent: string | null;
	/** Subdirectories, sorted by name (only those matching the asked name filter). */
	entries: RemoteDirEntry[];
	/** More subdirectories matched than `entries` holds (the host's per-level bound); a filter narrows them. */
	truncated?: boolean;
}

export interface IpcRemotePairPayload {
	/** `host` or `host:port`. */
	address: string;
	code: string;
}

export interface IpcRemoteListDirsPayload {
	deviceId: string;
	path?: string;
	/** Only subdirectories whose name contains this (case-insensitive). */
	query?: string;
}

// ============================================================================
// Preload API Shape (what window.omp exposes)
// ============================================================================

export interface LogBatch {
	lines: string[];
	nextSequence: number;
}

/** Versions/environment: the feedback dialog attaches them to bug reports; Settings shows the device language. */
export interface SystemInfo {
	appVersion: string;
	platform: string;
	arch: string;
	/** Device language subtag (`ko`, `zh-Hant`) the agent replies in on `auto` (src/shared/reply-language.ts); null when unknown. */
	deviceLanguage: string | null;
	osRelease: string;
	electron: string;
	chrome: string;
	node: string;
}

export interface OmpApi {
	terminal: TerminalApi;
	preview: PreviewApi;
	/** Scheduled `omp -p` runs on this machine (Settings › Schedules). */
	schedules: SchedulesApi;
	/** OMPdesk's own ssh on this computer: port forwards, port watch, agent state, prompts (Settings › SSH). */
	sshTools: SshToolsApi;
	runtime: {
		/** Best-effort fire-and-forget reporting so fatal render paths never wait on IPC. */
		report(error: RuntimeErrorReport): void;
		logPath(): Promise<string>;
		logSnapshot(): Promise<LogBatch>;
		/** Last `maxLines` runtime-error lines for the feedback dialog's opt-in diagnostics. */
		logTail(maxLines: number): Promise<string[]>;
	};
	app: {
		/**
		 * Quit the whole app through the main-process guard, which confirms while
		 * any session is still working. `window.close()` is NOT a quit: it only
		 * shuts the focused window and leaves the rest of the session behind.
		 */
		quit(): void;
	};
	rpc: SessionRpcClient & {
		commandForTab(tabId: string, cmd: RpcCommand, timeoutMs?: number): Promise<RpcResponse>;
	};
	events: {
		onBatch(callback: (events: AgentSessionEvent[]) => void): () => void;
		onTabStatus(callback: (payload: IpcTabStatusPayload) => void): () => void;
		/** `resent`: a paired host's re-attach sent the request again (`IpcExtensionUiPayload.resent`). */
		onExtensionUi(
			callback: (request: ExtensionUIRequest, tabId: string, signIn?: IpcSignIn, resent?: boolean) => void,
		): () => void;
		/** A tab's provider sign-in finished while a reloaded page was showing it (`IpcSignIn.active`). */
		onSignInEnded(callback: (payload: IpcSignInEndedPayload) => void): () => void;
		onLiveFrame(callback: (frame: RpcLiveFrame) => void): () => void;
		onBtwFrame(callback: (frame: RpcBtwFrame) => void): () => void;
		onConfigUpdate(callback: (payload: ConfigUpdateFrame) => void): () => void;
		/** Full-stream variants keep the originating visible tab id. */
		onTabBatch(callback: (events: AgentSessionEvent[], tabId: string) => void): () => void;
		onTabSidecarStatus(callback: (status: IpcSidecarStatusPayload, tabId: string) => void): () => void;
		/** Called once per frame; a batch's frames are delivered in one task (one React commit). */
		onTabSubagentFrame(callback: (frame: SubagentFrame, tabId: string) => void): () => void;
		onTabModelCatalogUpdate(callback: (frame: ModelCatalogUpdateFrame, tabId: string) => void): () => void;
		onTabCommandsUpdate(callback: (commands: AvailableCommand[], tabId: string) => void): () => void;
		onTabConfigUpdate(callback: (payload: ConfigUpdateFrame, tabId: string) => void): () => void;
		onTabPromptResult(callback: (frame: PromptResultFrame, tabId: string) => void): () => void;
		onTabCommandOutput(callback: (frame: CommandOutputFrame, tabId: string) => void): () => void;
		onTabSessionInfoUpdate(callback: (frame: SessionInfoUpdateFrame, tabId: string) => void): () => void;
		onTabExtensionError(callback: (frame: ExtensionErrorFrame, tabId: string) => void): () => void;
		onSessionsChanged(callback: () => void): () => void;
		onLogBatch(callback: (batch: LogBatch) => void): () => void;
		onMenuAction(callback: (action: MenuAction, payload?: MenuActionPayload) => void): () => void;
		onDeepLink(callback: (link: DeepLinkPayload) => void): () => void;
		onNotificationClick(callback: (payload: NotificationClickPayload) => void): () => void;
		onUpdaterStatus(callback: (status: UpdateStatus) => void): () => void;
		/** Fires when gui-bridge compatibility warnings are pending; take them with `bridgeHealth.take()`. */
		onBridgeHealth(callback: () => void): () => void;
	};
	updater: {
		check(): Promise<UpdateStatus>;
		download(): Promise<UpdateStatus>;
		apply(): Promise<void>;
		getStatus(): Promise<UpdateStatus>;
		version(): Promise<string>;
		authInfo(): Promise<UpdateAuthInfo>;
		testAuth(token?: string): Promise<UpdateAuthTestResult>;
		saveAuth(token: string): Promise<UpdateAuthTestResult>;
		clearAuth(): Promise<UpdateAuthInfo>;
	};
	bridgeHealth: {
		/** Pending warnings; each is handed to one window only. */
		take(): Promise<BridgeHealthWarning[]>;
	};
	/** Turns that continue by themselves: after the connection returns, and after a relaunch. */
	resume: {
		/** Cancel one tab's wait for the connection; its failure shows as it would have. */
		cancelWait(tabId: string): Promise<void>;
		/** Stop every turn the last launch resumed. */
		stop(): Promise<void>;
		/** The window's `online`/`offline` event, for main's connectivity state. */
		reportOnline(online: boolean): void;
		/** The relaunch's "Continuing N interrupted tasks" notice, once; null when there is none. */
		takeNotice(): Promise<IpcResumeNotice | null>;
	};
	/** This machine's automatic setup; remote tabs never use it (their host sets itself up). */
	setup: {
		getState(): Promise<SetupState>;
		/** Retry `item` now (a required item retries every missing required item in order). Rejects an unknown id. */
		retry(item: SetupItemId): Promise<void>;
		/** Cancel the running install; false when nothing runs. */
		cancel(): Promise<boolean>;
		onState(callback: (state: SetupState) => void): () => void;
	};
	/** omp's automatic update on this computer (a paired host updates its own omp under its own pref). */
	ompUpdate: {
		getState(): Promise<OmpUpdateState>;
		/** Check npm and update omp now, whatever the pref says; progress arrives through `onState`. */
		now(): Promise<void>;
		onState(callback: (state: OmpUpdateState) => void): () => void;
		/** omp updated itself (one window only): show "omp updated to X". */
		onUpdated(callback: (notice: OmpUpdatedNotice) => void): () => void;
	};
	/** omp's automatic update on a paired host (`device`), driven by that host's own OmpUpdater: the same state the local row shows. */
	hostOmpUpdate: {
		get(device: string): Promise<OmpUpdateState>;
		/** Check and update the host's omp now, whatever its pref says; progress arrives through `onState`. */
		now(device: string): Promise<OmpUpdateState>;
		onState(callback: (update: IpcHostOmpUpdate) => void): () => void;
	};
	/** This machine's GitHub CLI sign-in; remote tabs never use it (their host signs in on its own). */
	githubAuth: {
		refresh(force?: boolean): Promise<GithubAuthState>;
		startLogin(): Promise<GithubAuthState>;
		openLogin(): Promise<GithubAuthState>;
		cancelLogin(): Promise<GithubAuthState>;
		logout(): Promise<GithubAuthState>;
		switchAccount(login: string): Promise<GithubAuthState>;
		fillIdentity(): Promise<GithubAuthState>;
		productStar(star: boolean): Promise<GithubStarState>;
		onState(callback: (state: GithubAuthState) => void): () => void;
	};
	ui: {
		/** Rejects with `remote_offline` when a paired host's tab cannot take the answer now: the card stays open. */
		respondExtensionUi(response: ExtensionUIResponse, tabId?: string): Promise<void>;
		/** The asks and approvals this window's tabs wait on: a page that reloaded missed the events that raised them. */
		openRequests(): Promise<IpcOpenExtensionRequest[]>;
	};
	sessions: {
		/** `device` = paired host deviceId; absent = this device. Remote results carry `device`. */
		list(scope: "local" | "global", device?: string): Promise<SessionInfo[]>;
		delete(sessionPath: string, device?: string): Promise<void>;
		rename(sessionPath: string, name: string, device?: string): Promise<void>;
		search(query: string, scope: "local" | "global", device?: string): Promise<SessionContentMatch[]>;
		/** Move a stored session to `cwd`; resolves with its new path. */
		move(sessionPath: string, cwd: string, device?: string): Promise<string>;
		/**
		 * Open a session (or a fresh project window) in a new parallel window.
		 * False when its sidecar cannot be created. When `sessionPath` is already attached to a tab,
		 * the owner window is focused instead of spawning (F-OWN) and the
		 * call resolves true — the session is foregrounded either way.
		 */
		openInNewWindow(payload: IpcSessionOpenNewWindowPayload): Promise<boolean>;
		/** One-shot: the session this window was opened to display, if any. */
		consumePendingOpen(): Promise<string | null>;
	};
	tabs: {
		/** The calling window's tabs in acquisition order (boot reconciliation). */
		list(): Promise<IpcTabInfo[]>;
		/**
		 * Spawn a background tab bound to this window. Null when its sidecar cannot be created.
		 * When `sessionPath` is already attached to a tab, resolves with
		 * `{ tabId: null, ownerTabId, ownerWinId }` instead of spawning (F-OWN).
		 */
		spawn(payload: IpcSpawnTabPayload): Promise<IpcSpawnTabResult | null>;
		/** Release a tab's sidecar. False when the tab is unknown or foreign. */
		close(tabId: string): Promise<boolean>;
		/** Move full event forwarding to this tab. False when unknown or foreign. */
		setActive(tabId: string): Promise<boolean>;
		/** Set the focused tab plus up to four tabs rendered by the window. */
		setView(
			focusedTabId: string,
			visibleTabIds: string[],
			split?: IpcSetTabViewPayload["split"],
			rememberedSplits?: IpcSetTabViewPayload["rememberedSplits"],
		): Promise<boolean>;
		/** Put the window's tabs in this order (every tab id once). */
		reorder(tabIds: string[]): Promise<boolean>;
		/** The tab/window currently attached to a session file on `device` (absent = this device), if any (F-OWN). */
		getSessionOwner(sessionPath: string, device?: string): Promise<IpcSessionOwner | null>;
	};
	remote: {
		getState(): Promise<RemoteState>;
		setHostEnabled(enabled: boolean): Promise<RemoteState>;
		setDeviceName(name: string): Promise<RemoteState>;
		setKeepAwake(enabled: boolean): Promise<RemoteState>;
		rotateCode(): Promise<RemoteState>;
		revokePeer(deviceId: string): Promise<RemoteState>;
		/** Daily model-use limits for a paired device; `{}` removes them. */
		setPeerLimits(deviceId: string, limits: PeerLimits): Promise<RemoteState>;
		/** Start or stop LAN discovery; resolves with the devices seen so far (empty on stop). */
		discover(action: "start" | "stop"): Promise<RemoteDiscoveredDevice[]>;
		/** Throws IpcError `remote_wrong_code|remote_expired|remote_locked|remote_unreachable|remote_protocol`. */
		pair(payload: IpcRemotePairPayload): Promise<HostView>;
		removeHost(deviceId: string): Promise<RemoteState>;
		/** One directory level on the host; `path` absent = the host's home, `query` filters by name. */
		listDirs(deviceId: string, path?: string, query?: string): Promise<RemoteDirListing>;
		onState(callback: (state: RemoteState) => void): () => void;
		onDiscovered(callback: (devices: RemoteDiscoveredDevice[]) => void): () => void;
	};
	stats: {
		/** `device` = the paired host whose stats server answers; absent = this device. */
		fetch(path: string, params?: Record<string, string>, device?: string): Promise<unknown>;
	};
	bench: {
		/** `omp bench` on `device` (the paired host; absent = this device), one per window. */
		run(options: IpcBenchmarkRunOptions, device?: string): Promise<IpcBenchmarkRunResult>;
		abort(device?: string): Promise<boolean>;
	};
	modelSetup: {
		/** The model setup research on `device` (the paired host; absent = this device), one per window. */
		run(request: ModelSetupRequest, device?: string): Promise<IpcModelSetupRunResult>;
		status(device?: string): Promise<ModelSetupStatus>;
		abort(device?: string): Promise<boolean>;
	};
	system: {
		info(): Promise<SystemInfo>;
		openExternal(url: string): Promise<void>;
		/**
		 * Open a file in the system editor; relative paths resolve against the
		 * workspace of `tabId` (default: the active tab). A tab on a paired host
		 * fails with code `remote_path_native`.
		 */
		openPath(path: string, tabId?: string): Promise<IpcOpenPathResult>;
		/** Reveal a path in the file manager (relative paths resolve like `openPath`); fails when the file is missing, or `remote_path_native` for a paired host's tab. */
		revealPath(path: string, tabId?: string): Promise<IpcOpenPathResult>;
		showSaveDialog(defaultPath?: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null>;
		/** Save dialog, then write the image (`data` base64) there; `saved` is false when the user cancelled. */
		saveImage(defaultName: string, mimeType: string, data: string): Promise<{ saved: boolean; error?: string }>;
		showOpenDialog(
			filters?: { name: string; extensions: string[] }[],
			options?: { directory?: boolean; title?: string; buttonLabel?: string },
		): Promise<string[] | null>;
		notify(title: string, body?: string, tabId?: string): void;
	};
	prefs: {
		get(key?: string): Promise<unknown>;
		set(key: string, value: unknown): Promise<void>;
		/** `device` = the paired host whose profile it is; absent = this device. */
		getLaunchProfile(cwd: string, device?: string): Promise<LaunchProfile>;
		updateLaunchProfile(cwd: string, patch: Partial<LaunchProfile>, device?: string): Promise<LaunchProfile>;
	};
	sidecar: {
		restart(payload?: IpcSidecarRestartPayload): Promise<void>;
		selectProject(): Promise<string | null>;
		setProject(cwd: string): Promise<boolean>;
		defaultWorkspace(): Promise<string>;
		getStatus(): Promise<IpcSidecarStatusPayload>;
	};
	tray: {
		pushState(state: TrayState): void;
	};
	progress: {
		set(state: RunProgressState): void;
	};
	windowChrome: {
		/** Windows: recolor the native caption buttons drawn over the title bar. No-op elsewhere. */
		setColors(colors: WindowChromeColors): void;
	};
	/** The agent's models.yml on `device` (a paired host; absent = this device). */
	models: {
		listProviders(device?: string): Promise<CustomProvidersConfig>;
		upsertProvider(input: CustomProviderInput, device?: string): Promise<void>;
		deleteProvider(id: string, device?: string): Promise<void>;
		/** Write (or with `null`, remove) one model's `modelOverrides` entry under `provider` (B43). */
		setModelOverride(
			provider: string,
			modelId: string,
			override: ModelOverrideInput | null,
			device?: string,
		): Promise<void>;
		/** Opens this device's file only; a paired host's fails with code `remote_path_native`. */
		openConfig(device?: string): Promise<{ path: string; opened: boolean }>;
	};
	/** How omp spreads sessions over a provider's accounts on `device` (a paired host; absent = this device). */
	accountRotation: {
		get(device?: string): Promise<AccountRotationState>;
		set(mode: AccountRotationMode, device?: string): Promise<AccountRotationState>;
	};
	/** OMPdesk's built-in MCP preference of the machine that runs the focused session. */
	builtinRea: {
		get(device?: string): Promise<BuiltinReaState>;
		set(enabled: boolean, device?: string): Promise<BuiltinReaState>;
	};
	/** OMPdesk on a paired host (`device`), or this computer when absent. */
	hostDesktop: {
		get(device?: string): Promise<HostDesktopState>;
		/** Throws IpcError `host_busy|update_not_ready` for an install the host refuses. */
		update(action: HostUpdateAction, device?: string): Promise<HostDesktopState>;
	};
	fs: {
		list(path?: string, maxDepth?: number, maxEntries?: number, tabId?: string): Promise<IpcFsListResult>;
		read(path: string, maxBytes?: number, tabId?: string): Promise<IpcFsReadResult>;
		stat(path: string, tabId?: string): Promise<IpcFsStatResult>;
		mutate(mutation: IpcFsMutation, tabId?: string): Promise<IpcFsMutateResult>;
		search(request: IpcFsSearchRequest, tabId?: string): Promise<IpcFsSearchResult>;
		readPlan(payload: IpcFsReadPlanPayload): Promise<IpcFsReadPlanResult>;
		readImage(path: string, tabId?: string): Promise<IpcFsReadImageResult>;
		/** File bytes for the viewer: 100 MB cap on this device, 11 MB for a paired host's tab. */
		readBinary(path: string, maxBytes?: number, tabId?: string): Promise<IpcFsReadBinaryResult>;
		/** A seekable `omp-media://` URL for a local tab's audio/video file; release it when done. */
		mediaStream(path: string, tabId?: string): Promise<IpcFsMediaStreamResult>;
		releaseMediaStream(url: string): void;
		/** This machine's absolute path of a dropped, pasted or picked `File` (Electron `webUtils.getPathForFile`); "" when it has none. */
		pathForFile(file: File): string;
	};
	editor: {
		openExternal(content: string): Promise<{
			ok: boolean;
			unavailable: boolean;
			text: string | null;
			error?: string;
			/** Stable failure code for the renderer's localized message (shared/ipc-error-codes). */
			code?: IpcErrorCode;
		}>;
	};
	/** omp's per-session worktree lifecycle (`worktree.onStart` / `worktree.onExit`, omp 18.8.6+). */
	worktreeLifecycle: {
		/** This window's open questions, oldest first. */
		prompts(): Promise<IpcWorktreePrompt[]>;
		answer(id: string, accept: boolean): Promise<void>;
		onPrompts(callback: (prompts: IpcWorktreePrompt[]) => void): () => void;
		onNotice(callback: (notice: IpcWorktreeNotice) => void): () => void;
	};
}
