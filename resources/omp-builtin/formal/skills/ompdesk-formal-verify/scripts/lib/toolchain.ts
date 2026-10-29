import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import { platformKey } from "./cache";
import { isRecord, readJson } from "./json";
import { type RunResult, run, Unavailable } from "./proc";

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
export async function extractInto(archive: string, format: ArchiveFormat, dest: string): Promise<void> {
	const staging = `${dest}.tmp-${hostTag()}-${process.pid}`;
	try {
		fs.rmSync(staging, { recursive: true, force: true });
		fs.mkdirSync(staging, { recursive: true });
		let result: RunResult;
		if (format === "tar.gz") {
			result = await run(tarProgram(), ["-xzf", archive, "-C", staging]);
		} else if (process.platform === "win32") {
			// bsdtar reads zip files; Expand-Archive is slower but always there.
			result = await run(tarProgram(), ["-xf", archive, "-C", staging]);
			if (result.code !== 0) {
				result = await run("powershell", [
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					expandArchiveCommand(archive, staging),
				]);
			}
		} else {
			result = await run("unzip", ["-q", "-o", archive, "-d", staging]);
		}
		if (result.spawnError || result.code !== 0) {
			throw new Unavailable(
				`unpacking ${path.basename(archive)} failed: ${result.spawnError?.message ?? (result.stderr.trim() || `exit ${result.code}`)}`,
			);
		}
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
	/** How often a waiter tries the lock again. */
	pollMs?: number;
	/** Give up waiting on a holder after this long. */
	maxWaitMs?: number;
}

/** The note a holder writes into its lock file (for a waiter's log line only; the OS lock is what decides). */
interface LockOwner {
	pid: number;
	host: string;
	started: number;
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

/** The note in a lock file; null when it has none (yet) or is not ours. */
function readOwner(file: string): LockOwner | null {
	try {
		const json: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (isRecord(json) && typeof json.pid === "number" && typeof json.host === "string") {
			return { pid: json.pid, host: json.host, started: typeof json.started === "number" ? json.started : 0 };
		}
	} catch {
		// being written, or not a note of ours
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
 * computer left behind (each can be gigabytes). Only those of a pid that is no longer running; a name that carries
 * another host is left alone (the cache is per computer, so that is a copied folder, and its pids mean nothing
 * here). Names without a host are an older setup's. The scan stays three levels deep and never enters a toolchain.
 */
export function cleanLeftovers(root: string, options: { host?: string } = {}): string[] {
	const host = options.host ?? hostTag();
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
				const mine = match[1] === undefined || match[1] === host;
				if (mine && !pidAlive(Number(match[2]))) {
					fs.rmSync(full, { recursive: true, force: true });
					removed.push(full);
				}
			} else if (entry.isDirectory() && depth < 3) scan(full, depth + 1);
		}
	};
	scan(root, 1);
	return removed;
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

/** The OS calls behind the install lock, loaded once. Which ones depends on the platform; see `openLock`. */
interface OsCalls {
	/** POSIX: the errno values of a failed `flock` that mean "try again" (held by somebody else, or interrupted). */
	busy?: readonly number[];
	flock?: (fd: number, operation: number) => number;
	errno?: () => number;
	createFile?: (file: string) => bigint;
	closeHandle?: (handle: bigint) => void;
	writeFile?: (handle: bigint, text: string) => void;
	lastError?: () => number;
}

let osCalls: Promise<OsCalls> | undefined;

/**
 * Loads `bun:ffi` and the library the lock needs. macOS and Linux: libc's `flock`, whose lock belongs to the open file
 * description. Windows: kernel32's `CreateFileW`, whose sharing mode is the lock. A runtime without `bun:ffi` (the
 * scripts of this skill always run under Bun) or a platform with neither is Unavailable.
 */
function loadOsCalls(): Promise<OsCalls> {
	osCalls ??= (async (): Promise<OsCalls> => {
		let ffi: typeof import("bun:ffi");
		try {
			ffi = await import("bun:ffi");
		} catch (error) {
			throw new Unavailable(
				`the install lock needs bun:ffi, so these scripts run under Bun (${error instanceof Error ? error.message : String(error)})`,
			);
		}
		const { dlopen, FFIType, read } = ffi;
		try {
			if (process.platform === "darwin" || process.platform === "linux") {
				const darwin = process.platform === "darwin";
				const { symbols } = dlopen(darwin ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
					flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
					[darwin ? "__error" : "__errno_location"]: { args: [], returns: FFIType.ptr },
				});
				const where = darwin ? symbols.__error : symbols.__errno_location;
				return {
					busy: [darwin ? 35 : 11, 4], // EWOULDBLOCK, EINTR
					flock: (fd, operation) => symbols.flock(fd, operation),
					// Read right after the failed call, before anything else can set it.
					errno: () => read.i32(where() as never),
				};
			}
			if (process.platform === "win32") {
				const { symbols } = dlopen("kernel32.dll", {
					CreateFileW: {
						args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
						returns: FFIType.i64,
					},
					GetLastError: { args: [], returns: FFIType.u32 },
					CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
					WriteFile: {
						args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
						returns: FFIType.i32,
					},
					SetEndOfFile: { args: [FFIType.i64], returns: FFIType.i32 },
				});
				const GENERIC_READ_WRITE = 0xc0000000;
				const FILE_SHARE_READ = 1;
				const OPEN_ALWAYS = 4;
				const FILE_ATTRIBUTE_NORMAL = 0x80;
				return {
					createFile: file =>
						BigInt(
							symbols.CreateFileW(
								Buffer.from(`${file}\0`, "utf16le"),
								GENERIC_READ_WRITE,
								FILE_SHARE_READ,
								null,
								OPEN_ALWAYS,
								FILE_ATTRIBUTE_NORMAL,
								null,
							),
						),
					closeHandle: handle => void symbols.CloseHandle(handle),
					writeFile: (handle, text) => {
						const data = Buffer.from(text);
						const written = new Uint32Array(1);
						if (symbols.WriteFile(handle, data, data.length, written, null) === 0) {
							throw new Error(`WriteFile failed (error ${symbols.GetLastError()})`);
						}
						symbols.SetEndOfFile(handle);
					},
					lastError: () => symbols.GetLastError(),
				};
			}
		} catch (error) {
			throw new Unavailable(
				`the install lock could not load its system library (${error instanceof Error ? error.message : String(error)})`,
			);
		}
		throw new Unavailable(`the install lock has no system call for ${process.platform}`);
	})();
	return osCalls;
}

/** The lock file of one name: held from a successful `tryLock` until `release`, or until the process ends. */
interface LockFile {
	/** Takes the lock without waiting: false while another holder has it; anything else that fails is Unavailable. */
	tryLock(): boolean;
	/** Writes the holder's note into the lock file (only a holder may). */
	note(text: string): void;
	/** Lets go. The OS does the same when the process dies, killed or not, so a holder never leaves a lock behind. */
	release(): void;
}

/**
 * The lock is an OS lock on `file` that the kernel drops when its holder's process ends, so nothing here judges a
 * holder alive or dead and nothing needs a timeout to recover. The file is never deleted: its content is only the
 * holder's note for a waiter's log line.
 *
 * macOS/Linux: `flock(LOCK_EX | LOCK_NB)` on an fd opened by this call and kept open for the hold. BSD flock belongs to
 * the open file description, so two calls in one process exclude each other too (as two processes do).
 *
 * Windows: `CreateFileW` with read/write access and a sharing mode that allows only readers, OPEN_ALWAYS: a second
 * opener asks for write access and is refused on the sharing mode (busy), `CloseHandle` releases, and a waiter can
 * still read the note. A refused open is told busy from an environmental failure by a plain read open (see
 * `tryLock`), not by GetLastError, which the runtime may reset before it is read. Chosen over `LockFileEx` because that
 * needs a HANDLE and Bun gives fs.openSync only a CRT fd (no supported conversion), while CreateFileW needs no fd.
 *
 * Not supported: a cache folder on a network drive shared by several computers. flock and sharing modes are not
 * promised to hold across the network (NFS and SMB differ, some silently grant), so there the lock may let two
 * computers in; the cache is per computer.
 */
async function openLock(file: string, label: string): Promise<LockFile> {
	const calls = await loadOsCalls();
	const unavailable = (what: string, error?: unknown): Unavailable =>
		new Unavailable(`${label}: ${what}${error instanceof Error ? `: ${error.message}` : ""}`);
	if (calls.flock && calls.errno) {
		const { flock, errno } = calls;
		let fd: number;
		try {
			fd = fs.openSync(file, "a");
		} catch (error) {
			throw unavailable(`cannot open ${file}`, error);
		}
		let open = true;
		return {
			tryLock() {
				const LOCK_EX = 2;
				const LOCK_NB = 4;
				if (flock(fd, LOCK_EX | LOCK_NB) === 0) return true;
				const code = errno();
				if (calls.busy?.includes(code)) return false;
				throw unavailable(`flock(${file}) failed with errno ${code}`);
			},
			note(text) {
				// Appending file: after the truncate the write lands at the start.
				fs.ftruncateSync(fd, 0);
				fs.writeSync(fd, text);
			},
			release() {
				if (!open) return;
				open = false;
				fs.closeSync(fd);
			},
		};
	}
	const { createFile, closeHandle, writeFile, lastError } = calls as Required<OsCalls>;
	let handle: bigint | null = null;
	return {
		tryLock() {
			if (handle !== null) return true;
			const opened = createFile(file);
			if (opened !== -1n) {
				handle = opened;
				return true;
			}
			// Not GetLastError for the decision: the runtime can run Win32 calls between CreateFileW and the read of
			// the last error and reset it, so a busy lock could read as 0. Instead, a plain read open (libuv shares
			// read, write and delete) answers whether the file is there and readable: if it is, CreateFileW failed
			// on the holder's sharing mode, so the lock is busy; if it is not, the disk or the folder is the problem.
			let probe: number;
			try {
				probe = fs.openSync(file, "r");
			} catch (error) {
				throw unavailable(`CreateFileW(${file}) failed (error ${lastError()}) and the file cannot be read`, error);
			}
			fs.closeSync(probe);
			return false;
		},
		note(text) {
			if (handle !== null) writeFile(handle, text);
		},
		release() {
			if (handle === null) return;
			closeHandle(handle);
			handle = null;
		},
	};
}

/**
 * One installer at a time per name across processes (two agents may call setup together), and across calls in one
 * process: `<cache>/.lock-<name>` is held with an OS lock (`openLock`) until `work` ends. A waiter polls every `pollMs`
 * up to `maxWaitMs`, then is Unavailable, and prints progress; a holder that is merely slow, stopped or asleep keeps
 * the lock, and one that dies (killed, crashed) frees it at once. The holder's pid, host and start are written into
 * the lock file only so the waiting line can name them. A full or read-only disk, a lock file that cannot be opened and
 * a runtime without `bun:ffi` are Unavailable (exit 3, "not checked"), like a failed download.
 */
export async function withLock<T>(
	cache: string,
	name: string,
	work: () => Promise<T>,
	options: LockOptions = {},
): Promise<T> {
	const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	const pollMs = options.pollMs ?? 500;
	const maxWaitMs = options.maxWaitMs ?? 2 * 60 * 60_000;
	const lock = path.join(cache, `.lock-${name}`);
	const label = `${name} lock`;
	let file: LockFile;
	try {
		fs.mkdirSync(cache, { recursive: true });
		// A folder of this name is the lock of the hand-made protocol this one replaced (its holder was killed): the
		// file takes its place. Running a skill of the old protocol at the same time as this one is not supported:
		// each ignores the other's lock (the old one makes a folder where this one's file is, this one removes the
		// old folder), so two installers could work at once.
		if (fs.statSync(lock, { throwIfNoEntry: false })?.isDirectory())
			fs.rmSync(lock, { recursive: true, force: true });
		file = await openLock(lock, label);
	} catch (error) {
		throw error instanceof Unavailable
			? error
			: new Unavailable(`${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		const startedWaiting = Date.now();
		let nextNote = startedWaiting + 20_000;
		while (!file.tryLock()) {
			const owner = readOwner(lock);
			if (Date.now() - startedWaiting > maxWaitMs) {
				throw new Unavailable(`another setup of ${name} (pid ${owner?.pid ?? "?"}) has held ${lock} for too long`);
			}
			if (Date.now() >= nextNote) {
				log(`waiting for another setup of ${name} to finish (pid ${owner?.pid ?? "?"} on ${owner?.host ?? "?"})`);
				nextNote = Date.now() + 30_000;
			}
			await new Promise(resolve => setTimeout(resolve, pollMs));
		}
		try {
			file.note(JSON.stringify({ pid: process.pid, host: os.hostname(), started: Date.now() } satisfies LockOwner));
		} catch {
			// only a hint for another waiter's log line
		}
		const removed = cleanLeftovers(cache);
		if (removed.length > 0)
			log(`removed ${removed.length} unfinished download or unpack folder(s) of a stopped setup`);
		return await work();
	} catch (error) {
		throw environmental(error, label);
	} finally {
		file.release();
	}
}
