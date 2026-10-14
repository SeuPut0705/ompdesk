/**
 * Main process entry point for ompdesk.
 * App lifecycle: ready → window, sidecar, session index, IPC, tray, menu, deep links, updater.
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
	app,
	BrowserWindow,
	globalShortcut,
	ipcMain,
	nativeImage,
	powerSaveBlocker,
	protocol,
	session,
} from "electron";
import Store from "electron-store";
import { USER_PROFILE_PREF } from "../../resources/gui-bridge/user-profile-contracts";
import { ACCOUNT_ROTATION_LEDGER_FILE, ACCOUNT_ROTATION_PREF } from "../shared/account-rotation";
import { REA_PREF } from "../shared/builtin-mcp";
import { nativeAccelerator } from "../shared/hotkeys";
import { IPC_COMMANDS, IPC_EVENTS, type SessionKind } from "../shared/ipc-types";
import { REPLY_LANGUAGE_PREF } from "../shared/reply-language";
import { accountRotationDeps } from "./account-rotation";
import { installQuitGuard, requestQuit } from "./app-quit";
import { type BridgeConnectResult, BridgeHealth } from "./bridge-health";
import { setupDeepLinks } from "./deep-link";
import { ensureDefaultWorkspace } from "./default-workspace";
import { createGithubAuthService, registerGithubAuthIpc } from "./github-auth/ipc";
import type { GithubAuthService } from "./github-auth/service";
import { applyGpuFallbackIfNeeded, handleGpuProcessGone } from "./gpu-fallback";
import { mainT } from "./i18n";
import { firstUsableCwd } from "./initial-cwd";
import { registerIpcHandlers } from "./ipc";
import { migrateLegacyUserData } from "./legacy-user-data";
import { renameStoredSession } from "./local/session-files";
import { LogWatcher } from "./log-watcher";
import { LocalMachine } from "./machine-services";
import { MEDIA_SCHEME, MediaStreams } from "./media-stream";
import { createMenu } from "./menu";
import { ompPackageRoot, ompPathEnv, systemOmp } from "./omp-runtime";
import { RemoteDevices } from "./remote/devices";
import { LocalHostServices } from "./remote/host-services";
import { writeRuntimeLog } from "./runtime-log";
import { SessionIndex } from "./session-index";
import { SessionKindStore } from "./session-kinds";
import { registerSetupIpc } from "./setup/ipc";
import { applyManagedToolEnv, bunInstallDir, managedToolsDir, setupPlatform } from "./setup/paths";
import { SetupService } from "./setup/service";
import { shellSpawnEnv, spawnPath } from "./shell-env";
import { localSidecarFactory } from "./sidecar-factory";
import { SidecarPool } from "./sidecar-pool";
import { StatsClient } from "./stats-client";
import { StatsServerManager } from "./stats-server";
import { type PersistedTabLayout, sanitizePersistedTabLayouts } from "./tab-layout";
import { createTray, destroyTray } from "./tray";
import { setupUpdater } from "./updater";
import { WindowManager } from "./window";
import { resolveWindowSpawnTarget } from "./window-spawn-target";
import {
	isWorktreeStartCandidate,
	readLiveLifecycleSettings,
	WorktreeLifecycle,
	WorktreePrompts,
	type WorktreeWindows,
} from "./worktree-lifecycle";

// App identity: the dev run shows "Electron" in the dock otherwise; packaged
// builds get the name from the bundle via electron-builder. The name also picks
// the userData directory (~/Library/Application Support/ompdesk) and the
// "ompdesk Safe Storage" keychain item, so it stays lowercase and is set before
// anything resolves that path. People see the display name, OMPdesk.
app.setName("ompdesk");
app.setAboutPanelOptions({ applicationName: "OMPdesk" });

// Honor Electron's explicit profile before acquiring its instance lock.
const userDataDirectory = app.commandLine.getSwitchValue("user-data-dir");
if (userDataDirectory) {
	const directory = resolve(userDataDirectory);
	mkdirSync(directory, { recursive: true });
	app.setPath("userData", directory);
} else {
	// The pre-rename profile (a sibling of userData) moves in before the GPU
	// marker, the instance lock, prefs or window state read userData.
	try {
		const migration = migrateLegacyUserData(app.getPath("userData"));
		if (migration !== "skipped") {
			writeRuntimeLog({ source: "user-data-migration", message: `Legacy profile ${migration} into userData` });
		}
	} catch (error) {
		writeRuntimeLog({
			source: "user-data-migration",
			message: `Legacy profile migration failed: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
}

// Software-rendering escape hatch (must precede whenReady): a crashed GPU
// process leaves every window black — the marker relaunches without it.
applyGpuFallbackIfNeeded();

// Players stream audio/video through `omp-media://` (range requests); privileges must precede whenReady.
protocol.registerSchemesAsPrivileged([
	{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true } },
]);
const mediaStreams = new MediaStreams();

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
}

// Test runs (OMP_GUI_HEADLESS=1, set by playwright.config.ts) must not cover
// or take focus from the desktop. Hidden windows would stop rendering
// (Chromium pauses animation frames), so windows stay "shown" but transparent,
// click-through, off the Dock/taskbar, and unable to grab focus. A transparent
// window — or any window on a locked/headless CI display — also counts as
// occluded, which throttles timers and frames just the same; opt out of that.
if (process.env.OMP_GUI_HEADLESS === "1") {
	app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
	app.commandLine.appendSwitch("disable-renderer-backgrounding");
	app.commandLine.appendSwitch("disable-background-timer-throttling");
	if (process.platform === "darwin") {
		app.setActivationPolicy("accessory");
		// Chromium's own storage encryption would open the "ompdesk Safe Storage"
		// login-keychain item. Tests must not touch the user's keychain, and in a
		// fresh security session (the self-hosted CI runner's LaunchAgent) that
		// access blocks the main process.
		app.commandLine.appendSwitch("use-mock-keychain");
	}
	app.on("browser-window-created", (_event, win) => {
		win.setOpacity(0);
		win.setIgnoreMouseEvents(true);
		win.setSkipTaskbar(true);
		win.setFocusable(false);
	});
}

/**
 * Unpackaged runs keep resources in the source tree. Resolve them from the
 * bundle (out/main/index.js → ../..), not app.getAppPath(): that is the
 * project root under `electron-vite dev` but `out/main` when Electron is
 * launched on the bundle directly (e2e, `electron out/main/index.js`).
 * Packaged apps ship gui-bridge outside the asar (`extraResources`) because
 * omp, a separate process, loads it with `-e`.
 */
