/**
 * When a stored session last did something: the time of the newest conversation message in its journal. Stock lists
 * a session's `modified` as the file's mtime, and every relaunch appends to a file that did nothing: the quit's
 * `session_exit`, an idle recap, a title or usage entry, a report or restart notice (custom messages), the
 * interrupted-turn record a restore writes. Each moved a three-day-old session to "just now" in the sidebar.
 *
 * Only `message` entries count (user, assistant, tool results, shell runs: what the conversation holds), at the
 * message's own `timestamp`, which stock keeps as when it happened: its interrupted-turn record carries the time the
 * turn was cut, not the relaunch that journaled it. The journal is read from its end, a growing window at a time up
 * to `ACTIVITY_READ_LIMIT`, never the whole file; past that (a message line bigger than the limit) the row keeps
 * stock's mtime.
 */
import { open } from "node:fs/promises";

/** The first window read from a journal's end; most journals end within it. */
const FIRST_WINDOW = 64 * 1024;
/** The most read from the end before falling back to the file's mtime (a message line bigger than this). */
export const ACTIVITY_READ_LIMIT = 4 * 1024 * 1024;
/** How stock writes a message entry: its type is the first key of the line. */
const MESSAGE_LINE = '{"type":"message"';

function timeOf(line: string): number | undefined {
	try {
		const entry = JSON.parse(line) as { timestamp?: unknown; message?: { timestamp?: unknown } };
		const own = entry.message?.timestamp;
		if (typeof own === "number" && Number.isFinite(own)) return own;
		const journaled = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
		return Number.isFinite(journaled) ? journaled : undefined;
	} catch {
		// A line still being written (no newline yet) is not the newest finished message.
		return undefined;
	}
}

/**
 * The newest message's time in `text`, the end of a journal. `whole`: the text starts at the file's start, so its
 * first line is complete too; otherwise the first line is cut and is not read. A line that does not parse (the last
 * one, still being written) is skipped.
 */
export function lastMessageTime(text: string, whole: boolean): number | undefined {
	const lines = text.split("\n");
	for (let index = lines.length - 1; index >= (whole ? 0 : 1); index--) {
		const line = lines[index]!;
		if (!line.startsWith(MESSAGE_LINE)) continue;
		const time = timeOf(line);
		if (time !== undefined) return time;
	}
	return undefined;
}

/** The newest message's time of the journal at `path` (`size` bytes long), or null when none was found in reach. */
export async function lastActivity(path: string, size: number): Promise<number | null> {
	const file = await open(path, "r");
	try {
		for (let window = FIRST_WINDOW; ; window *= 4) {
			const start = Math.max(0, size - Math.min(window, ACTIVITY_READ_LIMIT));
			const buffer = Buffer.alloc(size - start);
			const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
			const time = lastMessageTime(buffer.toString("utf8", 0, bytesRead), start === 0);
			if (time !== undefined) return time;
			if (start === 0 || window >= ACTIVITY_READ_LIMIT) return null;
		}
	} finally {
		await file.close();
	}
}
