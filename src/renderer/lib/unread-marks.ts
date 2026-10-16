/**
 * A device's own "done" marks (design §5.7: unread is per device). A tab's done mark is raised when a run
 * settles while the tab is out of view, in the page's memory; a phone page the browser discarded, or reloaded
 * after a reconnect, would lose it, and so would a run that finished while the page was away. A web page keeps
 * two lists in its own storage: the tabs with a mark, and the tabs that were running when it last looked. On
 * the next load a marked tab is still marked, and a tab that was running and no longer is finished unseen.
 * The desktop keeps its marks in memory only, as before.
 */
export const UNREAD_MARKS_KEY = "omp.web.unread";

export interface UnreadMarks {
	/** Tab ids with a done mark. */
	unread: string[];
	/** Tab ids that were running at the last save. */
	running: string[];
}

type MarkStorage = Pick<Storage, "getItem" | "setItem">;

function ids(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function readUnreadMarks(storage: MarkStorage | null = browserStorage()): UnreadMarks {
	try {
		const raw = storage?.getItem(UNREAD_MARKS_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : null;
		if (typeof parsed !== "object" || parsed === null) return { unread: [], running: [] };
		const record = parsed as Record<string, unknown>;
		return { unread: ids(record.unread), running: ids(record.running) };
	} catch {
		return { unread: [], running: [] };
	}
}

export function writeUnreadMarks(marks: UnreadMarks, storage: MarkStorage | null = browserStorage()): void {
	try {
		storage?.setItem(UNREAD_MARKS_KEY, JSON.stringify(marks));
	} catch {
		// Private mode or a full quota: the marks then live only in memory, as on the desktop.
	}
}

/** Whether a tab the page has just learned of is marked: it was marked, or it ran and is idle now. */
export function restoredUnread(marks: UnreadMarks, tabId: string, running: boolean): boolean {
	return marks.unread.includes(tabId) || (marks.running.includes(tabId) && !running);
}

function browserStorage(): MarkStorage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}
