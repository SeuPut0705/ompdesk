import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNowTick, useTimeAgo, useTimeAgos } from "./now-tick";

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

describe("useTimeAgo", () => {
	it("moves a row's age on as minutes pass, rendering only when the text changes", async () => {
		let label = "";
		let ageRenders = 0;
		function Age({ iso }: { iso: string }) {
			label = useTimeAgo(iso);
			ageRenders++;
			return null;
		}
		const iso = new Date(Date.now() - 90_000).toISOString();
		await act(async () => root.render(<Age iso={iso} />));
		expect(label).toBe("1m");
		const mounted = ageRenders;
		await seconds(29);
		// Still "1m": the clock ticked, nothing rendered.
		expect(label).toBe("1m");
		expect(ageRenders).toBe(mounted);
		await seconds(1);
		expect(label).toBe("2m");
		expect(ageRenders).toBe(mounted + 1);
	});
});

describe("useTimeAgos", () => {
	it("keeps every age in a list current, rendering only when one of them changes", async () => {
		let labels: readonly string[] = [];
		let listRenders = 0;
		function Ages({ values }: { values: readonly (string | number | null)[] }) {
			labels = useTimeAgos(values);
			listRenders++;
			return null;
		}
		const values = [Date.now() - 90_000, new Date(Date.now() - 3 * 3_600_000).toISOString(), null];
		await act(async () => root.render(<Ages values={values} />));
		expect(labels).toEqual(["1m", "3h", ""]);
		const mounted = listRenders;
		await seconds(29);
		expect(listRenders).toBe(mounted);
		await seconds(1);
		expect(labels).toEqual(["2m", "3h", ""]);
		expect(listRenders).toBe(mounted + 1);

		// A new list reads at once, in its own order.
		await act(async () => root.render(<Ages values={[null, Date.now() - 5 * 60_000]} />));
		expect(labels).toEqual(["", "5m"]);
	});
});
