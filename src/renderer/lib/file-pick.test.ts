/** `trackFilePick`: a pick lasts from the click until its files landed or it was dismissed. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { filePickInProgress, PICK_RETURN_GRACE_MS, trackFilePick } from "./file-pick";

class FakeDocument extends EventTarget {
	visibilityState: "visible" | "hidden" = "visible";
	focused = true;
	hasFocus(): boolean {
		return this.focused;
	}
}

let doc: FakeDocument;
let view: Window;
let input: HTMLInputElement;
const ends: (() => void)[] = [];

function track(): () => void {
	const done = trackFilePick(input, view);
	ends.push(done);
	return done;
}

/** The phone's picker takes the screen (the page is hidden), then gives it back. */
function pickerShown(): void {
	doc.visibilityState = "hidden";
	doc.focused = false;
	view.dispatchEvent(new Event("blur"));
	doc.dispatchEvent(new Event("visibilitychange"));
}
function pickerGone(): void {
	doc.visibilityState = "visible";
	doc.focused = true;
	doc.dispatchEvent(new Event("visibilitychange"));
	view.dispatchEvent(new Event("focus"));
}

beforeEach(() => {
	vi.useFakeTimers();
	doc = new FakeDocument();
	view = Object.assign(new EventTarget(), { document: doc }) as unknown as Window;
	input = new EventTarget() as unknown as HTMLInputElement;
});

afterEach(() => {
	for (const done of ends.splice(0)) done();
	vi.useRealTimers();
});

describe("trackFilePick", () => {
	it("lasts from the click, through the page hiding behind the picker and its return, until the files landed", () => {
		const done = track();
		expect(filePickInProgress()).toBe(true);
		pickerShown();
		pickerGone();
		input.dispatchEvent(new Event("change"));
		// The files are still being read into the composer: however long that takes, the pick is not over.
		vi.advanceTimersByTime(PICK_RETURN_GRACE_MS * 10);
		expect(filePickInProgress()).toBe(true);
		done();
		expect(filePickInProgress()).toBe(false);
	});

	it("ends when the chooser is dismissed", () => {
		track();
		pickerShown();
		pickerGone();
		input.dispatchEvent(new Event("cancel"));
		expect(filePickInProgress()).toBe(false);
	});

	it("ends a while after the page came back without a change, for a browser that never fires cancel", () => {
		track();
		pickerShown();
		vi.advanceTimersByTime(PICK_RETURN_GRACE_MS * 10);
		expect(filePickInProgress()).toBe(true);
		pickerGone();
		vi.advanceTimersByTime(PICK_RETURN_GRACE_MS - 1);
		expect(filePickInProgress()).toBe(true);
		// A chooser sheet over the page (Android's Camera / Files choice) takes focus again: the wait starts over.
		view.dispatchEvent(new Event("blur"));
		vi.advanceTimersByTime(PICK_RETURN_GRACE_MS * 2);
		expect(filePickInProgress()).toBe(true);
		view.dispatchEvent(new Event("focus"));
		vi.advanceTimersByTime(PICK_RETURN_GRACE_MS);
		expect(filePickInProgress()).toBe(false);
	});

	it("counts each open pick, and ending one twice is harmless", () => {
		const first = track();
		const second = track();
		first();
		first();
		expect(filePickInProgress()).toBe(true);
		second();
		expect(filePickInProgress()).toBe(false);
	});
});
