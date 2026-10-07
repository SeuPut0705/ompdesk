/**
 * GitHub release updates. Install paths:
 *
 * - certificate-signed macOS builds and Windows keep electron-updater's
 *   staged flow (Squirrel ZIP / NSIS), downloaded in the background and
 *   applied on restart or quit;
 * - ad-hoc-signed macOS builds in a writable location ("relaunch") download
 *   the architecture-matched ZIP in the background, verify its release
 *   SHA-512 and the extracted bundle's signature/identity, and swap the bundle
 *   in place from a detached helper once the app exits — on "Restart" (then
 *   relaunch) or on any approved quit (no relaunch). Squirrel cannot do this
 *   for ad-hoc builds: it requires a stable signing identity;
 * - ad-hoc builds the app cannot replace (read-only volume, translocated)
 *   fall back to the verified DMG opened in Finder ("manual").
 *
 * Transfers report progress through one shared renderer state machine; an
 * interrupted transfer keeps its `.partial` and continues from that offset.
 *
 * Releases live in a private repo, so every request — release lookup, the
 * latest*.yml feed, and asset downloads — carries the user's own GitHub token
 * (src/main/update-auth.ts). Without one, or without access, the state is
 * `auth-required` instead of a raw 404.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { app, BrowserWindow, ipcMain, net, shell } from "electron";
import type { UpdateInfo } from "electron-updater";
import pkg from "electron-updater";
import type { UpdateAuthTestResult, UpdateInstallMode, UpdateStatus } from "../shared/ipc-types";
import { IPC_COMMANDS, IPC_EVENTS } from "../shared/ipc-types";
import { confirmQuit, requestQuit } from "./app-quit";
import { mainT } from "./i18n";
import {
	checkRepoAccess,
	clearUpdateToken,
	GITHUB_API_REPO,
	githubApiHeaders,
	RELEASE_REPO,
	resolveUpdateToken,
	storeUpdateToken,
	updateAuthInfo,
} from "./update-auth";
import {
	hasStableMacSigningIdentity,
	installerPartialPath,
	isSwappableBundleLocation,
	type MacInstallerAsset,
	macBundlePath,
	planInstallerTransfer,
	SWAP_SCRIPT,
	selectMacAsset,
	settleFailedUpdateCheck,
	settleIncompleteUpdateCheck,
	sha512FileBase64,
	sweepInstallerPartials,
} from "./updater-state";

const { autoUpdater } = pkg;

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
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
/** The release asset the current mode downloads: DMG (manual) or ZIP (relaunch). */
let macAsset: MacInstallerAsset | undefined;
let downloadedInstallerPath: string | undefined;
/** Running bundle the relaunch mode replaces (`/Applications/ompdesk.app`). */
let ownBundle: string | undefined;
/** Verified new bundle waiting for the swap (relaunch mode). */
let stagedApp: string | undefined;
/** The approved quit came from "Restart & install": reopen after the swap. */
let relaunchAfterSwap = false;
/** Token the last check authenticated with; the macOS asset download reuses it. */
let updateToken: string | undefined;
/** A check's failure is classified by runCheck, so the updater's own error event stays quiet. */
let checkInFlight = false;

