import { afterEach, describe, expect, it, vi } from "vitest";
import { type DeferredChunkScheduling, loadDeferredChunk } from "./deferred-chunk";

/** A touch/key target and an idle moment the test fires by hand. */
function scheduling() {
	const target = new EventTarget();
	const idle: { run: (() => void) | null; cancelled: boolean } = { run: null, cancelled: false };
	const sched: DeferredChunkScheduling = {
		target: target as unknown as DeferredChunkScheduling["target"],
		idle: callback => {
			idle.run = callback;
			return () => {
				idle.cancelled = true;
			};
		},
	};
	return { target, idle, sched };
}

/** Lets the load's promise chain run (a resolved or rejected mock settles within a few microtasks). */
async function settle(): Promise<void> {
	for (let tick = 0; tick < 5; tick++) await Promise.resolve();
}
const chunkError = () => new Error("Failed to fetch dynamically imported module: /assets/OnDemandDialogs-x.js");

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a deferred chunk", () => {
	it("loads in the first idle moment, once, and a touch after it loads nothing more", async () => {
		const { target, idle, sched } = scheduling();
		const load = vi.fn(async () => "module");
		const onLoaded = vi.fn();
		loadDeferredChunk({ load, onLoaded, start: "idle" }, sched);
		expect(load).not.toHaveBeenCalled();
		idle.run?.();
		await settle();
		expect(load).toHaveBeenCalledTimes(1);
		expect(onLoaded).toHaveBeenCalledWith("module");
		target.dispatchEvent(new Event("pointerdown"));
		await settle();
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("loads at the first pointerdown when it comes before the idle moment", async () => {
		const { target, idle, sched } = scheduling();
		const load = vi.fn(async () => "module");
		const onLoaded = vi.fn();
		loadDeferredChunk({ load, onLoaded, start: "idle" }, sched);
		target.dispatchEvent(new Event("pointerdown"));
		target.dispatchEvent(new Event("keydown"));
		await settle();
		expect(load).toHaveBeenCalledTimes(1);
		expect(onLoaded).toHaveBeenCalledWith("module");
		expect(idle.cancelled).toBe(true);
	});

	it("after a failed load, closes what it would show and tries again at the next touch or key", async () => {
		const { target, idle, sched } = scheduling();
		const load = vi.fn<() => Promise<string>>().mockRejectedValueOnce(chunkError()).mockResolvedValue("module");
		const onLoaded = vi.fn();
		const onFailed = vi.fn();
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		loadDeferredChunk({ load, onLoaded, onFailed, start: "idle" }, sched);
		idle.run?.();
		await settle();
		expect(onFailed).toHaveBeenCalledTimes(1);
		expect(onLoaded).not.toHaveBeenCalled();
		// Not in a loop: nothing loads again until the person touches or types.
		await settle();
		expect(load).toHaveBeenCalledTimes(1);
		target.dispatchEvent(new Event("keydown"));
		await settle();
		expect(load).toHaveBeenCalledTimes(2);
		expect(onLoaded).toHaveBeenCalledWith("module");
		// A chunk that would not load is the stale-build path's to report, not a logged error.
		expect(logged).not.toHaveBeenCalled();
	});

	it("logs a failure that is not a chunk load, and still tries again at the next touch", async () => {
		const { target, sched } = scheduling();
		const load = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new TypeError("boom")).mockResolvedValue("m");
		const onLoaded = vi.fn();
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		loadDeferredChunk({ load, onLoaded, start: "now" }, sched);
		await settle();
		expect(logged).toHaveBeenCalledTimes(1);
		target.dispatchEvent(new Event("pointerdown"));
		await settle();
		expect(onLoaded).toHaveBeenCalledWith("m");
	});

	it("delivers nothing and listens for nothing once cancelled", async () => {
		const { target, idle, sched } = scheduling();
		const load = vi.fn(async () => "module");
		const onLoaded = vi.fn();
		const cancel = loadDeferredChunk({ load, onLoaded, start: "idle" }, sched);
		cancel();
		expect(idle.cancelled).toBe(true);
		target.dispatchEvent(new Event("pointerdown"));
		await settle();
		expect(load).not.toHaveBeenCalled();
		expect(onLoaded).not.toHaveBeenCalled();
	});
});
