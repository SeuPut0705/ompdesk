/**
 * A finger on the streamed preview frame, read as what the page on the host computer should receive
 * (shared/preview.ts `PreviewStreamInput`; the host turns each into mouse, wheel or zoom events, main/web/preview-input.ts).
 * The page is on another machine, so there is no touch to forward: a gesture is recognised here and sent as the
 * pointer action it means.
 *
 *   tap                   → `tap` (a second tap close to the first, in time, counts 2, a third 3)
 *   one finger moves      → `wheel` deltas (the content follows the finger), then a short fling on release
 *   long press, release   → `context` (a right click)
 *   long press, move      → `drag` start / move / end with the left button (text selection, sliders, drag and drop)
 *   two fingers           → `pinch`: the size change from the first spread to the last, sent once on release,
 *                           with `onPinch` reporting the live scale so the viewer can show it under the fingers
 *   a mouse (tablet, USB) → hover, click, drag; its wheel scrolls (see `mouse*`)
 *
 * Positions come in CSS px inside the frame; events go out as fractions of it.
 */
import type { PreviewStreamInput } from "../../shared/preview";

/** A finger that moves less than this while down is still a tap or a press. */
export const TAP_SLOP_PX = 8;
/** Longest a tap may be down, and how long still-down makes it a long press. */
export const TAP_MAX_MS = 300;
export const LONG_PRESS_MS = 450;
/** A second tap within this time and distance of the first counts as a double tap. */
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_SLOP_PX = 30;
/** A release faster than this (px/ms) flings; each fling step is `FLING_STEP_MS` long and keeps `FLING_DECAY` of its speed. */
export const FLING_MIN_SPEED = 0.35;
export const FLING_STOP_SPEED = 0.03;
export const FLING_STEP_MS = 16;
export const FLING_DECAY = 0.94;
/** A pinch changes the zoom only when it spread or closed by more than this. */
export const PINCH_MIN_CHANGE = 0.03;

export interface GestureTimers {
	/** Run `callback` once after `ms`; returns the cancel. */
	after(callback: () => void, ms: number): () => void;
	/** Run `callback` every `ms`; returns the cancel. */
	repeat(callback: () => void, ms: number): () => void;
}

const realTimers: GestureTimers = {
	after(callback, ms) {
		const handle = setTimeout(callback, ms);
		return () => clearTimeout(handle);
	},
	repeat(callback, ms) {
		const handle = setInterval(callback, ms);
		return () => clearInterval(handle);
	},
};

export interface GestureOptions {
	/** Receives what the host should do, in order. */
	emit(events: PreviewStreamInput[]): void;
	/** The frame's size in CSS px (positions and deltas are measured against it). */
	size(): { width: number; height: number };
	/** The live pinch scale while two fingers are down (null when the pinch ended). */
	onPinch?(scale: number | null): void;
	now?: () => number;
	timers?: GestureTimers;
}

interface Pointer {
	x: number;
	y: number;
}

interface Sample {
	t: number;
	x: number;
	y: number;
}

type Phase = "idle" | "pending" | "scroll" | "press" | "drag" | "pinch";

export class GestureRecognizer {
	readonly #options: GestureOptions;
	readonly #now: () => number;
	readonly #timers: GestureTimers;
	readonly #pointers = new Map<number, Pointer>();
	#phase: Phase = "idle";
	#primary: number | null = null;
	#start: { x: number; y: number; t: number } = { x: 0, y: 0, t: 0 };
	#last: Pointer = { x: 0, y: 0 };
	#samples: Sample[] = [];
	#cancelLongPress: (() => void) | null = null;
	#cancelFling: (() => void) | null = null;
	#lastTap: { x: number; y: number; t: number; count: number } | null = null;
	#pinchStart = 0;
	#pinchScale = 1;

	constructor(options: GestureOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
		this.#timers = options.timers ?? realTimers;
	}

	/** The gesture in progress, for tests and for a viewer that dims its controls while a finger is down. */
	get phase(): Phase {
		return this.#phase;
	}

