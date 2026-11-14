/**
 * Node's client of the app updater (`updater.*`, native/ompdesk/crates/shell/PROTOCOL.md §15.8). The shell does the
 * work: the GitHub release check, the token, the downloads, the macOS staging and swap helper, the Windows installer,
 * the install marker, the background-check timer. Node keeps what needs Node's other state:
 *
 * - the mirror of the shell's status (`current`), localized with `mainT`, sent to every window and to the main-process
 *   listeners (the tray, the paired pages);
 * - the automatic install's scheduler (`app-auto-update.ts`, reading the tab pool) and its once-a-second tick;
 * - the confirm of a person's restart and the quit path (`app-quit.ts`);
 * - the window presence an install remembers, the runtime log (`gui-runtime.jsonl`, source `app-update`) and the next
 *   launch's report of the last install (`update-log-core.ts`).
 *
 * `.omp/rules/app-updater.md` says what must survive.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { app, BrowserWindow, autoUpdater as nativeAutoUpdater } from "electron";
import { codedError } from "../../../shared/ipc-error-codes";
import type { UpdateAuthInfo, UpdateAuthTestResult, UpdateInstallMode, UpdateStatus } from "../../../shared/ipc-types";
import { IPC_COMMANDS, IPC_EVENTS } from "../../../shared/ipc-types";
import { AutoInstallScheduler, type InstallTrigger } from "../../app-auto-update";
import { writeFileAtomicSync } from "../../atomic-file";
import { type BackgroundWork, NO_BACKGROUND_WORK } from "../../background-work";
import { writeRuntimeLog } from "../../runtime-log";
import { resolveLoginShellEnv, spawnPath } from "../../shell-env";
import {
	lastSwapEntry,
	type PendingInstall,
	parsePendingInstall,
	parseStartFailure,
	previousInstallDetails,
	relaunchPresence,
	START_FAILED_FILE,
	START_MARK_FILE,
	type StartFailure,
	type SwapLogEntry,
	scrubUpdateText,
	startFailureOf,
	startMarkJson,
	type UpdateLogDetails,
	type WindowPresence,
	windowPresenceOf,
} from "../../update-log-core";
import type { IpcRegistry } from "../../web/ipc-registry";
import { HostError } from "../client";
import { systemIdleSeconds } from "../shell-calls";
import { type MainTextKey, mainT } from "./boot";
import { markMainStep } from "./chrome-hang";
import { confirmUpdateRestart, disarmQuitWatchdog, onQuitForcedExit, requestQuit } from "./chrome-quit";
import { shellModule } from "./client";

/** An update status as the shell sends it: an error carries the `MAIN_TEXT` key to translate, not the text. */
type RawStatus =
	| Exclude<UpdateStatus, { state: "error" }>
	| { state: "error"; key: MainTextKey; suffix?: string; detail?: string; showInBanner?: boolean };

/** What every status event and every answer about the updater's state carries. */
interface State {
	status: RawStatus;
	/** `restartableUpdate()`: a relaunch with its bundle staged, or a Windows installer downloaded. */
	installable: boolean;
	mode: UpdateInstallMode;
}

type UpdaterSpec = {
	calls: {
		start: { params: { version: string }; result: State };
		check: { params: Record<string, never>; result: State };
		download: { params: Record<string, never>; result: State };
		install: {
			params: { trigger: InstallTrigger; presence?: WindowPresence };
			result: { then: "quit" | "quit-for-update" | "none" };
		};
		authInfo: { params: Record<string, never>; result: UpdateAuthInfo };
		authTest: { params: { token?: string }; result: UpdateAuthTestResult };
		authSave: { params: { token: string }; result: UpdateAuthTestResult };
		authClear: { params: Record<string, never>; result: UpdateAuthInfo };
	};
	posts: {
		quit: { trigger: InstallTrigger; presence?: WindowPresence };
	};
	events: {
		status: State;
	};
	asks: {
		loginEnv: { params: Record<string, never>; result: { token?: string; path: string } };
	};
};

const updater = shellModule<UpdaterSpec>("updater");

/** Each tick's look at the facts; a dev run shortens the countdown with OMP_DEV_UPDATE_AUTO_COUNTDOWN_MS. */
const AUTO_INSTALL_TICK_MS = 1000;

/**
 * App version for the updates row. `app.getVersion()` reads the HOST
 * package.json — the Electron binary's own when unpacked (dev shows
 * "36.9.5"), so dev resolves the project's package.json from the bundle
 * location instead. Packaged builds keep app.getVersion().
 */
