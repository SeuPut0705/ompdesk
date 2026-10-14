/**
 * The excerpt a full-content session search hit shows: the text around the
 * first query token, read back from the JSONL entry that holds it in its
 * original case. Presentation only — the match itself stays the raw grep in
 * session-index.ts, so no message projection of stock's is re-derived here;
 * any string value of the entry that contains the token is quoted.
 */

/** Characters of context kept on each side of the hit. */
const SNIPPET_CONTEXT = 70;
/** Occurrences of the token inspected for a conversation entry before falling back. */
const MAX_OCCURRENCES = 50;

function stringContaining(value: unknown, token: string): string | undefined {
	if (typeof value === "string") return value.toLowerCase().includes(token) ? value : undefined;
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = stringContaining(item, token);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	if (value && typeof value === "object") {
		for (const item of Object.values(value)) {
			const found = stringContaining(item, token);
			if (found !== undefined) return found;
		}
	}
	return undefined;
}

function clip(text: string, token: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	const at = flat.toLowerCase().indexOf(token);
	const start = Math.max(0, at - SNIPPET_CONTEXT);
	const end = Math.min(flat.length, at + token.length + SNIPPET_CONTEXT);
	return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

/**
 * `raw` is the session file text and `lower` its lowercase twin (the search cache holds both).
 * Returns undefined when no readable entry holds the token or case folding changed offsets.
 */
export function contentSnippet(raw: string, lower: string, tokens: readonly string[]): string | undefined {
	const token = tokens[0];
	if (!token || raw.length !== lower.length) return undefined;
	let fallback: string | undefined;
	let from = 0;
	for (let seen = 0; seen < MAX_OCCURRENCES; seen++) {
		const at = lower.indexOf(token, from);
		if (at < 0) break;
		const lineStart = lower.lastIndexOf("\n", at) + 1;
		const newline = lower.indexOf("\n", at);
		const lineEnd = newline < 0 ? lower.length : newline;
		from = lineEnd + 1;
		let entry: unknown;
		try {
			entry = JSON.parse(raw.slice(lineStart, lineEnd));
		} catch {
			continue;
		}
		const message = typeof entry === "object" && entry !== null && "message" in entry ? entry.message : undefined;
		const isMessage = message !== undefined;
		const text = stringContaining(isMessage ? message : entry, token);
		if (text === undefined) continue;
		if (isMessage) return clip(text, token);
		fallback ??= clip(text, token);
	}
	return fallback;
}
