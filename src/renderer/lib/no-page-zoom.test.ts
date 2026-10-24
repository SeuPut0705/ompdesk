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
		// A touch still reaches the page: a view that pinches by itself keeps working.
		expect(fire("touchmove")).toBe(false);
		stop();
		expect(fire("gesturestart")).toBe(false);
	});
});
