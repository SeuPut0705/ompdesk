import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { showOnFirstPaint } from "./window-show";

function fakeWindow() {
	const win = new EventEmitter();
	const contents = new EventEmitter();
	const shows: string[] = [];
	return { win, contents, shows, show: () => shows.push("show") };
}

describe("showOnFirstPaint", () => {
	it("shows a window whose ready-to-show never comes once its page has loaded", () => {
		// Electron on Windows: a hidden window with titleBarOverlay never emits ready-to-show
		// when its first frame is slow (electron/electron#54025).
		const w = fakeWindow();
		showOnFirstPaint(w.win, w.contents, w.show);
		w.contents.emit("did-finish-load");
		expect(w.shows).toEqual(["show"]);
	});

	it("shows once when both events come", () => {
		const w = fakeWindow();
		showOnFirstPaint(w.win, w.contents, w.show);
		w.win.emit("ready-to-show");
		w.contents.emit("did-finish-load");
		w.contents.emit("did-finish-load");
		expect(w.shows).toEqual(["show"]);
	});
});
