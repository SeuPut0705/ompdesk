/**
 * A page, a Settings section or a panel view that replaces another cross-fades through the View Transitions API
 * where the browser has it (Chromium 111+, Safari 18+), so the swap is one short opacity fade of the whole view
 * instead of a cut and a content pop-in. Everywhere it would cost or confuse it is a plain, instant update:
 * reduced motion, software compositing (`html[data-gpu="software"]`), a hidden document, a browser without the
 * API, and a swap inside a running transition. The update itself always runs, and `flushSync` makes the DOM change
 * land inside the transition's callback.
 */
import { flushSync } from "react-dom";

interface TransitionDocument {
	startViewTransition?: (update: () => void) => { finished: Promise<unknown>; updateCallbackDone?: Promise<unknown> };
}

let running = false;
/** The running transition's update until it has run: Chromium calls it later, once the old view is captured. */
let pendingUpdate: Promise<unknown> | null = null;

export function transitionView(update: () => void): void {
	// A swap asked for before the running transition applied its own update goes after it: run at once, it would land
	// first and be undone (a row click's close, then ⌘, opened Settings and closed it again).
	if (pendingUpdate) {
		const queued = pendingUpdate.then(update, update);
		pendingUpdate = queued;
		const clear = () => {
			if (pendingUpdate === queued) pendingUpdate = null;
		};
		queued.then(clear, clear);
		return;
	}
	const doc = (typeof document === "undefined" ? undefined : document) as (Document & TransitionDocument) | undefined;
	if (
		!doc ||
		running ||
		typeof doc.startViewTransition !== "function" ||
		doc.hidden ||
		doc.documentElement.dataset.gpu === "software" ||
		window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
	) {
		update();
		return;
	}
	running = true;
	let applied = false;
	const transition = doc.startViewTransition(() => {
		applied = true;
		flushSync(update);
	});
	const release = () => {
		running = false;
	};
	transition.finished.then(release, release);
	if (applied || !transition.updateCallbackDone) return;
	const done = transition.updateCallbackDone;
	pendingUpdate = done;
	const clear = () => {
		if (pendingUpdate === done) pendingUpdate = null;
	};
	done.then(clear, clear);
}
