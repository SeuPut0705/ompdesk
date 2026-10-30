import { afterEach, describe, expect, it, vi } from "vitest";
import { CUE_STEP_MS, installCueClock } from "./cue-clock";

/** An animation as the clock reads and writes it. */
class FakeAnimation {
	playState: AnimationPlayState = "running";
	playbackRate = 1;
	currentTime: number | null = 0;
	constructor(
		public startTime: number | null,
		readonly iterations: number,
	) {}
	readonly effect = { getComputedTiming: () => ({ iterations: this.iterations }) };
}

function fakeView(animations: FakeAnimation[]) {
	const now = { at: 1000 };
	const doc = Object.assign(new EventTarget(), {
		visibilityState: "visible" as DocumentVisibilityState,
		focused: true,
		hasFocus() {
			return this.focused;
		},
		getAnimations: () => animations,
		timeline: {
			get currentTime() {
				return now.at;
			},
		},
	});
	const view = Object.assign(new EventTarget(), {
		document: doc,
		setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
		setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
		clearInterval: (id: number | undefined) => clearInterval(id),
		performance: { now: () => now.at },
	});
	return { view: view as unknown as Window, doc, now };
}

afterEach(() => vi.useRealTimers());

describe("installCueClock", () => {
	it("holds every loop while the window is visible and unfocused and moves them together, ten times a second", async () => {
		vi.useFakeTimers();
		const loop = new FakeAnimation(400, Number.POSITIVE_INFINITY);
		const other = new FakeAnimation(700, Number.POSITIVE_INFINITY);
		const once = new FakeAnimation(900, 1);
		const { view, doc, now } = fakeView([loop, other, once]);
		const uninstall = installCueClock(view);
		await vi.advanceTimersByTimeAsync(0);
		// Focused: nothing is touched.
		expect(loop.playbackRate).toBe(1);

		doc.focused = false;
		view.dispatchEvent(new Event("blur"));
		await vi.advanceTimersByTimeAsync(0);
		expect([loop.playbackRate, other.playbackRate, once.playbackRate]).toEqual([0, 0, 1]);
		// Still "running": only its pace is held.
		expect(loop.playState).toBe("running");
		expect(loop.currentTime).toBe(600);

		now.at = 1250;
		await vi.advanceTimersByTimeAsync(CUE_STEP_MS);
		expect([loop.currentTime, other.currentTime]).toEqual([850, 550]);

		doc.focused = true;
		view.dispatchEvent(new Event("focus"));
		await vi.advanceTimersByTimeAsync(0);
		// Its own pace again, on the phase it had all along.
		expect([loop.playbackRate, loop.startTime]).toEqual([1, 400]);
		now.at = 2000;
		await vi.advanceTimersByTimeAsync(CUE_STEP_MS * 3);
		expect(loop.currentTime).toBe(850);
		uninstall();
	});

	it("lets every loop go when the window is hidden, and on uninstall", async () => {
		vi.useFakeTimers();
		const loop = new FakeAnimation(0, Number.POSITIVE_INFINITY);
		const { view, doc } = fakeView([loop]);
		const uninstall = installCueClock(view);
		doc.focused = false;
		view.dispatchEvent(new Event("blur"));
		await vi.advanceTimersByTimeAsync(0);
		expect(loop.playbackRate).toBe(0);
		doc.visibilityState = "hidden";
		doc.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(0);
		expect(loop.playbackRate).toBe(1);
		doc.visibilityState = "visible";
		doc.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(0);
		expect(loop.playbackRate).toBe(0);
		uninstall();
		expect(loop.playbackRate).toBe(1);
	});
});
