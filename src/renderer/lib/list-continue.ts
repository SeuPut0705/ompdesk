/**
 * Markdown list continuation for the chat composer: when a newline is inserted
 * on a list item, the new line starts with the same indent and bullet (numbers
 * incremented, task boxes reset). A newline on an empty item ends the list.
 *
 * Pure: the caller applies the returned edit through the browser's own text
 * insertion so native undo keeps working.
 */

/** Replace `text.slice(from, to)` with `insert`, then put the caret at `caret`. */
export interface ListEdit {
	from: number;
	to: number;
	insert: string;
	caret: number;
}

/** indent, bullet or `N.` / `N)`, spaces after it, optional task box (+ its trailing space). */
const ITEM = /^([ \t]*)([*+-]|\d{1,9}[.)])([ \t]+)(\[[ xX]\](?:[ \t]+|$))?/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** True when the line starting at `lineStart` lies inside a fenced code block opened on an earlier line. */
export function insideCodeFence(text: string, lineStart: number): boolean {
	let open: { char: string; length: number } | null = null;
	let at = 0;
	while (at < lineStart) {
		const next = text.indexOf("\n", at);
		const line = text.slice(at, next === -1 ? text.length : next);
		const fence = FENCE.exec(line);
		if (fence) {
			const run = fence[1] as string;
			if (open === null) open = { char: run[0] as string, length: run.length };
			else if (run[0] === open.char && run.length >= open.length && line.slice(fence[0].length).trim() === "")
				open = null;
		}
		if (next === -1) break;
		at = next + 1;
	}
	return open !== null;
}

/**
 * The edit a newline at `start..end` should make, or null when the plain newline stands
 * (not a list item, caret inside the bullet, inside a code fence).
 */
export function continueList(text: string, start: number, end: number = start): ListEdit | null {
	if (start < 0 || end < start || end > text.length) return null;
	const lineStart = text.lastIndexOf("\n", start - 1) + 1;
	const nextBreak = text.indexOf("\n", end);
	const lineEnd = nextBreak === -1 ? text.length : nextBreak;
	// A selection spanning lines is replaced by a plain newline.
	if (text.indexOf("\n", start) !== -1 && text.indexOf("\n", start) < end) return null;
	const line = text.slice(lineStart, lineEnd);
	const item = ITEM.exec(line);
	if (!item) return null;
	const markerEnd = lineStart + item[0].length;
	if (start < markerEnd) return null;
	if (insideCodeFence(text, lineStart)) return null;

	const empty = line.slice(item[0].length).trim() === "";
	if (empty && end === lineEnd) {
		// Nothing after the bullet: drop the bullet and indent, ending the list.
		return { from: lineStart, to: lineEnd, insert: "", caret: lineStart };
	}

	const indent = item[1] as string;
	const bullet = item[2] as string;
	const gap = item[3] as string;
	const next = /^\d/.test(bullet) ? `${Number.parseInt(bullet, 10) + 1}${bullet.slice(-1)}` : bullet;
	const box = item[4] === undefined ? "" : "[ ] ";
	const insert = `\n${indent}${next}${gap}${box}`;
	return { from: start, to: end, insert, caret: start + insert.length };
}
