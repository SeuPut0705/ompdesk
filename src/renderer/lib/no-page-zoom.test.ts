import { describe, expect, it } from "vitest";
import { blockPageZoom } from "./no-page-zoom";

describe("blockPageZoom: iOS's pinch never zooms a phone's page", () => {
	it("refuses WebKit's gesture events until it is removed", () => {
		const target = new EventTarget();
		const fire = (name: string) => {
			const event = new Event(name, { cancelable: true });
			target.dispatchEvent(event);
			return event.defaultPrevented;
		};
		const stop = blockPageZoom(target as unknown as Document);
		expect(["gesturestart", "gesturechange", "gestureend"].map(fire)).toEqual([true, true, true]);
		// One finger still scrolls; two fingers moving are a pinch the browser never gets.
		const touch = (count: number) => {
			const event = new Event("touchmove", { cancelable: true });
			Object.defineProperty(event, "touches", { value: { length: count } });
			target.dispatchEvent(event);
			return event.defaultPrevented;
		};
		expect(touch(1)).toBe(false);
		expect(touch(2)).toBe(true);
		stop();
		expect(fire("gesturestart")).toBe(false);
		expect(touch(2)).toBe(false);
	});
});