export function appVersion(): string {
	if (app.isPackaged) return app.getVersion();
	try {
		// out/main/index.js → ../../package.json (dev bundle layout).
		const raw = fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && "version" in parsed && typeof parsed.version === "string") {
			return parsed.version;
		}
	} catch {}
	return app.getVersion();
}

/** Current status, replayed to any window that asks (renderer boot/refresh). */
let current: UpdateStatus = { state: "idle" };
let installMode: UpdateInstallMode = "automatic";
/** The shell's `installable`: a relaunch with its bundle staged, or a Windows installer downloaded. */
let installable = false;
/** The last raw status the shell sent, as JSON: an answer that repeats it needs no second broadcast. */
let lastRaw: string | undefined;
/**
 * The version Node's own install is under way for. The shell's `downloaded` status never says "installing", so every
 * downloaded status of that version carries it until a status of another state arrives.
 */
let installingVersion: string | undefined;
/** Installs a downloaded update by itself at a quiet moment (Settings › Updates & about); null before `setupUpdater`. */
let autoInstall: AutoInstallScheduler | null = null;
/**
 * Seconds without keyboard or mouse input, read from the shell just before each look (`tickAutoInstall`): the answer
 * comes from another process, so the scheduler's synchronous facts hold the last one. It can only be older than the
 * moment of the decision, never ahead of it, so a person who just touched the computer is never taken for idle.
 */
let idleSeconds = 0;
/** The probe's background-work ask, for a click on "Restart & install"; null before `setupUpdater`. */
let askBackgroundWork: (() => Promise<BackgroundWork>) | null = null;
/** The trigger of the install in progress; unset until one starts, so an approved quit with an update staged counts as `quit`. */
let installTrigger: InstallTrigger | undefined;
/** How the windows sat when the install began (read before the quit tears them down). */
let presenceAtInstall: WindowPresence | undefined;
/** The shell was told the approved quit (`updater.quit`); it starts the swap helper once. */
let quitPosted = false;
/** `updater.start` answered (or failed): the install mode is known. */
let started: Promise<void> = Promise.resolve();

/** Samples the idle time, then lets the scheduler decide; a failed sample counts as "not idle". */
async function tickAutoInstall(): Promise<void> {
	idleSeconds = await systemIdleSeconds().catch(() => 0);
	autoInstall?.tick();
}

/** What the auto-install decision reads from the app (index.ts owns prefs and the tab pool). */
export interface AutoInstallProbe {
	/** Pref `appAutoUpdate`. */
	enabled: () => boolean;
	/** Continue interrupted work after relaunch is on. */
	resumes: () => boolean;
	/** A tab runs a turn or compacts, or an ask is open (this computer's tabs and the ones it hosts). */
	busy: () => boolean;
	/** An ask, an approval or a plan proposal waits on the person (a subset of `busy`; the log names it as the reason). */
	asking: () => boolean;
	/** Of those, a plan proposal: a relaunch loses it, so it holds the automatic restart however long nobody is there. */
	planWaiting: () => boolean;
	/** A tab compacts its context: a resume-on restart waits for it (a cut compaction does not resume). */
	compacting: () => boolean;
	/** Running background subagents and jobs of every tab on this computer, asked fresh (`background-work.ts`). */
	backgroundWork: () => Promise<BackgroundWork>;
}

/** One decision line in `gui-runtime.jsonl` (source `app-update`, info level). */
function logUpdate(message: "check" | "download" | "scheduler" | "swap", details: UpdateLogDetails): void {
	writeRuntimeLog({ source: "app-update", message, details: { level: "info", ...details } });
}

/** What the next launch reports an install from: the version before and after, written when the helper starts. */
function pendingInstallPath(): string {
	return path.join(app.getPath("userData"), "update-install.json");
}

function currentWindowPresence(): WindowPresence | undefined {
	return windowPresenceOf(
		BrowserWindow.getAllWindows()
			.filter(win => !win.isDestroyed())
			.map(win => ({ visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused() })),
	);
}

/**
 * How the relaunch an update made should show its windows: as they sat when the install began (hidden in the tray,
 * minimized, behind another app), read from the install marker before the first window opens. Null for any other
 * launch, and for an install the person started in front of the app.
 */
