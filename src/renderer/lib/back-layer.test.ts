import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backLayerDepth, pushBackLayer, startBackLayers } from "./back-layer";

/**
 * A history that behaves like Chromium's for the case that matters: `back()` fixes its target entry when it is
 * called and traverses later (asynchronously), so a `pushState` made in between is discarded by the traversal.
 */
class FakeHistory {
	entries: unknown[] = ["start", "app"];
	index = 1;
	#pending: (() => void)[] = [];
	#listeners: (() => void)[] = [];

	get state(): unknown {
		return this.entries[this.index];
	}
	pushState(state: unknown): void {
		this.entries.length = this.index + 1;
		this.entries.push(state);
		this.index += 1;
	}
	back(): void {
		const target = this.index - 1;
		this.#pending.push(() => {
			this.index = Math.max(0, target);
			for (const listener of this.#listeners) listener();
		});
	}
	/** The user's back gesture: the same traversal, started now. */
	gesture(): void {
		this.back();
		this.flush();
	}
	flush(): void {
		while (this.#pending.length > 0) this.#pending.shift()?.();
	}
	addEventListener(_type: string, listener: () => void): void {
		this.#listeners.push(listener);
	}
}

let fake: FakeHistory;
let stop: () => void;

beforeEach(() => {
	fake = new FakeHistory();
	Object.assign(globalThis, {
		window: {
			history: fake,
			addEventListener: (type: string, l: () => void) => fake.addEventListener(type, l),
			removeEventListener: () => {},
		},
	});
	stop = startBackLayers();
});

afterEach(() => {
	stop();
});

describe("back layers", () => {
	it("a menu item that opens a dialog, then the drawer closing, never leave the app's first entry", () => {
		const closed: string[] = [];
		const releaseDrawer = pushBackLayer(() => closed.push("drawer"));
		const releaseMenu = pushBackLayer(() => closed.push("menu"));
		// The menu item runs: the menu closes (hands its entry back) and the dialog takes a layer in the same tick.
		releaseMenu();
		const releaseDialog = pushBackLayer(() => closed.push("dialog"));
		fake.flush();
		// The dialog closes, then Settings closes the drawer.
		releaseDialog();
		fake.flush();
		releaseDrawer();
		fake.flush();
		expect(fake.index).toBe(1);
		expect(fake.state).toBe("app");
		expect(backLayerDepth()).toBe(0);
		expect(closed).toEqual([]);
	});

	it("the back gesture still closes the top layer, one per gesture", () => {
		const closed: string[] = [];
		pushBackLayer(() => closed.push("drawer"));
		const releaseMenu = pushBackLayer(() => closed.push("menu"));
		releaseMenu();
		pushBackLayer(() => closed.push("dialog"));
		fake.flush();
		fake.gesture();
		expect(closed).toEqual(["dialog"]);
		fake.gesture();
		expect(closed).toEqual(["dialog", "drawer"]);
		expect(fake.index).toBe(1);
	});

	it("a layer closed by the gesture does not hand back an entry a second time", () => {
		let release = () => {};
		release = pushBackLayer(() => release());
		fake.gesture();
		expect(fake.index).toBe(1);
		expect(backLayerDepth()).toBe(0);
	});
});