const devResourcesDir = join(__dirname, "..", "..", "resources");

// Packaged builds get the dock icon from the bundle; the dev run shows the default atom icon otherwise.
{
	const dockIcon = join(devResourcesDir, "icon.png");
	if (process.platform === "darwin" && existsSync(dockIcon)) {
		app.dock?.setIcon(nativeImage.createFromPath(dockIcon));
	}
}

interface MainPrefs {
	lastProject?: string;
	proxyUrl?: string;
	/** One layout per live window, in window order. */
	tabLayouts?: PersistedTabLayout[];
	/** Pre-multi-window shape, migrated on the first persist. */
	tabLayout?: PersistedTabLayout;
	[key: string]: unknown;
}

let mainPrefsStore: Store<MainPrefs> | null = null;

function prefsStore(): Store<MainPrefs> {
	mainPrefsStore ??= new Store<MainPrefs>({ name: "prefs" });
	return mainPrefsStore;
}

function resolveExplicitStartupCwd(): string | undefined {
	// `electron <main.js> <dir>` (dev, e2e) carries the script path; a packaged
	// app (`ompdesk.app/…/ompdesk <dir>`) does not. Flags (`--user-data-dir=…`) are skipped.
	const explicitCwd = process.argv.slice(process.defaultApp ? 2 : 1).find(arg => !arg.startsWith("-"));
	return explicitCwd && existsSync(explicitCwd) ? explicitCwd : undefined;
}

function resolveInitialCwd(): string {
	const explicitCwd = resolveExplicitStartupCwd();
	if (explicitCwd) return explicitCwd;
	return firstUsableCwd([prefsStore().get("lastProject"), process.cwd()]) ?? homedir();
}

// ──────────────────────────────────────────────────────────────────────────
// Sidecar proxy env
// ──────────────────────────────────────────────────────────────────────────
// The agent reads proxy config from env vars only (PI_PROXY_* → PI_PROXY →
// HTTPS_PROXY → ALL_PROXY). A Finder-launched app has no shell env, so a
// proxy-only network (codex's chatgpt.com backend behind a firewall) would
// silently hang every provider request. Resolution order per spawn:
// explicit GUI pref → inherited env (terminal launch) → macOS system proxy.

