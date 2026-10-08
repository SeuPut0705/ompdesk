import type { HLJSApi } from "highlight.js";

let hljsModule: HLJSApi | null = null;
let hljsPromise: Promise<HLJSApi> | null = null;

// Load the shared "common" language subset. Every code surface in the GUI —
// tool cards, markdown fences, diffs — highlights through this one lazy chunk.
export function loadHljs(): Promise<HLJSApi> {
	if (!hljsPromise) {
		hljsPromise = import("highlight.js/lib/common").then(mod => {
			hljsModule = mod.default;
			return mod.default;
		});
	}
	return hljsPromise;
}

/** The already-loaded hljs instance, or null while the lazy chunk is pending. */
export function getLoadedHljs(): HLJSApi | null {
	return hljsModule;
}

/** Above this size, highlight cost (grammar scan + span HTML) outweighs the
 * preview value; callers fall back to escaped plain text. Matches the diff
 * path's existing ceiling. */
export const HIGHLIGHT_CHAR_CAP = 20_000;

/** One run of same-class text on a single highlighted line. */
export interface HighlightToken {
	className: string | null;
	text: string;
}

const HIGHLIGHT_ENTITY_RE = /&(amp|lt|gt|quot|#x27);/g;
const HIGHLIGHT_ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	"#x27": "'",
};

function decodeHighlightedText(text: string): string {
	return text.replace(HIGHLIGHT_ENTITY_RE, entity => HIGHLIGHT_ENTITIES[entity.slice(1, -1)] ?? entity);
}

/**
 * Split flat-span hljs HTML into per-line React tokens. hljs output never
 * nests spans and escapes every text node, so decoding its five fixed
 * entities here preserves the original source without injecting HTML.
 */
export function splitHighlightedLines(html: string): HighlightToken[][] {
	const lines: HighlightToken[][] = [[]];
	let openClass: string | null = null;
	const tokenRe = /<span class="([^"]*)">|<\/span>|[^<]+/g;
	const pushText = (raw: string): void => {
		if (raw.length === 0) return;
		const text = decodeHighlightedText(raw);
		const line = lines[lines.length - 1]!;
		const previous = line[line.length - 1];
		if (previous?.className === openClass) {
			previous.text += text;
		} else {
			line.push({ className: openClass, text });
		}
	};

	let match = tokenRe.exec(html);
	while (match !== null) {
		const [token, spanClass] = match;
		if (spanClass !== undefined) {
			openClass = spanClass;
		} else if (token === "</span>") {
			openClass = null;
		} else {
			const parts = token.split("\n");
			for (let i = 0; i < parts.length; i++) {
				if (i > 0) lines.push([]);
				pushText(parts[i]!);
			}
		}
		match = tokenRe.exec(html);
	}
	return lines;
}
