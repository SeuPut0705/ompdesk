/**
 * A file chooser the page opened, from the input's click until the files it handed over have landed (the
 * caller says so) or it was dismissed. A phone's picker is another app: the page is hidden while it is in front
 * and comes back just before the input's `change`. Whatever the page does on that return (web-boot.ts: a reload
 * to load state it missed while hidden, an update) must wait while a pick is in progress, or the picked files
 * are dropped with the page (web/safe-moment.ts reads {@link filePickInProgress}).
 *
 * A browser without the input's `cancel` event (older than Chrome 113 / Safari 16.4) never says a pick was
 * dismissed: the pick then ends once the page has been back in the foreground for {@link PICK_RETURN_GRACE_MS}
 * without a `change`.
 */

/** How long the page may be back in front of a dismissed chooser that never fired `cancel`. */
export const PICK_RETURN_GRACE_MS = 3000;

const open = new Set<object>();

/** A file chooser is open, or the files it handed over are still on their way into the page. */
export function filePickInProgress(): boolean {
	return open.size > 0;
}

/**
 * Track the chooser `input` is about to open (call just before `input.click()`). The returned `done` ends the
 * pick; call it once its files have landed. A `cancel` ends it at once.
 */
export function trackFilePick(input: HTMLInputElement, view: Window = window): () => void {
	const pick = {};
	open.add(pick);
	let grace: ReturnType<typeof setTimeout> | undefined;
	const doc = view.document;
	const back = () => {
		clearTimeout(grace);
		if (doc.visibilityState === "visible" && doc.hasFocus?.() !== false)
			grace = setTimeout(done, PICK_RETURN_GRACE_MS);
	};
	const away = () => clearTimeout(grace);
	// Files arrived: the caller ends the pick when they have landed, however long that takes.
	const changed = () => {
		clearTimeout(grace);
		view.removeEventListener("focus", back);
		view.removeEventListener("blur", away);
		doc.removeEventListener("visibilitychange", back);
	};
	function done() {
		changed();
		input.removeEventListener("change", changed);
		input.removeEventListener("cancel", done);
		open.delete(pick);
	}
	input.addEventListener("change", changed);
	input.addEventListener("cancel", done);
	view.addEventListener("focus", back);
	view.addEventListener("blur", away);
	doc.addEventListener("visibilitychange", back);
	return done;
}
