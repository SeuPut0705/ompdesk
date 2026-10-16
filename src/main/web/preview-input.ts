/**
 * A viewer's gestures and keys (shared/preview.ts `PreviewStreamInput`) as what the offscreen page accepts:
 * `webContents.sendInputEvent` mouse, wheel and key events (browser-process input: `isTrusted`, user activation,
 * and the C143 real-input gate all hold, spikes S1), `insertText` for committed text, and the page's zoom for a
 * pinch. `sendInputEvent` has no touch type, so a touch becomes the mouse event it means: a tap is a click, a
 * one-finger drag a wheel scroll, a long press a right click, a long press and drag a left-button drag. A page that
 * needs `pointerType: "touch"` (maps, pinch canvases) sees a mouse; that is the documented limit of not holding
 * a debugger on the page, which would turn `choose` off.
 */
import type { KeyboardInputEvent, MouseInputEvent, MouseWheelInputEvent } from "electron";
import { z } from "zod";
import type { PreviewStreamInput } from "../../shared/preview";

/** The most events one `input` call carries, the longest text, and the largest wheel step: a phone cannot mean more. */
export const INPUT_BATCH_MAX = 64;
export const INPUT_TEXT_MAX = 10_000;
const WHEEL_MAX = 5000;
const PINCH_MIN = 0.5;
const PINCH_MAX = 2;

const fraction = z.number().finite();
const modifier = z.enum(["shift", "control", "alt", "meta"]);

export const previewStreamInputSchema: z.ZodType<PreviewStreamInput> = z.discriminatedUnion("t", [
	z.object({
		t: z.literal("tap"),
		x: fraction,
		y: fraction,
		count: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
	}),
	z.object({ t: z.literal("context"), x: fraction, y: fraction }),
	z.object({ t: z.literal("drag"), phase: z.enum(["start", "move", "end"]), x: fraction, y: fraction }),
	z.object({ t: z.literal("hover"), x: fraction, y: fraction }),
	z.object({ t: z.literal("wheel"), x: fraction, y: fraction, dx: z.number().finite(), dy: z.number().finite() }),
	z.object({ t: z.literal("pinch"), scale: z.number().finite().positive() }),
	z.object({ t: z.literal("key"), key: z.string().min(1).max(32), mods: z.array(modifier).max(4).optional() }),
	z.object({ t: z.literal("text"), text: z.string().min(1).max(INPUT_TEXT_MAX) }),
]);

export const previewStreamBatchSchema = z.array(previewStreamInputSchema).max(INPUT_BATCH_MAX);

/** The size of the page's window in the units `sendInputEvent` takes (DIPs); gestures arrive as fractions of it. */
export interface InputSurface {
	width: number;
	height: number;
}

export type InputOp =
	| { op: "event"; event: MouseInputEvent | MouseWheelInputEvent | KeyboardInputEvent }
	| { op: "text"; text: string }
	/** Multiply the page's zoom by `scale`. */
	| { op: "pinch"; scale: number };

/** DOM `KeyboardEvent.key` names → the key codes `sendInputEvent` knows. */
const NAMED_KEYS: Readonly<Record<string, string>> = {
	ArrowLeft: "Left",
	ArrowRight: "Right",
	ArrowUp: "Up",
	ArrowDown: "Down",
	Enter: "Enter",
	Backspace: "Backspace",
	Delete: "Delete",
	Tab: "Tab",
	Escape: "Escape",
	Home: "Home",
	End: "End",
	PageUp: "PageUp",
	PageDown: "PageDown",
	Insert: "Insert",
	" ": "Space",
};
/** Keys that also type something: the page's text fields only change on the `char` event that follows. */
const CHAR_KEYS: Readonly<Record<string, string>> = { Enter: "\r", " ": " " };

