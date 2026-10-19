import { afterEach, describe, expect, it, vi } from "vitest";
import { transitionView } from "./view-transition";

type Doc = { hidden: boolean; documentElement: { dataset: Record<string, string> }; startViewTransition?: unknown };

function install(doc: Partial<Doc>, reduced = false) {
	const base: Doc = { hidden: false, documentElement: { dataset: {} }, ...doc };
	vi.stubGlobal("document", base);
	vi.stubGlobal("window", { matchMedia: () => ({ matches: reduced }) });
	return base;
}

afterEach(() => vi.unstubAllGlobals());

describe("transitionView", () => {
	it("runs the update inside a view transition when the browser has one", async () => {
		const update = vi.fn();
		const finished = Promise.resolve();
		const start = vi.fn((callback: () => void) => {
			callback();
			return { finished };
		});
		install({ startViewTransition: start });
		transitionView(update);
		expect(start).toHaveBeenCalledTimes(1);
		expect(update).toHaveBeenCalledTimes(1);
		await finished;
	});

	it("updates at once without the API, under reduced motion, in software compositing and when hidden", () => {
		const start = vi.fn();
		for (const [doc, reduced] of [
			[{}, false],
			[{ startViewTransition: start }, true],
			[{ startViewTransition: start, documentElement: { dataset: { gpu: "software" } } }, false],
			[{ startViewTransition: start, hidden: true }, false],
		] as const) {
			install(doc, reduced);
			const update = vi.fn();
			transitionView(update);
			expect(update).toHaveBeenCalledTimes(1);
		}
		expect(start).not.toHaveBeenCalled();
	});

	it("does not nest a swap inside a running transition", async () => {
		let finish: () => void = () => {};
		const finished = new Promise<void>(resolve => {
			finish = resolve;
		});
		const start = vi.fn((callback: () => void) => {
			callback();
			return { finished };
		});
		install({ startViewTransition: start });
		transitionView(() => {});
		const second = vi.fn();
		transitionView(second);
		expect(start).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(1);
		finish();
		await finished;
	});

	it("applies a swap asked for during a transition after that transition's own update, never before it", async () => {
		// Chromium runs the update callback later, once the old view is captured: a swap asked for meanwhile (a row
		// click's close, then ⌘,) must not land first and be undone by it.
		let runUpdate: () => void = () => {};
		const updateDone = Promise.withResolvers<void>();
		const start = vi.fn((callback: () => void) => {
			runUpdate = () => {
				callback();
				updateDone.resolve();
			};
			return { finished: new Promise<void>(() => {}), updateCallbackDone: updateDone.promise };
		});
		install({ startViewTransition: start });
		const order: string[] = [];
		transitionView(() => order.push("close"));
		transitionView(() => order.push("open"));
		runUpdate();
		await updateDone.promise;
		await Promise.resolve();
		expect(order).toEqual(["close", "open"]);
	});
});
