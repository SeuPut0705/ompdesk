/**
 * What each live connection of a paired web page last reported about unsaved edits in its Files editor. A device
 * may hold up to four connections (browser tabs, a reload overlapping its predecessor) sharing ONE window, each with
 * its own Files state, so a report belongs to its connection and one page's fresh "nothing dirty" never erases
 * another's unsaved edit. Main may close one of the window's tabs on an agent's behalf (`ompdesk_session_stop
 * {close}`, the auto-close pass) while a page is offline or never asked: so a page says, on every change and on every
 * (re)connect, which of its tabs holds the unsaved edits (one per page), and main closes a tab only when no live
 * connection says it is dirty and at least one has reported. A window with no live reporting connection (none since
 * this launch, or every reporting one dropped) is `unreported`, never assumed clean.
 */
import type { ClientWindow } from "./client-window";

/** What a window's live reports say about one of its tabs. */
export type FileEdits = "clean" | "dirty" | "unreported";

/** The key of a caller with no connection id (an Electron window has one page). */
const NO_CONNECTION = "";

export class FileEditReports {
	/** Window id → connection id → the tab whose Files editor holds unsaved edits (null = none); absent = no report. */
	readonly #dirtyTab = new Map<number, Map<string, string | null>>();
	readonly #listeners = new Set<() => void>();
	/** Windows whose `closed` is already watched, so a later report adds no second listener. */
	readonly #watched = new Set<number>();

	/** The page behind `connId` (of `win`) reports the tab its Files editor holds unsaved edits in, or null. */
	report(win: ClientWindow, dirtyTabId: string | null, connId: string = NO_CONNECTION): void {
		const id = win.webContents.id;
		if (!this.#watched.has(id)) {
			this.#watched.add(id);
			win.once("closed", () => {
				this.#dirtyTab.delete(id);
				this.#watched.delete(id);
			});
		}
		const byConnection = this.#dirtyTab.get(id) ?? new Map<string, string | null>();
		this.#dirtyTab.set(id, byConnection);
		byConnection.set(connId, dirtyTabId);
		for (const listener of [...this.#listeners]) listener();
	}

	/**
	 * One connection ended: its report stays only as long as that page can still change it, and an offline page may
	 * edit a file main never hears about. Other connections' reports stand; with none left the window is `unreported`
	 * until a page reports again on its next connection.
	 */
	forget(windowId: number, connId: string = NO_CONNECTION): void {
		const byConnection = this.#dirtyTab.get(windowId);
		if (!byConnection) return;
		byConnection.delete(connId);
		if (byConnection.size === 0) this.#dirtyTab.delete(windowId);
	}

	edits(windowId: number, tabId: string): FileEdits {
		const byConnection = this.#dirtyTab.get(windowId);
		if (!byConnection || byConnection.size === 0) return "unreported";
		for (const dirtyTab of byConnection.values()) if (dirtyTab === tabId) return "dirty";
		return "clean";
	}

	/** Called after every report; returns the unsubscribe. */
	onReport(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
}