export function readRelaunchPresence(): WindowPresence | null {
	try {
		return relaunchPresence(parsePendingInstall(fs.readFileSync(pendingInstallPath(), "utf8")), Date.now()) ?? null;
	} catch {
		return null;
	}
}

/** The first launch after an install says how it ended: the version before and after (macOS adds `swap.log`'s last entry). */
function reportPreviousInstall(): void {
	let raw: string;
	try {
		raw = fs.readFileSync(pendingInstallPath(), "utf8");
		fs.rmSync(pendingInstallPath(), { force: true });
	} catch {
		return;
	}
	const pending: PendingInstall | undefined = parsePendingInstall(raw);
	if (!pending) return;
	let swap: SwapLogEntry | undefined;
	if (pending.mode === "relaunch") {
		try {
			const log = fs.readFileSync(path.join(app.getPath("userData"), "updates", "swap.log"), "utf8");
			swap = lastSwapEntry(log.slice(-16 * 1024));
		} catch {}
	}
	logUpdate("swap", previousInstallDetails(pending, appVersion(), swap));
	const failure = startFailureOf(pending, appVersion(), swap, Date.now(), startFailure);
	if (failure) rememberStartFailure(failure);
}

/** The start mark a macOS swap helper waits for after it reopened the new app (`SWAP_SCRIPT`). */
function startMarkPath(): string {
	return path.join(app.getPath("userData"), START_MARK_FILE);
}

let startNoted = false;

/**
 * The app's first window has loaded its page: say so, once per launch. Writes the start mark, then reports the
 * previous install. In this order a new app that dies before its first page leaves `update-install.json` unread,
 * and the old app the swap helper restored reports `rolled back` from it.
 */
export function noteAppStarted(): void {
	if (startNoted) return;
	startNoted = true;
	try {
		writeFileAtomicSync(startMarkPath(), startMarkJson(appVersion(), process.pid, Date.now()));
	} catch (error) {
		logUpdate("swap", {
			event: "start-mark-failed",
			reason: scrubUpdateText(error instanceof Error ? error.message : String(error)),
		});
	}
	reportPreviousInstall();
	// This version started: a failure recorded for it earlier (a person installed it anyway) no longer holds.
	if (startFailure?.version === appVersion()) clearStartFailure();
}

/**
 * The version whose start failed after an install (`update-start-failed.json`), read once at setup. The automatic
 * install leaves that version alone, or it would install, fail and roll back again at every safe point; a person's
 * "Restart & install" still installs it, and any other version clears it.
 */
let startFailure: StartFailure | undefined;

function startFailedPath(): string {
	return path.join(app.getPath("userData"), START_FAILED_FILE);
}

function rememberStartFailure(failure: StartFailure): void {
	startFailure = failure;
	try {
		writeFileAtomicSync(startFailedPath(), JSON.stringify(failure));
	} catch (error) {
		logUpdate("swap", {
			event: "start-failure-not-saved",
			reason: scrubUpdateText(error instanceof Error ? error.message : String(error)),
		});
	}
}

/** The downloaded version is the one that failed to start; a different one (a newer release) clears the record. */
function startFailedBefore(): boolean {
	if (!startFailure) return false;
	if (current.state !== "downloaded") return false;
	if (current.version === startFailure.version) return true;
	clearStartFailure();
	return false;
}

function clearStartFailure(): void {
	startFailure = undefined;
	fs.rmSync(startFailedPath(), { force: true });
}

/** What is downloaded is the version whose start failed, and nobody started its install: only a person's click installs it. */
function heldStartFailed(): boolean {
	return (
		startFailure !== undefined &&
		current.state === "downloaded" &&
		!current.installing &&
		current.version === startFailure.version
	);
}

/**
 * An install starts: remember who asked, and tell the window. Starting the installer and quitting take seconds
 * the window cannot speak in (and a second click meanwhile started the install twice), so the status says
 * "installing" first. The scheduler logs it once, whoever started it, and decides nothing more (12 Nov 2026: a click
 * left it deciding, and it logged a safe point and a countdown one second after the click).
 */
function beginInstall(trigger: InstallTrigger): void {
	installTrigger = trigger;
	presenceAtInstall = currentWindowPresence();
	autoInstall?.installStarted(trigger);
	if (current.state === "downloaded") {
		installingVersion = current.version;
		broadcast({ state: "downloaded", version: current.version, mode: current.mode, installing: true });
	}
}

