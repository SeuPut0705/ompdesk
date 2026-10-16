import { createHash } from "node:crypto";
import type * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { UpdateAccess, UpdateStatus, UpdateTokenSource } from "../shared/ipc-types";

/** The macOS update download: the release's DMG, saved under a versioned local name. */
export interface MacInstallerAsset {
	/** Local file name (`macDownloadName`). */
	name: string;
	/** API asset endpoint of the release's `ompdesk-mac-arm64.dmg`. */
	url: string;
	sha512: string;
	size: number;
}

/**
 * Local name of a downloaded DMG. The release asset is version-free, so the
 * version goes back into the name: Downloads stays legible, and a partial of
 * a superseded release never resumes into the new one.
 */
export function macDownloadName(version: string): string {
	return `ompdesk-${version}-arm64.dmg`;
}

/**
 * `/Applications/ompdesk.app` from `/Applications/ompdesk.app/Contents/MacOS/ompdesk`; undefined outside a bundle.
 * macOS paths only, so POSIX path rules on every platform the tests run on.
 */
export function macBundlePath(execPath: string): string | undefined {
	const macOsDir = path.posix.dirname(execPath);
	const bundle = path.posix.dirname(path.posix.dirname(macOsDir));
	return bundle.endsWith(".app") && path.posix.basename(macOsDir) === "MacOS" ? bundle : undefined;
}

/**
 * A bundle the app may replace itself: not on a mounted disk image (read-only)
 * and not App Translocation's randomized read-only copy of a quarantined app.
 * Writability is checked separately against the real filesystem.
 */
export function isSwappableBundleLocation(bundlePath: string): boolean {
	return !bundlePath.startsWith("/Volumes/") && !bundlePath.includes("/AppTranslocation/");
}

/**
 * Detached swap run after the app exits (`bash -c SWAP_SCRIPT swap <pid>
 * <staged.app> <dest.app> <relaunch 0|1> <log> [relaunch args…]`): wait for
 * the old process, copy the verified staged bundle next to the destination,
 * then exchange them with a rollback if the final move fails. Runs once and
 * exits; never a launchd job.
 */
export const SWAP_SCRIPT = `
pid="$1" src="$2" dest="$3" relaunch="$4" log="$5"
shift 5
exec >>"$log" 2>&1
echo "swap $(date): $src -> $dest"
for _ in $(seq 1 150); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
if kill -0 "$pid" 2>/dev/null; then echo "app still running; swap skipped"; exit 1; fi
[ -d "$src" ] || { echo "staged app missing"; exit 1; }
staging="$dest.updating" old="$dest.previous"
rm -rf "$staging" "$old"
ditto "$src" "$staging" || { rm -rf "$staging"; echo "copy failed"; exit 1; }
xattr -dr com.apple.quarantine "$staging" 2>/dev/null
if [ -e "$dest" ]; then mv "$dest" "$old" || { rm -rf "$staging"; echo "cannot move old app"; exit 1; }; fi
if ! mv "$staging" "$dest"; then
  [ -e "$old" ] && mv "$old" "$dest"
  echo "install failed; previous app restored"; exit 1
fi
rm -rf "$old" "$src"
echo "installed"
if [ "$relaunch" = "1" ]; then
  if [ "$#" -gt 0 ]; then open -n "$dest" --args "$@"; else open -n "$dest"; fi
fi
`;

/** Outcome of one external tool run (hdiutil, ditto, codesign, plutil). */
export interface ToolResult {
	ok: boolean;
	stdout: string;
}

export type ToolRunner = (command: string, args: readonly string[]) => Promise<ToolResult>;

/** Why a DMG could not be staged; updater.ts maps it to user-facing copy. */
export class StageBundleError extends Error {
	readonly reason: "mount" | "missing" | "copy" | "verify";

	constructor(reason: StageBundleError["reason"], message: string) {
		super(message);
		this.name = "StageBundleError";
		this.reason = reason;
	}
}

