/**
 * Main process entry point for ompdesk.
 * App lifecycle: ready → window, sidecar, session index, IPC, tray, menu, deep links, updater.
 */

import { existsSync, mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir, release } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import {
	app,
	BrowserWindow,
	clipboard,
	desktopCapturer,
	dialog,
	globalShortcut,
	ipcMain,
	nativeImage,
	nativeTheme,
	net,
	powerMonitor,
	powerSaveBlocker,
	protocol,
	session,
	shell,
	systemPreferences,
} from "electron";
import Store from "electron-store";
import {
	AUTO_TITLE_EVOLVE_PREF,
	AUTO_TITLE_PREF,
	autoTitleFromPrefs,
} from "../../resources/gui-bridge/modes/auto-title-contracts";
import { DELEGATION_PREF } from "../../resources/gui-bridge/modes/delegation-contracts";
import { JUDGE_ASSIST_PREF, judgeAssistEnabled } from "../../resources/gui-bridge/modes/judge-assist-contracts";
import { RECALL_TERMS_FILE } from "../../resources/gui-bridge/modes/memory-recall-contracts";
import {
	NEXT_PROMPT_INLINE_PREF,
	NEXT_PROMPT_PREF,
	nextPromptFromPrefs,
} from "../../resources/gui-bridge/modes/next-prompt-contracts";
import { USER_PROFILE_PREF } from "../../resources/gui-bridge/modes/user-profile-contracts";
import { OMPDESK_ROLES_FILE } from "../../resources/gui-bridge/ompdesk-role-contracts";
import { ACCOUNT_ROTATION_LEDGER_FILE, ACCOUNT_ROTATION_PREF } from "../shared/account-rotation";
import {
	AGENT_CLOSED_CHILDREN_PREF,
	AGENT_CONTROL_PREF,
	AGENT_HIDDEN_PREFS_KEY,
	agentHiddenPaths,
	parseClosedChildren,
} from "../shared/agent-control";
import { AI_MEMORY_TERMINAL_PREF } from "../shared/ai-memory";
import { REA_PREF, reaEnabled } from "../shared/builtin-mcp";
import { DEFAULT_BROWSER_PREF } from "../shared/default-browser";
import {
	APP_AUTO_UPDATE_PREF,
	CLOSE_TO_TRAY_NOTICE_PREF,
	CLOSE_TO_TRAY_PREF,
	closeToTrayEnabled,
	KEEP_AWAKE_WORKING_PREF,
	RESUME_INTERRUPTED_PREF,
	TOOLS_AUTO_UPDATE_PREF,
} from "../shared/desktop-prefs";
import { ECC_PREF } from "../shared/ecc";
import { nativeAccelerator } from "../shared/hotkeys";
import { IPC_COMMANDS, IPC_EVENTS, type SessionKind } from "../shared/ipc-types";
import { MOBILE_WEB_COMMAND, MOBILE_WEB_GET_STATE, MOBILE_WEB_PORT, MOBILE_WEB_STATE } from "../shared/mobile-web";
import { VISUAL_SCHEME } from "../shared/preview";
import { PSTACK_PREF } from "../shared/pstack";
import { REPLY_LANGUAGE_PREF } from "../shared/reply-language";
import { SCHEDULES_STATE } from "../shared/schedules";
import {
	finishedWorktreeFolders,
	type IpcSidebarProjects,
	SIDEBAR_PROJECTS_PREF,
	SIDEBAR_PROJECTS_STATE,
	type SidebarProjectsState,
} from "../shared/sidebar-projects";
import { migrateThemeName } from "../shared/theme-names";
import { WORKTREE_BRANCH_PREFIX_PREF, worktreeBranchPrefix } from "../shared/worktree-branch";
import { accountRotationDeps } from "./account-rotation";
import { agentDir } from "./agent-paths";
import { migrateAgentPowers } from "./agent-power-migration";
import { lowerAgentPriority } from "./agent-priority";
import { MemoryCare } from "./ai-memory/care";
import { careUnits } from "./ai-memory/care-units";
import { AiMemoryClient } from "./ai-memory/client";
import { runSmol } from "./ai-memory/distill-model";
import { registerAiMemoryIpc } from "./ai-memory/ipc";
import { chainJudges, jevJudge, type PairJudge, smolJudge } from "./ai-memory/memory-judge";
import { RecallStateFile } from "./ai-memory/recall-state";
import { RecallTermsIndex } from "./ai-memory/recall-terms";
import { AiMemoryService } from "./ai-memory/service";
import { MemorySync, serveConclusionPull, serveConclusionPush, servePull, servePush } from "./ai-memory/sync";
import { pidFileControl } from "./ai-memory/unit";
import { MemoryUpkeep } from "./ai-memory/upkeep";
import { appIconPath, appNotification, holdTestNotifications } from "./app-icon";
import { installQuitGuard, quitApproved, quitRisk, requestQuit, setQuitResumes } from "./app-quit";
import type { Autopilot } from "./autopilot";
import { type BridgeConnectResult, BridgeHealth } from "./bridge-health";
import { CliUpdater, psCommands, registerCliUpdateIpc } from "./cli-tools/updater";
import { answersWithin, ConnectivityMonitor, PROBE_TIMEOUT_MS } from "./connectivity";
import { installCliLaunchers } from "./control-socket/cli-install";
import { setupDeepLinks } from "./deep-link";
import { ensureDefaultWorkspace } from "./default-workspace";
import { initDeletedSessions } from "./deleted-sessions";
import type { DesktopSlotHost } from "./desktop-slot-host";
import { poolTabFor, registerDiagnosticBundleIpc } from "./diagnostic-bundle";
import { currentDiagnosticsReport, type DiagnosticsDeps, registerDiagnosticsIpc } from "./diagnostics";
import { DiskCare, registerDiskCareIpc } from "./disk/care";
import { SavedWorktreeStore, setSavedWorktreeStore } from "./disk/saved-worktrees";
import { registerExtensionUpdateIpc } from "./ext-update/ipc";
import { ExtensionUpdater } from "./ext-update/updater";
import { EMPTY_APPLY_PLAN } from "./extension-reload";
import { createGithubAuthService, registerGithubAuthIpc } from "./github-auth/ipc";
import type { GithubAuthService } from "./github-auth/service";
import {
	applyGpuFallbackIfNeeded,
	confirmHardwareTrial,
	handleGpuProcessGone,
	recordGpuIdentity,
	softwareCompositing,
} from "./gpu-fallback";
import { installHangWatchdog, markMainStep, reportPreviousHang } from "./hang-watchdog";
import { getMainLanguage, mainT } from "./i18n";
import { firstUsableCwd } from "./initial-cwd";
import { type IpcDeps, registerIpcHandlers } from "./ipc";
import { markLaunchStable, startLaunchGuard } from "./launch-guard";
import { CRASH_LOOP_LAUNCHES, STABLE_AFTER_MS } from "./launch-guard-core";
import { migrateLegacyUserData } from "./legacy-user-data";
import { stockWorktreeLocation, tablessWorktreeBridge } from "./local/git/worktree";
import { renameStoredSession } from "./local/session-files";
import { LogWatcher } from "./log-watcher";
import { askMacPermissionsOnce } from "./mac-permissions";
import { LocalMachine } from "./machine-services";
import { McpHub } from "./mcp-hub";
import { onMcpChange } from "./mcp-live";
import { MEDIA_SCHEME, MediaStreams } from "./media-stream";
import { createMenu } from "./menu";
import { followSetupState } from "./omp-availability";
import { ompPackageRoot, ompPathEnv, refreshSystemOmp, systemOmp } from "./omp-runtime";
import { OmpUpdater, registerOmpUpdateIpc } from "./omp-updater";
import { openLocalPath } from "./open-path";
import type { LidAwake } from "./power/lid-awake";
import { createLidAwake } from "./power/lid-awake-runtime";
import { activateAction, lastWindowCloseAction } from "./quit-guard";
import { decodeBinaryRead, HOST_FS_READ_BINARY_TIMEOUT_MS, SidebarProjectsStateSchema } from "./remote/app-protocol";
import { RemoteDevices } from "./remote/devices";
import { LocalHostServices } from "./remote/host-services";
import { KeepAwakePolicy } from "./remote/keep-awake";
import { readoptHostTabs } from "./remote/readopt";
import { migrateRetiredPrefs } from "./retired-prefs";
import { runtimeLogPath, writeRuntimeLog } from "./runtime-log";
import { layoutsToSave } from "./saved-layouts";
import { ompRunLauncher, ScheduleService } from "./schedules";
import { whenSessionFree } from "./session-free";
import { SessionIndex } from "./session-index";
import { SessionKindStore } from "./session-kinds";
import { setSessionDeleteLog } from "./session-mutations";
import { SettleWatch } from "./settle-watch";
import { registerSetupIpc } from "./setup/ipc";
import { applyManagedToolEnv, bunInstallDir, managedToolsDir, setupPlatform } from "./setup/paths";
import { SetupService } from "./setup/service";
import { findBun } from "./setup/supervisor";
import { shellSpawnEnv, spawnPath } from "./shell-env";
import { SidebarProjects } from "./sidebar-projects";
import { deviceLanguage, localSidecarFactory } from "./sidecar-factory";
import { SidecarPool } from "./sidecar-pool";
import { nextSnowflake } from "./snowflake";
import { markStartup } from "./startup-timing";
import { StatsClient } from "./stats-client";
import { StatsServerManager } from "./stats-server";
import { stockHelperRequest, stopStockHelper } from "./stock-helper";
import { seedSpellchecker } from "./system-languages";
import { type PersistedTabLayout, sanitizePersistedTabLayouts, type TabLayoutDrop } from "./tab-layout";
import { execFileExecutor, startTailscaleApp } from "./tailscale/cli";
import { locateTailscale, readBundleId, systemLocateDeps } from "./tailscale/locate";
import { MobileWebService } from "./tailscale/service";
import { Tailnet } from "./tailscale/tailnet";
import { exitWithLauncher } from "./test-launcher-exit";
import { createTray, destroyTray, hasTray } from "./tray";
import { InterruptedTurnStore, retryDelays, TurnResume } from "./turn-resume";
import { recordTurnStop, setTurnStopLog } from "./turn-stop-log";
import {
	appAutoUpdatePrefChanged,
	appVersion,
	checkForUpdate,
	downloadUpdate,
	readRelaunchPresence,
	restartableUpdate,
	restartIntoUpdate,
	setupUpdater,
	updateStatus,
} from "./updater";
import { FileEditReports } from "./web/file-edit-reports";
import { IpcRegistry } from "./web/ipc-registry";
import { UploadStore } from "./web/uploads";
import { WebClientWindow } from "./web/web-client-window";
import { WebHost } from "./web/web-host";
import { WebTabLayouts } from "./web/web-tab-layouts";
import { WindowManager } from "./window";
import { nativeThemeSource } from "./window-chrome";
import { resolveWindowSpawnTarget } from "./window-spawn-target";
import {
	isWorktreeStartCandidate,
	readLiveLifecycleSettings,
	WorktreeLifecycle,
	WorktreePrompts,
	type WorktreeWindows,
} from "./worktree-lifecycle";
import { sessionOpenFolders, setOpenFoldersSource } from "./worktree-orphans";

