import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import { platformKey } from "./cache";
import { isRecord, readJson } from "./json";
import { onInterrupt, type RunResult, run, Unavailable } from "./proc";

export type ArchiveFormat = "zip" | "tar.gz";

export interface Artifact {
	url: string;
	sha256: string;
	format?: ArchiveFormat;
	file?: string;
	version?: string;
}

export interface Toolchain {
	version: number;
	tla: {
		minJava: number;
		tla2tools: Artifact & { file: string; version: string };
		communityModules: Artifact & { file: string; version: string };
		jre: { platforms: Record<string, Artifact & { format: ArchiveFormat; version: string }> };
	};
	lean: {
		version: string;
		toolchain: string;
		elan: { version: string; platforms: Record<string, Artifact & { format: ArchiveFormat }> };
		archive: { platforms: Record<string, Artifact & { format: ArchiveFormat }> };
	};
}

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The skill folder (the one with SKILL.md). */
export function skillDir(): string {
	return SKILL_DIR;
}

export const DEFAULT_TOOLCHAIN_FILE = path.join(SKILL_DIR, "assets", "toolchain.json");

function fail(message: string): never {
	throw new Error(`toolchain.json: ${message}`);
}

function artifact(value: unknown, where: string, needFile: boolean, needFormat: boolean): Artifact {
	if (!isRecord(value)) fail(`${where} must be an object`);
	const { url, sha256, format, file, version } = value;
	if (typeof url !== "string" || !/^(https:\/\/|file:\/\/\/?)/.test(url)) fail(`${where}.url must be an https:// URL`);
	if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256))
		fail(`${where}.sha256 must be 64 lowercase hex digits`);
	if (needFormat && format !== "zip" && format !== "tar.gz") fail(`${where}.format must be "zip" or "tar.gz"`);
	if (needFile && (typeof file !== "string" || !file || /[\\/]/.test(file)))
		fail(`${where}.file must be a plain file name`);
	return {
		url,
		sha256,
		...(format ? { format: format as ArchiveFormat } : {}),
		...(typeof file === "string" ? { file } : {}),
		...(typeof version === "string" ? { version } : {}),
	};
}

function platforms(value: unknown, where: string): Record<string, Artifact & { format: ArchiveFormat }> {
	if (!isRecord(value) || Object.keys(value).length === 0) fail(`${where} must list at least one platform`);
	const out: Record<string, Artifact & { format: ArchiveFormat }> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (!/^(darwin|win32|linux)-(arm64|x64)$/.test(key))
			fail(`${where}.${key}: platform keys look like darwin-arm64`);
		out[key] = artifact(entry, `${where}.${key}`, false, true) as Artifact & { format: ArchiveFormat };
	}
	return out;
}

function versioned<T extends Artifact>(
	table: Record<string, T>,
	where: string,
): Record<string, T & { version: string }> {
	for (const [key, entry] of Object.entries(table)) {
		if (typeof entry.version !== "string") fail(`${where}.${key}.version is required`);
	}
	return table as Record<string, T & { version: string }>;
}