/** Expand one proxy URL into the full env-var set the agent and Bun honor. */
function proxyEnvVars(proxyUrl: string): Record<string, string> {
	return {
		PI_PROXY: proxyUrl,
		HTTPS_PROXY: proxyUrl,
		HTTP_PROXY: proxyUrl,
		ALL_PROXY: proxyUrl,
		https_proxy: proxyUrl,
		http_proxy: proxyUrl,
		all_proxy: proxyUrl,
	};
}

/** Accept "127.0.0.1:7890" shorthand; keep explicit schemes as-is. */
function normalizeProxyUrl(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed.includes("://")) return trimmed;
	return `http://${trimmed}`;
}

/** First entry of a Chromium PAC result → URL ("PROXY h:p" / "SOCKS5 h:p" / "DIRECT"). */
function parsePacResult(pac: string): string | undefined {
	const first = pac.split(";")[0]?.trim() ?? "";
	const [kind, endpoint] = first.split(/\s+/, 2);
	if (!endpoint) return undefined;
	if (kind === "PROXY") return `http://${endpoint}`;
	if (kind === "HTTPS") return `https://${endpoint}`;
	if (kind === "SOCKS" || kind === "SOCKS5") return `socks5://${endpoint}`;
	return undefined;
}

/** Representative URL for system-proxy resolution (codex's OAuth backend). */
const SYSTEM_PROXY_PROBE_URL = "https://chatgpt.com";

async function resolveProxyEnvForSpawn(): Promise<Record<string, string>> {
	const pref = prefsStore().get("proxyUrl");
	if (typeof pref === "string" && pref.trim()) return proxyEnvVars(normalizeProxyUrl(pref));
	if (
		process.env.PI_PROXY ||
		process.env.HTTPS_PROXY ||
		process.env.https_proxy ||
		process.env.ALL_PROXY ||
		process.env.all_proxy
	) {
		return {};
	}
	try {
		const pac = await session.defaultSession.resolveProxy(SYSTEM_PROXY_PROBE_URL);
		const systemProxy = parsePacResult(pac);
		return systemProxy ? proxyEnvVars(systemProxy) : {};
	} catch {
		return {};
	}
}

// Module-level instances (alive for app lifetime)
let windowManager: WindowManager;
let sidecarPool: SidecarPool;
let statsServer: StatsServerManager | null = null;
/** The startup omp resolution that creates `statsServer` has finished (with or without one). */
let statsLaunchSettled = false;
let sessionIndex: SessionIndex;
let statsClient: StatsClient;
let logWatcher: LogWatcher;
let remoteDevices: RemoteDevices | null = null;
let worktreePrompts: WorktreePrompts | null = null;
let worktreeLifecycle: WorktreeLifecycle | null = null;
let setupService: SetupService | null = null;
let githubAuthService: GithubAuthService | null = null;

function errorMessage(value: unknown): { message: string; stack?: string } {
	if (value instanceof Error) return { message: value.message, stack: value.stack };
	if (typeof value === "string") return { message: value };
	try {
		return { message: JSON.stringify(value) ?? String(value) };
	} catch {
		return { message: String(value) };
	}
}

function installMainRuntimeLogging(): void {
	process.on("uncaughtExceptionMonitor", (error, origin) => {
		writeRuntimeLog({ source: "main-uncaught", ...errorMessage(error), details: { origin } });
	});
	process.on("unhandledRejection", reason => {
		writeRuntimeLog({ source: "main-unhandled-rejection", ...errorMessage(reason) });
	});
	app.on("child-process-gone", (_event, details) => {
		writeRuntimeLog({
			source: "child-process",
			message: `${details.type} process exited: ${details.reason}`,
			details: {
				type: details.type,
				reason: details.reason,
				exitCode: details.exitCode,
				serviceName: details.serviceName ?? null,
				name: details.name ?? null,
			},
		});
		handleGpuProcessGone(details);
	});
}

/**
 * The saved session: one tab layout per window. Reads tolerate both the current
 * array and the pre-multi-window single layout written by older builds.
 */