// App identity: the dev run shows "Electron" in the dock otherwise; packaged
// builds get the name from the bundle via electron-builder. The name also picks
// the userData directory (~/Library/Application Support/ompdesk) and the
// "ompdesk Safe Storage" keychain item, so it stays lowercase and is set before
// anything resolves that path. People see the display name, OMPdesk.
app.setName("ompdesk");
// The Windows toast and taskbar group are keyed on this id: electron-builder gives the Start-menu shortcut the
// appId, so the same id there makes a toast wear the shortcut's name and icon (the dev run has no shortcut).
if (process.platform === "win32") app.setAppUserModelId("com.seuput.ompdesk");
app.setAboutPanelOptions({ applicationName: "OMPdesk", iconPath: appIconPath() });

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

// Players stream audio/video through `omp-media://` (range requests); the agent's visuals load in the Preview
// through `omp-visual://` (main/preview/visuals.ts; handled on the preview's visual session only). Privileges
// must precede whenReady.
protocol.registerSchemesAsPrivileged([
	{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true } },
	{ scheme: VISUAL_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
// No page resolves host names it only hints at (`<link rel=dns-prefetch>`, in any frame, whatever
// `x-dns-prefetch-control` says): a visual's page could spell what it read into a name for the system resolver,
// which neither CSP nor the visual session's dead proxy stops (Security #3). Only a hint is lost; Blink applies
// this after each page's preferences, in every renderer. Any `--blink-settings` given at launch is kept.
const blinkSettings = app.commandLine.getSwitchValue("blink-settings");
app.commandLine.appendSwitch(
	"blink-settings",
	[blinkSettings, "dnsPrefetchingEnabled=false"].filter(Boolean).join(","),
);
const mediaStreams = new MediaStreams();

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
}

// Crash-loop guard (launch-guard-core.ts): when the last launches all ended within seconds, this one starts in
// safe mode (software rendering, no automatic relaunch, machine setup and memory setup paused). Packaged runs
// only (a dev run restarts main on every edit, e2e kills apps on purpose); OMP_GUI_LAUNCH_GUARD=1 forces it.
// A second instance quits at once and is never recorded.
const launchGuardOn =
	gotLock && ((app.isPackaged && process.env.OMP_GUI_HEADLESS !== "1") || process.env.OMP_GUI_LAUNCH_GUARD === "1");
const safeMode = launchGuardOn
	? startLaunchGuard(join(app.getPath("userData"), "launch-history.json")).safeMode
	: false;
if (safeMode) {
	writeRuntimeLog({
		source: "launch-guard",
		message: `Safe mode: the last ${CRASH_LOOP_LAUNCHES} launches ended within ${STABLE_AFTER_MS / 1000} s of starting; software rendering, no automatic relaunch, setup paused`,
	});
}

// Software-rendering escape hatch (must precede whenReady): a crashed GPU
// process leaves every window black — the marker relaunches without it, once.
applyGpuFallbackIfNeeded(safeMode);

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
	holdTestNotifications();
}
// A test launch ends with the Playwright worker that launched it, even one that died running no handler.
exitWithLauncher(process.env, () => app.exit(0));

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
	if (!mainPrefsStore) {
		mainPrefsStore = new Store<MainPrefs>({ name: "prefs" });
		migrateRetiredPrefs(mainPrefsStore as unknown as Store<Record<string, unknown>>);
		const powers = migrateAgentPowers(mainPrefsStore as unknown as Store<Record<string, unknown>>, agentDir());
		if (powers) {
			writeRuntimeLog({
				// A clean migration is no failure: only one that could not edit config.yml is a background-task error.
				source: powers.error ? "background-task" : "user-data-migration",
				message: "agent-powers-migrated",
				details: { prefs: powers.prefs.join(","), stock: powers.stock.join(","), error: powers.error ?? null },
			});
		}
		// A theme the app no longer ships (the pre-curated set) is replaced by its nearest successor, so the
		// stored pref never names a missing theme and the saved window opens in the right scheme.
		const prefs = mainPrefsStore as unknown as Store<Record<string, unknown>>;
		for (const key of ["themeName", "systemLightTheme", "systemDarkTheme"]) {
			const stored = prefs.get(key);
			const migrated = migrateThemeName(stored);
			if (typeof stored === "string" && migrated !== null && migrated !== stored) prefs.set(key, migrated);
		}
	}
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
/** How long the stats server and setup's optional installs wait for a first ready tab before starting anyway. */
const FIRST_TAB_GRACE_MS = 30_000;

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
/** OMPdesk's MCP hub (src/main/mcp-hub.ts): the one process serving every omp's `rea` and `ompdesk-memory`. */
let mcpHub: McpHub | null = null;
/** The startup omp resolution that creates `statsServer` has finished (with or without one). */
let statsLaunchSettled = false;
let sessionIndex: SessionIndex;
let statsClient: StatsClient;
let logWatcher: LogWatcher;
let remoteDevices: RemoteDevices | null = null;
let worktreePrompts: WorktreePrompts | null = null;
let worktreeLifecycle: WorktreeLifecycle | null = null;
let setupService: SetupService | null = null;
let webHost: WebHost | null = null;
/** The phones' upload folder, also where a paired computer's attached files land; WebHost's own store once it exists. */
let earlyUploads: UploadStore | null = null;
function hostUploads(): UploadStore {
	if (webHost) return webHost.uploads;
	earlyUploads ??= new UploadStore({ root: join(app.getPath("userData"), "web-uploads") });
	return earlyUploads;
}
/** Paired web devices' tab layouts, by device (pref `webTabLayouts`). */
const webTabLayouts = new WebTabLayouts({
	get: () => prefsStore().get("webTabLayouts"),
	set: value => prefsStore().set("webTabLayouts", value),
});
let mobileWebService = null as MobileWebService | null;
let ompUpdater: OmpUpdater | null = null;
let cliUpdater: CliUpdater | null = null;
let aiMemoryService: AiMemoryService | null = null;
let aiMemoryUpkeep: MemoryUpkeep | null = null;
let aiMemoryCare: MemoryCare | null = null;
let aiMemorySync: MemorySync | null = null;
let recallTerms: RecallTermsIndex | null = null;
const RECALL_TERMS_REFRESH_MS = 10 * 60_000;
let extensionUpdater: ExtensionUpdater | null = null;
let githubAuthService: GithubAuthService | null = null;
let scheduleService: ScheduleService | null = null;
/** Keep-awake while this computer's own tabs run a turn (Settings › General › Window). */
let workAwakePolicy: KeepAwakePolicy | null = null;
/** A charging laptop's lid close never stops work a keep-awake blocker holds (src/main/power/lid-awake.ts). */
let lidAwake: LidAwake | null = null;
/** Disk care at launch and daily (src/main/disk/care.ts). */
let diskCare: DiskCare | null = null;

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
	// A console line to a stdout/stderr whose reader is gone (the terminal or test runner that started this copy
	// closed) fails with EPIPE on the stream; with no listener that is an uncaught exception and a crash dialog.
	// Losing the line is fine: the runtime log keeps what matters.
	for (const stream of [process.stdout, process.stderr]) {
		stream.on("error", error => {
			if ((error as NodeJS.ErrnoException).code !== "EPIPE") throw error;
		});
	}
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
function readSavedTabLayouts(options: { log?: boolean } = {}): PersistedTabLayout[] {
	const store = prefsStore();
	const drops: TabLayoutDrop[] = [];
	const collect = options.log ? (drop: TabLayoutDrop) => drops.push(drop) : undefined;
	let layouts = sanitizePersistedTabLayouts(store.get("tabLayouts"), undefined, collect);
	if (layouts.length === 0) layouts = sanitizePersistedTabLayouts(store.get("tabLayout"), undefined, collect);
	if (options.log) logLayoutRestore(layouts, drops);
	return layouts;
}

/**
 * One `tab-layout` line per launch: how many saved tabs come back, and which were left out or start fresh and why
 * (`TabLayoutDrop`), so a tab "missing after a relaunch" is explained from the log, never guessed.
 */
function logLayoutRestore(layouts: readonly PersistedTabLayout[], drops: readonly TabLayoutDrop[]): void {
	const count = (reason: TabLayoutDrop["reason"]) => drops.filter(drop => drop.reason === reason).length;
	writeRuntimeLog({
		source: "tab-layout",
		message: drops.length > 0 ? "restored, some tabs left out or fresh" : "restored",
		details: {
			level: "info",
			windows: layouts.length,
			tabs: layouts.reduce((sum, layout) => sum + layout.tabs.length, 0),
			folderGone: count("folder"),
			deleted: count("deleted"),
			duplicate: count("duplicate"),
			fresh: count("fresh"),
			...(drops.length > 0
				? {
						dropped: drops
							.slice(0, 20)
							.map(
								drop => `${drop.reason}: ${drop.sessionPath ? basename(drop.sessionPath) : basename(drop.cwd)}`,
							)
							.join("; "),
					}
				: {}),
		},
	});
}

/**
 * A finished worktree's session (its OMPdesk worktree is gone: disk care removed it once its work landed) never comes
 * back through a tab nobody uses (the user's report, 29 Oct 2026: a device's restored tabs listed two such sessions the
 * host itself hid). Given that computer's project list, the tabs a relaunch restored on one, asleep since, close on
 * `device` (undefined: this computer) as a deleted session's do.
 */
function closeFinishedTabs(device: string | undefined, state: Pick<SidebarProjectsState, "gone">): void {
	const closed = sidecarPool.closeAsleepTabsIn(device, finishedWorktreeFolders(state));
	if (closed.length === 0) return;
	writeRuntimeLog({
		source: "tab-layout",
		message: "closed restored tabs of finished worktrees",
		details: { level: "info", device: device ?? "local", tabs: closed.length },
	});
}

/**
 * Rewrite the saved session from the live windows. Runs on every tab change and
 * every window close, so a window the user closed for good never comes back and
 * a secondary window's tabs are no longer dropped on the floor.
 */
function persistTabLayouts(): void {
	const live: PersistedTabLayout[] = [];
	for (const win of windowManager.getAllWindows()) {
		const layout = sidecarPool.tabLayoutForWindow(win);
		if (layout) live.push(layout);
	}
	const store = prefsStore();
	const layouts = layoutsToSave({ quitApproved: quitApproved(), live, stored: store.get("tabLayouts") });
	if (!layouts) return;
	store.set("tabLayouts", layouts);
	if (store.has("tabLayout")) store.delete("tabLayout");
}

