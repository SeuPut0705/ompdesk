/**
 * The system back gesture (Android back, iOS edge swipe) closes the top sheet instead of leaving the page.
 * A sheet, dialog or drawer that opens takes a layer here: that pushes one history entry; back pops it and
 * closes the layer on top. A layer closed another way (its close button, the scrim, Escape) hands its own
 * entry back with `history.back()`, so the next back gesture still means "leave". Only active in the web
 * shell (`startBackLayers`); elsewhere `pushBackLayer` is a no-op, so Electron never touches history.
 *
 * `history.back()` fixes its target entry when it is called and traverses later, and that traversal discards
 * any entry pushed in between. A menu item that closes its menu (a `back()`) and opens a dialog (a push) in one
 * tick would therefore lose the dialog's entry and, one close later, step past the app's first entry (a blank
 * page). So while one of our own backs is in flight, later pushes and backs wait for its popstate and then run
 * in order.
 */

interface Layer {
	id: number;
	close: () => void;
	/** Its history entry exists (the push has run). */
	pushed: boolean;
}

const STATE_KEY = "ompLayer";

let running = false;
let nextId = 1;
const layers: Layer[] = [];
/** Entries of layers that closed out of order: their back presses close nothing. */
let staleEntries = 0;
/** Whether a `history.back()` we made ourselves is waiting for its popstate (not a gesture). */
let backInFlight = false;
/** History operations that arrived while a back was in flight, in order. */
const queued: (() => void)[] = [];

function runInOrder(operation: () => void): void {
	if (backInFlight) queued.push(operation);
	else operation();
}

function drain(): void {
	while (!backInFlight && queued.length > 0) queued.shift()?.();
}

/** Take a layer while a sheet is open; the returned release runs when it closes by any route. */
export function pushBackLayer(close: () => void): () => void {
	if (!running) return () => {};
	const layer: Layer = { id: nextId++, close, pushed: false };
	layers.push(layer);
	runInOrder(() => {
		if (!layers.includes(layer)) return;
		window.history.pushState({ [STATE_KEY]: layer.id }, "");
		layer.pushed = true;
	});
	return () => {
		const index = layers.indexOf(layer);
		if (index < 0) return;
		layers.splice(index, 1);
		if (!layer.pushed) {
			// Its push is still queued and will find the layer gone: there is no entry to hand back.
			return;
		}
		if (layers.slice(index).some(above => above.pushed)) {
			staleEntries += 1;
			return;
		}
		runInOrder(() => {
			backInFlight = true;
			window.history.back();
		});
	};
}

function onPopState(): void {
	if (backInFlight) {
		backInFlight = false;
		drain();
		return;
	}
	let top: Layer | undefined;
	for (let i = layers.length - 1; i >= 0; i--) {
		if (layers[i]?.pushed) {
			top = layers.splice(i, 1)[0];
			break;
		}
	}
	if (top) top.close();
	else if (staleEntries > 0) staleEntries -= 1;
}

export function startBackLayers(): () => void {
	running = true;
	window.addEventListener("popstate", onPopState);
	return () => {
		running = false;
		layers.length = 0;
		queued.length = 0;
		staleEntries = 0;
		backInFlight = false;
		window.removeEventListener("popstate", onPopState);
	};
}

/** For tests: how many layers hold a history entry. */
export function backLayerDepth(): number {
	return layers.length;
}
