import { describe, expect, it } from "vitest";
import { deletedSessions, initDeletedSessions } from "./deleted-sessions";
import {
	MAX_FORMER_TAB_IDS,
	MAX_PERSISTED_TITLE,
	sanitizePersistedTabLayout,
	sanitizePersistedTabLayouts,
	type TabLayoutDrop,
	type TabLayoutPathChecks,
} from "./tab-layout";

function pathChecks(directories: string[], files: string[], contentFiles: string[] = files): TabLayoutPathChecks {
	return {
		directoryExists: path => directories.includes(path),
		fileExists: path => files.includes(path),
		sessionHasContent: path => contentFiles.includes(path),
	};
}

describe("persisted tab layout", () => {
	it("preserves valid order, active selection, session kind, and worktree metadata", () => {
		const value = {
			version: 1,
			activeIndex: 1,
			tabs: [
				{ cwd: "/a", kind: "agent", sessionPath: "/sessions/a.jsonl" },
				{
					cwd: "/b",
					kind: "chat",
					worktree: {
						name: "feature",
						branch: "omp/gui/feature",
						baseCwd: "/repo",
						path: "/wt/gui-feature-1234567",
					},
				},
			],
		};

		expect(sanitizePersistedTabLayout(value, pathChecks(["/a", "/b"], ["/sessions/a.jsonl"]))).toEqual(value);
	});

	it("drops a worktree binding saved without its checkout path", () => {
		const layout = sanitizePersistedTabLayout(
			{
				version: 1,
				activeIndex: 0,
				tabs: [
					{ cwd: "/b", kind: "agent", worktree: { name: "feature", branch: "omp/gui/feature", baseCwd: "/repo" } },
				],
			},
			pathChecks(["/b"], []),
		);

		// The saved cwd follows session switches; it must never become the
		// directory the close prompt force-removes.
		expect(layout?.tabs[0]?.cwd).toBe("/b");
		expect(layout?.tabs[0]?.worktree).toBeUndefined();
	});

	it("carries a saved title and bounds the one read back from prefs", () => {
		const layout = sanitizePersistedTabLayout(
			{
				version: 1,
				activeIndex: 0,
				tabs: [
					{ cwd: "/a", kind: "agent", title: "x".repeat(400) },
					{ cwd: "/b", kind: "agent", title: 42 },
				],
			},
			pathChecks(["/a", "/b"], []),
		);

		// A restored tab stays unspawned until shown, so its saved title is the
		// only label it has — but prefs are untrusted input and must not grow.
		expect(layout?.tabs[0]?.title).toHaveLength(MAX_PERSISTED_TITLE);
		expect(layout?.tabs[1]?.title).toBeUndefined();
	});

	it("keeps the opener's session file a tab was opened from, and drops anything that is not one", () => {
		const layout = sanitizePersistedTabLayout(
			{
				version: 1,
				activeIndex: 0,
				tabs: [
					{ cwd: "/a", kind: "agent", sessionPath: "/s/a.jsonl", openedBy: "/s/boss.jsonl" },
					{ cwd: "/b", kind: "agent", openedBy: 7 },
					{ cwd: "/c", kind: "agent", openedBy: "  " },
					{ cwd: "/d", kind: "agent", sessionPath: "/s/d.jsonl", openedBy: "/s/d.jsonl" },
				],
			},
			pathChecks(["/a", "/b", "/c", "/d"], ["/s/a.jsonl", "/s/d.jsonl"]),
		);

		expect(layout?.tabs.map(tab => tab.openedBy)).toEqual(["/s/boss.jsonl", undefined, undefined, undefined]);
	});

	it("keeps a tab's earlier ids, bounded, and drops anything that is not one", () => {
		const many = Array.from({ length: 12 }, (_, index) => `15ad${index}`);
		const layout = sanitizePersistedTabLayout(
			{
				version: 1,
				activeIndex: 0,
				tabs: [
					{ cwd: "/a", kind: "agent", sessionPath: "/s/a.jsonl", formerIds: many },
					{
						cwd: "/b",
						kind: "agent",
						sessionPath: "/s/b.jsonl",
						formerIds: ["ok-1", 7, "", "a b", "x".repeat(65)],
					},
					{ cwd: "/c", kind: "agent", formerIds: "15ad1" },
				],
			},
			pathChecks(["/a", "/b", "/c"], ["/s/a.jsonl", "/s/b.jsonl"]),
		);
		expect(layout?.tabs.map(tab => tab.formerIds)).toEqual([many.slice(0, MAX_FORMER_TAB_IDS), ["ok-1"], undefined]);
	});

	it("remaps and clamps a restored two-pane layout after invalid tabs are dropped", () => {
		const value = {
			version: 1,
			activeIndex: 2,
			tabs: [
				{ cwd: "/missing", kind: "agent" },
				{ cwd: "/a", kind: "agent" },
				{ cwd: "/b", kind: "chat" },
			],
			split: { axis: "rows", firstIndex: 1, secondIndex: 2, ratio: 0.95 },
		};

		expect(sanitizePersistedTabLayout(value, pathChecks(["/a", "/b"], []))).toEqual({
			version: 1,
			activeIndex: 1,
			tabs: [
				{ cwd: "/a", kind: "agent" },
				{ cwd: "/b", kind: "chat" },
			],
			split: { axis: "rows", first: { tabId: "0" }, second: { tabId: "1" }, ratio: 0.8 },
		});
	});

	it("restores nested splits and collapses a missing middle pane", () => {
		const value = {
			version: 1,
			activeIndex: 1,
			tabs: ["/a", "/missing", "/c", "/d"].map(cwd => ({ cwd, kind: "agent" })),
			split: {
				axis: "columns",
				ratio: 0.6,
				first: { axis: "rows", ratio: 0.5, first: { tabId: "0" }, second: { tabId: "1" } },
				second: { axis: "rows", ratio: 0.5, first: { tabId: "2" }, second: { tabId: "3" } },
			},
		};
		const restored = sanitizePersistedTabLayout(value, pathChecks(["/a", "/c", "/d"], []));
		expect(restored?.split).toEqual({
			axis: "columns",
			ratio: 0.6,
			first: { tabId: "0" },
			second: { axis: "rows", ratio: 0.5, first: { tabId: "1" }, second: { tabId: "2" } },
		});
		expect(restored?.activeIndex).toBe(1);
	});

	it("keeps remembered splits next to the visible one and remaps their tabs", () => {
		const pair = (a: string, b: string, ratio = 0.5) => ({
			axis: "columns",
			ratio,
			first: { tabId: a },
			second: { tabId: b },
		});
		const value = {
			version: 1,
			activeIndex: 0,
			tabs: ["/a", "/missing", "/c", "/d", "/e", "/f"].map(cwd => ({ cwd, kind: "agent" })),
			split: pair("0", "2"),
			splits: [pair("3", "4", 0.3), pair("1", "5")],
		};
		const restored = sanitizePersistedTabLayout(value, pathChecks(["/a", "/c", "/d", "/e", "/f"], []));
		expect(restored?.split).toEqual(pair("0", "1"));
		// The second remembered split lost its missing member and dissolves.
		expect(restored?.splits).toEqual([pair("2", "3", 0.3)]);
	});

	it("never remembers a session twice or one that is on screen", () => {
		const pair = (a: string, b: string) => ({
			axis: "rows",
			ratio: 0.5,
			first: { tabId: a },
			second: { tabId: b },
		});
		const tabs = ["/a", "/b", "/c", "/d", "/e"].map(cwd => ({ cwd, kind: "agent" }));
		const dirs = ["/a", "/b", "/c", "/d", "/e"];
		// Solo active tab 0 is on screen: its remembered split loses it and dissolves.
		expect(
			sanitizePersistedTabLayout(
				{ version: 1, activeIndex: 0, tabs, splits: [pair("0", "1"), pair("2", "3"), pair("3", "4")] },
				pathChecks(dirs, []),
			)?.splits,
		).toEqual([pair("2", "3")]);
		// Garbage entries are ignored.
		expect(
			sanitizePersistedTabLayout(
				{ version: 1, activeIndex: 0, tabs, splits: [{ axis: "rows" }, "x", null, pair("1", "2")] },
				pathChecks(dirs, []),
			)?.splits,
		).toEqual([pair("1", "2")]);
		expect(
			sanitizePersistedTabLayout({ version: 1, activeIndex: 0, tabs, splits: "nope" }, pathChecks(dirs, []))?.splits,
		).toBeUndefined();
	});

	it("drops missing workspaces and selects the nearest surviving tab", () => {
		const value = {
			version: 1,
			activeIndex: 1,
			tabs: [
				{ cwd: "/before", kind: "agent" },
				{ cwd: "/deleted", kind: "agent" },
				{ cwd: "/after", kind: "chat" },
			],
		};

		expect(sanitizePersistedTabLayout(value, pathChecks(["/before", "/after"], []))).toEqual({
			version: 1,
			activeIndex: 1,
			tabs: [
				{ cwd: "/before", kind: "agent" },
				{ cwd: "/after", kind: "chat" },
			],
		});
	});

	it("turns a missing (never written) transcript into a fresh tab and removes duplicate session attachments", () => {
		const value = {
			version: 1,
			activeIndex: 0,
			tabs: [
				{ cwd: "/a", kind: "agent", sessionPath: "/sessions/deleted.jsonl" },
				{ cwd: "/b", kind: "agent", sessionPath: "/sessions/live.jsonl" },
				{ cwd: "/c", kind: "agent", sessionPath: "/sessions/live.jsonl" },
			],
		};

		expect(sanitizePersistedTabLayout(value, pathChecks(["/a", "/b", "/c"], ["/sessions/live.jsonl"]))).toEqual({
			version: 1,
			activeIndex: 0,
			tabs: [
				{ cwd: "/a", kind: "agent" },
				{ cwd: "/b", kind: "agent", sessionPath: "/sessions/live.jsonl" },
			],
		});
	});

	it("drops the tab of a session the user deleted, here or on a paired host, instead of a fresh tab in its folder", () => {
		initDeletedSessions(null);
		deletedSessions().add("/sessions/deleted.jsonl");
		deletedSessions().add("/host/gone.jsonl", "host-b");
		const value = {
			version: 1,
			activeIndex: 0,
			tabs: [
				{ cwd: "/a", kind: "agent", sessionPath: "/sessions/deleted.jsonl" },
				{ cwd: "/h", kind: "agent", sessionPath: "/host/gone.jsonl", device: "host-b" },
				{ cwd: "/h", kind: "agent", sessionPath: "/host/gone.jsonl", device: "host-c" },
				{ cwd: "/b", kind: "agent", sessionPath: "/sessions/unwritten.jsonl" },
			],
		};
		expect(sanitizePersistedTabLayout(value, pathChecks(["/a", "/b"], []))?.tabs).toEqual([
			{ cwd: "/h", kind: "agent", sessionPath: "/host/gone.jsonl", device: "host-c" },
			{ cwd: "/b", kind: "agent" },
		]);
		initDeletedSessions(null);
	});

	it("says which saved tabs a restore leaves out or starts fresh, and why", () => {
		initDeletedSessions(null);
		deletedSessions().add("/sessions/deleted.jsonl");
		const value = {
			version: 1,
			activeIndex: 0,
			tabs: [
				{ cwd: "/a", kind: "agent", sessionPath: "/sessions/kept.jsonl" },
				{ cwd: "/gone", kind: "agent", sessionPath: "/sessions/elsewhere.jsonl" },
				{ cwd: "/a", kind: "agent", sessionPath: "/sessions/deleted.jsonl" },
				{ cwd: "/a", kind: "agent", sessionPath: "/sessions/kept.jsonl" },
				{ cwd: "/b", kind: "agent", sessionPath: "/sessions/unwritten.jsonl" },
			],
		};
		const drops: TabLayoutDrop[] = [];
		sanitizePersistedTabLayout(value, pathChecks(["/a", "/b"], ["/sessions/kept.jsonl"]), drop => drops.push(drop));
		expect(drops).toEqual([
			{ reason: "folder", cwd: "/gone", sessionPath: "/sessions/elsewhere.jsonl" },
			{ reason: "deleted", cwd: "/a", sessionPath: "/sessions/deleted.jsonl" },
			{ reason: "duplicate", cwd: "/a", sessionPath: "/sessions/kept.jsonl" },
			{ reason: "fresh", cwd: "/b", sessionPath: "/sessions/unwritten.jsonl" },
		]);
		initDeletedSessions(null);
	});

	it("drops the disposable startup placeholder once an explicit tab exists", () => {
		const value = {
			version: 1,
			activeIndex: 0,
			tabs: [
				{ cwd: "/neutral", kind: "chat", placeholder: true },
				{ cwd: "/work", kind: "agent", sessionPath: "/sessions/work.jsonl" },
			],
		};

		expect(sanitizePersistedTabLayout(value, pathChecks(["/neutral", "/work"], ["/sessions/work.jsonl"]))).toEqual({
			version: 1,
			activeIndex: 0,
			tabs: [{ cwd: "/work", kind: "agent", sessionPath: "/sessions/work.jsonl" }],
		});
	});

	it("drops a lone startup placeholder so the next launch uses Work", () => {
		const value = {
			version: 1,
			activeIndex: 0,
			tabs: [{ cwd: "/neutral", kind: "chat", placeholder: true }],
		};

		expect(sanitizePersistedTabLayout(value, pathChecks(["/neutral"], []))).toBeNull();
	});

	it("migrates an empty first chat from layouts saved before placeholder metadata existed", () => {
		const value = {
			version: 1,
			activeIndex: 0,
			tabs: [
				{ cwd: "/neutral", kind: "chat", sessionPath: "/sessions/empty.jsonl" },
				{ cwd: "/work", kind: "agent", sessionPath: "/sessions/work.jsonl" },
			],
		};

		expect(
			sanitizePersistedTabLayout(
				value,
				pathChecks(
					["/neutral", "/work"],
					["/sessions/empty.jsonl", "/sessions/work.jsonl"],
					["/sessions/work.jsonl"],
				),
			),
		).toEqual({
			version: 1,
			activeIndex: 0,
			tabs: [{ cwd: "/work", kind: "agent", sessionPath: "/sessions/work.jsonl" }],
		});

		// A real first chat is never inferred to be a disposable placeholder.
		expect(
			sanitizePersistedTabLayout(
				value,
				pathChecks(
					["/neutral", "/work"],
					["/sessions/empty.jsonl", "/sessions/work.jsonl"],
					["/sessions/empty.jsonl", "/sessions/work.jsonl"],
				),
			),
		).toEqual(value);
	});

	it("rejects malformed or empty snapshots and keeps every tab past ten", () => {
		expect(sanitizePersistedTabLayout(null, pathChecks([], []))).toBeNull();
		expect(sanitizePersistedTabLayout({ version: 2, tabs: [] }, pathChecks([], []))).toBeNull();
		expect(sanitizePersistedTabLayout({ version: 1, activeIndex: 0, tabs: [] }, pathChecks([], []))).toBeNull();

		const tabs = Array.from({ length: 12 }, (_, index) => ({
			cwd: `/workspace-${index}`,
			kind: "agent",
		}));
		const directories = tabs.map(tab => tab.cwd);
		const restored = sanitizePersistedTabLayout({ version: 1, activeIndex: 11, tabs }, pathChecks(directories, []));
		expect(restored?.tabs).toHaveLength(12);
		expect(restored?.activeIndex).toBe(11);
	});

	it("keeps remote descriptors without checking this disk, and dedupes sessions per device", () => {
		const value = {
			version: 1,
			activeIndex: 1,
			tabs: [
				{ cwd: "/a", kind: "agent", sessionPath: "/sessions/a.jsonl" },
				{ cwd: "/Users/b/project", kind: "agent", sessionPath: "/sessions/a.jsonl", device: "host-b" },
				// Same host, same file: a second attach would double-own it.
				{ cwd: "/Users/b/other", kind: "agent", sessionPath: "/sessions/a.jsonl", device: "host-b" },
				{ cwd: "/Users/c/project", kind: "chat", device: "host-c" },
			],
		};
		const checks = pathChecks(["/a"], ["/sessions/a.jsonl"]);
		const directoryExists = checks.directoryExists;
		const probed: string[] = [];
		checks.directoryExists = path => {
			probed.push(path);
			return directoryExists(path);
		};

		expect(sanitizePersistedTabLayout(value, checks)).toEqual({
			version: 1,
			activeIndex: 1,
			tabs: [
				{ cwd: "/a", kind: "agent", sessionPath: "/sessions/a.jsonl" },
				{ cwd: "/Users/b/project", kind: "agent", sessionPath: "/sessions/a.jsonl", device: "host-b" },
				{ cwd: "/Users/c/project", kind: "chat", device: "host-c" },
			],
		});
		expect(probed).toEqual(["/a"]);
	});
});

