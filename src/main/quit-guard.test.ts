/**
 * What the ⌘Q confirmation is built from: the guard must count live runs, the
 * tabs they sit on, and the distinct windows to name in the message, and it
 * must stay silent when nothing is in flight (otherwise ⌘Q becomes a two-step
 * quit for every idle window).
 */

import { describe, expect, it, vi } from "vitest";
import {
	assessQuitRisk,
	lastWindowCloseAction,
	QuitLatch,
	quitNeedsConfirmation,
	type WindowTabFact,
} from "./quit-guard";

function fact(windowId: number, tabId: string, inFlight: boolean): WindowTabFact {
	return { windowId, tabId, inFlight };
}

describe("quit guard risk assessment", () => {
	it("counts only the in-flight tabs and the windows that hold them", () => {
		expect(
			assessQuitRisk([fact(1, "a", true), fact(1, "b", false), fact(2, "c", true), fact(3, "d", false)]),
		).toEqual({ workingTabs: 2, totalTabs: 4, workingWindows: 2 });
	});

	it("names one window once even when several of its tabs are working", () => {
		expect(assessQuitRisk([fact(7, "a", true), fact(7, "b", true), fact(7, "c", true)]).workingWindows).toBe(1);
	});

	it("asks only while work is in flight", () => {
		expect(quitNeedsConfirmation(assessQuitRisk([]))).toBe(false);
		expect(quitNeedsConfirmation(assessQuitRisk([fact(1, "a", false)]))).toBe(false);
		expect(quitNeedsConfirmation(assessQuitRisk([fact(1, "a", true)]))).toBe(true);
	});
});

describe("quit latch", () => {
	it("refuses an unapproved quit without tearing anything down", () => {
		const teardown = vi.fn();
		const latch = new QuitLatch();

		expect(latch.proceed(teardown)).toBe(false);
		expect(latch.approved).toBe(false);
		expect(teardown).not.toHaveBeenCalled();
	});

	it("tears down once per approved quit", () => {
		const teardown = vi.fn();
		const latch = new QuitLatch();
		latch.approve();

		expect(latch.proceed(teardown)).toBe(true);
		expect(latch.proceed(teardown)).toBe(true);
		expect(teardown).toHaveBeenCalledTimes(1);
	});

	it("runs the ⌘Q teardown when an update quits, before its windows close", () => {
		const teardown = vi.fn();
		const latch = new QuitLatch();

		// quitAndInstall() emits before-quit-for-update, then closes every window,
		// then emits before-quit: the teardown must already have run, and the
		// later before-quit must neither ask again nor tear down twice.
		latch.proceedForUpdate(teardown);
		expect(teardown).toHaveBeenCalledTimes(1);
		expect(latch.proceed(teardown)).toBe(true);
		expect(teardown).toHaveBeenCalledTimes(1);
	});
});

describe("closing the last shown window", () => {
	const close = (platform: NodeJS.Platform, closeToTray: boolean, quitApproved = false) =>
		lastWindowCloseAction({ platform, closeToTray, quitApproved });

	it("on Windows quits through the quit guard before the window goes, so running turns are asked about and resume", () => {
		// Closed first, the window's tabs would end as if their turns had finished (markers cleared),
		// and window-all-closed would quit afterwards with neither the confirmation nor a resume.
		expect(close("win32", false)).toBe("quit");
	});

	it("hides to the tray when the user chose close-to-tray", () => {
		expect(close("win32", true)).toBe("hide");
	});

	it("just closes once a quit is approved, and on macOS, which keeps running with no window", () => {
		expect(close("win32", false, true)).toBe("close");
		expect(close("win32", true, true)).toBe("close");
		expect(close("darwin", false)).toBe("close");
		expect(close("darwin", true)).toBe("close");
	});
});
