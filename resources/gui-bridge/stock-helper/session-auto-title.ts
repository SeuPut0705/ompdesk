/**
 * The automatic title a session list row shows beside a name the person typed (`SessionInfo.autoTitle`, rule
 * `shownAutoTitle` in modes/auto-title-contracts.ts). Stock's listing reads only a journal's head; the automatic title
 * is wherever the bridge last journaled it (`ompdesk.auto-title`, or stock's own automatic `title_change` before the
 * rename). Only a journal whose title slot says the person set the name is read, and each journal once: later calls
 * read only what was appended since (stock appends; the slot on the first line is rewritten in place at the same
 * width). A journal shorter than what was read was rewritten (a move, a compaction's copy) and is read again.
 */
import { open } from "node:fs/promises";
import {
	AUTO_TITLE_ENTRY,
	isAutomaticTitle,
	shownAutoTitle,
	type TitleJournalEntry,
} from "../modes/auto-title-contracts";

/** How much of a journal's start holds stock's title slot (one fixed-width line). */
const SLOT_BYTES = 2048;
/** Each read of the part of a journal not read yet. */
const CHUNK_BYTES = 1024 * 1024;

interface Scan {
	/** Bytes read so far: the end of the last whole line. */
	offset: number;
	/** The newest `title_change` and the newest automatic title, in journal order: all `shownAutoTitle` needs. */
	entries: TitleJournalEntry[];
}

/** Per journal: the listing's stamp it was read at, what it showed, and how far it was read (typed names only). */
interface Known {
	stamp: string;
	title: string | undefined;
	scan?: Scan;
}

const known = new Map<string, Known>();

/** Whether stock's title slot (the journal's first line) says the person set the name. */
function slotIsTyped(head: string): boolean {
	const end = head.indexOf("\n");
	try {
		const slot: unknown = JSON.parse(end < 0 ? head : head.slice(0, end));
		return typeof slot === "object" && slot !== null && "type" in slot && slot.type === "title" && "source" in slot
			? slot.source === "user"
			: false;
	} catch {
		return false;
	}
}

const text = (record: object, key: string): string | undefined => {
	const value: unknown = Reflect.get(record, key);
	return typeof value === "string" ? value : undefined;
};

/** A `title_change` or an `ompdesk.auto-title` line as the title rules read it; undefined for any other line. */
function relevant(line: string): TitleJournalEntry | undefined {
	if (!line.includes('"title_change"') && !line.includes(AUTO_TITLE_ENTRY)) return undefined;
	let entry: unknown;
	try {
		entry = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof entry !== "object" || entry === null) return undefined;
	const type = text(entry, "type");
	if (type === "title_change")
		return { type, title: text(entry, "title"), source: text(entry, "source"), trigger: text(entry, "trigger") };
	if (type === "custom" && text(entry, "customType") === AUTO_TITLE_ENTRY)
		return { type, customType: AUTO_TITLE_ENTRY, data: Reflect.get(entry, "data") };
	return undefined;
}

/** Keep the newest `title_change` and the newest automatic title, in order: all `shownAutoTitle` reads. */
function reduce(entries: readonly TitleJournalEntry[]): TitleJournalEntry[] {
	const change = entries.findLastIndex(entry => entry.type === "title_change");
	const auto = entries.findLastIndex(isAutomaticTitle);
	return entries.filter((_, i) => i === change || i === auto);
}

/**
 * The row's automatic title beside a typed name, or undefined. `size` is the journal's size the listing saw, `stamp`
 * its `modified:size`: an unchanged journal is not opened again.
 */
export async function listedAutoTitle(path: string, size: number, stamp: string): Promise<string | undefined> {
	const before = known.get(path);
	if (before?.stamp === stamp) return before.title;
	const file = await open(path, "r");
	try {
		const head = Buffer.alloc(Math.min(SLOT_BYTES, size));
		const { bytesRead } = await file.read(head, 0, head.length, 0);
		if (!slotIsTyped(head.toString("utf8", 0, bytesRead))) {
			known.set(path, { stamp, title: undefined });
			return undefined;
		}
		const previous = before?.scan && before.scan.offset <= size ? before.scan : { offset: 0, entries: [] };
		const found = [...previous.entries];
		let carry = "";
		let position = previous.offset;
		while (position < size) {
			const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, size - position));
			const read = await file.read(chunk, 0, chunk.length, position);
			if (read.bytesRead === 0) break;
			position += read.bytesRead;
			const lines = carry + chunk.toString("utf8", 0, read.bytesRead);
			const end = lines.lastIndexOf("\n");
			carry = end < 0 ? lines : lines.slice(end + 1);
			if (end < 0) continue;
			for (const line of lines.slice(0, end).split("\n")) {
				const entry = relevant(line);
				if (entry) found.push(entry);
			}
		}
		// A last line without its newline is still being written: read again from its start next time.
		const scan = { offset: position - Buffer.byteLength(carry), entries: reduce(found) };
		const title = shownAutoTitle(scan.entries);
		known.set(path, { stamp, title, scan });
		return title;
	} finally {
		await file.close();
	}
}

/** Forget the journals no longer listed. */
export function forgetAutoTitles(listed: ReadonlySet<string>): void {
	for (const path of known.keys()) if (!listed.has(path)) known.delete(path);
}