/** Reopen one saved window: its tabs in order, at the layout's active cwd. */
function spawnWindowWithLayout(layout: PersistedTabLayout): BrowserWindow | null {
	if (quitApproved()) return null;
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
	// An approved quit has torn the services down (or is doing so): a window built now has nothing to run on, and
	// restoring the layout on it would drop what a disposed `RemoteDevices` cannot open from the saved session.
	if (quitApproved()) return null;
	if (device && cwd) {
		const win = windowManager.createWindow({ cwd: resolveInitialCwd() });
		const fresh = pendingSessionPath === undefined;
		const sidecar = sidecarPool.acquire(
			cwd,
			win,
			undefined,
			pendingSessionPath,
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
	// The tab's omp starts on the session file (`--session`), as a tab spawn's does: the renderer's boot switch it
	// used to wait for never ran in a window whose tab list had not named its tab yet.
	const win = windowManager.createWindow({ cwd: target.cwd });
	const sidecar = sidecarPool.acquire(
		target.cwd,
		win,
		undefined,
		pendingSessionPath,
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
	markStartup("app-ready");
	// A second instance quits at once: it must not take the running one's marker, nor watch anything.
	if (gotLock) {
		reportPreviousHang();
		installHangWatchdog();
		// The GPU the crash marker compares (gpu-fallback-core.ts): a changed driver brings hardware back.
		void recordGpuIdentity();
		// A launch that ran this long, or quits cleanly sooner, ends no crash loop. A GPU relaunch's `app.exit`
		// and a crash skip both, so those launches stay unstable. A hardware trial that ran this long keeps hardware.
		setTimeout(() => {
			if (launchGuardOn) markLaunchStable();
			confirmHardwareTrial();
		}, STABLE_AFTER_MS).unref();
		if (launchGuardOn) app.on("will-quit", markLaunchStable);
	}
	windowManager = new WindowManager();
	// Before any window exists: each one is created under the app's theme, not the OS's (window-chrome.ts).
	nativeTheme.themeSource = nativeThemeSource(prefsStore().get("themeName"), prefsStore().get("theme"));
	// The windows' spellchecker follows the system language, not the en-US the trimmed locales leave (system-languages.ts).
	seedSpellchecker(session.defaultSession, app.getPreferredSystemLanguages(), process.platform);

	// Tools setup installed into the managed dir (PortableGit, Node/gh archives)
	// reach every process spawned from here on, sidecars included.
	const platform = setupPlatform();
	const toolsDir = managedToolsDir(platform, process.env, homedir(), app.getPath("userData"));
	applyManagedToolEnv(toolsDir, platform);

	const initialCwd = resolveInitialCwd();
	const explicitStartupCwd = resolveExplicitStartupCwd();
	const bridgeDir = app.isPackaged ? join(process.resourcesPath, "gui-bridge") : join(devResourcesDir, "gui-bridge");
	installCliLaunchers({
		cliDir: app.isPackaged ? join(process.resourcesPath, "cli") : join(devResourcesDir, "cli"),
		userData: app.getPath("userData"),
		platform,
		packaged: app.isPackaged,
		env: process.env,
		home: homedir(),
	});
	const builtinDir = app.isPackaged
		? join(process.resourcesPath, "omp-builtin")
		: join(devResourcesDir, "omp-builtin");
	const sessionKinds = new SessionKindStore(join(app.getPath("userData"), "session-kinds.json"));
	// gui-bridge compatibility warnings: once per omp version per launch, taken by whichever window asks first.
	const bridgeHealth = new BridgeHealth(
		() => {
			for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC_EVENTS.BRIDGE_HEALTH);
		},
		() => {
			// One attempt per omp version (BridgeHealth). An omp setup calls missing or broken (a compiled omp, a Bun
			// below its engines.bun) is repaired by setup; a usable one by the omp updater, a no-op when it is newest.
			const presence = setupService?.state().items.find(item => item.id === "omp")?.presence;
			if (presence && presence.kind !== "present") void setupService?.retry("omp").catch(() => undefined);
			else void ompUpdater?.updateNow().catch(() => undefined);
		},
	);
	// Every IPC handler registers once, here and in what this hands it to: on ipcMain for the app's windows,
	// and in the table a paired web device's calls are dispatched from (web/ipc-registry.ts).
	const ipc = new IpcRegistry(ipcMain);
	ipc.handle(IPC_COMMANDS.BRIDGE_HEALTH_TAKE, () => bridgeHealth.take());
	// The first local tab boots alone: the stats server and machine setup's optional installs (gh, Node;
	// winget on Windows) wait until a tab's session is ready, or FIRST_TAB_GRACE_MS when none comes (only
	// paired-host tabs, an omp that cannot start). Measured by e2e/first-run-no-omp.e2e.ts.
	const firstTabReady = Promise.withResolvers<void>();
	const afterFirstTab = (): Promise<void> => {
		const grace = Promise.withResolvers<void>();
		setTimeout(grace.resolve, FIRST_TAB_GRACE_MS).unref();
		return Promise.race([firstTabReady.promise, grace.promise]);
	};
	// Autopilot's coordinator is built in ipc.ts (it needs the RPC dispatcher); the factory and TurnResume read it from here.
	const autopilotRef: { current: Autopilot | null } = { current: null };
	const webTabNotice: IpcDeps["webTabNotice"] = { current: null };
	const secretaryAnswers: IpcDeps["secretaryAnswers"] = { current: null };
	// The desktop slot's host is built in ipc.ts next to the pool's wiring; the factory reads it from here.
	const desktopSlotRef: { current: DesktopSlotHost | null } = { current: null };
	// The shared-checkout pass is built in ipc.ts too; the factory runs it when a bridge reports a new changed file.
	const checkoutFilesRef: { current: ((sidecar: object) => void) | null } = { current: null };
	// Memory's address for the bridge's recall in every omp this computer runs (src/main/ai-memory/recall-state.ts).
	const memoryRecallState = new RecallStateFile(join(app.getPath("userData"), "ai-memory", "recall.json"));
	const recallTermsFile = join(app.getPath("userData"), "ai-memory", RECALL_TERMS_FILE);
	mcpHub = new McpHub({
		script: join(bridgeDir, "mcp-hub.ts"),
		env: async () => {
			const [resolution, basePath, shell, proxy] = await Promise.all([
				systemOmp(),
				spawnPath(),
				shellSpawnEnv(),
				resolveProxyEnvForSpawn(),
			]);
			// Bun from omp's own install runs the hub; REA's npx comes from the same PATH an omp's spawn has.
			return { ...shell, ...proxy, PATH: resolution.ok ? ompPathEnv(resolution.runtime.bin, basePath) : basePath };
		},
		reaCacheDir: join(app.getPath("userData"), "rea"),
		memoryStateFile: memoryRecallState.path,
		lowerPriority: lowerAgentPriority,
		log: (message, details) => console.log(`[mcp-hub] ${message}`, details ?? ""),
	});
	mcpHub.start();
	const hub = mcpHub;
	const createLocalSidecar = localSidecarFactory({
		bridgeDir,
		builtinDir,
		sessionFree: async sessionPath => {
			const started = Date.now();
			const outcome = await whenSessionFree(sessionPath, { owned: path => sessionIndex.ownedElsewhere(path) });
			if (outcome === "owned" || Date.now() - started > 1_000)
				writeRuntimeLog({
					source: "session-owner",
					message:
						outcome === "owned" ? "session still owned elsewhere; not opened" : "waited for the session's owner",
					details: { level: "info", session: basename(sessionPath), waitedMs: Date.now() - started },
				});
			return outcome;
		},
		builtinReaPref: () => prefsStore().get(REA_PREF),
		mcpHubEnv: cwd => hub.ompEnv(cwd),
		reaRuntimeFile: join(app.getPath("userData"), "rea-runtime.json"),
		agentControlPref: () => prefsStore().get(AGENT_CONTROL_PREF),
		pstackPref: () => prefsStore().get(PSTACK_PREF),
		eccPref: () => prefsStore().get(ECC_PREF),
		onReady: () => firstTabReady.resolve(),
		proxyEnv: resolveProxyEnvForSpawn,
		bridgeHealth,
		sessionKinds,
		replyLanguagePref: () => prefsStore().get(REPLY_LANGUAGE_PREF),
		defaultBrowserPref: () => prefsStore().get(DEFAULT_BROWSER_PREF),
		userProfilePref: () => prefsStore().get(USER_PROFILE_PREF),
		nextPromptPrefs: () =>
			nextPromptFromPrefs(prefsStore().get(NEXT_PROMPT_PREF), prefsStore().get(NEXT_PROMPT_INLINE_PREF)),
		autoTitlePrefs: () =>
			autoTitleFromPrefs(prefsStore().get(AUTO_TITLE_PREF), prefsStore().get(AUTO_TITLE_EVOLVE_PREF)),
		judgeAssistPref: () => judgeAssistEnabled(prefsStore().get(JUDGE_ASSIST_PREF)),
		delegationPref: () => prefsStore().get(DELEGATION_PREF),
		accountRotationPref: () => prefsStore().get(ACCOUNT_ROTATION_PREF),
		accountRotationLedger: join(app.getPath("userData"), ACCOUNT_ROTATION_LEDGER_FILE),
		ompdeskRolesFile: join(app.getPath("userData"), OMPDESK_ROLES_FILE),
		launchProfilesPref: () => prefsStore().get("launchProfiles"),
		// ai-memory's `session-end` (the handoff) needs omp's own shutdown, which only a closed stdin triggers.
		gracefulStopMs: () => (aiMemoryService?.state().phase === "ready" ? 4_000 : 0),
		aiMemoryExtensionArgs: cwd => aiMemoryService?.extensionArgs(cwd) ?? Promise.resolve([]),
		memoryStateFile: memoryRecallState.path,
		autopilot: () => autopilotRef.current,
		desktopSlot: () => desktopSlotRef.current,
		checkoutFiles: sidecar => checkoutFilesRef.current?.(sidecar),
	});
	initDeletedSessions(join(app.getPath("userData"), "deleted-sessions.json"));
	sessionIndex = new SessionIndex(undefined, initialCwd, sessionId => sessionKinds.isChat(sessionId), bridgeDir);
	// The sidebar's project list: folders outlive their last session (src/main/sidebar-projects.ts).
	const sidebarProjects = new SidebarProjects({
		read: () => prefsStore().get(SIDEBAR_PROJECTS_PREF),
		write: state => prefsStore().set(SIDEBAR_PROJECTS_PREF, state),
		sessions: () => sessionIndex.list("global"),
		defaultWorkspace: ensureDefaultWorkspace,
		// A removed worktree's project, read off its `gui-<name>-<hash7>` folder name (stock's root and repo hash).
		worktreeLocation: project => stockWorktreeLocation(tablessWorktreeBridge, project),
		worktreeBindings: () => sidecarPool.worktreeBindings(),
		onState: state => {
			const update: IpcSidebarProjects = { state };
			for (const win of BrowserWindow.getAllWindows()) {
				if (!win.isDestroyed()) win.webContents.send(SIDEBAR_PROJECTS_STATE, update);
			}
			// Devices whose sidebar shows this computer's section follow.
			devices.hostSidebarProjectsChanged(state);
			// The same rule as on a device: a tab restored asleep on a finished worktree here closes.
			closeFinishedTabs(undefined, state);
		},
	});
	sidecarPool = new SidecarPool((cwd, kind, fresh, device, tabId, web) => {
		if (!device) return createLocalSidecar(cwd, kind, fresh, undefined, web);
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
		{
			bind: (tabId, worktree) => {
				const bound = sidecarPool.bindWorktree(tabId, worktree);
				sidebarProjects.schedule();
				return bound;
			},
		},
		prompts,
		worktreeWindows,
		{ branchPrefix: () => worktreeBranchPrefix(prefsStore().get(WORKTREE_BRANCH_PREFIX_PREF)) },
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
			// Machine setup exists once startup built it; its node item carries the progress.
			installNode: () => void setupService?.installForConnection("node").catch(() => undefined),
		},
		desktop: {
			version: appVersion,
			update: {
				status: updateStatus,
				check: checkForUpdate,
				download: downloadUpdate,
				restartable: restartableUpdate,
				restart: () => restartIntoUpdate("user click"),
			},
			appearance: () => ({ themeName: prefsStore().get("themeName"), language: prefsStore().get("language") }),
			// Device tabs this computer hosts count too; their own quit prompt never reaches anyone.
			busy: (): boolean => quitRisk().workingTabs > 0 || hostServices.runningPeers().length > 0,
		},
		ompUpdater: () => {
			if (!ompUpdater) throw new Error("OMPdesk is still starting");
			return ompUpdater;
		},
		schedules: () => scheduleService,
		sidebarProjects: () => sidebarProjects,
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
	// One runtime-log line per stored-session delete, here or asked by a paired device (session-mutations.ts).
	setSessionDeleteLog((outcome, details) => writeRuntimeLog({ source: "session-delete", message: outcome, details }));
	// One runtime-log line per Stop that reaches an omp, naming who asked (turn-stop-log.ts).
	setTurnStopLog({
		write: details => writeRuntimeLog({ source: "turn-stop", message: String(details.by), details }),
		sessionOf: tab =>
			sidecarPool.sessionFileOf(tab) ?? hostServices.resumeFacts().find(fact => fact.tabId === tab)?.sessionFile,
	});
	const hostServices = new LocalHostServices({
		createSidecar: createLocalSidecar,
		// A paired computer's attached files land in the phones' upload folder (24 h); `webHost` is made later.
		uploads: { store: (deviceId, name, bytes) => hostUploads().store(deviceId, name, bytes) },
		// `devices` is created below; a host tab only opens once it serves connections.
		hostName: (): string => devices.deviceName(),
		sessionIndex,
		agentHidden: () => agentHiddenPaths(prefs.get(AGENT_HIDDEN_PREFS_KEY)),
		renameStoredSession: async (sessionPath, name) => {
			const omp = await systemOmp();
			if (!omp.ok) throw new Error(omp.error);
			await renameStoredSession(omp.runtime, sessionPath, name);
		},
		defaultWorkspace: ensureDefaultWorkspace,
		launchProfiles: { get: key => prefs.get(key), set: (key, value) => prefs.set(key, value) },
		machine,
		localTabs: sidecarPool,
		windowLiveSessions: () => sidecarPool.liveSessions(),
		sessionOpeners: () => {
			// A record of a child main closed, for one on this computer; a tab that holds the session again wins.
			const openers = new Map(
				parseClosedChildren(prefs.get(AGENT_CLOSED_CHILDREN_PREF)).flatMap(row =>
					row.device ? [] : [[row.path, row.openedBySession] as const],
				),
			);
			for (const [child, opener] of sidecarPool.sessionOpeners()) openers.set(child, opener);
			return openers;
		},
		mobileWebUrl: () => mobileWebService?.state().url ?? null,
		trashItem: abs => shell.trashItem(abs),
		// Autopilot runs paired devices started here, charged to them until they end (remote/hosted-autopilot.ts).
		runChargesFile: join(app.getPath("userData"), "autopilot-device-runs.json"),
	});
	// Orphaned worktrees (worktree-orphans.ts): a folder is open when a tab of this computer or a tab it hosts for a
	// paired device runs in it (`hostServices.workspaceDirs()` is the cwd of every hosted tab, a superset of `hostedSessions()`).
	setOpenFoldersSource(() => [...sidecarPool.workspaceDirs(), ...hostServices.workspaceDirs()]);
	let hostOmpVersion: string | null = null;
	void systemOmp().then(resolution => {
		if (resolution.ok) hostOmpVersion = resolution.runtime.version;
	});
	// Tailscale, read-only: computer sharing (src/main/remote/) works over the tailnet only and asks Tailscale who
	// connects. `OMP_GUI_TAILSCALE` (tests) names a fake CLI; Mobile web below locates the same way.
	const tailscaleOs = platform === "other" ? null : platform;
	const stringPref = (key: string): string | null => {
		const value = prefs.get(key);
		return typeof value === "string" && value.trim() ? value : null;
	};
	const locateTs = async () =>
		tailscaleOs
			? locateTailscale(
					systemLocateDeps(tailscaleOs, stringPref("mobileWeb.tailscaleBin"), spawnPath, mac =>
						readBundleId(mac, execFileExecutor),
					),
				)
			: null;
	const tailnet = new Tailnet({ locate: locateTs, exec: execFileExecutor });
	// A test launch never changes the machine's power settings (a killed test app would leave them changed), and a
	// second instance must not undo the running one's hold as a leftover.
	lidAwake =
		process.env.OMP_GUI_HEADLESS === "1" || !gotLock
			? null
			: createLidAwake({
					userData: app.getPath("userData"),
					onAc: !powerMonitor.isOnBatteryPower(),
					log: (message, details) => writeRuntimeLog({ source: "keep-awake", message, details }),
				});
	void lidAwake?.start();
	powerMonitor.on("on-ac", () => lidAwake?.setOnAc(true));
	powerMonitor.on("on-battery", () => lidAwake?.setOnAc(false));
	const keepAwakeBlocker = (label: string) => {
		const blocker = {
			start: () => powerSaveBlocker.start("prevent-app-suspension"),
			stop: (id: number) => powerSaveBlocker.stop(id),
		};
		return lidAwake ? lidAwake.wrap(blocker, label) : blocker;
	};
	const devices = new RemoteDevices({
		userData: app.getPath("userData"),
		appVersion: app.getVersion(),
		prefs: { get: key => prefs.get(key), set: (key, value) => prefs.set(key, value) },
		broadcast: (channel, data) => {
			for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(channel, data);
		},
		services: hostServices,
		modelWait: sidecarPool.modelWait,
		machineInfo: () => ({ platform: process.platform, ompVersion: hostOmpVersion, home: homedir(), sep }),
		offlineMessage: () => mainT("remote.offline"),
		stalledMessage: (device, seconds) => mainT("remote.tabStalled", undefined, { device, seconds }),
		// Test seam: the stall e2e (e2e/mobile-remote-session.e2e.ts) waits seconds, not a minute.
		...(Number(process.env.OMP_GUI_REMOTE_START_TIMEOUT_MS) > 0
			? { startTimeoutMs: Number(process.env.OMP_GUI_REMOTE_START_TIMEOUT_MS) }
			: {}),
		logTab: (step, details) => writeRuntimeLog({ source: "remote-tab", message: step, details }),
		// A quit (update restart included) leaves the turns a paired host runs for this computer running there, as it
		// leaves this computer's own to continue after the relaunch. With "Continue interrupted work" off the quit
		// dialog counted those turns and promised to stop them, so their host tabs close as before.
		keepHostTabsOnQuit: () => quitApproved() && prefs.get(RESUME_INTERRUPTED_PREF) !== false,
		powerSaveBlocker: keepAwakeBlocker("host"),
		tailnet,
		allowedUsers: () => mobileWebService?.allowedUsers() ?? [],
		adoptLogin: login => mobileWebService?.adoptLogin(login),
		blocks: () => webHost?.blocks ?? null,
		confirm: async details => {
			const confirmations = webHost?.confirmations;
			if (!confirmations) return false;
			const outcome = await confirmations.request({
				kind: "computer",
				name: details.name,
				userAgent: details.nodeName ?? "",
				tailscaleLogin: details.login,
				ip: details.ip,
			});
			return outcome.approved;
		},
		tailscaleAction: async action => {
			await mobileWebService?.request({ action });
		},
		loopback: !app.isPackaged && process.env.OMP_GUI_TEST_REMOTE_LOOPBACK === "1",
		log: (message, details) => writeRuntimeLog({ source: "remote", message, details }),
		logLink: (message, details) => writeRuntimeLog({ source: "remote-link", message, details }),
	});
	remoteDevices = devices;
	// Devices that use this computer as their host say "n sessions wait together" from its own count (its account).
	let lastModelWaitLocal = "{}";
	sidecarPool.modelWait.onChange(({ local }) => {
		const signature = JSON.stringify(Object.entries(local).sort());
		if (signature === lastModelWaitLocal) return;
		lastModelWaitLocal = signature;
		devices.hostModelWaitChanged(local);
	});
	// A paired web device's window is filed under the device (its window id changes every launch); a quit tears
	// the tabs down, which must not read as the device closing them.
	sidecarPool.onWindowTabsChanged = (win, layout) => {
		// A window's tab took or let go of a session, or learned who opened it: paired devices may list it otherwise.
		hostServices.listingChanged();
		if (win instanceof WebClientWindow) {
			if (!quitApproved()) webTabLayouts.save(win.deviceId, layout);
			return;
		}
		persistTabLayouts();
	};
	// Every take or let-go of a session file, a session-id change too (it re-registers only at the next get_state):
	// the devices' "held on this host" follows each one, so no device's read in the gap can hide a later close.
	sidecarPool.onSessionFilesChanged = () => hostServices.listingChanged();
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
		afterFirstTab()
			.then(() => Promise.all([systemOmp(), spawnPath()]))
			.then(([resolution, basePath]) => {
				// A quit tears the stats server down: a launch that resolves after it must not start a new one.
				if (!resolution.ok || statsServer || quitApproved()) return;
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
	// Accessibility and Screen Recording cannot be granted by an app: ask the OS once, after the first tab is up, so
	// computer use (agents have every power by default) shows the system prompt instead of failing silently.
	void afterFirstTab().then(() =>
		askMacPermissionsOnce({
			platform: process.platform,
			automatic: app.isPackaged && process.env.OMP_GUI_HEADLESS !== "1",
			prefs: prefsStore(),
			accessibilityTrusted: prompt => systemPreferences.isTrustedAccessibilityClient(prompt),
			screenStatus: () => systemPreferences.getMediaAccessStatus("screen"),
			requestScreenCapture: async () => {
				await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
			},
		}).catch(error =>
			writeRuntimeLog({
				source: "background-task",
				message: "mac-permissions-failed",
				details: { error: String(error) },
			}),
		),
	);

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
		appVersion: app.getVersion(),
		// Safe mode pauses automatic installs; Retry still runs one.
		automatic: !safeMode && (testInstaller !== null || (app.isPackaged && process.env.OMP_GUI_HEADLESS !== "1")),
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
			mobileWebService?.onSetupState(state);
			// ai-memory's wiring waits for Bun on Windows: it runs again (once) when the setup reports Bun present.
			if (state.items.some(item => item.id === "bun" && item.presence?.kind === "present")) {
				aiMemoryService?.bunInstalled();
			}
			if (state.items.some(item => item.presence !== null)) markStartup("setup-detected");
			// omp just became usable: local tabs that waited for it start now (tabs on paired hosts are theirs),
			// and a session list refused meanwhile is read again.
			const usable = followSetupState(state);
			if (!usable) return;
			for (const sidecar of sidecarPool.allSidecars()) {
				if (sidecar.device === undefined && sidecar.status === "waiting") sidecar.restart();
			}
			if (usable.refused) sessionIndex.relist();
		},
		beforeOptional: afterFirstTab,
		onOmpReady: () => {
			markStartup("omp-ready");
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
	registerSetupIpc(ipc, setup);
	const diagnostics: DiagnosticsDeps = {
		system: () => ({
			appVersion: appVersion(),
			packaged: app.isPackaged,
			electron: process.versions.electron ?? "?",
			chrome: process.versions.chrome ?? "?",
			node: process.versions.node ?? "?",
			platform: process.platform,
			arch: process.arch,
			osRelease: release(),
			osVersion: process.getSystemVersion(),
			language: deviceLanguage() ?? null,
		}),
		setupState: () => setup.state(),
		runtimeLogPath,
		pairedVersions: () => {
			const state = devices.state();
			return {
				hosts: state.hosts.flatMap(host => (host.state === "online" && host.appVersion ? [host.appVersion] : [])),
				devices: state.host.peers.flatMap(peer => (peer.online && peer.appVersion ? [peer.appVersion] : [])),
			};
		},
		display: async () => ({
			rendering: (await softwareCompositing()) ? "software" : "hardware",
			reducedMotion:
				typeof systemPreferences.getAnimationSettings === "function"
					? systemPreferences.getAnimationSettings().prefersReducedMotion
					: null,
		}),
	};
	registerDiagnosticsIpc(ipc, diagnostics);
	registerDiagnosticBundleIpc(ipc, {
		tabFor: poolTabFor(sidecarPool),
		agentHidden: () => agentHiddenPaths(prefs.get(AGENT_HIDDEN_PREFS_KEY)),
		diagnosticsText: () => currentDiagnosticsReport(diagnostics),
		readHostFile: async (tab, file) =>
			decodeBinaryRead(
				await devices.request(
					tab.device,
					"host.fs.readBinary",
					{ path: file, rtab: tab.tabId, cwd: tab.sidecar.cwd },
					HOST_FS_READ_BINARY_TIMEOUT_MS,
				),
			),
		chooseFile: async (caller, defaultPath) => {
			if (!caller.browserWindow) return null;
			const chosen = await dialog.showSaveDialog(caller.browserWindow, {
				defaultPath,
				filters: [{ name: "Zip", extensions: ["zip"] }],
			});
			return chosen.canceled ? null : (chosen.filePath ?? null);
		},
		downloadsDir: () => app.getPath("downloads"),
	});
	// omp keeps itself current (src/main/omp-updater.ts): a packaged app checks on its own; a test
	// launch only with a fake installer and OMP_GUI_TEST_OMP_UPDATES=1 (the fake omp's `update --check`
	// answers). OMPdesk's own update stays manual. It starts once machine setup's first pass has detected omp.
	const updater = new OmpUpdater({
		scheduled: testInstaller
			? process.env.OMP_GUI_TEST_OMP_UPDATES === "1"
			: app.isPackaged && process.env.OMP_GUI_HEADLESS !== "1",
		enabled: () => prefs.get(TOOLS_AUTO_UPDATE_PREF) !== false,
		fetchLatest: () => setup.latestOmp(),
		installed: () => {
			const presence = setup.state().items.find(item => item.id === "omp")?.presence;
			return presence?.kind === "present" ? presence.version : null;
		},
		update: (target, beforeInstall) => setup.updateOmp(target, beforeInstall),
		releaseHelpers: async () => {
			const stats = statsServer;
			statsServer = null;
			statsClient.port = 0;
			await Promise.all([stats?.kill(), stopStockHelper()]);
		},
		resume: async updated => {
			if (updated) {
				const resolution = await refreshSystemOmp();
				if (resolution.ok) hostOmpVersion = resolution.runtime.version;
			}
			await launchStats();
			if (updated) {
				sidecarPool.restartOnNewOmp();
				hostServices.restartOnNewOmp();
			}
		},
		onState: state => {
			for (const win of BrowserWindow.getAllWindows()) {
				if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.OMP_UPDATE_STATE, state);
			}
			// Devices that use this computer as their host show the same state.
			devices.hostOmpUpdateChanged(state);
		},
		// One quiet toast, in one window.
		onUpdated: notice => {
			const windows = BrowserWindow.getAllWindows().filter(win => !win.isDestroyed());
			const target = BrowserWindow.getFocusedWindow() ?? windows[0];
			target?.webContents.send(IPC_EVENTS.OMP_UPDATED, notice);
		},
	});
	ompUpdater = updater;
	registerOmpUpdateIpc(ipc, updater);
	// The vendor CLIs of connected accounts (Claude Code, Codex, Gemini, Cursor Agent, gh, …) keep current
	// the same way (src/main/cli-tools/, pref `toolsAutoUpdate`): already-installed tools only, through the
	// method that owns each. A test launch needs the fake installer and OMP_GUI_TEST_CLI_UPDATES=1. A
	// paired host does its own; remote tabs never reach this computer's tools.
	const cliToolUpdater = new CliUpdater({
		scheduled: testInstaller
			? process.env.OMP_GUI_TEST_CLI_UPDATES === "1"
			: app.isPackaged && process.env.OMP_GUI_HEADLESS !== "1",
		enabled: () => prefs.get(TOOLS_AUTO_UPDATE_PREF) !== false,
		platform: platform === "win32" ? "win32" : "darwin",
		toolsDir,
		connectedProviders: () =>
			stockHelperRequest<{ providers: string[] }>("accounts.providers").then(result => result.providers),
		env: async () => ({ ...process.env, ...(await shellSpawnEnv()), ...(await resolveProxyEnvForSpawn()) }),
		testInstaller,
		managedLatest: item => setup.latestManaged(item),
		runUpdate: request => setup.runToolUpdate(request),
		processes: psCommands,
		onState: state => {
			for (const win of BrowserWindow.getAllWindows()) {
				if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.CLI_UPDATE_STATE, state);
			}
		},
	});
	cliUpdater = cliToolUpdater;
	registerCliUpdateIpc(ipc, cliToolUpdater);
	// The marketplaces, plugins, skills and MCP servers of this computer's omp keep current too
	// (src/main/ext-update/, pref `toolsAutoUpdate`): stock's own refresh and upgrade run in the stock
	// helper's `extensions` worker, an MCP server's global binary is updated by the package manager that owns
	// it, and the live local tabs (this computer's own and the ones it hosts for paired devices) pick up the
	// result between turns. A test launch needs the fake installer and OMP_GUI_TEST_EXT_UPDATES=1.
	const extensionToolUpdater = new ExtensionUpdater({
		scheduled: testInstaller
			? process.env.OMP_GUI_TEST_EXT_UPDATES === "1"
			: app.isPackaged && process.env.OMP_GUI_HEADLESS !== "1",
		enabled: () => prefs.get(TOOLS_AUTO_UPDATE_PREF) !== false,
		platform: platform === "win32" ? "win32" : "darwin",
		toolsDir,
		helper: <T>(method: string, params: unknown, timeoutMs: number) =>
			stockHelperRequest<T>(method, params, { timeoutMs }),
		cwds: () => [...new Set([...sidecarPool.workspaceDirs(), ...hostServices.workspaceDirs()])],
		reaRoot: builtinDir,
		reaEnabled: () => reaEnabled(prefs.get(REA_PREF)),
		env: async () => ({ ...process.env, ...(await shellSpawnEnv()), ...(await resolveProxyEnvForSpawn()) }),
		testInstaller,
		// While omp is installed the stock helper is stopped; a request would start it again.
		blocked: () => updater.state().phase !== "idle",
		runUpdate: request => setup.runToolUpdate(request),
		processes: psCommands,
		apply: plan => {
			sidecarPool.applyExtensionUpdate(plan);
			hostServices.applyExtensionUpdate(plan);
		},
		onState: state => {
			for (const win of BrowserWindow.getAllWindows()) {
				if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.EXTENSION_UPDATE_STATE, state);
			}
		},
	});
	extensionUpdater = extensionToolUpdater;
	registerExtensionUpdateIpc(ipc, extensionToolUpdater);
	// One session's MCP change (an add, an adopted server, a sign-in, a reload) reaches every live session of this
	// computer, the tabs it hosts for paired devices included (mcp-live.ts).
	onMcpChange(change => {
		const plan = { ...EMPTY_APPLY_PLAN, mcp: change };
		sidecarPool.applyExtensionUpdate(plan);
		hostServices.applyExtensionUpdate(plan);
	});
	// ai-memory is OMPdesk's memory (src/main/ai-memory/, always on, no switch): the shipped binary is staged
	// into the tools dir, its per-user service serves it, and the omp sessions OMPdesk spawns load an app-owned
	// extension root with `-e` (nothing is written to ~/.omp/agent). A dev build reports only; OMP_GUI_AI_MEMORY_BIN
	// (tests, a developer's own build) runs exactly that binary; OMP_GUI_AI_MEMORY_UNIT_PIDFILE (the e2e fake's
	// "service" is a pid file) stands in for the OS service.
	const aiMemoryBinary = process.env.OMP_GUI_AI_MEMORY_BIN || null;
	const aiMemoryUnitPidFile = process.env.OMP_GUI_AI_MEMORY_UNIT_PIDFILE || null;
	/** The phase memory last reported (`onState`): a sync catches up when it turns `ready`. */
	let aiMemoryPhase: string | null = null;
	const aiMemory = new AiMemoryService({
		platform,
		arch: process.arch,
		automatic: !safeMode && (aiMemoryBinary !== null || (app.isPackaged && process.env.OMP_GUI_HEADLESS !== "1")),
		toolsDir,
		bundledDir: app.isPackaged
			? join(process.resourcesPath, "ai-memory-bin")
			: join(devResourcesDir, "ai-memory-bin", `${process.platform}-${process.arch}`),
		binaryOverride: aiMemoryBinary,
		noService: process.env.OMP_GUI_AI_MEMORY_NO_SERVICE === "1",
		// e2e runs shorten the automatic re-runs of a failed wiring pass with the same seam as the scheduled turn retry.
		...(process.env.OMP_GUI_RETRY_DELAYS_MS
			? { retryDelaysMs: retryDelays(process.env.OMP_GUI_RETRY_DELAYS_MS) }
			: {}),
		home: homedir(),
		agentDir,
		rootDir: join(app.getPath("userData"), "ai-memory", "omp-ext"),
		terminalPref: () => {
			const stored = prefs.get(AI_MEMORY_TERMINAL_PREF);
			return typeof stored === "boolean" ? stored : undefined;
		},
		persistTerminal: enabled => prefs.set(AI_MEMORY_TERMINAL_PREF, enabled),
		...(aiMemoryUnitPidFile ? { unit: pidFileControl(aiMemoryUnitPidFile) } : {}),
		spawnEnv: async () => ({ ...process.env, ...(await shellSpawnEnv()) }),
		beforeStart: afterFirstTab,
		// Windows starts `setup` through Bun; on a fresh machine the setup may still be installing it, and the setup's
		// state (its `onState` above) runs the wiring again once Bun is there.
		...(platform === "win32"
			? { bunPresent: async () => findBun({ ...process.env, ...(await shellSpawnEnv()) }) !== null }
			: {}),
		onState: state => {
			for (const win of BrowserWindow.getAllWindows()) {
				if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.AI_MEMORY_STATE, state);
			}
			// The repair and the learning run only while the server answers.
			if (state.phase === "ready") {
				aiMemoryUpkeep?.ready();
				aiMemoryCare?.ready();
			} else {
				aiMemoryUpkeep?.pause();
				aiMemoryCare?.pause();
			}
			void memoryRecallState.update(aiMemoryService?.recallEnv() ?? null);
			// Memory just came up: catch up with the computers this one is connected to.
			if (state.phase === "ready" && aiMemoryPhase !== "ready") {
				aiMemorySync?.syncAll();
				void recallTerms?.refresh();
			}
			aiMemoryPhase = state.phase;
		},
		log: (message, details) => writeRuntimeLog({ source: "ai-memory", message, details }),
	});
	aiMemoryService = aiMemory;
	// Memory's own quality upkeep (src/main/ai-memory/upkeep.ts): repairs old titles and child handoffs once per launch,
	// and learns decisions/rules/gotchas from a person's paused conversations on the user's cheap model.
	const memoryClient = new AiMemoryClient({
		url: () => aiMemory.state().serverUrl,
		dataDir: () => aiMemory.state().dataDir,
	});
	aiMemoryUpkeep = new MemoryUpkeep({
		client: memoryClient,
		model: async message => {
			const omp = await systemOmp();
			if (!omp.ok) throw new Error(omp.error);
			return runSmol(omp.runtime, message, join(app.getPath("temp"), "ompdesk-memory-upkeep"));
		},
		stateFile: join(app.getPath("userData"), "ai-memory", "upkeep.json"),
		log: (message, details) => writeRuntimeLog({ source: "ai-memory", message: `upkeep-${message}`, details }),
	});
	// Memory's own care (src/main/ai-memory/care.ts): after each update and then daily it fills in older conversations'
	// conclusions, hides pages a newer one repeats or contradicts and pages naming files that are gone; quiet but for the
	// runtime log and one line in Settings › Memory › Maintenance with Undo.
	const upkeepCwd = join(app.getPath("temp"), "ompdesk-memory-upkeep");
	const memoryJudge: PairJudge = async (pairs, rules) => {
		const omp = await systemOmp();
		if (!omp.ok) return null;
		await mkdir(upkeepCwd, { recursive: true });
		const judges = [
			jevJudge({
				omp: omp.runtime,
				hostFile: join(bridgeDir, "memory-judge-host.ts"),
				enabled: () => judgeAssistEnabled(prefs.get(JUDGE_ASSIST_PREF)),
				cwd: upkeepCwd,
			}),
		];
		// The cheap model reads stored pages to the provider, as learning reads conversations.
		judges.push(smolJudge({ model: message => runSmol(omp.runtime, message, upkeepCwd) }));
		return chainJudges(...judges)(pairs, rules);
	};
	aiMemoryCare = new MemoryCare({
		client: memoryClient,
		units: careUnits({
			client: memoryClient,
			judge: () => memoryJudge,
			sessionsDir: sessionIndex.sessionsDir,
			readMessages: path => sessionIndex.readMessages(path),
			origin: () => devices.deviceId,
			log: (message, details) => writeRuntimeLog({ source: "ai-memory", message, details }),
		}),
		version: app.getVersion(),
		stateFile: join(app.getPath("userData"), "ai-memory", "care.json"),
		log: (message, details) => writeRuntimeLog({ source: "ai-memory", message, details }),
	});
	// Memory shared between the person's paired computers (src/main/ai-memory/sync.ts): durable pages and session
	// conclusions, over the remote link. This computer serves `host.memory.*` to the devices allowed to use it, and
	// syncs with every host it is connected to when the link comes up, when memory comes up, and every few minutes.
	const memoryReady = (): boolean => aiMemory.state().phase === "ready";
	const memoryHost = { store: memoryClient, ready: memoryReady, selfId: () => devices.deviceId };
	hostServices.attachMemory({
		pull: (peer, params) => servePull(memoryHost, peer, params),
		push: (peer, params) => servePush(memoryHost, peer, params),
		conclusionsPull: (peer, params) => serveConclusionPull(memoryHost, peer, params),
		conclusionsPush: (peer, params) => serveConclusionPush(memoryHost, peer, params),
		allows: deviceId => devices.allowsPeer(deviceId),
	});
	aiMemorySync = new MemorySync({
		...memoryHost,
		onlineHosts: () => devices.onlineHosts(),
		request: (host, method, params, timeoutMs) => devices.request(host, method, params, timeoutMs),
		stateFile: join(app.getPath("userData"), "ai-memory", "sync.json"),
		log: (message, details) => writeRuntimeLog({ source: "memory-sync", message, details }),
		// e2e: the memory-sync spec waits seconds, not minutes.
		...(Number(process.env.OMP_GUI_TEST_MEMORY_SYNC_MS) > 0
			? { intervalMs: Number(process.env.OMP_GUI_TEST_MEMORY_SYNC_MS) }
			: {}),
	});
	devices.onHostOnline(host => aiMemorySync?.hostOnline(host));
	// A host's tab that kept running for this computer comes back attached: one the saved layout restored deferred is
	// started, one the layout lost (a quit that stalled before the relaunch) opens in the front window, adopted by
	// session path, under the ids the host knows.
	devices.onHostOnline(host => {
		void readoptHostTabs(host, {
			kept: deviceId => devices.keptTabs(deviceId),
			holder: (deviceId, sessionPath) => sidecarPool.sessionOwner(sessionPath, deviceId)?.tabId ?? null,
			start: tabId => {
				if (quitApproved() || sidecarPool.sidecarOf(tabId)?.status !== "asleep") return false;
				sidecarPool.startTab(tabId);
				return true;
			},
			open: (deviceId, tab) => {
				const win = windowManager.getTargetWindow();
				if (!win || quitApproved()) return null;
				const tabId = nextSnowflake();
				const sidecar = sidecarPool.acquire(
					tab.cwd,
					win,
					tabId,
					tab.sessionPath,
					tab.kind,
					undefined,
					false,
					false,
					false,
					tab.title,
					deviceId,
					undefined,
					[tab.rtab, ...tab.formerRtabs],
				);
				return sidecar ? tabId : null;
			},
			log: (step, details) => writeRuntimeLog({ source: "remote-tab", message: step, details }),
		});
	});
	// A tab restored asleep on a host's finished worktree closes, as one here does: the host's list is read as its link
	// comes up (the push follows only changes), then each change it pushes (`host.projects.changed`).
	devices.onHostOnline(host => {
		void devices
			.request<unknown>(host, "host.projects.command", { request: { action: "get" } })
			.then(data => closeFinishedTabs(host, SidebarProjectsStateSchema.parse(data)))
			.catch((error: unknown) =>
				writeRuntimeLog({
					source: "tab-layout",
					message: "finished worktree read failed",
					details: { level: "warn", device: host, error: error instanceof Error ? error.message : String(error) },
				}),
			);
	});
	devices.onHostProjects(closeFinishedTabs);
	aiMemorySync.start();
	// The term corpus of memory recall's coverage gate: read at memory-ready (onState above) and every ten minutes.
	recallTerms = new RecallTermsIndex({
		store: memoryClient,
		file: recallTermsFile,
		log: (message, details) => writeRuntimeLog({ source: "ai-memory", message, details }),
	});
	setInterval(() => {
		if (memoryReady()) void recallTerms?.refresh();
	}, RECALL_TERMS_REFRESH_MS).unref();
	registerAiMemoryIpc(ipc, aiMemory, {
		openExternal: url => shell.openExternal(url),
		openPath: path => shell.openPath(path),
		readClipboard: () => clipboard.readText(),
		writeClipboard: text => clipboard.writeText(text),
		care: () => aiMemoryCare,
	});
	// start() turns every failure into the `failed` phase and a log line; anything escaping it is logged too.
	void aiMemory.start().catch(error =>
		writeRuntimeLog({
			source: "ai-memory",
			message: "failed",
			stack: error instanceof Error ? error.stack : undefined,
			details: { detail: error instanceof Error ? error.message : String(error) },
		}),
	);
	void setup
		.start()
		.catch(() => undefined)
		.then(() => {
			updater.start();
			cliToolUpdater.start();
			extensionToolUpdater.start();
		});
	githubAuthService = createGithubAuthService(
		state => {
			for (const win of BrowserWindow.getAllWindows()) {
				if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.GITHUB_AUTH_STATE, state);
			}
		},
		{
			// A sign-in that finds gh missing installs it right then through setup's gh item (no back-off).
			installGh: () => setup.installForConnection("gh"),
			cancelGhInstall: () => {
				if (setup.state().items.find(item => item.id === "gh")?.phase === "running") setup.cancel();
			},
		},
	);
	registerGithubAuthIpc(ipc, githubAuthService);
	scheduleService = new ScheduleService({
		file: join(app.getPath("userData"), "schedules.json"),
		logDir: join(app.getPath("userData"), "schedule-runs"),
		launch: ompRunLauncher({
			omp: systemOmp,
			env: async () => ({ ...process.env, ...(await shellSpawnEnv()), ...(await resolveProxyEnvForSpawn()) }),
			extensionArgs: cwd => aiMemoryService?.extensionArgs(cwd) ?? Promise.resolve([]),
			extensionEnv: cwd => mcpHub?.ompEnv(cwd) ?? Promise.resolve({}),
		}),
		onState: state => {
			for (const win of BrowserWindow.getAllWindows()) {
				if (!win.isDestroyed()) win.webContents.send(SCHEDULES_STATE, state);
			}
			// Devices showing this computer's schedules (Settings › Schedules on a tab here) follow.
			devices.hostSchedulesChanged(state);
		},
		// A schedule a paired device saved here spends that device's daily model requests at every start.
		reserve: device => {
			const reservation = devices.reserveModelRequest(device);
			return reservation.ok
				? reservation
				: {
						ok: false,
						reason: `The daily ${reservation.refusal === "requests" ? "request" : "token"} limit of the device that saved this schedule is used up on this computer's models`,
					};
		},
	});
	void scheduleService.start();
	// Lists every folder sessions ran in (the first pass also the ones from before the list existed).
	void sidebarProjects.sync();
	logWatcher = new LogWatcher();

	// Settings › General › Window: closing the last window hides it to the tray
	// (Windows; macOS keeps running with no window anyway) or quits through the
	// quit guard, and this computer stays awake while any of its own tabs runs a turn.
	windowManager.lastWindowClose = () =>
		lastWindowCloseAction({
			platform: process.platform,
			quitApproved: quitApproved(),
			closeToTray: hasTray() && closeToTrayEnabled(prefs.get(CLOSE_TO_TRAY_PREF)),
		});
	windowManager.lastWindowHidden = () => {
		// macOS: the Dock icon is the way back and needs no explanation.
		if (process.platform === "darwin" || prefs.get(CLOSE_TO_TRAY_NOTICE_PREF) === true) return;
		prefs.set(CLOSE_TO_TRAY_NOTICE_PREF, true);
		appNotification({ title: mainT("tray.keepsRunningTitle"), body: mainT("tray.keepsRunningBody") }).show();
	};
	const workAwake = new KeepAwakePolicy({
		blocker: keepAwakeBlocker("work"),
	});
	workAwakePolicy = workAwake;
	const syncWorkAwake = () =>
		workAwake.update({
			enabled: prefs.get(KEEP_AWAKE_WORKING_PREF) !== false,
			connected: false,
			running: sidecarPool.tabInventory().some(tab => tab.inFlight),
		});
	// Interrupted turns continue on their own (turn-resume.ts): once the connection is back, and
	// after a relaunch. The marker file is rewritten on every run-state change, so a crash or a
	// SIGKILL, which run no quit hook, still leaves it behind.
	const connectivity = new ConnectivityMonitor({
		isOnline: () => net.isOnline(),
		// Right after a wake the OS can report a link before it carries traffic, and a dead DNS never shows in
		// `net.isOnline()`: ask the resolver itself, never its cache, and give up after `PROBE_TIMEOUT_MS`.
		// OMP_GUI_TEST_UNREACHABLE=1 (unpackaged e2e runs) makes every probe fail without touching the real resolver.
		probe: host =>
			!app.isPackaged && process.env.OMP_GUI_TEST_UNREACHABLE === "1"
				? Promise.resolve(false)
				: answersWithin(net.resolveHost(host ?? "example.com", { cacheUsage: "disallowed" }), PROBE_TIMEOUT_MS),
		now: Date.now,
		schedule: (run, ms) => {
			const timer = setTimeout(run, ms);
			return () => clearTimeout(timer);
		},
		changed: online => {
			turnResume.connectivityChanged();
			if (online) devices.wake("online");
		},
	});
	const turnResume = new TurnResume({
		store: new InterruptedTurnStore(join(app.getPath("userData"), "interrupted-turns.json"), error =>
			writeRuntimeLog({
				source: "turn-resume",
				message: "markers not saved",
				details: { error: error instanceof Error ? error.message : String(error) },
			}),
		),
		// This computer's own tabs and the ones it runs for paired devices (host-services.ts): the host
		// owns those turns, so their markers, waits and continuations are this computer's.
		pool: {
			resumeFacts: () => [...sidecarPool.resumeFacts(), ...hostServices.resumeFacts()],
			setAwaitingConnection: (tabId, awaiting) => {
				sidecarPool.setAwaitingConnection(tabId, awaiting);
				hostServices.setAwaitingConnection(tabId, awaiting);
			},
			// Only this computer's own tabs show the row: a paired device's tab mirrors its host's turn.
			setResuming: (tabId, resuming) => sidecarPool.setResuming(tabId, resuming),
			resumeRank: tabId => sidecarPool.resumeRank(tabId),
			// Only this computer's own tabs are ever scheduled: a hosted tab's retry would be invisible spend.
			setScheduledRetry: (tabId, retry) => sidecarPool.setScheduledRetry(tabId, retry),
			startTab: tabId => sidecarPool.startTab(tabId) ?? hostServices.startTab(tabId),
			tabForSession: (sessionPath, peer) =>
				peer ? hostServices.tabForSession(sessionPath, peer) : sidecarPool.tabForSession(sessionPath),
			// A move's command may be on its way in this computer's pool or in a hosted tab: the rules judge `touched` after.
			movesSettled: async tabId => {
				await Promise.all([sidecarPool.movesSettled(tabId), hostServices.movesSettled(tabId)]);
			},
			noteStopped: tabId => {
				sidecarPool.noteStopped(tabId);
				hostServices.noteStopped(tabId);
			},
		},
		network: {
			get online() {
				return connectivity.online;
			},
			shouldWait: () => connectivity.shouldWait(),
			verify: host => connectivity.verify(host),
		},
		enabled: () => prefs.get(RESUME_INTERRUPTED_PREF) !== false,
		scheduledRetry: {
			// OMP_GUI_RETRY_DELAYS_MS (comma list of ms) shortens the waits for e2e runs.
			delays: retryDelays(process.env.OMP_GUI_RETRY_DELAYS_MS),
			schedule: (run, ms) => {
				const timer = setTimeout(run, ms);
				return () => clearTimeout(timer);
			},
		},
		// A quit tears every tab down: that must not read as the turns ending.
		frozen: () => quitApproved(),
		now: Date.now,
		openTab: marker => {
			if (marker.peer) return devices.reviveHostTab(marker.peer, marker);
			const win = windowManager.getMainWindow();
			if (!win) return null;
			const sidecar = sidecarPool.acquire(marker.cwd, win, undefined, marker.sessionPath, marker.kind);
			return sidecar ? sidecarPool.tabForSession(marker.sessionPath) : null;
		},
		// An autopilot run is armed again before its goal resumes; the coordinator also learns when a tab's launch
		// continuation ended without resuming its goal, and then resumes the run itself (or, after the user's Stop on
		// the tab's resuming row, shows it paused: `app_closed`).
		resumeGoal: async tabId => {
			await autopilotRef.current?.resumeGoal(tabId);
		},
		goalSettled: (tabId, outcome) => autopilotRef.current?.resumeSettled(tabId, outcome),
		log: (message, details) => writeRuntimeLog({ source: "turn-resume", message, details }),
	});
	ipc.handle(IPC_COMMANDS.RESUME_CANCEL_WAIT, async (_caller, tabId: unknown) => {
		if (typeof tabId !== "string") return;
		// A paired host's tab: the host holds the wait, judged by its own connection.
		const sidecar = sidecarPool.sidecarOf(tabId);
		if (sidecar?.cancelHostWait) await sidecar.cancelHostWait();
		else turnResume.cancelWait(tabId);
	});
	// A paired device's Cancel on the wait or scheduled retry of a window's tab it views: this computer's own tab.
	sidecarPool.onCancelWait = tabId => turnResume.cancelWait(tabId);
	ipc.handle(IPC_COMMANDS.RESUME_STOP, async (_caller, tabId: unknown) => {
		if (typeof tabId === "string") await turnResume.stopResumed(tabId);
	});
	ipc.on(IPC_COMMANDS.CONNECTIVITY_REPORT, (_caller, online: unknown) => {
		if (typeof online === "boolean") connectivity.report(online);
	});
	setQuitResumes(() => prefs.get(RESUME_INTERRUPTED_PREF) !== false);
	powerMonitor.on("suspend", () => connectivity.suspend());
	powerMonitor.on("resume", () => {
		connectivity.resume();
		devices.wake("resume");
	});
	powerMonitor.on("unlock-screen", () => devices.wake("unlock"));
	app.on("browser-window-focus", () => devices.wake("focus"));
	// Chromium's own link state, sampled for changes the windows' events missed (a window may not exist).
	setInterval(() => connectivity.poll(), 3000).unref();
	sidecarPool.onRunningChange = () => {
		syncWorkAwake();
		turnResume.sync();
		hostServices.liveSessionsChanged();
	};
	// An ask opening or answered in a window changes what the paired devices show of its session's row.
	sidecarPool.observeTabs(activity => {
		if (activity.type !== "step") hostServices.liveSessionsChanged();
	});
	sidecarPool.settleWatch = new SettleWatch({
		facts: tabId => sidecarPool.settleFacts(tabId),
		log: details => writeRuntimeLog({ source: "settle-watch", message: "still settling", details }),
	});
	hostServices.attachResume(turnResume);
	// Disk care: idle worktrees' build output, landed and long-idle worktrees (saved first), the HTTP and Bun caches.
	// Automatic only in the packaged app outside a test run: a dev or test instance sees none of the real app's open
	// sessions, so their worktrees would look unused to it. The button runs it anywhere.
	const diskCareDir = join(app.getPath("userData"), "disk-care");
	const savedWorktrees = new SavedWorktreeStore(diskCareDir);
	setSavedWorktreeStore(savedWorktrees);
	const care = new DiskCare({
		bridge: tablessWorktreeBridge,
		openFolders: sessionOpenFolders,
		projects: () => {
			const { projects, removed } = sidebarProjects.state();
			return [...projects.map(project => project.path), ...removed];
		},
		userData: app.getPath("userData"),
		saved: savedWorktrees,
		clearHttpCache: () => session.defaultSession.clearCache(),
		bunBin: () => findBun(process.env),
		automatic: app.isPackaged && process.env.OMP_GUI_HEADLESS !== "1",
		worktrees:
			(app.isPackaged && process.env.OMP_GUI_HEADLESS !== "1") ||
			process.env.OMP_GUI_TEST_DISK_CARE_WORKTREES === "1",
		log: (message, details) =>
			writeRuntimeLog({
				source: "disk-care",
				message,
				details: { level: message === "failed" ? "error" : "info", ...details },
			}),
		broadcast: state => {
			for (const win of BrowserWindow.getAllWindows()) {
				if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.DISK_CARE_STATE, state);
			}
		},
	});
	diskCare = care;
	registerDiskCareIpc(ipc, care);
	void care.start();

	// Register all handlers and sidecar listeners before loading the renderer.
	const fileEditReports = new FileEditReports();
	registerIpcHandlers({
		fileEditReports,
		ipc,
		sidecarPool,
		sessionIndex,
		machine,
		logWatcher,
		windowManager,
		remoteDevices: devices,
		hostedTabs: hostServices,
		webTabNotice,
		secretaryAnswers,
		spawnWindow,
		initialCwd: resolveInitialCwd,
		worktreeLifecycle: lifecycle,
		worktreePrompts: prompts,
		autopilotRef,
		desktopSlotRef,
		checkoutFilesRef,
		relaunchContinuation: tabId => turnResume.relaunchContinuation(tabId),
		mediaStreams,
		uploads: { store: (deviceId, name, bytes) => hostUploads().store(deviceId, name, bytes) },
		schedules: () => scheduleService,
		sidebarProjects,
		// `webHost` is created below: the prompt origins read it when a prompt is sent, never at registration.
		promptOrigins: {
			of: win => webHost?.promptOrigin(win) ?? null,
			hostName: () => devices.deviceName(),
		},
		onPrefChanged: key => {
			if (key === KEEP_AWAKE_WORKING_PREF) syncWorkAwake();
			if (key === RESUME_INTERRUPTED_PREF) turnResume.sync();
			if (key === APP_AUTO_UPDATE_PREF) appAutoUpdatePrefChanged();
			if (key === TOOLS_AUTO_UPDATE_PREF) {
				updater.prefChanged();
				cliToolUpdater.prefChanged();
				extensionToolUpdater.prefChanged();
			}
			if (key === "themeName" || key === "theme") {
				nativeTheme.themeSource = nativeThemeSource(prefsStore().get("themeName"), prefsStore().get("theme"));
			}
		},
	});
	protocol.handle(MEDIA_SCHEME, request => mediaStreams.handle(request));
	webHost = new WebHost({
		ipc,
		onPageConnectionEnded: connId => fileEditReports.forget(connId),
		userData: app.getPath("userData"),
		// The built renderer: `web.html` and its assets sit beside `index.html` (a dev run has none).
		staticRoot: () => join(__dirname, "../renderer"),
		desktopWindows: () => windowManager.getAllWindows(),
		tabs: {
			activeTab: win => sidecarPool.activeTabForWindow(win),
			cwd: (win, tabId) => {
				const target = sidecarPool.tabTarget(win, tabId);
				return target && !target.device ? target.sidecar.cwd : null;
			},
			facts: tabId => sidecarPool.tabFacts(tabId),
			resnapshot: win => sidecarPool.resnapshotWindow(win),
		},
		openMedia: (url, range) => mediaStreams.handle(new Request(url, range ? { headers: { range } } : undefined)),
		shell: {
			openPath: abs => openLocalPath(abs, shell),
			reveal: abs => shell.showItemInFolder(abs),
			openExternal: url => shell.openExternal(url),
		},
		allowedUsers: () => mobileWebService?.allowedUsers() ?? [],
		// Off unless the user turned it on (Settings › Mobile web): a device Tailscale vouches for connects on its own.
		confirmNewDevices: () => mobileWebService?.confirmNewDevices() ?? false,
		whois: address => mobileWebService?.whois(address) ?? Promise.resolve(null),
		onUnpairedAuth: () =>
			appNotification({ title: mainT("web.unknownDevice.title"), body: mainT("web.unknownDevice.body") }).show(),
		language: () => getMainLanguage(),
		log: message => console.warn(`[web-push] ${message}`),
	});
	// Uploads expire on their own whether or not Mobile web serves: a paired computer's attached files land there too.
	void webHost.keepUploadsSwept();
	// Paired phones hear of finished turns, failures and asks through Web Push (web/web-push-notifier.ts); a question
	// the secretary answers for the owner is not pushed (agent-control/secretary.ts), a confirmation card for the owner is.
	sidecarPool.observeTabs(activity => {
		if (activity.type === "ask" && secretaryAnswers.current?.(activity.tabId, activity.text)) return;
		webHost?.tabActivity(activity);
	});
	webTabNotice.current = (tabId, notice) => webHost?.tabNotice(tabId, notice);
	webHost.devices.onRevoked(deviceId => webTabLayouts.drop(deviceId));
	const host = webHost;
	// Mobile web's Tailscale side (src/main/tailscale/): the switch, Tailscale's own setup and the published
	// address. The server it starts is the WebHost above. `OMP_GUI_TEST_TAILSCALE_OPEN` is a test's stand-in
	// for "start the Tailscale app" (the fake CLI of e2e/fixture/fake-tailscale.ts), never set by users.
	let lastMobileWebUrl: string | null = null;
	const mobileWeb = new MobileWebService({
		platform,
		prefs: {
			get: key => prefs.get(key),
			set: (key, value) => prefs.set(key, value),
			delete: key => prefs.delete(key),
		},
		server: {
			// The loopback port is 47831 when it is free; the published port is chosen separately (serve.ts).
			start: async () => {
				try {
					return await host.start({ port: MOBILE_WEB_PORT });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
					return host.start({ port: 0 });
				}
			},
			stop: () => host.stop(),
			configure: address => host.server.configure(address),
		},
		serveSecret: () => host.serveSecret(),
		setup,
		locate: locateTs,
		exec: execFileExecutor,
		startApp: located =>
			tailscaleOs
				? startTailscaleApp(located, tailscaleOs, execFileExecutor, process.env.OMP_GUI_TEST_TAILSCALE_OPEN || null)
				: Promise.reject(new Error("Mobile web needs macOS or Windows")),
		openExternal: url => shell.openExternal(url),
		openSystemSettings: () =>
			shell.openExternal(
				tailscaleOs === "darwin"
					? "x-apple.systempreferences:com.apple.preference.security"
					: "ms-settings:network-vpn",
			),
		// Desktop windows only: a paired phone reads the state through its own call.
		onState: state => {
			for (const win of BrowserWindow.getAllWindows()) {
				if (!win.isDestroyed()) win.webContents.send(MOBILE_WEB_STATE, state);
			}
			// Paired devices show this computer's page to their phones (`HostView.webUrl`): tell them when it moves.
			if (state.url !== lastMobileWebUrl) {
				lastMobileWebUrl = state.url;
				hostServices.mobileWebLinkChanged(state.url);
			}
		},
	});
	mobileWebService = mobileWeb;
	ipc.handle(MOBILE_WEB_GET_STATE, () => mobileWeb.state());
	ipc.handle(MOBILE_WEB_COMMAND, (_caller, request: unknown) => mobileWeb.request(request));
	// Switched on when the app last ran: published again (or found already in place) without a click.
	void mobileWeb.start();
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
	const savedLayouts = readSavedTabLayouts({ log: true });
	// An update's relaunch comes back as the app sat when it began: hidden in the tray, minimized or behind another
	// app (the user's rule, 23 Oct 2026: it reopened maximized in front of them). Only the windows this launch restores.
	const relaunchPresence = explicitStartupCwd ? null : readRelaunchPresence();
	windowManager.launchPresence = relaunchPresence;
	spawnWindow(explicitStartupCwd);
	markStartup("window-created");
	// A bare launch restores the saved session in full. The window above carries
	// layout[0]; these are the secondary windows whose tabs used to be dropped at
	// relaunch. An argv cwd is an explicit "open this", not a restore.
	if (!explicitStartupCwd) {
		for (const layout of savedLayouts.slice(1)) spawnWindowWithLayout(layout);
	}
	windowManager.launchPresence = null;
	// macOS activates the relaunched app; one that comes back in the tray gives the focus straight back.
	if (relaunchPresence === "hidden" && process.platform === "darwin") app.hide();
	// Each paired phone's or tablet's tabs come back into its window, as the host's sessions (web/web-tab-layouts.ts).
	if (webHost) {
		const paired = new Set(webHost.devices.list().map(device => device.deviceId));
		for (const { deviceId, layout } of webTabLayouts.restorable(paired)) {
			sidecarPool.restoreLayout(webHost.windows.windowFor(deviceId), layout);
		}
	}
	// After the saved windows (and so their tabs) exist: go on with what the last process left running.
	turnResume.launch();

	// Tray, menu, deep links, updater. Test runs (OMP_GUI_HEADLESS) skip the tray:
	// the menu bar is shared with the user's own OMPdesk, and a test's status item
	// once stalled this main thread (MenuBarAgent never completed its scene), so
	// the first window never reached Playwright (release run 38048085831).
	if (process.env.OMP_GUI_HEADLESS !== "1") createTray(windowManager, spawnWindow);
	createMenu(windowManager, spawnWindow);
	setupDeepLinks(windowManager, spawnWindow);
	setupUpdater(ipc, {
		// Default on: only a stored `false` turns it off (an unattended Mac running Autopilot updates itself).
		enabled: () => prefs.get(APP_AUTO_UPDATE_PREF) !== false,
		resumes: () => prefs.get(RESUME_INTERRUPTED_PREF) !== false,
		// Running turns, compactions and open asks, on this computer's tabs and the ones it hosts for paired devices.
		busy: () =>
			sidecarPool.tabInventory().some(tab => tab.inFlight) ||
			[...sidecarPool.resumeFacts(), ...hostServices.resumeFacts()].some(fact => fact.running || fact.awaitingUi),
		asking: () =>
			sidecarPool.restartHolds().planWaiting ||
			[...sidecarPool.resumeFacts(), ...hostServices.resumeFacts()].some(fact => fact.awaitingUi),
		compacting: () => sidecarPool.restartHolds().compacting || hostServices.compacting(),
	});
});

