import { afterEach, describe, expect, it, vi } from "vitest";
import { createPendingToolCalls } from "../../resources/gui-bridge/quit-journal-core";

afterEach(() => {
	vi.useRealTimers();
});

describe("the tool calls a quit waits for", () => {
	it("lets a quit with nothing running go at once", async () => {
		expect(await createPendingToolCalls().settled(1_000)).toBe(true);
	});

	it("holds the quit until every started call has its result, however they finish", async () => {
		const calls = createPendingToolCalls();
		calls.start("a");
		calls.start("b");
		let outcome: boolean | undefined;
		void calls.settled(1_000).then(value => {
			outcome = value;
		});
		calls.settle("b");
		await Promise.resolve();
		expect(outcome).toBeUndefined();
		calls.settle("a");
		await vi.waitFor(() => expect(outcome).toBe(true));
	});

	it("gives up after the bound when a tool never returns, and says so", async () => {
		vi.useFakeTimers();
		const calls = createPendingToolCalls();
		calls.start("stuck");
		const waiting = calls.settled(1_500);
		await vi.advanceTimersByTimeAsync(1_499);
		let done = false;
		void waiting.then(() => {
			done = true;
		});
		await Promise.resolve();
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(await waiting).toBe(false);
	});

	it("does not count a result for a call it never saw", async () => {
		const calls = createPendingToolCalls();
		calls.start("a");
		calls.settle("other");
		expect(calls.size).toBe(1);
	});
});
