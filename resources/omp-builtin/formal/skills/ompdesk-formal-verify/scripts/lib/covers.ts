/**
 * What a model covers, finer than a file. A `covers` entry of manifest.json is one of:
 *   `src/main/x.ts`            the whole file (or a folder): any change to it is drift
 *   `src/main/x.ts#sync`       one function, method, class or const by name (`Class.method` for a member)
 *   `src/main/x.ts:120-180`    a line range, in the coordinates of the working tree
 * so an unrelated edit elsewhere in a 2 500-line file does not raise drift.
 */
export type Cover =
	| { raw: string; kind: "path"; path: string }
	| { raw: string; kind: "symbol"; path: string; symbol: string }
	| { raw: string; kind: "range"; path: string; start: number; end: number };

export function parseCover(raw: string): Cover {
	const hash = raw.indexOf("#");
	if (hash > 0) {
		const symbol = raw.slice(hash + 1).trim();
		if (!symbol) throw new Error(`covers entry ${raw}: nothing after #`);
		return { raw, kind: "symbol", path: raw.slice(0, hash), symbol };
	}
	const range = /^(.+?):(\d+)(?:-(\d+))?$/.exec(raw);
	if (range) {
		const start = Number(range[2]);
		const end = range[3] === undefined ? start : Number(range[3]);
		if (start < 1 || end < start) throw new Error(`covers entry ${raw}: not a valid line range`);
		return { raw, kind: "range", path: range[1] as string, start, end };
	}
	return { raw, kind: "path", path: raw };
}

/** The file or folder part of every covers entry. */
export function coverPaths(covers: string[]): string[] {
	return [...new Set(covers.map(raw => parseCover(raw).path))];
}

export interface Span {
	/** 1-based, inclusive. */
	start: number;
	end: number;
}

const MODIFIERS =
	"(?:(?:export|default|declare|public|private|protected|static|async|readonly|override|abstract|get|set|unsafe|pub(?:\\([^)]*\\))?)\\s+)*";
const NOT_A_CALL = /^\s*(?:if|for|while|switch|return|await|throw|else|catch|new|typeof|yield)\b/;

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * From a declaration line, the line where its body ends: brace matching that skips strings, template literals and
 * comments, or (Python `def` and `class`) the indentation block. `null` when the line is not a declaration with a
 * body or a one-statement initializer.
 */
function spanEnd(lines: string[], from: number, keywordForm: boolean): number | null {
	const head = lines[from] as string;
	if (/^\s*(?:async\s+)?(?:def|class)\s/.test(head) && /:\s*(?:#.*)?$/.test(head) && !head.includes("{")) {
		const indent = /^\s*/.exec(head)?.[0].length ?? 0;
		let end = from;
		for (let i = from + 1; i < lines.length; i++) {
			const line = lines[i] as string;
			if (line.trim() === "") continue;
			if ((/^\s*/.exec(line)?.[0].length ?? 0) <= indent) break;
			end = i;
		}
		return end;
	}
	let paren = 0;
	let depth = 0;
	let opened = false;
	let inString: string | undefined;
	let inBlockComment = false;
	for (let i = from; i < lines.length; i++) {
		const line = lines[i] as string;
		for (let c = 0; c < line.length; c++) {
			const ch = line[c] as string;
			const next = line[c + 1];
			if (inBlockComment) {
				if (ch === "*" && next === "/") {
					inBlockComment = false;
					c++;
				}
				continue;
			}
			if (inString) {
				if (ch === "\\") c++;
				else if (ch === inString) inString = undefined;
				continue;
			}
			if (ch === "/" && next === "/") break;
			if (ch === "/" && next === "*") {
				inBlockComment = true;
				c++;
			} else if (ch === '"' || ch === "'" || ch === "`") inString = ch;
			else if (ch === "(" || ch === "[") paren++;
			else if (ch === ")" || ch === "]") paren--;
			else if (ch === "{") {
				if (paren <= 0 || opened) {
					opened = true;
					depth++;
				}
			} else if (ch === "}") {
				if (opened) {
					depth--;
					if (depth === 0) return i;
				}
			} else if (ch === ";" && !opened && paren <= 0) return keywordForm ? i : null;
		}
		if (inString && inString !== "`") inString = undefined;
	}
	return null;
}

/** The lines of every declaration named `name` (a function, method, class, const, type, Rust `fn`, Go `func`, Python `def`). */
export function findSymbolSpans(source: string, symbol: string): Span[] {
	const lines = source.split(/\r?\n/);
	const parts = symbol.split(".").filter(Boolean);
	let scope: Span[] = [{ start: 1, end: lines.length }];
	for (const part of parts) {
		const found: Span[] = [];
		const name = escapeRegex(part);
		const keywordForm = new RegExp(
			`^\\s*${MODIFIERS}(?:function\\s*\\*?\\s*|class\\s+|interface\\s+|enum\\s+|type\\s+|namespace\\s+|const\\s+|let\\s+|var\\s+|def\\s+|fn\\s+|func\\s+(?:\\([^)]*\\)\\s*)?|struct\\s+|trait\\s+|impl\\s+)#?${name}\\b`,
		);
		const methodForm = new RegExp(`^\\s*${MODIFIERS}\\*?#?${name}\\s*(?:<[^>\\n]*>)?\\s*\\(`);
		for (const area of scope) {
			for (let i = area.start - 1; i < area.end; i++) {
				const line = lines[i] as string;
				const isKeyword = keywordForm.test(line);
				if (!isKeyword && (NOT_A_CALL.test(line) || !methodForm.test(line))) continue;
				const end = spanEnd(lines, i, isKeyword);
				if (end === null || end >= area.end) continue;
				found.push({ start: i + 1, end: end + 1 });
				i = end;
			}
		}
		if (found.length === 0) return [];
		scope = found;
	}
	return scope;
}

/** The text of the spans, trailing whitespace dropped, as one string (what a drift check compares). */
export function spanText(source: string, spans: Span[]): string {
	const lines = source.split(/\r?\n/);
	return spans
		.map(span =>
			lines
				.slice(span.start - 1, span.end)
				.map(line => line.trimEnd())
				.join("\n"),
		)
		.join("\n----\n");
}

export interface Hunk {
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
}

/** Hunks of `git diff -U0` output (`@@ -a,b +c,d @@`). */
export function parseHunks(diff: string): Hunk[] {
	return [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map(match => ({
		oldStart: Number(match[1]),
		oldCount: match[2] === undefined ? 1 : Number(match[2]),
		newStart: Number(match[3]),
		newCount: match[4] === undefined ? 1 : Number(match[4]),
	}));
}

/**
 * Does the diff touch the working-tree lines `start`..`end`? A hunk touches them when it changes a line in the range,
 * or deletes lines right inside it. A hunk above the range that adds or removes lines moves the range
 * (`shifted`): the numbers in the manifest no longer point at the same code.
 */
export function rangeChanges(hunks: Hunk[], start: number, end: number): { touched: boolean; shifted: number } {
	let touched = false;
	let shifted = 0;
	for (const hunk of hunks) {
		const first = hunk.newCount === 0 ? hunk.newStart + 1 : hunk.newStart;
		const last = hunk.newCount === 0 ? hunk.newStart : hunk.newStart + hunk.newCount - 1;
		if (hunk.newCount === 0 ? hunk.newStart >= start && hunk.newStart < end : first <= end && last >= start)
			touched = true;
		else if (last < start) shifted += hunk.newCount - hunk.oldCount;
	}
	return { touched, shifted };
}
