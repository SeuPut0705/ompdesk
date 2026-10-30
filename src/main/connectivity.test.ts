import { describe, expect, it, vi } from "vitest";
import {
	answersWithin,
	ConnectivityMonitor,
	PROBE_INTERVAL_MS,
	PROBE_TIMEOUT_MS,
	REPROBE_INTERVAL_MS,
	RESUME_WINDOW_MS,
} from "./connectivity";

function harness(initialOnline = true) {
	const state = { online: initialOnline, reachable: true, now: 1_000_000 };
	const changes: boolean[] = [];
	const timers: Array<{ run: () => void; ms: number; live: boolean }> = [];
	const monitor = new ConnectivityMonitor({
		isOnline: () => state.online,
		probe: async () => state.reachable,
		now: () => state.now,
		schedule: (run, ms) => {
			const timer = { run, ms, live: true };
			timers.push(timer);
			return () => {
				timer.live = false;
			};
		},
		changed: online => changes.push(online),
	});
	/** Let the monitor's pending promise chain settle. */
	const settle = async () => {
		for (let i = 0; i < 5; i++) await Promise.resolve();
	};
	const fireTimer = async () => {
		const timer = timers.findLast(candidate => candidate.live);
		if (!timer) throw new Error("no live timer");
		timer.live = false;
		timer.run();
		await settle();
	};
	return { state, changes, monitor, settle, fireTimer, timers };
}

