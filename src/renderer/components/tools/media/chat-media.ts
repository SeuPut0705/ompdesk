/**
 * Which local files the chat shows as media, and where it finds them. Stock
 * tool results carry only text and image blocks: a video, a sound or a
 * document reaches the transcript as a path — a read's `details.mediaPath`,
 * a write's `resolvedPath`, tts's "Saved … to <path>", a browser recording's
 * returned `{ path }` — or as a path the reply links or quotes. Players and
 * chips read those files through the Files viewer's `fs.readBinary`, never
 * through a `file:` URL.
 */
import { resultDetails, resultText } from "../../../lib/format";
import { asRecord } from "../../../lib/wire-value";
import { viewerKind } from "../../panels/viewers/file-kind";

export type ChatMediaKind = "video" | "audio";
/**
 * Files the chat shows as a card (FileCard.tsx) without playing: a picture,
 * a PDF's first page, a page in a sandbox, a document (Word, Excel,
 * PowerPoint, CSV/TSV and other Office files), and any other file a reply
 * hands over (`file`: an archive, an installer, a database, or a file it
 * links outside the project).
 */
export type ChatFileKind = "image" | "pdf" | "html" | "document" | "file";
export type ChatReferenceKind = ChatMediaKind | ChatFileKind;

export interface ChatFileReference {
	path: string;
	kind: ChatReferenceKind;
}

/** `video`/`audio` by the Files viewer's own extension table, else null. */
export function chatMediaKind(path: string): ChatMediaKind | null {
	const kind = viewerKind(path);
	return kind === "video" || kind === "audio" ? kind : null;
}

/**
 * Media, pictures (SVG included), PDFs, pages, documents and other non-text files (archives,
 * installers, databases) by the Files viewer's extension table; a text or source file is none:
 * a reply names those to point at code, and they stay links in its text.
 */
export function chatReferenceKind(path: string): ChatReferenceKind | null {
	const kind = viewerKind(path);
	if (kind === "docx" || kind === "xlsx" || kind === "pptx" || kind === "csv" || kind === "office") return "document";
	if (kind === "binary") return "file";
	return kind === "video" || kind === "audio" || kind === "image" || kind === "pdf" || kind === "html" ? kind : null;
}

/** An absolute path (`/…`, `~/…`, `C:\…`, `\\server\…`): one the reply names outside the tab's folder can be. */
export function isAbsoluteChatPath(path: string): boolean {
	return /^(?:\/|~[\\/]|[A-Za-z]:[\\/]|\\\\)/.test(path);
}

