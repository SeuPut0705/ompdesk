/**
 * What the quit confirmation is built from: the guard must count live runs, the
 * tabs they sit on, and the distinct windows to name in the message, and it
 * must stay silent when nothing would stop: nothing in flight (otherwise ⌘Q
 * becomes a two-step quit for every idle window), or running work that the next
 * launch continues (Continue interrupted work on; ⌘Q and the update restart alike).
 */

import { describe, expect, it, vi } from "vitest";
import { closeToTrayEnabled } from "../shared/desktop-prefs";
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

	it("asks only while work is in flight and quitting would stop it", () => {
		const working = assessQuitRisk([fact(1, "a", true)]);
		// Continue interrupted work off: the quit really stops the run.
		expect(quitNeedsConfirmation(assessQuitRisk([]), false)).toBe(false);
		expect(quitNeedsConfirmation(assessQuitRisk([fact(1, "a", false)]), false)).toBe(false);
		expect(quitNeedsConfirmation(working, false)).toBe(true);
		// On (the default): the marker stays and the next launch continues the run, so nothing asks.
		expect(quitNeedsConfirmation(working, true)).toBe(false);
		expect(quitNeedsConfirmation(assessQuitRisk([]), true)).toBe(false);
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

	it("hides to the tray unless the user turned close-to-tray off", () => {
		expect(close("win32", true)).toBe("hide");
	});

	it("just closes once a quit is approved", () => {
		expect(close("win32", false, true)).toBe("close");
		expect(close("win32", true, true)).toBe("close");
		expect(close("darwin", false, true)).toBe("close");
	});

	it("hides on macOS whatever the pref, so tabs and omp keep running and the Dock brings it back", () => {
		expect(close("darwin", false)).toBe("hide");
		expect(close("darwin", true)).toBe("hide");
	});

	it("reads the close-to-tray pref as on unless explicitly false", () => {
		expect(closeToTrayEnabled(undefined)).toBe(true);
		expect(closeToTrayEnabled(true)).toBe(true);
		expect(closeToTrayEnabled(false)).toBe(false);
	});
});
