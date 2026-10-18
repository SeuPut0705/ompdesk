/**
 * Put the pinned ai-memory release binaries under `resources/ai-memory-bin/<platform>-<arch>/`
 * (gitignored), for both platforms whatever the host OS: the builder configs ship one directory
 * each (`extraResources` → `ai-memory-bin/`), `scripts/after-pack.cjs` fails a package without it.
 * The pin is `resources/omp-builtin/ai-memory/ai-memory.json`; bump it with `bun run bump:ai-memory`.
 *
 *   bun run sync:ai-memory
 *
 * Each archive is downloaded from the GitHub release together with its `<archive>.sha256`; the
 * published checksum, the pin's `archiveSha256` and the downloaded bytes must agree, and the one
 * extracted binary must equal `binarySha256`. Archives are read in-process (no tar/unzip binary).
 * Anything else exits 1 and leaves nothing half-written (temp file, then rename).
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, inflateRawSync } from "node:zlib";

export const AI_MEMORY_REPO = "akitaonrails/ai-memory";
export const PLATFORM_KEYS = ["darwin-arm64", "win32-x64"] as const;
export type PlatformKey = (typeof PLATFORM_KEYS)[number];

export interface PlatformPin {
	archive: string;
	archiveSha256: string;
	binary: string;
	binarySha256: string;
}
export interface AiMemoryPin {
	version: string;
	repository: string;
	assets: Record<PlatformKey, PlatformPin>;
}

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PIN_FILE = path.join(REPO_ROOT, "resources/omp-builtin/ai-memory/ai-memory.json");
export const BIN_ROOT = path.join(REPO_ROOT, "resources/ai-memory-bin");

const HEX64 = /^[0-9a-f]{64}$/;

export function readPin(file = PIN_FILE): AiMemoryPin {
	const pin = JSON.parse(fs.readFileSync(file, "utf8")) as AiMemoryPin;
	if (pin.repository !== AI_MEMORY_REPO) throw new Error(`${file}: repository must be ${AI_MEMORY_REPO}`);
	return pin;
}

export function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** `resources/ai-memory-bin/<platform>-<arch>/<binary>` (`<platform>-<arch>` is `process.platform`/`arch`). */
export function binaryPath(platform: string, arch: string, pin: AiMemoryPin = readPin(), binRoot = BIN_ROOT): string {
	const entry = (pin.assets as Record<string, PlatformPin | undefined>)[`${platform}-${arch}`];
	if (!entry) throw new Error(`ai-memory pin has no ${platform}-${arch} entry`);
	return path.join(binRoot, `${platform}-${arch}`, entry.binary);
}

export function releaseUrl(version: string, file: string): string {
	return `https://github.com/${AI_MEMORY_REPO}/releases/download/v${version}/${file}`;
}

/** The hash in a `sha256sum`-style file (`<hex>  <name>`, or a bare `<hex>`), lowercased. */
export function parseSha256File(text: string): string {
	const token = text.trim().split(/\s+/)[0] ?? "";
	const hash = token.toLowerCase();
	if (!HEX64.test(hash)) throw new Error(`not a SHA-256 checksum file: ${JSON.stringify(text.slice(0, 80))}`);
	return hash;
}

/** Throws unless the published checksum, the pin and the downloaded bytes are one hash. */
export function verifyArchive(name: string, bytes: Uint8Array, published: string, pinned: string): string {
	const actual = sha256(bytes);
	if (published !== pinned) throw new Error(`${name}: published SHA-256 ${published} differs from the pin ${pinned}`);
	if (actual !== published) throw new Error(`${name}: downloaded bytes hash to ${actual}, published ${published}`);
	return actual;
}

/** The bytes of the regular file `member` (leading `./` ignored) in a .tar.gz. */
export function extractTarGzMember(archive: Uint8Array, member: string): Buffer {
	const tar = gunzipSync(archive);
	let offset = 0;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every(byte => byte === 0)) break;
		const cString = (from: number, to: number) => {
			const field = header.subarray(from, to);
			const end = field.indexOf(0);
			return field.subarray(0, end < 0 ? field.length : end).toString("utf8");
		};
		const size = Number.parseInt(cString(124, 136).trim() || "0", 8);
		const type = String.fromCharCode(header[156] || 0x30);
		const prefix = cString(345, 500);
		const name = (prefix ? `${prefix}/` : "") + cString(0, 100);
		const start = offset + 512;
		if ((type === "0" || type === "\0") && name.replace(/^\.\//, "") === member) {
			if (start + size > tar.length) throw new Error(`tar member ${member} is truncated`);
			return Buffer.from(tar.subarray(start, start + size));
		}
		offset = start + Math.ceil(size / 512) * 512;
	}
	throw new Error(`${member} is not in the tar archive`);
}

