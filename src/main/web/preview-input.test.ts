/** A viewer's gestures as the mouse, wheel and key events the offscreen page takes (and nothing else). */
import { describe, expect, it } from "vitest";
import { electronKey, INPUT_BATCH_MAX, InputMapper, type InputOp, previewStreamBatchSchema } from "./preview-input";

const SURFACE = { width: 400, height: 800, scale: 1 };

const events = (ops: InputOp[]) => ops.map(op => (op.op === "event" ? op.event : op));

describe("InputMapper", () => {
	it("maps a tap to a move, a press and a release at the frame's fraction", () => {
		const mapper = new InputMapper();
		expect(events(mapper.map({ t: "tap", x: 0.5, y: 0.25 }, SURFACE))).toEqual([
			{ type: "mouseMove", x: 200, y: 200 },
			{ type: "mouseDown", x: 200, y: 200, button: "left", clickCount: 1 },
			{ type: "mouseUp", x: 200, y: 200, button: "left", clickCount: 1 },
		]);
	});

	it("keeps the click count of a double tap, and clamps a point outside the frame", () => {
		const mapper = new InputMapper();
		const [, down] = events(mapper.map({ t: "tap", x: 2, y: -1, count: 2 }, SURFACE));
		expect(down).toEqual({ type: "mouseDown", x: 399, y: 0, button: "left", clickCount: 2 });
	});

	it("maps a long press to a right click and a long press with movement to a left-button drag", () => {
		const mapper = new InputMapper();
		expect(
			events(mapper.map({ t: "context", x: 0, y: 0 }, SURFACE)).map(event =>
				"button" in event ? event.button : null,
			),
		).toEqual([null, "right", "right"]);
		const start = events(mapper.map({ t: "drag", phase: "start", x: 0.1, y: 0.1 }, SURFACE));
		expect(start.at(-1)).toMatchObject({ type: "mouseDown", button: "left" });
		expect(mapper.dragging).toBe(true);
		expect(events(mapper.map({ t: "drag", phase: "move", x: 0.2, y: 0.1 }, SURFACE))).toEqual([
			{ type: "mouseMove", x: 80, y: 80, modifiers: ["leftbuttondown"] },
		]);
		expect(events(mapper.map({ t: "drag", phase: "end", x: 0.2, y: 0.1 }, SURFACE))).toEqual([
			{ type: "mouseUp", x: 80, y: 80, button: "left", clickCount: 1 },
		]);
		expect(mapper.dragging).toBe(false);
	});

	it("drops a drag move or end with no start, and a hover during a drag", () => {
		const mapper = new InputMapper();
		expect(mapper.map({ t: "drag", phase: "move", x: 0.5, y: 0.5 }, SURFACE)).toEqual([]);
		expect(mapper.map({ t: "drag", phase: "end", x: 0.5, y: 0.5 }, SURFACE)).toEqual([]);
		mapper.map({ t: "drag", phase: "start", x: 0.5, y: 0.5 }, SURFACE);
		expect(mapper.map({ t: "hover", x: 0.5, y: 0.5 }, SURFACE)).toEqual([]);
		mapper.reset();
		expect(mapper.map({ t: "hover", x: 0.5, y: 0.5 }, SURFACE)).toHaveLength(1);
	});

	it("flips the DOM's wheel sign into Electron's, as precise scrolling deltas", () => {
		const mapper = new InputMapper();
		expect(events(mapper.map({ t: "wheel", x: 0.5, y: 0.5, dx: 0, dy: 120 }, SURFACE))).toEqual([
			{
				type: "mouseWheel",
				x: 200,
				y: 400,
				deltaX: 0,
				deltaY: -120,
				hasPreciseScrollingDeltas: true,
				canScroll: true,
			},
		]);
		const [huge] = events(mapper.map({ t: "wheel", x: 0, y: 0, dx: 0, dy: -1e9 }, SURFACE));
		expect(huge).toMatchObject({ deltaY: 5000 });
	});

	it("scales a wheel delta from the frame's CSS px to the window's DIPs, so a swipe scrolls as far on any host", () => {
		// A 1× host screen: the window is twice the frame and zoomed by 2 (host.ts `placeStreamed`). 120 frame px is
		// 240 DIPs, which the page's zoom of 2 reads as the same 120 CSS px a 2× host's unzoomed page does.
		const mapper = new InputMapper();
		const [event] = events(mapper.map({ t: "wheel", x: 0, y: 0, dx: 30, dy: 120 }, { ...SURFACE, scale: 2 }));
		expect(event).toMatchObject({ deltaX: -60, deltaY: -240 });
	});

	it("turns a pinch into a zoom factor within a sane range", () => {
		const mapper = new InputMapper();
		expect(mapper.map({ t: "pinch", scale: 1.25 }, SURFACE)).toEqual([{ op: "pinch", scale: 1.25 }]);
		expect(mapper.map({ t: "pinch", scale: 40 }, SURFACE)).toEqual([{ op: "pinch", scale: 2 }]);
		expect(mapper.map({ t: "pinch", scale: 0.001 }, SURFACE)).toEqual([{ op: "pinch", scale: 0.5 }]);
	});

	it("hands committed text over whole", () => {
		const mapper = new InputMapper();
		expect(mapper.map({ t: "text", text: "한글 text" }, SURFACE)).toEqual([{ op: "text", text: "한글 text" }]);
	});

	it("sends a typed character as down, char and up, and a special key without a char", () => {
		const mapper = new InputMapper();
		expect(events(mapper.map({ t: "key", key: "a" }, SURFACE))).toEqual([
			{ type: "keyDown", keyCode: "a" },
			{ type: "char", keyCode: "a" },
			{ type: "keyUp", keyCode: "a" },
		]);
		expect(events(mapper.map({ t: "key", key: "ArrowLeft" }, SURFACE))).toEqual([
			{ type: "keyDown", keyCode: "Left" },
			{ type: "keyUp", keyCode: "Left" },
		]);
		// Enter and Space type something, so a text field changes.
		expect(events(mapper.map({ t: "key", key: "Enter" }, SURFACE))[1]).toEqual({ type: "char", keyCode: "\r" });
		expect(events(mapper.map({ t: "key", key: " " }, SURFACE))[0]).toEqual({ type: "keyDown", keyCode: "Space" });
	});

	it("a shortcut is a command: Ctrl or Meta suppresses the char, and the modifiers ride every event", () => {
		const mapper = new InputMapper();
		expect(events(mapper.map({ t: "key", key: "a", mods: ["control"] }, SURFACE))).toEqual([
			{ type: "keyDown", keyCode: "a", modifiers: ["control"] },
			{ type: "keyUp", keyCode: "a", modifiers: ["control"] },
		]);
		expect(events(mapper.map({ t: "key", key: "A", mods: ["shift"] }, SURFACE))[1]).toEqual({
			type: "char",
			keyCode: "A",
			modifiers: ["shift"],
		});
	});

	it("gives the page nothing for a key it has no name for", () => {
		expect(electronKey("Unidentified")).toBeNull();
		expect(electronKey("F13")).toEqual({ keyCode: "F13", char: null });
		expect(electronKey("😀")).toEqual({ keyCode: "😀", char: "😀" });
		expect(new InputMapper().map({ t: "key", key: "Dead" }, SURFACE)).toEqual([]);
	});
});

