/**
 * Input area utilities: file handling and command filtering.
 */

import { FS_LIST_MAX_ENTRIES, type FsTreeEntry } from "../../../../shared/ipc-types";
import { pathMatcher } from "../../../lib/fuzzy-score";
import type { ComposerImage } from "../../../stores/composer";

/** How deep (the tree's own cap) and how many files (every file one walk returns) one `@` listing asks main for. */
export const MENTION_FS_DEPTH = 16;
export const MENTION_FS_MAX_ENTRIES = FS_LIST_MAX_ENTRIES;

/** Cap on completion menu items (the `^` model menu). */
export const MAX_MENU_ITEMS = 8;
/** Cap on the `/` and `$` menus once something is typed; with nothing typed they list every entry. */
export const MAX_LIST_MENU_ITEMS = 20;
/** Cap on fuzzy file results shown above the scheme entries in the @ menu. */
export const MAX_MENTION_FILE_ITEMS = 20;
/** Internal URL schemes always offered in the @ menu, below file results. */
export const MENTION_SCHEMES = ["skill://", "memory://", "artifact://", "issue://", "pr://", "local://plan.md"];

/** Collect workspace-relative file paths from an fs:list tree (files only). */
function flattenFilePaths(entries: FsTreeEntry[], out: string[]): void {
	for (const entry of entries) {
		if (entry.kind === "file") out.push(entry.path);
		else if (entry.children) flattenFilePaths(entry.children, out);
	}
}

/**
 * How long one listing answers the `@` menu: the next `@` after it walks the tree again, so files the
 * agent created since show up.
 */
export const MENTION_FILES_TTL_MS = 30_000;

/**
 * What a walk knows besides its paths. Main walks breadth-first, so when the entry cap cuts the walk it is
 * the deepest files that are missing; `loadDir` reaches them: typing a longer path (`@pkg/api/`) lists that
 * folder on its own, and the menu merges what it finds.
 */
export interface MentionListing {
	/** The walk stopped at its entry cap: some files are not in the list. */
	truncated: boolean;
	/** NFC twin of each path, same order (macOS names may be decomposed, typed Hangul is composed). */
	nfc: string[];
	/** A folder's own listing, once `loadDir` has finished: files the walk missed, and whether it was cut too. */
	dir(dir: string): { extra: string[]; truncated: boolean } | undefined;
	/** List `dir` (workspace-relative) once; the answer is read back with `dir`. Never rejects. */
	loadDir(dir: string): Promise<void>;
}

/** The listing behind a path list `listMentionFiles` answered with (a plain array stays what callers see). */
const mentionListings = new WeakMap<readonly string[], MentionListing>();

export function mentionListingOf(paths: readonly string[]): MentionListing | undefined {
	return mentionListings.get(paths);
}

function describeListing(paths: string[], truncated: boolean, tabId: string | undefined): MentionListing {
	let known: Set<string> | undefined;
	const loaded = new Map<string, { extra: string[]; truncated: boolean }>();
	const pending = new Map<string, Promise<void>>();
	return {
		truncated,
		nfc: paths.map(path => path.normalize("NFC")),
		dir: dir => loaded.get(dir),
		loadDir(dir) {
			const inflight = pending.get(dir);
			if (inflight) return inflight;
			const task = window.omp.fs
				.list(dir, MENTION_FS_DEPTH, MENTION_FS_MAX_ENTRIES, tabId)
				.then(result => {
					const found: string[] = [];
					if (result.ok) flattenFilePaths(result.entries, found);
					known ??= new Set(paths);
					const have = known;
					loaded.set(dir, {
						extra: found.filter(path => !have.has(path)).sort(),
						truncated: !result.ok || !!result.truncated,
					});
				})
				// A failed read is remembered as an incomplete one, so the menu never asks again in a loop.
				.catch(() => void loaded.set(dir, { extra: [], truncated: true }));
			pending.set(dir, task);
			return task;
		},
	};
}

/** @mention file lists, cached per session cwd; inflight dedupes concurrent walks. */
const mentionFileInflight = new Map<string, Promise<string[]>>();
const mentionFileCache = new Map<string, { paths: string[]; at: number }>();

/** The last listing of `cwd`, fresh or not: what the `@` menu shows until the next walk lands. */
export function cachedMentionFiles(cwd: string): string[] | undefined {
	return mentionFileCache.get(cwd)?.paths;
}