// macOS: re-create window on dock click
app.on("activate", () => {
	if (!windowManager) return;
	const windows = windowManager.getAllWindows();
	const action = activateAction({
		quitApproved: quitApproved(),
		windowCount: windows.length,
		anyVisible: windows.some(win => win.isVisible()),
	});
	if (action === "spawn") spawnWindow();
	if (action !== "show") return;
	const win = windowManager.getTargetWindow() ?? windows[0];
	if (win.isMinimized()) win.restore();
	win.show();
	win.focus();
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
		// Each step is named to the hang watchdog first: a stalled quit then names the step that never returned.
		const steps: Array<[string, () => void]> = [
			["stats-server", () => void statsServer?.kill()],
			["mcp-hub", () => void mcpHub?.kill()],
			["omp-updater", () => ompUpdater?.dispose()],
			["cli-updater", () => cliUpdater?.dispose()],
			["extension-updater", () => extensionUpdater?.dispose()],
			["setup", () => setupService?.dispose()],
			["ai-memory-sync", () => aiMemorySync?.dispose()],
			["ai-memory-upkeep", () => aiMemoryUpkeep?.dispose()],
			["ai-memory-care", () => aiMemoryCare?.dispose()],
			["ai-memory", () => aiMemoryService?.dispose()],
			["github-auth", () => githubAuthService?.dispose()],
			["schedules", () => scheduleService?.dispose()],
			["work-awake", () => workAwakePolicy?.dispose()],
			["lid-awake", () => lidAwake?.dispose()],
			["disk-care", () => diskCare?.stop()],
			["sidecars", () => sidecarPool?.disposeAll()],
			["remote-devices", () => void remoteDevices?.dispose()],
			["mobile-web", () => mobileWebService?.dispose()],
			["web-host", () => void webHost?.stop()],
			["session-index", () => sessionIndex?.stop()],
			["log-watcher", () => logWatcher?.stop()],
			["tray", () => destroyTray()],
		];
		for (const [name, run] of steps) {
			markMainStep("quit", `teardown:${name}`);
			run();
		}
		markMainStep("quit", "teardown:done");
	},
	async () => {
		const lifecycle = worktreeLifecycle;
		if (!lifecycle) return;
		await lifecycle.finalize({
			prepare: async tabId => {
				const sidecar = sidecarPool.sidecarOf(tabId);
				if (!sidecar) return;
				// Stock stops the turn first, so the questions describe a worktree nothing still writes to.
				recordTurnStop({ command: "abort", tab: tabId, by: "quit", surface: "worktree-finalize" });
				await sidecar.rpcClient?.command({ type: "abort" }).catch(() => undefined);
				await lifecycle.refreshExitPolicy(tabId, () => readLiveLifecycleSettings(sidecar));
			},
			release: tabId => sidecarPool.releaseTabWhenExited(tabId),
		});
	},
);
