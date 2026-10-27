import { describe, expect, it } from "vitest";
import { ConnectivityMonitor, PROBE_INTERVAL_MS, RESUME_WINDOW_MS } from "./connectivity";

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

	it("stops probing when the computer goes back to sleep", async () => {
		const { monitor, state, settle, timers } = harness();
		state.reachable = false;
		monitor.resume();
		await settle();
		monitor.suspend();
		expect(timers.every(timer => !timer.live)).toBe(true);
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
});