/** The bytes of the file `member` in a .zip (central directory; stored or deflate; no zip64). */
export function extractZipMember(archive: Uint8Array, member: string): Buffer {
	const zip = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
	let eocd = -1;
	for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) {
		if (zip.readUInt32LE(at) === 0x06054b50) {
			eocd = at;
			break;
		}
	}
	if (eocd < 0) throw new Error("not a zip archive (no end-of-central-directory record)");
	const count = zip.readUInt16LE(eocd + 10);
	let at = zip.readUInt32LE(eocd + 16);
	if (count === 0xffff || at === 0xffffffff) throw new Error("zip64 archives are not supported");
	for (let index = 0; index < count; index++) {
		if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("corrupt zip central directory");
		const method = zip.readUInt16LE(at + 10);
		const compressed = zip.readUInt32LE(at + 20);
		const size = zip.readUInt32LE(at + 24);
		const nameLength = zip.readUInt16LE(at + 28);
		const extraLength = zip.readUInt16LE(at + 30);
		const commentLength = zip.readUInt16LE(at + 32);
		const local = zip.readUInt32LE(at + 42);
		const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
		at += 46 + nameLength + extraLength + commentLength;
		if (name !== member) continue;
		if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error("corrupt zip local header");
		const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
		const body = zip.subarray(data, data + compressed);
		const out = method === 0 ? Buffer.from(body) : method === 8 ? inflateRawSync(body) : null;
		if (!out) throw new Error(`zip member ${member} uses unsupported compression method ${method}`);
		if (out.length !== size) throw new Error(`zip member ${member} is ${out.length} bytes, expected ${size}`);
		return out;
	}
	throw new Error(`${member} is not in the zip archive`);
}

export function extractBinary(archiveName: string, archive: Uint8Array, binary: string): Buffer {
	if (archiveName.endsWith(".tar.gz")) return extractTarGzMember(archive, binary);
	if (archiveName.endsWith(".zip")) return extractZipMember(archive, binary);
	throw new Error(`unknown archive type: ${archiveName}`);
}

export async function download(url: string, headers: Record<string, string> = {}): Promise<Buffer> {
	const response = await fetch(url, { headers, redirect: "follow" });
	if (!response.ok) throw new Error(`GET ${url}: ${response.status} ${response.statusText}`);
	return Buffer.from(await response.arrayBuffer());
}

/** Download an archive and its published checksum; the archive's SHA-256 once the published one matches. */
export async function fetchArchive(
	version: string,
	archive: string,
): Promise<{ bytes: Buffer; published: string; actual: string }> {
	const [bytes, checksum] = await Promise.all([
		download(releaseUrl(version, archive)),
		download(releaseUrl(version, `${archive}.sha256`)),
	]);
	return { bytes, published: parseSha256File(checksum.toString("utf8")), actual: sha256(bytes) };
}

/** Write `bytes` atomically (temp file in the same directory, then rename) with the given mode. */
export function writeAtomic(file: string, bytes: Uint8Array, mode = 0o755): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.tmp-${process.pid}`;
	try {
		fs.writeFileSync(temp, bytes, { mode });
		fs.chmodSync(temp, mode);
		fs.renameSync(temp, file);
	} finally {
		fs.rmSync(temp, { force: true });
	}
}

function fileHash(file: string): string | null {
	try {
		return sha256(fs.readFileSync(file));
	} catch {
		return null;
	}
}

/** Populate every pinned platform; returns the files written (already-matching ones are skipped). */
export async function syncAiMemory(pin = readPin(), binRoot = BIN_ROOT): Promise<string[]> {
	const written: string[] = [];
	for (const key of PLATFORM_KEYS) {
		const entry = pin.assets[key];
		const target = path.join(binRoot, key, entry.binary);
		if (fileHash(target) === entry.binarySha256) {
			if (process.platform !== "win32") fs.chmodSync(target, 0o755);
			console.log(`ok    ${key}: ${path.relative(REPO_ROOT, target)} matches the pin`);
			continue;
		}
		const { bytes, published, actual } = await fetchArchive(pin.version, entry.archive);
		verifyArchive(entry.archive, bytes, published, entry.archiveSha256);
		if (actual !== entry.archiveSha256)
			throw new Error(`${entry.archive}: SHA-256 ${actual}, pin ${entry.archiveSha256}`);
		const binary = extractBinary(entry.archive, bytes, entry.binary);
		const binaryHash = sha256(binary);
		if (binaryHash !== entry.binarySha256) {
			throw new Error(`${key}: extracted ${entry.binary} hashes to ${binaryHash}, pin ${entry.binarySha256}`);
		}
		writeAtomic(target, binary);
		written.push(target);
		console.log(`wrote ${key}: ${path.relative(REPO_ROOT, target)} (${binary.length} bytes, v${pin.version})`);
	}
	return written;
}

if (import.meta.main) {
	syncAiMemory().catch(error => {
		console.error(`sync:ai-memory failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	});
}
