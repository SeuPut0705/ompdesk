import { afterEach, describe, expect, it, vi } from "vitest";
import { layoutKeyboardOpen, startKeyboardInset } from "./keyboard-inset";

describe("layoutKeyboardOpen (Android resizes-content)", () => {
	it("is open when a focused field and a layout that lost keyboard height", () => {
		expect(layoutKeyboardOpen(852, 552, true)).toBe(true);
	});

	it("ignores a dynamic toolbar, an unfocused resize and a layout at rest", () => {
		expect(layoutKeyboardOpen(852, 796, true)).toBe(false);
		expect(layoutKeyboardOpen(852, 552, false)).toBe(false);
		expect(layoutKeyboardOpen(852, 852, true)).toBe(false);
	});
});

describe("startKeyboardInset", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("drops the bottom inset (data-kb) while a resizes-content keyboard is up and brings it back after", () => {
		const listeners = new Map<string, () => void>();
		const field = { matches: () => true };
		const win = {
			innerWidth: 393,
			innerHeight: 852,
			scrollX: 0,
			scrollY: 0,
			scrollTo: () => {},
			// The visual viewport follows the layout viewport: the keyboard leaves no inset of its own.
			visualViewport: {
				height: 852,
				offsetTop: 0,
				scale: 1,
				addEventListener: () => {},
				removeEventListener: () => {},
			},
			addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
			removeEventListener: () => {},
		};
		const doc = { activeElement: null as unknown, addEventListener: () => {}, removeEventListener: () => {} };
		vi.stubGlobal("window", win);
		vi.stubGlobal("document", doc);
		vi.stubGlobal("HTMLElement", class {});
		const root = {
			style: { setProperty: () => {}, removeProperty: () => {} },
			dataset: {} as Record<string, string>,
		};
		const stop = startKeyboardInset(root as unknown as HTMLElement);
		expect(root.dataset.kb).toBeUndefined();

		const focused = Object.assign(new (globalThis.HTMLElement as unknown as new () => object)(), field);
		doc.activeElement = focused;
		win.innerHeight = 552;
		win.visualViewport.height = 552;
		listeners.get("resize")?.();
		expect(root.dataset.kb).toBe("open");

		win.innerHeight = 852;
		win.visualViewport.height = 852;
		listeners.get("resize")?.();
		expect(root.dataset.kb).toBeUndefined();

		// The keyboard closed by the system leaves the field focused; a later toolbar-sized change is no keyboard.
		win.innerHeight = 800;
		win.visualViewport.height = 800;
		listeners.get("resize")?.();
		expect(root.dataset.kb).toBeUndefined();
		stop();
	});
});
