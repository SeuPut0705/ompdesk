/**
 * How main closes a tab for an agent (`AgentControl.#closeTab`: `ompdesk_session_stop {close}`, the auto-close pass,
 * a failed open's cleanup, Autopilot's source tab). The one place that decides between asking the tab's window,
 * releasing it in main and keeping it; every close path goes through it.
 *
 * A desktop window closes its own tab when asked and refuses one in use, with unsaved Files edits or its last. A
 * paired web page's window may have no socket (the ask would be dropped), so main releases that tab itself, unless a
 * live connection of the page reported unsaved Files edits in it (`FileEditReports`) or the person is at it. A page
 * that is offline or has said nothing since launch (`unreported`) does not hold the tab: the user's rule is that a
 * finished child closes.
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

export function tabCloseStep(tab: TabCloseFacts): TabCloseStep {
	if (tab.webEdits === undefined) return { action: "ask-window" };
	if (tab.webEdits === "dirty") return { action: "keep", reason: "dirty" };
	if (tab.looked || tab.userTouched) return { action: "keep", reason: "in-use" };
	return { action: "release" };
}
