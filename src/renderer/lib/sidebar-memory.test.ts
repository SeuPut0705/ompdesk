import { afterEach, describe, expect, it, vi } from "vitest";
import { SIDEBAR_VISIBLE_STORAGE_KEY } from "../../shared/boot-shell-geometry";
import {
	deviceGroupKey,
	EMPTY_FOLDS,
	FOLD_LIMIT,
	parseSidebarFamilies,
	parseSidebarFolds,
	readSidebarVisible,
	SIDEBAR_FOLDS_STORAGE_KEY,
	withFlag,
	writeSidebarFolds,
	writeSidebarVisible,
} from "./sidebar-memory";

function storage(initial: Record<string, string> = {}) {
	const map = new Map(Object.entries(initial));
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => void map.set(key, value),
	});
	return map;
}

const set = vi.fn(async (_key: string, _value: unknown) => {});
vi.stubGlobal("window", { omp: { prefs: { get: vi.fn(), set } } });

afterEach(() => {
	set.mockClear();
	vi.unstubAllGlobals();
	vi.stubGlobal("window", { omp: { prefs: { get: vi.fn(), set } } });
});

describe("sidebar visibility memory", () => {
	it("shows the sidebar unless it was left collapsed, and mirrors every write for the pre-paint script", () => {
		const map = storage();
		expect(readSidebarVisible()).toBe(true);
		writeSidebarVisible(false);
		expect(map.get(SIDEBAR_VISIBLE_STORAGE_KEY)).toBe("0");
		expect(set).toHaveBeenCalledWith("sidebarVisible", false);
		expect(readSidebarVisible()).toBe(false);
		writeSidebarVisible(true);
		expect(map.get(SIDEBAR_VISIBLE_STORAGE_KEY)).toBe("1");
		expect(readSidebarVisible()).toBe(true);
	});

	it("survives a missing storage and a missing prefs bridge", () => {
		vi.stubGlobal("localStorage", undefined);
		vi.stubGlobal("window", {});
		expect(readSidebarVisible()).toBe(true);
		expect(() => writeSidebarVisible(false)).not.toThrow();
	});
});

describe("fold records", () => {
	it("round-trips what was saved and ignores malformed parts", () => {
		const map = storage();
		const folds = {
			...EMPTY_FOLDS,
			groups: { "/work/a": true, "/work/b": false },
			devices: { local: true },
			deviceGroups: { [deviceGroupKey("d1", "/srv")]: true },
			chats: { local: true },
			starterOpen: true,
		};
		writeSidebarFolds(folds);
		expect(parseSidebarFolds(JSON.parse(map.get(SIDEBAR_FOLDS_STORAGE_KEY) ?? "null"))).toEqual(folds);
		expect(set).toHaveBeenCalledWith("sidebarFolds", folds);
		expect(parseSidebarFolds(null)).toEqual(EMPTY_FOLDS);
		// A record an earlier build saved with its Code/Chat lane reads without it.
		expect(parseSidebarFolds({ groups: ["x"], devices: { a: "yes", b: true }, lane: "chat" })).toEqual({
			...EMPTY_FOLDS,
			devices: { b: true },
		});
	});

	it("keeps only the newest entries of a record", () => {
		let record: Record<string, boolean> = {};
		for (let index = 0; index < FOLD_LIMIT + 25; index++) record = withFlag(record, `/p/${index}`, true);
		expect(Object.keys(record)).toHaveLength(FOLD_LIMIT);
		expect(record["/p/0"]).toBeUndefined();
		expect(record[`/p/${FOLD_LIMIT + 24}`]).toBe(true);
		// A touched entry becomes the newest again.
		record = withFlag(record, "/p/25", false);
		expect(Object.keys(record).at(-1)).toBe("/p/25");
		expect(
			parseSidebarFolds({ groups: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`/q/${i}`, true])) })
				.groups,
		).toSatisfy((groups: Record<string, boolean>) => Object.keys(groups).length === FOLD_LIMIT);
	});

	it("never remembers a live tab's row key as a family", () => {
		expect(
			parseSidebarFamilies({
				expanded: ["/s/a.jsonl", "tab:t1", 4, "/s/a.jsonl"],
				hidden: ["tab:t2", "/s/b.jsonl"],
			}),
		).toEqual({
			expanded: ["/s/a.jsonl"],
			hidden: ["/s/b.jsonl"],
		});
		expect(parseSidebarFamilies("junk")).toEqual({ expanded: [], hidden: [] });
	});
});
