import { describe, expect, it, vi } from "vitest";
import { flushReloadReasons, noteReload, type ReloadStorage, reloadReport } from "./reload-reason";
import { PageResync } from "./resync";

function timers() {
	const pending: { callback: () => void; ms: number }[] = [];
	return {
		pending,
		setTimer: (callback: () => void, ms: number) => {
			const entry = { callback, ms };
			pending.push(entry);
			return entry;
		},
		clearTimer: (handle: unknown) => {
			const index = pending.indexOf(handle as (typeof pending)[number]);
			if (index >= 0) pending.splice(index, 1);
		},
		fire: () => pending.shift()?.callback(),
	};
}

/** Let pending microtasks (a pass and what follows it) run. */
const settle = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("PageResync (catching up in place after a reconnect that missed events)", () => {
	it("reads the page's state again instead of reloading, and gives up only after three failures in a row", async () => {
		const clock = timers();
		const results = [false, false, false];
		const run = vi.fn(async () => results.shift() ?? true);
		const giveUp = vi.fn();
		const resync = new PageResync({ run, giveUp, ...clock, retryMs: 1000 });
		resync.request();
		await settle();
		expect(run).toHaveBeenCalledTimes(1);
		// A failed pass is tried again after a growing wait.
		expect(clock.pending.map(entry => entry.ms)).toEqual([1000]);
		clock.fire();
		await settle();
		expect(clock.pending.map(entry => entry.ms)).toEqual([2000]);
		expect(giveUp).not.toHaveBeenCalled();
		clock.fire();
		await settle();
		expect(run).toHaveBeenCalledTimes(3);
		expect(giveUp).toHaveBeenCalledWith(3);
		// Given up: later reconnects change nothing (the last-resort reload is pending).
		resync.request();
		await settle();
		expect(run).toHaveBeenCalledTimes(3);
	});

	it("counts a throw as a failure and resets the count after a pass that works", async () => {
		const clock = timers();
		let fail = true;
		const run = vi.fn(async () => {
			if (fail) throw new Error("The link to the computer dropped");
			return true;
		});
		const giveUp = vi.fn();
		const resync = new PageResync({ run, giveUp, ...clock });
		resync.request();
		await settle();
		resync.request();
		await settle();
		fail = false;
		resync.request();
		await settle();
		expect(resync.passes).toBe(1);
		fail = true;
		resync.request();
		await settle();
		resync.request();
		await settle();
		expect(giveUp).not.toHaveBeenCalled();
	});

	it("runs one pass at a time, and once more for a reconnect during a pass", async () => {
		const gates: (() => void)[] = [];
		const run = vi.fn(() => {
			const { promise, resolve } = Promise.withResolvers<boolean>();
			gates.push(() => resolve(true));
			return promise;
		});
		const resync = new PageResync({ run, giveUp: () => {}, ...timers() });
		resync.request();
		resync.request();
		resync.request();
		await settle();
		expect(run).toHaveBeenCalledTimes(1);
		gates.shift()?.();
		await settle();
		expect(run).toHaveBeenCalledTimes(2);
		gates.shift()?.();
		await settle();
		expect(run).toHaveBeenCalledTimes(2);
		expect(resync.passes).toBe(2);
	});

	it("a reconnect while a retry waits runs at once", async () => {
		const clock = timers();
		const results = [false, true];
		const run = vi.fn(async () => results.shift() ?? true);
		const resync = new PageResync({ run, giveUp: () => {}, ...clock });
		resync.request();
		await settle();
		expect(clock.pending).toHaveLength(1);
		resync.request();
		await settle();
		expect(clock.pending).toHaveLength(0);
		expect(run).toHaveBeenCalledTimes(2);
	});
});

class MemoryStorage implements ReloadStorage {
	readonly items = new Map<string, string>();
	getItem(key: string): string | null {
		return this.items.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		this.items.set(key, value);
	}
	removeItem(key: string): void {
		this.items.delete(key);
	}
}

describe("reload reasons (every reload of the page explains itself in the host's runtime log)", () => {
	it("keeps each reason across the reload and sends them all on the next connect, once", () => {
		const storage = new MemoryStorage();
		noteReload(storage, { reason: "update", at: Date.UTC(2026, 9, 18, 14, 15) });
		noteReload(storage, { reason: "resync-failed", at: Date.UTC(2026, 9, 18, 14, 16), details: { failures: 3 } });
		const sent: unknown[] = [];
		expect(flushReloadReasons(storage, report => sent.push(report))).toBe(2);
		expect(sent).toEqual([
			{ source: "web-reload", message: "update", details: { reloadedAt: "2026-10-18T14:15:00.000Z" } },
			{
				source: "web-reload",
				message: "resync-failed",
				details: { reloadedAt: "2026-10-18T14:16:00.000Z", failures: 3 },
			},
		]);
		expect(flushReloadReasons(storage, report => sent.push(report))).toBe(0);
		expect(sent).toHaveLength(2);
	});

	it("keeps the newest twenty, ignores a corrupt record and never throws on a full storage", () => {
		const storage = new MemoryStorage();
		for (let index = 0; index < 25; index++) noteReload(storage, { reason: "update", at: index });
		storage.setItem(
			"omp.web.reload-reasons",
			JSON.stringify([...JSON.parse(storage.getItem("omp.web.reload-reasons") ?? "[]"), { bad: 1 }]),
		);
		const sent: { details?: Record<string, unknown> }[] = [];
		flushReloadReasons(storage, report => sent.push(report));
		expect(sent).toHaveLength(20);
		expect(sent[0]?.details?.reloadedAt).toBe(new Date(5).toISOString());
		const full: ReloadStorage = {
			getItem: () => null,
			setItem: () => {
				throw new DOMException("QuotaExceededError");
			},
			removeItem: () => {},
		};
		expect(() => noteReload(full, { reason: "error-boundary", at: 0 })).not.toThrow();
		expect(reloadReport({ reason: "chunk-load-failed", at: 0 }).source).toBe("web-reload");
	});
});
