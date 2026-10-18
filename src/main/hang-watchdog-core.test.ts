import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consumeHangMarker, createHangDetector, type HangMarker, writeHangMarker } from "./hang-watchdog-core";

const CHECK = 1_000;
const TIMEOUT = 5_000;

function harness() {
	let now = 0;
	const hangs: number[] = [];
	const resolved: number[] = [];
	const detector = createHangDetector({
		timeoutMs: TIMEOUT,
		checkIntervalMs: CHECK,
		now: () => now,
		onHang: ms => hangs.push(ms),
		onResolved: ms => resolved.push(ms),
	});
	/** Advances the clock by one check interval, optionally delivering a heartbeat first, then ticks. */
	const step = (beat: boolean, ms = CHECK): void => {
		now += ms;
		if (beat) detector.heartbeat();
		detector.tick();
	};
	return {
		detector,
		hangs,
		resolved,
		step,
		jump: (ms: number): void => {
			now += ms;
		},
	};
}

describe("createHangDetector", () => {
	it("stays quiet while heartbeats keep coming", () => {
		const h = harness();
		for (let i = 0; i < 30; i++) h.step(true);
		expect(h.hangs).toEqual([]);
	});

	it("reports a hang once, after the timeout without a heartbeat", () => {
		const h = harness();
		h.step(true);
		for (let i = 0; i < 5; i++) h.step(false); // 5 s silent: not yet over the timeout
		expect(h.hangs).toEqual([]);
		h.step(false); // 6 s
		expect(h.hangs).toEqual([6_000]);
		for (let i = 0; i < 10; i++) h.step(false);
		expect(h.hangs).toHaveLength(1);
	});

	it("treats a tick gap over three intervals as a system suspend and does not report", () => {
		const h = harness();
		h.step(true);
		h.jump(10 * 60_000); // laptop lid closed: the worker's own timer stopped too
		h.detector.tick();
		expect(h.hangs).toEqual([]);
		// The wait restarted at the wake-up tick: a real stall afterwards is still caught.
		for (let i = 0; i < 6; i++) h.step(false);
		expect(h.hangs).toHaveLength(1);
		expect(h.hangs[0]).toBeLessThan(TIMEOUT + 2 * CHECK);
	});

	it("reports the resolution when heartbeats resume, and can report a later stall", () => {
		const h = harness();
		for (let i = 0; i < 8; i++) h.step(false);
		expect(h.hangs).toHaveLength(1);
		h.step(true);
		expect(h.resolved).toEqual([9_000]);
		for (let i = 0; i < 3; i++) h.step(true);
		for (let i = 0; i < 7; i++) h.step(false);
		expect(h.hangs).toHaveLength(2);
	});

	it("does not read the first tick after a long stall as a sleep", () => {
		const h = harness();
		for (let i = 0; i < 20; i++) h.step(false);
		h.step(true);
		expect(h.hangs).toHaveLength(1);
		expect(h.resolved).toHaveLength(1);
		h.step(false);
		expect(h.hangs).toHaveLength(1);
	});

	it("reset waits for fresh heartbeats after the OS resumed", () => {
		const h = harness();
		h.step(true);
		for (let i = 0; i < 4; i++) h.step(false);
		h.detector.reset();
		h.step(false);
		h.step(false);
		expect(h.hangs).toEqual([]);
	});
});

describe("hang marker", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "hang-marker-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const marker: HangMarker = { detectedAt: 1_700_000_000_000, pid: 4242, unresponsiveMs: 6_100, selfRecovered: false };

	it("round-trips and is removed once consumed", () => {
		const file = join(dir, "main-thread-hang.json");
		writeHangMarker(file, marker);
		expect(consumeHangMarker(file)).toEqual(marker);
		expect(() => readFileSync(file)).toThrow();
		expect(consumeHangMarker(file)).toBeNull();
	});

	it("reads a rewritten marker as recovered", () => {
		const file = join(dir, "m.json");
		writeHangMarker(file, marker);
		writeHangMarker(file, { ...marker, unresponsiveMs: 9_000, selfRecovered: true });
		expect(consumeHangMarker(file)).toMatchObject({ unresponsiveMs: 9_000, selfRecovered: true });
	});

	it("drops a corrupt or invalid marker without throwing", () => {
		const file = join(dir, "m.json");
		writeFileSync(file, "{not json");
		expect(consumeHangMarker(file)).toBeNull();
		writeFileSync(file, JSON.stringify({ detectedAt: 1, pid: -3, unresponsiveMs: 5 }));
		expect(consumeHangMarker(file)).toBeNull();
	});
});