function isWritable(target: string): boolean {
	try {
		fs.accessSync(target, fs.constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

function detectInstallMode(): UpdateInstallMode {
	if (process.platform !== "darwin") return "automatic";

	// Test seam for unpackaged preview builds; never overrides a release bundle.
	if (!app.isPackaged) {
		const override = process.env.OMP_DEV_UPDATE_MODE;
		if (override === "automatic" || override === "manual") return override;
	}

	const result = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", process.execPath], {
		encoding: "utf8",
	});
	if (result.status === 0 && hasStableMacSigningIdentity(`${result.stdout}${result.stderr}`)) return "automatic";
	// Ad-hoc: replace ourselves when the bundle sits somewhere we may write.
	const bundle = app.isPackaged ? macBundlePath(process.execPath) : undefined;
	if (bundle && isSwappableBundleLocation(bundle) && isWritable(bundle) && isWritable(path.dirname(bundle))) {
		ownBundle = bundle;
		return "relaunch";
	}
	return "manual";
}

function updatesDirectory(): string {
	return path.join(app.getPath("userData"), "updates");
}

function plistValue(appPath: string, key: string): string | undefined {
	const result = spawnSync(
		"/usr/bin/plutil",
		["-extract", key, "raw", "-o", "-", path.join(appPath, "Contents", "Info.plist")],
		{ encoding: "utf8" },
	);
	return result.status === 0 ? result.stdout.trim() : undefined;
}

/** Extract the verified ZIP and prove the bundle is this app at `version`, intact. */
async function stageBundle(zipPath: string, version: string): Promise<string> {
	const stagingDir = path.join(updatesDirectory(), version);
	await fs.promises.rm(stagingDir, { recursive: true, force: true });
	await fs.promises.mkdir(stagingDir, { recursive: true });
	const unzip = spawnSync("/usr/bin/ditto", ["-x", "-k", zipPath, stagingDir], { encoding: "utf8" });
	if (unzip.status !== 0) throw new Error(`${mainT("updates.downloadFailed")} (unzip)`);
	const entries = await fs.promises.readdir(stagingDir);
	const bundleName = entries.find(entry => entry.endsWith(".app"));
	if (!bundleName || !ownBundle) throw new Error(mainT("updates.installerMissing"));
	const staged = path.join(stagingDir, bundleName);
	const verify = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", staged], { encoding: "utf8" });
	const identityMatches =
		plistValue(staged, "CFBundleIdentifier") === plistValue(ownBundle, "CFBundleIdentifier") &&
		plistValue(staged, "CFBundleShortVersionString") === version;
	if (verify.status !== 0 || !identityMatches) {
		await fs.promises.rm(stagingDir, { recursive: true, force: true });
		throw new Error(mainT("updates.hashMismatch"));
	}
	return staged;
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
 * Signed CDN URL for a release asset. Private repos 404 on
 * `releases/download/...`; the API asset endpoint answers an authenticated
 * `application/octet-stream` request with a redirect to a short-lived signed
 * URL. The redirect is taken by hand because Chromium would forward the
 * Authorization header to the CDN, which rejects a second auth mechanism.
 */
async function signedAssetUrl(version: string, assetName: string, token: string): Promise<string> {
	const release = await net.fetch(`${GITHUB_API_REPO}/releases/tags/v${encodeURIComponent(version)}`, {
		headers: githubApiHeaders(token),
	});
	if (!release.ok) throw new Error(`${mainT("updates.downloadFailed")} (${release.status})`);
	const { assets } = (await release.json()) as { assets?: { id: number; name: string }[] };
	const asset = assets?.find(candidate => candidate.name === assetName);
	if (!asset) throw new Error(mainT("updates.installerMissing"));

	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const request = net.request({ url: `${GITHUB_API_REPO}/releases/assets/${asset.id}`, redirect: "manual" });
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
	request.end();
	return promise;
}

async function downloadMacAsset(
	version: string,
	asset: MacInstallerAsset,
	token: string,
	mode: "manual" | "relaunch",
): Promise<void> {
	// Manual installers land in Downloads for Finder; relaunch ZIPs are private staging.
	if (mode === "relaunch") await fs.promises.mkdir(updatesDirectory(), { recursive: true });
	const destinationPath =
		mode === "manual" ? availableDownloadPath(asset.name) : path.join(updatesDirectory(), asset.name);
	const partialPath = installerPartialPath(destinationPath);
	const assetUrl = await signedAssetUrl(version, asset.name, token);
	// Partials of releases this one superseded can never be continued.
	if (mode === "manual") await sweepInstallerPartials(path.dirname(partialPath), partialPath);
	else await sweepUpdatesDirectory(asset.name);

	let existing = await fileSize(partialPath);
	if (asset.size !== undefined && existing > asset.size) {
		await fs.promises.rm(partialPath, { force: true });
		existing = 0;
	}
	const response = await net.fetch(assetUrl, existing > 0 ? { headers: { range: `bytes=${existing}-` } } : undefined);
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

	const contentLength = Number(response.headers.get("content-length"));
	const total = asset.size ?? (Number.isFinite(contentLength) ? contentLength + plan.offset : 0);
	const startedAt = performance.now();
	let transferred = plan.offset;
	let lastProgressAt = 0;
	const file = await fs.promises.open(partialPath, plan.append ? "a" : "w");

	try {
		const reader = response.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			let offset = 0;
			while (offset < value.byteLength) {
				const { bytesWritten } = await file.write(value, offset, value.byteLength - offset);
				offset += bytesWritten;
			}
			transferred += value.byteLength;
			const now = performance.now();
			if (now - lastProgressAt >= PROGRESS_INTERVAL_MS || (total > 0 && transferred === total)) {
				const elapsedSeconds = Math.max((now - startedAt) / 1000, 0.001);
				broadcast({
					state: "downloading",
					version,
					mode,
					percent: total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0,
					bytesPerSecond: Math.round(transferred / elapsedSeconds),
					transferred,
					total,
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
	await Promise.all(
		entries
			.filter(entry => !keep.has(entry))
			.map(entry => fs.promises.rm(path.join(updatesDirectory(), entry), { recursive: true, force: true })),
	);
}

/** Background download for relaunch mode; failures stay out of the banner like any passive check. */
async function prepareRelaunchUpdate(version: string): Promise<void> {
	if (!macAsset || !updateToken) return;
	broadcast({
		state: "downloading",
		version,
		mode: "relaunch",
		percent: 0,
		bytesPerSecond: 0,
		transferred: 0,
		total: macAsset.size ?? 0,
	});
	try {
		await downloadMacAsset(version, macAsset, updateToken, "relaunch");
	} catch (error) {
		broadcast({
			state: "error",
			message: error instanceof Error ? error.message : String(error),
			showInBanner: false,
		});
	}
}

function broadcast(status: UpdateStatus): void {
	current = status;
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send(IPC_EVENTS.UPDATER_STATUS, status);
	}
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
 * One update check, authenticated as the user. `manual` checks surface
 * failures in the banner; background polls only update Settings.
 */
async function runCheck(manual: boolean): Promise<void> {
	const resolved = await resolveUpdateToken();
	if (!resolved) {
		updateToken = undefined;
		broadcast({ state: "auth-required", reason: "missing" });
		return;
	}
	updateToken = resolved.token;
	// A pre-release only exists for the updater test harness; never in a release bundle.
	autoUpdater.allowPrerelease = !app.isPackaged && process.env.OMP_DEV_UPDATE_PRERELEASE === "1";
	autoUpdater.setFeedURL({ provider: "github", ...RELEASE_REPO, private: true, token: resolved.token });
	checkInFlight = true;
	try {
		await autoUpdater.checkForUpdates();
		const settled = settleIncompleteUpdateCheck(current, manual, mainT("updates.noResult"));
		if (settled !== current) broadcast(settled);
	} catch (error) {
		const access = await checkRepoAccess(resolved.token);
		const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
		const message = error instanceof Error ? error.message : String(error);
		broadcast(settleFailedUpdateCheck(access, code, message, appVersion(), manual));
	} finally {
		checkInFlight = false;
	}
}

async function testAuth(token: string | undefined): Promise<UpdateAuthTestResult> {
	if (token?.trim()) return { access: await checkRepoAccess(token.trim()), source: null };
	const resolved = await resolveUpdateToken();
	if (!resolved) return { access: "missing", source: null };
	return { access: await checkRepoAccess(resolved.token), source: resolved.source };
}

export function setupUpdater(): void {
	installMode = detectInstallMode();
	// Installs interrupted by older builds keyed the partial by process id, which
	// nothing could ever continue — those orphans are the only debris a startup
	// sweep can identify for sure.
	if (process.platform === "darwin") void sweepInstallerPartials(app.getPath("downloads"));
	// Updates download in the background as soon as a check finds one (Claude/Codex
	// style); the only prompt is "Restart & install". Manual DMGs still wait for a click.
	autoUpdater.autoDownload = installMode === "automatic";
	autoUpdater.autoInstallOnAppQuit = installMode === "automatic";
	// Dev/preview verification gate: electron-updater skips unpackaged apps
	// unless forced. Pair with OMP_DEV_UPDATE_MODE=manual to exercise the DMG path.
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
			macAsset = selectMacAsset(info.files, info.version, installMode === "manual" ? "dmg" : "zip");
			if (!macAsset) {
				broadcast({ state: "error", message: mainT("updates.installerMissing") });
				return;
			}
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
			bytesPerSecond: progress.bytesPerSecond,
			transferred: progress.transferred,
			total: progress.total,
		});
	});
	autoUpdater.on("update-downloaded", info =>
		broadcast({ state: "downloaded", version: info.version, mode: "automatic" }),
	);
	autoUpdater.on("error", error => {
		if (checkInFlight) return;
		// Passive failures remain unobtrusive. Explicit IPC actions catch and
		// rebroadcast the same failure as user-visible.
		broadcast({ state: "error", message: error.message, showInBanner: false });
	});

	ipcMain.handle(IPC_COMMANDS.UPDATER_CHECK, async () => {
		broadcast({ state: "checking" });
		await runCheck(true);
		return current;
	});
	ipcMain.handle(IPC_COMMANDS.UPDATER_DOWNLOAD, async () => {
		if (current.state !== "available") return current;
		try {
			if (current.mode === "manual" || current.mode === "relaunch") {
				if (!macAsset) throw new Error(mainT("updates.installerMissing"));
				if (!updateToken) {
					broadcast({ state: "auth-required", reason: "missing" });
					return current;
				}
				broadcast({
					state: "downloading",
					version: current.version,
					mode: current.mode,
					percent: 0,
					bytesPerSecond: 0,
					transferred: 0,
					total: macAsset.size ?? 0,
				});
				await downloadMacAsset(activeUpdate?.version ?? current.version, macAsset, updateToken, current.mode);
			} else {
				await autoUpdater.downloadUpdate();
			}
		} catch (error) {
			broadcast({
				state: "error",
				message: error instanceof Error ? error.message : String(error),
				showInBanner: true,
			});
		}
		return current;
	});
	ipcMain.handle(IPC_COMMANDS.UPDATER_APPLY, async () => {
		if (current.state !== "downloaded") return;
		if (current.mode === "manual") {
			if (!downloadedInstallerPath) {
				broadcast({ state: "error", message: mainT("updates.installerMissing"), showInBanner: true });
				return;
			}
			try {
				await openManualInstaller(downloadedInstallerPath);
			} catch (error) {
				broadcast({
					state: "error",
					message: error instanceof Error ? error.message : String(error),
					showInBanner: true,
				});
			}
			return;
		}
		if (current.mode === "relaunch") {
			if (!stagedApp || !ownBundle) {
				broadcast({ state: "error", message: mainT("updates.installerMissing"), showInBanner: true });
				return;
			}
			// Running work dies with the restart: same prompt as ⌘Q.
			if (!(await confirmQuit())) return;
			relaunchAfterSwap = true;
			requestQuit();
			return;
		}
		autoUpdater.quitAndInstall();
	});
	ipcMain.handle(IPC_COMMANDS.UPDATER_GET_STATUS, () => current);
	ipcMain.handle(IPC_COMMANDS.UPDATER_VERSION, () => appVersion());
	ipcMain.handle(IPC_COMMANDS.UPDATER_AUTH_INFO, () => updateAuthInfo());
	ipcMain.handle(IPC_COMMANDS.UPDATER_AUTH_TEST, (_event, token?: string) => testAuth(token));
	ipcMain.handle(IPC_COMMANDS.UPDATER_AUTH_SAVE, async (_event, token: string): Promise<UpdateAuthTestResult> => {
		const trimmed = token.trim();
		if (!trimmed) return { access: "missing", source: null };
		const access = await checkRepoAccess(trimmed);
		if (access === "ok") await storeUpdateToken(trimmed);
		return { access, source: access === "ok" ? "stored" : null };
	});
	ipcMain.handle(IPC_COMMANDS.UPDATER_AUTH_CLEAR, async () => {
		await clearUpdateToken();
		return updateAuthInfo();
	});

	// First check once the app settles; then every 4h. A downloaded or
	// in-flight update is never replaced by a background re-check.
	const backgroundCheck = () => {
		if (current.state === "downloading" || current.state === "downloaded") return;
		void runCheck(false);
	};
	setTimeout(backgroundCheck, 3000);
	setInterval(backgroundCheck, CHECK_INTERVAL_MS);
}