/** An approved quit with an update staged installs it, though nothing asked: the quit is the trigger. */
function quitInstallTrigger(): InstallTrigger {
	if (installTrigger === undefined) beginInstall("quit");
	return installTrigger ?? "quit";
}

const statusListeners = new Set<(status: UpdateStatus) => void>();

/** Main-process subscribers to every status change (the tray menu); returns the unsubscribe. */
export function onUpdateStatus(listener: (status: UpdateStatus) => void): () => void {
	statusListeners.add(listener);
	return () => statusListeners.delete(listener);
}

function broadcast(status: UpdateStatus): void {
	current = status.state === "downloaded" && !status.installing ? withNotice(status) : status;
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send(IPC_EVENTS.UPDATER_STATUS, current);
	}
	for (const listener of statusListeners) listener(current);
}

/**
 * A downloaded update with the countdown the scheduler shows now (`restartAt`). Any status that reaches the windows
 * goes through here, so a re-broadcast of the staged update (a manual re-check) keeps the countdown and one that went
 * never lingers.
 */
function withNotice(status: Extract<UpdateStatus, { state: "downloaded" }>): UpdateStatus {
	const { restartAt: _restartAt, ...plain } = status;
	const restartAt = autoInstall?.restartAt;
	return restartAt === undefined ? plain : { ...plain, restartAt };
}

/** The status in the UI language: an error's key becomes its text (with the suffix the shell added). */
function localize(raw: RawStatus): UpdateStatus {
	if (raw.state !== "error") return raw;
	return {
		state: "error",
		message: mainT(raw.key) + (raw.suffix ? ` (${raw.suffix})` : ""),
		...(raw.detail !== undefined ? { detail: raw.detail } : {}),
		...(raw.showInBanner !== undefined ? { showInBanner: raw.showInBanner } : {}),
	};
}

/** A status the shell sent: localized, carrying Node's "installing" for the version Node began installing. */
function receive(raw: RawStatus): void {
	let status = localize(raw);
	if (status.state !== "downloaded") installingVersion = undefined;
	else if (installingVersion === status.version) status = { ...status, installing: true };
	broadcast(status);
}

/** The shell's state, from an event or from the answer to a call. An answer that repeats the last event changes nothing. */
function mirror(state: State, fromEvent: boolean): void {
	installable = state.installable;
	installMode = state.mode;
	const raw = JSON.stringify(state.status);
	if (!fromEvent && raw === lastRaw) return;
	lastRaw = raw;
	receive(state.status);
}

/** A status Node itself made (a call failed): the shell's next answer shows its own state again. */
function showLocal(status: UpdateStatus): void {
	lastRaw = undefined;
	broadcast(status);
}

/** Error status for a failed call: the localized `key` headline with the raw cause kept as `detail`. */
function failureStatus(error: unknown, key: MainTextKey, showInBanner: boolean): UpdateStatus {
	return {
		state: "error",
		message: mainT(key),
		detail: error instanceof Error ? error.message : String(error),
		showInBanner,
	};
}

/** The updater's current state (also what a paired device sees for this computer). */
export function updateStatus(): UpdateStatus {
	return current;
}

/**
 * A user-started check. A downloaded update is the answer and changes nothing: Settings › Updates checks as it opens,
 * and a "checking" status in between made the automatic install give up its round (the countdown or the waiting
 * notice went, the max wait started over). The shell's own `checking` status reaches the windows, not this function.
 * A download held as start-failed is looked past: a newer release replaces it, and the shell keeps it meanwhile.
 */
export async function checkForUpdate(): Promise<UpdateStatus> {
	if (current.state === "downloaded" && !heldStartFailed()) return current;
	try {
		mirror(await updater.call("check", {}), false);
	} catch (error) {
		// A held download is still the answer when the look fails.
		if (!heldStartFailed()) showLocal(failureStatus(error, "updates.checkFailed", true));
	}
	return current;
}

/** Start the download of the update a check found. */
export async function downloadUpdate(): Promise<UpdateStatus> {
	if (current.state !== "available") return current;
	try {
		mirror(await updater.call("download", {}), false);
	} catch (error) {
		showLocal(failureStatus(error, "updates.downloadFailed", true));
	}
	return current;
}

/**
 * Whether `restartIntoUpdate` can install what is downloaded: relaunch or
 * automatic mode with its files in place. The manual DMG needs someone at the
 * Mac to drag the app, so it never qualifies.
 */
export function restartableUpdate(): boolean {
	return current.state === "downloaded" && installable && current.mode !== "manual";
}

