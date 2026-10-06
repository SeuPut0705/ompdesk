/**
 * Emoji completion, ported from the TUI (`packages/coding-agent/src/modes/
 * emoji-autocomplete.ts`). The shortcode bucket JSON (32.7 KB, built offline
 * by scripts/build-emojis.py — keep in sync with
 * packages/coding-agent/src/modes/data/emojis.json) is lazy-loaded on first
 * trigger so it never enters the eager chunk; the emoticon table and
 * submit-time expansion are static and synchronous.
 *
 * Three behaviors, all required for TUI parity:
 * 1. popup suggestions after `:query` (≥1 letter, left-bounded opening colon)
 * 2. inline replace — `:name:` on the closing colon, emoticons on a terminator
 * 3. submit-time expandEmoticons over the whole message
 */

type Entry = readonly [name: string, char: string];
type Buckets = Readonly<Record<string, readonly Entry[]>>;

// Western text emoticons outside the `:name:` grammar. Longest-first so
// `:-)` wins over `:)` (mirrors the TUI table verbatim).
const EMOTICONS: ReadonlyArray<readonly [pattern: string, char: string]> = [
	[":'-(", "😢"],
	[">:-(", "😠"],
	[":-)", "🙂"],
	[":-(", "🙁"],
	[":-D", "😃"],
	[":-P", "😛"],
	[":-p", "😛"],
	[":-O", "😮"],
	[":-o", "😮"],
	[":-|", "😐"],
	[":-/", "😕"],
	[":-\\", "😕"],
	[":-*", "😘"],
	[";-)", "😉"],
	[";-P", "😜"],
	[":')", "🥲"],
	[":'D", "😂"],
	[":'(", "😢"],
	["</3", "💔"],
	[">:(", "😠"],
	["B-)", "😎"],
	["8-)", "😎"],
	["o.O", "😳"],
	["O.o", "😳"],
	[":)", "🙂"],
	[":(", "🙁"],
	[":D", "😃"],
	[":P", "😛"],
	[":p", "😛"],
	[":O", "😮"],
	[":o", "😮"],
	[":|", "😐"],
	[":/", "😕"],
	[":\\", "😕"],
	[":*", "😘"],
	[";)", "😉"],
	[":3", "😺"],
	["<3", "❤️"],
	["xD", "😆"],
	["XD", "😆"],
	["B)", "😎"],
	["8)", "😎"],
];

const MAX_SUGGESTIONS = 12;

let bucketsPromise: Promise<Buckets> | null = null;
function loadBuckets(): Promise<Buckets> {
	bucketsPromise ??= import("./data/emojis.json").then(module => module.default as unknown as Buckets);
	return bucketsPromise;
}

