/**
 * A folded paste's `[Paste #N, +L lines]` marker is one unit in the field (DI-3), as it is in the TUI editor: a
 * Backspace/Delete (word and line deletes included) that touches any part of it takes all of it, as one edit.
 * This plans what the browser would delete for such a key, so the caller can widen it to whole markers.
 */
import { PLATFORM } from "../../../lib/keymap";

export interface DeleteKey {
	key: string;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
}

const isSpace = (char: string | undefined): boolean => char !== undefined && /\s/.test(char);

/** Start of the word before `at`: whitespace, then the run of non-space before it. */
function wordStart(value: string, at: number): number {
	let index = at;
	while (index > 0 && isSpace(value[index - 1])) index--;
	while (index > 0 && !isSpace(value[index - 1])) index--;
	return index;
}

/** End of the word after `at`. */
function wordEnd(value: string, at: number): number {
	let index = at;
	while (index < value.length && isSpace(value[index])) index++;
	while (index < value.length && !isSpace(value[index])) index++;
	return index;
}

/**
 * The range a Backspace/Delete press removes from `value` with the selection `[start, end)`, as near as can be told
 * before the browser acts (a word is the run of non-space text; a line ends at a newline). Null for any other key.
 */
export function plannedDeletion(
	value: string,
	start: number,
	end: number,
	key: DeleteKey,
	platform: string = PLATFORM,
): { from: number; to: number } | null {
	if (key.key !== "Backspace" && key.key !== "Delete") return null;
	// Shift+Delete is Cut on Windows and Linux; its selection is removed whole whatever it touches.
	if (key.shiftKey && key.key === "Delete") return start === end ? null : { from: start, to: end };
	if (start !== end) return { from: start, to: end };
	const mac = platform === "mac";
	const word = mac ? key.altKey : key.ctrlKey;
	const line = mac && key.metaKey;
	if (key.key === "Backspace") {
		const from = line ? value.lastIndexOf("\n", start - 1) + 1 : word ? wordStart(value, start) : start - 1;
		return from < start && from >= 0 ? { from, to: start } : null;
	}
	const newline = value.indexOf("\n", start);
	const to = line ? (newline === -1 ? value.length : newline) : word ? wordEnd(value, start) : start + 1;
	return to > start && to <= value.length ? { from: start, to } : null;
}