describe("persisted session (all windows)", () => {
	function layout(cwdCount: number, prefix: string, activeIndex = 0) {
		return {
			version: 1,
			activeIndex,
			tabs: Array.from({ length: cwdCount }, (_, index) => ({
				cwd: `/${prefix}-${index}`,
				kind: "agent",
			})),
		};
	}

	function dirs(...prefixes: string[]): string[] {
		return prefixes.flatMap(prefix => Array.from({ length: 12 }, (_, index) => `/${prefix}-${index}`));
	}

	it("restores one layout per window and still reads the pre-multi-window single object", () => {
		const first = layout(2, "a");
		const second = layout(1, "b");
		const paths = pathChecks(dirs("a", "b"), []);

		expect(sanitizePersistedTabLayouts([first, second], paths)).toEqual([first, second]);
		// An upgrade from the one-slot shape must not lose the session.
		expect(sanitizePersistedTabLayouts(first, paths)).toEqual([first]);
	});

	it("skips an unsalvageable window without shifting the rest", () => {
		const second = layout(1, "b");
		const restored = sanitizePersistedTabLayouts(
			[null, { version: 1, activeIndex: 0, tabs: [{ cwd: "/gone", kind: "agent" }] }, second],
			pathChecks(dirs("b"), []),
		);

		expect(restored).toEqual([second]);
	});

	it("restores every window's tabs with no total limit", () => {
		const paths = pathChecks(dirs("a", "b"), []);
		const restored = sanitizePersistedTabLayouts(
			[
				layout(12, "a"),
				{ ...layout(4, "b", 3), split: { axis: "rows", firstIndex: 2, secondIndex: 3, ratio: 0.5 } },
			],
			paths,
		);
		expect(restored.map(entry => entry.tabs.length)).toEqual([12, 4]);
		expect(restored[1]?.activeIndex).toBe(3);
		expect(restored[1]?.split).toBeDefined();
	});

	it("returns nothing for a session with no restorable window", () => {
		expect(sanitizePersistedTabLayouts([], pathChecks([], []))).toEqual([]);
		expect(sanitizePersistedTabLayouts(undefined, pathChecks([], []))).toEqual([]);
	});
});
