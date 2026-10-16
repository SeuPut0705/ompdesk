/**
 * GitHub release updates. A release carries two assets, `ompdesk-mac-arm64.dmg`
 * and `ompdesk-windows-setup.exe`, and their version, size and SHA-512 in an
 * HTML comment in its notes (src/main/update-release.ts); a custom
 * electron-updater provider (src/main/update-provider.ts) turns that into
 * electron-updater's UpdateInfo. Install paths:
 *
 * - Windows keeps electron-updater's NSIS flow, downloaded in the background
 *   and applied on restart or quit (full download: no blockmaps ship);
 * - macOS builds in a writable location ("relaunch") download the DMG in the
 *   background, verify its SHA-512, copy the app out of the mounted image,
 *   verify its signature/identity, and swap the bundle in place from a
 *   detached helper once the app exits — on "Restart" (then relaunch) or on
 *   any approved quit (no relaunch). This covers certificate-signed builds
 *   too: Squirrel would need a ZIP the release no longer ships;
 * - builds the app cannot replace (read-only volume, translocated) fall back
 *   to the verified DMG opened in Finder ("manual").
 *
 * Transfers report progress through one shared renderer state machine; an
 * interrupted transfer keeps its `.partial` and continues from that offset.
 * Only one macOS transfer runs at a time (a check or download request meanwhile
 * just returns its status), and one that receives nothing for
 * DOWNLOAD_IDLE_TIMEOUT_MS fails as retryable.
 *
 * The release repo is public, so a check and a download carry no credentials
 * by default. A configured GitHub token (src/main/update-auth.ts) is added to
 * every request as a rate-limit raise, and keeps updates working if the repo
 * is private again; only when the repo answers an anonymous request with
 * "not found" does the state become `auth-required`.
 */

