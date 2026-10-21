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