export interface StageBundleOptions {
	/** SHA-512-verified release DMG. */
	dmgPath: string;
	/** Emptied, then receives the `.app`; removed again if verification fails. */
	stagingDir: string;
	/** Parent of the temporary mount point. */
	mountRoot: string;
	version: string;
	/** Running bundle; the staged one must carry its bundle id. */
	ownBundle: string;
	run: ToolRunner;
	/** Electron's `original-fs` in the app: plain fs never mistakes `app.asar` for a directory. */
	fs: Pick<typeof nodeFs.promises, "mkdir" | "mkdtemp" | "readdir" | "rm" | "rmdir">;
}

/**
 * Copy the app out of the release DMG and prove it is this app at `version`,
 * intact: mount read-only without Finder, `ditto` the bundle out, always
 * detach, then check `codesign --verify --deep --strict`, the bundle id and
 * the short version. Returns the staged `.app` path.
 */
export async function stageBundleFromDmg(options: StageBundleOptions): Promise<string> {
	const { dmgPath, stagingDir, mountRoot, version, ownBundle, run, fs: files } = options;
	await files.rm(stagingDir, { recursive: true, force: true });
	await files.mkdir(stagingDir, { recursive: true });
	await files.mkdir(mountRoot, { recursive: true });
	const mountPoint = await files.mkdtemp(path.join(mountRoot, "ompdesk-update-"));

	let staged: string;
	try {
		const attach = await run("/usr/bin/hdiutil", [
			"attach",
			"-nobrowse",
			"-readonly",
			"-noautoopen",
			"-mountpoint",
			mountPoint,
			dmgPath,
		]);
		if (!attach.ok) throw new StageBundleError("mount", `hdiutil could not attach ${dmgPath}`);
		try {
			const entries = await files.readdir(mountPoint, { withFileTypes: true });
			// The DMG also holds the /Applications symlink; only a real directory is the app.
			const bundle = entries.find(entry => entry.isDirectory() && entry.name.endsWith(".app"));
			if (!bundle) throw new StageBundleError("missing", `${dmgPath} contains no .app bundle`);
			staged = path.join(stagingDir, bundle.name);
			const copy = await run("/usr/bin/ditto", [path.join(mountPoint, bundle.name), staged]);
			if (!copy.ok) throw new StageBundleError("copy", `ditto could not copy ${bundle.name} out of the DMG`);
		} finally {
			const detach = await run("/usr/bin/hdiutil", ["detach", mountPoint]);
			if (!detach.ok) await run("/usr/bin/hdiutil", ["detach", "-force", mountPoint]);
		}
	} finally {
		// rmdir, never a recursive rm: a mount that refused to detach must keep its contents.
		await files.rmdir(mountPoint).catch(() => {});
	}

	const plistValue = async (appPath: string, key: string) => {
		const result = await run("/usr/bin/plutil", [
			"-extract",
			key,
			"raw",
			"-o",
			"-",
			path.join(appPath, "Contents", "Info.plist"),
		]);
		return result.ok ? result.stdout.trim() : undefined;
	};
	const signature = await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", staged]);
	const bundleId = await plistValue(staged, "CFBundleIdentifier");
	const verified =
		signature.ok &&
		bundleId !== undefined &&
		bundleId === (await plistValue(ownBundle, "CFBundleIdentifier")) &&
		(await plistValue(staged, "CFBundleShortVersionString")) === version;
	if (!verified) {
		await files.rm(stagingDir, { recursive: true, force: true });
		throw new StageBundleError("verify", `The bundle in ${dmgPath} is not an intact OMPdesk ${version}`);
	}
	return staged;
}

/**
 * electron-updater may resolve without emitting an available/not-available
 * event (notably in unpackaged builds). Never leave the public state machine
 * stuck in `checking` after the request itself has finished.
 */
