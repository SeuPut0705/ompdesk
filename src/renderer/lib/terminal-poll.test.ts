/** The phone's terminal read loop: one request at a time, the next only after xterm took the output. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	TERMINAL_OUTPUT_BUDGET,
	TERMINAL_POLL_MAX_WAIT_MS,
	type TerminalOperation,
	type TerminalSnapshot,
} from "../../shared/terminal-types";
import { MIN_GAP_MS, pollTerminal, RETRY_MS } from "./terminal-poll";

const ID = "pty-1";
const snapshot = (output: string, offset: number, extra: Partial<TerminalSnapshot> = {}): TerminalSnapshot => ({
	id: ID,
	output,
	offset,
	exited: false,
	...extra,
});

type Answer = TerminalSnapshot[] | null | ((advance: (ms: number) => void) => Promise<TerminalSnapshot[] | null>);

function harness(answers: Answer[]) {
	let now = 0;
	let stop = false;
	let inFlight = 0;
	let maxInFlight = 0;
	const requests: TerminalOperation[] = [];
	const written: string[] = [];
	const snapshots: TerminalSnapshot[] = [];
	const slept: number[] = [];
	const writes: Array<() => void> = [];
	const run = pollTerminal({
		id: ID,
		now: () => now,
		sleep: async ms => {
			slept.push(ms);
			now += ms;
		},
		stopped: () => stop,
		onSnapshot: item => snapshots.push(item),
		request: async operation => {
			requests.push(operation);
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			const next = answers.shift();
			try {
				if (next === undefined) {
					// The last request ends the run, after a full hold, so it adds no pause of its own.
					stop = true;
					now += TERMINAL_POLL_MAX_WAIT_MS;
					return [snapshot("", 0)];
				}
				return typeof next === "function"
					? await next(ms => {
							now += ms;
						})
					: next;
			} finally {
				inFlight -= 1;
			}
		},
		write: output => {
			written.push(output);
			const { promise, resolve } = Promise.withResolvers<void>();
			writes.push(resolve);
			return promise;
		},
	});
	return {
		run,
		requests,
		written,
		snapshots,
		slept,
		maxInFlight: () => maxInFlight,
		/** xterm has parsed the oldest output it was given. */
		parsed: () => writes.shift()?.(),
		tick: () => vi.advanceTimersByTimeAsync(0),
		advance: (ms: number) => {
			now += ms;
		},
		stop: () => {
			stop = true;
		},
	};
}

describe("pollTerminal", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("asks as a long poll with the viewer's offset and an output budget", async () => {
		const h = harness([[snapshot("", 5)]]);
		await h.run;
		expect(h.requests[0]).toEqual({
			action: "list",
			offsets: { [ID]: 0 },
			waitMs: TERMINAL_POLL_MAX_WAIT_MS,
			budget: TERMINAL_OUTPUT_BUDGET,
		});
	});

	it("does not ask again until xterm has taken the output, then asks from where the viewer reached", async () => {
		const h = harness([[snapshot("hello", 5)], [snapshot(" world", 11)]]);
		await h.tick();
		expect(h.requests).toHaveLength(1);
		expect(h.written).toEqual(["hello"]);
		// xterm is still parsing: a flood of output cannot pile up behind a slow screen.
		await h.tick();
		await h.tick();
		expect(h.requests).toHaveLength(1);
		h.parsed();
		await h.tick();
		expect(h.requests).toHaveLength(2);
		expect(h.requests[1]).toMatchObject({ offsets: { [ID]: 5 } });
		h.parsed();
		await h.run;
		expect(h.requests[2]).toMatchObject({ offsets: { [ID]: 11 } });
		expect(h.written).toEqual(["hello", " world"]);
		expect(h.maxInFlight()).toBe(1);
	});

	it("reports every snapshot, so an exit or a resize reaches the panel", async () => {
		const h = harness([[snapshot("", 0, { exited: true, exitCode: 1, cols: 100, rows: 30, lease: "other" })]]);
		await h.run;
		expect(h.snapshots[0]).toMatchObject({ exited: true, exitCode: 1, cols: 100, lease: "other" });
	});

	it("keeps an empty answer from becoming a busy loop on a host without the long poll", async () => {
		const h = harness([[snapshot("", 0)], [snapshot("", 0)], [snapshot("", 0)]]);
		await h.run;
		expect(h.slept.length).toBeGreaterThanOrEqual(3);
		expect(h.slept.every(ms => ms === MIN_GAP_MS)).toBe(true);
	});

	it("does not pause after a held answer (the host already waited)", async () => {
		const held = async (advance: (ms: number) => void) => {
			advance(1000);
			return [snapshot("", 0)];
		};
		const h = harness([held, held]);
		await h.run;
		expect(h.slept).toEqual([]);
	});

	it("retries after a failed request, and when the session is gone", async () => {
		const h = harness([null, [], [snapshot("ok", 2)]]);
		await h.tick();
		h.parsed();
		await h.run;
		expect(h.slept.slice(0, 2)).toEqual([RETRY_MS, RETRY_MS]);
		expect(h.written).toEqual(["ok"]);
	});

	it("stops at once, dropping an answer that arrives after it", async () => {
		const answer = Promise.withResolvers<TerminalSnapshot[] | null>();
		const h = harness([() => answer.promise]);
		await h.tick();
		h.stop();
		answer.resolve([snapshot("late", 4)]);
		await h.run;
		expect(h.written).toEqual([]);
	});
});
