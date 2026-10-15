/**
 * Input area utilities: file handling and command filtering.
 */

import type { FsTreeEntry } from "../../../shared/ipc-types";
import type { ComposerImage } from "../../stores/composer";

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

/** @mention file lists, cached per session cwd; inflight dedupes concurrent walks. */
const mentionFileInflight = new Map<string, Promise<string[]>>();
export const mentionFileCache = new Map<string, string[]>();
export function listMentionFiles(cwd: string, tabId?: string | null): Promise<string[]> {
	const cached = mentionFileCache.get(cwd);
	if (cached) return Promise.resolve(cached);
	const inflight = mentionFileInflight.get(cwd);
	if (inflight) return inflight;
	const task = window.omp.fs
		.list(undefined, MENTION_FS_DEPTH, MENTION_FS_MAX_ENTRIES, tabId ?? undefined)
		.then(result => {
			const paths: string[] = [];
			if (result.ok) flattenFilePaths(result.entries, paths);
			paths.sort();
			mentionFileCache.set(cwd, paths);
			return paths;
		})
		.catch(() => {
			// Best-effort: on IPC failure the @ menu falls back to scheme entries
			// only; nothing is cached so the next attempt retries the walk.
			return [] as string[];
		})
		.finally(() => {
			mentionFileInflight.delete(cwd);
		});
	mentionFileInflight.set(cwd, task);
	return task;
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
