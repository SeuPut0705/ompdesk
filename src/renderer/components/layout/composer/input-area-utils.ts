/**
 * Input area utilities: file handling and command filtering.
 */

import type { FsTreeEntry } from "../../../../shared/ipc-types";
import type { ComposerImage } from "../../../stores/composer";

const MENTION_FS_DEPTH = 8;
const MENTION_FS_MAX_ENTRIES = 2000;

/** Cap on completion menu items. */
export const MAX_MENU_ITEMS = 8;
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
/** Formats re-encoded when downscaled; GIF (maybe animated) and others go as they are. */
const RESIZABLE_TYPES: Record<string, true> = { "image/png": true, "image/jpeg": true, "image/webp": true };

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

export async function fileToImage(file: File): Promise<ComposerImage> {
	const blob = (await downscaled(file)) ?? file;
	const dataUrl = await readDataUrl(blob);
	return {
		content: { type: "image", data: dataUrl.slice(dataUrl.indexOf(",") + 1), mimeType: blob.type || "image/png" },
		preview: dataUrl,
	};
}
