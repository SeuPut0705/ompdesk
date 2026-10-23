/**
 * Workspace filesystem behind fs:list / fs:read / fs:read-image /
 * fs:read-binary / fs:read-plan / fs:stat, plus the Files panel's few writes
 * (fs:mutate: new file or folder, rename, move to the trash) — node:fs based,
 * no sidecar session required, cross-platform, rooted at a tab's cwd. Shared by
 * the local IPC handlers and by the remote host (src/main/remote/host-services.ts),
 * which serves the same calls for a paired device's tabs with the same
 * confinement and caps. Never throws: every failure is an `ok: false` result
 * with a stable code.
 */
import type { Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promises as fsp } from "original-fs";
import { z } from "zod";
import { codedError, type IpcErrorCode } from "../shared/ipc-error-codes";
import type {
	FsTreeEntry,
	IpcFsListPayload,
	IpcFsListResult,
	IpcFsMutateResult,
	IpcFsMutation,
	IpcFsReadBinaryPayload,
	IpcFsReadBinaryResult,
	IpcFsReadImagePayload,
	IpcFsReadImageResult,
	IpcFsReadPayload,
	IpcFsReadPlanPayload,
	IpcFsReadPlanResult,
	IpcFsReadResult,
	IpcFsStatResult,
	RemoteDirListing,
} from "../shared/ipc-types";
import { FS_LIST_MAX_ENTRIES, FS_WRITE_MAX_BYTES, HOST_DOWNLOAD_PART_BYTES } from "../shared/ipc-types";

const FS_LIST_DEFAULT_DEPTH = 8;
const FS_LIST_MAX_DEPTH = 16;
/** Files one listing returns: `default` without a `maxEntries`, never more than `max`. */
interface FsListFileCaps {
	default: number;
	max: number;
}
const FS_LIST_FILE_CAPS: FsListFileCaps = { default: 2000, max: FS_LIST_MAX_ENTRIES };
const FS_READ_DEFAULT_MAX_BYTES = 200_000;
const FS_READ_MAX_BYTES_CAP = 2_000_000;
/** Markdown images become data URLs in the renderer; bound the bytes. */
const FS_IMAGE_MAX_BYTES = 25_000_000;
/** File viewer reads on this device: whole files up to this size. */
export const FS_BINARY_LOCAL_MAX_BYTES = 100 * 1024 * 1024;
/** A paired host's reply travels base64 (+33%) in one 16 MiB frame (remote/wire.ts). */
export const FS_BINARY_REMOTE_MAX_BYTES = 11 * 1024 * 1024;
/** Bytes read for magic-number sniffing (SVG's text check needs a few hundred). */
const SNIFF_HEADER_BYTES = 512;
const OCTET_STREAM = "application/octet-stream";
/**
 * Remote folder picker: one level, bounded so a huge directory cannot flood the link; the
 * picker's name filter reaches the folders past the bound.
 */
const LIST_DIRS_MAX_ENTRIES = 2000;

/** Always-skipped names, applied like root .gitignore patterns. */
const FS_IGNORED_DEFAULTS = [
	"node_modules",
	".git",
	".hg",
	".svn",
	"dist",
	"out",
	".next",
	"target",
	"build",
	".turbo",
	"coverage",
	"__pycache__",
	".venv",
	"venv",
	".cache",
	".codegraph",
	"bazel-*",
];

interface IgnoreRule {
	negated: boolean;
	dirOnly: boolean;
	regex: RegExp;
}

const REGEX_SPECIALS = "\\^$.|+()[]{}";

/**
 * Compile one gitignore pattern line into a rule. Minimal but faithful to the
 * common semantics: `!` negation, trailing `/` dir-only, any slash anchors the
 * pattern to the root, `*`/`?` match within a segment, `**` crosses segments.
 */
function compileIgnoreRule(rawLine: string): IgnoreRule | null {
	let line = rawLine.trimEnd();
	if (!line || line.startsWith("#")) return null;
	let negated = false;
	if (line.startsWith("!")) {
		negated = true;
		line = line.slice(1);
	} else if (line.startsWith("\\!") || line.startsWith("\\#")) {
		line = line.slice(1);
	}
	let dirOnly = false;
	if (line.endsWith("/")) {
		dirOnly = true;
		line = line.slice(0, -1);
	}
	if (!line) return null;
	const anchored = line.includes("/");
	if (line.startsWith("/")) line = line.slice(1);
	let body = "";
	let i = 0;
	while (i < line.length) {
		const char = line[i];
		if (char === "*") {
			if (line[i + 1] === "*") {
				if (line[i + 2] === "/") {
					body += "(?:[^/]+/)*";
					i += 3;
				} else {
					body += ".*";
					i += 2;
				}
			} else {
				body += "[^/]*";
				i += 1;
			}
		} else if (char === "?") {
			body += "[^/]";
			i += 1;
		} else if (REGEX_SPECIALS.includes(char)) {
			body += `\\${char}`;
			i += 1;
		} else {
			body += char;
			i += 1;
		}
	}
	// A matching directory also ignores everything beneath it.
	const source = anchored ? `^${body}(?:/.*)?$` : `(?:^|/)${body}(?:/.*)?$`;
	return { negated, dirOnly, regex: new RegExp(source) };
}