/** Forget every listing (tests). */
export function clearMentionFiles(): void {
	mentionFileCache.clear();
	mentionFileInflight.clear();
}

/**
 * The workspace's files for the `@` menu: the cached listing while it is fresh, else one walk. A failed
 * walk is never remembered (the next `@` tries again) and answers with the last good listing, if any.
 * The walk's extra facts (cut off or not, NFC names, folder listings) sit behind {@link mentionListingOf}.
 */
export function listMentionFiles(cwd: string, tabId?: string | null, now = Date.now()): Promise<string[]> {
	const cached = mentionFileCache.get(cwd);
	if (cached && now - cached.at < MENTION_FILES_TTL_MS) return Promise.resolve(cached.paths);
	const inflight = mentionFileInflight.get(cwd);
	if (inflight) return inflight;
	const task = window.omp.fs
		.list(undefined, MENTION_FS_DEPTH, MENTION_FS_MAX_ENTRIES, tabId ?? undefined)
		.then(result => {
			if (!result.ok) return cached?.paths ?? [];
			const paths: string[] = [];
			flattenFilePaths(result.entries, paths);
			paths.sort();
			mentionListings.set(paths, describeListing(paths, result.truncated === true, tabId ?? undefined));
			mentionFileCache.set(cwd, { paths, at: now });
			return paths;
		})
		.catch(() => cached?.paths ?? [])
		.finally(() => {
			mentionFileInflight.delete(cwd);
		});
	mentionFileInflight.set(cwd, task);
	return task;
}

/**
 * The `@` file token that ends at the caret, read as stock's `extractAtFilePrefix` reads it (pi-tui
 * autocomplete.ts; a renderer copy, stock cannot run here): `@` at the start or after whitespace, then
 * either an open quote (`@"My Re`, a path with spaces) or any run of characters up to stock's path
 * delimiters (space, tab, `"`, `'`, `=`), so Hangul and other non-ASCII names count. `start` is the `@`.
 */
export function mentionToken(before: string): { start: number; query: string; quoted: boolean } | null {
	const quoted = /(^|\s)@"([^"]*)$/.exec(before);
	if (quoted) return { start: quoted.index + (quoted[1] ?? "").length, query: quoted[2] ?? "", quoted: true };
	const bare = /(^|\s)@([^\s"'=]*)$/.exec(before);
	if (bare) return { start: bare.index + (bare[1] ?? "").length, query: bare[2] ?? "", quoted: false };
	return null;
}

/**
 * The folder a typed `@` query names (`src/ren` → `src`), the one a cut-off listing can still be asked for
 * on its own; null for a query with no folder part, an absolute one, or one that leaves the workspace.
 */
export function mentionDirOf(query: string): string | null {
	const path = query.replace(/^\.\//, "");
	const slash = path.lastIndexOf("/");
	if (slash <= 0) return null;
	const dir = path.slice(0, slash);
	return dir.split("/").some(part => part === ".." || part === "") ? null : dir;
}

/** A batch of workspace paths and their NFC twins (same order): label and match text vs the path to insert. */
export interface MentionSource {
	paths: readonly string[];
	nfc: readonly string[];
}

export interface MentionMatch {
	/** The path as it is on disk: what the mention inserts. */
	path: string;
	/** The NFC path the menu shows; `ranges` index this. */
	label: string;
	ranges: [number, number][];
}

/**
 * The best `limit` workspace files for an `@` query, ranked by {@link pathMatcher} (file-name and word
 * starts, runs, CamelCase humps, Hangul initial consonants; a shorter path wins a tie), and how many files
 * matched in all. `query` is NFC.
 */
export function searchMentionFiles(
	query: string,
	sources: readonly MentionSource[],
	limit = MAX_MENTION_FILE_ITEMS,
): { matches: MentionMatch[]; total: number } {
	const match = pathMatcher(query);
	const scored: { source: number; index: number; score: number }[] = [];
	sources.forEach((source, sourceIndex) => {
		source.nfc.forEach((label, index) => {
			const found = match(label, false);
			if (found) scored.push({ source: sourceIndex, index, score: found.score });
		});
	});
	const labelOf = (entry: { source: number; index: number }) => sources[entry.source]?.nfc[entry.index] ?? "";
	scored.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		const x = labelOf(a);
		const y = labelOf(b);
		return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
	});
	const matches = scored.slice(0, limit).map(entry => {
		const label = labelOf(entry);
		return {
			path: sources[entry.source]?.paths[entry.index] ?? label,
			label,
			ranges: match(label)?.ranges ?? [],
		};
	});
	return { matches, total: scored.length };
}