function readSavedTabLayouts(): PersistedTabLayout[] {
	const store = prefsStore();
	const layouts = sanitizePersistedTabLayouts(store.get("tabLayouts"));
	if (layouts.length > 0) return layouts;
	return sanitizePersistedTabLayouts(store.get("tabLayout"));
}

/**
 * Rewrite the saved session from the live windows. Runs on every tab change and
 * every window close, so a window the user closed for good never comes back and
 * a secondary window's tabs are no longer dropped on the floor.
 */
function persistTabLayouts(): void {
	const layouts: PersistedTabLayout[] = [];
	for (const win of windowManager.getAllWindows()) {
		const layout = sidecarPool.tabLayoutForWindow(win);
		if (layout) layouts.push(layout);
	}
	// No live window means the app is quitting (or idle in the dock), not that
	// the session was abandoned — writing an empty set would wipe the restore.
	if (layouts.length === 0) return;
	const store = prefsStore();
	store.set("tabLayouts", layouts);
	store.delete("tabLayout");
}

/** Reopen one saved window: its tabs in order, at the layout's active cwd. */
function spawnWindowWithLayout(layout: PersistedTabLayout): BrowserWindow | null {
	const active = layout.tabs[layout.activeIndex] ?? layout.tabs[0];
	if (!active) return null;
	// The window record keeps a path on this machine; a paired host's cwd means nothing here.
	const win = windowManager.createWindow({ cwd: active.device ? resolveInitialCwd() : active.cwd });
	if (sidecarPool.restoreLayout(win, layout) > 0) return win;
	win.close();
	return null;
}

/** Spawn a window with its own sidecar (the pool's 1:1 owner). Null when the sidecar cannot be created.
 *  With no target, start a fresh agent in the default workspace; explicit
 *  workspace/session requests retain their selected/fallback cwd and requested
 *  session kind. `device` runs the window's tab on that paired host, at its `cwd`. */
function spawnWindow(
	cwd?: string,
	pendingSessionPath?: string,
	kind?: SessionKind,
	device?: string,
): BrowserWindow | null {
	if (device && cwd) {
		const win = windowManager.createWindow({ cwd: resolveInitialCwd(), pendingSessionPath });
		const fresh = pendingSessionPath === undefined;
		const sidecar = sidecarPool.acquire(
			cwd,
			win,
			undefined,
			undefined,
			kind ?? "agent",
			undefined,
			fresh,
			false,
			false,
			undefined,
			device,
		);
		if (sidecar) return win;
		win.close();
		return null;
	}
	const restoreSavedLayout = cwd === undefined && pendingSessionPath === undefined && kind === undefined;
	if (restoreSavedLayout) {
		const [saved] = readSavedTabLayouts();
		if (saved) {
			const restored = spawnWindowWithLayout(saved);
			if (restored) return restored;
		}
	}
	const target = resolveWindowSpawnTarget(
		cwd,
		pendingSessionPath,
		kind,
		resolveInitialCwd(),
		ensureDefaultWorkspace(),
	);
	const win = windowManager.createWindow({ cwd: target.cwd, pendingSessionPath });
	const sidecar = sidecarPool.acquire(
		target.cwd,
		win,
		undefined,
		undefined,
		target.kind,
		undefined,
		target.fresh,
		target.placeholder,
	);
	if (!sidecar) {
		win.close();
		return null;
	}
	return win;
}

