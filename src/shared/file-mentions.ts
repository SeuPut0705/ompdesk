/**
 * The `@path` mentions stock omp reads at send time. Copy of stock
 * `extractFileMentions` (`pi-coding-agent/src/utils/file-mentions.ts`): the
 * renderer shows a card per mention while the user writes, before omp sees
 * the prompt, and cannot import stock. `file-mentions.test.ts` runs it
 * against the installed stock function.
 */

const FILE_MENTION_REGEX = /@(?:"([^"]+)"|'([^']+)'|([^\s@]+))/g;
const LEADING_PUNCTUATION_REGEX = /^[`"'([{<]+/;
const TRAILING_PUNCTUATION_REGEX = /[)\]}>.,;:!?"'`]+$/;
const MENTION_BOUNDARY_REGEX = /[\s([{<"'`]/;

interface MentionToken {
	path: string;
	start: number;
	end: number;
}

function mentionTokens(text: string): MentionToken[] {
	const tokens: MentionToken[] = [];
	for (const match of text.matchAll(FILE_MENTION_REGEX)) {
		const index = match.index ?? 0;
		if (index > 0 && !MENTION_BOUNDARY_REGEX.test(text[index - 1] ?? "")) continue;
		const quoted = match[1] ?? match[2];
		const path =
			quoted !== undefined
				? quoted.trim()
				: (match[3] ?? "")
						.trim()
						.replace(LEADING_PUNCTUATION_REGEX, "")
						.replace(TRAILING_PUNCTUATION_REGEX, "")
						.trim();
		if (path) tokens.push({ path, start: index, end: index + match[0].length });
	}
	return tokens;
}

/** Every mentioned path, deduplicated, in order (stock `extractFileMentions`). */
export function extractFileMentions(text: string): string[] {
	return [...new Set(mentionTokens(text).map(token => token.path))];
}

/**
 * The text without its mentions of `path`, each with one following space, so
 * removing a draft's card removes the attachment stock would have read. An
 * unquoted mention keeps the punctuation stock trims off its path, which is
 * the user's text: `(see @a.ts)` → `(see )`.
 */
export function removeFileMention(text: string, path: string): string {
	let result = "";
	let cursor = 0;
	for (const token of mentionTokens(text)) {
		if (token.path !== path) continue;
		const raw = text.slice(token.start, token.end);
		// Keep the punctuation the mention's own path does not include.
		const at = raw.indexOf(path);
		const lead = at > 1 && !/^@["']/.test(raw) ? raw.slice(1, at) : "";
		const tail = at >= 0 && !/^@["']/.test(raw) ? raw.slice(at + path.length) : "";
		result += text.slice(cursor, token.start) + lead + tail;
		cursor = token.end;
		if (!lead && !tail && text[cursor] === " ") cursor += 1;
	}
	return result + text.slice(cursor);
}

/** Where `text` holds code (fenced blocks and inline code spans): a mention there is code the person sent, not a file. */
function codeRanges(text: string): [number, number][] {
	const ranges: [number, number][] = [];
	let offset = 0;
	let fence: { marker: string; start: number } | null = null;
	for (const line of text.split("\n")) {
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence) {
			if (marker && marker[0] === fence.marker[0] && marker.length >= fence.marker.length) {
				ranges.push([fence.start, offset + line.length]);
				fence = null;
			}
		} else if (marker) fence = { marker, start: offset };
		else
			for (const span of line.matchAll(/(`+)[^`]+?\1/g))
				ranges.push([offset + span.index, offset + span.index + span[0].length]);
		offset += line.length + 1;
	}
	if (fence) ranges.push([fence.start, text.length]);
	return ranges;
}

/** The mentions outside code that name something path-like (a folder or an extension; `@kim` is a person, not a file). */
function attachedTokens(text: string): MentionToken[] {
	const code = codeRanges(text);
	return mentionTokens(text).filter(
		token => isPathLikeMention(token.path) && !code.some(([start, end]) => token.start < end && token.end > start),
	);
}

/** A mentioned path that reads as a file or folder: it has a separator or an extension. */
export function isPathLikeMention(path: string): boolean {
	return /[\\/.]/.test(path);
}

/**
 * A sent prompt shown with its attachments as cards: the text without the lines that hold nothing
 * but mentions (what the composer's picker, drop and paste insert), and every path it mentions
 * outside code, in order. A mention inside a sentence stays in the text, which reads wrong without it.
 */
export function splitAttachedMentions(text: string): { text: string; paths: string[] } {
	const tokens = attachedTokens(text);
	if (tokens.length === 0) return { text, paths: [] };
	const kept: string[] = [];
	let lineStart = 0;
	for (const line of text.split("\n")) {
		const lineEnd = lineStart + line.length;
		let rest = "";
		let cursor = lineStart;
		for (const token of tokens) {
			if (token.start < lineStart || token.end > lineEnd) continue;
			rest += text.slice(cursor, token.start);
			cursor = token.end;
		}
		rest += text.slice(cursor, lineEnd);
		const onlyMentions = cursor !== lineStart && rest.trim() === "";
		if (!onlyMentions) kept.push(line);
		lineStart = lineEnd + 1;
	}
	return {
		text: kept.join("\n").replace(/^\n+|\n+$/g, ""),
		paths: [...new Set(tokens.map(token => token.path))],
	};
}

/**
 * `text` with each mention outside code replaced by what `replace` makes of its path (null keeps it
 * as written). The punctuation stock trims off an unquoted mention's path stays around the result:
 * `(see @a/b.ts).` keeps its parenthesis and full stop.
 */
export function replaceFileMentions(text: string, replace: (path: string) => string | null): string {
	let result = "";
	let cursor = 0;
	for (const token of attachedTokens(text)) {
		const next = replace(token.path);
		if (next === null) continue;
		const raw = text.slice(token.start, token.end);
		const quoted = /^@["']/.test(raw);
		const at = raw.indexOf(token.path);
		const lead = !quoted && at > 1 ? raw.slice(1, at) : "";
		const tail = !quoted && at >= 0 ? raw.slice(at + token.path.length) : "";
		result += text.slice(cursor, token.start) + lead + next + tail;
		cursor = token.end;
	}
	return result + text.slice(cursor);
}