	#fraction(x: number, y: number): { x: number; y: number } {
		const { width, height } = this.#options.size();
		return { x: width > 0 ? x / width : 0, y: height > 0 ? y / height : 0 };
	}

	#emit(...events: PreviewStreamInput[]): void {
		if (events.length > 0) this.#options.emit(events);
	}

	pointerDown(id: number, x: number, y: number): void {
		this.#stopFling();
		this.#pointers.set(id, { x, y });
		if (this.#pointers.size === 2) {
			// A second finger turns whatever the first started into a pinch; nothing of it is sent.
			this.#clearLongPress();
			if (this.#phase === "drag")
				this.#emit({ t: "drag", phase: "end", ...this.#fraction(this.#last.x, this.#last.y) });
			const [a, b] = [...this.#pointers.values()];
			this.#pinchStart = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
			this.#pinchScale = 1;
			this.#phase = "pinch";
			return;
		}
		if (this.#pointers.size > 2 || this.#phase === "pinch") return;
		this.#primary = id;
		this.#phase = "pending";
		this.#start = { x, y, t: this.#now() };
		this.#last = { x, y };
		this.#samples = [{ t: this.#start.t, x, y }];
		this.#cancelLongPress = this.#timers.after(() => this.#longPress(), LONG_PRESS_MS);
	}

	pointerMove(id: number, x: number, y: number): void {
		const pointer = this.#pointers.get(id);
		if (!pointer) return;
		pointer.x = x;
		pointer.y = y;
		if (this.#phase === "pinch") {
			const [a, b] = [...this.#pointers.values()];
			if (a && b && this.#pinchStart > 0) {
				this.#pinchScale = Math.hypot(a.x - b.x, a.y - b.y) / this.#pinchStart;
				this.#options.onPinch?.(this.#pinchScale);
			}
			return;
		}
		if (id !== this.#primary) return;
		const now = this.#now();
		if (this.#phase === "pending") {
			if (Math.hypot(x - this.#start.x, y - this.#start.y) <= TAP_SLOP_PX) return;
			this.#clearLongPress();
			this.#phase = "scroll";
			// The scroll starts from where the finger first was, so the slop is not lost.
			this.#last = { x: this.#start.x, y: this.#start.y };
		} else if (this.#phase === "press") {
			if (Math.hypot(x - this.#start.x, y - this.#start.y) <= TAP_SLOP_PX) return;
			this.#phase = "drag";
			this.#emit({ t: "drag", phase: "start", ...this.#fraction(this.#start.x, this.#start.y) });
			this.#last = { x: this.#start.x, y: this.#start.y };
		}
		if (this.#phase === "drag") {
			this.#emit({ t: "drag", phase: "move", ...this.#fraction(x, y) });
			this.#last = { x, y };
			return;
		}
		if (this.#phase === "scroll") {
			const dx = this.#last.x - x;
			const dy = this.#last.y - y;
			this.#last = { x, y };
			this.#samples.push({ t: now, x, y });
			if (this.#samples.length > 6) this.#samples.shift();
			if (dx !== 0 || dy !== 0) this.#emit({ t: "wheel", ...this.#fraction(x, y), dx, dy });
		}
	}

	pointerUp(id: number): void {
		const pointer = this.#pointers.get(id);
		if (!pointer) return;
		this.#pointers.delete(id);
		if (this.#phase === "pinch") {
			if (this.#pointers.size === 0) this.#endPinch();
			return;
		}
		if (id !== this.#primary) return;
		this.#clearLongPress();
		const phase = this.#phase;
		this.#phase = "idle";
		this.#primary = null;
		const at = this.#fraction(pointer.x, pointer.y);
		if (phase === "pending") {
			// The tap is where the finger first touched, not where a wobble left it.
			if (this.#now() - this.#start.t <= TAP_MAX_MS) this.#tap({ x: this.#start.x, y: this.#start.y });
		} else if (phase === "press") {
			this.#emit({ t: "context", ...this.#fraction(this.#start.x, this.#start.y) });
		} else if (phase === "drag") {
			this.#emit({ t: "drag", phase: "end", ...at });
		} else if (phase === "scroll") {
			this.#fling(pointer);
		}
	}

	/** The browser took the touch (a system gesture, a scroll of the page itself): nothing is sent. */
	pointerCancel(id: number): void {
		const wasDrag = this.#phase === "drag" && id === this.#primary;
		this.#pointers.delete(id);
		if (this.#phase === "pinch" && this.#pointers.size === 0) {
			this.#phase = "idle";
			this.#options.onPinch?.(null);
		}
		if (id !== this.#primary) return;
		this.#clearLongPress();
		if (wasDrag) this.#emit({ t: "drag", phase: "end", ...this.#fraction(this.#last.x, this.#last.y) });
		this.#phase = "idle";
		this.#primary = null;
	}

	#tap(at: Pointer): void {
		const now = this.#now();
		const previous = this.#lastTap;
		const count =
			previous &&
			now - previous.t <= DOUBLE_TAP_MS &&
			Math.hypot(at.x - previous.x, at.y - previous.y) <= DOUBLE_TAP_SLOP_PX
				? Math.min(3, previous.count + 1)
				: 1;
		this.#lastTap = { x: at.x, y: at.y, t: now, count };
		this.#emit({ t: "tap", ...this.#fraction(at.x, at.y), ...(count > 1 ? { count: count as 2 | 3 } : {}) });
	}

	#longPress(): void {
		this.#cancelLongPress = null;
		if (this.#phase === "pending") this.#phase = "press";
	}

	#clearLongPress(): void {
		this.#cancelLongPress?.();
		this.#cancelLongPress = null;
	}

	#endPinch(): void {
		const scale = this.#pinchScale;
		this.#phase = "idle";
		this.#primary = null;
		this.#options.onPinch?.(null);
		if (Math.abs(scale - 1) > PINCH_MIN_CHANGE) this.#emit({ t: "pinch", scale });
	}

	/** Keep scrolling after the finger lifts, slowing down, at the speed it left with. */
	#fling(at: Pointer): void {
		const now = this.#now();
		const recent = this.#samples.filter(sample => now - sample.t <= 100);
		const first = recent[0];
		const last = recent.at(-1);
		if (!first || !last || last.t === first.t) return;
		let vx = (first.x - last.x) / (last.t - first.t);
		let vy = (first.y - last.y) / (last.t - first.t);
		if (Math.hypot(vx, vy) < FLING_MIN_SPEED) return;
		const where = this.#fraction(at.x, at.y);
		this.#cancelFling = this.#timers.repeat(() => {
			const dx = vx * FLING_STEP_MS;
			const dy = vy * FLING_STEP_MS;
			vx *= FLING_DECAY;
			vy *= FLING_DECAY;
			this.#emit({ t: "wheel", ...where, dx, dy });
			if (Math.hypot(vx, vy) < FLING_STOP_SPEED) this.#stopFling();
		}, FLING_STEP_MS);
	}

	#stopFling(): void {
		this.#cancelFling?.();
		this.#cancelFling = null;
	}

	/** The viewer left (the panel closed, the page changed): no timer outlives it. */
	dispose(): void {
		this.#clearLongPress();
		this.#stopFling();
		this.#pointers.clear();
		this.#phase = "idle";
	}
}
