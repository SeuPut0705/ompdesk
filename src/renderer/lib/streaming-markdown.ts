export interface StableMarkdownBlock {
	/** Stable source-end offset; remains unchanged as later text arrives. */
	end: number;
	content: string;
}

export interface StreamingMarkdownSegments {
	blocks: StableMarkdownBlock[];
	tail: string;
	tailStart: number;
}

interface FenceState {
	marker: "`" | "~";
	length: number;
}

function openingFence(line: string): FenceState | null {
	const match = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
	const fence = match?.[1];
	if (!fence) return null;
	return { marker: fence[0] as "`" | "~", length: fence.length };
}

function closesFence(line: string, fence: FenceState): boolean {
	const candidate = line.replace(/^[ \t]{0,3}/, "");
	let length = 0;
	while (candidate[length] === fence.marker) length++;
	return length >= fence.length && candidate.slice(length).trim().length === 0;
}
const LIST_ITEM_RE = /^[ \t]{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]/;
/** A lone, possibly-still-growing marker token ("-", "2", "2.") — a list
 * continuation candidate that must not yet end the block. */
const PARTIAL_MARKER_RE = /^(?:[-*+]|\d{1,9}[.)]?)$/;

/** Approximate visual columns of the line's leading whitespace (tab = 4). */
function leadingColumns(line: string): number {
	let columns = 0;
	for (const ch of line) {
		if (ch === " ") columns++;
		else if (ch === "\t") columns += 4 - (columns % 4);
		else break;
	}
	return columns;
}

/** Content column a list continuation must reach, or null when not a list. */
function listContentColumn(line: string): number | null {
	if (!LIST_ITEM_RE.test(line)) return null;
	const marker = line.trimStart().split(/[ \t]/, 1)[0] ?? "";
	return leadingColumns(line) + marker.length + 1;
}

/**
 * Split a growing Markdown stream into immutable blocks and one mutable tail.
 *
 * Blank lines are safe promotion points outside fenced code and display-math
 * blocks. A closed code/math fence is also promoted immediately. Stable blocks
 * can therefore be memoized and parsed exactly once while the unfinished tail
 * remains cheap plain text until its structure is complete.
 */
export function segmentStreamingMarkdown(text: string): StreamingMarkdownSegments {
	const blocks: StableMarkdownBlock[] = [];
	let blockStart = 0;
	let offset = 0;
	let fence: FenceState | null = null;
	let displayMath: "$$" | "\\]" | null = null;
	// Blank lines inside a list block are NOT stable boundaries: an indented
	// continuation or a further item still belongs to the same <li>, so
	// promotion defers until a line proves the list ended. Without this,
	// `1. first\n\n   second` rendered `second` outside the list live and
	// jumped at message_end.
	let listColumn: number | null = null;
	let sawFirstLine = false;
	let pendingBoundary: number | null = null;

	const promote = (end: number) => {
		const content = text.slice(blockStart, end);
		if (content.trim().length > 0) blocks.push({ end, content });
		blockStart = end;
		sawFirstLine = false;
		listColumn = null;
		pendingBoundary = null;
	};

	while (offset < text.length) {
		const newline = text.indexOf("\n", offset);
		const hasNewline = newline !== -1;
		const end = hasNewline ? newline + 1 : text.length;
		const line = text.slice(offset, hasNewline ? newline : text.length);
		const trimmed = line.trim();
		let closedFence = false;
		let closedMath = false;

		// A pending list boundary resolves against the FIRST following
		// non-blank line — even when that line opens a fence or math block,
		// which would otherwise swallow the boundary and strand a finished
		// list in the mutable tail for the whole fenced block. The check is
		// partial-line-safe: a bare "2" or "2." may still grow into an item,
		// so it counts as continuing instead of promoting (append-stable).
		if (pendingBoundary !== null && trimmed.length > 0) {
			const continuesList =
				LIST_ITEM_RE.test(line) || PARTIAL_MARKER_RE.test(trimmed) || leadingColumns(line) >= (listColumn ?? 0);
			if (!continuesList) promote(pendingBoundary);
			pendingBoundary = null;
		}

		if (fence) {
			if (closesFence(line, fence)) {
				fence = null;
				closedFence = true;
			}
		} else if (!displayMath) {
			fence = openingFence(line);
		}

		if (!fence && !closedFence) {
			if (displayMath === "$$" && trimmed === "$$") {
				displayMath = null;
				closedMath = true;
			} else if (!displayMath) {
				if (trimmed === "$$") displayMath = "$$";
				else if (trimmed.startsWith("\\[")) displayMath = "\\]";
			}
			// A bracket equation may start/end beside its body. A TeX row break
			// (`\\`) before `]` is content, not a closing delimiter.
			if (displayMath === "\\]" && /(?:^|[^\\])(?:\\\\)*\\\]$/.test(trimmed)) {
				displayMath = null;
				closedMath = true;
			}
		}

		if (hasNewline && !fence && !displayMath && (closedFence || (closedMath && listColumn === null))) {
			promote(end);
		} else if (!fence && !displayMath && !closedFence && !closedMath) {
			if (trimmed.length === 0) {
				if (hasNewline) {
					if (listColumn !== null) {
						if (pendingBoundary === null) pendingBoundary = end;
					} else {
						promote(end);
					}
				}
			} else if (hasNewline && !sawFirstLine) {
				// Classify list-ness only from complete lines — a partial first
				// line ("1.") would freeze a wrong non-list verdict.
				sawFirstLine = true;
				listColumn = listContentColumn(line);
			}
		}

		offset = end;
	}

	return {
		blocks,
		tail: text.slice(blockStart),
		tailStart: blockStart,
	};
}