export function settleIncompleteUpdateCheck(
	status: UpdateStatus,
	manual: boolean,
	noResultMessage = "Couldn't finish the update check. Try again later.",
): UpdateStatus {
	if (status.state !== "checking") return status;
	return manual ? { state: "error", message: noResultMessage } : { state: "idle" };
}

/* ------------------------------------------- release access (token optional) */

export interface ResolvedUpdateToken {
	token: string;
	source: UpdateTokenSource;
}

/**
 * Headers for GitHub's REST API. The repo is public, so with no `token` the
 * request carries no Authorization header at all (anonymous, 60 requests an
 * hour per address); a token only raises that limit and keeps updates working
 * if the repo is ever private again.
 */
export function githubApiHeaders(
	token: string | undefined,
	accept = "application/vnd.github+json",
): Record<string, string> {
	const headers: Record<string, string> = { accept, "x-github-api-version": "2022-11-28" };
	if (token) headers.authorization = `Bearer ${token}`;
	return headers;
}

/**
 * First usable token in precedence order (env → gh → stored). Lookups run
 * lazily so a token found in the environment never spawns `gh`.
 */
export async function firstUpdateToken(
	lookups: readonly (readonly [UpdateTokenSource, () => Promise<string | undefined> | string | undefined])[],
): Promise<ResolvedUpdateToken | undefined> {
	for (const [source, lookup] of lookups) {
		const token = (await lookup())?.trim();
		if (token) return { token, source };
	}
	return undefined;
}

/**
 * `GET /repos/{owner}/{repo}` status → access. GitHub answers 404 (not 403)
 * for a private repo the caller cannot see, so both mean "no access". A 403
 * with `rateLimited` (`x-ratelimit-remaining: 0`) is the hourly limit, which
 * says nothing about access and reads as a network-class failure.
 */
export function classifyRepoAccess(status: number, rateLimited = false): UpdateAccess {
	if (status >= 200 && status < 300) return "ok";
	if (status === 401) return "invalid";
	if (status === 403 && rateLimited) return "network";
	if (status === 403 || status === 404) return "denied";
	return "network";
}

/**
 * Status for a failed check once repo access is known. `message` is the
 * user-facing copy; `detail` (the raw updater error) rides along for the
 * banner's tooltip and Settings.
 */
export function settleFailedUpdateCheck(
	access: UpdateAccess,
	errorCode: string | undefined,
	message: string,
	currentVersion: string,
	manual: boolean,
	detail?: string,
): UpdateStatus {
	if (access === "invalid" || access === "denied" || access === "missing") {
		return { state: "auth-required", reason: access };
	}
	// Access is fine and GitHub has no release yet: nothing newer exists.
	if (access === "ok" && errorCode === "ERR_UPDATER_LATEST_VERSION_NOT_FOUND") {
		return { state: "not-available", version: currentVersion };
	}
	return detail && detail !== message
		? { state: "error", message, detail, showInBanner: manual }
		: { state: "error", message, showInBanner: manual };
}

/* -------------------------------------------- macOS manual installer transfer */

const PARTIAL_SUFFIX = ".partial";
/**
 * Only names the updater itself could have written: `ompdesk-<version>[-arm64][ (n)].dmg`
 * plus a partial suffix. Downloads is the user's directory, so anything else —
 * including a lookalike like `holiday.dmg.partial` — must survive the sweep.
 */
const INSTALLER_DEBRIS = /^ompdesk-[\d.]+(?:-arm64)?(?: \(\d+\))?\.dmg(?:\.partial|\.download-\d+)$/;
const HASH_CHUNK_BYTES = 1024 * 1024;

/**
 * Deterministic name for the in-flight installer. The earlier PID-keyed temp
 * name could never be continued after a crash or quit, so every interrupted
 * download left an unresumable copy of a ~120 MB DMG behind in Downloads.
 */
export function installerPartialPath(destinationPath: string): string {
	return `${destinationPath}${PARTIAL_SUFFIX}`;
}