describe("previewStreamBatchSchema", () => {
	it("accepts each input kind and refuses a malformed or oversized one", () => {
		expect(
			previewStreamBatchSchema.safeParse([
				{ t: "tap", x: 0.1, y: 0.2 },
				{ t: "wheel", x: 0.1, y: 0.2, dx: 0, dy: 4 },
				{ t: "key", key: "a", mods: ["shift"] },
				{ t: "text", text: "hi" },
			]).success,
		).toBe(true);
		expect(previewStreamBatchSchema.safeParse([{ t: "tap", x: "0.1", y: 0.2 }]).success).toBe(false);
		expect(previewStreamBatchSchema.safeParse([{ t: "eval", code: "1" }]).success).toBe(false);
		expect(previewStreamBatchSchema.safeParse([{ t: "key", key: "a", mods: ["super"] }]).success).toBe(false);
		expect(previewStreamBatchSchema.safeParse([{ t: "text", text: "" }]).success).toBe(false);
		expect(
			previewStreamBatchSchema.safeParse(
				Array.from({ length: INPUT_BATCH_MAX + 1 }, () => ({ t: "hover", x: 0, y: 0 })),
			).success,
		).toBe(false);
		expect(previewStreamBatchSchema.safeParse([{ t: "pinch", scale: Number.POSITIVE_INFINITY }]).success).toBe(false);
	});
});