/** Validates the pin file; throws a message naming the first bad field. */
export function parseToolchain(input: unknown): Toolchain {
	if (!isRecord(input) || input.version !== 1) fail('"version" must be 1');
	const { tla, lean } = input;
	if (!isRecord(tla) || !isRecord(lean)) fail('"tla" and "lean" are required');
	const jre = tla.jre;
	if (!isRecord(jre)) fail("tla.jre is required");
	const minJava = tla.minJava;
	if (typeof minJava !== "number" || !Number.isInteger(minJava) || minJava < 8)
		fail("tla.minJava must be an integer >= 8");
	const tools = artifact(tla.tla2tools, "tla.tla2tools", true, false);
	const community = artifact(tla.communityModules, "tla.communityModules", true, false);
	if (typeof tools.version !== "string") fail("tla.tla2tools.version is required");
	if (typeof community.version !== "string") fail("tla.communityModules.version is required");
	if (typeof lean.version !== "string" || typeof lean.toolchain !== "string")
		fail("lean.version and lean.toolchain are required");
	if (lean.toolchain !== `leanprover/lean4:v${lean.version}`)
		fail(`lean.toolchain must be leanprover/lean4:v${lean.version}`);
	const elan = lean.elan;
	if (!isRecord(elan) || typeof elan.version !== "string") fail("lean.elan.version is required");
	const archive = lean.archive;
	if (!isRecord(archive)) fail("lean.archive is required");
	return {
		version: 1,
		tla: {
			minJava,
			tla2tools: tools as Toolchain["tla"]["tla2tools"],
			communityModules: community as Toolchain["tla"]["communityModules"],
			jre: { platforms: versioned(platforms(jre.platforms, "tla.jre.platforms"), "tla.jre.platforms") },
		},
		lean: {
			version: lean.version,
			toolchain: lean.toolchain,
			elan: { version: elan.version, platforms: platforms(elan.platforms, "lean.elan.platforms") },
			archive: { platforms: platforms(archive.platforms, "lean.archive.platforms") },
		},
	};
}

/** `OMPDESK_FORMAL_TOOLCHAIN` points at another pin file (tests, an internal mirror); else the one in assets/. */
export function loadToolchain(env: NodeJS.ProcessEnv = process.env): Toolchain {
	return parseToolchain(readJson(env.OMPDESK_FORMAL_TOOLCHAIN || DEFAULT_TOOLCHAIN_FILE));
}

/** The entry for this machine, or Unavailable naming the platform. */
export function forPlatform<T>(table: Record<string, T>, what: string, key = platformKey()): T {
	const entry = table[key];
	if (!entry) {
		throw new Unavailable(
			`no pinned ${what} for ${key} (pinned: ${Object.keys(table).join(", ")}); install it yourself and put it on PATH`,
		);
	}
	return entry;
}

export function sha256File(file: string): Promise<string> {
	const hash = createHash("sha256");
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const stream = fs.createReadStream(file);
	stream.on("data", chunk => hash.update(chunk));
	stream.on("error", reject);
	stream.on("end", () => resolve(hash.digest("hex")));
	return promise;
}

export async function fileMatches(file: string, sha256: string): Promise<boolean> {
	try {
		return (await sha256File(file)) === sha256;
	} catch {
		return false;
	}
}

/** Downloads are off with `OMPDESK_FORMAL_OFFLINE=1` (no network: the check is reported as not run). */
export function downloadsRefused(env: NodeJS.ProcessEnv = process.env): string | null {
	return env.OMPDESK_FORMAL_OFFLINE === "1"
		? "downloads are refused (OMPDESK_FORMAL_OFFLINE=1); the tool is not installed"
		: null;
}

/** A download that sends nothing for this long is given up (a stalled connection would hold the lock forever). */
export const DOWNLOAD_IDLE_MS = 60_000;

/**
 * Fetches `url` to `dest` and checks its SHA-256 before the file appears under its final name. A refused,
 * failed, stalled or mismatching download is Unavailable: the tool is missing, never silently replaced.
 */
