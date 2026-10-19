/**
 * Registers all IPC handlers and wires sidecar events to renderer windows.
 *
 * A tab on a paired host (`device`) runs its omp there, so every handler
 * that reads or writes the machine running omp — sessions, workspace files,
 * launch profiles, project switches, and the models.yml providers, stats and
 * benchmarks Settings/Usage/Stats show (machine-services.ts) — goes to that
 * host through RemoteDevices. Native open/reveal of a host path is refused
 * (`remote_path_native`): this machine cannot see that disk.
 */
import { existsSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, clipboard, dialog, type Notification, screen, shell } from "electron";
import Store from "electron-store";
import { AUTO_TITLE_EVOLVE_PREF, AUTO_TITLE_PREF } from "../../resources/gui-bridge/modes/auto-title-contracts";
import {
	AUTOPILOT_BRANCH_PREF,
	AUTOPILOT_NOTIFY_PREF,
	AUTOPILOT_SHIP_PREF,
} from "../../resources/gui-bridge/modes/autopilot-contracts";
import { DELEGATION_PREF, isDelegationMode } from "../../resources/gui-bridge/modes/delegation-contracts";
import { NEXT_PROMPT_INLINE_PREF, NEXT_PROMPT_PREF } from "../../resources/gui-bridge/modes/next-prompt-contracts";
import { isUserProfile, USER_PROFILE_PREF } from "../../resources/gui-bridge/modes/user-profile-contracts";
import {
	localizePromptOrigins,
	PROMPT_ORIGIN_HOST_ID,
	type PromptOrigin,
	type PromptOriginLabel,
} from "../../resources/gui-bridge/prompt-origin-contracts";
import { ACCOUNT_ROTATION_PREF, isAccountRotationMode } from "../shared/account-rotation";
import { AGENT_CONTROL_PREF, isAgentControlTool, parseAgentMessage } from "../shared/agent-control";
import { REA_PREF } from "../shared/builtin-mcp";
import { BATCH_NOTIFICATIONS_PREF } from "../shared/desktop-prefs";
import { codedError, type IpcErrorCode, ipcErrorCode } from "../shared/ipc-error-codes";
import type {
	CustomProviderInput,
	IpcBenchmarkRunOptions,
	IpcBenchmarkRunResult,
	IpcCloseTabPayload,
	IpcExtensionUiRespondPayload,
	IpcFsListPayload,
	IpcFsListResult,
	IpcFsMediaStreamPayload,
	IpcFsMediaStreamResult,
	IpcFsMutateResult,
	IpcFsMutation,
	IpcFsReadBinaryPayload,
	IpcFsReadBinaryResult,
	IpcFsReadImagePayload,
	IpcFsReadImageResult,
	IpcFsReadPayload,
	IpcFsReadPlanPayload,
	IpcFsReadPlanResult,
	IpcFsReadResult,
	IpcFsSearchResult,
	IpcFsStatResult,
	IpcGetLaunchProfilePayload,
	IpcGetSessionOwnerPayload,
	IpcModelSetupRunResult,
	IpcNotifyPayload,
	IpcOpenPathResult,
	IpcPrefsChangedPayload,
	IpcPrefsGetPayload,
	IpcPrefsSetPayload,
	IpcRemoteListDirsPayload,
	IpcRpcCommandForTabPayload,
	IpcRpcCommandPayload,
	IpcSessionOpenNewWindowPayload,
	IpcSessionOwner,
	IpcSessionsDeletePayload,
	IpcSessionsListPayload,
	IpcSessionsMovePayload,
	IpcSessionsRenamePayload,
	IpcSessionsSearchPayload,
	IpcSetActiveTabPayload,
	IpcSetTabViewPayload,
	IpcSidecarRestartPayload,
	IpcSpawnTabPayload,
	IpcStatsFetchPayload,
	IpcUpdateLaunchProfilePayload,
	IpcWorktreePromptAnswer,
	NotificationClickPayload,
	SessionContentMatch,
	SessionInfo,
	SessionKind,
} from "../shared/ipc-types";
import { IPC_COMMANDS, IPC_EVENTS, type RunProgressState, type TrayState } from "../shared/ipc-types";
import type { ModelSetupRequest } from "../shared/model-setup";
import { PREVIEW_VISUAL, type PreviewVisualEvent } from "../shared/preview";
import { isReplyLanguagePref, REPLY_LANGUAGE_PREF } from "../shared/reply-language";
import type { RpcCommand, RpcResponse, RpcSessionState } from "../shared/rpc-types";
import { isUiLanguage } from "../shared/ui-language";
import { AgentControlRuntime } from "./agent-control/host";
import { appNotification } from "./app-icon";
import { requestQuit } from "./app-quit";
import { Autopilot, type AutopilotCommand, validAutopilotPref } from "./autopilot";
import { readBranchFacts } from "./autopilot-branches";
import { ensureDefaultWorkspace } from "./default-workspace";
import { DesktopSlotHost } from "./desktop-slot-host";
import { openInExternalEditor } from "./editor";
import { isOpenableExternalUrl } from "./external-url";
import { getMainLanguage, mainT } from "./i18n";
import type { MainTextKey } from "./i18n-text";
import { type LaunchProfilePrefs, readLaunchProfile, updateLaunchProfile } from "./launch-profile-store";
import { readProjectOrigin } from "./local/git/origin";
import { renameStoredSession } from "./local/session-files";
import type { LogWatcher } from "./log-watcher";
import { type LocalMachine, type MachineServices, machineFor as pickMachine } from "./machine-services";
import type { MediaStreams } from "./media-stream";
import { createMenu } from "./menu";
import { modelsPath } from "./models-config";
import { NotificationBatcher, type ShownNotice } from "./notification-batch";
import { systemOmp } from "./omp-runtime";
import { openLocalPath } from "./open-path";
import { registerPreviewHost } from "./preview/host";
import { runVisualizeTool, VISUALIZE_TOOL, VisualStore } from "./preview/visuals";
import { decodeBinaryRead, HOST_FS_READ_BINARY_TIMEOUT_MS, ModelOverrideInputSchema } from "./remote/app-protocol";
import type { RemoteDevices } from "./remote/devices";
import type { LocalHostServices } from "./remote/host-services";
import { runtimeLogPath, writeRuntimeLog } from "./runtime-log";
import { tailLogLines } from "./runtime-log-core";
import type { ScheduleService } from "./schedules";
import type { SessionIndex } from "./session-index";
import { deleteSession, moveSession, renameSession } from "./session-mutations";
import { resolveEditorCommand, shellSpawnEnv } from "./shell-env";
import { deviceLanguage } from "./sidecar-factory";
import type { SidecarPool } from "./sidecar-pool";
import type { SidecarLike } from "./sidecar-types";
import { registerSshToolsIpc } from "./ssh/ipc";
import { markStartupFromRenderer } from "./startup-timing";
import { stockHelperRequest } from "./stock-helper";
import { spawnTabForWindow } from "./tab-spawn";
import { formatTerminalRead, TERMINAL_READ_TOOL } from "./terminal/agent-tool";
import { closeTabTerminals, readTabTerminals, registerTerminalIpc } from "./terminal/ipc";
import { setTrayState } from "./tray";
import { aggregateTrayStatus } from "./tray-labels";
import { type RelaunchContinuation, STOP_COMMANDS, TOUCH_COMMANDS } from "./turn-resume";
import { appVersion } from "./updater";
import type { ClientWindow } from "./web/client-window";
import type { IpcCaller, IpcRegistry } from "./web/ipc-registry";
import { writeDialogPreload } from "./web/preview-dialog";
import type { SpawnWindow, WindowManager } from "./window";
import { sanitizeChromeColors, TOP_BAR_HEIGHT } from "./window-chrome";
import {
	listWorkspace,
	mutateWorkspace,
	readPlanFile,
	readWorkspaceBinary,
	readWorkspaceFile,
	readWorkspaceImage,
	resolveWithin,
	resolveWorkspaceMedia,
	statWorkspacePath,
} from "./workspace-fs";
import { searchWorkspace } from "./workspace-search";
import { readLiveLifecycleSettings, type WorktreeLifecycle, type WorktreePrompts } from "./worktree-lifecycle";

/** The caller `ompdesk_app` hands a handler: the calling session's window, no native browser window. */
function agentCaller(win: ClientWindow): IpcCaller {
	return { win, browserWindow: null, sender: { id: win.webContents.id, once: () => undefined } };
}

export interface IpcDeps {
	/** Where every handler here registers (index.ts's one table). */
	ipc: IpcRegistry;
	sidecarPool: SidecarPool;
	sessionIndex: SessionIndex;
	/** This computer's models.yml, stats server and `omp bench`; a paired host serves its own. */
	machine: LocalMachine;
	logWatcher: LogWatcher;
	windowManager: WindowManager;
	/** Both remote roles: the paired hosts tabs may run on, and this computer as a host. */
	remoteDevices: RemoteDevices;
	/**
	 * The tabs this computer runs for paired devices (LocalHostServices): this computer's windows list their
	 * sessions (`HOSTED_SESSIONS`) and open one as a view of that tab, never as a second omp on its file.
	 */
	hostedTabs: Pick<LocalHostServices, "viewSession" | "hostedSessions" | "onHostedSessionsChange">;
	/** Spawn a window with its own sidecar (index.ts's pool-backed helper). */
	spawnWindow: SpawnWindow;
	/** Where to start when the caller has no cwd. Never the volume root: a
	 * Finder-launched app's `process.cwd()` is "/", which no session belongs in. */
	initialCwd: () => string;
	/** omp's `worktree.onStart` / `worktree.onExit` for this machine's tabs. */
	worktreeLifecycle: WorktreeLifecycle;
	/** The questions it asks in the windows. */
	worktreePrompts: WorktreePrompts;
	/** `omp-media://` URLs handed to players (registered as a protocol in index.ts). */
	mediaStreams: MediaStreams;
	/** A preference was written through PREFS_SET (main-side effects such as keep-awake). */
	onPrefChanged?: (key: string) => void;
	/** The Schedules service, created later than the handlers: read per use. */
	schedules?: () => Pick<ScheduleService, "state" | "command"> | null;
	/**
	 * Who typed a prompt, for the tabs several windows show (bridge prompt-origin.ts): `of` is the paired
	 * device a window belongs to (null for a desktop window, whose prompts are the host's own), `hostName`
	 * what a window that is not the host's calls it.
	 */
	promptOrigins?: { of(win: ClientWindow): PromptOrigin | null; hostName(): string };
	/** Autopilot's coordinator, built in `registerIpcHandlers` (it needs the RPC dispatcher) and published here for the sidecar factory and TurnResume. */
	autopilotRef: { current: Autopilot | null };
	/** The desktop slot's host, built in `registerIpcHandlers` (it needs the pool) and published here for the sidecar factory. */
	desktopSlotRef: { current: DesktopSlotHost | null };
	/** How a tab whose omp came up with an autopilot run `running` goes on (TurnResume's `relaunchContinuation`). */
	relaunchContinuation: (tabId: string) => RelaunchContinuation;
}

/**
 * Resolve the sidecar that owns the calling window. Routing derives from
 * the caller (Electron's `event.sender`, which Electron guarantees is the
 * caller's webContents), never from a client-supplied id. Null when the
 * window has no sidecar bound yet.
 */
function sidecarFor(deps: IpcDeps, caller: IpcCaller): SidecarLike | null {
	const win = caller.win;
	if (!win) return null;
	return deps.sidecarPool.sidecarForWindow(win);
}

/** The tab a handler acts on — `tabId`, else the calling window's active tab — with its device. */
function targetFor(deps: IpcDeps, caller: IpcCaller, tabId?: string) {
	const win = caller.win;
	return win ? deps.sidecarPool.tabTarget(win, typeof tabId === "string" ? tabId : undefined) : null;
}

