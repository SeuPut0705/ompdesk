/**
 * Workspace filesystem reads behind fs:list / fs:read / fs:read-image /
 * fs:read-plan — node:fs based, no sidecar session required, cross-platform,
 * rooted at a tab's cwd. Shared by the local IPC handlers and by the remote
 * host (src/main/remote/host-services.ts), which serves the same reads for a
 * paired device's tabs with the same confinement and caps. Never throws: every
 * failure is an `ok: false` result with a stable code.
 */
import { type Dirent, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { codedError, type IpcErrorCode } from "../shared/ipc-error-codes";
import type {
	FsTreeEntry,
	IpcFsListPayload,
	IpcFsListResult,
	IpcFsReadImagePayload,
	IpcFsReadImageResult,
	IpcFsReadPayload,
	IpcFsReadPlanPayload,
	IpcFsReadPlanResult,
	IpcFsReadResult,
	RemoteDirListing,
} from "../shared/ipc-types";

const FS_LIST_DEFAULT_DEPTH = 8;
const FS_LIST_MAX_DEPTH = 16;
const FS_LIST_DEFAULT_MAX_FILES = 2000;
const FS_LIST_MAX_FILES_CAP = 20_000;
const FS_READ_DEFAULT_MAX_BYTES = 200_000;
const FS_READ_MAX_BYTES_CAP = 2_000_000;
/** Markdown images become data URLs in the renderer; bound the bytes. */
const FS_IMAGE_MAX_BYTES = 25_000_000;
/** Remote folder picker: one level, bounded so a huge directory cannot flood the link. */
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

/** Recursive readdir → sorted tree (dirs first, then files, each alphabetical). */
async function walkWorkspace(
	dirAbs: string,
	relPrefix: string,
	depth: number,
	state: WalkState,
): Promise<FsTreeEntry[]> {
	let dirents: Dirent[];
	try {
		dirents = await fsp.readdir(dirAbs, { withFileTypes: true });
	} catch {
		return []; // Unreadable directory (permissions) — skip, don't fail the walk.
	}
	const dirs: FsTreeEntry[] = [];
	const files: FsTreeEntry[] = [];
	const sorted = dirents.filter(dirent => !dirent.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name));
	for (const dirent of sorted) {
		if (state.truncated) break;
		const isDir = dirent.isDirectory();
		if (!isDir && !dirent.isFile()) continue;
		const rel = relPrefix ? `${relPrefix}/${dirent.name}` : dirent.name;
		if (isIgnored(state.rules, rel, isDir)) continue;
		if (isDir) {
			const children =
				depth < state.maxDepth ? await walkWorkspace(path.join(dirAbs, dirent.name), rel, depth + 1, state) : [];
			dirs.push({ name: dirent.name, path: rel, kind: "dir", children });
		} else {
			if (state.fileCount >= state.maxFiles) {
				state.truncated = true;
				break;
			}
			state.fileCount += 1;
			files.push({ name: dirent.name, path: rel, kind: "file" });
		}
	}
	return [...dirs, ...files];
}

/** `~/` expands to this machine's home; absolute paths normalize; relative ones resolve inside `cwd`. */
function resolveReadPath(cwd: string | null, target: string): { abs: string } | { error: string; code: IpcErrorCode } {
	const raw = target.startsWith("~/") ? path.join(os.homedir(), target.slice(2)) : target;
	if (path.isAbsolute(raw)) return { abs: path.normalize(raw) };
	if (!cwd) return { error: "No workspace", code: "no_workspace" };
	const within = resolveWithin(cwd, raw);
	return within ? { abs: within } : { error: "Path escapes the workspace", code: "path_escapes_workspace" };
}

/** The workspace tree under `rootAbs` (gitignore-aware, depth- and file-capped). */
export async function listWorkspace(
	rootAbs: string | null,
	payload: Omit<IpcFsListPayload, "tabId">,
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
		maxFiles: clampInt(payload?.maxEntries, 1, FS_LIST_MAX_FILES_CAP, FS_LIST_DEFAULT_MAX_FILES),
		fileCount: 0,
		truncated: false,
	};
	try {
		const stat = await fsp.stat(dirAbs);
		if (!stat.isDirectory()) {
			return { ok: false, entries: [], truncated: false, error: "Not a directory", code: "not_a_directory" };
		}
		const entries = await walkWorkspace(dirAbs, prefix, 0, state);
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

function sniffImageMime(header: Buffer): string | null {
	if (header.length >= 8 && header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47) {
		return "image/png";
	}
	if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image/jpeg";
	if (header.length >= 6 && header.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
	if (header.length >= 6 && header.subarray(0, 6).toString("ascii") === "GIF87a") return "image/gif";
	if (
		header.length >= 12 &&
		header.subarray(0, 4).toString("ascii") === "RIFF" &&
		header.subarray(8, 12).toString("ascii") === "WEBP"
	) {
		return "image/webp";
	}
	if (header.length >= 12 && header.subarray(4, 8).toString("ascii") === "ftyp") {
		const brand = header.subarray(8, 12).toString("ascii");
		if (brand === "avif" || brand === "avis") return "image/avif";
	}
	if (header.length >= 2 && header[0] === 0x42 && header[1] === 0x4d) return "image/bmp";
	if (header.length >= 4 && header[0] === 0x00 && header[1] === 0x00 && header[2] === 0x01 && header[3] === 0x00) {
		return "image/x-icon";
	}
	// SVG is text: only when it actually starts with an XML/SVG prolog. Loaded
	// through <img> it renders in secure static mode (no script execution).
	const text = header.toString("utf8").trimStart().slice(0, 512).toLowerCase();
	if (text.startsWith("<svg") || (text.startsWith("<?xml") && text.includes("<svg"))) return "image/svg+xml";
	return null;
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
 * (this machine's home when omitted), hidden ones skipped. Throws a coded
 * error (`not_absolute_path`, `not_a_directory`, `file_not_found`) for a bad target.
 */
export async function listDirectories(target: string | undefined): Promise<RemoteDirListing> {
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
	const entries = dirents
		.filter(dirent => dirent.isDirectory() && !dirent.name.startsWith("."))
		.map(dirent => dirent.name)
		.sort((a, b) => a.localeCompare(b))
		.slice(0, LIST_DIRS_MAX_ENTRIES)
		.map(name => ({ name, path: path.join(abs, name) }));
	const parent = path.dirname(abs);
	return { path: abs, parent: parent === abs ? null : parent, entries };
}
