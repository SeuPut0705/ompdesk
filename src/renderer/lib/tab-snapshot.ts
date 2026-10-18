/**
 * The tab strip as of the last run (`lib/snapshot-cache.ts`, kind `tabs`): which tabs a window had, which one was
 * active. The tab store starts from it, so the first frame shows the strip, the selected row in the sidebar and
 * (through `lib/transcript-snapshot.ts`) the active tab's last rows, before `tabs.list` answers. Those tabs are
 * ghosts: a guess about who is there, never a live tab. The tab list's answer adopts each ghost into the real tab
 * of the same session (same place, same selection, nothing moves) and drops the ones nobody claims.
 *
 * One entry per window slot (main's `?slot=`, the creation order of the windows: a relaunch restores them in that
 * order), so a second window never paints the first one's tabs. A web page has the one slot `web`.
 */
import type { IpcTabWorktree, SessionKind } from "../../shared/ipc-types";
import { snapshotNs, snapshots } from "./snapshot-cache";

/** What of a tab is worth guessing: who it is and what it is called; never its live status. */
export interface TabSnapshotEntry {
	id: string;
	cwd: string;
	kind: SessionKind;
	title?: string;
	task?: string;
	sessionPath?: string;
	sessionId?: string;
	device?: string;
	worktree?: IpcTabWorktree;
	placeholder?: boolean;
	openedBy?: string;
	openedBySession?: string;
}

export interface TabSnapshot {
	tabs: TabSnapshotEntry[];
	activeTabId: string | null;
}

/** A window's tabs are few; a runaway list is not a tab strip. */
const MAX_TABS = 60;
const WRITE_DELAY_MS = 500;

function windowSlot(): string {
	try {
		return new URLSearchParams(window.location.search).get("slot") ?? "0";
	} catch {
		return "0";
	}
}

export function readTabSnapshot(): TabSnapshot | null {
	const hit = snapshots().read<TabSnapshot>("tabs", snapshotNs(undefined), windowSlot());
	const value = hit?.value;
	if (!value || !Array.isArray(value.tabs) || value.tabs.length === 0) return null;
	const tabs = value.tabs.filter(tab => tab && typeof tab.id === "string" && typeof tab.cwd === "string");
	if (tabs.length === 0) return null;
	const activeTabId = tabs.some(tab => tab.id === value.activeTabId) ? value.activeTabId : (tabs[0]?.id ?? null);
	return { tabs, activeTabId };
}

let timer: ReturnType<typeof setTimeout> | undefined;

/** Remember the strip after a quiet moment; `produce` reads it then (a drag or a burst of pushes writes once). */
export function rememberTabs(produce: () => TabSnapshot | null): void {
	clearTimeout(timer);
	timer = setTimeout(() => {
		const value = produce();
		if (value && value.tabs.length > 0) snapshots().write("tabs", snapshotNs(undefined), windowSlot(), value);
	}, WRITE_DELAY_MS);
}

export function tabSnapshotEntry(tab: TabSnapshotEntry): TabSnapshotEntry {
	return {
		id: tab.id,
		cwd: tab.cwd,
		kind: tab.kind,
		...(tab.title === undefined ? {} : { title: tab.title }),
		...(tab.task === undefined ? {} : { task: tab.task }),
		...(tab.sessionPath === undefined ? {} : { sessionPath: tab.sessionPath }),
		...(tab.sessionId === undefined ? {} : { sessionId: tab.sessionId }),
		...(tab.device === undefined ? {} : { device: tab.device }),
		...(tab.worktree === undefined ? {} : { worktree: tab.worktree }),
		...(tab.placeholder === undefined ? {} : { placeholder: tab.placeholder }),
		...(tab.openedBy === undefined ? {} : { openedBy: tab.openedBy }),
		...(tab.openedBySession === undefined ? {} : { openedBySession: tab.openedBySession }),
	};
}

export function limitTabs<T>(tabs: T[]): T[] {
	return tabs.length > MAX_TABS ? tabs.slice(0, MAX_TABS) : tabs;
}