/** Last matching rule wins, per gitignore semantics. */
function isIgnored(rules: IgnoreRule[], relPath: string, isDir: boolean): boolean {
	let ignored = false;
	for (const rule of rules) {
		if (rule.dirOnly && !isDir) continue;
		if (rule.regex.test(relPath)) ignored = !rule.negated;
	}
	return ignored;
}

async function loadIgnoreRules(rootAbs: string): Promise<IgnoreRule[]> {
	const rules: IgnoreRule[] = [];
	for (const pattern of FS_IGNORED_DEFAULTS) {
		const rule = compileIgnoreRule(pattern);
		if (rule) rules.push(rule);
	}
	try {
		const content = await fsp.readFile(path.join(rootAbs, ".gitignore"), "utf8");
		for (const line of content.split(/\r?\n/)) {
			const rule = compileIgnoreRule(line);
			if (rule) rules.push(rule);
		}
	} catch {
		// No readable root .gitignore — defaults only.
	}
	return rules;
}

/** Resolve `rel` against `root`, refusing escapes outside the workspace. */
export function resolveWithin(root: string, rel: string): string | null {
	const resolved = path.resolve(root, rel);
	const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
	if (resolved !== root && !resolved.startsWith(rootWithSep)) return null;
	return resolved;
}

/** `abs` when it exists and is a regular file, else null. */
async function statFile(abs: string): Promise<string | null> {
	try {
		return (await fsp.stat(abs)).isFile() ? abs : null;
	} catch {
		return null;
	}
}

/**
 * Newest top-level `*plan.md` (case-insensitive) in `dirAbs`, mirroring the
 * agent-side `listPlanFiles` fallback (the agent names its own
 * `local://<slug>-plan.md`, so the configured path alone often misses it).
 */