import { execFile, spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { app, BrowserWindow, net, shell } from "electron";
import type { UpdateInfo } from "electron-updater";
import pkg from "electron-updater";
// Not node:fs: Electron's fs treats `app.asar` as a directory, so a recursive rm
// of a staged bundle fails with ENOTEMPTY and leaves the archive behind; every
// later download then died sweeping that leftover (a skipped update could never
// be skipped). Nothing here reads inside an archive.
import * as fs from "original-fs";
import type { UpdateAuthTestResult, UpdateInstallMode, UpdateStatus } from "../shared/ipc-types";
import { IPC_COMMANDS, IPC_EVENTS } from "../shared/ipc-types";
import { confirmQuit, requestQuit } from "./app-quit";
import { mainT } from "./i18n";
import type { MainTextKey } from "./i18n-text";
import {
	checkRepoAccess,
	clearUpdateToken,
	GITHUB_API_REPO,
	resolveUpdateToken,
	storeUpdateToken,
	updateAuthInfo,
} from "./update-auth";
import { releaseUpdateProvider } from "./update-provider";
import { type PlatformRelease, UPDATE_METADATA_ERROR, UPDATE_PLATFORM_ERROR } from "./update-release";
import {
	DOWNLOAD_IDLE_TIMEOUT_MS,
	githubApiHeaders,
	installerPartialPath,
	isSwappableBundleLocation,
	type MacInstallerAsset,
	macBundlePath,
	macDownloadName,
	planInstallerTransfer,
	SingleTransfer,
	StageBundleError,
	SWAP_SCRIPT,
	settleFailedUpdateCheck,
	settleIncompleteUpdateCheck,
	sha512FileBase64,
	stageBundleFromDmg,
	sweepInstallerPartials,
	type ToolResult,
	withinIdle,
} from "./updater-state";
import type { IpcRegistry } from "./web/ipc-registry";

const { autoUpdater } = pkg;

// Five minutes: a release reaches users within one interval. One GitHub API
// call per check is 12 an hour, under the 60/h anonymous limit.
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const PROGRESS_INTERVAL_MS = 100;

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
let activeUpdate: UpdateInfo | undefined;
/** The release the last check resolved; macOS takes its DMG from here. */
let resolvedRelease: PlatformRelease | undefined;
/** The DMG the current macOS mode downloads (manual: to Downloads; relaunch: to staging). */
let macAsset: MacInstallerAsset | undefined;
let downloadedInstallerPath: string | undefined;
/** Running bundle the relaunch mode replaces (`/Applications/OMPdesk.app`). */
let ownBundle: string | undefined;
/** Verified new bundle waiting for the swap (relaunch mode). */
let stagedApp: string | undefined;
/** The approved quit came from "Restart & install": reopen after the swap. */
let relaunchAfterSwap = false;
/** Token the last check authenticated with, if any; the macOS asset download reuses it. */
let updateToken: string | undefined;
/** A check's failure is classified by runCheck, so the updater's own error event stays quiet. */
let checkInFlight = false;
/** The macOS DMG download; a second one would append to the same `.partial`. */
const macTransfer = new SingleTransfer();

function isWritable(target: string): boolean {
	try {
		fs.accessSync(target, fs.constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/** Relaunch needs a bundle we may replace; anything else gets the Finder DMG. */
function swappableBundle(bundle: string | undefined): string | undefined {
	if (bundle && isSwappableBundleLocation(bundle) && isWritable(bundle) && isWritable(path.dirname(bundle))) {
		return bundle;
	}
	return undefined;
}

function detectInstallMode(): UpdateInstallMode {
	if (process.platform !== "darwin") return "automatic";

	// Test seams for unpackaged preview builds; never override a release bundle.
	// Relaunch needs a writable stand-in bundle to replace (OMP_DEV_UPDATE_BUNDLE).
	if (!app.isPackaged) {
		const override = process.env.OMP_DEV_UPDATE_MODE;
		if (override === "relaunch") {
			ownBundle = swappableBundle(process.env.OMP_DEV_UPDATE_BUNDLE);
			return ownBundle ? "relaunch" : "manual";
		}
		if (override === "manual") return "manual";
	}

	// Ad-hoc or certificate-signed alike: the release ships a DMG, not the ZIP Squirrel needs.
	ownBundle = swappableBundle(app.isPackaged ? macBundlePath(process.execPath) : undefined);
	return ownBundle ? "relaunch" : "manual";
}

function updatesDirectory(): string {
	return path.join(app.getPath("userData"), "updates");
}

function runTool(command: string, args: readonly string[]): Promise<ToolResult> {
	const { promise, resolve } = Promise.withResolvers<ToolResult>();
	execFile(command, [...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
		resolve({ ok: !error, stdout }),
	);
	return promise;
}

/** Copy the app out of the verified DMG and prove it is this app at `version`, intact. */
async function stageBundle(dmgPath: string, version: string): Promise<string> {
	if (!ownBundle) throw new Error(mainT("updates.installerMissing"));
	try {
		return await stageBundleFromDmg({
			dmgPath,
			stagingDir: path.join(updatesDirectory(), version),
			mountRoot: os.tmpdir(),
			version,
			ownBundle,
			run: runTool,
			fs: fs.promises,
		});
	} catch (error) {
		if (!(error instanceof StageBundleError)) throw error;
		if (error.reason === "missing") throw new Error(mainT("updates.installerMissing"));
		if (error.reason === "verify") throw new Error(mainT("updates.hashMismatch"));
		throw new Error(`${mainT("updates.downloadFailed")} (${error.reason})`);
	}
}

/** Hand the swap to a detached helper that outlives this process (never launchd). */
function launchSwap(staged: string, destination: string, relaunch: boolean): void {
	const log = path.join(updatesDirectory(), "swap.log");
	const child = spawn(
		"/bin/bash",
		[
			"-c",
			SWAP_SCRIPT,
			"ompdesk-swap",
			String(process.pid),
			staged,
			destination,
			relaunch ? "1" : "0",
			log,
			...process.argv.slice(1),
		],
		{ detached: true, stdio: "ignore" },
	);
	child.unref();
}

function availableDownloadPath(fileName: string): string {
	const downloadsDirectory = app.getPath("downloads");
	const extension = path.extname(fileName);
	const stem = path.basename(fileName, extension);
	let candidate = path.join(downloadsDirectory, fileName);
	for (let suffix = 2; fs.existsSync(candidate); suffix += 1) {
		candidate = path.join(downloadsDirectory, `${stem} (${suffix})${extension}`);
	}
	return candidate;
}

async function fileSize(filePath: string): Promise<number> {
	try {
		return (await fs.promises.stat(filePath)).size;
	} catch {
		return 0;
	}
}

async function openManualInstaller(filePath: string): Promise<void> {
	shell.showItemInFolder(filePath);
	const openError = await shell.openPath(filePath);
	if (openError) throw new Error(mainT("updates.openInstallerFailed"));
}

/**
 * Signed CDN URL for a release asset. The API asset endpoint answers an
 * `application/octet-stream` request with a redirect to a short-lived signed
 * URL (a private repo 404s on `releases/download/...`, so this one path serves
 * both). The redirect is taken by hand because Chromium would forward the
 * Authorization header, when there is one, to the CDN, which rejects a second
 * auth mechanism.
 */
async function signedAssetUrl(assetApiUrl: string, token: string | undefined, signal: AbortSignal): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const request = net.request({ url: assetApiUrl, redirect: "manual" });
	for (const [name, value] of Object.entries(githubApiHeaders(token, "application/octet-stream"))) {
		request.setHeader(name, value);
	}
	request.on("redirect", (_status, _method, redirectUrl) => {
		resolve(redirectUrl);
		request.abort();
	});
	request.on("response", response => {
		reject(new Error(`${mainT("updates.downloadFailed")} (${response.statusCode})`));
		request.abort();
	});
	request.on("error", reject);
	signal.addEventListener("abort", () => request.abort(), { once: true });
	request.end();
	return promise;
}

async function downloadMacAsset(
	version: string,
	asset: MacInstallerAsset,
	token: string | undefined,
	mode: "manual" | "relaunch",
): Promise<void> {
	// Manual installers land in Downloads for Finder; relaunch DMGs are private staging.
	if (mode === "relaunch") await fs.promises.mkdir(updatesDirectory(), { recursive: true });
	const destinationPath =
		mode === "manual" ? availableDownloadPath(asset.name) : path.join(updatesDirectory(), asset.name);
	const partialPath = installerPartialPath(destinationPath);
	// Every network step gets the idle timeout: a stalled transfer fails as
	// retryable instead of sitting in `downloading` forever.
	const controller = new AbortController();
	const abort = () => controller.abort();
	const assetUrl = await withinIdle(
		signedAssetUrl(asset.url, token, controller.signal),
		DOWNLOAD_IDLE_TIMEOUT_MS,
		abort,
	);
	// Partials of releases this one superseded can never be continued.
	if (mode === "manual") await sweepInstallerPartials(path.dirname(partialPath), partialPath);
	else await sweepUpdatesDirectory(asset.name);

	let existing = await fileSize(partialPath);
	if (existing > asset.size) {
		await fs.promises.rm(partialPath, { force: true });
		existing = 0;
	}
	const response = await withinIdle(
		net.fetch(assetUrl, {
			signal: controller.signal,
			...(existing > 0 ? { headers: { range: `bytes=${existing}-` } } : {}),
		}),
		DOWNLOAD_IDLE_TIMEOUT_MS,
		abort,
	);
	const plan = planInstallerTransfer(existing, {
		status: response.status,
		contentRange: response.headers.get("content-range") ?? undefined,
	});
	if (!response.ok || !response.body) {
		// A 416 means the offset is past the release's bytes, so the partial could
		// never complete; everything else leaves it for the next attempt.
		if (response.status === 416) await fs.promises.rm(partialPath, { force: true });
		throw new Error(`${mainT("updates.downloadFailed")} (${response.status})`);
	}

	const total = asset.size;
	let transferred = plan.offset;
	let lastProgressAt = 0;
	const file = await fs.promises.open(partialPath, plan.append ? "a" : "w");

	try {
		const reader = response.body.getReader();
		for (;;) {
			const { done, value } = await withinIdle(reader.read(), DOWNLOAD_IDLE_TIMEOUT_MS, abort);
			if (done) break;
			let offset = 0;
			while (offset < value.byteLength) {
				const { bytesWritten } = await file.write(value, offset, value.byteLength - offset);
				offset += bytesWritten;
			}
			transferred += value.byteLength;
			const now = performance.now();
			if (now - lastProgressAt >= PROGRESS_INTERVAL_MS || (total > 0 && transferred === total)) {
				broadcast({
					state: "downloading",
					version,
					mode,
					percent: total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0,
				});
				lastProgressAt = now;
			}
		}
		await file.sync();
	} finally {
		// Bytes already written stay: an interrupted transfer resumes from here.
		await file.close();
	}

	if ((await sha512FileBase64(partialPath)) !== asset.sha512) {
		await fs.promises.rm(partialPath, { force: true });
		throw new Error(mainT("updates.hashMismatch"));
	}

	await fs.promises.rename(partialPath, destinationPath);
	if (mode === "relaunch") {
		stagedApp = await stageBundle(destinationPath, version);
		await fs.promises.rm(destinationPath, { force: true });
		broadcast({ state: "downloaded", version, mode });
		return;
	}
	downloadedInstallerPath = destinationPath;
	// e2e/headless runs verify the download but never put Finder on screen.
	if (process.env.OMP_GUI_HEADLESS !== "1") await openManualInstaller(destinationPath);
	broadcast({ state: "downloaded", version, mode });
}

/** Drop staging left by older releases; keep this release's partial so it can resume. */
async function sweepUpdatesDirectory(keepAsset: string): Promise<void> {
	const keep = new Set([keepAsset, installerPartialPath(keepAsset), "swap.log"]);
	let entries: string[] = [];
	try {
		entries = await fs.promises.readdir(updatesDirectory());
	} catch {
		return;
	}
	// One stubborn leftover must never block the download that replaces it.
	await Promise.allSettled(
		entries
			.filter(entry => !keep.has(entry))
			.map(entry => fs.promises.rm(path.join(updatesDirectory(), entry), { recursive: true, force: true })),
	);
}

/** Background download for relaunch mode; failures stay out of the banner like any passive check. */
async function prepareRelaunchUpdate(version: string): Promise<void> {
	if (!macAsset) return;
	try {
		await startMacDownload(version, macAsset, updateToken, "relaunch");
	} catch (error) {
		broadcast(failureStatus(error, "updates.downloadFailed", false));
	}
}

/** The one macOS asset download; callers return early while `macTransfer.running`. */
function startMacDownload(
	version: string,
	asset: MacInstallerAsset,
	token: string | undefined,
	mode: "manual" | "relaunch",
): Promise<void> {
	return macTransfer.start(() => {
		broadcast({ state: "downloading", version, mode, percent: 0 });
		return downloadMacAsset(version, asset, token, mode);
	});
}

function broadcast(status: UpdateStatus): void {
	current = status;
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send(IPC_EVENTS.UPDATER_STATUS, status);
	}
}

/** Failure copy this module already localized when it threw (installer download/verify/open). */
const OWN_FAILURE_KEYS: readonly MainTextKey[] = [
	"updates.downloadFailed",
	"updates.hashMismatch",
	"updates.installerMissing",
	"updates.openInstallerFailed",
];

/**
 * Error status for an updater failure. Our own throws already carry localized
 * copy; anything else (electron-updater, network stack) becomes the localized
 * `fallback` headline with the raw text kept as `detail`.
 */
function failureStatus(error: unknown, fallback: MainTextKey, showInBanner: boolean): UpdateStatus {
	const raw = error instanceof Error ? error.message : String(error);
	if (OWN_FAILURE_KEYS.some(key => raw.startsWith(mainT(key)))) return { state: "error", message: raw, showInBanner };
	return { state: "error", message: mainT(fallback), detail: raw, showInBanner };
}

/** Release-notes excerpt for the banner; updater carries HTML/markdown-ish notes. */
function notesOf(info: { releaseNotes?: unknown }): string | undefined {
	const notes = info.releaseNotes;
	if (typeof notes === "string") return notes.slice(0, 500);
	if (Array.isArray(notes)) {
		const first = notes[0] as { note?: string } | undefined;
		return first?.note?.slice(0, 500);
	}
	return undefined;
}

/**
 * One update check, anonymous unless a token is configured. `manual` checks
 * surface failures in the banner; background polls only update Settings.
 */
async function runCheck(manual: boolean): Promise<void> {
	let token = (await resolveUpdateToken())?.token;
	let rejected = false;
	checkInFlight = true;
	try {
		updateToken = token;
		let failure = await attemptCheck(token);
		// GitHub answers 401 to a bad token even for public data (an expired
		// GH_TOKEN, a stale `gh` login). The repo is public, so ask again
		// without it instead of blocking updates on the stale credential.
		if (failure && token && (await checkRepoAccess(token)) === "invalid") {
			rejected = true;
			token = undefined;
			updateToken = undefined;
			failure = await attemptCheck(undefined);
		}
		if (!failure) {
			const settled = settleIncompleteUpdateCheck(current, manual, mainT("updates.noResult"));
			if (settled !== current) broadcast(settled);
			return;
		}
		const error = failure.error;
		let access = await checkRepoAccess(token);
		// An anonymous request GitHub answers "not found" means the repo is
		// private again: a token is needed (or the one tried was rejected).
		if (access === "denied" && !token) access = rejected ? "invalid" : "missing";
		const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
		const detail = error instanceof Error ? error.message : String(error);
		// A release without usable metadata is no update, but never a silent one.
		const message =
			code === UPDATE_METADATA_ERROR
				? mainT("updates.releaseInvalid")
				: code === UPDATE_PLATFORM_ERROR
					? mainT("updates.installerMissing")
					: mainT("updates.checkFailed");
		broadcast(settleFailedUpdateCheck(access, code, message, appVersion(), manual, detail));
	} finally {
		checkInFlight = false;
	}
}

/** Points electron-updater at the release feed with `token` (none = anonymous) and checks once. */
async function attemptCheck(token: string | undefined): Promise<{ error: unknown } | undefined> {
	resolvedRelease = undefined;
	autoUpdater.setFeedURL({
		provider: "custom",
		updateProvider: releaseUpdateProvider({
			apiRepo: GITHUB_API_REPO,
			platform: process.platform === "win32" ? "windows" : "mac",
			// A pre-release only exists for the updater test harness; never in a release bundle.
			allowPrerelease: !app.isPackaged && process.env.OMP_DEV_UPDATE_PRERELEASE === "1",
			apiHeaders: githubApiHeaders(token),
			downloadHeaders: githubApiHeaders(token, "application/octet-stream"),
			fetch: (url, init) => net.fetch(url, init),
			onResolved: release => {
				resolvedRelease = release;
			},
		}),
	});
	try {
		await autoUpdater.checkForUpdates();
		return undefined;
	} catch (error) {
		return { error };
	}
}

async function testAuth(token: string | undefined): Promise<UpdateAuthTestResult> {
	if (token?.trim()) return { access: await checkRepoAccess(token.trim()), source: null };
	const resolved = await resolveUpdateToken();
	const access = await checkRepoAccess(resolved?.token);
	// Anonymous and refused: the repo is private, so a token is what is missing.
	if (!resolved) return { access: access === "denied" ? "missing" : access, source: null };
	return { access, source: resolved.source };
}

/** The updater's current state (also what a paired device sees for this computer). */
export function updateStatus(): UpdateStatus {
	return current;
}

/** A user-started check; a macOS transfer in flight keeps its state. */
export async function checkForUpdate(): Promise<UpdateStatus> {
	if (macTransfer.running) return current;
	broadcast({ state: "checking" });
	await runCheck(true);
	return current;
}

/** Start the download of the update a check found. */
export async function downloadUpdate(): Promise<UpdateStatus> {
	if (current.state !== "available" || macTransfer.running) return current;
	try {
		if (current.mode === "manual" || current.mode === "relaunch") {
			if (!macAsset) throw new Error(mainT("updates.installerMissing"));
			await startMacDownload(activeUpdate?.version ?? current.version, macAsset, updateToken, current.mode);
		} else {
			await autoUpdater.downloadUpdate();
		}
	} catch (error) {
		broadcast(failureStatus(error, "updates.downloadFailed", true));
	}
	return current;
}

/**
 * Whether `restartIntoUpdate` can install what is downloaded: relaunch or
 * automatic mode with its files in place. The manual DMG needs someone at the
 * Mac to drag the app, so it never qualifies.
 */
export function restartableUpdate(): boolean {
	if (current.state !== "downloaded") return false;
	if (current.mode === "relaunch") return stagedApp !== undefined && ownBundle !== undefined;
	return current.mode === "automatic";
}

/**
 * Quit into the downloaded update and reopen (relaunch: the swap helper;
 * automatic: electron-updater's installer). Callers have already confirmed
 * the quit; it stops every tab this computer runs.
 */
export function restartIntoUpdate(): void {
	if (current.state !== "downloaded") return;
	if (current.mode === "relaunch") {
		if (!stagedApp || !ownBundle) {
			broadcast({ state: "error", message: mainT("updates.installerMissing"), showInBanner: true });
			return;
		}
		relaunchAfterSwap = true;
		requestQuit();
		return;
	}
	// Once approved, quitAndInstall() emits before-quit-for-update and the
	// quit guard runs ⌘Q's teardown.
	if (current.mode === "automatic") autoUpdater.quitAndInstall();
}

export function setupUpdater(ipc: IpcRegistry): void {
	installMode = detectInstallMode();
	// Installs interrupted by older builds keyed the partial by process id, which
	// nothing could ever continue — those orphans are the only debris a startup
	// sweep can identify for sure.
	if (process.platform === "darwin") void sweepInstallerPartials(app.getPath("downloads"));
	// Updates download in the background as soon as a check finds one (Claude/Codex
	// style); the only prompt is "Restart & install". Manual DMGs still wait for a click.
	autoUpdater.autoDownload = installMode === "automatic";
	autoUpdater.autoInstallOnAppQuit = installMode === "automatic";
	// Releases publish no blockmaps; NSIS always downloads the whole installer.
	autoUpdater.disableDifferentialDownload = true;
	// Dev/preview verification gate: electron-updater skips unpackaged apps
	// unless forced. Pair with OMP_DEV_UPDATE_MODE to exercise the DMG paths.
	if (process.env.OMP_DEV_UPDATE_CHECK === "1") autoUpdater.forceDevUpdateConfig = true;
	// Relaunch mode: any approved quit installs the staged bundle; "Restart"
	// additionally reopens it. `will-quit` only fires once the quit guard agreed.
	if (installMode === "relaunch") {
		app.on("will-quit", () => {
			if (stagedApp && ownBundle) launchSwap(stagedApp, ownBundle, relaunchAfterSwap);
		});
	}

	autoUpdater.on("checking-for-update", () => broadcast({ state: "checking" }));
	autoUpdater.on("update-available", info => {
		// The transfer in flight keeps its asset and version; restarting it would
		// append a second stream to the same partial.
		if (macTransfer.running) return;
		activeUpdate = info;
		// A manual re-check of the release already staged must not fetch it again.
		if (installMode === "relaunch" && stagedApp && path.basename(path.dirname(stagedApp)) === info.version) {
			broadcast({ state: "downloaded", version: info.version, mode: "relaunch" });
			return;
		}
		macAsset = undefined;
		downloadedInstallerPath = undefined;
		stagedApp = undefined;
		if (installMode === "manual" || installMode === "relaunch") {
			// Only Apple Silicon builds ship; an Intel Mac has no installer to fetch.
			if (process.arch !== "arm64") {
				broadcast({ state: "error", message: mainT("updates.unsupportedArchitecture") });
				return;
			}
			const release = resolvedRelease?.version === info.version ? resolvedRelease : undefined;
			if (!release) {
				broadcast({ state: "error", message: mainT("updates.installerMissing") });
				return;
			}
			macAsset = {
				name: macDownloadName(info.version),
				url: release.assetUrl,
				sha512: release.file.sha512,
				size: release.file.size,
			};
		}
		broadcast({ state: "available", version: info.version, notes: notesOf(info), mode: installMode });
		if (installMode === "relaunch") void prepareRelaunchUpdate(info.version);
	});
	autoUpdater.on("update-not-available", () => broadcast({ state: "not-available", version: appVersion() }));
	autoUpdater.on("download-progress", progress => {
		if (installMode !== "automatic") return;
		broadcast({
			state: "downloading",
			version: activeUpdate?.version ?? appVersion(),
			mode: "automatic",
			percent: Math.round(progress.percent),
		});
	});
	autoUpdater.on("update-downloaded", info =>
		broadcast({ state: "downloaded", version: info.version, mode: "automatic" }),
	);
	autoUpdater.on("error", error => {
		if (checkInFlight) return;
		// Passive failures remain unobtrusive. Explicit IPC actions catch and
		// rebroadcast the same failure as user-visible.
		broadcast(failureStatus(error, "updates.failed", false));
	});

	ipc.handle(IPC_COMMANDS.UPDATER_CHECK, () => checkForUpdate());
	ipc.handle(IPC_COMMANDS.UPDATER_DOWNLOAD, () => downloadUpdate());
	ipc.handle(IPC_COMMANDS.UPDATER_APPLY, async () => {
		if (current.state !== "downloaded") return;
		if (current.mode === "manual") {
			if (!downloadedInstallerPath) {
				broadcast({ state: "error", message: mainT("updates.installerMissing"), showInBanner: true });
				return;
			}
			try {
				await openManualInstaller(downloadedInstallerPath);
			} catch (error) {
				broadcast(failureStatus(error, "updates.openInstallerFailed", true));
			}
			return;
		}
		if (!restartableUpdate()) {
			broadcast({ state: "error", message: mainT("updates.installerMissing"), showInBanner: true });
			return;
		}
		// ⌘Q's rule: running work continues after the restart (turn-resume.ts), so this asks only with that setting off.
		if (!(await confirmQuit())) return;
		restartIntoUpdate();
	});
	ipc.handle(IPC_COMMANDS.UPDATER_GET_STATUS, () => current);
	ipc.handle(IPC_COMMANDS.UPDATER_VERSION, () => appVersion());
	ipc.handle(IPC_COMMANDS.UPDATER_AUTH_INFO, () => updateAuthInfo());
	ipc.handle(IPC_COMMANDS.UPDATER_AUTH_TEST, (_caller, token?: string) => testAuth(token));
	ipc.handle(IPC_COMMANDS.UPDATER_AUTH_SAVE, async (_caller, token: string): Promise<UpdateAuthTestResult> => {
		const trimmed = token.trim();
		if (!trimmed) return { access: "missing", source: null };
		const access = await checkRepoAccess(trimmed);
		if (access === "ok") await storeUpdateToken(trimmed);
		return { access, source: access === "ok" ? "stored" : null };
	});
	ipc.handle(IPC_COMMANDS.UPDATER_AUTH_CLEAR, async () => {
		await clearUpdateToken();
		return updateAuthInfo();
	});

	// First check once the app settles; then every five minutes. A downloaded or
	// in-flight update is never replaced by a background re-check.
	const backgroundCheck = () => {
		if (current.state === "downloading" || current.state === "downloaded") return;
		void runCheck(false);
	};
	setTimeout(backgroundCheck, 3000);
	setInterval(backgroundCheck, CHECK_INTERVAL_MS);
}