/**
 * "Restart & install" (the app's button, `updates.apply`, the tray): the one install path. `from` is where the person
 * pressed it: a paired page already asked on its own screen (its confirm sheet names the running work), so nobody
 * would answer a dialog here.
 */
export async function applyUpdate(from: "here" | "device" = "here"): Promise<void> {
	if (current.state !== "downloaded" || current.installing) return;
	if (current.mode === "manual") {
		// The manual DMG: the shell reopens the verified file in Finder; nothing quits.
		try {
			await updater.call("install", { trigger: "user click" });
		} catch (error) {
			showLocal(failureStatus(error, "updates.openInstallerFailed", true));
		}
		return;
	}
	if (!restartableUpdate()) {
		showLocal({ state: "error", message: mainT("updates.installerMissing"), showInBanner: true });
		return;
	}
	// ⌘Q's rule: running turns continue after the restart (turn-resume.ts), so this asks only with that setting off, or
	// when background subagents or jobs would start over (the scheduler's own install never asks).
	if (
		from === "here" &&
		!(await confirmUpdateRestart(() => (askBackgroundWork ?? (async () => NO_BACKGROUND_WORK))()))
	)
		return;
	await installNow("user click");
}

/**
 * Quit into the downloaded update and reopen (relaunch: the swap helper;
 * automatic: the Windows installer). Callers have already confirmed
 * the quit; it stops every tab this computer runs.
 */
export function restartIntoUpdate(trigger: InstallTrigger): void {
	void installNow(trigger);
}

async function installNow(trigger: InstallTrigger): Promise<void> {
	if (current.state !== "downloaded" || current.installing || current.mode === "manual") return;
	if (!restartableUpdate()) {
		showLocal({ state: "error", message: mainT("updates.installerMissing"), showInBanner: true });
		return;
	}
	markMainStep("update", installMode === "relaunch" ? "relaunch-swap: quit" : "quit-and-install");
	beginInstall(trigger);
	let then: "quit" | "quit-for-update" | "none";
	try {
		({ then } = await updater.call("install", {
			trigger,
			...(presenceAtInstall ? { presence: presenceAtInstall } : {}),
		}));
	} catch (error) {
		// A failed install leaves the app running: the committed quit is off.
		disarmQuitWatchdog("update");
		installTrigger = undefined;
		installingVersion = undefined;
		showLocal(failureStatus(error, "updates.failed", true));
		return;
	}
	if (then === "none") {
		// Nothing was staged: the shell's error status went out.
		installTrigger = undefined;
		installingVersion = undefined;
		return;
	}
	if (then === "quit") {
		requestQuit();
		return;
	}
	// The installer started (or failed to): electron-updater's quit, which app-quit.ts tears down on.
	nativeAutoUpdater.emit("before-quit-for-update");
	app.quit();
}

/** Which install path this copy runs; Settings explains why the automatic switch is unavailable in `manual`. */
export function updateInstallMode(): UpdateInstallMode {
	return installMode;
}

/** Pref `appAutoUpdate` changed: look at once instead of at the next tick; settles once the scheduler looked. */
export function appAutoUpdatePrefChanged(): Promise<void> {
	return tickAutoInstall();
}

/** The automatic install's "Later" (the notice here, a paired page's or a paired computer's). */
export function postponeUpdate(): void {
	autoInstall?.postpone();
}

/** The shell reports an approved quit once: it starts the swap helper (relaunch) or the silent installer (Windows). */
function postQuit(): void {
	if (quitPosted) return;
	quitPosted = true;
	const trigger = quitInstallTrigger();
	const presence = presenceAtInstall ?? currentWindowPresence();
	void updater.post("quit", { trigger, ...(presence ? { presence } : {}) });
}

/** A rejected auth call whose code the Settings row explains: rethrown the way the window's IPC carries a code. */
async function authCall<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (
			error instanceof HostError &&
			(error.code === "keychain_would_ask" || error.code === "safe_storage_unavailable")
		) {
			throw codedError(error.code, error.message);
		}
		throw error;
	}
}

