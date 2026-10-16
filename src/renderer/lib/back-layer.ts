/**
 * The system back gesture (Android back, iOS edge swipe) closes the top sheet instead of leaving the page.
 * A sheet, dialog or drawer that opens takes a layer here: that pushes one history entry; back pops it and
 * closes the layer on top. A layer closed another way (its close button, the scrim, Escape) hands its own
 * entry back with `history.back()`, so the next back gesture still means "leave". Only active in the web
 * shell (`startBackLayers`); elsewhere `pushBackLayer` is a no-op, so Electron never touches history.
 */

interface Layer {
	id: number;
	close: () => void;
}

const STATE_KEY = "ompLayer";

let running = false;
let nextId = 1;
const layers: Layer[] = [];
/** Entries of layers that closed out of order: their back presses close nothing. */
let staleEntries = 0;
/** `history.back()` calls we made ourselves; their popstate is not a gesture. */
let ownBacks = 0;

/** Take a layer while a sheet is open; the returned release runs when it closes by any route. */
export function pushBackLayer(close: () => void): () => void {
	if (!running) return () => {};
	const layer: Layer = { id: nextId++, close };
	layers.push(layer);
	window.history.pushState({ [STATE_KEY]: layer.id }, "");
	return () => {
		const index = layers.indexOf(layer);
		if (index < 0) return;
		layers.splice(index, 1);
		if (index === layers.length) {
			ownBacks += 1;
			window.history.back();
		} else staleEntries += 1;
	};
}

function onPopState(): void {
	if (ownBacks > 0) {
		ownBacks -= 1;
		return;
	}
	const top = layers.pop();
	if (top) top.close();
	else if (staleEntries > 0) staleEntries -= 1;
}

export function startBackLayers(): () => void {
	running = true;
	window.addEventListener("popstate", onPopState);
	return () => {
		running = false;
		layers.length = 0;
		staleEntries = 0;
		ownBacks = 0;
		window.removeEventListener("popstate", onPopState);
	};
}

/** For tests: how many layers hold a history entry. */
export function backLayerDepth(): number {
	return layers.length;
}
