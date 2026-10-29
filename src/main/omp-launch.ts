/**
 * How a tab's omp is launched: which session it opens. One rule for every spawn of a tab, whoever starts it (a new tab,
 * a stored session, a relaunch's saved tab, a paired device's tab, an omp update, a crash, machine setup, the desktop
 * slot), so no path can open another session than the one the tab is on.
 */
import { existsSync } from "node:fs";

/** What a tab knows about its session before a spawn. */
export interface TabSession {
	/** The session the tab is on: the file it was asked to open, then the one its omp reported (`get_state`). */
	readonly path: string | null;
	/** A new tab that has not booted yet: stock's `autoResume` must not reopen another session in its folder. */
	readonly isNew: boolean;
}

/** `{ session }`: `--session <file>`; `new`: a new session in the folder (`autoResume` pinned off); `default`: omp's own. */
export type SessionOpen = { readonly session: string } | "new" | "default";

/**
 * A written session is reopened. A session stock never wrote (it writes a new session's file at the first answer:
 * a tab restored or restarted before its first turn ended) opens nothing, and `--session` on it only fails ("Session
 * not found"), so the tab starts a new session in its folder, as a new tab does. Only a tab with no session at all (it
 * moved to another folder) leaves the choice to omp.
 */
export function sessionOpen(tab: TabSession, written: (path: string) => boolean = existsSync): SessionOpen {
	if (tab.path && written(tab.path)) return { session: tab.path };
	return tab.isNew || tab.path ? "new" : "default";
}