app.whenReady().then(() => {
	installMainRuntimeLogging();
	windowManager = new WindowManager();

	// Tools setup installed into the managed dir (PortableGit, Node/gh archives)
	// reach every process spawned from here on, sidecars included.
	const platform = setupPlatform();
	const toolsDir = managedToolsDir(platform, process.env, homedir(), app.getPath("userData"));
	applyManagedToolEnv(toolsDir, platform);

	const initialCwd = resolveInitialCwd();
	const explicitStartupCwd = resolveExplicitStartupCwd();
	const bridgeDir = app.isPackaged ? join(process.resourcesPath, "gui-bridge") : join(devResourcesDir, "gui-bridge");
	const sessionKinds = new SessionKindStore(join(app.getPath("userData"), "session-kinds.json"));
	// gui-bridge compatibility warnings: once per omp version per launch, taken by whichever window asks first.
	const bridgeHealth = new BridgeHealth(() => {
		for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC_EVENTS.BRIDGE_HEALTH);
	});
	ipcMain.handle(IPC_COMMANDS.BRIDGE_HEALTH_TAKE, () => bridgeHealth.take());
	const createLocalSidecar = localSidecarFactory({
		bridgeDir,
		builtinDir: app.isPackaged ? join(process.resourcesPath, "omp-builtin") : join(devResourcesDir, "omp-builtin"),
		builtinReaPref: () => prefsStore().get(REA_PREF),
		proxyEnv: resolveProxyEnvForSpawn,
		bridgeHealth,
		sessionKinds,
		replyLanguagePref: () => prefsStore().get(REPLY_LANGUAGE_PREF),
		userProfilePref: () => prefsStore().get(USER_PROFILE_PREF),
		accountRotationPref: () => prefsStore().get(ACCOUNT_ROTATION_PREF),
		accountRotationLedger: join(app.getPath("userData"), ACCOUNT_ROTATION_LEDGER_FILE),
	});
	sessionIndex = new SessionIndex(undefined, initialCwd, sessionId => sessionKinds.isChat(sessionId), bridgeDir);
	sidecarPool = new SidecarPool((cwd, kind, fresh, device, tabId) => {
		if (!device) return createLocalSidecar(cwd, kind, fresh);
		// The host runs its own health check, session-kind record and bridge
		// probe; only the probe's verdict comes back, for this machine's toast.
		const sc = devices.createSidecar(device, tabId, cwd, kind, fresh);
		sc.on("bridge", (result: BridgeConnectResult) => void bridgeHealth.observe(result));
		return sc;
	});
	// omp's `worktree.onStart` / `worktree.onExit` (omp 18.8.6+), which stock runs only in its TUI.
	const worktreeWindows: WorktreeWindows = {
		live: () => {
			const focused = BrowserWindow.getFocusedWindow();
			const all = BrowserWindow.getAllWindows().filter(win => !win.isDestroyed());
			const ordered = focused && !focused.isDestroyed() ? [focused, ...all.filter(win => win !== focused)] : all;
			return ordered.map(win => win.webContents.id);
		},
		send: (winId, channel, payload) => {
			const win = BrowserWindow.getAllWindows().find(item => !item.isDestroyed() && item.webContents.id === winId);
			win?.webContents.send(channel, payload);
		},
	};
	const prompts = new WorktreePrompts(worktreeWindows);
	const lifecycle = new WorktreeLifecycle(
		{ bind: (tabId, worktree) => sidecarPool.bindWorktree(tabId, worktree) },
		prompts,
		worktreeWindows,
	);
	worktreePrompts = prompts;
	worktreeLifecycle = lifecycle;
	sidecarPool.worktreeStartGate = (tabId, winId, facts) =>
		isWorktreeStartCandidate(facts) ? lifecycle.startGate(tabId, winId) : null;
	sidecarPool.onTabReleased = (tabId, exited) => lifecycle.released(tabId, exited);
	// This computer's models.yml, stats server and `omp bench`, for its own
	// windows and for the devices that use it as their host.
	statsClient = new StatsClient();
	const machine = new LocalMachine({
		stats: statsClient,
		// Until omp is resolved below there is no manager yet, but one is coming: a read in
		// that window waits like a booting server instead of hearing "stopped for good".
		statsRestart: () => statsServer?.ensureRunning() ?? (statsLaunchSettled ? "exhausted" : "already-pending"),
		statsText: mainT,
		benchmarkOmp: systemOmp,
		benchmarkEnv: async () => ({ ...process.env, ...(await shellSpawnEnv()), ...(await resolveProxyEnvForSpawn()) }),
		builtinRea: {
			read: () => prefsStore().get(REA_PREF),
			write: enabled => prefsStore().set(REA_PREF, enabled),
		},
		accountRotation: accountRotationDeps({
			prefs: { get: key => prefsStore().get(key), set: (key, value) => prefsStore().set(key, value) },
			tabs: () => sidecarPool.allSidecars(),
			hostedTabsChanged: () => devices.hostAccountRotationChanged(),
			evenSupported: async () => {
				const omp = await systemOmp();
				return omp.ok ? bridgeHealth.supports(omp.runtime.version, "accountRotation") : null;
			},
		}),
	});
	// This computer as a host: paired devices' tabs run here through the same factory.
	const prefs = prefsStore();
	const hostServices = new LocalHostServices({
		createSidecar: createLocalSidecar,
		sessionIndex,
		renameStoredSession: async (sessionPath, name) => {
			const omp = await systemOmp();
			if (!omp.ok) throw new Error(omp.error);
			await renameStoredSession(omp.runtime, sessionPath, name);
		},
		defaultWorkspace: ensureDefaultWorkspace,
		launchProfiles: { get: key => prefs.get(key), set: (key, value) => prefs.set(key, value) },
		machine,
		localTabs: sidecarPool,
	});
	let hostOmpVersion: string | null = null;
	void systemOmp().then(resolution => {
		if (resolution.ok) hostOmpVersion = resolution.runtime.version;
	});
	const devices = new RemoteDevices({
		userData: app.getPath("userData"),
		appVersion: app.getVersion(),
		prefs: { get: key => prefs.get(key), set: (key, value) => prefs.set(key, value) },
		broadcast: (channel, data) => {
			for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(channel, data);
		},
		services: hostServices,
		machineInfo: () => ({ platform: process.platform, ompVersion: hostOmpVersion, home: homedir(), sep }),
		offlineMessage: () => mainT("remote.offline"),
		powerSaveBlocker: {
			start: () => powerSaveBlocker.start("prevent-app-suspension"),
			stop: id => powerSaveBlocker.stop(id),
		},
	});
	remoteDevices = devices;
	sidecarPool.onWindowTabsChanged = () => persistTabLayouts();
	// A closed window's tabs have to leave the saved session with it, or the next
	// launch resurrects a window the user deliberately shut.
	windowManager.subscribeWindowClosed(record => {
		worktreePrompts?.windowClosed(record.id);
		persistTabLayouts();
	});
	// Stats dashboard: omp's own dashboard API from the user's omp install. A
	// missing or too-old omp already surfaces on every tab; the dashboard just
	// stays unavailable until setup installs omp (launchStats runs again then).
	const launchStats = () =>
		Promise.all([systemOmp(), spawnPath()])
			.then(([resolution, basePath]) => {
				if (!resolution.ok || statsServer) return;
				const packageRoot = ompPackageRoot(resolution.runtime.bin);
				if (!packageRoot) {
					console.warn(`[stats-server] cannot locate the omp package behind ${resolution.runtime.bin}`);
					return;
				}
				statsServer = new StatsServerManager({
					command: "bun",
					args: [join(bridgeDir, "stats-host.ts"), "127.0.0.1", "0"],
					env: { PATH: ompPathEnv(resolution.runtime.bin, basePath), OMP_PACKAGE_ROOT: packageRoot },
				});
				statsServer.on("ready", (port: number) => {
					statsClient.port = port;
				});
				statsServer.on("exit", () => {
					statsClient.port = 0;
				});
				statsServer.start();
			})
			.finally(() => {
				statsLaunchSettled = true;
			});
	void launchStats();

	// This machine's setup: detect Bun/omp/Git/gh/Node and, in a packaged app,
	// install what is missing on its own (src/main/setup/). Tests opt in with a
	// fake installer (OMP_GUI_TEST_INSTALLER); headless test runs never install.
	const testInstaller = process.env.OMP_GUI_TEST_INSTALLER || null;
	const setup = new SetupService({
		platform,
		arch: process.arch,
		systemRoot: process.env.SystemRoot || "C:\\Windows",
		toolsDir,
		bunInstall: bunInstallDir(process.env, homedir()),
		statePath: join(app.getPath("userData"), "setup-state.json"),
		automatic: testInstaller !== null || (app.isPackaged && process.env.OMP_GUI_HEADLESS !== "1"),
		testInstaller,
		testDownload:
			testInstaller && process.env.OMP_GUI_TEST_DOWNLOAD
				? { url: process.env.OMP_GUI_TEST_DOWNLOAD, sha256: process.env.OMP_GUI_TEST_DOWNLOAD_SHA256 ?? "" }
				: null,
		spawnEnv: async () => ({ ...process.env, ...(await shellSpawnEnv()), ...(await resolveProxyEnvForSpawn()) }),
		onState: state => {
			for (const win of BrowserWindow.getAllWindows()) {
				if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.SETUP_STATE, state);
			}
		},
		onOmpReady: () => {
			void launchStats();
			// Local tabs that failed for lack of omp start now; tabs on paired hosts are theirs.
			for (const sidecar of sidecarPool.allSidecars()) {
				if (sidecar.device === undefined && (sidecar.status === "error" || sidecar.status === "exited")) {
					sidecar.restart();
				}
			}
		},
	});
	setupService = setup;
	registerSetupIpc(ipcMain, setup);
	void setup.start();
	githubAuthService = createGithubAuthService(state => {
		for (const win of BrowserWindow.getAllWindows()) {
			if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.GITHUB_AUTH_STATE, state);
		}
	});
	registerGithubAuthIpc(ipcMain, githubAuthService);
	logWatcher = new LogWatcher();

	// Register all handlers and sidecar listeners before loading the renderer.
	registerIpcHandlers({
		sidecarPool,
		sessionIndex,
		machine,
		logWatcher,
		windowManager,
		remoteDevices: devices,
		spawnWindow,
		initialCwd: resolveInitialCwd,
		worktreeLifecycle: lifecycle,
		worktreePrompts: prompts,
		mediaStreams,
	});
	protocol.handle(MEDIA_SCHEME, request => mediaStreams.handle(request));
	// Before the first window: a restored remote tab needs its host's link to exist.
	devices.start();

	// Global shortcut: Cmd+Shift+O — toggle focused window, else show the most
	// recent, else spawn one (multi-window decision tree).
	globalShortcut.register(nativeAccelerator("window.toggle"), () => {
		const focused = BrowserWindow.getFocusedWindow();
		if (focused && !focused.isDestroyed() && windowManager.recordFor(focused)) {
			if (focused.isVisible()) focused.hide();
			else {
				focused.show();
				focused.focus();
			}
			return;
		}
		const win = windowManager.getMainWindow();
		if (win) {
			win.show();
			win.focus();
			return;
		}
		spawnWindow();
	});
	sessionIndex.start();
	logWatcher.start();
	// Read before the first window restores: every tab change rewrites the store,
	// so a later read would only see the just-restored primary window.
	const savedLayouts = readSavedTabLayouts();
	spawnWindow(explicitStartupCwd);
	// A bare launch restores the saved session in full. The window above carries
	// layout[0]; these are the secondary windows whose tabs used to be dropped at
	// relaunch. An argv cwd is an explicit "open this", not a restore.
	if (!explicitStartupCwd) {
		for (const layout of savedLayouts.slice(1)) spawnWindowWithLayout(layout);
	}

	// Tray, menu, deep links, updater. Test runs (OMP_GUI_HEADLESS) skip the tray:
	// the menu bar is shared with the user's own OMPdesk, and a test's status item
	// once stalled this main thread (MenuBarAgent never completed its scene), so
	// the first window never reached Playwright (release run 38048085831).
	if (process.env.OMP_GUI_HEADLESS !== "1") createTray(windowManager, spawnWindow);
	createMenu(windowManager, spawnWindow);
	setupDeepLinks(windowManager, spawnWindow);
	setupUpdater();
});

