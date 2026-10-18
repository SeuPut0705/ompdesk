import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSnapshotsForTest, snapshots } from "./snapshot-cache";
import { limitTabs, readTabSnapshot, rememberTabs, tabSnapshotEntry } from "./tab-snapshot";

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

const stubWindow = (search: string) => vi.stubGlobal("window", { location: { search } });

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new Memory() });
	resetSnapshotsForTest();
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	Reflect.deleteProperty(globalThis, "localStorage");
	resetSnapshotsForTest();
});

describe("tab snapshot", () => {
	it("is empty on a first start", () => {
		stubWindow("");
		expect(readTabSnapshot()).toBeNull();
	});

	it("writes once after a quiet moment and reads back the strip and the active tab", () => {
		stubWindow("?slot=0");
		const strip = {
			tabs: [tabSnapshotEntry({ id: "a", cwd: "/p", kind: "agent", title: "Alpha", sessionPath: "/s/a.jsonl" })],
			activeTabId: "a",
		};
		const produce = vi.fn(() => strip);
		rememberTabs(produce);
		rememberTabs(produce);
		expect(readTabSnapshot()).toBeNull();
		vi.advanceTimersByTime(600);
		expect(produce).toHaveBeenCalledTimes(1);
		expect(readTabSnapshot()).toEqual(strip);
	});

	it("keeps one strip per window slot, so a second window never paints the first one's tabs", () => {
		stubWindow("?slot=0");
		rememberTabs(() => ({ tabs: [{ id: "a", cwd: "/p", kind: "agent" }], activeTabId: "a" }));
		vi.advanceTimersByTime(600);
		stubWindow("?slot=1");
		expect(readTabSnapshot()).toBeNull();
		stubWindow("?slot=0");
		expect(readTabSnapshot()?.tabs.map(tab => tab.id)).toEqual(["a"]);
	});

	it("falls back to the first tab when the saved active one is not in the strip, and ignores malformed tabs", () => {
		stubWindow("");
		snapshots().write("tabs", "local", "0", {
			tabs: [{ id: "x", cwd: "/p", kind: "agent" }, { nope: true }],
			activeTabId: "missing",
		});
		expect(readTabSnapshot()).toEqual({ tabs: [{ id: "x", cwd: "/p", kind: "agent" }], activeTabId: "x" });
	});

	it("keeps the identity of a tab, never its live state", () => {
		const entry = tabSnapshotEntry({
			id: "a",
			cwd: "/p",
			kind: "chat",
			status: "running",
			awaitingInput: "approval",
		} as never);
		expect(entry).toEqual({ id: "a", cwd: "/p", kind: "chat" });
		expect(limitTabs(Array.from({ length: 100 }, (_, i) => i))).toHaveLength(60);
	});
});