export async function download(
	url: string,
	dest: string,
	sha256: string,
	options: {
		label: string;
		env?: NodeJS.ProcessEnv;
		log?: (line: string) => void;
		idleTimeoutMs?: number;
		/** Stops the download (nothing more is written) when this aborts. */
		signal?: AbortSignal;
	},
): Promise<void> {
	if (await fileMatches(dest, sha256)) return;
	const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	const refused = downloadsRefused(options.env);
	if (refused) throw new Unavailable(`${options.label}: ${refused}`);
	const part = `${dest}.part-${hostTag()}-${process.pid}`;
	const hash = createHash("sha256");
	const idleMs = options.idleTimeoutMs ?? DOWNLOAD_IDLE_MS;
	const controller = new AbortController();
	const onAbort = (): void => controller.abort(options.signal?.reason ?? new Error("aborted"));
	if (options.signal?.aborted) onAbort();
	else options.signal?.addEventListener("abort", onAbort, { once: true });
	let idle: ReturnType<typeof setTimeout> | undefined;
	const touch = (): void => {
		clearTimeout(idle);
		idle = setTimeout(() => controller.abort(new Error(`no data for ${Math.round(idleMs / 1000)} s`)), idleMs);
	};
	try {
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		let source: Readable;
		let total = 0;
		touch();
		if (url.startsWith("file://")) {
			const local = fileURLToPath(url);
			total = fs.statSync(local).size;
			source = fs.createReadStream(local);
		} else {
			const response = await fetch(url, { redirect: "follow", signal: controller.signal });
			if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} ${response.statusText}`);
			total = Number(response.headers.get("content-length") ?? 0);
			source = Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>);
		}
		log(`downloading ${options.label}${total ? ` (${(total / 1048576).toFixed(0)} MB)` : ""} from ${url}`);
		let seen = 0;
		let nextMark = 0.25;
		source.on("data", (chunk: Buffer) => {
			touch();
			hash.update(chunk);
			seen += chunk.length;
			if (total > 50 * 1048576 && seen / total >= nextMark) {
				log(`  ${options.label}: ${Math.round((seen / total) * 100)}%`);
				nextMark += 0.25;
			}
		});
		await pipeline(source, fs.createWriteStream(part), { signal: controller.signal });
		const actual = hash.digest("hex");
		if (actual !== sha256) throw new Error(`SHA-256 mismatch: expected ${sha256}, got ${actual}`);
		if (controller.signal.aborted) throw new Error(String(controller.signal.reason?.message ?? "aborted"));
		fs.renameSync(part, dest);
	} catch (error) {
		fs.rmSync(part, { force: true });
		const reason = controller.signal.aborted
			? String(controller.signal.reason?.message ?? "aborted")
			: error instanceof Error
				? error.message
				: String(error);
		throw new Unavailable(`${options.label}: could not download ${url}: ${reason}`);
	} finally {
		clearTimeout(idle);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

/** Removes a path, and keeps going when it cannot: a leftover is cleaned by the next setup, an error here would hide the real one. */
function removeQuietly(target: string): void {
	try {
		fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	} catch {
		// cleanLeftovers removes it once this process is gone
	}
}

/**
 * The program that unpacks archives. Windows: `tar` on PATH is Git Bash's GNU tar (Git's `usr\bin` comes first),
 * which cannot read zip and takes `C:` for a host name, so the system's bsdtar is called by absolute path.
 */
export function tarProgram(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
	if (platform !== "win32") return "tar";
	return path.win32.join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32", "tar.exe");
}

/** PowerShell's fallback for a zip: its progress bar alone makes `Expand-Archive` many times slower. */
export function expandArchiveCommand(archive: string, staging: string): string {
	const quote = (text: string): string => `'${text.replaceAll("'", "''")}'`;
	return `$ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(staging)} -Force`;
}

const RENAME_RETRYABLE = ["EPERM", "EACCES", "EBUSY"];

/** Windows holds a freshly written tree open while Defender scans it: a rename of it fails for a moment. */
const RENAME_DELAYS_MS = process.platform === "win32" ? [100, 250, 500, 1000, 2000] : [];

/** `rename`, tried again after each delay when it fails with EPERM, EACCES or EBUSY; any other error is thrown at once. */
export async function renameRetrying(
	from: string,
	to: string,
	delays: readonly number[] = RENAME_DELAYS_MS,
	rename: (from: string, to: string) => void = fs.renameSync,
): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			rename(from, to);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? "";
			if (attempt >= delays.length || !RENAME_RETRYABLE.includes(code)) throw error;
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, delays[attempt]);
			await promise;
		}
	}
}

