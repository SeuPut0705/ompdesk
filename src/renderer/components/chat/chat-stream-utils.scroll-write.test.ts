import { Virtualizer } from "@tanstack/react-virtual";
import { describe, expect, it } from "vitest";
import { compensateRowsAbove, readerMoved, transcriptScrollTo, viewMark } from "./chat-stream-utils";

/** A scroll element as the virtualizer writes it: `scrollTo` moves `scrollTop` at once, as a browser does. */
interface FakeScroller {
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
	scrollTo(options: { top?: number }): void;
}

function scroller(): FakeScroller {
	const element: FakeScroller = {
		scrollTop: 0,
		scrollHeight: 50_000,
		clientHeight: 800,
		scrollTo(options) {
			element.scrollTop = Math.max(0, options.top ?? element.scrollTop);
		},
	};
	return element;
}

function transcript(element: FakeScroller): Virtualizer<HTMLElement, Element> {
	const virtualizer = new Virtualizer<HTMLElement, Element>({
		count: 100,
		estimateSize: () => 100,
		getScrollElement: () => element as unknown as HTMLElement,
		observeElementRect: () => undefined,
		observeElementOffset: () => undefined,
		scrollToFn: transcriptScrollTo,
		anchorTo: "start",
	});
	virtualizer._willUpdate();
	// Lays the rows out at their estimates.
	virtualizer.getTotalSize();
	return virtualizer;
}

// 26 Oct 2026, the user's phone: flinging up through a long transcript jumped thousands of pixels and back. The page
// that loads older history moves the view down by the page's height with `scrollToOffset`, and the virtualizer only
// learns the new offset from the next scroll event; a row above measured in the same frame was compensated from the
// stale offset (still the fling's, near the top), which wrote the view back up by the whole page (2636 → 275).
describe("transcriptScrollTo", () => {
	it("lets a measurement right after a write compensate from where the view now is", () => {
		const element = scroller();
		const virtualizer = transcript(element);
		// The fling's last scroll event left the virtualizer at 130.
		virtualizer.scrollOffset = 130;
		element.scrollTop = 130;
		virtualizer.scrollToOffset(2600);
		expect(element.scrollTop).toBe(2600);
		// A row near the page's top, above both the stale and the real view, measures 60px taller than its estimate
		// before the next scroll event.
		virtualizer.resizeItem(1, 160);
		expect(element.scrollTop).toBe(2660);
	});

	it("leaves the virtualizer's own adjustments to it, so an adjustment is applied once", () => {
		const element = scroller();
		const virtualizer = transcript(element);
		virtualizer.scrollOffset = 2600;
		element.scrollTop = 2600;
		virtualizer.resizeItem(5, 160);
		virtualizer.resizeItem(6, 130);
		expect(element.scrollTop).toBe(2690);
		expect(virtualizer.scrollOffset).toBe(2690);
	});
});

// The same fling, past the page load: a row above the view that measures again (its picture or card settles, or it
// mounts again at another height) moved what the reader reads by its change, because the virtualizer leaves a
// re-measured row uncompensated while the view moves up; flinging up from the tail of a streaming reply moved the
// text by 431px in one frame.
describe("compensateRowsAbove", () => {
	it("keeps the view on its text when a row above it measures again while the view moves up", () => {
		const element = scroller();
		const virtualizer = transcript(element);
		virtualizer.shouldAdjustScrollPositionOnItemSizeChange = compensateRowsAbove;
		virtualizer.scrollOffset = 2600;
		element.scrollTop = 2600;
		virtualizer.resizeItem(1, 160);
		expect(element.scrollTop).toBe(2660);
		virtualizer.scrollDirection = "backward";
		virtualizer.resizeItem(1, 120);
		expect(element.scrollTop).toBe(2620);
	});

	it("leaves a row the view's top cuts through to grow below the fold, as a streaming reply does", () => {
		const element = scroller();
		const virtualizer = transcript(element);
		virtualizer.shouldAdjustScrollPositionOnItemSizeChange = compensateRowsAbove;
		// Row 25 spans 2500-2600 at its estimate; the view's top is in it.
		virtualizer.scrollOffset = 2550;
		element.scrollTop = 2550;
		virtualizer.resizeItem(25, 150);
		expect(element.scrollTop).toBe(2600);
		virtualizer.scrollDirection = "backward";
		virtualizer.resizeItem(25, 450);
		expect(element.scrollTop).toBe(2600);
	});
});

describe("readerMoved", () => {
	it("tells the reader's own scrolling from the writes the transcript made", () => {
		const element = scroller();
		const virtualizer = transcript(element);
		virtualizer.scrollOffset = 1000;
		element.scrollTop = 1000;
		const mark = viewMark(virtualizer);
		expect(readerMoved(virtualizer, mark)).toBe(false);
		// A write since the mark (a hold, the virtualizer's own adjustment) is where the view should be.
		virtualizer.scrollToOffset(1400);
		expect(readerMoved(virtualizer, mark)).toBe(false);
		// A scroll event reports the view somewhere no write put it: the reader's finger or wheel.
		virtualizer.scrollOffset = 1320;
		expect(readerMoved(virtualizer, mark)).toBe(true);
		expect(readerMoved(virtualizer, viewMark(virtualizer))).toBe(false);
	});
});
