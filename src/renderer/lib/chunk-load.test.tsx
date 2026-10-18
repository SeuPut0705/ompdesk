import { parseHTML } from "linkedom";
import { act, type ReactNode, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isChunkLoadError,
	lazyChunk,
	loadChunk,
	RECOVERY_GRACE_MS,
	useChunkFailureStore,
	watchChunkFailures,
} from "./chunk-load";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

/** WebKit's message for a module the server no longer has (the phone, v0.38.1). */
const stale = () => new TypeError("Importing a module script failed.");

let root: Root | null = null;
let container: { textContent: string | null; querySelector(selector: string): { click(): void } | null };

beforeEach(() => useChunkFailureStore.setState({ failed: false, appGone: false }));
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
});

async function render(node: ReactNode): Promise<void> {
	container = document.createElement("div") as unknown as typeof container;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element, { onCaughtError: () => {}, onUncaughtError: () => {} });
	await act(async () => root?.render(node));
}

describe("isChunkLoadError", () => {
	it.each([
		"Importing a module script failed.",
		"Failed to fetch dynamically imported module: https://mac.ts.net/assets/PanelViews-DjBW9_uG.js",
		"error loading dynamically imported module: https://mac.ts.net/assets/en-x.js",
		"Unable to preload CSS for /assets/PanelViews-LZoznX6r.css",
	])("knows %s", message => expect(isChunkLoadError(new TypeError(message))).toBe(true));

	it("leaves other errors alone", () => {
		expect(isChunkLoadError(new Error("Maximum call stack size exceeded."))).toBe(false);
		expect(isChunkLoadError(undefined)).toBe(false);
	});
});

describe("loadChunk (a failed dynamic import retries once, then the build counts as stale)", () => {
	it("retries once and recovers without marking the build stale", async () => {
		const load = vi.fn().mockRejectedValueOnce(stale()).mockResolvedValueOnce("module");
		await expect(loadChunk(load)).resolves.toBe("module");
		expect(load).toHaveBeenCalledTimes(2);
		expect(useChunkFailureStore.getState().failed).toBe(false);
	});

	it("marks the build stale after the second failure", async () => {
		const load = vi.fn().mockRejectedValue(stale());
		await expect(loadChunk(load)).rejects.toThrow("Importing a module script failed.");
		expect(load).toHaveBeenCalledTimes(2);
		expect(useChunkFailureStore.getState().failed).toBe(true);
	});

	it("never retries an error that is not a chunk load", async () => {
		const load = vi.fn().mockRejectedValue(new Error("boom"));
		await expect(loadChunk(load)).rejects.toThrow("boom");
		expect(load).toHaveBeenCalledTimes(1);
		expect(useChunkFailureStore.getState().failed).toBe(false);
	});
});

describe("lazyChunk", () => {
	it("renders nothing in place of a view whose chunk never loads, instead of crashing the page", async () => {
		const View = lazyChunk<() => ReactNode>(() => Promise.reject(stale()));
		await render(
			<div>
				before
				<Suspense fallback="loading">
					<View />
				</Suspense>
				after
			</div>,
		);
		expect(container.textContent).toBe("beforeafter");
		expect(useChunkFailureStore.getState().failed).toBe(true);
	});
});

describe("watchChunkFailures (every other dynamic import that fails for good)", () => {
	/** The window as `watchChunkFailures` sees it: Vite's helper dispatches the event with the error as `payload`. */
	function fakeWindow() {
		let listener: ((event: unknown) => void) | null = null;
		return {
			addEventListener: (_type: string, next: (event: unknown) => void) => {
				listener = next;
			},
			fire: (payload: unknown) => listener?.({ type: "vite:preloadError", payload }),
		};
	}

	it("marks the build stale once the grace passes without a recovery", () => {
		const target = fakeWindow();
		const timers: (() => void)[] = [];
		// After any recovery an earlier test made (the module keeps the last one).
		watchChunkFailures(
			target as never,
			() => Date.now() + 60_000,
			callback => timers.push(callback),
		);
		target.fire(new Error("boom"));
		expect(timers).toHaveLength(0);
		target.fire(stale());
		expect(timers).toHaveLength(1);
		expect(useChunkFailureStore.getState().failed).toBe(false);
		timers[0]?.();
		expect(useChunkFailureStore.getState().failed).toBe(true);
		expect(RECOVERY_GRACE_MS).toBeGreaterThan(0);
	});

	it("marks nothing for a failure a retry recovered within the grace", async () => {
		const target = fakeWindow();
		const timers: (() => void)[] = [];
		let clock = 1000;
		watchChunkFailures(
			target as never,
			() => clock,
			callback => timers.push(callback),
		);
		target.fire(stale());
		clock = 1500;
		await loadChunk(vi.fn().mockRejectedValueOnce(stale()).mockResolvedValueOnce("ok"), () => clock);
		timers[0]?.();
		expect(useChunkFailureStore.getState().failed).toBe(false);
	});
});
