import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNowTick } from "./now-tick";

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

let renders = 0;
let root: Root;

function Clock() {
	useNowTick(true);
	renders++;
	return null;
}

function setVisibility(state: "visible" | "hidden"): void {
	Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
	document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(async () => {
	vi.useFakeTimers();
	Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
	renders = 0;
	root = createRoot(document.createElement("div") as unknown as Element);
	await act(async () => root.render(<Clock />));
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.useRealTimers();
});

/** One second per `act`, which would otherwise batch the ticks into one render. */
async function seconds(count: number): Promise<void> {
	for (let second = 0; second < count; second++)
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
}

describe("useNowTick", () => {
	it("ticks once a second in view, stands still while hidden and catches up on return", async () => {
		const mounted = renders;
		await seconds(3);
		expect(renders).toBe(mounted + 3);

		await act(async () => setVisibility("hidden"));
		await seconds(10);
		expect(renders).toBe(mounted + 3);

		await act(async () => setVisibility("visible"));
		expect(renders).toBe(mounted + 4);
		await seconds(1);
		expect(renders).toBe(mounted + 5);
	});
});
