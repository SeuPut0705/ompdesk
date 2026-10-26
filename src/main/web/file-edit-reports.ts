/**
 * What each paired web page last reported about unsaved edits in its Files editor. A page keeps its Files state
 * to itself, and main may close one of its tabs on an agent's behalf (`ompdesk_session_stop {close}`, the auto-close
 * pass) while the page is offline or never asked: so the page says, on every change and on every (re)connect, which
 * of its tabs holds the unsaved edits (a window has at most one), and main closes a tab only when the page's latest
 * word says it is clean. A page that has said nothing since this launch is `unreported`, never assumed clean.
 */
import type { ClientWindow } from "./client-window";

/** What a window's latest report says about one of its tabs. */
export type FileEdits = "clean" | "dirty" | "unreported";

export class FileEditReports {
	/** Window id → the tab whose Files editor holds unsaved edits (null = none); absent = no report yet. */
	readonly #dirtyTab = new Map<number, string | null>();
	readonly #listeners = new Set<() => void>();

	/** The page of `win` reports the tab its Files editor holds unsaved edits in, or null. */
	report(win: ClientWindow, dirtyTabId: string | null): void {
		const id = win.webContents.id;
		if (!this.#dirtyTab.has(id)) win.once("closed", () => this.#dirtyTab.delete(id));
		this.#dirtyTab.set(id, dirtyTabId);
		for (const listener of [...this.#listeners]) listener();
	}

	edits(windowId: number, tabId: string): FileEdits {
		if (!this.#dirtyTab.has(windowId)) return "unreported";
		return this.#dirtyTab.get(windowId) === tabId ? "dirty" : "clean";
	}

	/** Called after every report; returns the unsubscribe. */
	onReport(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
}
