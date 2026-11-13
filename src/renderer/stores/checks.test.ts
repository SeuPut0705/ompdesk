import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checksFrame } from "../dev-harness/fixture-checks";
import { resetSnapshotsForTest } from "../lib/snapshot-cache";
import { restartChecksForTest, useChecksStore } from "./checks";

class Memory {
	readonly map = new Map<string, string>();
	get length() {
		return this.map.size;
	}
	key(i: number) {
		return [...this.map.keys()][i] ?? null;
	}
	getItem(k: string) {
		return this.map.get(k) ?? null;
	}
	setItem(k: string, v: string) {
		this.map.set(k, v);
	}
	removeItem(k: string) {
		this.map.delete(k);
	}
}

const NOW = Date.UTC(2026, 10, 13, 12);

beforeEach(() => {
	vi.useFakeTimers({ now: NOW });
	Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new Memory() });
	resetSnapshotsForTest();
	useChecksStore.getState().reset();
});
afterEach(() => {
	useChecksStore.getState().reset();
	Reflect.deleteProperty(globalThis, "localStorage");
	resetSnapshotsForTest();
	vi.useRealTimers();
});

/** A page that loads again: the same storage, nothing in memory. */
function reload(): void {
	resetSnapshotsForTest();
	restartChecksForTest();
}

describe("checks store", () => {
	it("paints the last frame on the next page's first render, marked as last run's until main answers", () => {
		const frame = checksFrame("busy", NOW, true);
		useChecksStore.getState().apply(frame);
		vi.advanceTimersByTime(2000);

		reload();
		expect(useChecksStore.getState().frame).toEqual(frame);
		expect(useChecksStore.getState().remembered).toBe(true);

		const next = checksFrame("idle", NOW, true);
		useChecksStore.getState().hydrateIfCurrent(useChecksStore.getState().version, next);
		expect(useChecksStore.getState().frame).toEqual(next);
		expect(useChecksStore.getState().remembered).toBe(false);
	});

	it("forgets the frame once main has none, so a page without a hub draws nothing after a reload", () => {
		useChecksStore.getState().apply(checksFrame("busy", NOW, true));
		vi.advanceTimersByTime(2000);
		reload();
		useChecksStore.getState().hydrateIfCurrent(0, null);
		vi.advanceTimersByTime(2000);

		reload();
		expect(useChecksStore.getState().frame).toBeNull();
		expect(useChecksStore.getState().remembered).toBe(false);
	});

	it("keeps the newest of frames that come faster than it writes", () => {
		useChecksStore.getState().apply(checksFrame("idle", NOW, true));
		vi.advanceTimersByTime(1000);
		const newest = checksFrame("busy", NOW, true);
		useChecksStore.getState().apply(newest);
		vi.advanceTimersByTime(1000);

		reload();
		expect(useChecksStore.getState().frame).toEqual(newest);
	});
});
