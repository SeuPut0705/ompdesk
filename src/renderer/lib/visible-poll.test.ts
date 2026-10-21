import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollWhileVisible } from "./visible-poll";

const { document, window, Event } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, { document, window, Event });

function setVisibility(state: "visible" | "hidden"): void {
	Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
	document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("pollWhileVisible", () => {
	it("ticks on its interval while shown, asks nothing while hidden, catches up once on show", () => {
		const tick = vi.fn();
		const stop = pollWhileVisible(tick, 1000);
		vi.advanceTimersByTime(2000);
		expect(tick).toHaveBeenCalledTimes(2);

		setVisibility("hidden");
		expect(tick).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(5000);
		expect(tick).toHaveBeenCalledTimes(2);

		setVisibility("visible");
		expect(tick).toHaveBeenCalledTimes(3);
		vi.advanceTimersByTime(1000);
		expect(tick).toHaveBeenCalledTimes(4);

		stop();
		vi.advanceTimersByTime(5000);
		setVisibility("hidden");
		setVisibility("visible");
		expect(tick).toHaveBeenCalledTimes(4);
	});
});
