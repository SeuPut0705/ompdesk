import { describe, expect, it, vi } from "vitest";
import { LidAwake, type LidBackend } from "./lid-awake";

function setup(options: { onAc?: boolean; laptop?: boolean; holdFails?: boolean; releaseFails?: number } = {}) {
	let releaseFailures = options.releaseFails ?? 0;
	const calls: string[] = [];
	const backend: LidBackend = {
		name: "fake",
		isLaptop: vi.fn(async () => options.laptop ?? true),
		recover: vi.fn(async () => {
			calls.push("recover");
			return null;
		}),
		hold: vi.fn(async () => {
			calls.push("hold");
			if (options.holdFails) throw new Error("powercfg failed");
			return { changed: true };
		}),
		release: vi.fn(async () => {
			calls.push("release");
			if (releaseFailures-- > 0) throw new Error("powercfg failed");
		}),
		releaseNow: vi.fn(() => {
			calls.push("releaseNow");
		}),
	};
	const log = vi.fn();
	const lid = new LidAwake({ backend, onAc: options.onAc ?? true, log });
	let next = 0;
	const inner = { start: vi.fn(() => ++next), stop: vi.fn() };
	const work = lid.wrap(inner, "work");
	const host = lid.wrap(inner, "host");
	const lines = () =>
		log.mock.calls.map(([message, details]) => `${message} ${details.reason ?? details.step ?? ""}`.trim());
	return { backend, calls, lid, work, host, inner, lines };
}

describe("LidAwake", () => {
	it("holds the lid while work runs on AC and releases when it ends, after recovering any leftover first", async () => {
		const { calls, lid, work, inner, lines } = setup();
		const id = work.start();
		expect(inner.start).toHaveBeenCalledTimes(1);
		await lid.settled();
		expect(lid.held).toBe(true);
		work.stop(id);
		expect(inner.stop).toHaveBeenCalledWith(id);
		await lid.settled();
		expect(lid.held).toBe(false);
		expect(calls).toEqual(["recover", "hold", "release"]);
		expect(lines()).toEqual(["held work", "released work-ended"]);
	});

	it("counts the host role's blocker and the work blocker together", async () => {
		const { calls, lid, work, host } = setup();
		const a = work.start();
		const b = host.start();
		await lid.settled();
		work.stop(a);
		await lid.settled();
		expect(lid.held).toBe(true);
		host.stop(b);
		await lid.settled();
		expect(calls).toEqual(["recover", "hold", "release"]);
	});

	it("follows AC and battery at once while work runs", async () => {
		const { calls, lid, work, lines } = setup({ onAc: false });
		work.start();
		await lid.settled();
		expect(lid.held).toBe(false);
		lid.setOnAc(true);
		await lid.settled();
		expect(lid.held).toBe(true);
		lid.setOnAc(false);
		await lid.settled();
		expect(lid.held).toBe(false);
		expect(calls).toEqual(["recover", "hold", "release"]);
		expect(lines()).toEqual(["held charging", "released on-battery"]);
	});

	it("never holds on a computer without a battery, and asks only once", async () => {
		const { backend, calls, lid, work, lines } = setup({ laptop: false });
		const id = work.start();
		await lid.settled();
		work.stop(id);
		work.start();
		await lid.settled();
		expect(calls).toEqual(["recover"]);
		expect(backend.isLaptop).toHaveBeenCalledTimes(1);
		expect(lines()).toEqual(["skipped no battery"]);
	});

	it("an input that flips back while a hold is in flight ends released, without a second hold", async () => {
		const { calls, lid, work } = setup();
		const id = work.start();
		work.stop(id);
		await lid.settled();
		expect(lid.held).toBe(false);
		expect(calls.filter(call => call === "hold").length).toBeLessThanOrEqual(1);
		expect(calls.at(-1)).not.toBe("hold");
	});

	it("a failed hold is logged and tried again on the next change, not in a loop", async () => {
		const { backend, lid, work, lines } = setup({ holdFails: true });
		const id = work.start();
		await lid.settled();
		expect(lid.held).toBe(false);
		expect(backend.hold).toHaveBeenCalledTimes(1);
		work.stop(id);
		work.start();
		await lid.settled();
		expect(backend.hold).toHaveBeenCalledTimes(2);
		expect(lines()).toEqual(["failed work", "failed work"]);
	});

	it("a failed release stays held, is retried on the next change and at quit the backend is always asked", async () => {
		const { calls, lid, work, lines } = setup({ releaseFails: 1 });
		const id = work.start();
		await lid.settled();
		work.stop(id);
		await lid.settled();
		expect(lid.held).toBe(true);
		lid.setOnAc(false);
		await lid.settled();
		expect(lid.held).toBe(false);
		expect(lines()).toEqual(["held work", "failed work-ended", "released on-battery"]);

		const failedHold = setup({ holdFails: true });
		failedHold.work.start();
		await failedHold.lid.settled();
		failedHold.lid.dispose();
		expect(failedHold.calls).toEqual(["recover", "hold", "releaseNow"]);
		expect(calls).toEqual(["recover", "hold", "release", "release"]);
	});

	it("quit releases synchronously, and a hold that lands after quit is undone", async () => {
		const held = setup();
		held.work.start();
		await held.lid.settled();
		held.lid.dispose();
		expect(held.calls).toEqual(["recover", "hold", "releaseNow"]);
		expect(held.lines()).toEqual(["held work", "released quit"]);

		const racing = setup();
		racing.work.start();
		racing.lid.dispose();
		await racing.lid.settled();
		expect(racing.calls).not.toContain("hold");
		expect(racing.lid.held).toBe(false);
	});
});