async function newestPlanFile(dirAbs: string): Promise<string | null> {
	let dirents: Dirent[];
	try {
		dirents = await fsp.readdir(dirAbs, { withFileTypes: true });
	} catch {
		return null;
	}
	let best: { abs: string; mtimeMs: number } | null = null;
	for (const dirent of dirents) {
		if (!dirent.isFile() || !/plan\.md$/i.test(dirent.name)) continue;
		const abs = path.join(dirAbs, dirent.name);
		try {
			const { mtimeMs } = await fsp.stat(abs);
			if (!best || mtimeMs > best.mtimeMs) best = { abs, mtimeMs };
		} catch {
			// Vanished between readdir and stat — skip.
		}
	}
	return best?.abs ?? null;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

interface WalkState {
	rules: IgnoreRule[];
	maxDepth: number;
	maxFiles: number;
	fileCount: number;
	truncated: boolean;
}

/**
 * Name order for every listing here: numeric runs compare as numbers, so
 * `file-2` sorts before `file-10`. Stock omp exports no name comparator (its
 * only one is inline in `ida/install.ts`), so this is the platform's own.
 */
const NAME_ORDER = new Intl.Collator(undefined, { numeric: true });

/**
 * Breadth-first readdir → sorted tree (dirs first, then files, each in natural name order). Level by level,
 * so when the file cap stops the walk it is the deepest files that are missing, never every file of a
 * folder that merely sorts late; every folder seen is in the tree, with the children the walk got to.
 */
async function walkWorkspace(dirAbs: string, relPrefix: string, state: WalkState): Promise<FsTreeEntry[]> {
	const top: FsTreeEntry[] = [];
	let level = [{ abs: dirAbs, rel: relPrefix, out: top }];
	for (let depth = 0; level.length > 0 && !state.truncated; depth++) {
		const next: typeof level = [];
		for (const dir of level) {
			if (state.truncated) break;
			let dirents: Dirent[];
			try {
				dirents = await fsp.readdir(dir.abs, { withFileTypes: true });
			} catch {
				continue; // Unreadable directory (permissions) — skip, don't fail the walk.
			}
			const files: FsTreeEntry[] = [];
			const sorted = dirents
				.filter(dirent => !dirent.isSymbolicLink())
				.sort((a, b) => NAME_ORDER.compare(a.name, b.name));
			for (const dirent of sorted) {
				const isDir = dirent.isDirectory();
				if (!isDir && !dirent.isFile()) continue;
				const rel = dir.rel ? `${dir.rel}/${dirent.name}` : dirent.name;
				if (isIgnored(state.rules, rel, isDir)) continue;
				if (isDir) {
					const children: FsTreeEntry[] = [];
					dir.out.push({ name: dirent.name, path: rel, kind: "dir", children });
					if (depth < state.maxDepth) next.push({ abs: path.join(dir.abs, dirent.name), rel, out: children });
				} else if (state.fileCount >= state.maxFiles) {
					state.truncated = true;
					break;
				} else {
					state.fileCount += 1;
					files.push({ name: dirent.name, path: rel, kind: "file" });
				}
			}
			dir.out.push(...files);
		}
		level = next;
	}
	return top;
}

/** `~/` expands to this machine's home; absolute paths normalize; relative ones resolve inside `cwd`. */
function resolveReadPath(cwd: string | null, target: string): { abs: string } | { error: string; code: IpcErrorCode } {
	const raw = target.startsWith("~/") ? path.join(os.homedir(), target.slice(2)) : target;
	if (path.isAbsolute(raw)) return { abs: path.normalize(raw) };
	if (!cwd) return { error: "No workspace", code: "no_workspace" };
	const within = resolveWithin(cwd, raw);
	return within ? { abs: within } : { error: "Path escapes the workspace", code: "path_escapes_workspace" };
}

/**
 * The workspace tree under `rootAbs` (gitignore-aware, depth- and file-capped). `fileCaps` is the production
 * pair; a test passes small ones so the caps are proven on a dozen files instead of thousands.
 */
export async function listWorkspace(
	rootAbs: string | null,
	payload: Omit<IpcFsListPayload, "tabId">,
	fileCaps: FsListFileCaps = FS_LIST_FILE_CAPS,
): Promise<IpcFsListResult> {
	if (!rootAbs) return { ok: false, entries: [], truncated: false, error: "No workspace", code: "no_workspace" };
	const prefix = (typeof payload?.path === "string" ? payload.path : "")
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.replace(/^\/+|\/+$/g, "");
	const dirAbs = resolveWithin(rootAbs, prefix);
	if (!dirAbs) {
		return {
			ok: false,
			entries: [],
			truncated: false,
			error: "Path escapes the workspace",
			code: "path_escapes_workspace",
		};
	}
	const state: WalkState = {
		rules: await loadIgnoreRules(rootAbs),
		maxDepth: clampInt(payload?.maxDepth, 1, FS_LIST_MAX_DEPTH, FS_LIST_DEFAULT_DEPTH),
		maxFiles: clampInt(payload?.maxEntries, 1, fileCaps.max, fileCaps.default),
		fileCount: 0,
		truncated: false,
	};
	try {
		const stat = await fsp.stat(dirAbs);
		if (!stat.isDirectory()) {
			return { ok: false, entries: [], truncated: false, error: "Not a directory", code: "not_a_directory" };
		}
		const entries = await walkWorkspace(dirAbs, prefix, state);
		return { ok: true, entries, truncated: state.truncated };
	} catch (err) {
		return {
			ok: false,
			entries: [],
			truncated: state.truncated,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/** A text file with a byte cap; binary (NUL in the read region) comes back empty. */
export async function readWorkspaceFile(
	cwd: string | null,
	payload: Omit<IpcFsReadPayload, "tabId">,
): Promise<IpcFsReadResult> {
	const fail = (error: string, code?: IpcErrorCode): IpcFsReadResult => ({
		ok: false,
		content: "",
		truncated: false,
		binary: false,
		size: 0,
		error,
		...(code ? { code } : {}),
	});
	if (typeof payload?.path !== "string" || payload.path.length === 0) return fail("Invalid path", "invalid_path");
	const target = resolveReadPath(cwd, payload.path);
	if ("error" in target) return fail(target.error, target.code);
	const maxBytes = clampInt(payload.maxBytes, 1, FS_READ_MAX_BYTES_CAP, FS_READ_DEFAULT_MAX_BYTES);
	try {
		const stat = await fsp.stat(target.abs);
		if (!stat.isFile()) return fail("Not a file", "not_a_file");
		const handle = await fsp.open(target.abs, "r");
		try {
			const length = Math.min(stat.size, maxBytes + 1);
			const buffer = Buffer.alloc(length);
			const { bytesRead } = await handle.read(buffer, 0, length, 0);
			const slice = buffer.subarray(0, bytesRead);
			if (slice.includes(0)) {
				return { ok: true, content: "", truncated: false, binary: true, size: stat.size };
			}
			return {
				ok: true,
				content: slice.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf8"),
				truncated: stat.size > maxBytes,
				binary: false,
				size: stat.size,
			};
		} finally {
			await handle.close();
		}
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
}

function hasBytes(header: Uint8Array, offset: number, bytes: readonly number[]): boolean {
	if (header.length < offset + bytes.length) return false;
	return bytes.every((byte, index) => header[offset + index] === byte);
}

function hasAscii(header: Uint8Array, offset: number, text: string): boolean {
	if (header.length < offset + text.length) return false;
	for (let index = 0; index < text.length; index++) {
		if (header[offset + index] !== text.charCodeAt(index)) return false;
	}
	return true;
}

/** The MIME a binary file's leading bytes prove, or null when no known signature matches. */
function sniffMagic(header: Uint8Array): string | null {
	if (hasAscii(header, 0, "%PDF-")) return "application/pdf";
	if (hasBytes(header, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (hasBytes(header, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (hasAscii(header, 0, "GIF87a") || hasAscii(header, 0, "GIF89a")) return "image/gif";
	if (hasAscii(header, 0, "RIFF")) {
		if (hasAscii(header, 8, "WEBP")) return "image/webp";
		if (hasAscii(header, 8, "WAVE")) return "audio/wav";
	}
	// ISO base media (mp4/mov/m4a/avif): `ftyp` box first, major brand after it.
	if (header.length >= 12 && hasAscii(header, 4, "ftyp")) {
		const brand = String.fromCharCode(...header.subarray(8, 12));
		if (brand === "avif" || brand === "avis") return "image/avif";
		if (brand === "qt  ") return "video/quicktime";
		if (brand === "M4A " || brand === "M4B ") return "audio/mp4";
		return "video/mp4";
	}
	// EBML: the DocType element names WebM or Matroska within the first bytes.
	if (hasBytes(header, 0, [0x1a, 0x45, 0xdf, 0xa3])) {
		return String.fromCharCode(...header.subarray(0, 64)).includes("webm") ? "video/webm" : "video/x-matroska";
	}
	if (hasAscii(header, 0, "ID3")) return "audio/mpeg";
	if (hasAscii(header, 0, "OggS")) return "audio/ogg";
	if (hasAscii(header, 0, "fLaC")) return "audio/flac";
	const zipRecord = hasBytes(header, 2, [3, 4]) || hasBytes(header, 2, [5, 6]) || hasBytes(header, 2, [7, 8]);
	if (hasAscii(header, 0, "PK") && zipRecord) return "application/zip";
	if (hasBytes(header, 0, [0x1f, 0x8b])) return "application/gzip";
	if (hasAscii(header, 0, "SQLite format 3\0")) return "application/vnd.sqlite3";
	// BMP: "BM" alone is too weak for arbitrary files; the header's reserved words are zero.
	if (hasAscii(header, 0, "BM") && hasBytes(header, 6, [0, 0, 0, 0])) return "image/bmp";
	// ICO: reserved 0, type 1, and at least one image.
	if (hasBytes(header, 0, [0, 0, 1, 0]) && header.length >= 6 && (header[4] !== 0 || header[5] !== 0)) {
		return "image/x-icon";
	}
	// Bare MPEG audio frame (an mp3 without an ID3 tag): sync bits, a valid version, layer I–III.
	const second = header[1] ?? 0;
	if (header[0] === 0xff && (second & 0xe0) === 0xe0 && (second & 0x18) !== 0x08 && (second & 0x06) !== 0) {
		return "audio/mpeg";
	}
	return null;
}

function sniffImageMime(header: Buffer): string | null {
	const magic = sniffMagic(header);
	if (magic) return magic.startsWith("image/") ? magic : null;
	// SVG is text: only when it actually starts with an XML/SVG prolog. Loaded
	// through <img> it renders in secure static mode (no script execution).
	const text = header.toString("utf8").trimStart().slice(0, 512).toLowerCase();
	if (text.startsWith("<svg") || (text.startsWith("<?xml") && text.includes("<svg"))) return "image/svg+xml";
	return null;
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** Fallback when no signature matches, and the refinement inside a container family. */
const EXTENSION_MIME: Readonly<Record<string, string>> = {
	pdf: "application/pdf",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	bmp: "image/bmp",
	ico: "image/x-icon",
	svg: "image/svg+xml",
	mp4: "video/mp4",
	m4v: "video/mp4",
	mov: "video/quicktime",
	webm: "video/webm",
	mkv: "video/x-matroska",
	ogv: "video/ogg",
	mp3: "audio/mpeg",
	m4a: "audio/mp4",
	aac: "audio/aac",
	wav: "audio/wav",
	ogg: "audio/ogg",
	oga: "audio/ogg",
	opus: "audio/ogg",
	weba: "audio/webm",
	flac: "audio/flac",
	docx: DOCX_MIME,
	xlsx: XLSX_MIME,
	pptx: PPTX_MIME,
	zip: "application/zip",
	gz: "application/gzip",
	tgz: "application/gzip",
	tar: "application/x-tar",
	"7z": "application/x-7z-compressed",
	sqlite: "application/vnd.sqlite3",
	sqlite3: "application/vnd.sqlite3",
	wasm: "application/wasm",
};

/**
 * Signatures that cannot tell the members of a family apart (OOXML is a zip;
 * an mp4/ogg/webm container may hold only audio): the extension picks the member.
 */
const FAMILY_BY_EXTENSION: Readonly<Record<string, readonly string[]>> = {
	"application/zip": [DOCX_MIME, XLSX_MIME, PPTX_MIME],
	"video/mp4": ["audio/mp4"],
	"audio/ogg": ["video/ogg"],
	"video/webm": ["audio/webm"],
};

/** A file's MIME: magic numbers first, then the extension, else application/octet-stream. */
export function sniffMime(header: Uint8Array, filePath: string): string {
	const byExtension = EXTENSION_MIME[path.extname(filePath).slice(1).toLowerCase()];
	const magic = sniffMagic(header);
	if (magic) return byExtension && FAMILY_BY_EXTENSION[magic]?.includes(byExtension) ? byExtension : magic;
	return byExtension ?? OCTET_STREAM;
}

/** Fill `buffer` from the start of the file; fewer bytes only when the file is shorter. */
async function readInto(handle: FileHandle, buffer: Uint8Array): Promise<number> {
	let offset = 0;
	while (offset < buffer.length) {
		const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
		if (bytesRead === 0) break;
		offset += bytesRead;
	}
	return offset;
}

/**
 * File viewer read: the bytes of any file with a sniffed MIME, resolved like
 * `readWorkspaceFile`. A whole file up to `capBytes` (local 100 MB, a paired
 * host's 11 MB); over the cap it fails `file_too_large` with the size and MIME
 * set. An explicit `maxBytes` below the cap asks for a prefix instead (the hex
 * view): a bigger file comes back `truncated` with that many bytes.
 */
export async function readWorkspaceBinary(
	cwd: string | null,
	payload: Omit<IpcFsReadBinaryPayload, "tabId">,
	capBytes: number = FS_BINARY_LOCAL_MAX_BYTES,
): Promise<IpcFsReadBinaryResult> {
	const fail = (error: string, code?: IpcErrorCode, size = 0, mime = OCTET_STREAM): IpcFsReadBinaryResult => ({
		ok: false,
		data: new Uint8Array(0),
		mime,
		size,
		truncated: false,
		error,
		...(code ? { code } : {}),
	});
	if (typeof payload?.path !== "string" || payload.path.length === 0) return fail("Invalid path", "invalid_path");
	const target = resolveReadPath(cwd, payload.path);
	if ("error" in target) return fail(target.error, target.code);
	const prefix =
		typeof payload.maxBytes === "number" && payload.maxBytes < capBytes
			? clampInt(payload.maxBytes, 1, capBytes, capBytes)
			: null;
	try {
		const stat = await fsp.stat(target.abs);
		if (!stat.isFile()) return fail("Not a file", "not_a_file");
		const handle = await fsp.open(target.abs, "r");
		try {
			if (prefix === null && stat.size > capBytes) {
				const header = new Uint8Array(Math.min(stat.size, SNIFF_HEADER_BYTES));
				const read = await readInto(handle, header);
				const mime = sniffMime(header.subarray(0, read), target.abs);
				return fail(`File is ${stat.size} bytes, over the ${capBytes}-byte cap`, "file_too_large", stat.size, mime);
			}
			const length = prefix === null ? stat.size : Math.min(stat.size, prefix);
			const buffer = new Uint8Array(length);
			const read = await readInto(handle, buffer);
			// A file that shrank since the stat: hand over an exact-size copy, not a view of the larger buffer.
			const data = read === length ? buffer : buffer.slice(0, read);
			return {
				ok: true,
				data,
				mime: sniffMime(data.subarray(0, SNIFF_HEADER_BYTES), target.abs),
				size: stat.size,
				truncated: stat.size > length,
			};
		} finally {
			await handle.close();
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const missing = err instanceof Error && "code" in err && err.code === "ENOENT";
		return fail(message, missing ? "file_not_found" : undefined);
	}
}

export interface WorkspaceRangePayload {
	path: string;
	offset: number;
	length: number;
}

/**
 * One slice of a file for a download in parts (`host.fs.readRange`): resolved and confined like
 * `readWorkspaceBinary`. `length` is clamped to `capBytes` (never above HOST_DOWNLOAD_PART_BYTES); an `offset` at or
 * past the end answers empty data with the file's size. `truncated` says bytes remain past this slice; `mime` is
 * sniffed from the file's start only when the slice holds it, else from the extension.
 */
export async function readWorkspaceRange(
	cwd: string | null,
	payload: WorkspaceRangePayload,
	capBytes: number = HOST_DOWNLOAD_PART_BYTES,
): Promise<IpcFsReadBinaryResult> {
	const fail = (error: string, code?: IpcErrorCode): IpcFsReadBinaryResult => ({
		ok: false,
		data: new Uint8Array(0),
		mime: OCTET_STREAM,
		size: 0,
		truncated: false,
		error,
		...(code ? { code } : {}),
	});
	if (typeof payload?.path !== "string" || payload.path.length === 0) return fail("Invalid path", "invalid_path");
	if (!Number.isSafeInteger(payload.offset) || payload.offset < 0) return fail("Invalid offset", "invalid_path");
	const target = resolveReadPath(cwd, payload.path);
	if ("error" in target) return fail(target.error, target.code);
	const length = clampInt(payload.length, 0, Math.min(capBytes, HOST_DOWNLOAD_PART_BYTES), 0);
	try {
		const stat = await fsp.stat(target.abs);
		if (!stat.isFile()) return fail("Not a file", "not_a_file");
		const want = Math.max(0, Math.min(length, stat.size - payload.offset));
		const buffer = new Uint8Array(want);
		const handle = await fsp.open(target.abs, "r");
		let read = 0;
		try {
			while (read < want) {
				const { bytesRead } = await handle.read(buffer, read, want - read, payload.offset + read);
				if (bytesRead === 0) break;
				read += bytesRead;
			}
		} finally {
			await handle.close();
		}
		// A file that shrank since the stat: an exact-size copy, not a view of the larger buffer.
		const data = read === want ? buffer : buffer.slice(0, read);
		return {
			ok: true,
			data,
			mime: sniffMime(payload.offset === 0 ? data.subarray(0, SNIFF_HEADER_BYTES) : new Uint8Array(0), target.abs),
			size: stat.size,
			truncated: payload.offset + data.length < stat.size,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const missing = err instanceof Error && "code" in err && err.code === "ENOENT";
		return fail(message, missing ? "file_not_found" : undefined);
	}
}

export type WorkspaceFileResult =
	| { ok: true; abs: string; size: number }
	| { ok: false; error: string; code?: IpcErrorCode };

/** The regular file `target` names, resolved like a read (relative paths confined to `cwd`); a copy of it is saved from `abs`. */
export async function resolveWorkspaceFile(cwd: string | null, target: unknown): Promise<WorkspaceFileResult> {
	if (typeof target !== "string" || target.length === 0)
		return { ok: false, error: "Invalid path", code: "invalid_path" };
	const resolved = resolveReadPath(cwd, target);
	if ("error" in resolved) return { ok: false, error: resolved.error, code: resolved.code };
	try {
		const stat = await fsp.stat(resolved.abs);
		if (!stat.isFile()) return { ok: false, error: "Not a file", code: "not_a_file" };
		return { ok: true, abs: resolved.abs, size: stat.size };
	} catch (err) {
		const missing = err instanceof Error && "code" in err && err.code === "ENOENT";
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
			...(missing ? { code: "file_not_found" as const } : {}),
		};
	}
}

export type WorkspaceMediaResult =
	| { ok: true; abs: string; mime: string; size: number }
	| { ok: false; error: string; code?: IpcErrorCode };

/**
 * The file an audio/video stream serves: resolved like `readWorkspaceBinary`
 * (relative paths confined to `cwd`, absolute and `~/` paths as the viewer
 * reads them), a regular file, and sniffed as audio or video — a stream never
 * hands out any other kind of file.
 */
export async function resolveWorkspaceMedia(cwd: string | null, target: unknown): Promise<WorkspaceMediaResult> {
	if (typeof target !== "string" || target.length === 0)
		return { ok: false, error: "Invalid path", code: "invalid_path" };
	const resolved = resolveReadPath(cwd, target);
	if ("error" in resolved) return { ok: false, error: resolved.error, code: resolved.code };
	try {
		const stat = await fsp.stat(resolved.abs);
		if (!stat.isFile()) return { ok: false, error: "Not a file", code: "not_a_file" };
		const handle = await fsp.open(resolved.abs, "r");
		let mime: string;
		try {
			const header = new Uint8Array(Math.min(stat.size, SNIFF_HEADER_BYTES));
			const read = await readInto(handle, header);
			mime = sniffMime(header.subarray(0, read), resolved.abs);
		} finally {
			await handle.close();
		}
		if (!/^(?:audio|video)\//.test(mime))
			return { ok: false, error: `Not audio or video (${mime})`, code: "unsupported" };
		return { ok: true, abs: resolved.abs, mime, size: stat.size };
	} catch (err) {
		const missing = err instanceof Error && "code" in err && err.code === "ENOENT";
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
			...(missing ? { code: "file_not_found" as const } : {}),
		};
	}
}

/**
 * Markdown-image read: model output references images by path (`![alt](…)`)
 * and the renderer turns them into data URLs for <img>. Relative paths stay
 * workspace-confined; absolute paths and `~` are readable because the bytes
 * never leave the <img> (no exfil channel), but the file must sniff as a real
 * image type and fit under a size cap.
 */
export async function readWorkspaceImage(
	cwd: string | null,
	payload: Omit<IpcFsReadImagePayload, "tabId">,
): Promise<IpcFsReadImageResult> {
	const fail = (error: string, code?: IpcErrorCode): IpcFsReadImageResult => ({
		ok: false,
		dataUrl: null,
		mime: null,
		size: 0,
		error,
		...(code ? { code } : {}),
	});
	if (typeof payload?.path !== "string" || payload.path.length === 0) return fail("Invalid path", "invalid_path");
	const target = resolveReadPath(cwd, payload.path);
	if ("error" in target) return fail(target.error, target.code);
	try {
		const stat = await fsp.stat(target.abs);
		if (!stat.isFile()) return fail("Not a file", "not_a_file");
		if (stat.size > FS_IMAGE_MAX_BYTES) return fail("Image too large", "image_too_large");
		const handle = await fsp.open(target.abs, "r");
		try {
			const header = Buffer.alloc(512);
			const { bytesRead } = await handle.read(header, 0, 512, 0);
			const mime = sniffImageMime(header.subarray(0, bytesRead));
			if (!mime) return fail("Not a supported image", "unsupported_image");
			const body = Buffer.alloc(stat.size);
			await handle.read(body, 0, stat.size, 0);
			return { ok: true, dataUrl: `data:${mime};base64,${body.toString("base64")}`, mime, size: stat.size };
		} finally {
			await handle.close();
		}
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
}

/**
 * Plan-mode document read — deliberately OFF the RPC bus: reading via the
 * bash RPC injected the plan into the model context and appended
 * bashExecution entries to the transcript on every poll. Reads the
 * configured path, else the newest `*plan.md` in the session-local root.
 * Confined to the workspace and the sessions dir (plan artifacts live there).
 */
export async function readPlanFile(
	cwd: string | null,
	sessionsDir: string,
	payload: Omit<IpcFsReadPlanPayload, "tabId">,
): Promise<IpcFsReadPlanResult> {
	const fail = (error: string, code?: IpcErrorCode): IpcFsReadPlanResult => ({
		ok: false,
		path: null,
		content: null,
		error,
		...(code ? { code } : {}),
	});
	if (typeof payload?.fsPath !== "string" || payload.fsPath.length === 0) return fail("Invalid path", "invalid_path");
	if (!cwd) return fail("No workspace", "no_workspace");
	const withinAllowedRoots = (value: string): string | null =>
		resolveWithin(cwd, value) ?? resolveWithin(sessionsDir, value);
	const target = withinAllowedRoots(payload.fsPath);
	if (!target) return fail("Path escapes allowed roots", "path_escapes_roots");
	let localRoot: string | null = null;
	if (typeof payload.localRoot === "string" && payload.localRoot.length > 0) {
		localRoot = withinAllowedRoots(payload.localRoot);
		if (!localRoot) return fail("Path escapes allowed roots", "path_escapes_roots");
	}
	try {
		const picked = (await statFile(target)) ?? (localRoot ? await newestPlanFile(localRoot) : null);
		if (!picked) return { ok: true, path: null, content: null };
		return { ok: true, path: picked, content: await fsp.readFile(picked, "utf8") };
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
}

/**
 * One directory level for a folder picker: the subdirectories of `target`
 * (this machine's home when omitted), hidden ones skipped, only those whose
 * name contains `query` (case-insensitive) when one is given. At most
 * LIST_DIRS_MAX_ENTRIES come back, `truncated` when more matched. Throws a coded
 * error (`not_absolute_path`, `not_a_directory`, `file_not_found`) for a bad target.
 */
export async function listDirectories(target: string | undefined, query?: string): Promise<RemoteDirListing> {
	const dir = target === undefined || target === "" ? os.homedir() : target;
	if (!path.isAbsolute(dir)) throw codedError("not_absolute_path", "Not an absolute path");
	const abs = path.resolve(dir);
	let dirents: Dirent[];
	try {
		dirents = await fsp.readdir(abs, { withFileTypes: true });
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOTDIR") throw codedError("not_a_directory", "Not a directory");
		if (code === "ENOENT") throw codedError("file_not_found", "Directory not found");
		throw err;
	}
	const needle = query?.trim().toLocaleLowerCase() ?? "";
	const names = dirents
		.filter(
			dirent =>
				dirent.isDirectory() &&
				!dirent.name.startsWith(".") &&
				(needle === "" || dirent.name.toLocaleLowerCase().includes(needle)),
		)
		.map(dirent => dirent.name)
		.sort(NAME_ORDER.compare);
	const entries = names.slice(0, LIST_DIRS_MAX_ENTRIES).map(name => ({ name, path: path.join(abs, name) }));
	const parent = path.dirname(abs);
	return { path: abs, parent: parent === abs ? null : parent, entries, truncated: names.length > entries.length };
}

/** The file's mtime and size, for the viewer's disk watch; a missing path is `file_not_found`. */
export async function statWorkspacePath(cwd: string | null, target: unknown): Promise<IpcFsStatResult> {
	const fail = (error: string, code?: IpcErrorCode): IpcFsStatResult => ({
		ok: false,
		mtimeMs: 0,
		size: 0,
		error,
		...(code ? { code } : {}),
	});
	if (typeof target !== "string" || target.length === 0) return fail("Invalid path", "invalid_path");
	const resolved = resolveReadPath(cwd, target);
	if ("error" in resolved) return fail(resolved.error, resolved.code);
	try {
		const stat = await fsp.stat(resolved.abs);
		return { ok: true, mtimeMs: stat.mtimeMs, size: stat.size, directory: stat.isDirectory() };
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), fsErrorCode(err));
	}
}

function fsErrorCode(err: unknown): IpcErrorCode | undefined {
	const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
	if (code === "ENOENT") return "file_not_found";
	if (code === "EEXIST" || code === "ENOTEMPTY") return "exists";
	return undefined;
}

/** One path segment a user typed: no separators, no `.`/`..`, no control characters. */
function validEntryName(name: unknown): name is string {
	return (
		typeof name === "string" &&
		name.trim() === name &&
		name.length > 0 &&
		name.length <= 255 &&
		name !== "." &&
		name !== ".." &&
		!/[\\/]|\p{Cc}/u.test(name)
	);
}

/** The wire shape of `IpcFsMutation`; anything else from a renderer or a peer is refused. */
const FsMutationSchema: z.ZodType<IpcFsMutation> = z.discriminatedUnion("op", [
	z.object({ op: z.enum(["createFile", "createFolder"]), parent: z.string(), name: z.string() }),
	z.object({ op: z.literal("rename"), path: z.string(), name: z.string() }),
	z.object({ op: z.literal("trash"), path: z.string() }),
	z.object({
		op: z.literal("write"),
		path: z.string(),
		content: z.string(),
		expectedMtimeMs: z.number(),
		force: z.boolean().optional(),
	}),
]);

/**
 * The Files panel's writes inside `root`: create an empty file or a folder in `parent`, rename an entry in place,
 * hand it to `trash` (the OS trash, never a hard delete), or `write` an existing text file the viewer edited.
 * An existing target is `exists`, never overwritten; a write whose file changed since the editor loaded it is
 * `changed_on_disk` unless forced. `path` in the result is the new workspace-relative POSIX path.
 */
export async function mutateWorkspace(
	root: string | null,
	request: unknown,
	trash: (abs: string) => Promise<void>,
): Promise<IpcFsMutateResult> {
	const fail = (error: string, code?: IpcErrorCode): IpcFsMutateResult => ({
		ok: false,
		error,
		...(code ? { code } : {}),
	});
	if (!root) return fail("No workspace", "no_workspace");
	const parsed = FsMutationSchema.safeParse(request);
	if (!parsed.success) return fail("Invalid file operation", "invalid_path");
	const mutation = parsed.data;
	const relative = (abs: string) => path.relative(root, abs).split(path.sep).join("/");
	const inside = (rel: unknown) =>
		typeof rel === "string" ? resolveWithin(root, rel.replace(/\\/g, "/").replace(/^\.\//, "")) : null;
	const exists = (abs: string) =>
		fsp.lstat(abs).then(
			() => true,
			() => false,
		);
	try {
		if ("parent" in mutation) {
			if (!validEntryName(mutation.name)) return fail("Invalid name", "invalid_name");
			const dir = inside(mutation.parent);
			if (!dir) return fail("Path escapes the workspace", "path_escapes_workspace");
			if (!(await fsp.stat(dir)).isDirectory()) return fail("Not a directory", "not_a_directory");
			const abs = path.join(dir, mutation.name);
			if (mutation.op === "createFile") await fsp.writeFile(abs, "", { flag: "wx" });
			else await fsp.mkdir(abs);
			return { ok: true, path: relative(abs) };
		}
		const source = inside(mutation.path);
		if (!source) return fail("Path escapes the workspace", "path_escapes_workspace");
		if (source === root) return fail("The project folder itself can't change here", "invalid_path");
		if (!(await exists(source))) return fail("File not found", "file_not_found");
		if (mutation.op === "trash") {
			await trash(source);
			return { ok: true, path: relative(source) };
		}
		if (mutation.op === "write") {
			// Through a symlink only when its target is inside the project too.
			const [realRoot, realSource] = await Promise.all([fsp.realpath(root), fsp.realpath(source)]);
			if (realSource !== realRoot && !realSource.startsWith(realRoot + path.sep)) {
				return fail("Path escapes the workspace", "path_escapes_workspace");
			}
			const before = await fsp.stat(realSource);
			if (!before.isFile()) return fail("Not a file", "not_a_file");
			if (Buffer.byteLength(mutation.content, "utf8") > FS_WRITE_MAX_BYTES) {
				return fail("The file is too large to save here", "file_too_large");
			}
			if (!mutation.force && before.mtimeMs !== mutation.expectedMtimeMs) {
				return fail("The file changed on disk since it was opened", "changed_on_disk");
			}
			// In place, so the file keeps its mode, owner, links and any open handles.
			await fsp.writeFile(realSource, mutation.content, "utf8");
			return { ok: true, path: relative(source), mtimeMs: (await fsp.stat(realSource)).mtimeMs };
		}
		if (!validEntryName(mutation.name)) return fail("Invalid name", "invalid_name");
		const target = path.join(path.dirname(source), mutation.name);
		if (target === source) return { ok: true, path: relative(source) };
		// A case-only rename finds the source itself on a case-insensitive disk; anything else there is taken.
		if (await exists(target)) {
			const [from, to] = await Promise.all([fsp.lstat(source), fsp.lstat(target)]);
			if (from.ino !== to.ino || from.dev !== to.dev) return fail("A file with that name already exists", "exists");
		}
		await fsp.rename(source, target);
		return { ok: true, path: relative(target) };
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), fsErrorCode(err));
	}
}