/** The key code and the character `key` types, or null for a key the page cannot be given. */
export function electronKey(key: string): { keyCode: string; char: string | null } | null {
	const named = Object.hasOwn(NAMED_KEYS, key) ? NAMED_KEYS[key] : undefined;
	if (named) return { keyCode: named, char: Object.hasOwn(CHAR_KEYS, key) ? (CHAR_KEYS[key] ?? null) : null };
	if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return { keyCode: key, char: null };
	// A single typed character (one code point, so an emoji or a surrogate pair is still one key).
	if ([...key].length === 1) return { keyCode: key, char: key };
	return null;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
/** A DOM wheel delta as Electron's: opposite sign, capped, and a zero stays a plain zero. */
const flipWheel = (delta: number) => (delta === 0 ? 0 : -clamp(delta, -WHEEL_MAX, WHEEL_MAX));

export class InputMapper {
	/** A left-button drag is in progress: moves carry the button, and a stray move without a start is dropped. */
	#dragging = false;

	get dragging(): boolean {
		return this.#dragging;
	}

	map(input: PreviewStreamInput, surface: InputSurface): InputOp[] {
		const point = (x: number, y: number) => ({
			x: Math.round(clamp(x, 0, 1) * Math.max(0, surface.width - 1)),
			y: Math.round(clamp(y, 0, 1) * Math.max(0, surface.height - 1)),
		});
		const mouse = (event: MouseInputEvent): InputOp => ({ op: "event", event });
		switch (input.t) {
			case "tap": {
				const at = point(input.x, input.y);
				const clickCount = input.count ?? 1;
				return [
					mouse({ type: "mouseMove", ...at }),
					mouse({ type: "mouseDown", ...at, button: "left", clickCount }),
					mouse({ type: "mouseUp", ...at, button: "left", clickCount }),
				];
			}
			case "context": {
				const at = point(input.x, input.y);
				return [
					mouse({ type: "mouseMove", ...at }),
					mouse({ type: "mouseDown", ...at, button: "right", clickCount: 1 }),
					mouse({ type: "mouseUp", ...at, button: "right", clickCount: 1 }),
				];
			}
			case "drag": {
				const at = point(input.x, input.y);
				if (input.phase === "start") {
					this.#dragging = true;
					return [
						mouse({ type: "mouseMove", ...at }),
						mouse({ type: "mouseDown", ...at, button: "left", clickCount: 1 }),
					];
				}
				if (!this.#dragging) return [];
				if (input.phase === "move") return [mouse({ type: "mouseMove", ...at, modifiers: ["leftbuttondown"] })];
				this.#dragging = false;
				return [mouse({ type: "mouseUp", ...at, button: "left", clickCount: 1 })];
			}
			case "hover":
				return this.#dragging ? [] : [mouse({ type: "mouseMove", ...point(input.x, input.y) })];
			case "wheel": {
				const at = point(input.x, input.y);
				// Electron's wheel delta has the opposite sign of the DOM's: positive scrolls the content down.
				return [
					{
						op: "event",
						event: {
							type: "mouseWheel",
							...at,
							deltaX: flipWheel(input.dx),
							deltaY: flipWheel(input.dy),
							hasPreciseScrollingDeltas: true,
							canScroll: true,
						},
					},
				];
			}
			case "pinch":
				return [{ op: "pinch", scale: clamp(input.scale, PINCH_MIN, PINCH_MAX) }];
			case "text":
				return [{ op: "text", text: input.text }];
			case "key": {
				const key = electronKey(input.key);
				if (!key) return [];
				const modifiers = input.mods?.length ? [...input.mods] : undefined;
				const base = modifiers ? { modifiers } : {};
				const events: InputOp[] = [{ op: "event", event: { type: "keyDown", keyCode: key.keyCode, ...base } }];
				// A shortcut (Ctrl or Meta held) is a command, never a typed character.
				const command = modifiers?.includes("control") || modifiers?.includes("meta");
				if (key.char !== null && !command)
					events.push({ op: "event", event: { type: "char", keyCode: key.char, ...base } });
				events.push({ op: "event", event: { type: "keyUp", keyCode: key.keyCode, ...base } });
				return events;
			}
		}
	}

	/** The page lost its viewer or navigated: no drag is in progress any more. */
	reset(): void {
		this.#dragging = false;
	}
}