/** `file:///a/b%20c.mp4` → `/a/b c.mp4` (malformed escapes stay as written). */
export function fileUrlPath(url: string): string {
	const raw = url.replace(/^file:\/\//i, "");
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

/**
 * The local path a markdown href names, or null for web, mail, in-page and
 * other-scheme links (`local://`, `artifact://` keep their own handlers). A
 * Windows drive prefix is a path, not a scheme.
 */
export function localFilePath(href: string): string | null {
	if (/^(?:https?:|mailto:|#|\/\/)/i.test(href)) return null;
	if (/^file:\/\//i.test(href)) return fileUrlPath(href.replace(/[?#].*$/, ""));
	if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) return null;
	const raw = href.replace(/[?#].*$/, "");
	if (!raw) return null;
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

/** Paths found under `details.value` (a browser run's return), at most `depth` levels down. */
function returnedPaths(value: unknown, depth: number, out: string[]): void {
	if (depth < 0) return;
	if (Array.isArray(value)) {
		for (const item of value.slice(0, 16)) returnedPaths(item, depth - 1, out);
		return;
	}
	const record = asRecord(value);
	if (!record) return;
	for (const [key, item] of Object.entries(record)) {
		if (typeof item === "string" && /path$/i.test(key)) out.push(item);
		else if (typeof item === "object") returnedPaths(item, depth - 1, out);
	}
}

/**
 * Audio and video files a finished tool call produced or showed, in result
 * order and without repeats: stock read's `details.mediaPath`, write's
 * `details.resolvedPath`, tts's saved file (the local backend may swap the
 * requested `.mp3` for `.wav`, so its result line wins over `output_path`),
 * and `*path` fields of a browser run's return value (`tab.recordStop()`).
 */
export function toolResultMedia(
	toolName: string,
	args: Record<string, unknown>,
	result: unknown,
): { path: string; kind: ChatMediaKind }[] {
	const details = resultDetails(result);
	const found: string[] = [];
	if (typeof details?.mediaPath === "string") found.push(details.mediaPath);
	if (toolName === "write" && typeof details?.resolvedPath === "string") found.push(details.resolvedPath);
	if (toolName === "tts") {
		const saved = /^Saved \d+ bytes to (.+?) \(/m.exec(resultText(result))?.[1];
		if (saved) found.push(saved);
		else if (typeof args.output_path === "string") found.push(args.output_path);
	}
	if (details && "value" in details) returnedPaths(details.value, 3, found);
	return [...new Set(found)].flatMap(path => {
		const kind = path ? chatMediaKind(path) : null;
		return kind ? [{ path, kind }] : [];
	});
}

const LINK = /(!?)\[(?:[^\]\\\n]|\\.)*\]\(\s*(<[^>\n]*>|[^\s)]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
const DEFINITION = /^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]*>|\S+)/gm;
const CODE_SPAN = /`([^`\n]+)`/g;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Local media and documents the reply names by link (`[demo](out/demo.mp4)`,
 * a reference definition) or as a quoted path (`` `out/demo.mp4` ``), deduped,
 * in order. Image embeds and raw `<video>`/`<audio>` already render in place,
 * fenced code is a command or a listing rather than a mention, and a code span
 * with spaces or shell syntax is a command, not a path.
 */
export function referencedFiles(markdown: string): ChatFileReference[] {
	const prose: string[] = [];
	let fence: string | null = null;
	for (const line of markdown.split("\n")) {
		const marker = FENCE.exec(line)?.[1];
		if (fence) {
			if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
			continue;
		}
		if (marker) {
			fence = marker;
			continue;
		}
		prose.push(line);
	}
	const text = prose.join("\n");
	const candidates: { index: number; href: string; linked: boolean }[] = [];
	for (const match of text.matchAll(LINK)) {
		if (!match[1]) candidates.push({ index: match.index, href: match[2] ?? "", linked: true });
	}
	for (const match of text.matchAll(DEFINITION))
		candidates.push({ index: match.index, href: match[1] ?? "", linked: true });
	for (const match of text.matchAll(CODE_SPAN)) {
		const quoted = (match[1] ?? "").trim();
		if (quoted && !/[\s*?{}$|<>;&]/.test(quoted))
			candidates.push({ index: match.index, href: quoted, linked: false });
	}
	const seen = new Set<string>();
	const references: ChatFileReference[] = [];
	for (const { href, linked } of candidates.sort((a, b) => a.index - b.index)) {
		const path = localFilePath(href.startsWith("<") ? href.slice(1, -1) : href);
		// A text file the reply links by an absolute path is one it hands over (`/tmp/report.md`), not code it
		// cites: a citation carries a line, and one inside the tab's folder is dropped by ReplyFiles.
		const handedOver =
			path !== null && linked && isAbsoluteChatPath(path) && !/(?::\d+|#L\d+)$/.test(href) && !/[\\/]$/.test(path);
		const kind = path ? (chatReferenceKind(path) ?? (handedOver ? "file" : null)) : null;
		// `out/a.mp4` and `./out/a.mp4` are one file.
		const key = path?.replace(/^(?:\.[\\/])+/, "") ?? "";
		if (!path || !kind || seen.has(key)) continue;
		seen.add(key);
		references.push({ path, kind });
	}
	return references;
}
