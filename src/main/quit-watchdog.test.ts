/**
 * The force-exit timer behind a committed quit or update install (quit-watchdog.ts): it fires once the
 * deadline passes with the process still alive, not before, never after the quit was cancelled, and a
 * repeated arm (every `before-quit` event) does not push the deadline out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUIT_EXIT_TIMEOUT_MS, QuitWatchdog, type QuitWatchdogReport } from "./quit-watchdog";

function watchdog(timeoutMs?: number) {
	const exit = vi.fn<() => void>();
	const log = vi.fn<(report: QuitWatchdogReport) => void>();
	const dog = new QuitWatchdog({
		setTimer: (fn, ms) => setTimeout(fn, ms),
		clearTimer: handle => clearTimeout(handle as NodeJS.Timeout),
		log,
		exit,
		timeoutMs,
	});
	return { dog, exit, log };
}

describe("quit watchdog", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("forces the exit after the deadline and not before, logging why", () => {
		const { dog, exit, log } = watchdog();
		dog.arm("update");
		expect(dog.armed).toBe(true);
		vi.advanceTimersByTime(QUIT_EXIT_TIMEOUT_MS - 1);
		expect(exit).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(exit).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledTimes(1);
		expect(log.mock.calls[0]?.[0]).toMatchObject({
			source: "background-task",
			details: { watchdog: "quit", reason: "update", timeoutMs: QUIT_EXIT_TIMEOUT_MS },
		});
		expect(dog.armed).toBe(false);
	});

	it("does nothing when nothing was armed", () => {
		const { exit } = watchdog();
		vi.advanceTimersByTime(QUIT_EXIT_TIMEOUT_MS * 2);
		expect(exit).not.toHaveBeenCalled();
	});

	it("stays quiet after the quit is cancelled", () => {
		const { dog, exit, log } = watchdog();
		dog.arm("update");
		vi.advanceTimersByTime(QUIT_EXIT_TIMEOUT_MS / 2);
		dog.disarm();
		expect(dog.armed).toBe(false);
		vi.advanceTimersByTime(QUIT_EXIT_TIMEOUT_MS * 2);
		expect(exit).not.toHaveBeenCalled();
		expect(log).not.toHaveBeenCalled();
	});

	it("disarms by reason only when the reason matches", () => {
		const { dog, exit } = watchdog();
		dog.arm("quit");
		dog.disarm("update");
		expect(dog.armed).toBe(true);
		vi.advanceTimersByTime(QUIT_EXIT_TIMEOUT_MS);
		expect(exit).toHaveBeenCalledTimes(1);

		dog.arm("update");
		dog.disarm("update");
		expect(dog.armed).toBe(false);
	});

	it("keeps the first deadline when armed again", () => {
		const { dog, exit } = watchdog(1000);
		dog.arm("quit");
		vi.advanceTimersByTime(600);
		dog.arm("quit");
		vi.advanceTimersByTime(400);
		expect(exit).toHaveBeenCalledTimes(1);
	});

	it("can be armed again after a cancel", () => {
		const { dog, exit } = watchdog(1000);
		dog.arm("update");
		dog.disarm();
		dog.arm("update");
		vi.advanceTimersByTime(1000);
		expect(exit).toHaveBeenCalledTimes(1);
	});
});
