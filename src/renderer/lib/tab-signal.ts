import type { SessionTab } from "../stores/tabs";

export interface TabSignalPresentation {
	active: boolean;
	color: string;
	labelKey: string;
	running: boolean;
}

/**
 * The tab's `error` is a session another omp still holds: a wait that ends by itself (the tab opens the session once
 * that omp lets go), never a failure. The one rule every surface reads (row, pane header, child rows, work tree, tray).
 */
export function isSessionHeld(tab: { status: string; sessionHeld?: boolean }): boolean {
	return tab.status === "error" && tab.sessionHeld === true;
}

/** The tab failed: an `error` that is no held session. */
export function isTabFailed(tab: { status: string; sessionHeld?: boolean }): boolean {
	return tab.status === "error" && !isSessionHeld(tab);
}

/** A tab's signal; any tab-shaped state works (the sidebar's row of a paired device's tab on this computer too). */
export function tabSignalPresentation(
	tab: Pick<SessionTab, "status" | "compacting" | "awaitingInput" | "unreadDone" | "sessionHeld">,
	activeRuntime = false,
): TabSignalPresentation {
	const running = tab.status === "running" || tab.compacting === true || activeRuntime;
	// A session blocked on the user outranks "running": it needs the user, not just time.
	if (tab.awaitingInput) {
		const labelKey = tab.awaitingInput === "approval" ? "sidebar.row.needsApproval" : "sidebar.row.needsInput";
		return { active: true, color: "var(--omp-warning)", labelKey, running };
	}
	if (running) {
		return { active: true, color: "var(--omp-accent)", labelKey: "titlebar.status.working", running: true };
	}
	if (tab.unreadDone) {
		return { active: false, color: "var(--omp-success)", labelKey: "tabs.done", running: false };
	}
	if (tab.status === "ready") {
		return { active: false, color: "var(--omp-dim)", labelKey: "titlebar.status.ready", running: false };
	}
	// Another omp still holds the session: the tab opens it by itself, a wait like connecting, never a failure.
	if (tab.status === "starting" || isSessionHeld(tab)) {
		const labelKey = tab.status === "starting" ? "titlebar.status.connecting" : "titlebar.status.sessionHeld";
		return { active: true, color: "var(--omp-warning)", labelKey, running: false };
	}
	// A restored tab whose process has not been spawned yet, or a tab waiting for
	// omp while machine setup installs it. Inert, not a warning: nothing is wrong.
	if (tab.status === "asleep" || tab.status === "waiting") {
		return { active: false, color: "var(--omp-dim)", labelKey: `titlebar.status.${tab.status}`, running: false };
	}
	return {
		active: tab.status === "restarting",
		color: tab.status === "error" || tab.status === "exited" ? "var(--omp-error)" : "var(--omp-warning)",
		labelKey: `titlebar.status.${tab.status}`,
		running: false,
	};
}