/**
 * The calling window's working directory on THIS machine — the bound local
 * tab's cwd when one exists, else the cwd the window was created with (before
 * its sidecar binds, or while its active tab runs on a paired host).
 */
function cwdFor(deps: IpcDeps, caller: IpcCaller, tabId?: string): string | null {
	const win = caller.win;
	if (!win) return null;
	const target = deps.sidecarPool.tabTarget(win, tabId);
	if (tabId) return target && !target.device ? target.sidecar.cwd : null;
	if (target && !target.device) return target.sidecar.cwd;
	return deps.windowManager.recordFor(win)?.cwd ?? null;
}

/** The caller's cwd when its active tab runs on `device` (undefined = this machine), else null. */
function cwdOnDevice(deps: IpcDeps, caller: IpcCaller, device: string | undefined): string | null {
	if (!device) return cwdFor(deps, caller);
	const target = targetFor(deps, caller);
	return target?.device === device ? target.sidecar.cwd : null;
}

/**
 * The existing local file behind a path from a tool card or reply: "~"
 * expands, relative paths resolve inside the calling tab's workspace (escapes
 * refused), absolute paths pass through (the agent can legitimately touch
 * files outside it). A paired host's path means nothing here
 * (`remote_path_native`; the renderer falls back to the forwarded preview),
 * and a missing file fails loudly, since both shell calls fail silently.
 */
async function existingLocalPath(
	deps: IpcDeps,
	caller: IpcCaller,
	target: unknown,
	tabId?: string,
): Promise<{ ok: true; path: string } | IpcOpenPathResult> {
	if (targetFor(deps, caller, tabId)?.device) {
		return { ok: false, error: "The file is on another device", code: "remote_path_native" };
	}
	if (typeof target !== "string" || !target.trim()) return { ok: false, error: "Empty path", code: "empty_path" };
	let resolved = target.startsWith("~/") ? path.join(os.homedir(), target.slice(2)) : target;
	if (!path.isAbsolute(resolved)) {
		const rootAbs = cwdFor(deps, caller, tabId);
		if (!rootAbs) return { ok: false, error: "No workspace", code: "no_workspace" };
		const within = resolveWithin(rootAbs, resolved);
		if (!within) return { ok: false, error: "Path escapes the workspace", code: "path_escapes_workspace" };
		resolved = within;
	}
	try {
		await fsp.access(resolved);
	} catch {
		return { ok: false, error: "File not found", code: "file_not_found" };
	}
	return { ok: true, path: resolved };
}

/** A payload's paired-host deviceId; anything else means this machine. */
function deviceOf(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

/** The benchmark slot of a window on this machine (paired devices on a host use `peer:<id>`). */
function benchCaller(webContentsId: number): string {
	return `window:${webContentsId}`;
}

interface PrefsSchema {
	[key: string]: unknown;
}

// Dedupe state for SYSTEM_NOTIFY across multiple windows (see the handler).
let lastNotifyKey = "";
let lastNotifyAt = 0;
/** The first-run credential check is only worth it while it beats omp's boot; past this it says "cannot tell". */
const SIGNED_IN_TIMEOUT_MS = 10_000;
/** Shown notifications that switch to a tab on click, kept alive until then. */
const liveNotifications = new Set<Notification>();
/** Windows whose close already cancels their pending notification summary. */
const notifyBatchedWindows = new Set<number>();

/** One OS notification; one about a tab switches to it on click. */
function showNotification(windowId: number, notice: ShownNotice): { close: () => void } {
	const win = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.id === windowId);
	const notification = appNotification({ title: notice.title, body: notice.body });
	const { tabId } = notice;
	if (win && tabId) {
		// Held until clicked or dismissed: a collected Notification drops its click.
		liveNotifications.add(notification);
		const release = () => liveNotifications.delete(notification);
		notification.on("close", release);
		notification.on("click", () => {
			release();
			if (win.isDestroyed()) return;
			if (win.isMinimized()) win.restore();
			win.show();
			win.focus();
			win.webContents.send(IPC_EVENTS.NOTIFICATION_CLICK, { tabId } satisfies NotificationClickPayload);
		});
	}
	notification.show();
	return { close: () => notification.close() };
}

const notificationBatcher = new NotificationBatcher({
	show: showNotification,
	language: () => getMainLanguage(),
	setTimer: (fn, ms) => setTimeout(fn, ms).unref(),
	clearTimer: handle => clearTimeout(handle as NodeJS.Timeout),
});
app.once("will-quit", () => notificationBatcher.dispose());

// Per-window tray/progress snapshots, aggregated for the app-global tray/dock.
const trayStates = new Map<number, TrayState>();
const progressStates = new Map<number, RunProgressState>();

/** Collapse per-window run-progress to one: any working > waiting > idle. */
function aggregateProgress(states: RunProgressState[]): RunProgressState {
	if (states.some(s => s === "working")) return "working";
	if (states.some(s => s === "waiting")) return "waiting";
	return "idle";
}

