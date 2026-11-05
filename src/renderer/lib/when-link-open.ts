import type { WebRuntime } from "../web/runtime";

/**
 * Run `run` once the paired page's link to its computer is open, at once on a desktop window (no runtime) or an open
 * link. The idle preloads of lazy views start here: a dynamic import that fails while the computer is out of reach
 * is kept failed by the browser (WebKit answers every later `import()` of that module with the same failure), so a
 * Settings page preloaded during an outage never opened again until the page reloaded. Returns the cancel.
 */
export function whenLinkOpen(
	runtime: Pick<WebRuntime, "connectionState" | "onConnectionState"> | null,
	run: () => void,
): () => void {
	if (!runtime || runtime.connectionState() === "open") {
		run();
		return () => {};
	}
	let done = false;
	let unsubscribe: (() => void) | null = null;
	const finish = () => {
		done = true;
		unsubscribe?.();
		unsubscribe = null;
	};
	unsubscribe = runtime.onConnectionState(state => {
		if (state !== "open" || done) return;
		finish();
		run();
	});
	if (done) finish();
	return finish;
}
