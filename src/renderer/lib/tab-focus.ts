/**
 * Focus follows a session activation. ⌃Tab, a click on a sidebar row, New session and ⌘T all change which session
 * the window shows, and the control that had focus (the outgoing composer, hidden now; the sidebar button just
 * clicked) is the wrong place for the next keystroke: characters typed straight after went nowhere. Once React has
 * committed the new pane, the composer takes focus, but only when focus is on `<body>`, on a button inside the
 * sidebar or in a pane that is no longer the active one, so the terminal, the files editor or a text field the user
 * is typing in (a row's rename box) is never robbed. A dialog is never robbed either: the ⌃Tab switcher is one that
 * is still closing a frame after it switched, so the take waits a few frames for a dialog to go (or for the new pane's
 * field to exist) and gives up after that. A touch device keeps the keyboard down: focusing a field there would raise it.
 */
import { TOUCH_QUERY } from "../hooks/use-shell-mode";
import { useSessionStore } from "../stores/session";
import { useTabsStore } from "../stores/tabs";
import { useUiStore } from "../stores/ui";
import { activeComposerInput } from "./composer-focus";

const TEXT_ENTRY = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
/** A dialog, or the overlay of one still fading out (`Modal` drops its role then but keeps the focus trap in the DOM). */
const DIALOG = '[role="dialog"], dialog[open], .omp-dialog-overlay';
/** Half a second for a closing dialog to leave (`Modal` unmounts 150 ms after it closes), or the new pane's field to be there to focus. Counted in time: a 240 Hz display draws 30 frames before that exit ends. */
const RETRY_MS = 500;

/** Whether the element holding focus is one the composer may take it from. */
export function focusIsAdrift(active: Element | null): boolean {
	if (!active || active === document.body) return true;
	if (active.closest('.omp-session-pane[data-active="false"]')) return true;
	return active.closest(".omp-session-sidebar") !== null && !active.matches(TEXT_ENTRY);
}

/** "take" now, "wait" for a dialog to close, or "leave" focus where the user has it. */
function verdict(): "take" | "wait" | "leave" {
	if (typeof matchMedia === "function" && matchMedia(TOUCH_QUERY).matches) return "leave";
	if (useUiStore.getState().destination !== "session") return "leave";
	if (document.querySelector(DIALOG)) return "wait";
	return focusIsAdrift(document.activeElement) ? "take" : "leave";
}

/** Returns the unsubscribe. */
export function followActivationFocus(): () => void {
	let frame = 0;
	/** A hand-off is waiting for its frame. */
	let pending = false;
	/** Hand focus over now: true once it is where it should be (or should stay where it is). */
	const take = (): "done" | "again" => {
		const decision = verdict();
		if (decision === "leave") return "done";
		if (decision === "take") {
			const field = activeComposerInput();
			field?.focus();
			if (field && document.activeElement === field) return "done";
		}
		return "again";
	};
	const schedule = () => {
		cancelAnimationFrame(frame);
		pending = true;
		let started: number | null = null;
		// After React commits the pane (its `data-active` and field), as `omp:fill-composer` waits a frame.
		const attempt = (now: number) => {
			if (!pending) return;
			started ??= now;
			if (take() === "done" || now - started >= RETRY_MS) {
				pending = false;
				return;
			}
			frame = requestAnimationFrame(attempt);
		};
		frame = requestAnimationFrame(attempt);
	};
	// A key typed before that frame (a person typing straight after ⌘T, or a window whose frames run late) would land
	// in the hidden pane's composer or on <body>: hand focus over first, so the character lands in the new composer
	// (nightly 39516053875, composer-flows: "second tab text" read "econd tab text").
	const onKeyDown = (event: KeyboardEvent) => {
		if (!pending || event.ctrlKey || event.metaKey || event.altKey) return;
		if (!((event.key.length === 1 && event.key !== " ") || event.key === "Process")) return;
		if (take() === "done") {
			pending = false;
			cancelAnimationFrame(frame);
		}
	};
	window.addEventListener("keydown", onKeyDown, true);
	const stopTabs = useTabsStore.subscribe((next, previous) => {
		if (next.activeTabId && next.activeTabId !== previous.activeTabId) schedule();
	});
	// New session in an untouched tab, the session picker: the tab stays, its session changes. "" is "none yet".
	const stopSession = useSessionStore.subscribe((next, previous) => {
		if (previous.sessionId && next.sessionId && next.sessionId !== previous.sessionId) schedule();
	});
	return () => {
		cancelAnimationFrame(frame);
		window.removeEventListener("keydown", onKeyDown, true);
		stopTabs();
		stopSession();
	};
}
