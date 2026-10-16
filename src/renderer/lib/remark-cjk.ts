/**
 * Two CommonMark/GFM edges that break Korean (and other CJK) replies, fixed on
 * the mdast before it becomes HTML. Adapted from Mixdog's
 * `repairAdjacentStrongPunctuation` and `trimAutolinkCjkSuffix`
 * (apps/desktop/src/renderer/markdown-plugins.ts, Apache-2.0; see THIRD_PARTY_NOTICES.txt).
 */
import type { InlineCode, Nodes, Root, RootContent, Text } from "mdast";

type ChildSpan = { child: RootContent; start: number; end: number };

/** `**…%**이며`: a strong run whose last character is punctuation, glued to a letter or digit. */
const ADJACENT_STRONG =
	/(\*\*(?!\s)([^*\n]*?[^\s\p{L}\p{N}*])\*\*|__(?!\s)([^_\n]*?[^\s\p{L}\p{N}_])__)(?=[\p{L}\p{N}])/gu;
const CJK_CHARACTER =
	/[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uffef]/u;
const TRAILING_URL_PUNCTUATION = /[?!.,:*_~]$/;

/** Whether an odd run of backslashes escapes the character at `index`. */
function escapedAt(value: string, index: number): boolean {
	let slashes = 0;
	for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor--) slashes++;
	return slashes % 2 === 1;
}

/** The children as one string (text verbatim, inline code as a backtick, anything else a newline). */
function projectChildren(
	children: RootContent[],
	visit: (node: Nodes) => void,
): { projection: string; spans: ChildSpan[] } {
	let projection = "";
	const spans = children.map(child => {
		visit(child);
		const start = projection.length;
		projection += child.type === "text" ? child.value : child.type === "inlineCode" ? "`" : "\n";
		return { child, start, end: projection.length };
	});
	return { projection, spans };
}

/** The children covering [start, end) of the projection: text cut to the range, other nodes whole. */
function sliceSpans(spans: ChildSpan[], start: number, end: number): RootContent[] {
	const result: RootContent[] = [];
	for (const span of spans) {
		if (span.end <= start || span.start >= end) continue;
		result.push(
			span.child.type === "text"
				? { type: "text", value: span.child.value.slice(Math.max(0, start - span.start), end - span.start) }
				: span.child,
		);
	}
	return result;
}

/**
 * CommonMark leaves `**0.118%**이며` unbold: punctuation right before the
 * closing delimiter and a letter right after it make it non-right-flanking.
 * Inline code may split such a run, so the match runs on a projection (one
 * backtick per code node) and the original nodes are wrapped; code content is
 * never searched, and other node kinds form a boundary.
 */
export function remarkCjkStrong() {
	return (tree: Root) => {
		const visit = (node: Nodes) => {
			if (node.type === "strong" || node.type === "code" || node.type === "inlineCode") return;
			if (!("children" in node)) return;
			const children: RootContent[] = node.children;
			const { projection, spans } = projectChildren(children, visit);
			const repaired: RootContent[] = [];
			let cursor = 0;
			for (const match of projection.matchAll(ADJACENT_STRONG)) {
				if (escapedAt(projection, match.index)) continue;
				const end = match.index + match[0].length;
				repaired.push(...sliceSpans(spans, cursor, match.index), {
					type: "strong",
					children: sliceSpans(spans, match.index + 2, end - 2).filter(
						(child): child is Text | InlineCode => child.type === "text" || child.type === "inlineCode",
					),
				});
				cursor = end;
			}
			if (cursor === 0) return;
			repaired.push(...sliceSpans(spans, cursor, projection.length));
			children.splice(0, children.length, ...repaired);
		};
		visit(tree);
	};
}

/** Where a literal autolink's label stops: its first CJK character, less exposed punctuation and unbalanced `)`. */
function autolinkCut(label: string): number {
	const found = label.search(CJK_CHARACTER);
	if (found <= 0) return -1;
	let end = found;
	for (;;) {
		const head = label.slice(0, end);
		if (TRAILING_URL_PUNCTUATION.test(head)) end--;
		else if (head.endsWith(")") && head.split(")").length > head.split("(").length) end--;
		else return end;
	}
}

/**
 * GFM extends a bare URL through every non-space character, so Korean prose
 * glued to it (`페이지(https://a.io/x/)와`) ended up in the href and opened a
 * 404. A literal autolink (its label is the URL's tail and starts where the
 * link starts; `[..](..)` and `<..>` carry a delimiter first) is cut at its
 * first CJK character and the rest goes back to prose.
 */
export function remarkCjkAutolink() {
	return (tree: Root) => {
		const visit = (node: Nodes) => {
			if (!("children" in node)) return;
			const children: RootContent[] = node.children;
			for (let index = 0; index < children.length; index++) {
				const child = children[index];
				visit(child);
				if (child.type !== "link" || child.children.length !== 1) continue;
				const label = child.children[0];
				if (label.type !== "text" || !child.url.endsWith(label.value)) continue;
				const start = child.position?.start.offset;
				if (start === undefined || start !== label.position?.start.offset) continue;
				const end = autolinkCut(label.value);
				if (end <= 0) continue;
				const tail = label.value.slice(end);
				child.url = child.url.slice(0, child.url.length - tail.length);
				label.value = label.value.slice(0, end);
				child.position = undefined;
				label.position = undefined;
				children.splice(index + 1, 0, { type: "text", value: tail });
				index++;
			}
		};
		visit(tree);
	};
}
