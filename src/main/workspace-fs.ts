/**
 * Workspace filesystem behind fs:list / fs:read / fs:read-image / fs:read-binary / fs:read-plan / fs:stat, plus the
 * Files panel's few writes (fs:mutate: new file or folder, rename, write, move to the trash), rooted at a tab's cwd.
 * Shared by the local IPC handlers and by the remote host (src/main/remote/host-services.ts), which serves the same
 * calls for a paired device's tabs with the same confinement and caps. Never throws (`listDirectories` aside): every
 * failure is an `ok: false` result with a stable code.
 *
 * The disk work runs in the core process (`native/ompdesk/crates/core/src/fs`, methods `fs.*`). What stays here: each
 * call's argument checks and its path resolution with node's `path` rules (`resolveWithin`, which other modules call
 * synchronously; the core only ever gets absolute paths main produced), the MIME sniffing (`sniffMime`, synchronous
 * for its callers too) over the bytes the core sends, and the trash, which needs Electron.
 */
import os from "node:os";
import path from "node:path";
import { codedError, type IpcErrorCode, isIpcErrorCode } from "../shared/ipc-error-codes";
import type {
	FsTreeEntry,
	IpcFsListPayload,
	IpcFsListResult,
	IpcFsMutateResult,
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
import { CoreError, core } from "./core/process";

/** Files one listing returns: `default` without a `maxEntries`, never more than `max`. */
interface FsListFileCaps {
	default: number;
	max: number;
}
const FS_LIST_FILE_CAPS: FsListFileCaps = { default: 2000, max: FS_LIST_MAX_ENTRIES };
/** File viewer reads on this device: whole files up to this size. */
export const FS_BINARY_LOCAL_MAX_BYTES = 100 * 1024 * 1024;
/** A paired host's reply travels base64 (+33%) in one 16 MiB frame (remote/wire.ts). */
export const FS_BINARY_REMOTE_MAX_BYTES = 11 * 1024 * 1024;
/** Bytes read for magic-number sniffing (SVG's text check needs a few hundred). */
const SNIFF_HEADER_BYTES = 512;
const OCTET_STREAM = "application/octet-stream";
/** The name order's locale: what `new Intl.Collator()` resolves, which the core's ICU collation then uses. */
const NAME_LOCALE = new Intl.Collator().resolvedOptions().locale;

/** Resolve `rel` against `root`, refusing escapes outside the workspace. */
export function resolveWithin(root: string, rel: string): string | null {
	const resolved = path.resolve(root, rel);
	const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
	if (resolved !== root && !resolved.startsWith(rootWithSep)) return null;
	return resolved;
}

/** `~/` expands to this machine's home; absolute paths normalize; relative ones resolve inside `cwd`. */
function resolveReadPath(cwd: string | null, target: string): { abs: string } | { error: string; code: IpcErrorCode } {
	const raw = target.startsWith("~/") ? path.join(os.homedir(), target.slice(2)) : target;
	if (path.isAbsolute(raw)) return { abs: path.normalize(raw) };
	if (!cwd) return { error: "No workspace", code: "no_workspace" };
	const within = resolveWithin(cwd, raw);
	return within ? { abs: within } : { error: "Path escapes the workspace", code: "path_escapes_workspace" };
}

type Asked<T> = { ok: true; result: T; bin: Uint8Array } | { ok: false; error: string; code?: IpcErrorCode };

/** One core call as the functions here report it: the app's code when the failure has one, and its message. */
async function ask<T>(method: string, params: unknown, bin?: Uint8Array): Promise<Asked<T>> {
	try {
		const answer = await core().call<T>(method, params, bin ? { bin } : {});
		return { ok: true, result: answer.result, bin: answer.bin ?? new Uint8Array(0) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return error instanceof CoreError && isIpcErrorCode(error.code)
			? { ok: false, error: message, code: error.code }
			: { ok: false, error: message };
	}
}

interface CoreStat {
	file: boolean;
	directory: boolean;
	size: number;
	mtimeMs: number;
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
	const fail = (error: string, code?: IpcErrorCode): IpcFsListResult => ({
		ok: false,
		entries: [],
		truncated: false,
		error,
		...(code ? { code } : {}),
	});
	if (!rootAbs) return fail("No workspace", "no_workspace");
	const prefix = (typeof payload?.path === "string" ? payload.path : "")
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.replace(/^\/+|\/+$/g, "");
	const dirAbs = resolveWithin(rootAbs, prefix);
	if (!dirAbs) return fail("Path escapes the workspace", "path_escapes_workspace");
	const listed = await ask<{ entries: FsTreeEntry[]; truncated: boolean }>("fs.list", {
		root: rootAbs,
		dir: dirAbs,
		prefix,
		maxDepth: payload?.maxDepth,
		maxEntries: payload?.maxEntries,
		caps: fileCaps,
		locale: NAME_LOCALE,
	});
	if (!listed.ok) return fail(listed.error, listed.code);
	return { ok: true, entries: listed.result.entries, truncated: listed.result.truncated };
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
	const read = await ask<{ content: string; truncated: boolean; binary: boolean; size: number }>("fs.readText", {
		path: target.abs,
		maxBytes: payload.maxBytes,
	});
	if (!read.ok) return fail(read.error, read.code);
	return { ok: true, ...read.result };
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
	const read = await ask<{ size: number; truncated: boolean; tooLarge: boolean }>("fs.readBinary", {
		path: target.abs,
		maxBytes: payload.maxBytes,
		cap: capBytes,
		head: SNIFF_HEADER_BYTES,
	});
	if (!read.ok) return fail(read.error, read.code);
	const { size, truncated, tooLarge } = read.result;
	if (tooLarge)
		return fail(
			`File is ${size} bytes, over the ${capBytes}-byte cap`,
			"file_too_large",
			size,
			sniffMime(read.bin, target.abs),
		);
	return {
		ok: true,
		data: read.bin,
		mime: sniffMime(read.bin.subarray(0, SNIFF_HEADER_BYTES), target.abs),
		size,
		truncated,
	};
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
	const read = await ask<{ size: number; truncated: boolean }>("fs.readRange", {
		path: target.abs,
		offset: payload.offset,
		length: payload.length,
		cap: Math.min(capBytes, HOST_DOWNLOAD_PART_BYTES),
	});
	if (!read.ok) return fail(read.error, read.code);
	return {
		ok: true,
		data: read.bin,
		mime: sniffMime(payload.offset === 0 ? read.bin.subarray(0, SNIFF_HEADER_BYTES) : new Uint8Array(0), target.abs),
		size: read.result.size,
		truncated: read.result.truncated,
	};
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
	const stat = await ask<CoreStat>("fs.stat", { path: resolved.abs });
	if (!stat.ok) return stat;
	if (!stat.result.file) return { ok: false, error: "Not a file", code: "not_a_file" };
	return { ok: true, abs: resolved.abs, size: stat.result.size };
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
	const head = await ask<{ size: number }>("fs.resolveMedia", { path: resolved.abs, head: SNIFF_HEADER_BYTES });
	if (!head.ok) return head;
	const mime = sniffMime(head.bin, resolved.abs);
	if (!/^(?:audio|video)\//.test(mime))
		return { ok: false, error: `Not audio or video (${mime})`, code: "unsupported" };
	return { ok: true, abs: resolved.abs, mime, size: head.result.size };
}

/**
 * Markdown-image read: model output references images by path (`![alt](…)`)
 * and the renderer turns them into data URLs for <img>. Relative paths stay
 * workspace-confined; absolute paths and `~` are readable because the bytes
 * never leave the <img> (no exfil channel), but the file must sniff as a real
 * image type and fit under a size cap. With `known` (a paired device's copy) a
 * file that still has that mtime and size answers `unchanged`, without bytes.
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
	const read = await ask<{ size: number; mtimeMs: number; unchanged?: boolean }>("fs.readImage", {
		path: target.abs,
		known: payload.known,
	});
	if (!read.ok) return fail(read.error, read.code);
	const { size, mtimeMs, unchanged } = read.result;
	if (unchanged) return { ok: true, dataUrl: null, mime: null, size, mtimeMs, unchanged: true };
	const body = Buffer.from(read.bin.buffer, read.bin.byteOffset, read.bin.byteLength);
	const mime = sniffImageMime(body.subarray(0, SNIFF_HEADER_BYTES));
	if (!mime) return fail("Not a supported image", "unsupported_image");
	return { ok: true, dataUrl: `data:${mime};base64,${body.toString("base64")}`, mime, size, mtimeMs };
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
	const plan = await ask<{ content: string | null; fallback: string | null }>("fs.readPlan", { target, localRoot });
	if (!plan.ok) return fail(plan.error, plan.code);
	const { content, fallback } = plan.result;
	if (content === null) return { ok: true, path: null, content: null };
	return { ok: true, path: fallback !== null && localRoot ? path.join(localRoot, fallback) : target, content };
}

/**
 * One directory level for a folder picker: the subdirectories of `target`
 * (this machine's home when omitted), hidden ones skipped, only those whose
 * name contains `query` (case-insensitive) when one is given. At most
 * 2000 come back, `truncated` when more matched. Throws a coded
 * error (`not_absolute_path`, `not_a_directory`, `file_not_found`) for a bad target.
 */
export async function listDirectories(target: string | undefined, query?: string): Promise<RemoteDirListing> {
	const dir = target === undefined || target === "" ? os.homedir() : target;
	if (!path.isAbsolute(dir)) throw codedError("not_absolute_path", "Not an absolute path");
	const abs = path.resolve(dir);
	let listed: { names: string[]; truncated: boolean };
	try {
		listed = (await core().call<typeof listed>("fs.listDirs", { dir: abs, query, locale: NAME_LOCALE })).result;
	} catch (error) {
		if (error instanceof CoreError && (error.code === "not_a_directory" || error.code === "file_not_found"))
			throw codedError(error.code, error.message);
		throw error instanceof CoreError && error.code === "io" ? new Error(error.message) : error;
	}
	const entries = listed.names.map(name => ({ name, path: path.join(abs, name) }));
	const parent = path.dirname(abs);
	return { path: abs, parent: parent === abs ? null : parent, entries, truncated: listed.truncated };
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
	const stat = await ask<CoreStat>("fs.stat", { path: resolved.abs });
	if (!stat.ok) return fail(stat.error, stat.code);
	return { ok: true, mtimeMs: stat.result.mtimeMs, size: stat.result.size, directory: stat.result.directory };
}

/**
 * The Files panel's writes inside `root`: create an empty file or a folder in `parent`, rename an entry in place,
 * hand it to `trash` (the OS trash, never a hard delete), or `write` an existing text file the viewer edited.
 * An existing target is `exists`, never overwritten; a write whose file changed since the editor loaded it is
 * `changed_on_disk` unless forced. `path` in the result is the new workspace-relative POSIX path. The core validates
 * the request and does the work; here the request's path is resolved (it gets `resolved`, null for an escape) and a
 * `trash` answer, on the path the core just checked, goes to `trash`.
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
	const fields =
		typeof request === "object" && request !== null && !Array.isArray(request)
			? (request as Record<string, unknown>)
			: null;
	const rel = fields?.op === "createFile" || fields?.op === "createFolder" ? fields.parent : fields?.path;
	const resolved = typeof rel === "string" ? resolveWithin(root, rel.replace(/\\/g, "/").replace(/^\.\//, "")) : null;
	// A write's text goes as the frame's bytes, encoded as node writes it.
	const content =
		fields?.op === "write" && typeof fields.content === "string" ? Buffer.from(fields.content, "utf8") : undefined;
	const done = await ask<{ abs: string; trash?: boolean; mtimeMs?: number }>(
		"fs.mutate",
		{
			root,
			request: content ? { ...fields, content: undefined } : request,
			resolved,
			maxWriteBytes: FS_WRITE_MAX_BYTES,
		},
		content,
	);
	if (!done.ok) return fail(done.error, done.code);
	const { abs, mtimeMs } = done.result;
	if (done.result.trash) {
		try {
			await trash(abs);
		} catch (err) {
			return fail(err instanceof Error ? err.message : String(err));
		}
	}
	const relative = path.relative(root, abs).split(path.sep).join("/");
	return mtimeMs === undefined ? { ok: true, path: relative } : { ok: true, path: relative, mtimeMs };
}