/**
 * Rewrite a focused field's text as one native edit, so Cmd/Ctrl+Z undoes exactly this change (a value
 * written by script leaves the browser's undo stack pointing into text that is gone). Only the changed
 * middle is replaced. False when the field is not focused or the browser refuses the edit: the caller
 * then writes the value itself.
 */
export function editFieldText(el: HTMLTextAreaElement, next: string): boolean {
	const doc = el.ownerDocument;
	if (typeof doc.execCommand !== "function" || doc.activeElement !== el) return false;
	const value = el.value;
	if (value === next) return true;
	const shorter = Math.min(value.length, next.length);
	let start = 0;
	while (start < shorter && value[start] === next[start]) start++;
	// Never split a surrogate pair: half an emoji is not text the field can insert.
	if (start > 0 && /[\uD800-\uDBFF]/.test(value.charAt(start - 1))) start--;
	let end = 0;
	while (end < shorter - start && value[value.length - 1 - end] === next[next.length - 1 - end]) end++;
	if (end > 0 && /[\uDC00-\uDFFF]/.test(value.charAt(value.length - end))) end--;
	const insert = next.slice(start, next.length - end);
	el.setSelectionRange(start, value.length - end);
	const done = insert === "" ? doc.execCommand("delete") : doc.execCommand("insertText", false, insert);
	return done && el.value === next;
}

/**
 * Longest side an attached picture keeps. Providers downscale anything larger
 * themselves (Anthropic's documented 1568 px), so sending more only grows the
 * IPC message, the session file and the request.
 */
export const IMAGE_MAX_SIDE = 1568;
/** Formats re-encoded when downscaled; GIF (maybe animated) goes as it is. */
const RESIZABLE_TYPES: Record<string, true> = { "image/png": true, "image/jpeg": true, "image/webp": true };
/** The picture formats every provider takes (stock pi-ai's Anthropic, OpenAI and Gemini converters agree on these). */
const MODEL_IMAGE_TYPES: Record<string, true> = { ...RESIZABLE_TYPES, "image/gif": true };

function readDataUrl(blob: Blob): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const reader = new FileReader();
	reader.onload = () => resolve(String(reader.result));
	reader.onerror = () => reject(reader.error);
	reader.readAsDataURL(blob);
	return promise;
}

/** The picture scaled to fit {@link IMAGE_MAX_SIDE}, or null when it already fits or cannot be decoded here. */
async function downscaled(file: File): Promise<Blob | null> {
	if (!RESIZABLE_TYPES[file.type] || typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function")
		return null;
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		return null;
	}
	try {
		const scale = IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height);
		if (scale >= 1) return null;
		const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
		const context = canvas.getContext("2d");
		if (!context) return null;
		context.imageSmoothingQuality = "high";
		context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		return await canvas.convertToBlob({ type: file.type, quality: 0.9 });
	} finally {
		bitmap.close();
	}
}

/** A format models take as it is: JPEG, PNG, GIF and WebP. */
export function isModelImageType(mimeType: string): boolean {
	return MODEL_IMAGE_TYPES[mimeType] === true;
}

/**
 * The picture as an image attachment: JPEG, PNG, GIF and WebP as they are (scaled to fit); any other format through
 * `toModel` (stock's image path in main), or as it is when there is none (a web page: the host converts it as it
 * lands). Throws when it cannot be read or converted: the caller attaches it as a file.
 */
export async function fileToImage(
	file: File,
	toModel?: (image: { data: string; mimeType: string }) => Promise<{ data: string; mimeType: string }>,
): Promise<ComposerImage> {
	if (!isModelImageType(file.type) && toModel) {
		const raw = await readDataUrl(file);
		const converted = await toModel({ data: raw.slice(raw.indexOf(",") + 1), mimeType: file.type });
		return {
			content: { type: "image", data: converted.data, mimeType: converted.mimeType },
			preview: `data:${converted.mimeType};base64,${converted.data}`,
		};
	}
	const blob = (await downscaled(file)) ?? file;
	const dataUrl = await readDataUrl(blob);
	return {
		content: { type: "image", data: dataUrl.slice(dataUrl.indexOf(",") + 1), mimeType: blob.type || "image/png" },
		preview: dataUrl,
	};
}
