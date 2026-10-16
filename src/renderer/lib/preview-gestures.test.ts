/** A finger on the streamed preview frame, as the pointer actions the host page receives. */
import { describe, expect, it } from "vitest";
import type { PreviewStreamInput } from "../../shared/preview";
import {
	DOUBLE_TAP_MS,
	FLING_STEP_MS,
	GestureRecognizer,
	type GestureTimers,
	LONG_PRESS_MS,
	TAP_MAX_MS,
	TAP_SLOP_PX,
} from "./preview-gestures";

const FRAME = { width: 400, height: 800 };

function setup() {
	let now = 1000;
	const sent: PreviewStreamInput[] = [];
	const pinches: Array<number | null> = [];
	const once: Array<{ at: number; run: () => void; live: boolean }> = [];
	const intervals: Array<{ every: number; next: number; run: () => void; live: boolean }> = [];
	const timers: GestureTimers = {
		after(run, ms) {
			const entry = { at: now + ms, run, live: true };
			once.push(entry);
			return () => {
				entry.live = false;
			};
		},
		repeat(run, ms) {
			const entry = { every: ms, next: now + ms, run, live: true };
			intervals.push(entry);
			return () => {
				entry.live = false;
			};
		},
	};
	const recognizer = new GestureRecognizer({
		emit: events => sent.push(...events),
		size: () => FRAME,
		onPinch: scale => pinches.push(scale),
		now: () => now,
		timers,
	});
	const advance = (ms: number) => {
		const end = now + ms;
		for (;;) {
			const due = [
				...once
					.filter(entry => entry.live && entry.at <= end)
					.map(entry => ({ at: entry.at, run: () => entry.run(), done: () => (entry.live = false) })),
				...intervals
					.filter(entry => entry.live && entry.next <= end)
					.map(entry => ({ at: entry.next, run: () => entry.run(), done: () => (entry.next += entry.every) })),
			].sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			now = due.at;
			due.done();
			due.run();
		}
		now = end;
	};
	return { recognizer, sent, pinches, advance, intervals };
}

