/**
 * Main process entry point for ompdesk.
 * App lifecycle: ready → window, sidecar, session index, IPC, tray, menu, deep links, updater.
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { app, BrowserWindow, globalShortcut, ipcMain, nativeImage, session } from "electron";
import Store from "electron-store";
import { nativeAccelerator } from "../shared/hotkeys";
import { IPC_COMMANDS, IPC_EVENTS, type SessionKind } from "../shared/ipc-types";
import { installQuitGuard, requestQuit } from "./app-quit";
import { bootModelSelector } from "./boot-model";
import { type BridgeConnectResult, BridgeHealth } from "./bridge-health";
import { setupDeepLinks } from "./deep-link";
import { ensureDefaultWorkspace } from "./default-workspace";
import { applyGpuFallbackIfNeeded, handleGpuProcessGone } from "./gpu-fallback";
import { ompFailureText } from "./i18n";
import { firstUsableCwd } from "./initial-cwd";
import { registerIpcHandlers } from "./ipc";
import { migrateLegacyUserData } from "./legacy-user-data";
import { LogWatcher } from "./log-watcher";
import { createMenu } from "./menu";
import { ompPackageRoot, ompPathEnv, systemOmp } from "./omp-runtime";
import { writeRuntimeLog } from "./runtime-log";
import { SessionIndex } from "./session-index";
import { SessionKindStore } from "./session-kinds";
import { shellSpawnEnv, spawnPath } from "./shell-env";
import { SidecarManager } from "./sidecar";
import { SidecarPool } from "./sidecar-pool";
import { StatsClient } from "./stats-client";
import { StatsServerManager } from "./stats-server";
import { type PersistedTabLayout, sanitizePersistedTabLayouts } from "./tab-layout";
import { createTray, destroyTray } from "./tray";
import { setupUpdater } from "./updater";
import { WindowManager } from "./window";
import { resolveWindowSpawnTarget } from "./window-spawn-target";

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
	if (process.platform === "darwin") app.setActivationPolicy("accessory");
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
let sessionIndex: SessionIndex;
let statsClient: StatsClient;
let logWatcher: LogWatcher;

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
	const activeCwd = layout.tabs[layout.activeIndex]?.cwd ?? layout.tabs[0]?.cwd;
	if (!activeCwd) return null;
	const win = windowManager.createWindow({ cwd: activeCwd });
	if (sidecarPool.restoreLayout(win, layout) > 0) return win;
	win.close();
	return null;
}

/** Spawn a window with its own sidecar (the pool's 1:1 owner). Null at cap.
 *  With no target, create a fresh global chat; explicit workspace/session
 *  requests retain their selected/fallback cwd and requested session kind. */
function spawnWindow(cwd?: string, pendingSessionPath?: string, kind?: SessionKind): BrowserWindow | null {
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

	const initialCwd = resolveInitialCwd();
	const explicitStartupCwd = resolveExplicitStartupCwd();
	const bridgeDir = app.isPackaged ? join(process.resourcesPath, "gui-bridge") : join(devResourcesDir, "gui-bridge");
	const sessionKinds = new SessionKindStore(join(app.getPath("userData"), "session-kinds.json"));
	// gui-bridge compatibility warnings: once per omp version per launch, taken by whichever window asks first.
	const bridgeHealth = new BridgeHealth(() => {
		for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC_EVENTS.BRIDGE_HEALTH);
	});
	ipcMain.handle(IPC_COMMANDS.BRIDGE_HEALTH_TAKE, () => bridgeHealth.take());
	sidecarPool = new SidecarPool((cwd, kind, fresh) => {
		const sc = new SidecarManager({
			// The status banner shows this text; localize it in the UI language.
			omp: async () => {
				const resolution = await systemOmp();
				return resolution.ok || !resolution.reason
					? resolution
					: { ...resolution, error: ompFailureText(resolution.reason) };
			},
			bridgeDir,
			cwd,
			kind,
			fresh,
			proxyEnv: resolveProxyEnvForSpawn,
			shellEnv: shellSpawnEnv,
			bootModel: runtime => bootModelSelector(runtime, bridgeDir),
			// Finder-launched omp has no terminal, and a sidecar that dies before
			// it can write its own log only speaks through stderr — land the tail
			// in gui-runtime.jsonl so it is readable after the fact.
			reportFailure: report => {
				writeRuntimeLog(
					{
						source: "sidecar-restart",
						message: report.reason,
						details: { attempt: report.attempt, maxAttempts: report.maxAttempts, stderr: report.stderr },
					},
					{ cwd: report.cwd },
				);
			},
		});
		// Ready-health-check applies to every pooled sidecar, not just the first.
		// A failure marks the live child `error` without killing it; the manager
		// re-probes and returns it to `ready` once a command succeeds again.
		sc.on("status", ({ status }) => {
			if (status !== "ready") return;
			const client = sc.rpcClient;
			if (!client) return;
			client
				.command({ type: "get_state" })
				.then(res => {
					if (!res.success) sc.markUnhealthy(`Health check failed: ${res.error ?? "unknown"}`);
				})
				.catch(err => {
					sc.markUnhealthy(`Health check timed out: ${err instanceof Error ? err.message : String(err)}`);
				});
		});
		sc.on("bridge", (result: BridgeConnectResult) => void bridgeHealth.observe(result));
		// omp has no session kind; remember which sessions chat tabs created.
		if (kind === "chat") sc.on("session", ({ sessionId }) => sessionId && sessionKinds.markChat(sessionId));
		return sc;
	}, 10);
	sidecarPool.onWindowTabsChanged = () => persistTabLayouts();
	// A closed window's tabs have to leave the saved session with it, or the next
	// launch resurrects a window the user deliberately shut.
	windowManager.subscribeWindowClosed(() => persistTabLayouts());
	sessionIndex = new SessionIndex(undefined, initialCwd, sessionId => sessionKinds.isChat(sessionId));
	statsClient = new StatsClient();
	// Stats dashboard: omp's own dashboard API from the user's omp install. A
	// missing or too-old omp already surfaces on every tab; the dashboard just
	// stays unavailable.
	void Promise.all([systemOmp(), spawnPath()]).then(([resolution, basePath]) => {
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
	});
	logWatcher = new LogWatcher();

	// Register all handlers and sidecar listeners before loading the renderer.
	registerIpcHandlers({
		sidecarPool,
		sessionIndex,
		statsClient,
		statsRestart: () => statsServer?.ensureRunning() ?? "exhausted",
		logWatcher,
		windowManager,
		benchmarkOmp: systemOmp,
		benchmarkEnv: async () => ({ ...process.env, ...(await shellSpawnEnv()), ...(await resolveProxyEnvForSpawn()) }),
		spawnWindow,
		initialCwd: resolveInitialCwd,
	});

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

	// Tray, menu, deep links, updater
	createTray(windowManager, spawnWindow);
	createMenu(windowManager, spawnWindow);
	setupDeepLinks(windowManager, spawnWindow);
	setupUpdater();

	// Probe stats server (non-blocking)
	statsClient.probe().catch(() => {});
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
// used to SIGTERM every live agent run without a word.
installQuitGuard(
	() => (sidecarPool ? sidecarPool.tabInventory() : []),
	() => {
		statsServer?.kill();
		sidecarPool?.disposeAll();
		sessionIndex?.stop();
		logWatcher?.stop();
		destroyTray();
	},
);
