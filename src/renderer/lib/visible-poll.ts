/**
 * Runs `tick` every `ms` while the window is shown, and once when it shows
 * again after being hidden: a hidden window asks nothing, the app's rule for
 * every poll. Returns the stop.
 */
export function pollWhileVisible(tick: () => void, ms: number): () => void {
	const run = () => {
		if (document.visibilityState !== "hidden") tick();
	};
	const timer = window.setInterval(run, ms);
	document.addEventListener("visibilitychange", run);
	return () => {
		window.clearInterval(timer);
		document.removeEventListener("visibilitychange", run);
	};
}

function hidden(): boolean {
	return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * Resolves when the window shows again, so a read a hidden window would make waits until someone can see what it
 * brings; `null` while it is shown, so a caller skips the wait without a microtask.
 */
export function whenVisible(): Promise<void> | null {
	if (!hidden()) return null;
	const { promise, resolve } = Promise.withResolvers<void>();
	const shown = () => {
		if (hidden()) return;
		document.removeEventListener("visibilitychange", shown);
		resolve();
	};
	document.addEventListener("visibilitychange", shown);
	return promise;
}