export function registerIpcHandlers(deps: IpcDeps): void {
	const { ipc } = deps;
	registerTerminalIpc(ipc, deps.sidecarPool, deps.remoteDevices);
	registerSshToolsIpc(ipc);
	const visuals = new VisualStore(path.join(app.getPath("userData"), "visuals"));
	let dialogPreload: string | null = null;
	const visualPages = registerPreviewHost(
		ipc,
		(senderId, tabId) => {
			const win = BrowserWindow.getAllWindows().find(window => window.webContents.id === senderId);
			const target = win ? deps.sidecarPool.tabTarget(win, tabId) : null;
			// A named tab this window does not own counts as remote: agent browsing refuses it.
			return tabId ? !target || Boolean(target.device) : Boolean(target?.device);
		},
		visuals,
		{
			// A paired phone's preview (main/web/preview-stream.ts): its tab may be a paired host's, like a window's.
			isRemote: (win, tabId) => {
				const target = deps.sidecarPool.tabTarget(win, tabId);
				return tabId ? !target || Boolean(target.device) : Boolean(target?.device);
			},
			hostScale: () => screen.getPrimaryDisplay().scaleFactor,
			preloadPath: () => (dialogPreload ??= writeDialogPreload(app.getPath("userData"))),
		},
	);
	/** The paired host a window's running benchmark is on, so closing the window stops it there. */
	const remoteBenchmarks = new Map<number, string>();
	/** The same for a window's model setup research. */
	const remoteModelSetups = new Map<number, string>();
	const { sidecarPool, sessionIndex, logWatcher, windowManager, remoteDevices } = deps;
	const prefsStore = new Store<PrefsSchema>({ name: "prefs" });
	const remoteMachine = { request: remoteDevices.request.bind(remoteDevices), statsText: mainT };
	/**
	 * Delete a stored session (the sidebar, `/delete`, the control tools): the tab holding it closes. One a paired
	 * device's tab on this computer runs is refused, as the host refuses a device the other's live tab.
	 */
	const deleteStoredSession = async (sessionPath: string, device: string | undefined): Promise<void> => {
		const usedByDevice =
			deps.hostedTabs.hostedSessions().some(session => session.sessionPath === sessionPath) ||
			sidecarPool.deviceViewing(sessionPath);
		if (!device && usedByDevice) throw codedError("session_running", "A paired device is using this session");
		await deleteSession(sidecarPool, sessionPath, device, () =>
			device
				? remoteDevices.request(device, "sessions.delete", { sessionPath })
				: sessionIndex.deleteSession(sessionPath),
		);
	};

	/**
	 * The machine a Settings/Usage/Stats call acts on: `device` is the paired
	 * host the caller's focused tab runs on (absent = this computer). A
	 * benchmark there roots at that tab's folder when it is the window's tab.
	 */
	const machineFor = (caller: IpcCaller, device: unknown): MachineServices => {
		const id = deviceOf(device);
		const target = id ? targetFor(deps, caller) : null;
		return pickMachine(id, deps.machine, {
			...remoteMachine,
			...(target && target.device === id ? { tab: { rtab: target.tabId, cwd: target.sidecar.cwd } } : {}),
		});
	};

	// Drop a closed window's tray/progress snapshot so the aggregate reflects
	// only live windows (and re-render the tray with the new aggregate).
	windowManager.subscribeWindowClosed(record => {
		trayStates.delete(record.id);
		progressStates.delete(record.id);
		const caller = benchCaller(record.id);
		void deps.machine.abortBenchmark(caller);
		const device = remoteBenchmarks.get(record.id);
		remoteBenchmarks.delete(record.id);
		if (device)
			void pickMachine(device, deps.machine, remoteMachine)
				.abortBenchmark(caller)
				.catch(() => false);
		void deps.machine.abortModelSetup(caller);
		const setupDevice = remoteModelSetups.get(record.id);
		remoteModelSetups.delete(record.id);
		if (setupDevice)
			void pickMachine(setupDevice, deps.machine, remoteMachine)
				.abortModelSetup(caller)
				.catch(() => false);
	});

	// Sidecar → owning-window event forwarding is wired by SidecarPool at
	// acquire time. GUI host tools need Electron, so the pool calls this
	// executor (set once at startup); unknown tools fail with stock's wording.
	sidecarPool.hostToolExecutor = (sidecar, request, tab) => {
		const reply = (text: string, isError: boolean) =>
			sidecar.sendSideChannel({
				type: "host_tool_result",
				id: request.id,
				result: textToolResult(text),
				...(isError ? { isError: true } : {}),
			});
		if (request.toolName === TERMINAL_READ_TOOL) {
			const target = {
				tabId: tab.tabId,
				webContentsId: tab.win.webContents.id,
				cwd: sidecar.cwd,
				device: sidecar.device,
			};
			void readTabTerminals(remoteDevices, target).then(
				snapshots => reply(formatTerminalRead(snapshots, request.arguments), false),
				error =>
					reply(`Couldn't read the terminals: ${error instanceof Error ? error.message : String(error)}`, true),
			);
			return;
		}
		if (request.toolName === VISUALIZE_TOOL) {
			// The files a visual shows are on this computer; a paired host's tab has its own folder there.
			if (sidecar.device) {
				reply("gui_visualize shows visuals only for tabs on the user's own computer.", true);
				return;
			}
			const context = {
				tabId: tab.tabId,
				cwd: sidecar.cwd,
				store: visuals,
				pages: visualPages,
				reveal: (visualId: string) => {
					if (!tab.win.isDestroyed())
						tab.win.webContents.send(PREVIEW_VISUAL, { tabId: tab.tabId, visualId } satisfies PreviewVisualEvent);
				},
			};
			void runVisualizeTool(context, request.arguments).then(result => reply(result.text, result.isError));
			return;
		}
		if (isAgentControlTool(request.toolName)) {
			void agentControl
				.run(tab.win, tab.tabId, request.toolName, request.arguments)
				.then(outcome => reply(outcome.text, outcome.isError));
			return;
		}
		const result = executeGuiHostTool(request.toolName, request.arguments);
		reply(result ?? `Host tool "${request.toolName}" is not registered`, result === undefined);
	};

	// Session index changes: this window set, and every device using this
	// computer as its host.
	sessionIndex.onChange = () => {
		broadcast(windowManager, IPC_EVENTS.SESSIONS_CHANGED, undefined);
		remoteDevices.hostSessionsChanged();
	};
	// The sessions this computer runs for paired devices are every window's sidebar rows too.
	deps.hostedTabs.onHostedSessionsChange(() =>
		broadcast(windowManager, IPC_EVENTS.HOSTED_SESSIONS_CHANGED, deps.hostedTabs.hostedSessions()),
	);

	// Host-level lookups on a paired host, shared by spawn/open/switch paths.
	const remoteKindFor = (device: string, sessionPath: string) =>
		remoteDevices.request<SessionKind>(device, "sessions.kindFor", { sessionPath });
	const remoteDefaultWorkspace = (device: string) => remoteDevices.request<string>(device, "workspace.default", {});

	// Log lines (batched by LogWatcher)
	logWatcher.onLines = lines => {
		broadcast(windowManager, IPC_EVENTS.LOG_LINE, { lines, nextSequence: logWatcher.getSnapshot().nextSequence });
	};

	// ========================================================================
	// IPC Command Handlers
	// ========================================================================
	ipc.on(IPC_COMMANDS.RUNTIME_ERROR_REPORT, (caller, report: unknown) => {
		const win = caller.win;
		writeRuntimeLog(report, {
			windowId: win?.webContents.id,
			cwd: win ? windowManager.recordFor(win)?.cwd : undefined,
		});
	});
	ipc.on(IPC_COMMANDS.RUNTIME_STARTUP_MARK, (_caller, mark: unknown) => markStartupFromRenderer(mark));

	ipc.handle(IPC_COMMANDS.RUNTIME_LOG_PATH, () => runtimeLogPath());
	// Feedback dialog: last few runtime-error lines for the opt-in diagnostics
	// block. Tail-read so a large log doesn't have to be parsed end to end.
	ipc.handle(IPC_COMMANDS.RUNTIME_LOG_TAIL, async (_caller, maxLines: unknown) => {
		const limit = typeof maxLines === "number" && maxLines > 0 ? Math.min(Math.floor(maxLines), 50) : 20;
		return tailLogLines(runtimeLogPath(), limit);
	});
	ipc.handle(IPC_COMMANDS.LOG_SNAPSHOT, () => logWatcher.getSnapshot());

	// RPC command passthrough — always returns a response, never throws.
	// Throwing here causes "Error occurred in handler" console spam AND
	// Tray/dock are app-global OS surfaces; with N parallel windows each pushing
	// its own state, aggregate per-window instead of last-write-wins (which made
	// the indicator flap with push order) or focus-gating (which let it go
	// stale). Status aggregates across windows: any error > streaming > waiting
	// > idle; the displayed blob is the most recently pushed one, with its
	// status replaced by the aggregate.
	ipc.on(IPC_EVENTS.TRAY_STATE_PUSH, (caller, state: TrayState) => {
		const winId = caller.win?.webContents.id;
		if (winId === undefined) return;
		trayStates.set(winId, state);
		const aggregate = aggregateTrayStatus([...trayStates.values()]);
		setTrayState({ ...state, status: aggregate });
	});

	// Run-progress (terminal.showProgress): aggregate per-window the same way —
	// any window working → working, else any waiting → waiting, else idle.
	ipc.on(IPC_EVENTS.PROGRESS_SET, (caller, state: RunProgressState) => {
		const winId = caller.win?.webContents.id;
		if (winId === undefined) return;
		progressStates.set(winId, state);
		windowManager.setRunProgress(aggregateProgress([...progressStates.values()]));
	});

	// Windows title-bar overlay: the caption buttons repaint in the theme's top-bar colors.
	ipc.on(IPC_EVENTS.WINDOW_CHROME_SET, (caller, value: unknown) => {
		if (process.platform !== "win32") return;
		const colors = sanitizeChromeColors(value);
		const win = caller.browserWindow;
		if (!colors || !win || win.isDestroyed()) return;
		win.setTitleBarOverlay({ ...colors, height: TOP_BAR_HEIGHT });
	});

	/** Composer modes with no stock event: the other windows that show the tab re-read them (`noteModeChanged`). */
	const MODE_TOGGLE_COMMANDS: Record<string, true> = {
		set_plan_mode: true,
		set_prewalk: true,
		set_agents_paused: true,
		set_goal: true,
		set_fast_mode: true,
		set_slow_mode: true,
		set_ultrafast_mode: true,
	};

	/**
	 * The device a window's prompts are typed on: a paired web device; in the viewer test hook
	 * (`OMP_GUI_TEST_VIEWER_WINDOWS=1`, two Electron windows) every window is its own device. null = the host's own.
	 */
	const promptOriginOf = (win: ClientWindow): PromptOrigin | null =>
		deps.promptOrigins?.of(win) ??
		(process.env.OMP_GUI_TEST_VIEWER_WINDOWS === "1"
			? { deviceId: `window-${win.webContents.id}`, name: `Window ${win.webContents.id}` }
			: null);

	/** A transcript page labelled for a tab no device owns, as `win` sees it (`localizePromptOrigins`). */
	const localizeTranscript = (data: unknown, win: ClientWindow): unknown => {
		const page = data as { messages?: PromptOriginLabel[] } | undefined;
		if (!page?.messages?.some(message => message.promptFromId !== undefined)) return data;
		const ownId = promptOriginOf(win)?.deviceId ?? PROMPT_ORIGIN_HOST_ID;
		const hostName = deps.promptOrigins?.hostName() ?? os.hostname();
		return { ...page, messages: localizePromptOrigins(page.messages, ownId, hostName) };
	};

	const dispatchRpcCommand = async (
		win: ClientWindow,
		sidecar: SidecarLike | null,
		issuerTabId: string | null,
		payload: IpcRpcCommandPayload,
	) => {
		// The desktop slot is app-wide, not a tab's: answered here, whatever the tab's omp is doing.
		const slotCommand = payload.command.type;
		if (
			slotCommand === "get_desktop_slot" ||
			slotCommand === "desktop_slot_stop" ||
			slotCommand === "desktop_slot_retry" ||
			slotCommand === "desktop_slot_kill"
		) {
			if (slotCommand === "desktop_slot_stop") await desktopSlot.stop();
			if (slotCommand === "desktop_slot_retry") desktopSlot.retry();
			if (slotCommand === "desktop_slot_kill" && !(await desktopSlot.killHolder())) {
				return {
					id: payload.command.id,
					type: "response",
					command: slotCommand,
					success: false,
					error: "That session's omp has not exited, so the screen stays reserved for it.",
				};
			}
			return {
				id: payload.command.id,
				type: "response",
				command: slotCommand,
				success: true,
				data: desktopSlot.state(),
			};
		}
		const client = sidecar?.rpcClient;
		if (!client || !sidecar) {
			return {
				id: payload.command.id,
				type: "response",
				success: false,
				error: "Sidecar not connected",
				code: "sidecar_not_connected",
			};
		}
		// A tab on a paired host whose link is down: say so, not "not ready".
		if (sidecar.offline) {
			return {
				id: payload.command.id,
				type: "response",
				success: false,
				error: "The device running this tab is offline",
				code: "remote_offline",
			};
		}
		if (sidecar.status !== "ready") {
			return {
				id: payload.command.id,
				type: "response",
				success: false,
				error: `Sidecar not ready (${sidecar.status})`,
				code: "sidecar_not_ready",
			};
		}
		const { id: _id, ...cmd } = payload.command;
		// A person's own prompt (an agent's is wrapped) means the session is theirs now: it never closes by itself.
		if (
			issuerTabId &&
			(cmd.type === "prompt" || cmd.type === "steer" || cmd.type === "follow_up") &&
			parseAgentMessage(cmd.message) === null
		)
			agentControl.noteUserPrompt(issuerTabId);
		// The work board's review queue (src/main/agent-control): answered here, never sent to omp.
		if (cmd.type === "agent_control_review") {
			if (!issuerTabId)
				return { id: _id, type: "response", command: cmd.type, success: false, error: "No tab", code: "no_tab" };
			try {
				return {
					id: _id,
					type: "response",
					command: cmd.type,
					success: true,
					data: await agentControl.review(win, issuerTabId, cmd.action, cmd.child),
				};
			} catch (err) {
				return {
					id: _id,
					type: "response",
					command: cmd.type,
					success: false,
					error: err instanceof Error ? err.message : String(err),
					code: "agent_control_review_failed",
				};
			}
		}
		// Autopilot's coordinator answers its own commands for a local tab (src/main/autopilot.ts).
		if ((cmd.type === "get_autopilot" || cmd.type === "set_autopilot") && !sidecar.device && issuerTabId) {
			return autopilot.handleCommand(win, sidecar, issuerTabId, cmd as AutopilotCommand, _id);
		}
		// Every window that shows the tab has its own composer draft; its omp hears "empty" only when all
		// of them are (multi-viewer). One window's report passes as it is.
		if (issuerTabId && (cmd.type === "set_idle_compaction_draft" || cmd.type === "set_next_prompt_draft")) {
			cmd.empty = sidecarPool.noteDraft(issuerTabId, win.webContents.id, cmd.type, cmd.empty);
		}
		// One omp, one subagent stream level, several windows with their own work maps: it gets the highest.
		if (issuerTabId && cmd.type === "set_subagent_subscription") {
			cmd.level = sidecarPool.noteSubagentLevel(issuerTabId, win.webContents.id, cmd.level);
		}
		// F-OWN refuse-or-focus backstop: a switch_session onto a file a
		// DIFFERENT tab owns would double-attach it (the owner itself re-attaches
		// freely). Refuse BEFORE dispatch — the sidecar would attach for real
		// and silently diverge the owner's file. The renderer pre-check routes
		// to the owner; this catches the race.
		if (cmd.type === "switch_session") {
			const blocker = sidecarPool.foreignSessionOwner(issuerTabId, cmd.sessionPath);
			// A paired device's tab here runs it: the window opens a view of that tab instead (`tabs.spawn`).
			if (
				!blocker &&
				!sidecar.device &&
				deps.hostedTabs.hostedSessions().some(s => s.sessionPath === cmd.sessionPath)
			)
				return {
					id: _id,
					type: "response",
					command: "switch_session",
					success: false,
					error: "A paired device's tab runs this session",
					code: "session_owned_elsewhere",
					data: { hosted: true },
				};
			if (blocker) {
				return {
					id: _id,
					type: "response",
					command: "switch_session",
					success: false,
					error: "Session is already open in another tab",
					code: "session_owned_elsewhere",
					data: { ownerTabId: blocker.tabId, ownerWinId: blocker.winId },
				};
			}
			// Agent and chat sessions never convert. omp has no session kind, so
			// the guard lives here, against the GUI's own kind record — on the
			// machine that holds the file.
			let targetKind: SessionKind;
			try {
				targetKind = sidecar.device
					? await remoteKindFor(sidecar.device, cmd.sessionPath)
					: await sessionIndex.kindFor(cmd.sessionPath);
			} catch (err) {
				return {
					id: _id,
					type: "response",
					command: "switch_session",
					success: false,
					error: err instanceof Error ? err.message : String(err),
					code: ipcErrorCode(err) ?? "rpc_delivery_unknown",
				};
			}
			if (targetKind !== sidecar.kind) {
				return {
					id: _id,
					type: "response",
					command: "switch_session",
					success: false,
					error: `Cannot switch from ${sidecar.kind} session to ${targetKind} session. Open the target session in a new tab instead.`,
					code: "session_kind_mismatch",
				};
			}
		}
		// A Stop is the user's word that this turn is over: a relaunch must not resume it, even if the
		// process dies before the run's end event arrives (turn-resume.ts).
		if (issuerTabId && STOP_COMMANDS[cmd.type]) {
			sidecarPool.noteStopped(issuerTabId);
			// ■ on an autopilot run stops its running children too.
			void autopilot.aborted(issuerTabId);
		}
		// The user is moving the tab to another session or branch: a scheduled retry of its old failure is off.
		if (issuerTabId && TOUCH_COMMANDS[cmd.type]) sidecarPool.noteTouched(issuerTabId);
		// A provider sign-in's own requests belong to its login panel, also for a page that reloads before
		// `login` answers (EXTENSION_UI_OPEN tags them).
		const signIn = cmd.type === "login" ? issuerTabId : null;
		const login = cmd.type === "login" ? cmd.providerId : null;
		let signInError: string | null = null;
		if (signIn && login) sidecarPool.noteSignIn(signIn, true, { providerId: login });
		try {
			// A prompt from a paired web device names its device to the omp first: the bridge journals it for the
			// message with that text, so every window can say who typed it.
			if ((cmd.type === "prompt" || cmd.type === "steer" || cmd.type === "follow_up") && !sidecar.device) {
				const origin = promptOriginOf(win);
				if (origin)
					await client.command({ type: "prompt_origin_set", origin, text: cmd.message }).catch(() => undefined);
			}
			let response = await client.command({ ...cmd, id: _id } as RpcCommand, payload.timeoutMs);
			if (cmd.type === "get_transcript_page" && response.success && !sidecar.device) {
				response = { ...response, data: localizeTranscript(response.data, win) };
			}
			// omp has no session kind: a chat tab is plain omp started in the
			// default workspace, so the tab's own kind is what get_state reports.
			if (cmd.type === "get_state" && response.success && sidecar.kind === "chat") {
				response = { ...response, data: { ...(response.data as RpcSessionState), kind: "chat" } };
			}
			// F-OWN registration points carried by this passthrough: a successful
			// switch_session attaches the issuer to that file; get_state is how
			// the renderer's attach/hydrate reports the file (session_info_update
			// itself carries only the session id, never the path).
			if (issuerTabId && response.success) {
				if (cmd.type === "switch_session") {
					const cancelled = (response.data as { cancelled?: boolean } | undefined)?.cancelled ?? false;
					if (!cancelled) sidecarPool.noteSessionFile(issuerTabId, cmd.sessionPath);
				} else if (cmd.type === "get_state") {
					const state = response.data as RpcSessionState | undefined;
					sidecarPool.noteSessionFile(issuerTabId, state?.sessionFile ?? null);
					// switch_session re-roots the agent with no main-observable
					// event; get_state (run by every hydrate) carries the live
					// cwd. Adopt it so the tab chip tracks the session, and sync
					// the window record (menu "New Window" reads cwd from it) —
					// the same tail as a project switch, minus the respawn. The
					// record keeps local paths: a host's cwd means nothing here.
					if (state?.cwd && sidecarPool.adoptSessionCwd(issuerTabId, state.cwd) && !sidecar.device) {
						windowManager.setRecordCwd(win, state.cwd);
					}
				}
			}
			if (issuerTabId && response.success && MODE_TOGGLE_COMMANDS[cmd.type]) {
				sidecarPool.noteModeChanged(issuerTabId, win.webContents.id);
			}
			// A login or logout writes the shared credential store; every tab's omp
			// re-reads it so a newly connected account's image model turns on everywhere.
			if (response.success && (cmd.type === "login" || cmd.type === "logout")) {
				for (const other of sidecarPool.allSidecars()) other.syncImageGeneration();
			}
			if (cmd.type === "login" && !response.success) signInError = response.error ?? "";
			return response;
		} catch (err) {
			signInError = err instanceof Error ? err.message : String(err);
			return {
				id: _id,
				type: "response",
				success: false,
				code: ipcErrorCode(err) ?? "rpc_delivery_unknown",
				error: err instanceof Error ? err.message : String(err),
			};
		} finally {
			if (signIn && login) sidecarPool.noteSignIn(signIn, false, { providerId: login, error: signInError });
		}
	};

	const autopilot: Autopilot = new Autopilot({
		pool: sidecarPool,
		dispatch: (win, sidecar, tabId, command, timeoutMs) =>
			dispatchRpcCommand(win, sidecar, tabId, {
				command,
				timeoutMs,
			} as IpcRpcCommandPayload) as Promise<RpcResponse>,
		spawnTab: (win, payload) =>
			spawnTabForWindow(
				{
					sidecarPool: deps.sidecarPool,
					sessionIndex,
					fallbackCwd: () => null,
					initialCwd: deps.initialCwd,
					defaultWorkspace: ensureDefaultWorkspace,
					remote: { kindFor: remoteKindFor, defaultWorkspace: remoteDefaultWorkspace },
					hosted: deps.hostedTabs,
				},
				win,
				payload,
			),
		prefs: { get: key => prefsStore.get(key) },
		// Batched like any tab notification (notification-batch.ts); a click opens the tab.
		notify: (tabId, notice) => {
			const windowId = sidecarPool.tabInventory().find(tab => tab.tabId === tabId)?.windowId;
			if (windowId === undefined) return;
			if (!notifyBatchedWindows.has(windowId)) {
				const owner = windowManager.getAllWindows().find(candidate => candidate.webContents.id === windowId);
				if (owner) {
					notifyBatchedWindows.add(windowId);
					owner.once("closed", () => {
						notifyBatchedWindows.delete(windowId);
						notificationBatcher.dropWindow(windowId);
					});
				}
			}
			notificationBatcher.notify(
				windowId,
				{ title: notice.title, body: notice.body, tabId, kind: notice.kind },
				prefsStore.get(BATCH_NOTIFICATIONS_PREF) !== false,
			);
		},
		text: (key, params) => mainT(key, undefined, params),
		relaunchContinuation: deps.relaunchContinuation,
	});
	deps.autopilotRef.current = autopilot;
	// The desktop slot (src/main/desktop-slot-host.ts): the bridge's slot frames come through the sidecar factory.
	const desktopSlot = new DesktopSlotHost({
		pool: sidecarPool,
		broadcast: state => sidecarPool.broadcastEvent({ type: "desktop_slot_update", state }),
	});
	deps.desktopSlotRef.current = desktopSlot;
	sidecarPool.onAcquire = (tabId, sidecar) => {
		autopilot.attachSidecar(tabId, sidecar);
		desktopSlot.attachSidecar(tabId, sidecar);
	};
	sidecarPool.observeTabs(activity => {
		autopilot.observeActivity(activity);
		desktopSlot.observeActivity(activity);
	});

	// OMPdesk control tools (src/main/agent-control): the same pool, dispatcher, spawn path and notifications the GUI uses.
	const agentControl: AgentControlRuntime = new AgentControlRuntime({
		isStopping: callerTabId => autopilot.isStopping(callerTabId),
		beforeFirstPrompt: child => autopilot.beforeFirstPrompt(child),
		autopilot: {
			command: (win, sidecar, tabId, command) => autopilot.handleCommand(win, sidecar, tabId, command, undefined),
			defaultBranch: async (cwd, remote) => (await readBranchFacts(cwd, remote)).defaultBranch,
		},
		pool: sidecarPool,
		schedules: () => deps.schedules?.() ?? null,
		dispatch: (win, sidecar, tabId, command, timeoutMs) =>
			dispatchRpcCommand(win, sidecar, tabId, {
				command,
				timeoutMs,
			} as IpcRpcCommandPayload) as Promise<RpcResponse>,
		spawnTab: (win, payload) =>
			spawnTabForWindow(
				{
					sidecarPool: deps.sidecarPool,
					sessionIndex,
					fallbackCwd: () => null,
					initialCwd: deps.initialCwd,
					defaultWorkspace: ensureDefaultWorkspace,
					remote: { kindFor: remoteKindFor, defaultWorkspace: remoteDefaultWorkspace },
					hosted: deps.hostedTabs,
				},
				win,
				payload,
			),
		prefs: {
			get: key => prefsStore.get(key),
			set: (key, value) => prefsStore.set(key, value),
			changed: key => prefChanged(null, key),
		},
		sweepMs: process.env.OMP_GUI_TEST_AGENT_SWEEP_MS ? Number(process.env.OMP_GUI_TEST_AGENT_SWEEP_MS) : undefined,
		deviceName: id => remoteDevices.state().hosts.find(host => host.deviceId === id)?.name ?? id,
		sessions: {
			list: () => sessionIndex.list("global"),
			search: (query, paths) => sessionIndex.searchContent(query, paths),
			read: sessionPath => sessionIndex.readMessages(sessionPath),
		},
		remote: {
			hosts: () => remoteDevices.state().hosts,
			request: (device, method, params) => remoteDevices.request(device, method, params),
		},
		notify: (win, tabId, title, body) => {
			showNotification(win.webContents.id, { title, body, tabId });
		},
		deleteSession: deleteStoredSession,
		text: (key, params) => mainT(`agentControl.${key}` as MainTextKey, undefined, params),
		// `ompdesk_app` runs the app's own handlers as the calling session's window would.
		app: {
			invoke: (win, channel, args) => ipc.invoke(channel, agentCaller(win), args),
			fire: (win, channel, args) => ipc.send(channel, agentCaller(win), args),
			localize: (en, ko) => (getMainLanguage() === "ko" ? ko : en),
		},
	});

	// Autopilot's coordinator (src/main/autopilot.ts): the tab hooks DeskTools calls and the frames the sidecar
	// factory hands over; index.ts reaches it through `deps.autopilotRef` (TurnResume, the factory).
	autopilot.attachControl(agentControl.control);

	ipc.handle(IPC_COMMANDS.RPC_COMMAND, async (caller, payload: IpcRpcCommandPayload) => {
		const win = caller.win;
		if (!win)
			return { id: payload.command.id, type: "response", success: false, error: "No window", code: "no_window" };
		const issuerTabId = sidecarPool.activeTabForWindow(win);
		return dispatchRpcCommand(win, sidecarPool.sidecarForWindow(win), issuerTabId, payload);
	});

	// RPC addressed at a specific tab. Split panes use this for every command;
	// the shared dispatcher preserves the same ownership/cwd bookkeeping as the
	// focused-tab path.
	ipc.handle(IPC_COMMANDS.RPC_COMMAND_FOR_TAB, async (caller, payload: IpcRpcCommandForTabPayload) => {
		const win = caller.win;
		if (!win)
			return { id: payload?.command?.id, type: "response", success: false, error: "No window", code: "no_window" };
		const sidecar = sidecarPool.sidecarForTab(win, payload.tabId);
		return dispatchRpcCommand(win, sidecar, payload.tabId, payload);
	});

	// Extension UI respond — F-UI-ORIGIN: route to the sidecar that RAISED the
	// request (tracked by request id), not the window's active tab; the user
	// may have switched tabs while the dialog was open. Unknown ids (raised
	// before tracking, or after a restart) fall back to the active sidecar.
	// Resolves once the omp took the answer; a paired host's tab that did not
	// rejects, and the renderer keeps the card open. Another window that shows
	// the tab may have answered first: that rejects with `already_answered`.
	ipc.handle(IPC_COMMANDS.EXTENSION_UI_RESPOND, async (caller, payload: IpcExtensionUiRespondPayload) => {
		const { response, tabId } = payload;
		const win = caller.win ?? undefined;
		if (typeof tabId === "string") {
			if (!win || !sidecarPool.sidecarForTab(win, tabId)) return;
			if (typeof response?.id === "string") await sidecarPool.routeSideChannel(response.id, response, tabId, win);
			return;
		}
		if (
			typeof response?.id === "string" &&
			(await sidecarPool.routeSideChannel(response.id, response, undefined, win))
		)
			return;
		await sidecarFor(deps, caller)?.sendSideChannel(response);
	});

	ipc.handle(IPC_COMMANDS.EXTENSION_UI_OPEN, caller => {
		const win = caller.win;
		return win ? sidecarPool.openRequests(win) : [];
	});

	// Sessions. `device` names the paired host whose session index answers;
	// its sessions come back tagged with it.
	ipc.handle(IPC_COMMANDS.SESSIONS_LIST, async (caller, payload: IpcSessionsListPayload) => {
		const scope = payload.scope === "local" ? "local" : "global";
		const device = deviceOf(payload.device);
		const cwd = cwdOnDevice(deps, caller, device) ?? undefined;
		if (!device) return sessionIndex.list(scope, cwd);
		const sessions = await remoteDevices.request<SessionInfo[]>(device, "sessions.list", { scope, cwd });
		return sessions.map(info => ({ ...info, device }));
	});

	ipc.handle(IPC_COMMANDS.SESSIONS_DELETE, async (_caller, payload: IpcSessionsDeletePayload) => {
		if (typeof payload.sessionPath !== "string" || !payload.sessionPath.endsWith(".jsonl")) {
			throw codedError("invalid_session_path", "Invalid session path");
		}
		await deleteStoredSession(payload.sessionPath, deviceOf(payload.device));
	});

	ipc.handle(IPC_COMMANDS.SESSIONS_RENAME, async (_caller, payload: IpcSessionsRenamePayload) => {
		if (typeof payload.sessionPath !== "string" || !payload.sessionPath.endsWith(".jsonl")) {
			throw codedError("invalid_session_path", "Invalid session path");
		}
		const device = deviceOf(payload.device);
		await renameSession(sidecarPool, payload.sessionPath, payload.name, {
			device,
			renameStored: async name => {
				if (device)
					return remoteDevices.request(device, "sessions.rename", { sessionPath: payload.sessionPath, name });
				const omp = await systemOmp();
				if (!omp.ok) throw new Error(omp.error);
				await renameStoredSession(omp.runtime, payload.sessionPath, name);
			},
		});
	});

	ipc.handle(IPC_COMMANDS.SESSIONS_MOVE, async (_caller, payload: IpcSessionsMovePayload): Promise<string> => {
		if (typeof payload.sessionPath !== "string" || !payload.sessionPath.endsWith(".jsonl")) {
			throw codedError("invalid_session_path", "Invalid session path");
		}
		if (typeof payload.cwd !== "string" || !path.isAbsolute(payload.cwd)) {
			throw codedError("not_absolute_path", "Not an absolute path");
		}
		const device = deviceOf(payload.device);
		return moveSession(sidecarPool, payload.sessionPath, device, () =>
			device
				? remoteDevices.request<string>(device, "sessions.move", {
						sessionPath: payload.sessionPath,
						cwd: payload.cwd,
					})
				: sessionIndex.moveSession(payload.sessionPath, payload.cwd),
		);
	});

	// Open a session (or a fresh project window) in a NEW parallel window with
	// its own sidecar. The calling window's sidecar is left running untouched —
	// this is the explicit parallel action. Returns false when the window's
	// sidecar cannot be created.
	// F-OWN: when the session is already attached to a tab, focus the owner
	// window (win.show()+win.focus() — the codebase's focus pattern, see
	// deep-link.ts/tray.ts) instead of spawning a second sidecar for the same
	// file; resolves true because the session ends up foregrounded either way.
	// The session switch is done by the NEW window's renderer on boot (it pulls
	// pendingSessionPath and runs switch_session + hydrate itself), which avoids
	// racing the renderer's boot hydration and surfaces failures in that window.
	ipc.handle(IPC_COMMANDS.SESSION_OPEN_NEW_WINDOW, async (caller, payload: IpcSessionOpenNewWindowPayload) => {
		const sessionPath = typeof payload?.sessionPath === "string" ? payload.sessionPath : undefined;
		const device = deviceOf(payload?.device);
		if (sessionPath) {
			const owner = deps.sidecarPool.sessionOwner(sessionPath, device);
			if (owner && deps.windowManager.focusWindowById(owner.winId)) return true;
		}
		// The new window's sidecar must spawn with the target file's kind, or the
		// boot-time switch_session hits the agent-side kind guard and the pool
		// entry would lie about its kind (I1).
		const kind = sessionPath
			? device
				? await remoteKindFor(device, sessionPath)
				: await sessionIndex.kindFor(sessionPath)
			: undefined;
		const requested = typeof payload?.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : undefined;
		// A chat runs outside any project, in the default workspace.
		const cwd =
			kind === "chat"
				? device
					? await remoteDefaultWorkspace(device)
					: ensureDefaultWorkspace()
				: (requested ??
					cwdOnDevice(deps, caller, device) ??
					(device ? await remoteDefaultWorkspace(device) : deps.initialCwd()));
		return deps.spawnWindow(cwd, sessionPath, kind, device) !== null;
	});

	// Fresh window pulls the session it was opened to display (one-shot). The
	// renderer performs the actual switch_session + hydrate on boot, which
	// avoids racing the boot hydration and surfaces failures in that window.
	ipc.handle(IPC_COMMANDS.SESSION_CONSUME_PENDING, caller => {
		const win = caller.win;
		return win ? (deps.windowManager.consumePendingSession(win) ?? null) : null;
	});

	// ========================================================================
	// Session tabs — in-window parallel sessions. Each tab owns a pooled
	// sidecar bound to the CALLING window (no new BrowserWindow); the pool
	// moves full event forwarding to the window's active tab. Routing derives
	// from the caller, so a renderer can only touch its own window's tabs.
	// ========================================================================

	// Spawn a background tab. Null when its sidecar cannot be created; the renderer decides
	// whether to activate it (SET_ACTIVE_TAB) — spawn itself never switches.
	// F-OWN: a sessionPath already attached to a tab returns
	// { tabId: null, ownerTabId, ownerWinId, refusal: "owned" } — the renderer
	// switches to (or focuses) the owner instead of double-attaching the file.
	// F-KIND: an explicit payload kind that disagrees with the file's stamped
	// kind returns { tabId: null, refusal: "kind-mismatch" } (I3); an omitted
	// payload kind defers to the file. Decision logic lives in tab-spawn.ts so
	// both refusal contracts are unit-testable without an Electron runtime.
	ipc.handle(IPC_COMMANDS.SPAWN_TAB, (caller, payload: IpcSpawnTabPayload) => {
		const win = caller.win;
		if (!win) return null;
		return spawnTabForWindow(
			{
				sidecarPool: deps.sidecarPool,
				sessionIndex,
				fallbackCwd: device => cwdOnDevice(deps, caller, device),
				initialCwd: deps.initialCwd,
				defaultWorkspace: ensureDefaultWorkspace,
				remote: { kindFor: remoteKindFor, defaultWorkspace: remoteDefaultWorkspace },
				hosted: deps.hostedTabs,
				anyWindowViews: process.env.OMP_GUI_TEST_VIEWER_WINDOWS === "1",
			},
			win,
			payload,
		);
	});

	// Release a tab's sidecar. The window falls back to its initial no-tab
	// state when its last tab closes (welcome screen; handlers tolerate null).
	// A tab owning a `worktree.onStart` worktree first re-reads `worktree.onExit`
	// from its live session (stock reads it at shutdown); the pool's release
	// then hands the exit to worktree-lifecycle.ts.
	ipc.handle(IPC_COMMANDS.CLOSE_TAB, async (caller, payload: IpcCloseTabPayload) => {
		const win = caller.win;
		if (!win || typeof payload?.tabId !== "string") return false;
		const sidecar = deps.sidecarPool.sidecarForTab(win, payload.tabId);
		if (!sidecar) return false;
		// A window viewing another window's tab only leaves it; the owner's close releases it for all.
		if (deps.sidecarPool.detachViewer(win, payload.tabId)) return true;
		// A view of a paired device's tab here only leaves it: the omp and its worktree are the device's.
		if (deps.sidecarPool.isHostedView(payload.tabId)) {
			closeTabTerminals(caller.sender.id, payload.tabId);
			return deps.sidecarPool.releaseTab(payload.tabId);
		}
		await deps.worktreeLifecycle.refreshExitPolicy(payload.tabId, () => readLiveLifecycleSettings(sidecar));
		closeTabTerminals(caller.sender.id, payload.tabId);
		return deps.sidecarPool.releaseTab(payload.tabId);
	});

	// The calling window's open `worktree.onStart` / `worktree.onExit` questions.
	ipc.handle(IPC_COMMANDS.WORKTREE_PROMPTS_GET, caller => {
		const win = caller.win;
		return win ? deps.worktreePrompts.forWindow(win.webContents.id) : [];
	});

	ipc.handle(IPC_COMMANDS.WORKTREE_PROMPT_ANSWER, (caller, payload: IpcWorktreePromptAnswer) => {
		const win = caller.win;
		if (!win || typeof payload?.id !== "string") return false;
		return deps.worktreePrompts.answer(win.webContents.id, payload.id, payload.accept === true);
	});

	// Where each folder comes from (a linked worktree's main checkout and what the worktree is for), from git.
	ipc.handle(IPC_COMMANDS.PROJECT_ORIGINS_GET, async (_caller, cwds: unknown) => {
		const folders = Array.isArray(cwds)
			? [...new Set(cwds.filter((cwd): cwd is string => typeof cwd === "string" && cwd !== ""))].slice(0, 200)
			: [];
		const origins = await Promise.all(folders.map(cwd => readProjectOrigin(cwd)));
		return Object.fromEntries(folders.map((cwd, index) => [cwd, origins[index] ?? null]));
	});

	// Move full event forwarding to the window's active tab (listeners move,
	// never duplicate). The renderer calls this before hydrateSession().
	ipc.handle(IPC_COMMANDS.SET_ACTIVE_TAB, (caller, payload: IpcSetActiveTabPayload) => {
		const win = caller.win;
		if (!win || typeof payload?.tabId !== "string") return false;
		return deps.sidecarPool.setActiveTab(win, payload.tabId);
	});

	ipc.handle(IPC_COMMANDS.SET_TAB_VIEW, (caller, payload: IpcSetTabViewPayload) => {
		const win = caller.win;
		if (!win || typeof payload?.focusedTabId !== "string" || !Array.isArray(payload.visibleTabIds)) return false;
		return deps.sidecarPool.setTabView(
			win,
			payload.focusedTabId,
			payload.visibleTabIds,
			payload.split,
			payload.rememberedSplits,
		);
	});

	ipc.handle(IPC_COMMANDS.REORDER_TABS, (caller, payload: { tabIds?: unknown }) => {
		const win = caller.win;
		const tabIds = payload?.tabIds;
		if (!win || !Array.isArray(tabIds) || !tabIds.every(id => typeof id === "string")) return false;
		return deps.sidecarPool.reorderWindowTabs(win, tabIds);
	});

	// Boot reconciliation: the window's tabs in acquisition order (the initial
	// sidecar is tab 0 — main minted its tabId at acquire).
	ipc.handle(IPC_COMMANDS.GET_TABS, caller => {
		const win = caller.win;
		return win ? deps.sidecarPool.tabsForWindow(win) : [];
	});

	// F-OWN: which tab/window owns a session file, if any. The renderer
	// belt-guards (open tab / open-in-new-window rows) consult this before
	// attempting an attach.
	ipc.handle(IPC_COMMANDS.GET_SESSION_OWNER, (_caller, payload: IpcGetSessionOwnerPayload) => {
		if (typeof payload?.sessionPath !== "string") return null;
		const device = deviceOf(payload.device);
		const owner = deps.sidecarPool.sessionOwner(payload.sessionPath, device);
		if (owner || device) return owner;
		const held = deps.hostedTabs.hostedSessions().some(session => session.sessionPath === payload.sessionPath);
		return held ? ({ tabId: "", winId: 0, hosted: true } satisfies IpcSessionOwner) : null;
	});
	ipc.handle(IPC_COMMANDS.HOSTED_SESSIONS, () => deps.hostedTabs.hostedSessions());

	// Full-content search over session files (raw JSONL grep on the machine
	// holding them, scoped to the same candidate set the list view would show).
	ipc.handle(
		IPC_COMMANDS.SESSIONS_SEARCH,
		async (caller, payload: IpcSessionsSearchPayload): Promise<SessionContentMatch[]> => {
			const scope = payload.scope === "local" ? "local" : "global";
			const query = typeof payload.query === "string" ? payload.query : "";
			const device = deviceOf(payload.device);
			const cwd = cwdOnDevice(deps, caller, device) ?? undefined;
			if (device) {
				// A host on an older OMPdesk answers bare paths (no excerpt).
				const hits = await remoteDevices.request<(string | SessionContentMatch)[]>(device, "sessions.search", {
					query,
					scope,
					cwd,
				});
				return hits.map(hit => (typeof hit === "string" ? { path: hit } : hit));
			}
			const candidates = await sessionIndex.list(scope, cwd);
			return sessionIndex.searchContent(
				query,
				candidates.map(info => info.path),
			);
		},
	);

	// Stats: the stats server of the machine the caller's focused tab runs on.
	ipc.handle(IPC_COMMANDS.STATS_FETCH, (caller, payload: IpcStatsFetchPayload) =>
		machineFor(caller, payload?.device).fetchStats(payload.path, payload.params),
	);

	// `omp bench` on the machine the caller's focused tab runs on, one per window.
	ipc.handle(
		IPC_COMMANDS.BENCH_RUN,
		async (caller, options: IpcBenchmarkRunOptions, device?: unknown): Promise<IpcBenchmarkRunResult> => {
			const id = deviceOf(device);
			const senderId = caller.sender.id;
			if (!id) return deps.machine.runBenchmark(benchCaller(senderId), options, cwdFor(deps, caller));
			return runTracked(remoteBenchmarks, senderId, id, () =>
				machineFor(caller, id).runBenchmark(benchCaller(senderId), options, null),
			);
		},
	);
	ipc.handle(IPC_COMMANDS.BENCH_ABORT, (caller, device?: unknown) =>
		machineFor(caller, device).abortBenchmark(benchCaller(caller.sender.id)),
	);

	// The model setup assistant's research on the machine the caller's focused tab runs on, one per window.
	ipc.handle(
		IPC_COMMANDS.MODEL_SETUP_RUN,
		async (caller, request: ModelSetupRequest, device?: unknown): Promise<IpcModelSetupRunResult> => {
			const id = deviceOf(device);
			const senderId = caller.sender.id;
			if (!id) return deps.machine.runModelSetup(benchCaller(senderId), request);
			return runTracked(remoteModelSetups, senderId, id, () =>
				machineFor(caller, id).runModelSetup(benchCaller(senderId), request),
			);
		},
	);
	ipc.handle(IPC_COMMANDS.MODEL_SETUP_STATUS, (caller, device?: unknown) =>
		machineFor(caller, device).modelSetupStatus(benchCaller(caller.sender.id)),
	);
	ipc.handle(IPC_COMMANDS.MODEL_SETUP_ABORT, (caller, device?: unknown) =>
		machineFor(caller, device).abortModelSetup(benchCaller(caller.sender.id)),
	);

	// Renderer-initiated quit (the `quit` command). Straight to the guard, never
	// `window.close()`: closing the focused window only hides the rest of the
	// session behind it.
	ipc.on(IPC_COMMANDS.APP_QUIT, () => {
		requestQuit();
	});

	// System
	ipc.handle(IPC_COMMANDS.SYSTEM_INFO, () => ({
		appVersion: appVersion(),
		platform: process.platform,
		arch: process.arch,
		deviceLanguage: deviceLanguage() ?? null,
		osRelease: os.release(),
		electron: process.versions.electron ?? "?",
		chrome: process.versions.chrome ?? "?",
		node: process.versions.node ?? "?",
	}));
	ipc.handle(IPC_COMMANDS.SYSTEM_OPEN_EXTERNAL, async (_caller, url: unknown) => {
		if (isOpenableExternalUrl(url)) await shell.openExternal(url);
	});

	// Tool-card and reply path links: open in the system editor, or reveal the
	// file in the file manager when no editor association exists.
	ipc.handle(
		IPC_COMMANDS.SYSTEM_OPEN_PATH,
		async (caller, target: string, tabId?: string): Promise<IpcOpenPathResult> => {
			const local = await existingLocalPath(deps, caller, target, tabId);
			if (!("path" in local)) return local;
			await openLocalPath(local.path, shell);
			return { ok: true };
		},
	);

	// "Show in Finder" for a path the renderer knows (agent definition files, reply links).
	ipc.handle(
		IPC_COMMANDS.SYSTEM_REVEAL_PATH,
		async (caller, target: string, tabId?: string): Promise<IpcOpenPathResult> => {
			const local = await existingLocalPath(deps, caller, target, tabId);
			if (!("path" in local)) return local;
			shell.showItemInFolder(local.path);
			return { ok: true };
		},
	);

	ipc.handle(
		IPC_COMMANDS.SYSTEM_SAVE_DIALOG,
		async (caller, defaultPath?: string, filters?: { name: string; extensions: string[] }[]) => {
			const win = caller.browserWindow;
			if (!win) return null;
			const result = await dialog.showSaveDialog(win, {
				defaultPath: defaultPath ?? "session.html",
				filters: filters ?? [{ name: "HTML", extensions: ["html"] }],
			});
			return result.canceled ? null : (result.filePath ?? null);
		},
	);

	ipc.handle(IPC_COMMANDS.SYSTEM_SAVE_IMAGE, async (caller, defaultName: string, mimeType: string, data: string) => {
		const win = caller.browserWindow;
		if (!win) return { saved: false };
		const extension =
			mimeType
				.split("/")[1]
				?.split(/[+;]/)[0]
				?.replace("jpeg", "jpg")
				.replace(/[^a-z0-9]/gi, "") || "png";
		const result = await dialog.showSaveDialog(win, {
			defaultPath: path.basename(defaultName) || `image.${extension}`,
			filters: [{ name: "Image", extensions: [extension] }],
		});
		if (result.canceled || !result.filePath) return { saved: false };
		try {
			await fsp.writeFile(result.filePath, Buffer.from(data, "base64"));
			return { saved: true };
		} catch (error) {
			return { saved: false, error: error instanceof Error ? error.message : String(error) };
		}
	});

	ipc.handle(
		IPC_COMMANDS.SYSTEM_OPEN_DIALOG,
		async (
			caller,
			filters?: { name: string; extensions: string[] }[],
			options?: { directory?: boolean; title?: string; buttonLabel?: string },
		) => {
			const win = caller.browserWindow;
			if (!win) return null;
			const result = await dialog.showOpenDialog(win, {
				properties: options?.directory ? ["openDirectory", "createDirectory"] : ["openFile", "multiSelections"],
				filters: filters ?? [],
				title: options?.title,
				buttonLabel: options?.buttonLabel,
				// macOS sheet header; the panel's own "New Folder" button creates the project folder.
				message: options?.title,
			});
			return result.canceled ? null : result.filePaths;
		},
	);

	ipc.handle(IPC_COMMANDS.SYSTEM_NOTIFY, (caller, payload: IpcNotifyPayload) => {
		if (typeof payload.title === "string") {
			// Dedupe within a window (a turn can emit the same notification from
			// several renderers), but NOT across windows — two parallel sessions
			// finishing in different windows are distinct events the user wants.
			// A tab several windows show is one event, whichever of them reports it.
			const win = caller.win;
			const winId = win?.webContents.id ?? 0;
			const tabId = typeof payload.tabId === "string" ? payload.tabId : undefined;
			const scope = tabId && sidecarPool.isShared(tabId) ? `tab:${tabId}` : winId;
			const key = `${scope}${payload.title}${payload.body ?? ""}`;
			const now = Date.now();
			if (key === lastNotifyKey && now - lastNotifyAt < 1500) return;
			lastNotifyKey = key;
			lastNotifyAt = now;
			if (win && !notifyBatchedWindows.has(winId)) {
				notifyBatchedWindows.add(winId);
				win.once("closed", () => {
					notifyBatchedWindows.delete(winId);
					notificationBatcher.dropWindow(winId);
				});
			}
			// Bursts fold into one summary unless the pref is off (notification-batch.ts).
			notificationBatcher.notify(
				winId,
				{
					title: payload.title,
					body: payload.body,
					tabId,
					kind: payload.kind,
				},
				prefsStore.get(BATCH_NOTIFICATIONS_PREF) !== false,
			);
		}
	});

	// Preferences
	ipc.handle(IPC_COMMANDS.PREFS_GET, (_caller, payload: IpcPrefsGetPayload) => {
		if (payload.key) {
			return prefsStore.get(payload.key);
		}
		return prefsStore.store;
	});

	/** `PREFS_CHANGED` to every window but the one that wrote the key, so the others' settings follow it. */
	const prefChanged = (writer: ClientWindow | null, key: string): void => {
		const writerId = writer?.webContents.id;
		for (const win of windowManager.getAllWindows()) {
			if (win.webContents.id !== writerId) {
				win.webContents.send(IPC_EVENTS.PREFS_CHANGED, { key } satisfies IpcPrefsChangedPayload);
			}
		}
	};
	ipc.handle(IPC_COMMANDS.PREFS_SET, (caller, payload: IpcPrefsSetPayload) => {
		if (typeof payload.key !== "string") {
			throw codedError("invalid_preference_key", "Invalid preference key");
		}
		const replyLanguage = payload.key === REPLY_LANGUAGE_PREF;
		if (replyLanguage && !isReplyLanguagePref(payload.value)) {
			throw codedError("invalid_preference_key", "Invalid reply language");
		}
		const userProfile = payload.key === USER_PROFILE_PREF;
		if (userProfile && !isUserProfile(payload.value)) {
			throw codedError("invalid_preference_key", "Invalid profile");
		}
		const nextPrompt = payload.key === NEXT_PROMPT_PREF || payload.key === NEXT_PROMPT_INLINE_PREF;
		if (nextPrompt && typeof payload.value !== "boolean") {
			throw codedError("invalid_preference_key", "Invalid prompt suggestion preference");
		}
		const autoTitle = payload.key === AUTO_TITLE_PREF || payload.key === AUTO_TITLE_EVOLVE_PREF;
		if (autoTitle && typeof payload.value !== "boolean") {
			throw codedError("invalid_preference_key", "Invalid automatic title preference");
		}
		if (payload.key === DELEGATION_PREF && !isDelegationMode(payload.value)) {
			throw codedError("invalid_preference_key", "Invalid delegation strength");
		}
		if (
			(payload.key === AUTOPILOT_SHIP_PREF ||
				payload.key === AUTOPILOT_NOTIFY_PREF ||
				payload.key === AUTOPILOT_BRANCH_PREF) &&
			!validAutopilotPref(payload.key, payload.value)
		) {
			throw codedError("invalid_preference_key", "Invalid autopilot preference");
		}
		if (payload.key === ACCOUNT_ROTATION_PREF) {
			if (!isAccountRotationMode(payload.value)) {
				throw codedError("invalid_preference_key", "Invalid account rotation");
			}
			// Same path as Settings' own control: store, then push to the live sessions.
			return deps.machine.setAccountRotation(payload.value).then(() => prefChanged(caller.win, payload.key));
		}
		if (payload.key === REA_PREF) {
			if (typeof payload.value !== "boolean")
				throw codedError("invalid_preference_key", "Invalid built-in REA preference");
			return deps.machine.setBuiltinRea(payload.value).then(() => prefChanged(caller.win, payload.key));
		}
		// `undefined` clears the key: electron-store rejects set(key, undefined) with
		// "Use `delete()` to clear values", which broke the one-time prompt-history
		// migration on every launch and with it loading the composer's ↑ history.
		// Each set or delete rewrites and fsyncs the whole file on the main thread; writing the value already
		// stored changes nothing, so only a change is written. The pushes below still run.
		if (payload.value === undefined) {
			if (prefsStore.has(payload.key)) prefsStore.delete(payload.key);
		} else if (JSON.stringify(prefsStore.get(payload.key)) !== JSON.stringify(payload.value)) {
			prefsStore.set(payload.key, payload.value);
		}
		if (replyLanguage) {
			// Every open session's next turn follows; paired hosts keep their own setting.
			for (const sidecar of sidecarPool.allSidecars()) if (!sidecar.device) sidecar.syncReplyLanguage();
			remoteDevices.hostReplyLanguageChanged();
		}
		if (userProfile) {
			for (const sidecar of sidecarPool.allSidecars()) if (!sidecar.device) sidecar.syncUserProfile();
			remoteDevices.hostUserProfileChanged();
		}
		if (nextPrompt) {
			// Every open local session follows now; a paired host's tab follows the host's own setting.
			for (const sidecar of sidecarPool.allSidecars()) if (!sidecar.device) sidecar.syncNextPrompt();
			remoteDevices.hostNextPromptChanged();
		}
		if (autoTitle) {
			// Every open local session follows now; a paired host's tab follows the host's own setting.
			for (const sidecar of sidecarPool.allSidecars()) if (!sidecar.device) sidecar.syncAutoTitle();
			remoteDevices.hostAutoTitleChanged();
		}
		if (payload.key === "language" && isUiLanguage(payload.value)) {
			createMenu(windowManager, deps.spawnWindow);
		}
		if (payload.key === AGENT_CONTROL_PREF)
			for (const sidecar of sidecarPool.allSidecars()) if (!sidecar.device) sidecar.syncHostTools();
		deps.onPrefChanged?.(payload.key);
		prefChanged(caller.win, payload.key);
	});

	// Launch profiles live with the machine that spawns omp: a tab's paired
	// host keeps its own.
	const launchProfilePrefs: LaunchProfilePrefs = {
		get: key => prefsStore.get(key),
		set: (key, value) => prefsStore.set(key, value),
	};
	ipc.handle(IPC_COMMANDS.PREFS_GET_LAUNCH_PROFILE, (_caller, payload: IpcGetLaunchProfilePayload) => {
		const device = deviceOf(payload?.device);
		return device
			? remoteDevices.request(device, "launchProfile.get", { cwd: payload.cwd })
			: readLaunchProfile(launchProfilePrefs, payload?.cwd);
	});

	ipc.handle(IPC_COMMANDS.PREFS_UPDATE_LAUNCH_PROFILE, (_caller, payload: IpcUpdateLaunchProfilePayload) => {
		const device = deviceOf(payload?.device);
		return device
			? remoteDevices.request(device, "launchProfile.update", { cwd: payload.cwd, patch: payload.patch })
			: updateLaunchProfile(launchProfilePrefs, payload?.cwd, payload?.patch);
	});

	// Sidecar control
	ipc.handle(IPC_COMMANDS.SIDECAR_RESTART, (caller, payload?: IpcSidecarRestartPayload) => {
		const win = caller.win;
		if (!win) throw codedError("no_window", "No window");
		const sidecar =
			typeof payload?.tabId === "string"
				? sidecarPool.sidecarForTab(win, payload.tabId)
				: sidecarPool.sidecarForWindow(win);
		if (!sidecar) throw codedError("unknown_tab", "Unknown tab");
		const sessionPath =
			typeof payload?.sessionPath === "string" && payload.sessionPath ? payload.sessionPath : undefined;
		sidecar.restart(undefined, sessionPath);
	});

	// Native folder picker: this machine's disk only. A tab on a paired host
	// picks through the remote folder picker (remote.listDirs) and setProject.
	ipc.handle(IPC_COMMANDS.SIDECAR_SELECT_PROJECT, async caller => {
		const win = caller.browserWindow;
		if (!win) return null;
		const target = targetFor(deps, caller);
		if (!target) return null;
		if (target.device) throw codedError("remote_path_native", "The project is on another device");
		const { sidecar } = target;
		const result = await dialog.showOpenDialog(win, {
			title: mainT("dialog.openProject"),
			defaultPath: sidecar.cwd,
			properties: ["openDirectory", "createDirectory"],
		});
		if (result.canceled || !result.filePaths[0]) return null;

		const cwd = result.filePaths[0];
		prefsStore.set("lastProject", cwd);
		// Per-window project switch: restart only this window's sidecar and keep
		// the window record in sync (menu "New Window" reads cwd from it).
		windowManager.setRecordCwd(win, cwd);
		sidecar.restart(cwd);
		return cwd;
	});

	// Switch to a KNOWN workspace directory (no native picker): used by the
	// workspace manager to jump to a recent project. Validates the directory
	// exists, then restarts the sidecar there (same tail as select-project).
	// On a paired host the directory is checked there, and this machine's
	// last-project pref and window record keep local paths only.
	ipc.handle(IPC_COMMANDS.SIDECAR_SET_PROJECT, async (caller, payload: { cwd?: string }) => {
		const cwd = payload?.cwd;
		if (typeof cwd !== "string" || cwd.length === 0) return false;
		const target = targetFor(deps, caller);
		if (!target) return false;
		if (target.device) {
			try {
				await remoteDevices.request(target.device, "fs.listDirs", { path: cwd });
			} catch {
				return false;
			}
			target.sidecar.restart(cwd);
			return true;
		}
		try {
			if (!(await fsp.stat(cwd)).isDirectory()) return false;
		} catch {
			return false;
		}
		prefsStore.set("lastProject", cwd);
		const win = caller.win;
		if (win) windowManager.setRecordCwd(win, cwd);
		target.sidecar.restart(cwd);
		return true;
	});

	ipc.handle(IPC_COMMANDS.SIDECAR_DEFAULT_WORKSPACE, () => ensureDefaultWorkspace());

	// models.yml custom providers of the machine the caller's focused tab runs on.
	ipc.handle(IPC_COMMANDS.MODELS_PROVIDERS_LIST, (caller, device?: unknown) =>
		machineFor(caller, device).listProviders(),
	);
	// A true first run, known before omp boots (the first-run provider step opens at once): stock's own
	// credential store and env-key map in the stock helper, under the environment omp itself gets. Anything
	// that cannot answer (no omp yet, an old omp, a broker that is down) is "cannot tell".
	ipc.handle(IPC_COMMANDS.MODELS_SIGNED_IN, async () => {
		try {
			const env = await shellSpawnEnv();
			const result = await stockHelperRequest<{ signedIn: boolean }>(
				"accounts.signedIn",
				{ env },
				{ timeoutMs: SIGNED_IN_TIMEOUT_MS },
			);
			return result.signedIn;
		} catch {
			return null;
		}
	});

	ipc.handle(IPC_COMMANDS.MODELS_PROVIDER_UPSERT, (caller, input: CustomProviderInput, device?: unknown) =>
		machineFor(caller, device).upsertProvider(input),
	);

	ipc.handle(IPC_COMMANDS.MODELS_PROVIDER_DELETE, (caller, id: string, device?: unknown) =>
		machineFor(caller, device).deleteProvider(id),
	);

	ipc.handle(
		IPC_COMMANDS.MODELS_OVERRIDE_SET,
		(caller, provider: unknown, modelId: unknown, override: unknown, device?: unknown) => {
			if (typeof provider !== "string" || !provider || typeof modelId !== "string" || !modelId) {
				throw codedError("invalid_preference_key", "Invalid model override target");
			}
			return machineFor(caller, device).setModelOverride(
				provider,
				modelId,
				ModelOverrideInputSchema.nullable().parse(override),
			);
		},
	);

	// Account rotation is per machine: a paired host's tabs follow the host's own pref.
	ipc.handle(IPC_COMMANDS.ACCOUNT_ROTATION_GET, (caller, device?: unknown) =>
		machineFor(caller, device).accountRotation(),
	);

	ipc.handle(IPC_COMMANDS.ACCOUNT_ROTATION_SET, (caller, mode: unknown, device?: unknown) => {
		if (!isAccountRotationMode(mode)) throw codedError("invalid_preference_key", "Invalid account rotation");
		return machineFor(caller, device).setAccountRotation(mode);
	});

	ipc.handle(IPC_COMMANDS.BUILTIN_REA_GET, (caller, device?: unknown) => machineFor(caller, device).builtinRea());
	ipc.handle(IPC_COMMANDS.BUILTIN_REA_SET, (caller, enabled: unknown, device?: unknown) => {
		if (typeof enabled !== "boolean") throw codedError("invalid_preference_key", "Invalid built-in REA preference");
		return machineFor(caller, device).setBuiltinRea(enabled);
	});
	ipc.handle(IPC_COMMANDS.HOST_DESKTOP_GET, (caller, device?: unknown) => machineFor(caller, device).desktop());
	ipc.handle(IPC_COMMANDS.HOST_DESKTOP_UPDATE, (caller, action: unknown, device?: unknown) => {
		if (action !== "check" && action !== "download" && action !== "install") {
			throw codedError("invalid_preference_key", "Invalid update action");
		}
		return machineFor(caller, device).desktopUpdate(action);
	});
	// omp's own update on a paired host: that host's OmpUpdater runs it; its state changes come back as pushed events.
	ipc.handle(IPC_COMMANDS.HOST_OMP_UPDATE_GET, (caller, device?: unknown) => machineFor(caller, device).ompUpdate());
	ipc.handle(IPC_COMMANDS.HOST_OMP_UPDATE_NOW, (caller, device?: unknown) =>
		machineFor(caller, device).startOmpUpdate(),
	);

	// "Edit config" — open the agent's models.yml in the system editor. The
	// file is created with a minimal skeleton when missing so there is always
	// something to edit; when no editor association exists, reveal it in the
	// file manager instead. A paired host's file is out of this editor's reach:
	// its providers are edited in-app.
	ipc.handle(IPC_COMMANDS.MODELS_CONFIG_OPEN, async (_caller, device?: unknown) => {
		if (deviceOf(device)) throw codedError("remote_path_native", "The models file is on another device");
		const file = modelsPath();
		if (!existsSync(file)) {
			await fsp.mkdir(path.dirname(file), { recursive: true });
			await fsp.writeFile(file, "# Custom model providers.\nproviders: {}\n", "utf8");
		}
		const openError = await shell.openPath(file);
		if (openError) shell.showItemInFolder(file);
		return { path: file, opened: !openError };
	});

	// Workspace filesystem — node:fs against the tab's cwd (src/main/workspace-fs.ts);
	// works without a live sidecar session and never throws (renderer reads
	// ok/error). A tab on a paired host reads that host's disk, with the same
	// confinement and caps.
	const remoteFs = async <T>(
		target: { tabId: string; sidecar: SidecarLike; device: string },
		method: string,
		params: object,
		fail: (error: string, code: IpcErrorCode | undefined) => T,
		wire: { timeoutMs?: number; decode?: (raw: unknown) => T } = {},
	): Promise<T> => {
		try {
			const raw = await remoteDevices.request<T>(
				target.device,
				method,
				{ ...params, rtab: target.tabId, cwd: target.sidecar.cwd },
				wire.timeoutMs,
			);
			return wire.decode ? wire.decode(raw) : raw;
		} catch (err) {
			return fail(err instanceof Error ? err.message : String(err), ipcErrorCode(err));
		}
	};

	ipc.handle(IPC_COMMANDS.FS_LIST, async (caller, payload: IpcFsListPayload): Promise<IpcFsListResult> => {
		const target = targetFor(deps, caller, payload?.tabId);
		const request = { path: payload?.path, maxDepth: payload?.maxDepth, maxEntries: payload?.maxEntries };
		if (target?.device) {
			return remoteFs({ ...target, device: target.device }, "fs.list", request, (error, code) => ({
				ok: false,
				entries: [],
				truncated: false,
				error,
				...(code ? { code } : {}),
			}));
		}
		return listWorkspace(cwdFor(deps, caller, payload?.tabId), request);
	});

	ipc.handle(IPC_COMMANDS.FS_READ, async (caller, payload: IpcFsReadPayload): Promise<IpcFsReadResult> => {
		const target = targetFor(deps, caller, payload?.tabId);
		const request = { path: payload?.path, maxBytes: payload?.maxBytes };
		if (target?.device) {
			return remoteFs({ ...target, device: target.device }, "fs.read", request, (error, code) => ({
				ok: false,
				content: "",
				truncated: false,
				binary: false,
				size: 0,
				error,
				...(code ? { code } : {}),
			}));
		}
		return readWorkspaceFile(cwdFor(deps, caller, payload?.tabId), request);
	});

	ipc.handle(
		IPC_COMMANDS.FS_STAT,
		async (caller, payload: { path?: unknown; tabId?: string }): Promise<IpcFsStatResult> => {
			const target = targetFor(deps, caller, payload?.tabId);
			if (target?.device) {
				return remoteFs(
					{ ...target, device: target.device },
					"fs.stat",
					{ path: payload?.path },
					(error, code) => ({ ok: false, mtimeMs: 0, size: 0, error, ...(code ? { code } : {}) }),
				);
			}
			return statWorkspacePath(cwdFor(deps, caller, payload?.tabId), payload?.path);
		},
	);

	// Files panel writes; a paired host's tab writes on that host (which trashes through its own shell).
	ipc.handle(
		IPC_COMMANDS.FS_MUTATE,
		async (caller, payload: { mutation: IpcFsMutation; tabId?: string }): Promise<IpcFsMutateResult> => {
			const target = targetFor(deps, caller, payload?.tabId);
			if (target?.device) {
				return remoteFs(
					{ ...target, device: target.device },
					"fs.mutate",
					{ mutation: payload?.mutation },
					(error, code) => ({ ok: false, error, ...(code ? { code } : {}) }),
				);
			}
			return mutateWorkspace(cwdFor(deps, caller, payload?.tabId), payload?.mutation, abs => shell.trashItem(abs));
		},
	);

	ipc.handle(
		IPC_COMMANDS.FS_SEARCH,
		async (caller, payload: { request: unknown; tabId?: string }): Promise<IpcFsSearchResult> => {
			const target = targetFor(deps, caller, payload?.tabId);
			if (target?.device) {
				return remoteFs(
					{ ...target, device: target.device },
					"fs.search",
					{ request: payload?.request },
					(error, code) => ({
						ok: false,
						matches: [],
						files: 0,
						limited: false,
						error,
						...(code ? { code } : {}),
					}),
				);
			}
			return searchWorkspace(cwdFor(deps, caller, payload?.tabId), payload?.request, stockHelperRequest);
		},
	);

	ipc.handle(
		IPC_COMMANDS.FS_READ_IMAGE,
		async (caller, payload: IpcFsReadImagePayload): Promise<IpcFsReadImageResult> => {
			const target = targetFor(deps, caller, payload?.tabId);
			const request = { path: payload?.path };
			if (target?.device) {
				return remoteFs({ ...target, device: target.device }, "fs.readImage", request, (error, code) => ({
					ok: false,
					dataUrl: null,
					mime: null,
					size: 0,
					error,
					...(code ? { code } : {}),
				}));
			}
			return readWorkspaceImage(cwdFor(deps, caller, payload?.tabId), request);
		},
	);

	ipc.handle(
		IPC_COMMANDS.FS_READ_BINARY,
		async (caller, payload: IpcFsReadBinaryPayload): Promise<IpcFsReadBinaryResult> => {
			const target = targetFor(deps, caller, payload?.tabId);
			const request = { path: payload?.path, maxBytes: payload?.maxBytes };
			if (target?.device) {
				return remoteFs(
					{ ...target, device: target.device },
					"host.fs.readBinary",
					request,
					(error, code) => ({
						ok: false,
						data: new Uint8Array(0),
						mime: "application/octet-stream",
						size: 0,
						truncated: false,
						error,
						...(code ? { code } : {}),
					}),
					{ timeoutMs: HOST_FS_READ_BINARY_TIMEOUT_MS, decode: decodeBinaryRead },
				);
			}
			return readWorkspaceBinary(cwdFor(deps, caller, payload?.tabId), request);
		},
	);

	// A player's stream URL: same resolution and roots as FS_READ_BINARY, audio/video only.
	// A paired host's tab has none (`remote_path_native`): the renderer reads it through
	// `host.fs.readBinary` under the host's cap instead.
	const streamOwners = new Set<number>();
	ipc.handle(
		IPC_COMMANDS.FS_MEDIA_STREAM,
		async (caller, payload: IpcFsMediaStreamPayload): Promise<IpcFsMediaStreamResult> => {
			const target = targetFor(deps, caller, payload?.tabId);
			if (target?.device) {
				return { ok: false, error: "This file is on a paired device", code: "remote_path_native" };
			}
			const media = await resolveWorkspaceMedia(cwdFor(deps, caller, payload?.tabId), payload?.path);
			if (!media.ok) return media;
			const owner = caller.sender.id;
			if (!streamOwners.has(owner)) {
				streamOwners.add(owner);
				caller.sender.once("destroyed", () => {
					streamOwners.delete(owner);
					deps.mediaStreams.releaseOwner(owner);
				});
			}
			return {
				ok: true,
				url: deps.mediaStreams.open(media.abs, media.mime, owner),
				mime: media.mime,
				size: media.size,
			};
		},
	);
	ipc.on(IPC_COMMANDS.FS_MEDIA_RELEASE, (caller, url: unknown) => deps.mediaStreams.release(url, caller.sender.id));

	ipc.handle(
		IPC_COMMANDS.FS_READ_PLAN,
		async (caller, payload: IpcFsReadPlanPayload): Promise<IpcFsReadPlanResult> => {
			const target = targetFor(deps, caller, payload?.tabId);
			const request = { fsPath: payload?.fsPath, localRoot: payload?.localRoot ?? null };
			if (target?.device) {
				return remoteFs({ ...target, device: target.device }, "fs.readPlan", request, (error, code) => ({
					ok: false,
					path: null,
					content: null,
					error,
					...(code ? { code } : {}),
				}));
			}
			return readPlanFile(cwdFor(deps, caller, payload?.tabId), sessionIndex.sessionsDir, request);
		},
	);

	ipc.handle(IPC_COMMANDS.SIDECAR_STATUS_GET, caller => {
		const sidecar = sidecarFor(deps, caller);
		return sidecar
			? { ...sidecar.statusPayload, cwd: sidecar.cwd }
			: { status: "starting", cwd: cwdFor(deps, caller) ?? "" };
	});

	// ========================================================================
	// Remote devices — this computer as a host, and the hosts it is paired with.
	// ========================================================================
	ipc.handle(IPC_COMMANDS.REMOTE_GET_STATE, () => remoteDevices.state());
	ipc.handle(IPC_COMMANDS.REMOTE_SET_HOST_ENABLED, (_caller, enabled: unknown) =>
		remoteDevices.setHostEnabled(enabled === true),
	);
	ipc.handle(IPC_COMMANDS.REMOTE_SET_DEVICE_NAME, (_caller, name: unknown) => remoteDevices.setDeviceName(name));
	ipc.handle(IPC_COMMANDS.REMOTE_SET_KEEP_AWAKE, (_caller, enabled: unknown) =>
		remoteDevices.setKeepAwake(enabled === true),
	);
	ipc.handle(IPC_COMMANDS.REMOTE_ROTATE_CODE, () => remoteDevices.rotateCode());
	ipc.handle(IPC_COMMANDS.REMOTE_REVOKE_PEER, (_caller, deviceId: unknown) => remoteDevices.revokePeer(deviceId));
	ipc.handle(IPC_COMMANDS.REMOTE_SET_PEER_LIMITS, (_caller, payload: unknown) => remoteDevices.setPeerLimits(payload));
	ipc.handle(IPC_COMMANDS.REMOTE_DISCOVER, (_caller, action: unknown) => remoteDevices.discover(action));
	ipc.handle(IPC_COMMANDS.REMOTE_PAIR, (_caller, payload: unknown) => remoteDevices.pair(payload));
	ipc.handle(IPC_COMMANDS.REMOTE_REMOVE_HOST, (_caller, deviceId: unknown) => remoteDevices.removeHost(deviceId));
	ipc.handle(IPC_COMMANDS.REMOTE_LIST_DIRS, (_caller, payload: IpcRemoteListDirsPayload) =>
		remoteDevices.listDirs(payload?.deviceId, payload?.path, payload?.query),
	);

	// External-editor round trip ($VISUAL/$EDITOR, temp file, exit-0 read-back)
	// for the composer editor dialog. Result shape carries availability +
	// cancellation so the renderer never has to catch.
	ipc.handle(IPC_COMMANDS.EDITOR_OPEN_EXTERNAL, async (_caller, payload: { content?: string }) => {
		if (!(await resolveEditorCommand())) {
			return {
				ok: false,
				unavailable: true as const,
				text: null,
				error: "Set $VISUAL or $EDITOR to use an external editor",
				code: "editor_unset" as const,
			};
		}
		try {
			const { text } = await openInExternalEditor(typeof payload?.content === "string" ? payload.content : "");
			return { ok: true, unavailable: false as const, text };
		} catch (err) {
			return {
				ok: false,
				unavailable: false as const,
				text: null,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	});
}

function broadcast(windowManager: WindowManager, channel: string, data: unknown): void {
	for (const win of windowManager.getAllWindows()) {
		if (!win.isDestroyed()) {
			win.webContents.send(channel, data);
		}
	}
}

/** Stock omp's `AgentToolResult` content for a GUI host tool's plain-text outcome. */
function textToolResult(text: string): { content: Array<{ type: "text"; text: string }> } {
	return { content: [{ type: "text", text }] };
}

/** Execute GUI-registered host tools. Returns undefined for unknown tools. */
function executeGuiHostTool(name: string, args: Record<string, unknown>): string | undefined {
	switch (name) {
		case "gui_open_url": {
			const url = typeof args.url === "string" ? args.url : "";
			if (url.startsWith("https://") || url.startsWith("http://")) {
				void shell.openExternal(url);
				return "Opened in browser";
			}
			return `Invalid URL: ${url}`;
		}
		case "gui_notify": {
			const title = typeof args.title === "string" ? args.title : "Notification";
			const body = typeof args.body === "string" ? args.body : "";
			appNotification({ title, body }).show();
			return "Notification shown";
		}
		case "gui_clipboard_read": {
			return clipboard.readText();
		}
		default:
			return undefined;
	}
}

/**
 * One window's benchmark or model setup research on a paired host: `running`
 * remembers the host so closing the window aborts it there, and a link
 * failure comes back as the result's error.
 */
async function runTracked<T>(
	running: Map<number, string>,
	senderId: number,
	device: string,
	run: () => Promise<T>,
): Promise<T | { success: false; error: string; code?: IpcErrorCode }> {
	running.set(senderId, device);
	try {
		return await run();
	} catch (err) {
		const code = ipcErrorCode(err);
		return { success: false, error: err instanceof Error ? err.message : String(err), ...(code ? { code } : {}) };
	} finally {
		if (running.get(senderId) === device) running.delete(senderId);
	}
}
