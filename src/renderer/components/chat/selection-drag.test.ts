/**
 * Transcript drag-selection (A105): edge autoscroll speed, the drag lifecycle
 * on the window, and the rows a selection keeps mounted.
 */
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import {
	EDGE_BAND_PX,
	edgeScrollStep,
	installSelectionDrag,
	MAX_PINNED_ROWS,
	selectionRowSpan,
} from "./selection-drag";

describe("edgeScrollStep", () => {
	it("is still inside the band-free middle and grows toward each edge and beyond, capped", () => {
		expect(edgeScrollStep(300, 100, 700)).toBe(0);
		expect(edgeScrollStep(100 + EDGE_BAND_PX, 100, 700)).toBe(0);
		expect(edgeScrollStep(100 + EDGE_BAND_PX - 1, 100, 700)).toBe(-1);
		expect(edgeScrollStep(700 - EDGE_BAND_PX + 60, 100, 700)).toBe(14);
		expect(edgeScrollStep(5000, 100, 700)).toBe(28);
		expect(edgeScrollStep(-5000, 100, 700)).toBe(-28);
	});
});

function fakeWindow() {
	const listeners = new Map<string, Set<(event: PointerEvent) => void>>();
	const frames: (() => void)[] = [];
	return {
		listeners,
		frames,
		addEventListener: (type: string, fn: (event: PointerEvent) => void) => {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type)!.add(fn);
		},
		removeEventListener: (type: string, fn: (event: PointerEvent) => void) => listeners.get(type)?.delete(fn),
		requestAnimationFrame: (fn: () => void) => frames.push(fn),
		cancelAnimationFrame: () => frames.splice(0),
		fire: (type: string, event: Partial<PointerEvent>) => {
			for (const fn of listeners.get(type) ?? []) fn(event as PointerEvent);
		},
	};
}

describe("installSelectionDrag", () => {
	it("starts on a real drag, scrolls while held past the bottom edge, and ends on pointer up", () => {
		const win = fakeWindow();
		let onDown: ((event: PointerEvent) => void) | undefined;
		const scroller = {
			ownerDocument: { defaultView: win },
			scrollTop: 0,
			getBoundingClientRect: () => ({ top: 100, bottom: 700, right: 800 }),
			addEventListener: (_type: string, fn: (event: PointerEvent) => void) => {
				onDown = fn;
			},
			removeEventListener: () => {},
		};
		const onStart = vi.fn();
		const onEnd = vi.fn();
		const dispose = installSelectionDrag(scroller as unknown as HTMLElement, { onStart, onEnd });
		const text = { closest: () => null };
		const base = { pointerId: 1, isPrimary: true, pointerType: "mouse", button: 0 };

		// A press on a control is the control's.
		onDown!({ ...base, clientX: 10, clientY: 400, target: { closest: () => ({}) } } as unknown as PointerEvent);
		expect(win.listeners.get("pointermove")?.size ?? 0).toBe(0);

		onDown!({ ...base, clientX: 10, clientY: 400, target: text } as unknown as PointerEvent);
		win.fire("pointermove", { ...base, clientX: 11, clientY: 401 });
		expect(onStart).not.toHaveBeenCalled();
		win.fire("pointermove", { ...base, clientX: 10, clientY: 760 });
		expect(onStart).toHaveBeenCalledTimes(1);
		win.frames.shift()!();
		expect(scroller.scrollTop).toBeGreaterThan(0);

		win.fire("pointerup", { ...base });
		expect(onEnd).toHaveBeenCalledTimes(1);
		expect(win.listeners.get("pointermove")?.size).toBe(0);
		dispose();
	});
});

describe("selectionRowSpan", () => {
	const { document } = parseHTML(
		`<div id="s">${["a", "b", "c", "d"].map(key => `<div data-row-key="${key}"><p>${key} text</p></div>`).join("")}</div><p id="out">x</p>`,
	);
	const scroller = document.getElementById("s") as unknown as HTMLElement;
	const keys = ["a", "b", "c", "d"];
	const textOf = (key: string) => document.querySelector(`[data-row-key="${key}"] p`)!.firstChild as unknown as Node;
	const selection = (anchor: Node | null, focus: Node | null, collapsed = false) =>
		({
			isCollapsed: collapsed,
			rangeCount: 1,
			anchorNode: anchor,
			focusNode: focus,
			getRangeAt: () => ({ commonAncestorContainer: scroller }),
		}) as unknown as Selection;

	it("covers every row between the two ends, either direction", () => {
		expect(selectionRowSpan(selection(textOf("b"), textOf("d")), scroller, keys)).toEqual(["b", "c", "d"]);
		expect(selectionRowSpan(selection(textOf("c"), textOf("a")), scroller, keys)).toEqual(["a", "b", "c"]);
	});

	it("clears for a collapsed selection or one outside the transcript, and keeps what it had for unmounted ends", () => {
		expect(selectionRowSpan(selection(textOf("a"), textOf("a"), true), scroller, keys)).toEqual([]);
		expect(selectionRowSpan(null, scroller, keys)).toEqual([]);
		const outside = document.getElementById("out")!.firstChild as unknown as Node;
		expect(
			selectionRowSpan(
				{
					...selection(outside, outside),
					getRangeAt: () => ({ commonAncestorContainer: outside }),
				} as unknown as Selection,
				scroller,
				keys,
			),
		).toEqual([]);
		const detached = document.createElement("p") as unknown as Node;
		expect(selectionRowSpan(selection(detached, detached), scroller, keys)).toBeNull();
	});

	it("keeps only the ends of a selection longer than the cap", () => {
		const many = Array.from({ length: MAX_PINNED_ROWS + 2 }, (_, index) =>
			index === 0 ? "a" : index === MAX_PINNED_ROWS + 1 ? "d" : `r${index}`,
		);
		expect(selectionRowSpan(selection(textOf("a"), textOf("d")), scroller, many)).toEqual(["a", "d"]);
	});
});