// macOS: re-create window on dock click
app.on("activate", () => {
	if (windowManager && windowManager.getAllWindows().length === 0) {
		spawnWindow();
	}
});

// Quit on all windows closed (except macOS)
app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		requestQuit();
	}
});

// Cleanup on quit, behind the "sessions are still working" confirmation: ⌘Q
// used to SIGTERM every live agent run without a word. Before the teardown,
// tabs owning a `worktree.onStart` worktree apply `worktree.onExit` while their
// windows can still ask.
installQuitGuard(
	() => (sidecarPool ? sidecarPool.tabInventory() : []),
	() => {
		statsServer?.kill();
		setupService?.dispose();
		githubAuthService?.dispose();
		sidecarPool?.disposeAll();
		void remoteDevices?.dispose();
		sessionIndex?.stop();
		logWatcher?.stop();
		destroyTray();
	},
	async () => {
		const lifecycle = worktreeLifecycle;
		if (!lifecycle) return;
		await lifecycle.finalize({
			prepare: async tabId => {
				const sidecar = sidecarPool.sidecarOf(tabId);
				if (!sidecar) return;
				// Stock stops the turn first, so the questions describe a worktree nothing still writes to.
				await sidecar.rpcClient?.command({ type: "abort" }).catch(() => undefined);
				await lifecycle.refreshExitPolicy(tabId, () => readLiveLifecycleSettings(sidecar));
			},
			release: tabId => sidecarPool.releaseTabWhenExited(tabId),
		});
	},
);
