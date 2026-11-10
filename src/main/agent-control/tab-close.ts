/**
 * How main closes a tab for an agent (`AgentControl.#closeTab`: `ompdesk_session_stop {close}`, the auto-close pass,
 * a failed open's cleanup, Autopilot's source tab). The one place that decides between asking the tab's window,
 * releasing it in main and keeping it; every close path goes through it.
 *
 * A desktop window closes its own tab when asked and refuses one in use, with unsaved Files edits or its last. A
 * paired web page's window may have no socket (the ask would be dropped), so main releases that tab itself, unless a
 * live connection of the page reported unsaved Files edits in it (`FileEditReports`) or the person is at it and the
 * close was not cleared by `needsPersonTurn` (`ompdesk_session_stop` checked it). A page that is offline or has said
 * nothing since launch (`unreported`) does not hold the tab: the user's rule is that a finished child closes.
 */
import type { FileEdits } from "../web/file-edit-reports";

export interface TabCloseFacts {
	/** Only on a paired web page's tab: what its page's live connections report (`FileEditReports.edits`). */
	webEdits?: FileEdits;
	/** The person is looking at it. */
	looked?: boolean;
	/** The person typed into it or prompted it. */
	userTouched?: boolean;
}

export type TabCloseStep =
	/** A desktop window's tab: its renderer closes it, and applies its own guards. */
	| { action: "ask-window" }
	/** A paired web page's tab: main releases it as the page's own close would. */
	| { action: "release" }
	/** `dirty`: a live connection of its page reported unsaved Files edits in it; `in-use`: the person is at it. */
	| { action: "keep"; reason: "dirty" | "in-use" };

/**
 * Whether stopping, closing or deleting `tab` needs a turn the person's own message started (the user's rule). A
 * session the person typed into always does: their own words are in it. One they only look at does unless the
 * caller opened it (`own`): an agent's own session is never held back because the person watches it.
 */
export function needsPersonTurn(tab: TabCloseFacts, own: boolean): boolean {
	return tab.userTouched === true || (!own && tab.looked === true);
}

/** `cleared`: the in-use rule was checked for this close and lets it go (`needsPersonTurn`, or the person asked). */
export function tabCloseStep(tab: TabCloseFacts, cleared = false): TabCloseStep {
	if (tab.webEdits === undefined) return { action: "ask-window" };
	if (tab.webEdits === "dirty") return { action: "keep", reason: "dirty" };
	if (!cleared && needsPersonTurn(tab, false)) return { action: "keep", reason: "in-use" };
	return { action: "release" };
}
