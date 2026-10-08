/**
 * Registers all IPC handlers and wires sidecar events to renderer windows.
 *
 * A tab on a paired host (`device`) runs its omp there, so every handler
 * that reads or writes the machine running omp — sessions, workspace files,
 * launch profiles, project switches — goes to that host through
 * RemoteDevices. Native open/reveal of a host path is refused
 * (`remote_path_native`): this machine cannot see that disk.
 */
import { existsSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserWindow, clipboard, dialog, ipcMain, Notification, shell } from "electron";
import Store from "electron-store";
import { codedError, type IpcErrorCode, ipcErrorCode } from "../shared/ipc-error-codes";
import type {
	CustomProviderInput,
	IpcBenchmarkRunOptions,
	IpcBenchmarkRunResult,
	IpcCloseTabPayload,
	IpcExtensionUiRespondPayload,
	IpcFsListPayload,
	IpcFsListResult,
	IpcFsReadImagePayload,
	IpcFsReadImageResult,
	IpcFsReadPayload,
	IpcFsReadPlanPayload,
	IpcFsReadPlanResult,
	IpcFsReadResult,
	IpcGetLaunchProfilePayload,
	IpcGetSessionOwnerPayload,
	IpcHostToolResultPayload,
	IpcHostToolUpdatePayload,
	IpcHostUriResultPayload,
	IpcNotifyPayload,
	IpcOpenPathResult,
	IpcPrefsGetPayload,
	IpcPrefsSetPayload,
	IpcRemoteListDirsPayload,
	IpcRpcCommandForTabPayload,
	IpcRpcCommandPayload,
	IpcSessionOpenNewWindowPayload,
	IpcSessionsDeletePayload,
	IpcSessionsListPayload,
	IpcSessionsRenamePayload,
	IpcSessionsSearchPayload,
	IpcSetActiveTabPayload,
	IpcSetTabViewPayload,
	IpcSidecarRestartPayload,
	IpcSpawnTabPayload,
	IpcStatsFetchPayload,
	IpcUpdateLaunchProfilePayload,
	SessionInfo,
	SessionKind,
} from "../shared/ipc-types";
import { IPC_COMMANDS, IPC_EVENTS, type RunProgressState, type TrayState } from "../shared/ipc-types";
import type { HostToolResult, HostToolUpdate, RpcCommand, RpcSessionState } from "../shared/rpc-types";
import { isUiLanguage } from "../shared/ui-language";
import { requestQuit } from "./app-quit";
import { BenchmarkRunner } from "./benchmark-runner";
import { ensureDefaultWorkspace } from "./default-workspace";
import { openInExternalEditor } from "./editor";
import { mainT } from "./i18n";
import { type LaunchProfilePrefs, readLaunchProfile, updateLaunchProfile } from "./launch-profile-store";
import { renameStoredSession } from "./local/session-files";
import type { LogWatcher } from "./log-watcher";
import { createMenu } from "./menu";
import { deleteModelsProvider, listModelsProviders, modelsPath, upsertModelsProvider } from "./models-config";
import { type OmpResolution, systemOmp } from "./omp-runtime";
import type { RemoteDevices } from "./remote/devices";
import { runtimeLogPath, writeRuntimeLog } from "./runtime-log";
import type { SessionIndex } from "./session-index";
import { resolveEditorCommand } from "./shell-env";
import type { SidecarLike, SidecarPool } from "./sidecar-pool";
import type { StatsClient } from "./stats-client";
import type { Revive } from "./stats-restart-policy";
import { spawnTabForWindow } from "./tab-spawn";
import { setTrayState } from "./tray";
import { aggregateTrayStatus } from "./tray-labels";
import { appVersion } from "./updater";
import type { SpawnWindow, WindowManager } from "./window";
import { sanitizeChromeColors, TOP_BAR_HEIGHT } from "./window-chrome";
import { listWorkspace, readPlanFile, readWorkspaceFile, readWorkspaceImage, resolveWithin } from "./workspace-fs";

export interface IpcDeps {
	sidecarPool: SidecarPool;
	sessionIndex: SessionIndex;
	statsClient: StatsClient;
	/** Demand-driven revive for the bundled stats server (no server → "exhausted"). */
	statsRestart: () => Revive;
	logWatcher: LogWatcher;
	windowManager: WindowManager;
	/** Both remote roles: the paired hosts tabs may run on, and this computer as a host. */
	remoteDevices: RemoteDevices;
	/** The system omp the benchmark runs (`omp bench`). */
	benchmarkOmp: () => Promise<OmpResolution>;
	benchmarkEnv: () => Promise<NodeJS.ProcessEnv>;
	/** Spawn a window with its own sidecar (index.ts's pool-backed helper). */
	spawnWindow: SpawnWindow;
	/** Where to start when the caller has no cwd. Never the volume root: a
	 * Finder-launched app's `process.cwd()` is "/", which no session belongs in. */
	initialCwd: () => string;
}

/**
 * Resolve the sidecar that owns the calling window. Routing derives from
 * `event.sender` (Electron guarantees it is the caller's webContents), never
 * from a client-supplied id. Null when the window has no sidecar bound yet.
 */
function sidecarFor(deps: IpcDeps, event: Electron.IpcMainInvokeEvent): SidecarLike | null {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (!win) return null;
	return deps.sidecarPool.sidecarForWindow(win);
}

