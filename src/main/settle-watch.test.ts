import { describe, expect, it } from "vitest";
import { SettleWatch, type SettleWatchTimers } from "./settle-watch";

function fakeTimers() {
	let now = 0;
	const due: Array<{ at: number; run: () => void; id: number }> = [];
	let next = 0;
	const timers: SettleWatchTimers = {
		now: () => now,
		setTimeout: (run, ms) => {
			const id = ++next;
			due.push({ at: now + ms, run, id });
			return id;
		},
		clearTimeout: handle => {
			const i = due.findIndex(d => d.id === handle);
			if (i >= 0) due.splice(i, 1);
		},
	};
	const advance = async (ms: number) => {
		now += ms;
		for (const d of due.filter(d => d.at <= now)) {
			due.splice(due.indexOf(d), 1);
			d.run();
		}
		await Promise.resolve();
		await Promise.resolve();
	};
	return { timers, advance };
}

describe("settle watch", () => {
	it("logs stock's state, main's flags and the last settle frame once a tab stays settling past the delay", async () => {
		const { timers, advance } = fakeTimers();
		const lines: Array<Record<string, unknown>> = [];
		const watch = new SettleWatch({
			timers,
			delayMs: 60_000,
			facts: async () => ({
				stock: { isSettled: true, hasPendingAsyncWork: false },
				run: { running: true, turn: false },
			}),
			log: details => lines.push(details),
		});
		watch.noteFrame("t1", "prompt_result", false);
		watch.track("t1", true);
		await advance(59_999);
		expect(lines).toEqual([]);
		watch.track("t1", true);
		await advance(1);
		expect(lines).toEqual([
			{
				tabId: "t1",
				settlingMs: 60_000,
				lastSettleFrame: { frame: "prompt_result", settled: false, at: 0, ageMs: 60_000 },
				stock: { isSettled: true, hasPendingAsyncWork: false },
				run: { running: true, turn: false },
			},
		]);
		await advance(120_000);
		expect(lines).toHaveLength(1);
	});

	it("writes nothing for a tab that settles in time, or settles while stock is being asked", async () => {
		const { timers, advance } = fakeTimers();
		const lines: unknown[] = [];
		let answer!: (facts: Record<string, unknown>) => void;
		const watch = new SettleWatch({
			timers,
			delayMs: 60_000,
			facts: () => new Promise(r => (answer = r)),
			log: details => lines.push(details),
		});
		watch.track("t1", true);
		await advance(30_000);
		watch.track("t1", false);
		await advance(60_000);
		watch.track("t2", true);
		await advance(60_000);
		watch.track("t2", false);
		answer({});
		await advance(0);
		expect(lines).toEqual([]);
	});

	it("a new stretch of settling is watched afresh, and a released tab is forgotten", async () => {
		const { timers, advance } = fakeTimers();
		const lines: Array<Record<string, unknown>> = [];
		const watch = new SettleWatch({ timers, delayMs: 10, facts: async () => ({}), log: d => lines.push(d) });
		watch.track("t1", true);
		await advance(10);
		watch.track("t1", false);
		watch.track("t1", true);
		await advance(10);
		expect(lines.map(l => l.tabId)).toEqual(["t1", "t1"]);
		watch.track("t2", true);
		watch.forget("t2");
		await advance(10);
		expect(lines).toHaveLength(2);
	});
});
