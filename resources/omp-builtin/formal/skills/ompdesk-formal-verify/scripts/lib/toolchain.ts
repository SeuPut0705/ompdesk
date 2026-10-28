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
	options: { label: string; env?: NodeJS.ProcessEnv; log?: (line: string) => void; idleTimeoutMs?: number },
): Promise<void> {
	const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	const refused = downloadsRefused(options.env);
	if (refused) throw new Unavailable(`${options.label}: ${refused}`);
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	const part = `${dest}.part-${process.pid}`;
	const hash = createHash("sha256");
	const idleMs = options.idleTimeoutMs ?? DOWNLOAD_IDLE_MS;
	const controller = new AbortController();
	let idle: ReturnType<typeof setTimeout> | undefined;
	const touch = (): void => {
		clearTimeout(idle);
		idle = setTimeout(() => controller.abort(new Error(`no data for ${Math.round(idleMs / 1000)} s`)), idleMs);
	};
	try {
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

/** Unpacks into a fresh folder, then moves the single top-level folder (if any) to `dest`. */
export async function extractInto(archive: string, format: ArchiveFormat, dest: string): Promise<void> {
	const staging = `${dest}.tmp-${process.pid}`;
	fs.rmSync(staging, { recursive: true, force: true });
	fs.mkdirSync(staging, { recursive: true });
	try {
		let result: RunResult;
		if (format === "tar.gz") {
			result = await run("tar", ["-xzf", archive, "-C", staging]);
		} else if (process.platform === "win32") {
			// Windows' tar.exe (bsdtar) reads zip files; Expand-Archive is slower but always there.
			result = await run("tar", ["-xf", archive, "-C", staging]);
			if (result.code !== 0) {
				const quote = (text: string): string => `'${text.replaceAll("'", "''")}'`;
				result = await run("powershell", [
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(staging)} -Force`,
				]);
			}
		} else {
			result = await run("unzip", ["-q", "-o", archive, "-d", staging]);
		}
		if (result.spawnError || result.code !== 0) {
			throw new Error(
				`unpacking ${path.basename(archive)} failed: ${result.spawnError?.message ?? (result.stderr.trim() || `exit ${result.code}`)}`,
			);
		}
		const children = fs.readdirSync(staging);
		const only = children.length === 1 ? path.join(staging, children[0] as string) : null;
		const root = only && fs.statSync(only).isDirectory() ? only : staging;
		fs.rmSync(dest, { recursive: true, force: true });
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.renameSync(root, dest);
	} finally {
		fs.rmSync(staging, { recursive: true, force: true });
	}
}

export interface LockOptions {
	log?: (line: string) => void;
	/** How often a waiter looks again. */
	pollMs?: number;
	/** The holder rewrites its lock this often while it works. */
	heartbeatMs?: number;
	/** A lock nobody has touched for this long is abandoned, whatever its pid says (another computer, a frozen holder). */
	staleMs?: number;
	/** Give up waiting on a live holder after this long. */
	maxWaitMs?: number;
}

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

function readOwner(file: string): LockOwner | null {
	try {
		const json: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (isRecord(json) && typeof json.pid === "number" && typeof json.host === "string") {
			return { pid: json.pid, host: json.host, started: typeof json.started === "number" ? json.started : 0 };
		}
	} catch {
		// being written, or not a lock of ours
	}
	return null;
}

function touched(lock: string, ownerFile: string): number {
	for (const target of [ownerFile, lock]) {
		try {
			return fs.statSync(target).mtimeMs;
		} catch {
			// try the next
		}
	}
	return 0;
}

const LEFTOVER = /\.(?:part|tmp)-(\d+)$/;

/**
 * Removes `*.part-<pid>` downloads and `*.tmp-<pid>` unpack folders that a killed setup left behind (each can be
 * gigabytes). Only those of a pid that is no longer running; the scan stays three levels deep and never enters a
 * toolchain.
 */
export function cleanLeftovers(root: string): string[] {
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
				if (!pidAlive(Number(match[1]))) {
					fs.rmSync(full, { recursive: true, force: true });
					removed.push(full);
				}
			} else if (entry.isDirectory() && depth < 3 && !entry.name.startsWith(".lock-")) scan(full, depth + 1);
		}
	};
	scan(root, 1);
	return removed;
}

/**
 * One installer at a time per name across processes (two agents may call setup together). The lock records the
 * holder's pid and host and is touched every minute: a waiter takes it over at once when that pid is gone, or when
 * nobody touched it for minutes; a live holder, however slow its download, keeps it. Waiting prints progress.
 */
export async function withLock<T>(
	cache: string,
	name: string,
	work: () => Promise<T>,
	options: LockOptions = {},
): Promise<T> {
	const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	const pollMs = options.pollMs ?? 500;
	const heartbeatMs = options.heartbeatMs ?? 60_000;
	const staleMs = options.staleMs ?? 5 * 60_000;
	const maxWaitMs = options.maxWaitMs ?? 2 * 60 * 60_000;
	fs.mkdirSync(cache, { recursive: true });
	const lock = path.join(cache, `.lock-${name}`);
	const ownerFile = path.join(lock, "owner.json");
	const me: LockOwner = { pid: process.pid, host: os.hostname(), started: Date.now() };
	const startedWaiting = Date.now();
	let nextNote = startedWaiting + 20_000;
	for (;;) {
		try {
			fs.mkdirSync(lock);
			fs.writeFileSync(ownerFile, JSON.stringify(me));
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const owner = readOwner(ownerFile);
		const idle = Date.now() - touched(lock, ownerFile);
		const dead = owner !== null && owner.host === me.host && !pidAlive(owner.pid);
		if (dead || idle > staleMs) {
			log(
				dead
					? `taking over the ${name} lock: its holder (pid ${owner?.pid}) is no longer running`
					: `taking over the ${name} lock: nobody touched it for ${Math.round(idle / 60_000)} min`,
			);
			const aside = `${lock}.stale-${process.pid}-${Date.now()}`;
			try {
				fs.renameSync(lock, aside);
				fs.rmSync(aside, { recursive: true, force: true });
			} catch {
				// another waiter took it over first
			}
			continue;
		}
		if (Date.now() - startedWaiting > maxWaitMs) {
			throw new Unavailable(`another setup of ${name} (pid ${owner?.pid ?? "?"}) has held ${lock} for too long`);
		}
		if (Date.now() >= nextNote) {
			log(`waiting for another setup of ${name} to finish (pid ${owner?.pid ?? "?"} on ${owner?.host ?? "?"})`);
			nextNote = Date.now() + 30_000;
		}
		await new Promise(resolve => setTimeout(resolve, pollMs));
	}
	const beat = setInterval(() => {
		const now = new Date();
		try {
			fs.utimesSync(ownerFile, now, now);
		} catch {
			// the lock was taken over; the work below will find out when it writes
		}
	}, heartbeatMs);
	beat.unref();
	try {
		const removed = cleanLeftovers(cache);
		if (removed.length > 0)
			log(`removed ${removed.length} unfinished download or unpack folder(s) of a stopped setup`);
		return await work();
	} finally {
		clearInterval(beat);
		fs.rmSync(lock, { recursive: true, force: true });
	}
}