/** The tab a handler acts on — `tabId`, else the calling window's active tab — with its device. */
function targetFor(deps: IpcDeps, event: Electron.IpcMainInvokeEvent, tabId?: string) {
	const win = BrowserWindow.fromWebContents(event.sender);
	return win ? deps.sidecarPool.tabTarget(win, typeof tabId === "string" ? tabId : undefined) : null;
}

/**
 * The calling window's working directory on THIS machine — the bound local
 * tab's cwd when one exists, else the cwd the window was created with (before
 * its sidecar binds, or while its active tab runs on a paired host).
 */
function cwdFor(deps: IpcDeps, event: Electron.IpcMainInvokeEvent, tabId?: string): string | null {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (!win) return null;
	const target = deps.sidecarPool.tabTarget(win, tabId);
	if (tabId) return target && !target.device ? target.sidecar.cwd : null;
	if (target && !target.device) return target.sidecar.cwd;
	return deps.windowManager.recordFor(win)?.cwd ?? null;
}

/** The caller's cwd when its active tab runs on `device` (undefined = this machine), else null. */
function cwdOnDevice(deps: IpcDeps, event: Electron.IpcMainInvokeEvent, device: string | undefined): string | null {
	if (!device) return cwdFor(deps, event);
	const target = targetFor(deps, event);
	return target?.device === device ? target.sidecar.cwd : null;
}