/** Unpacks into a fresh folder, then moves the single top-level folder (if any) to `dest`. A failed unpack is Unavailable. */
export async function extractInto(
	archive: string,
	format: ArchiveFormat,
	dest: string,
	signal?: AbortSignal,
): Promise<void> {
	const staging = `${dest}.tmp-${hostTag()}-${process.pid}`;
	try {
		fs.rmSync(staging, { recursive: true, force: true });
		fs.mkdirSync(staging, { recursive: true });
		let result: RunResult;
		if (format === "tar.gz") {
			result = await run(tarProgram(), ["-xzf", archive, "-C", staging], { signal });
		} else if (process.platform === "win32") {
			// bsdtar reads zip files; Expand-Archive is slower but always there.
			result = await run(tarProgram(), ["-xf", archive, "-C", staging], { signal });
			if (result.code !== 0) {
				result = await run(
					"powershell",
					["-NoProfile", "-NonInteractive", "-Command", expandArchiveCommand(archive, staging)],
					{ signal },
				);
			}
		} else {
			result = await run("unzip", ["-q", "-o", archive, "-d", staging], { signal });
		}
		if (result.spawnError || result.code !== 0) {
			throw new Unavailable(
				`unpacking ${path.basename(archive)} failed: ${result.spawnError?.message ?? (result.stderr.trim() || `exit ${result.code}`)}`,
			);
		}
		// An aborted setup (its lock was taken over) writes nothing more into `dest`.
		signal?.throwIfAborted();
		const children = fs.readdirSync(staging);
		const only = children.length === 1 ? path.join(staging, children[0] as string) : null;
		const root = only && fs.statSync(only).isDirectory() ? only : staging;
		fs.rmSync(dest, { recursive: true, force: true });
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		await renameRetrying(root, dest);
	} catch (error) {
		throw environmental(error, `unpacking ${path.basename(archive)}`);
	} finally {
		removeQuietly(staging);
	}
}

export interface LockOptions {
	log?: (line: string) => void;
	/** How often a waiter looks again. */
	pollMs?: number;
	/** The holder rewrites its lock this often while it works. */
	heartbeatMs?: number;
	/**
	 * A lock of another computer (whose holder's pid cannot be asked) that nobody has touched for this long is abandoned.
	 * A holder on this computer is never taken over while its pid lives, however long its computer slept.
	 */
	staleMs?: number;
	/** Give up waiting on a live holder after this long. */
	maxWaitMs?: number;
}

interface LockOwner {
	pid: number;
	host: string;
	started: number;
	/** Random per withLock call: tells this holder's lock from one a later process took over. */
	token: string;
}

/** Is a process with this pid running on this computer? EPERM means it exists but is not ours. */
export function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readOwner(file: string): LockOwner | null {
	try {
		const json: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (isRecord(json) && typeof json.pid === "number" && typeof json.host === "string") {
			return {
				pid: json.pid,
				host: json.host,
				started: typeof json.started === "number" ? json.started : 0,
				token: typeof json.token === "string" ? json.token : "",
			};
		}
	} catch {
		// being written, or not a lock of ours
	}
	return null;
}

/** When the lock was last touched (its owner file, else its folder); null when there is no lock any more. */
function touched(lock: string, ownerFile: string): number | null {
	for (const target of [ownerFile, lock]) {
		try {
			return fs.statSync(target).mtimeMs;
		} catch {
			// try the next
		}
	}
	return null;
}

/** This computer's name as it appears in `.part-` and `.tmp-` names (letters, digits and `_`). */
export function hostTag(host: string = os.hostname()): string {
	return host.replace(/[^A-Za-z0-9_]/g, "_");
}

/** `<name>.part-<host>-<pid>`; the host is absent in names written before hosts were recorded. */
const LEFTOVER = /\.(?:part|tmp)-(?:([A-Za-z0-9_]+)-)?(\d+)$/;

/**
 * Removes `*.part-<host>-<pid>` downloads and `*.tmp-<host>-<pid>` unpack folders that a killed setup of this
 * computer left behind (each can be gigabytes). Only those of a pid that is no longer running: another computer's
 * (a shared cache folder) are never touched, since its pids mean nothing here. `legacy` also removes names without a
 * host (an older setup's), which the caller allows only while no other computer is working in the cache. The scan
 * stays three levels deep and never enters a toolchain.
 */
