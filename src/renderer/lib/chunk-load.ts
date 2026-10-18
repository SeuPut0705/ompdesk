/**
 * A chunk of this build that will not load. On a paired web page this is an old page after the host updated: the
 * page asks for a hashed `/assets/` file the new host build does not have (v0.38.1: "Importing a module script
 * failed." at `Lazy`, which crashed the page to the error screen). The host keeps the previous builds' assets for a
 * while (main/web/asset-archive.ts) and the service worker keeps what it fetched (sw-core.ts), so this is rare; when
 * it still happens the page stays as it is and shows one chip ("A new version is available · Reload",
 * `NewVersionChip`), and the reload waits for the user's tap.
 *
 * - `loadChunk` retries a failed load once; the lazy views (`lazyChunk`) render nothing after a second failure
 *   instead of throwing to the error boundary.
 * - `watchChunkFailures` counts every other dynamic import that fails (Vite's `vite:preloadError`); one that a retry
 *   recovered within `RECOVERY_GRACE_MS` shows nothing.
 */
import { type ComponentType, type LazyExoticComponent, lazy } from "react";
import { create } from "zustand";

/** The messages a failed module or chunk-style load carries in WebKit, Chromium, Firefox and Vite's preload. */
const CHUNK_ERROR =
	/Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Unable to preload CSS|Failed to load module script/i;

/** How long a failure waits for a retry of it to recover before the chip shows. */
export const RECOVERY_GRACE_MS = 3000;

export function isChunkLoadError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	return CHUNK_ERROR.test(message);
}

/** Whether a chunk of this build failed to load for good: the chip shows. */
export const useChunkFailureStore = create<{ failed: boolean }>(() => ({ failed: false }));

let recoveredAt = 0;

/** Load a chunk, once more when the first try failed as a chunk load. */
export async function loadChunk<T>(load: () => Promise<T>, now: () => number = Date.now): Promise<T> {
	try {
		return await load();
	} catch (first) {
		if (!isChunkLoadError(first)) throw first;
		try {
			const value = await load();
			recoveredAt = now();
			return value;
		} catch (second) {
			if (isChunkLoadError(second)) useChunkFailureStore.setState({ failed: true });
			throw second;
		}
	}
}

/** `React.lazy` through `loadChunk`; a view whose chunk will not load renders nothing (the chip says why). */
// biome-ignore lint/suspicious/noExplicitAny: React.lazy's own constraint; a component of any props is lazy-loadable.
export function lazyChunk<T extends ComponentType<any>>(load: () => Promise<{ default: T }>): LazyExoticComponent<T> {
	const nothing = (() => null) as unknown as T;
	return lazy(() =>
		loadChunk(load).catch((error: unknown) => {
			if (!isChunkLoadError(error)) throw error;
			return { default: nothing };
		}),
	);
}

/** Once, at start (main.tsx): a dynamic import that failed and was not recovered shows the chip. */
export function watchChunkFailures(
	target: Pick<Window, "addEventListener"> = window,
	now: () => number = Date.now,
	setTimer: (callback: () => void, ms: number) => unknown = (callback, ms) => setTimeout(callback, ms),
): void {
	target.addEventListener("vite:preloadError", event => {
		if (!isChunkLoadError("payload" in event ? event.payload : undefined)) return;
		const failedAt = now();
		setTimer(() => {
			if (recoveredAt < failedAt) useChunkFailureStore.setState({ failed: true });
		}, RECOVERY_GRACE_MS);
	});
}