/** A payload's paired-host deviceId; anything else means this machine. */
function deviceOf(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

interface PrefsSchema {
	[key: string]: unknown;
}

// Dedupe state for SYSTEM_NOTIFY across multiple windows (see the handler).
let lastNotifyKey = "";
let lastNotifyAt = 0;

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
	const benchmarkRunners = new Map<number, BenchmarkRunner>();
	const { sidecarPool, sessionIndex, statsClient, logWatcher, windowManager, remoteDevices } = deps;
	const prefsStore = new Store<PrefsSchema>({ name: "prefs" });

	// Drop a closed window's tray/progress snapshot so the aggregate reflects
	// only live windows (and re-render the tray with the new aggregate).
	windowManager.subscribeWindowClosed(record => {
		trayStates.delete(record.id);
		progressStates.delete(record.id);
		benchmarkRunners.get(record.id)?.abort();
		benchmarkRunners.delete(record.id);
	});

	// Sidecar → owning-window event forwarding (events/status/extensionUi/
	// hostUriRequest/subagentFrame/commandsUpdate/configUpdate) is wired by
	// SidecarPool at acquire time. hostToolCall needs the main-process executor,
	// so the pool routes it through this callback (set once at startup). The
	// boolean tells the pool whether the tool was answered inline; only
	// renderer-forwarded calls get request-id → origin tracking (F-UI-ORIGIN).
	sidecarPool.hostToolExecutor = (sidecar, request, win) => {
		const result = executeGuiHostTool(request.toolName, request.arguments);
		if (result !== undefined) {
			sidecar.sendSideChannel({ type: "host_tool_result", id: request.id, result: textToolResult(result) });
			return true;
		}
		// Unknown host tools → forward to the owning renderer.
		if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.HOST_TOOL_CALL, { request });
		return false;
	};

	// Session index changes: this window set, and every device using this
	// computer as its host.
	sessionIndex.onChange = () => {
		broadcast(windowManager, IPC_EVENTS.SESSIONS_CHANGED, undefined);
		remoteDevices.hostSessionsChanged();
	};

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
	ipcMain.on(IPC_COMMANDS.RUNTIME_ERROR_REPORT, (event, report: unknown) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		writeRuntimeLog(report, {
			windowId: win?.webContents.id,
			cwd: win ? windowManager.recordFor(win)?.cwd : undefined,
		});
	});

	ipcMain.handle(IPC_COMMANDS.RUNTIME_LOG_PATH, () => runtimeLogPath());
	// Feedback dialog: last few runtime-error lines for the opt-in diagnostics
	// block. Tail-read so a large log doesn't have to be parsed end to end.
	ipcMain.handle(IPC_COMMANDS.RUNTIME_LOG_TAIL, async (_event, maxLines: unknown) => {
		const limit = typeof maxLines === "number" && maxLines > 0 ? Math.min(Math.floor(maxLines), 50) : 20;
		try {
			const stat = await fsp.stat(runtimeLogPath());
			const fd = await fsp.open(runtimeLogPath(), "r");
			try {
				const size = Math.min(stat.size, 256 * 1024);
				const { bytesRead, buffer } = await fd.read(Buffer.alloc(size), 0, size, stat.size - size);
				return buffer.subarray(0, bytesRead).toString("utf8").split("\n").filter(Boolean).slice(-limit);
			} finally {
				await fd.close();
			}
		} catch {
			return [];
		}
	});
	ipcMain.handle(IPC_COMMANDS.LOG_SNAPSHOT, () => logWatcher.getSnapshot());

	// RPC command passthrough — always returns a response, never throws.
	// Throwing here causes "Error occurred in handler" console spam AND
	// Tray/dock are app-global OS surfaces; with N parallel windows each pushing
	// its own state, aggregate per-window instead of last-write-wins (which made
	// the indicator flap with push order) or focus-gating (which let it go
	// stale). Status aggregates across windows: any error > streaming > waiting
	// > idle; the displayed blob is the most recently pushed one, with its
	// status replaced by the aggregate.
	ipcMain.on(IPC_EVENTS.TRAY_STATE_PUSH, (event, state: TrayState) => {
		const winId = BrowserWindow.fromWebContents(event.sender)?.webContents.id;
		if (winId === undefined) return;
		trayStates.set(winId, state);
		const aggregate = aggregateTrayStatus([...trayStates.values()]);
		setTrayState({ ...state, status: aggregate });
	});

	// Run-progress (terminal.showProgress): aggregate per-window the same way —
	// any window working → working, else any waiting → waiting, else idle.
	ipcMain.on(IPC_EVENTS.PROGRESS_SET, (event, state: RunProgressState) => {
		const winId = BrowserWindow.fromWebContents(event.sender)?.webContents.id;
		if (winId === undefined) return;
		progressStates.set(winId, state);
		windowManager.setRunProgress(aggregateProgress([...progressStates.values()]));
	});

	// Windows title-bar overlay: the caption buttons repaint in the theme's top-bar colors.
	ipcMain.on(IPC_EVENTS.WINDOW_CHROME_SET, (event, value: unknown) => {
		if (process.platform !== "win32") return;
		const colors = sanitizeChromeColors(value);
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!colors || !win || win.isDestroyed()) return;
		win.setTitleBarOverlay({ ...colors, height: TOP_BAR_HEIGHT });
	});

	const dispatchRpcCommand = async (
		win: BrowserWindow,
		sidecar: SidecarLike | null,
		issuerTabId: string | null,
		payload: IpcRpcCommandPayload,
	) => {
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
		// F-OWN refuse-or-focus backstop: a switch_session onto a file a
		// DIFFERENT tab owns would double-attach it (the owner itself re-attaches
		// freely). Refuse BEFORE dispatch — the sidecar would attach for real
		// and silently diverge the owner's file. The renderer pre-check routes
		// to the owner; this catches the race.
		if (cmd.type === "switch_session") {
			const blocker = sidecarPool.foreignSessionOwner(issuerTabId, cmd.sessionPath);
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
		try {
			let response = await client.command({ ...cmd, id: _id } as RpcCommand, payload.timeoutMs);
			// omp has no session kind: a chat tab is omp spawned with --no-tools,
			// so the tab's own kind is what get_state reports.
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
			// A login or logout writes the shared credential store; every tab's omp
			// re-reads it so a newly connected account's image model turns on everywhere.
			if (response.success && (cmd.type === "login" || cmd.type === "logout")) {
				for (const other of sidecarPool.allSidecars()) other.syncImageGeneration();
			}
			return response;
		} catch (err) {
			return {
				id: _id,
				type: "response",
				success: false,
				code: ipcErrorCode(err) ?? "rpc_delivery_unknown",
				error: err instanceof Error ? err.message : String(err),
			};
		}
	};

	ipcMain.handle(IPC_COMMANDS.RPC_COMMAND, async (event, payload: IpcRpcCommandPayload) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win)
			return { id: payload.command.id, type: "response", success: false, error: "No window", code: "no_window" };
		const issuerTabId = sidecarPool.activeTabForWindow(win);
		return dispatchRpcCommand(win, sidecarPool.sidecarForWindow(win), issuerTabId, payload);
	});

	// RPC addressed at a specific tab. Split panes use this for every command;
	// the shared dispatcher preserves the same ownership/cwd bookkeeping as the
	// focused-tab path.
	ipcMain.handle(IPC_COMMANDS.RPC_COMMAND_FOR_TAB, async (event, payload: IpcRpcCommandForTabPayload) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win)
			return { id: payload?.command?.id, type: "response", success: false, error: "No window", code: "no_window" };
		const sidecar = sidecarPool.sidecarForTab(win, payload.tabId);
		return dispatchRpcCommand(win, sidecar, payload.tabId, payload);
	});

	// Extension UI respond — F-UI-ORIGIN: route to the sidecar that RAISED the
	// request (tracked by request id), not the window's active tab; the user
	// may have switched tabs while the dialog was open. Unknown ids (raised
	// before tracking, or after a restart) fall back to the active sidecar.
	ipcMain.handle(IPC_COMMANDS.EXTENSION_UI_RESPOND, (event, payload: IpcExtensionUiRespondPayload) => {
		const { response } = payload;
		if (typeof response?.id === "string" && sidecarPool.routeSideChannel(response.id, response, true)) return;
		sidecarFor(deps, event)?.sendSideChannel(response);
	});

	// Host tool result — same origin routing as extension UI (verified: the
	// raise path is per-sidecar, but a naive sidecarFor response route would
	// misroute to the active tab after a switch).
	ipcMain.handle(IPC_COMMANDS.HOST_TOOL_RESULT, (event, payload: IpcHostToolResultPayload) => {
		const { result } = payload;
		if (typeof result?.id !== "string") return;
		const frame = stockHostToolResult(result);
		if (sidecarPool.routeSideChannel(result.id, frame, true)) return;
		sidecarFor(deps, event)?.sendSideChannel(frame);
	});

	// Host tool update — origin routing without unregistering: the result
	// frame follows and still needs the route.
	ipcMain.handle(IPC_COMMANDS.HOST_TOOL_UPDATE, (event, payload: IpcHostToolUpdatePayload) => {
		const { update } = payload;
		if (typeof update?.id !== "string") return;
		const frame = stockHostToolUpdate(update);
		if (sidecarPool.routeSideChannel(update.id, frame, false)) return;
		sidecarFor(deps, event)?.sendSideChannel(frame);
	});

	// Host URI result — same origin routing as extension UI.
	ipcMain.handle(IPC_COMMANDS.HOST_URI_RESULT, (event, payload: IpcHostUriResultPayload) => {
		const { result } = payload;
		if (typeof result?.id === "string" && sidecarPool.routeSideChannel(result.id, result, true)) return;
		sidecarFor(deps, event)?.sendSideChannel(result);
	});

	// Sessions. `device` names the paired host whose session index answers;
	// its sessions come back tagged with it.
	ipcMain.handle(IPC_COMMANDS.SESSIONS_LIST, async (event, payload: IpcSessionsListPayload) => {
		const scope = payload.scope === "local" ? "local" : "global";
		const device = deviceOf(payload.device);
		const cwd = cwdOnDevice(deps, event, device) ?? undefined;
		if (!device) return sessionIndex.list(scope, cwd);
		const sessions = await remoteDevices.request<SessionInfo[]>(device, "sessions.list", { scope, cwd });
		return sessions.map(info => ({ ...info, device }));
	});

	ipcMain.handle(IPC_COMMANDS.SESSIONS_DELETE, async (_event, payload: IpcSessionsDeletePayload) => {
		if (typeof payload.sessionPath !== "string" || !payload.sessionPath.endsWith(".jsonl")) {
			throw codedError("invalid_session_path", "Invalid session path");
		}
		const device = deviceOf(payload.device);
		const owner = sidecarPool.sessionOwner(payload.sessionPath, device);
		if (owner && sidecarPool.sessionOwnerIsLive(payload.sessionPath, device)) {
			const response = await sidecarPool.commandForIdleSession(
				payload.sessionPath,
				{ type: "drop_session" },
				device,
			);
			if (!response) throw codedError("session_running", "Session is currently running");
			if (!response.success) throw new Error(response.error);
			const cancelled = (response.data as { cancelled?: boolean } | undefined)?.cancelled ?? false;
			if (cancelled) throw codedError("session_delete_cancelled", "Session deletion was cancelled");
			// The owner moved on to a fresh, not-yet-saved session.
			sidecarPool.noteSessionFile(owner.tabId, null);
			return;
		}
		// Either no tab claims the file, or the claiming tab has no process (a
		// restored tab that was never shown). Nothing is loaded anywhere, so the
		// file IS the session — drop the tab's claim first so it cannot wake into
		// a path that no longer exists.
		if (owner) sidecarPool.noteSessionFile(owner.tabId, null);
		if (device) await remoteDevices.request(device, "sessions.delete", { sessionPath: payload.sessionPath });
		else await sessionIndex.deleteSession(payload.sessionPath);
	});

	ipcMain.handle(IPC_COMMANDS.SESSIONS_RENAME, async (_event, payload: IpcSessionsRenamePayload) => {
		if (typeof payload.sessionPath !== "string" || !payload.sessionPath.endsWith(".jsonl")) {
			throw codedError("invalid_session_path", "Invalid session path");
		}
		const name = typeof payload.name === "string" ? payload.name.trim() : "";
		if (!name) throw codedError("session_name_empty", "Session name cannot be empty");
		const device = deviceOf(payload.device);
		if (
			sidecarPool.sessionOwner(payload.sessionPath, device) &&
			sidecarPool.sessionOwnerIsLive(payload.sessionPath, device)
		) {
			// The owner's in-memory title must change with the file. Stock renames
			// mid-run (a user title also locks out the pending auto-title), so
			// unlike delete this does not wait for the tab to go idle.
			const command: RpcCommand = { type: "set_session_name", name, sessionPath: payload.sessionPath };
			const response = await sidecarPool.commandForSession(payload.sessionPath, command, device);
			if (!response) throw codedError("session_starting", "Session is still starting");
			if (!response.success) throw new Error(response.error);
			return;
		}
		// An owner with no process has no in-memory title to keep in step, so the
		// rename is the same stored-file edit it is for an unowned session.
		if (device) {
			await remoteDevices.request(device, "sessions.rename", { sessionPath: payload.sessionPath, name });
			return;
		}
		const omp = await systemOmp();
		if (!omp.ok) throw new Error(omp.error);
		await renameStoredSession(omp.runtime, payload.sessionPath, name);
	});

	// Open a session (or a fresh project window) in a NEW parallel window with
	// its own sidecar. The calling window's sidecar is left running untouched —
	// this is the explicit parallel action. Returns false at the pool cap.
	// F-OWN: when the session is already attached to a tab, focus the owner
	// window (win.show()+win.focus() — the codebase's focus pattern, see
	// deep-link.ts/tray.ts) instead of spawning a second sidecar for the same
	// file; resolves true because the session ends up foregrounded either way.
	// The session switch is done by the NEW window's renderer on boot (it pulls
	// pendingSessionPath and runs switch_session + hydrate itself), which avoids
	// racing the renderer's boot hydration and surfaces failures in that window.
	ipcMain.handle(IPC_COMMANDS.SESSION_OPEN_NEW_WINDOW, async (event, payload: IpcSessionOpenNewWindowPayload) => {
		const sessionPath = typeof payload?.sessionPath === "string" ? payload.sessionPath : undefined;
		const device = deviceOf(payload?.device);
		if (sessionPath) {
			const owner = deps.sidecarPool.sessionOwner(sessionPath, device);
			if (owner && deps.windowManager.focusWindowById(owner.winId)) return true;
		}
		if (deps.sidecarPool.atCap) return false;
		const requested = typeof payload?.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : undefined;
		const cwd =
			requested ??
			cwdOnDevice(deps, event, device) ??
			(device ? await remoteDefaultWorkspace(device) : deps.initialCwd());
		// The new window's sidecar must spawn with the target file's kind, or the
		// boot-time switch_session hits the agent-side kind guard and the pool
		// entry would lie about its kind (I1).
		const kind = sessionPath
			? device
				? await remoteKindFor(device, sessionPath)
				: await sessionIndex.kindFor(sessionPath)
			: undefined;
		return deps.spawnWindow(cwd, sessionPath, kind, device) !== null;
	});

	// Fresh window pulls the session it was opened to display (one-shot). The
	// renderer performs the actual switch_session + hydrate on boot, which
	// avoids racing the boot hydration and surfaces failures in that window.
	ipcMain.handle(IPC_COMMANDS.SESSION_CONSUME_PENDING, event => {
		const win = BrowserWindow.fromWebContents(event.sender);
		return win ? (deps.windowManager.consumePendingSession(win) ?? null) : null;
	});

	// ========================================================================
	// Session tabs — in-window parallel sessions. Each tab owns a pooled
	// sidecar bound to the CALLING window (no new BrowserWindow); the pool
	// moves full event forwarding to the window's active tab. Routing derives
	// from event.sender, so a renderer can only touch its own window's tabs.
	// ========================================================================

	// Spawn a background tab. Null at the pool cap; the renderer decides
	// whether to activate it (SET_ACTIVE_TAB) — spawn itself never switches.
	// F-OWN: a sessionPath already attached to a tab returns
	// { tabId: null, ownerTabId, ownerWinId, refusal: "owned" } — the renderer
	// switches to (or focuses) the owner instead of double-attaching the file.
	// F-KIND: an explicit payload kind that disagrees with the file's stamped
	// kind returns { tabId: null, refusal: "kind-mismatch" } (I3); an omitted
	// payload kind defers to the file. Decision logic lives in tab-spawn.ts so
	// both refusal contracts are unit-testable without an Electron runtime.
	ipcMain.handle(IPC_COMMANDS.SPAWN_TAB, (event, payload: IpcSpawnTabPayload) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win) return null;
		return spawnTabForWindow(
			{
				sidecarPool: deps.sidecarPool,
				sessionIndex,
				fallbackCwd: device => cwdOnDevice(deps, event, device),
				initialCwd: deps.initialCwd,
				defaultWorkspace: ensureDefaultWorkspace,
				remote: { kindFor: remoteKindFor, defaultWorkspace: remoteDefaultWorkspace },
			},
			win,
			payload,
		);
	});

	// Release a tab's sidecar. The window falls back to its initial no-tab
	// state when its last tab closes (welcome screen; handlers tolerate null).
	ipcMain.handle(IPC_COMMANDS.CLOSE_TAB, (event, payload: IpcCloseTabPayload) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win || typeof payload?.tabId !== "string") return false;
		if (!deps.sidecarPool.sidecarForTab(win, payload.tabId)) return false;
		return deps.sidecarPool.releaseTab(payload.tabId);
	});

	// Move full event forwarding to the window's active tab (listeners move,
	// never duplicate). The renderer calls this before hydrateSession().
	ipcMain.handle(IPC_COMMANDS.SET_ACTIVE_TAB, (event, payload: IpcSetActiveTabPayload) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win || typeof payload?.tabId !== "string") return false;
		return deps.sidecarPool.setActiveTab(win, payload.tabId);
	});

	ipcMain.handle(IPC_COMMANDS.SET_TAB_VIEW, (event, payload: IpcSetTabViewPayload) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win || typeof payload?.focusedTabId !== "string" || !Array.isArray(payload.visibleTabIds)) return false;
		return deps.sidecarPool.setTabView(win, payload.focusedTabId, payload.visibleTabIds, payload.split);
	});

	// Boot reconciliation: the window's tabs in acquisition order (the initial
	// sidecar is tab 0 — main minted its tabId at acquire).
	ipcMain.handle(IPC_COMMANDS.GET_TABS, event => {
		const win = BrowserWindow.fromWebContents(event.sender);
		return win ? deps.sidecarPool.tabsForWindow(win) : [];
	});

	// F-OWN: which tab/window owns a session file, if any. The renderer
	// belt-guards (open tab / open-in-new-window rows) consult this before
	// attempting an attach.
	ipcMain.handle(IPC_COMMANDS.GET_SESSION_OWNER, (_event, payload: IpcGetSessionOwnerPayload) => {
		return typeof payload?.sessionPath === "string"
			? deps.sidecarPool.sessionOwner(payload.sessionPath, deviceOf(payload.device))
			: null;
	});

	// Full-content search over session files (raw JSONL grep on the machine
	// holding them, scoped to the same candidate set the list view would show).
	ipcMain.handle(IPC_COMMANDS.SESSIONS_SEARCH, async (event, payload: IpcSessionsSearchPayload) => {
		const scope = payload.scope === "local" ? "local" : "global";
		const query = typeof payload.query === "string" ? payload.query : "";
		const device = deviceOf(payload.device);
		const cwd = cwdOnDevice(deps, event, device) ?? undefined;
		if (device) return remoteDevices.request<string[]>(device, "sessions.search", { query, scope, cwd });
		const candidates = await sessionIndex.list(scope, cwd);
		return sessionIndex.searchContent(
			query,
			candidates.map(info => info.path),
		);
	});

	// Stats
	ipcMain.handle(IPC_COMMANDS.STATS_FETCH, async (_event, payload: IpcStatsFetchPayload) => {
		if (typeof payload.path !== "string") {
			throw codedError("invalid_stats_path", "Invalid stats path");
		}
		if (!statsClient.port) {
			// Nothing is listening: ask for it and let the caller keep waiting — but
			// only while a revive is actually possible, so a permanently dead stats
			// server ends in an error instead of an endless "loading".
			const revive = deps.statsRestart();
			return {
				error: mainT(revive === "exhausted" ? "stats.notRunning" : "stats.notReady"),
				unavailable: revive !== "exhausted",
				// Dead for good (no revive left): the renderer shows a calm page-level state, not this text.
				stopped: revive === "exhausted",
			};
		}
		try {
			return await statsClient.fetch(payload.path, payload.params);
		} catch (err) {
			// A request that reached the server and failed is a failure, not a
			// booting server: the dashboard must show it, not retry for a budget.
			const msg = err instanceof Error ? err.message : String(err);
			return { error: msg, unavailable: false };
		}
	});

	ipcMain.handle(
		IPC_COMMANDS.BENCH_RUN,
		async (event, options: IpcBenchmarkRunOptions): Promise<IpcBenchmarkRunResult> => {
			const cwd = cwdFor(deps, event);
			if (!cwd) return { success: false, error: "No active workspace", code: "no_workspace" };
			const resolution = await deps.benchmarkOmp();
			if (!resolution.ok) return { success: false, error: resolution.error };
			const senderId = event.sender.id;
			const runner = benchmarkRunners.get(senderId) ?? new BenchmarkRunner();
			benchmarkRunners.set(senderId, runner);
			try {
				return await runner.run(resolution.runtime.bin, cwd, options, await deps.benchmarkEnv());
			} finally {
				if (!runner.running) benchmarkRunners.delete(senderId);
			}
		},
	);
	ipcMain.handle(IPC_COMMANDS.BENCH_ABORT, event => benchmarkRunners.get(event.sender.id)?.abort() ?? false);

	// Renderer-initiated quit (the `quit` command). Straight to the guard, never
	// `window.close()`: closing the focused window only hides the rest of the
	// session behind it.
	ipcMain.on(IPC_COMMANDS.APP_QUIT, () => {
		requestQuit();
	});

	// System
	ipcMain.handle(IPC_COMMANDS.SYSTEM_INFO, () => ({
		appVersion: appVersion(),
		platform: process.platform,
		arch: process.arch,
		osRelease: os.release(),
		electron: process.versions.electron ?? "?",
		chrome: process.versions.chrome ?? "?",
		node: process.versions.node ?? "?",
	}));
	ipcMain.handle(IPC_COMMANDS.SYSTEM_OPEN_EXTERNAL, async (_event, url: string) => {
		if (typeof url === "string" && (url.startsWith("https://") || url.startsWith("http://"))) {
			await shell.openExternal(url);
		}
	});

	// Tool-card path links — open a file in the system editor. "~" expands,
	// relative paths resolve inside the calling window's workspace (escapes
	// refused), absolute paths pass through: the agent can legitimately touch
	// files outside the workspace. When no editor association exists, reveal
	// the file in the file manager instead of failing.
	ipcMain.handle(
		IPC_COMMANDS.SYSTEM_OPEN_PATH,
		async (event, target: string, tabId?: string): Promise<IpcOpenPathResult> => {
			// A paired host's path means nothing to this machine's editor; the
			// renderer falls back to the in-app preview (forwarded fs read).
			if (targetFor(deps, event, tabId)?.device) {
				return { ok: false, error: "The file is on another device", code: "remote_path_native" };
			}
			if (typeof target !== "string" || !target.trim())
				return { ok: false, error: "Empty path", code: "empty_path" };
			let resolved = target.startsWith("~/") ? path.join(os.homedir(), target.slice(2)) : target;
			if (!path.isAbsolute(resolved)) {
				const rootAbs = cwdFor(deps, event, tabId);
				if (!rootAbs) return { ok: false, error: "No workspace", code: "no_workspace" };
				const within = resolveWithin(rootAbs, resolved);
				if (!within) return { ok: false, error: "Path escapes the workspace", code: "path_escapes_workspace" };
				resolved = within;
			}
			// A stale tool card can reference a file that no longer exists (or never
			// did outside the workspace). Both openPath and showItemInFolder fail
			// silently on missing paths, so detect it here and let the link toast.
			try {
				await fsp.access(resolved);
			} catch {
				return { ok: false, error: "File not found", code: "file_not_found" };
			}
			const openError = await shell.openPath(resolved);
			if (!openError) return { ok: true, resolvedPath: resolved };
			shell.showItemInFolder(resolved);
			return { ok: true, resolvedPath: resolved };
		},
	);

	// "Show in Finder" for an absolute path the renderer already knows (agent definition files).
	ipcMain.handle(
		IPC_COMMANDS.SYSTEM_REVEAL_PATH,
		async (event, target: string, tabId?: string): Promise<IpcOpenPathResult> => {
			if (targetFor(deps, event, tabId)?.device) {
				return { ok: false, error: "The file is on another device", code: "remote_path_native" };
			}
			if (typeof target !== "string" || !path.isAbsolute(target)) {
				return { ok: false, error: "Not an absolute path", code: "not_absolute_path" };
			}
			try {
				await fsp.access(target);
			} catch {
				return { ok: false, error: "File not found", code: "file_not_found" };
			}
			shell.showItemInFolder(target);
			return { ok: true, resolvedPath: target };
		},
	);

	ipcMain.handle(
		IPC_COMMANDS.SYSTEM_SAVE_DIALOG,
		async (event, defaultPath?: string, filters?: { name: string; extensions: string[] }[]) => {
			const win = BrowserWindow.fromWebContents(event.sender);
			if (!win) return null;
			const result = await dialog.showSaveDialog(win, {
				defaultPath: defaultPath ?? "session.html",
				filters: filters ?? [{ name: "HTML", extensions: ["html"] }],
			});
			return result.canceled ? null : (result.filePath ?? null);
		},
	);

	ipcMain.handle(
		IPC_COMMANDS.SYSTEM_OPEN_DIALOG,
		async (
			event,
			filters?: { name: string; extensions: string[] }[],
			options?: { directory?: boolean; title?: string; buttonLabel?: string },
		) => {
			const win = BrowserWindow.fromWebContents(event.sender);
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

	ipcMain.handle(IPC_COMMANDS.SYSTEM_CLIPBOARD_READ, () => {
		return clipboard.readText();
	});

	ipcMain.handle(IPC_COMMANDS.SYSTEM_NOTIFY, (event, payload: IpcNotifyPayload) => {
		if (typeof payload.title === "string") {
			// Dedupe within a window (a turn can emit the same notification from
			// several renderers), but NOT across windows — two parallel sessions
			// finishing in different windows are distinct events the user wants.
			const winId = BrowserWindow.fromWebContents(event.sender)?.webContents.id ?? 0;
			const key = `${winId}${payload.title}${payload.body ?? ""}`;
			const now = Date.now();
			if (key === lastNotifyKey && now - lastNotifyAt < 1500) return;
			lastNotifyKey = key;
			lastNotifyAt = now;
			new Notification({ title: payload.title, body: payload.body ?? "" }).show();
		}
	});

	// Preferences
	ipcMain.handle(IPC_COMMANDS.PREFS_GET, (_event, payload: IpcPrefsGetPayload) => {
		if (payload.key) {
			return prefsStore.get(payload.key);
		}
		return prefsStore.store;
	});

	ipcMain.handle(IPC_COMMANDS.PREFS_SET, (_event, payload: IpcPrefsSetPayload) => {
		if (typeof payload.key !== "string") {
			throw codedError("invalid_preference_key", "Invalid preference key");
		}
		prefsStore.set(payload.key, payload.value);
		if (payload.key === "language" && isUiLanguage(payload.value)) {
			createMenu(windowManager, deps.spawnWindow);
		}
	});

	// Launch profiles live with the machine that spawns omp: a tab's paired
	// host keeps its own.
	const launchProfilePrefs: LaunchProfilePrefs = {
		get: key => prefsStore.get(key),
		set: (key, value) => prefsStore.set(key, value),
	};
	ipcMain.handle(IPC_COMMANDS.PREFS_GET_LAUNCH_PROFILE, (_event, payload: IpcGetLaunchProfilePayload) => {
		const device = deviceOf(payload?.device);
		return device
			? remoteDevices.request(device, "launchProfile.get", { cwd: payload.cwd })
			: readLaunchProfile(launchProfilePrefs, payload?.cwd);
	});

	ipcMain.handle(IPC_COMMANDS.PREFS_UPDATE_LAUNCH_PROFILE, (_event, payload: IpcUpdateLaunchProfilePayload) => {
		const device = deviceOf(payload?.device);
		return device
			? remoteDevices.request(device, "launchProfile.update", { cwd: payload.cwd, patch: payload.patch })
			: updateLaunchProfile(launchProfilePrefs, payload?.cwd, payload?.patch);
	});

	// Sidecar control
	ipcMain.handle(IPC_COMMANDS.SIDECAR_RESTART, (event, payload?: IpcSidecarRestartPayload) => {
		const win = BrowserWindow.fromWebContents(event.sender);
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
	ipcMain.handle(IPC_COMMANDS.SIDECAR_SELECT_PROJECT, async event => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win) return null;
		const target = targetFor(deps, event);
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
	ipcMain.handle(IPC_COMMANDS.SIDECAR_SET_PROJECT, async (event, payload: { cwd?: string }) => {
		const cwd = payload?.cwd;
		if (typeof cwd !== "string" || cwd.length === 0) return false;
		const target = targetFor(deps, event);
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
		const win = BrowserWindow.fromWebContents(event.sender);
		if (win) windowManager.setRecordCwd(win, cwd);
		target.sidecar.restart(cwd);
		return true;
	});

	ipcMain.handle(IPC_COMMANDS.SIDECAR_DEFAULT_WORKSPACE, () => ensureDefaultWorkspace());

	ipcMain.handle(IPC_COMMANDS.MODELS_PROVIDERS_LIST, () => {
		return listModelsProviders();
	});

	ipcMain.handle(IPC_COMMANDS.MODELS_PROVIDER_UPSERT, (_event, input: CustomProviderInput) => {
		upsertModelsProvider(input);
	});

	ipcMain.handle(IPC_COMMANDS.MODELS_PROVIDER_DELETE, (_event, id: string) => {
		deleteModelsProvider(id);
	});

	// "Edit config" — open the agent's models.yml in the system editor. The
	// file is created with a minimal skeleton when missing so there is always
	// something to edit; when no editor association exists, reveal it in the
	// file manager instead.
	ipcMain.handle(IPC_COMMANDS.MODELS_CONFIG_OPEN, async () => {
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
	): Promise<T> => {
		try {
			return await remoteDevices.request<T>(target.device, method, {
				...params,
				rtab: target.tabId,
				cwd: target.sidecar.cwd,
			});
		} catch (err) {
			return fail(err instanceof Error ? err.message : String(err), ipcErrorCode(err));
		}
	};

	ipcMain.handle(IPC_COMMANDS.FS_LIST, async (event, payload: IpcFsListPayload): Promise<IpcFsListResult> => {
		const target = targetFor(deps, event, payload?.tabId);
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
		return listWorkspace(cwdFor(deps, event, payload?.tabId), request);
	});

	ipcMain.handle(IPC_COMMANDS.FS_READ, async (event, payload: IpcFsReadPayload): Promise<IpcFsReadResult> => {
		const target = targetFor(deps, event, payload?.tabId);
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
		return readWorkspaceFile(cwdFor(deps, event, payload?.tabId), request);
	});

	ipcMain.handle(
		IPC_COMMANDS.FS_READ_IMAGE,
		async (event, payload: IpcFsReadImagePayload): Promise<IpcFsReadImageResult> => {
			const target = targetFor(deps, event, payload?.tabId);
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
			return readWorkspaceImage(cwdFor(deps, event, payload?.tabId), request);
		},
	);

	ipcMain.handle(
		IPC_COMMANDS.FS_READ_PLAN,
		async (event, payload: IpcFsReadPlanPayload): Promise<IpcFsReadPlanResult> => {
			const target = targetFor(deps, event, payload?.tabId);
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
			return readPlanFile(cwdFor(deps, event, payload?.tabId), sessionIndex.sessionsDir, request);
		},
	);

	ipcMain.handle(IPC_COMMANDS.SIDECAR_STATUS_GET, event => {
		const sidecar = sidecarFor(deps, event);
		return sidecar
			? { ...sidecar.statusPayload, cwd: sidecar.cwd }
			: { status: "starting", cwd: cwdFor(deps, event) ?? "" };
	});

	// ========================================================================
	// Remote devices — this computer as a host, and the hosts it is paired with.
	// ========================================================================
	ipcMain.handle(IPC_COMMANDS.REMOTE_GET_STATE, () => remoteDevices.state());
	ipcMain.handle(IPC_COMMANDS.REMOTE_SET_HOST_ENABLED, (_event, enabled: unknown) =>
		remoteDevices.setHostEnabled(enabled === true),
	);
	ipcMain.handle(IPC_COMMANDS.REMOTE_SET_DEVICE_NAME, (_event, name: unknown) => remoteDevices.setDeviceName(name));
	ipcMain.handle(IPC_COMMANDS.REMOTE_ROTATE_CODE, () => remoteDevices.rotateCode());
	ipcMain.handle(IPC_COMMANDS.REMOTE_REVOKE_PEER, (_event, deviceId: unknown) => remoteDevices.revokePeer(deviceId));
	ipcMain.handle(IPC_COMMANDS.REMOTE_DISCOVER, (_event, action: unknown) => remoteDevices.discover(action));
	ipcMain.handle(IPC_COMMANDS.REMOTE_PAIR, (_event, payload: unknown) => remoteDevices.pair(payload));
	ipcMain.handle(IPC_COMMANDS.REMOTE_REMOVE_HOST, (_event, deviceId: unknown) => remoteDevices.removeHost(deviceId));
	ipcMain.handle(IPC_COMMANDS.REMOTE_LIST_DIRS, (_event, payload: IpcRemoteListDirsPayload) =>
		remoteDevices.listDirs(payload?.deviceId, payload?.path),
	);

	// External-editor round trip ($VISUAL/$EDITOR, temp file, exit-0 read-back)
	// for the composer editor dialog. Result shape carries availability +
	// cancellation so the renderer never has to catch.
	ipcMain.handle(IPC_COMMANDS.EDITOR_OPEN_EXTERNAL, async (_event, payload: { content?: string }) => {
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

/**
 * Stock omp's `AgentToolResult` (`{ content, isError }`) built from the GUI's
 * plain-text host tool outcome; the renderer IPC keeps its `result`/`error`
 * string shape and main translates at the wire.
 */
function textToolResult(text: string): { content: Array<{ type: "text"; text: string }> } {
	return { content: [{ type: "text", text }] };
}

function stockHostToolResult(frame: HostToolResult): object {
	const failed = frame.error !== undefined;
	return {
		type: "host_tool_result",
		id: frame.id,
		result: textToolResult(failed ? (frame.error ?? "") : (frame.result ?? "")),
		...(failed ? { isError: true } : {}),
	};
}

function stockHostToolUpdate(frame: HostToolUpdate): object {
	return { type: "host_tool_update", id: frame.id, partialResult: textToolResult(frame.update) };
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
			new Notification({ title, body }).show();
			return "Notification shown";
		}
		case "gui_clipboard_read": {
			return clipboard.readText();
		}
		default:
			return undefined;
	}
}
