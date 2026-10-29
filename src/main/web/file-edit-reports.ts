/**
 * What each live connection of a paired web page last reported about unsaved edits in its Files editor. A report
 * belongs to the connection that sent it (`IpcCaller.connId`, a fresh UUID per socket), never to the window: a device
 * may hold up to four connections (browser tabs, a reload overlapping its predecessor) sharing ONE window, each with
 * its own Files state, so one page's fresh "nothing dirty" never erases another's unsaved edit. A connection's report
 * stands until that connection ends (`WsRouter` `onConnectionEnded`, which also ends every connection of a device
 * before its window goes); an offline page may edit a file main never hears about, so its old word stops counting.
 * The page reports on every change and on every (re)connect (`FileEditReporter`).
 *
 * `edits` is what an agent's close reads (`tabCloseStep`): `dirty` when a live connection names the tab, `clean` when
 * some live connection reported and none names it, `unreported` when none has (none since this launch, or every
 * reporting one dropped), never assumed clean.
 */

/** What a window's live reports say about one of its tabs. */
export type FileEdits = "clean" | "dirty" | "unreported";

interface Report {
	windowId: number;
	/** The tab whose Files editor holds unsaved edits, null for none (a page has at most one). */
	dirtyTabId: string | null;
}

export class FileEditReports {
	/** Connection id → its latest report; absent = that connection has not reported, or ended. */
	readonly #byConnection = new Map<string, Report>();
	readonly #listeners = new Set<() => void>();

	/** The page behind `connId`, a connection of window `windowId`, reports the tab holding its unsaved edits, or null. */
	report(windowId: number, connId: string, dirtyTabId: string | null): void {
		this.#byConnection.set(connId, { windowId, dirtyTabId });
		for (const listener of [...this.#listeners]) listener();
	}

	/** The connection ended: its report no longer counts (other connections' reports stand). Tells no listener. */
	forget(connId: string): void {
		this.#byConnection.delete(connId);
	}

	edits(windowId: number, tabId: string): FileEdits {
		let reported = false;
		for (const report of this.#byConnection.values()) {
			if (report.windowId !== windowId) continue;
			if (report.dirtyTabId === tabId) return "dirty";
			reported = true;
		}
		return reported ? "clean" : "unreported";
	}

	/** Called after every report; returns the unsubscribe. */
	onReport(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
}