describe("ConnectivityMonitor", () => {
	it("follows the window's offline and online events", () => {
		const { monitor, changes } = harness();
		expect(monitor.online).toBe(true);
		expect(monitor.shouldWait()).toBe(false);

		monitor.report(false);
		expect(monitor.online).toBe(false);
		expect(monitor.shouldWait()).toBe(true);

		monitor.report(true);
		expect(monitor.online).toBe(true);
		expect(monitor.shouldWait()).toBe(false);
		expect(changes).toEqual([false, true]);
	});

	it("does not repeat a change it already reported", () => {
		const { monitor, changes } = harness();
		monitor.report(true);
		monitor.report(false);
		monitor.report(false);
		expect(changes).toEqual([false]);
	});

	it("samples net.isOnline() by edge, so a window's event is not overruled by an unchanged sample", () => {
		const { monitor, state, changes } = harness();
		monitor.report(false);
		monitor.poll();
		expect(monitor.online).toBe(false);

		state.online = false;
		monitor.poll();
		state.online = true;
		monitor.poll();
		expect(monitor.online).toBe(true);
		expect(changes).toEqual([false, true]);
	});

	it("goes offline at suspend and stays there until the wake is confirmed by the probe", async () => {
		const { monitor, state, changes, settle, fireTimer } = harness();
		monitor.suspend();
		expect(changes).toEqual([false]);

		state.reachable = false;
		state.now += 3_600_000;
		monitor.resume();
		await settle();
		expect(monitor.online).toBe(false);
		// An optimistic online event during recovery does not end it; the probe does.
		monitor.report(true);
		await settle();
		expect(monitor.online).toBe(false);

		state.reachable = true;
		await fireTimer();
		expect(monitor.online).toBe(true);
		expect(changes).toEqual([false, true]);
	});

	it("retries the probe on its interval while the network is still down", async () => {
		const { monitor, state, settle, fireTimer, timers } = harness();
		state.reachable = false;
		monitor.resume();
		await settle();
		expect(timers.at(-1)?.ms).toBe(PROBE_INTERVAL_MS);
		await fireTimer();
		await fireTimer();
		expect(monitor.online).toBe(false);
		state.reachable = true;
		await fireTimer();
		expect(monitor.online).toBe(true);
	});

	it("holds a network-class error as waiting for a short window after the wake, then lets it fail", async () => {
		const { monitor, state, settle } = harness();
		monitor.resume();
		await settle();
		expect(monitor.online).toBe(true);
		expect(monitor.shouldWait()).toBe(true);

		state.now += RESUME_WINDOW_MS - 1;
		expect(monitor.shouldWait()).toBe(true);
		state.now += 1;
		expect(monitor.shouldWait()).toBe(false);
	});

	it("stops the wake's probe loop when the computer goes back to sleep", async () => {
		const { monitor, state, settle, timers } = harness();
		state.reachable = false;
		monitor.resume();
		await settle();
		monitor.suspend();
		expect(timers.filter(timer => timer.live).every(timer => timer.ms === REPROBE_INTERVAL_MS)).toBe(true);
	});

	describe("an offline state nothing ends (a missed `online` event, a wake whose `resume` never came)", () => {
		it("asks again on its own interval and goes online as soon as a probe answers", async () => {
			const { monitor, state, changes, settle, fireTimer, timers } = harness();
			monitor.report(false);
			expect(timers.filter(timer => timer.live).map(timer => timer.ms)).toEqual([REPROBE_INTERVAL_MS]);

			// Nothing answers yet: it stays offline and asks again later, for as long as it takes.
			state.reachable = false;
			await fireTimer();
			await fireTimer();
			expect(monitor.online).toBe(false);
			expect(timers.filter(timer => timer.live).map(timer => timer.ms)).toEqual([REPROBE_INTERVAL_MS]);

			// The network is back though no event said so: the next ask releases the wait.
			state.reachable = true;
			await fireTimer();
			expect(monitor.online).toBe(true);
			expect(changes).toEqual([false, true]);
			expect(timers.every(timer => !timer.live)).toBe(true);
		});

		it("is within a minute of the network coming back, with the probe's own time counted", () => {
			expect(REPROBE_INTERVAL_MS + PROBE_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
		});

		it("trusts an answering probe over a link flag that says offline", async () => {
			const { monitor, state, fireTimer } = harness();
			monitor.report(false);
			state.online = false;
			await fireTimer();
			expect(monitor.online).toBe(true);
		});

		it("covers a suspend whose resume never arrives", async () => {
			const { monitor, changes, fireTimer } = harness();
			monitor.suspend();
			await fireTimer();
			expect(monitor.online).toBe(true);
			expect(changes).toEqual([false, true]);
		});

		it("a real online event ends it at once and cancels the asking", () => {
			const { monitor, timers } = harness();
			monitor.report(false);
			monitor.report(true);
			expect(timers.every(timer => !timer.live)).toBe(true);
		});

		it("leaves the wake's own probe loop in charge once the wake comes", async () => {
			const { monitor, state, settle, timers } = harness();
			monitor.suspend();
			state.reachable = false;
			monitor.resume();
			await settle();
			expect(timers.filter(timer => timer.live).map(timer => timer.ms)).toEqual([PROBE_INTERVAL_MS]);
		});

		it("treats a probe that throws as unreachable and asks again", async () => {
			const changes: boolean[] = [];
			const timers: Array<{ run: () => void; ms: number; live: boolean }> = [];
			const monitor = new ConnectivityMonitor({
				isOnline: () => true,
				probe: async () => {
					throw new Error("resolver gone");
				},
				now: () => 0,
				schedule: (run, ms) => {
					const timer = { run, ms, live: true };
					timers.push(timer);
					return () => {
						timer.live = false;
					};
				},
				changed: online => changes.push(online),
			});
			monitor.report(false);
			const timer = timers.findLast(candidate => candidate.live);
			timer?.run();
			for (let i = 0; i < 5; i++) await Promise.resolve();
			expect(monitor.online).toBe(false);
			expect(timers.filter(candidate => candidate.live).map(candidate => candidate.ms)).toEqual([
				REPROBE_INTERVAL_MS,
			]);
			expect(changes).toEqual([false]);
		});
	});

	it("treats a throwing probe as unreachable", async () => {
		const state = { calls: 0 };
		const changes: boolean[] = [];
		const timers: Array<() => void> = [];
		const monitor = new ConnectivityMonitor({
			isOnline: () => true,
			probe: async () => {
				state.calls++;
				throw new Error("dns");
			},
			now: () => 0,
			schedule: run => {
				timers.push(run);
				return () => undefined;
			},
			changed: online => changes.push(online),
		});
		monitor.resume();
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(state.calls).toBe(1);
		expect(monitor.online).toBe(false);
		expect(timers).toHaveLength(1);
	});

	it("asked after a network failure while the link is up, an unreachable network goes offline until the probe answers", async () => {
		const { monitor, state, changes, settle, fireTimer, timers } = harness();
		state.reachable = false;
		expect(await monitor.verify()).toBe(false);
		expect(monitor.online).toBe(false);
		expect(monitor.shouldWait()).toBe(true);
		expect(timers.at(-1)?.ms).toBe(PROBE_INTERVAL_MS);
		// The link reporting itself up again does not end it; only the probe does.
		monitor.report(true);
		await settle();
		await fireTimer();
		expect(monitor.online).toBe(false);

		state.reachable = true;
		await fireTimer();
		expect(monitor.online).toBe(true);
		expect(monitor.shouldWait()).toBe(false);
		expect(changes).toEqual([false, true]);
	});

	it("a reachable network after a network failure stays online with no probe loop, and one probe serves concurrent asks", async () => {
		const calls = { probes: 0 };
		const timers: Array<() => void> = [];
		const changes: boolean[] = [];
		const answer = Promise.withResolvers<boolean>();
		const monitor = new ConnectivityMonitor({
			isOnline: () => true,
			probe: () => {
				calls.probes++;
				return answer.promise;
			},
			now: () => 0,
			schedule: run => {
				timers.push(run);
				return () => undefined;
			},
			changed: online => changes.push(online),
		});
		const asks = [monitor.verify(), monitor.verify(), monitor.verify()];
		answer.resolve(true);
		expect(await Promise.all(asks)).toEqual([true, true, true]);
		expect(calls.probes).toBe(1);
		expect(monitor.online).toBe(true);
		expect(timers).toEqual([]);
		expect(changes).toEqual([]);
	});

	it("does not probe when it already knows the network is down", async () => {
		const { monitor, state, timers } = harness();
		monitor.report(false);
		state.reachable = true;
		expect(await monitor.verify()).toBe(false);
		expect(timers).toEqual([]);
		expect(monitor.online).toBe(false);
	});

	it("a host that alone does not resolve (a mistyped provider URL) is no lost connection; the way out decides", async () => {
		const asked: Array<string | undefined> = [];
		const monitor = new ConnectivityMonitor({
			isOnline: () => true,
			probe: async host => {
				asked.push(host);
				return host === undefined;
			},
			now: () => 0,
			schedule: () => () => undefined,
			changed: () => undefined,
		});
		expect(await monitor.verify("api.typo.example")).toBe(true);
		expect(monitor.online).toBe(true);
		expect(asked.sort()).toEqual(["api.typo.example", undefined].sort());
	});

	it("offline after a failed lookup comes back as soon as the failed host answers, even with the default way out still silent", async () => {
		const answering = new Set<string | undefined>();
		const timers: Array<() => void> = [];
		const monitor = new ConnectivityMonitor({
			isOnline: () => true,
			probe: async host => answering.has(host),
			now: () => 0,
			schedule: run => {
				timers.push(run);
				return () => undefined;
			},
			changed: () => undefined,
		});
		// A proxy-only network: the default way out never resolves here, the provider's host does once DNS is back.
		expect(await monitor.verify("api.provider.example")).toBe(false);
		expect(monitor.online).toBe(false);
		answering.add("api.provider.example");
		timers.shift()?.();
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(monitor.online).toBe(true);
	});
});

describe("answersWithin", () => {
	it("is yes for a lookup that answers, no for one that fails or outlives the deadline", async () => {
		vi.useFakeTimers();
		try {
			expect(await answersWithin(Promise.resolve({}), 2_500)).toBe(true);
			expect(await answersWithin(Promise.reject(new Error("ENOTFOUND")), 2_500)).toBe(false);
			const hung = answersWithin(new Promise(() => undefined), 2_500);
			vi.advanceTimersByTime(2_500);
			expect(await hung).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});