export function cleanLeftovers(root: string, options: { host?: string; legacy?: boolean } = {}): string[] {
	const host = options.host ?? hostTag();
	const legacy = options.legacy ?? true;
	const removed: string[] = [];
	const scan = (dir: string, depth: number): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			const match = LEFTOVER.exec(entry.name);
			if (match) {
				const mine = match[1] === undefined ? legacy : match[1] === host;
				if (mine && !pidAlive(Number(match[2]))) {
					fs.rmSync(full, { recursive: true, force: true });
					removed.push(full);
				}
			} else if (entry.isDirectory() && depth < 3 && !entry.name.startsWith(".lock-")) scan(full, depth + 1);
		}
	};
	scan(root, 1);
	return removed;
}

/** Does a lock of another computer in this cache look alive (touched within `staleMs`)? */
function otherHostWorking(cache: string, host: string, staleMs: number): boolean {
	let entries: string[];
	try {
		entries = fs.readdirSync(cache);
	} catch {
		return false;
	}
	for (const entry of entries) {
		if (!entry.startsWith(".lock-") || entry.endsWith(TAKEOVER_SUFFIX) || entry.includes(".stale-")) continue;
		const lock = path.join(cache, entry);
		const owner = readOwner(path.join(lock, "owner.json"));
		const at = touched(lock, path.join(lock, "owner.json"));
		if (owner && owner.host !== host && at !== null && Date.now() - at <= staleMs) {
			return true;
		}
	}
	return false;
}

/** Errors of the machine, not of the code: a full, read-only or locked disk. */
const ENVIRONMENTAL = ["ENOSPC", "EDQUOT", "EACCES", "EPERM", "EROFS", "EBUSY", "EIO", "EMFILE", "ENFILE", "ENOTEMPTY"];

/**
 * An fs error that says the disk or its permissions are the problem becomes Unavailable (exit 3, "not checked") naming
 * what was being done; anything else, a bug included, is returned as it is.
 */