export interface InstallerTransferPlan {
	/** Bytes already on disk to keep. 0 restarts the transfer. */
	offset: number;
	/** True when the response continues the partial, so bytes append to it. */
	append: boolean;
}

/**
 * A `Range` request is only honored if the server answers 206 *and* starts
 * exactly where the local file ends. Anything else — a server that ignored the
 * header, one that answered for different bytes — means rewriting from the top,
 * because appending foreign bytes would produce an installer that then fails
 * hashing.
 */
export function planInstallerTransfer(
	existingBytes: number,
	response: { status: number; contentRange?: string },
): InstallerTransferPlan {
	if (existingBytes <= 0 || response.status !== 206) return { offset: 0, append: false };
	const match = /^bytes\s+(\d+)-/i.exec(response.contentRange ?? "");
	return Number(match?.[1]) === existingBytes ? { offset: existingBytes, append: true } : { offset: 0, append: false };
}

/**
 * A transfer that delivers nothing for this long is abandoned with a retryable
 * error; its partial stays, so the retry resumes from there.
 */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;

export class TransferStalledError extends Error {
	constructor(idleMs: number) {
		super(`No data received for ${Math.round(idleMs / 1000)} s`);
		this.name = "TransferStalledError";
	}
}

/**
 * `pending`, or a TransferStalledError once `idleMs` passes before it settles;
 * `onStall` then aborts the transfer. Await one step at a time (the response,
 * then each chunk) so the clock restarts whenever bytes arrive.
 */
export async function withinIdle<T>(pending: Promise<T>, idleMs: number, onStall: () => void): Promise<T> {
	const { promise: stalled, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => {
		// Settle first: an abort that rejects `pending` synchronously must not win the race.
		reject(new TransferStalledError(idleMs));
		onStall();
	}, idleMs);
	try {
		return await Promise.race([pending, stalled]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * At most one installer transfer at a time: a second one would append to the
 * same `.partial` and fail the SHA-512 check. `start` hands back the transfer
 * already running instead of starting another.
 */
export class SingleTransfer {
	#running: Promise<void> | undefined;

	get running(): boolean {
		return this.#running !== undefined;
	}

	start(transfer: () => Promise<void>): Promise<void> {
		this.#running ??= transfer().finally(() => {
			this.#running = undefined;
		});
		return this.#running;
	}
}

/** Stream a finished installer through SHA-512 without holding a DMG in memory. */
export async function sha512FileBase64(filePath: string): Promise<string> {
	const hash = createHash("sha512");
	const file = await fs.open(filePath, "r");
	const buffer = new Uint8Array(HASH_CHUNK_BYTES);
	try {
		let position = 0;
		for (;;) {
			const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
			if (bytesRead === 0) break;
			hash.update(buffer.subarray(0, bytesRead));
			position += bytesRead;
		}
	} finally {
		await file.close();
	}
	return hash.digest("base64");
}

/**
 * Delete installer debris: PID-keyed partials written by older builds (never
 * resumable) and, once a fresh download names its own partial, `.partial` files
 * belonging to a superseded release. Without a current download there is no way
 * to tell a resumable partial from an abandoned one, so startup removes only
 * the old debris. Everything else in Downloads belongs to the user.
 */
export async function sweepInstallerPartials(directory: string, activePartial?: string): Promise<string[]> {
	const activeName = activePartial ? path.basename(activePartial) : undefined;
	const removed: string[] = [];
	let entries: string[];
	try {
		entries = await fs.readdir(directory);
	} catch {
		return removed;
	}
	for (const name of entries) {
		if (!INSTALLER_DEBRIS.test(name)) continue;
		if (name === activeName) continue;
		if (activeName === undefined && name.endsWith(PARTIAL_SUFFIX)) continue;
		try {
			await fs.rm(path.join(directory, name), { force: true });
			removed.push(name);
		} catch {
			/* still open by a racing transfer; the next launch retries */
		}
	}
	return removed;
}