describe("GestureRecognizer", () => {
	it("a quick touch and release is a tap at its position, as a fraction of the frame", () => {
		const { recognizer, sent, advance } = setup();
		recognizer.pointerDown(1, 200, 400);
		advance(80);
		recognizer.pointerUp(1);
		expect(sent).toEqual([{ t: "tap", x: 0.5, y: 0.5 }]);
	});

	it("tolerates a little finger wobble in a tap, and sends nothing for a press held too long without a release action", () => {
		const { recognizer, sent, advance } = setup();
		recognizer.pointerDown(1, 100, 100);
		recognizer.pointerMove(1, 100 + TAP_SLOP_PX, 100);
		advance(100);
		recognizer.pointerUp(1);
		expect(sent).toEqual([{ t: "tap", x: 0.25, y: 0.125 }]);
		sent.length = 0;
		recognizer.pointerDown(2, 100, 100);
		advance(TAP_MAX_MS + 10);
		recognizer.pointerUp(2);
		// Held past the tap time but short of a long press: not a click.
		expect(sent).toEqual([]);
	});

	it("counts a second and third tap close to the first in time and place", () => {
		const { recognizer, sent, advance } = setup();
		for (let tap = 0; tap < 3; tap++) {
			recognizer.pointerDown(1, 200, 400);
			advance(40);
			recognizer.pointerUp(1);
			advance(100);
		}
		expect(sent.map(event => (event.t === "tap" ? event.count : null))).toEqual([undefined, 2, 3]);
		advance(DOUBLE_TAP_MS + 10);
		recognizer.pointerDown(1, 200, 400);
		advance(40);
		recognizer.pointerUp(1);
		expect(sent.at(-1)).toEqual({ t: "tap", x: 0.5, y: 0.5 });
	});

	it("a tap far from the last is a first tap again", () => {
		const { recognizer, sent, advance } = setup();
		recognizer.pointerDown(1, 50, 50);
		advance(40);
		recognizer.pointerUp(1);
		recognizer.pointerDown(1, 350, 700);
		advance(40);
		recognizer.pointerUp(1);
		expect(sent.every(event => event.t === "tap" && event.count === undefined)).toBe(true);
	});

	it("a one-finger move scrolls the content with the finger: up is a positive wheel delta", () => {
		const { recognizer, sent, advance } = setup();
		recognizer.pointerDown(1, 200, 600);
		advance(16);
		recognizer.pointerMove(1, 200, 560);
		advance(16);
		recognizer.pointerMove(1, 210, 500);
		expect(sent).toEqual([
			{ t: "wheel", x: 0.5, y: 0.7, dx: 0, dy: 40 },
			{ t: "wheel", x: 210 / 400, y: 0.625, dx: -10, dy: 60 },
		]);
	});

	it("flings after a fast release and stops once the speed is spent", () => {
		const { recognizer, sent, advance, intervals } = setup();
		recognizer.pointerDown(1, 200, 700);
		for (let step = 1; step <= 5; step++) {
			advance(16);
			recognizer.pointerMove(1, 200, 700 - step * 30);
		}
		const scrolled = sent.length;
		recognizer.pointerUp(1);
		advance(FLING_STEP_MS * 5);
		expect(sent.length).toBeGreaterThan(scrolled);
		const speeds = sent.slice(scrolled).map(event => (event.t === "wheel" ? event.dy : 0));
		expect(speeds[0]).toBeGreaterThan(0);
		expect(speeds[speeds.length - 1]).toBeLessThan(speeds[0] ?? 0);
		advance(10_000);
		expect(intervals.every(entry => !entry.live)).toBe(true);
	});

	it("a slow release does not fling, and touching the frame stops a fling", () => {
		const { recognizer, sent, advance } = setup();
		recognizer.pointerDown(1, 200, 700);
		advance(16);
		recognizer.pointerMove(1, 200, 690);
		advance(400);
		recognizer.pointerMove(1, 200, 689);
		recognizer.pointerUp(1);
		const before = sent.length;
		advance(500);
		expect(sent.length).toBe(before);
		recognizer.pointerDown(2, 200, 700);
		for (let step = 1; step <= 5; step++) {
			advance(16);
			recognizer.pointerMove(2, 200, 700 - step * 30);
		}
		recognizer.pointerUp(2);
		advance(FLING_STEP_MS * 2);
		const flinging = sent.length;
		recognizer.pointerDown(3, 100, 100);
		advance(FLING_STEP_MS * 10);
		expect(sent.length).toBe(flinging);
	});

	it("a long press released in place is a context click at where it began", () => {
		const { recognizer, sent, advance } = setup();
		recognizer.pointerDown(1, 100, 200);
		advance(LONG_PRESS_MS + 10);
		expect(recognizer.phase).toBe("press");
		recognizer.pointerUp(1);
		expect(sent).toEqual([{ t: "context", x: 0.25, y: 0.25 }]);
	});

	it("a long press that then moves drags with the left button from where it began", () => {
		const { recognizer, sent, advance } = setup();
		recognizer.pointerDown(1, 100, 200);
		advance(LONG_PRESS_MS + 10);
		recognizer.pointerMove(1, 160, 200);
		recognizer.pointerMove(1, 220, 200);
		recognizer.pointerUp(1);
		expect(sent).toEqual([
			{ t: "drag", phase: "start", x: 0.25, y: 0.25 },
			{ t: "drag", phase: "move", x: 0.4, y: 0.25 },
			{ t: "drag", phase: "move", x: 0.55, y: 0.25 },
			{ t: "drag", phase: "end", x: 0.55, y: 0.25 },
		]);
	});

	it("moving before the long press time scrolls instead, and the long press never fires", () => {
		const { recognizer, sent, advance } = setup();
		recognizer.pointerDown(1, 100, 200);
		advance(100);
		recognizer.pointerMove(1, 100, 150);
		advance(LONG_PRESS_MS);
		recognizer.pointerUp(1);
		expect(sent.some(event => event.t === "context" || event.t === "drag")).toBe(false);
		expect(sent[0]).toMatchObject({ t: "wheel", dy: 50 });
	});

	it("two fingers pinch: the live scale is reported and one pinch is sent on release", () => {
		const { recognizer, sent, pinches, advance } = setup();
		recognizer.pointerDown(1, 150, 400);
		recognizer.pointerDown(2, 250, 400);
		advance(30);
		recognizer.pointerMove(2, 350, 400);
		expect(pinches.at(-1)).toBeCloseTo(2, 5);
		recognizer.pointerUp(2);
		expect(sent).toEqual([]);
		recognizer.pointerUp(1);
		expect(sent).toEqual([{ t: "pinch", scale: 2 }]);
		expect(pinches.at(-1)).toBeNull();
	});

	it("a pinch that barely moved sends nothing, and a second finger cancels a drag in progress", () => {
		const { recognizer, sent, advance } = setup();
		recognizer.pointerDown(1, 150, 400);
		recognizer.pointerDown(2, 250, 400);
		recognizer.pointerMove(2, 252, 400);
		recognizer.pointerUp(2);
		recognizer.pointerUp(1);
		expect(sent).toEqual([]);
		recognizer.pointerDown(3, 100, 200);
		advance(LONG_PRESS_MS + 10);
		recognizer.pointerMove(3, 200, 200);
		sent.length = 0;
		recognizer.pointerDown(4, 300, 300);
		expect(sent).toEqual([{ t: "drag", phase: "end", x: 0.5, y: 0.25 }]);
	});

	it("a cancelled touch sends nothing, ends a drag, and forgets the press", () => {
		const { recognizer, sent, advance } = setup();
		recognizer.pointerDown(1, 100, 200);
		advance(LONG_PRESS_MS + 10);
		recognizer.pointerCancel(1);
		expect(sent).toEqual([]);
		expect(recognizer.phase).toBe("idle");
		recognizer.pointerDown(2, 100, 200);
		advance(LONG_PRESS_MS + 10);
		recognizer.pointerMove(2, 200, 200);
		recognizer.pointerCancel(2);
		expect(sent.at(-1)).toMatchObject({ t: "drag", phase: "end" });
	});

	it("disposing cancels every pending timer", () => {
		const { recognizer, sent, advance } = setup();
		recognizer.pointerDown(1, 100, 200);
		recognizer.dispose();
		advance(LONG_PRESS_MS * 3);
		recognizer.pointerUp(1);
		expect(sent).toEqual([]);
	});
});