export function environmental(error: unknown, what: string): unknown {
	if (error instanceof Unavailable) return error;
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (typeof code === "string" && ENVIRONMENTAL.includes(code)) {
		return new Unavailable(`${what}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return error;
}

/** A takeover of a dead lock is serialized by this second lock (`.lock-<name>.takeover`), itself abandoned after this long. */
const TAKEOVER_SUFFIX = ".takeover";
const TAKEOVER_STALE_MS = 30_000;

/**
 * One installer at a time per name across processes (two agents may call setup together). The lock records the
 * holder's pid, host and a token, and is touched every minute: a waiter takes it over at once when that pid is gone
 * on this computer; a holder that is alive on this computer keeps it however long it takes or sleeps. A lock of
 * another computer is taken over only after nobody touched it for minutes. Waiting prints progress.
 *
 * Every change of the lock folder (making it, a release, a takeover, the heartbeat) runs inside a short second mutex
 * (`.lock-<name>.takeover`): a takeover that judged a lock and then deletes it cannot have it replaced in between
 * (the holder released and another waiter made a fresh one). A holder removes its lock only while it still holds its
 * own token, also when a signal ends the process. A holder whose lock was taken over (another computer's holder that
 * slept) aborts `work`'s signal and fails as Unavailable once `work` has stopped; `work` must stop writing then. A full
 * or read-only disk is Unavailable, like a failed download.
 */
export async function withLock<T>(
	cache: string,
	name: string,
	work: (signal: AbortSignal) => Promise<T>,
	options: LockOptions = {},
): Promise<T> {
	const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	const pollMs = options.pollMs ?? 500;
	const heartbeatMs = options.heartbeatMs ?? 60_000;
	const staleMs = options.staleMs ?? 5 * 60_000;
	const maxWaitMs = options.maxWaitMs ?? 2 * 60 * 60_000;
	const lock = path.join(cache, `.lock-${name}`);
	const guard = `${lock}${TAKEOVER_SUFFIX}`;
	const ownerFile = path.join(lock, "owner.json");
	const me: LockOwner = { pid: process.pid, host: os.hostname(), started: Date.now(), token: randomUUID() };
	const label = `${name} lock`;

	const mine = (): boolean => {
		const owner = readOwner(ownerFile);
		return owner !== null && owner.pid === me.pid && owner.host === me.host && owner.token === me.token;
	};
	// Windows refuses mkdir with EPERM/EACCES while a folder of that name is still being deleted (another process just
	// released or took over the lock). That is a busy lock, not a permission problem, unless it never ends.
	let pendingDelete = 0;
	const deletePending = (error: unknown): boolean => {
		const code = (error as NodeJS.ErrnoException).code;
		if (process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES")) return false;
		return ++pendingDelete <= 200;
	};
	/**
	 * The short mutex (`.lock-<name>.takeover`) that every change of the lock folder runs under: making it, removing it
	 * on release, taking it over, and the heartbeat. A takeover judges the lock and then deletes it; with this held
	 * nobody can make, remove or touch the lock in between, so it removes the very lock it judged. Returns false when
	 * somebody else holds it; a guard nobody released for TAKEOVER_STALE_MS (its holder died) is removed.
	 */
	const tryGuard = (): boolean => {
		try {
			fs.mkdirSync(guard);
			return true;
		} catch (error) {
			if (deletePending(error)) return false;
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw environmental(error, label);
			// A guard that vanished is not stale: its holder just finished, and the next taker may already have made a new one.
			const age = fs.statSync(guard, { throwIfNoEntry: false });
			if (age && Date.now() - age.mtimeMs > TAKEOVER_STALE_MS) fs.rmSync(guard, { recursive: true, force: true });
			return false;
		}
	};
	const unguard = (): void => {
		fs.rmSync(guard, { recursive: true, force: true });
	};
	/** Runs `body` under the guard, waiting (blocking) for it: the guard is held for a few fs calls at a time. */
	const underGuardSync = <R>(body: () => R): R => {
		const gate = new Int32Array(new SharedArrayBuffer(4));
		const until = Date.now() + 2 * TAKEOVER_STALE_MS;
		while (!tryGuard()) {
			if (Date.now() > until) throw new Unavailable(`${label}: ${guard} stayed busy`);
			Atomics.wait(gate, 0, 0, 2);
		}
		try {
			return body();
		} finally {
			unguard();
		}
	};
	const release = (): void => {
		underGuardSync(() => {
			if (mine()) fs.rmSync(lock, { recursive: true, force: true });
		});
	};
	/** Makes the lock folder and writes the owner, under the guard; false when somebody else's lock is there. */
	const makeLock = (): boolean => {
		try {
			fs.mkdirSync(lock);
			pendingDelete = 0;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST" || deletePending(error)) return false;
			throw environmental(error, label);
		}
		try {
			fs.writeFileSync(ownerFile, JSON.stringify(me));
		} catch (error) {
			fs.rmSync(lock, { recursive: true, force: true });
			throw environmental(error, label);
		}
		return true;
	};
	const acquire = (): boolean => {
		// A lock that is there needs no guard: this look only spares the guard (a waiter polling every few ms would
		// keep it taken); the mkdir below, under the guard, is what decides.
		if (fs.existsSync(lock)) return false;
		if (!tryGuard()) return false;
		try {
			return makeLock();
		} finally {
			unguard();
		}
	};
	const sameOwner = (a: LockOwner | null, b: LockOwner | null): boolean =>
		a === null || b === null ? a === b : a.pid === b.pid && a.started === b.started && a.token === b.token;
	/**
	 * What a waiter sees of the lock now: who holds it, and whether it is dead or abandoned. Only a takeover under the
	 * guard may act on it (outside, it is a hint: the lock can change right after). A lock that is gone is never
	 * abandoned. A lock whose owner changed between the first read and the last is not abandoned for any reason (the
	 * mtime and the pid verdict belong to the old one). A holder on this computer is abandoned only when its pid is
	 * gone; staleness alone (idle > staleMs) condemns only a lock whose holder cannot be asked: another computer's, or
	 * one with no readable owner.
	 */
	const judge = (): { owner: LockOwner | null; idle: number; gone: boolean; abandoned: boolean; dead: boolean } => {
		const owner = readOwner(ownerFile);
		const at = touched(lock, ownerFile);
		if (at === null) return { owner, idle: 0, gone: true, dead: false, abandoned: false };
		const idle = Date.now() - at;
		const local = owner !== null && owner.host === me.host;
		const dead = owner !== null && local && !pidAlive(owner.pid);
		const again = readOwner(ownerFile);
		if (!sameOwner(owner, again)) return { owner: again, idle: 0, gone: false, dead: false, abandoned: false };
		return { owner, idle, gone: false, dead, abandoned: dead || (!local && idle > staleMs) };
	};
	const takeOver = (): boolean => {
		if (!tryGuard()) return false;
		try {
			const now = judge();
			if (now.gone) return makeLock();
			if (!now.abandoned) return false;
			log(
				now.dead
					? `taking over the ${name} lock: its holder (pid ${now.owner?.pid}) is no longer running`
					: `taking over the ${name} lock: nobody touched it for ${Math.round(now.idle / 60_000)} min (holder on ${now.owner?.host ?? "an unknown computer"})`,
			);
			fs.rmSync(lock, { recursive: true, force: true });
			return makeLock();
		} catch (error) {
			throw environmental(error, label);
		} finally {
			unguard();
		}
	};

	try {
		fs.mkdirSync(cache, { recursive: true });
	} catch (error) {
		throw environmental(error, label);
	}
	const startedWaiting = Date.now();
	let nextNote = startedWaiting + 20_000;
	while (!acquire()) {
		const seen = judge();
		if (seen.abandoned && takeOver()) break;
		if (Date.now() - startedWaiting > maxWaitMs) {
			throw new Unavailable(
				`another setup of ${name} (pid ${seen.owner?.pid ?? "?"}) has held ${lock} for too long`,
			);
		}
		if (Date.now() >= nextNote) {
			log(
				`waiting for another setup of ${name} to finish (pid ${seen.owner?.pid ?? "?"} on ${seen.owner?.host ?? "?"})`,
			);
			nextNote = Date.now() + 30_000;
		}
		await new Promise(resolve => setTimeout(resolve, pollMs));
	}
	const unregister = onInterrupt(release);
	// A takeover of this lock (its holder is on another computer that slept past staleMs, or the folder was removed)
	// ends this holder's work: it is no longer protected, and whoever holds the lock now may be installing into the same
	// folder. `work` is told through the signal and awaited: it must have stopped writing before this setup fails.
	const lostError = (): Unavailable =>
		new Unavailable(`${label}: ${lock} was taken over while this setup was running; its work is not protected`);
	const stopWork = new AbortController();
	const beat = setInterval(() => {
		let held = false;
		try {
			held = tryGuard();
			if (!held) return; // somebody is changing the lock: the next beat
			if (!mine()) {
				clearInterval(beat);
				stopWork.abort(lostError());
				return;
			}
			const now = new Date();
			fs.utimesSync(ownerFile, now, now);
		} catch {
			// the lock was removed; the work below will find out when it ends
		} finally {
			if (held) unguard();
		}
	}, heartbeatMs);
	beat.unref();
	try {
		const removed = cleanLeftovers(cache, { legacy: !otherHostWorking(cache, me.host, staleMs) });
		if (removed.length > 0)
			log(`removed ${removed.length} unfinished download or unpack folder(s) of a stopped setup`);
		const result = await work(stopWork.signal);
		if (stopWork.signal.aborted || !mine()) throw lostError();
		return result;
	} catch (error) {
		if (stopWork.signal.aborted) throw stopWork.signal.reason;
		throw environmental(error, label);
	} finally {
		clearInterval(beat);
		unregister();
		release();
	}
}