export function setupUpdater(ipc: IpcRegistry, probe: AutoInstallProbe): void {
	askBackgroundWork = probe.backgroundWork;
	try {
		startFailure = parseStartFailure(fs.readFileSync(startFailedPath(), "utf8"));
	} catch {}
	autoInstall = new AutoInstallScheduler({
		now: Date.now,
		facts: () => {
			const enabled = probe.enabled();
			const resumes = probe.resumes();
			return {
				enabled,
				installable: restartableUpdate(),
				startFailedBefore: startFailedBefore(),
				resumes,
				busy: probe.busy(),
				asking: probe.asking(),
				planWaiting: probe.planWaiting(),
				compacting: probe.compacting(),
				focused: BrowserWindow.getAllWindows().some(win => win.isFocused()),
				idleMs: idleSeconds * 1000,
			};
		},
		countdownMs: Number(process.env.OMP_DEV_UPDATE_AUTO_COUNTDOWN_MS) || undefined,
		// Dev/test seam (unpackaged only): a short max wait, to reach the forced restart after "Later" in a test.
		maxWaitMs: (!app.isPackaged && Number(process.env.OMP_DEV_UPDATE_AUTO_MAX_WAIT_MS)) || undefined,
		log: (event, details) => logUpdate("scheduler", { event, ...details }),
		effects: {
			announce: () => broadcast(current),
			withdraw: () => broadcast(current),
			install: () => restartIntoUpdate("auto"),
		},
	});
	setInterval(() => void tickAutoInstall(), AUTO_INSTALL_TICK_MS).unref();

	// Relaunch mode: any approved quit installs the staged bundle; "Restart" additionally reopens it. `will-quit` only
	// fires once the quit guard agreed; the quit watchdog's forced `app.exit` skips it, so it reports the same quit
	// through the same once-only call. The mode is the shell's (known once `updater.start` answered).
	app.on("will-quit", () => {
		if (installMode === "relaunch" && installable) postQuit();
	});
	onQuitForcedExit(() => {
		if (installMode === "relaunch" && installable) postQuit();
	});
	// Windows: the installer starts silently when the app ends with code 0 and no install began, an approved quit or a
	// forced `exit(0)` alike (the shim emits `quit` for both, as electron-updater's `autoInstallOnAppQuit` read it).
	app.on("quit", (_event: unknown, code: number) => {
		if (installMode === "automatic" && code === 0 && installTrigger === undefined && current.state === "downloaded")
			postQuit();
	});

	updater.on("status", state => mirror(state, true));
	// The shell asks for the login shell's token and PATH (for `gh`) while it checks: serve it before the first call.
	updater.serve("loginEnv", async () => {
		const login = await resolveLoginShellEnv();
		const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || login.env.GH_TOKEN || login.env.GITHUB_TOKEN;
		return { ...(token ? { token } : {}), path: await spawnPath() };
	});

	ipc.handle(IPC_COMMANDS.UPDATER_CHECK, () => checkForUpdate());
	ipc.handle(IPC_COMMANDS.UPDATER_DOWNLOAD, () => downloadUpdate());
	// A paired page's click was confirmed on its own screen (src/renderer/web/shim.ts); a window's asks here.
	ipc.handle(IPC_COMMANDS.UPDATER_APPLY, caller => applyUpdate(caller.connId ? "device" : "here"));
	ipc.handle(IPC_COMMANDS.UPDATER_POSTPONE, () => postponeUpdate());
	ipc.handle(IPC_COMMANDS.UPDATER_INSTALL_MODE, async () => {
		await started;
		return installMode;
	});
	ipc.handle(IPC_COMMANDS.UPDATER_GET_STATUS, () => current);
	ipc.handle(IPC_COMMANDS.UPDATER_VERSION, () => appVersion());
	ipc.handle(IPC_COMMANDS.UPDATER_AUTH_INFO, () => authCall(() => updater.call("authInfo", {})));
	ipc.handle(IPC_COMMANDS.UPDATER_AUTH_TEST, (_caller, token?: string) =>
		authCall(() => updater.call("authTest", token === undefined ? {} : { token })),
	);
	ipc.handle(IPC_COMMANDS.UPDATER_AUTH_SAVE, (_caller, token: string) =>
		authCall(() => updater.call("authSave", { token })),
	);
	ipc.handle(IPC_COMMANDS.UPDATER_AUTH_CLEAR, () => authCall(() => updater.call("authClear", {})));

	// The shell detects the install mode, applies the dev seams, sweeps debris and starts the background check.
	started = updater.call("start", { version: appVersion() }).then(
		state => mirror(state, false),
		error => {
			const reason = scrubUpdateText(error instanceof Error ? error.message : String(error));
			logUpdate("check", { event: "error", kind: "start-failed", reason });
		},
	);
}