function lowerBound(arr: readonly Entry[], target: string): number {
	let lo = 0;
	let hi = arr.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (arr[mid]![0] < target) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

function isNameCharCode(c: number): boolean {
	return (
		(c >= 0x61 && c <= 0x7a) ||
		(c >= 0x41 && c <= 0x5a) ||
		(c >= 0x30 && c <= 0x39) ||
		c === 0x5f ||
		c === 0x2b ||
		c === 0x2d
	);
}

/** Left token boundary for an opening `:` (mirrors the TUI set, `\r` included). */
function hasLeftBoundary(text: string, colonIdx: number): boolean {
	if (colonIdx === 0) return true;
	const c = text.charCodeAt(colonIdx - 1);
	return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x28 || c === 0x5b || c === 0x7b || c === 0x3e;
}

interface EmojiTrigger {
	/** Full token including the leading `:` (e.g. `:joy`). */
	prefix: string;
	query: string;
}

function extractTrigger(text: string): EmojiTrigger | null {
	let i = text.length;
	while (i > 0 && isNameCharCode(text.charCodeAt(i - 1))) i--;
	if (i === 0 || text.charCodeAt(i - 1) !== 0x3a) return null;
	const colonIdx = i - 1;
	if (!hasLeftBoundary(text, colonIdx)) return null;
	const name = text.slice(i);
	return { prefix: `:${name}`, query: name.toLowerCase() };
}

export interface EmojiSuggestionItem {
	value: string;
	label: string;
}

/** Popup suggestions for `:query`. Async: the bucket JSON is lazy-loaded. */
export async function getEmojiSuggestions(
	textBeforeCursor: string,
): Promise<{ items: EmojiSuggestionItem[]; prefix: string } | null> {
	const trigger = extractTrigger(textBeforeCursor);
	if (!trigger) return null;
	// A bare `:` in prose ("note:") never pops — wait for one letter.
	if (trigger.query.length === 0) return null;

	const buckets = await loadBuckets();
	const items: EmojiSuggestionItem[] = [];

	// Emoticon literals whose pattern starts with `:<query>` first.
	const wanted = `:${trigger.query}`;
	for (const [pattern, char] of EMOTICONS) {
		if (items.length >= MAX_SUGGESTIONS) break;
		if (pattern.length < wanted.length) continue;
		if (pattern.toLowerCase().slice(0, wanted.length) !== wanted) continue;
		items.push({ value: char, label: `${char}  ${pattern}` });
	}

	const bucket = buckets[trigger.query[0]!];
	if (bucket) {
		for (let i = lowerBound(bucket, trigger.query); i < bucket.length && items.length < MAX_SUGGESTIONS; i++) {
			const [name, char] = bucket[i]!;
			if (!name.startsWith(trigger.query)) break;
			items.push({ value: char, label: `${char}  :${name}:` });
		}
	}

	return items.length > 0 ? { items, prefix: trigger.prefix } : null;
}

function lookupExact(buckets: Buckets, name: string): string | undefined {
	const bucket = buckets[name[0] ?? ""];
	if (!bucket) return undefined;
	const i = lowerBound(bucket, name);
	const hit = bucket[i];
	return hit && hit[0] === name ? hit[1] : undefined;
}

function tryShortcodeInlineReplace(
	buckets: Buckets,
	textBeforeCursor: string,
): { replaceLen: number; insert: string } | null {
	const len = textBeforeCursor.length;
	if (len === 0 || textBeforeCursor.charCodeAt(len - 1) !== 0x3a) return null;
	const closeIdx = len - 1;
	let nameStart = closeIdx;
	while (nameStart > 0 && isNameCharCode(textBeforeCursor.charCodeAt(nameStart - 1))) nameStart--;
	if (nameStart === closeIdx) return null; // `::`
	if (nameStart === 0 || textBeforeCursor.charCodeAt(nameStart - 1) !== 0x3a) return null;
	const openIdx = nameStart - 1;
	if (!hasLeftBoundary(textBeforeCursor, openIdx)) return null;
	const name = textBeforeCursor.slice(nameStart, closeIdx).toLowerCase();
	const char = lookupExact(buckets, name);
	if (!char) return null;
	return { replaceLen: name.length + 2, insert: char };
}

function isEmoticonTerminator(c: number): boolean {
	return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

function tryEmoticonInlineReplace(textBeforeCursor: string): { replaceLen: number; insert: string } | null {
	const len = textBeforeCursor.length;
	if (len < 2) return null;
	const terminator = textBeforeCursor.charCodeAt(len - 1);
	if (!isEmoticonTerminator(terminator)) return null;
	const term = textBeforeCursor[len - 1]!;
	const tail = len - 1;
	for (const [pattern, char] of EMOTICONS) {
		const plen = pattern.length;
		if (tail < plen) continue;
		const start = tail - plen;
		let match = true;
		for (let j = 0; j < plen; j++) {
			if (textBeforeCursor.charCodeAt(start + j) !== pattern.charCodeAt(j)) {
				match = false;
				break;
			}
		}
		if (!match) continue;
		// Emoticons embedded in identifiers / URLs / code stay untouched.
		if (start > 0 && !hasLeftBoundary(textBeforeCursor, start)) continue;
		return { replaceLen: plen + 1, insert: char + term };
	}
	return null;
}

/** Inline replace on typing (`:name:` close, or emoticon + terminator). Async for the buckets. */
export async function tryEmojiInlineReplace(
	textBeforeCursor: string,
): Promise<{ replaceLen: number; insert: string } | null> {
	const emoticon = tryEmoticonInlineReplace(textBeforeCursor);
	if (emoticon) return emoticon;
	// Shortcode needs the bucket lookup — only load it when the tail is a colon.
	if (textBeforeCursor.charCodeAt(textBeforeCursor.length - 1) !== 0x3a) return null;
	const buckets = await loadBuckets();
	return tryShortcodeInlineReplace(buckets, textBeforeCursor);
}

/**
 * Submit-time expansion: rewrite emoticons at token boundaries across the
 * whole message (catches Enter pressed without a trailing space). Static and
 * synchronous — only the EMOTICONS table is involved.
 */
export function expandEmoticons(text: string): string {
	if (text.length < 2) return text;
	let out = "";
	let cursor = 0;
	let i = 0;
	while (i < text.length) {
		if (i === 0 || hasLeftBoundary(text, i)) {
			let matched = false;
			for (const [pattern, char] of EMOTICONS) {
				if (!text.startsWith(pattern, i)) continue;
				const end = i + pattern.length;
				if (end !== text.length) {
					const next = text.charCodeAt(end);
					if (!isEmoticonTerminator(next)) continue;
				}
				out += text.slice(cursor, i) + char;
				cursor = end;
				i = end;
				matched = true;
				break;
			}
			if (matched) continue;
		}
		i++;
	}
	if (cursor === 0) return text;
	return out + text.slice(cursor);
}
