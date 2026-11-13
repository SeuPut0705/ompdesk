/**
 * The `chrome` module's window area (PROTOCOL.md §15.5): the shell makes every app window and owns its life (geometry,
 * chrome, first show, close to tray, crash recovery, the context menu, links, run progress); the shim adopts each one
 * (`win.adopted`), so main holds the same `BrowserWindow` it always did. What stays here is main's own bookkeeping of
 * its windows: each one's project folder and slot, the window user actions go to, and who hears a window close.
 */
import { BrowserWindow } from "electron";
import type { RunProgressState, SessionKind } from "../../../shared/ipc-types";
import type { WindowPresence } from "../../update-log-core";
import type { ClientWindow } from "../../web/client-window";
import { HostError } from "../client";
import { chrome } from "./chrome";

export interface WindowSpec {
	calls: {
		open: {
			params: { cwd: string; presence: WindowPresence | null };
			result: { winId: number; wcId: number; slot: number; mica: boolean };
		};
	};
	posts: {
		cwd: { winId: number; cwd: string };
		runProgress: { state: RunProgressState };
		closeToTray: { on: boolean };
	};
	events: {
		hiddenToTray: { winId: number };
	};
	asks: {
		spawn: { params: { cwd?: string }; result: { winId: number | null } };
	};
}

export interface WindowRecord {
	win: BrowserWindow;
	/** Stable id for routing/logging; equals win.webContents.id. */
	id: number;
	cwd: string;
	/** The window has the Mica backdrop: its renderer loads with `?mica=1` and lets it through. */
	mica: boolean;
	/**
	 * Creation order among the open windows (the lowest free number): a renderer loads with `?slot=N` and paints
	 * the tab strip its slot had last time before the tab list answers (renderer/lib/tab-snapshot.ts).
	 */
	slot: number;
}

/**
 * Spawn a window with its own sidecar (index.ts's pool-backed helper). With no
 * target it restores the saved session, else opens the GUI-owned workspace; an
 * explicit but empty cwd falls back to resolveInitialCwd. Neither path can land
 * on a bare process.cwd(), which is "/" for Finder-launched apps. `kind` is the
 * target session file's stamped kind (OPEN_NEW_WINDOW resolves it from the
 * session index); omitted = agent. `device` opens the window's tab on a paired
 * host, where `cwd` and `pendingSessionPath` are that host's paths. A session's window starts its tab on that file.
 */
export type SpawnWindow = (
	cwd?: string,
	pendingSessionPath?: string,
	kind?: SessionKind,
	device?: string,
) => Promise<BrowserWindow | null>;

export class WindowManager {
	#records = new Map<number, WindowRecord>();
	#windowClosedListeners = new Set<(record: WindowRecord) => void>();
	/** How windows created now first show (an update's relaunch restoring its windows); null: in front, as always. */
	launchPresence: WindowPresence | null = null;

	/**
	 * Subscribe to window teardown (tray aggregates, tab-layout persistence). A listener set rather than one slot
	 * because more than one consumer needs it — returns the unsubscribe function.
	 */
	subscribeWindowClosed(listener: (record: WindowRecord) => void): () => void {
		this.#windowClosedListeners.add(listener);
		return () => this.#windowClosedListeners.delete(listener);
	}

	/**
	 * Opens an app window in the shell, its page loading; resolves with the adopted `BrowserWindow`, or null when the
	 * shell refused because a quit is approved (it builds no window then, however late the open reached it).
	 */
	async createWindow(opts: { cwd: string }): Promise<BrowserWindow | null> {
		let made: WindowSpec["calls"]["open"]["result"];
		try {
			made = await chrome().call("open", { cwd: opts.cwd, presence: this.launchPresence });
		} catch (error) {
			if (error instanceof HostError && error.code === "quitting") return null;
			throw error;
		}
		const win = BrowserWindow.fromId(made.winId);
		if (!win) throw new Error(`chrome.open: window ${made.winId} was not adopted`);
		const record: WindowRecord = { win, id: made.wcId, cwd: opts.cwd, mica: made.mica, slot: made.slot };
		this.#records.set(record.id, record);
		win.once("closed", () => {
			this.#records.delete(record.id);
			for (const listener of this.#windowClosedListeners) listener(record);
		});
		return win;
	}

	recordFor(win: ClientWindow): WindowRecord | undefined {
		return this.#records.get(win.webContents.id);
	}

	/**
	 * Show+focus a window by its webContents id (the F-OWN focus pattern: opening an already-attached session
	 * foregrounds its owner window instead of spawning a duplicate). False when unknown or destroyed.
	 */
	focusWindowById(id: number): boolean {
		const record = this.#records.get(id);
		if (!record || record.win.isDestroyed()) return false;
		if (record.win.isMinimized()) record.win.restore();
		record.win.show();
		record.win.focus();
		return true;
	}

	/** Update a window's project dir (called when its sidecar switches project). */
	setRecordCwd(win: ClientWindow, cwd: string): void {
		const record = this.#records.get(win.webContents.id);
		if (!record) return;
		record.cwd = cwd;
		void chrome()
			.post("cwd", { winId: record.win.id, cwd })
			.catch(() => {});
	}

	getMainWindow(): BrowserWindow | null {
		for (const record of this.#records.values()) {
			if (!record.win.isDestroyed()) return record.win;
		}
		return null;
	}

	/** Window that should receive user-initiated actions: the focused window when it's one of ours, else the first. */
	getTargetWindow(): BrowserWindow | null {
		const focused = BrowserWindow.getFocusedWindow();
		if (focused && !focused.isDestroyed() && this.#records.has(focused.webContents.id)) return focused;
		return this.getMainWindow();
	}

	getAllWindows(): BrowserWindow[] {
		return [...this.#records.values()].map(r => r.win).filter(w => !w.isDestroyed());
	}

	/**
	 * Run-progress indicator (agent `terminal.showProgress` setting): Dock badge (● working, ! waiting — macOS only)
	 * plus a progress bar on every window; "idle" clears both.
	 */
	setRunProgress(state: RunProgressState): void {
		void chrome()
			.post("runProgress", { state })
			.catch(() => {});
	}
}

/** Settings › General › Window (`closeToTrayEnabled`): what closing the last shown window does on Windows. */
export function setCloseToTray(on: boolean): void {
	void chrome()
		.post("closeToTray", { on })
		.catch(() => {});
}

/** The last shown window hid instead of closing (the one-time "keeps running in the tray" notice). */
export function onHiddenToTray(listener: (winId: number) => void): () => void {
	return chrome().on("hiddenToTray", ({ winId }) => listener(winId));
}

/** The shell asks main for a window with its tab (menu, tray, deep links, a Dock click with none open). */
export function serveSpawn(spawn: (cwd?: string) => Promise<BrowserWindow | null>): void {
	chrome().serve("spawn", async ({ cwd }) => ({ winId: (await spawn(cwd))?.id ?? null }));
}
