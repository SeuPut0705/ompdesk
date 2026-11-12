import { describe, expect, it } from "vitest";
import { memoryRecord, processOwners, RECORD_EVERY_MS, RECORD_TOP_PROCESSES, RecordClock } from "./memory-record";
import type { TaggedProcess, TagOwner } from "./session-processes";

const MB = 1024 ** 2;
const NOW = 60_000_000;
const TAG_A = "a".repeat(32);
const TAG_B = "b".repeat(32);
const TAG_GONE = "c".repeat(32);
const MAIN = 100;

/** A process that started `pid` minutes after boot, so a parent (a lower pid here) is always older than its child. */
const row = (pid: number, ppid: number, mbytes: number, name: string, extra: Partial<TaggedProcess> = {}) => ({
	pid,
	ppid,
	bytes: mbytes * MB,
	name,
	startedMs: 60_000 * pid,
	...extra,
});

/** OMPdesk (100) runs tab A's omp (200) and a hosted tab's (300); A left a re-parented dev server (900, parent 1). */
const ROWS: TaggedProcess[] = [
	row(1, 0, 10, "launchd"),
	row(MAIN, 1, 400, "OMPdesk"),
	row(110, MAIN, 150, "OMPdesk Helper"),
	row(200, MAIN, 280, "bun", { tag: TAG_A }),
	row(210, 200, 60, "node", { tag: TAG_A }),
	row(900, 1, 900, "node", { tag: TAG_A }),
	row(300, MAIN, 260, "bun", { tag: TAG_B }),
	row(310, 300, 1200, "qemu-system-aarch64-headless", { tag: TAG_B }),
	row(950, 1, 700, "adb", { tag: TAG_GONE }),
	row(500, 1, 2000, "Xcode"),
];
const OWNERS: TagOwner[] = [
	{ tag: TAG_A, cwd: "/work/shop", sessionPath: "/s/a.jsonl", pid: 200 },
	{ tag: TAG_B, cwd: "/work/app", sessionPath: "/s/b.jsonl", device: "MacBook", pid: 300 },
];
const TABS = [
	{ pid: 200, label: "Checkout page" },
	{ pid: 300, label: "Emulator run (for MacBook)" },
];

describe("who uses the memory", () => {
	it("names each of the largest processes with its size, age and session, or says it is not OMPdesk's", () => {
		const record = memoryRecord(ROWS, OWNERS, TABS, MAIN, NOW);
		expect(record.top.slice(0, 5)).toEqual([
			{ name: "Xcode", pid: 500, mb: 2000, ageMin: 500, owner: "not OMPdesk's" },
			{
				name: "qemu-system-aarch64-headless",
				pid: 310,
				mb: 1200,
				ageMin: 690,
				owner: "session",
				session: "Emulator run (for MacBook)",
				folder: "/work/app",
				device: "MacBook",
			},
			// Re-parented long ago: only its tag says whose it is.
			{
				name: "node",
				pid: 900,
				mb: 900,
				ageMin: 100,
				owner: "session",
				session: "Checkout page",
				folder: "/work/shop",
			},
			// A tag no open tab holds.
			{ name: "adb", pid: 950, mb: 700, ageMin: 50, owner: "closed session" },
			{ name: "OMPdesk", pid: MAIN, mb: 400, ageMin: 900, owner: "OMPdesk" },
		]);
		expect(record.sessions).toEqual([
			{ session: "Emulator run (for MacBook)", folder: "/work/app", device: "MacBook", mb: 1460, processes: 2 },
			{ session: "Checkout page", folder: "/work/shop", mb: 1240, processes: 3 },
			{ session: "(closed session)", mb: 700, processes: 1 },
		]);
		expect([record.sessionsMb, record.ompdeskMb, record.otherMb]).toEqual([3400, 550, 2010]);
	});

	it("names at most the bound, however many processes run", () => {
		const many = Array.from({ length: 400 }, (_, index) => row(1000 + index, 1, index, "worker"));
		const record = memoryRecord(many, [], [], MAIN, NOW);
		expect(record.top).toHaveLength(RECORD_TOP_PROCESSES);
		expect(record.top[0]).toMatchObject({ pid: 1399, mb: 399 });
	});

	it("gives an untagged process under a tab's omp to that tab", () => {
		// An omp started before tags existed, or a child that cleared its environment.
		const rows = [
			row(MAIN, 1, 1, "OMPdesk"),
			row(200, MAIN, 1, "bun"),
			row(210, 200, 1, "bash"),
			row(220, 210, 1, "node"),
		];
		const whose = processOwners(rows, [], [{ pid: 200, label: "Old tab" }], MAIN);
		expect(whose.get(220)).toEqual({ kind: "session", title: "Old tab" });
		expect(whose.get(MAIN)).toEqual({ kind: "ompdesk" });
	});

	it("never follows a parent id that names a younger process", () => {
		// Windows keeps a dead parent's id on its children; the id now names a process OMPdesk started later.
		const rows = [
			row(MAIN, 1, 1, "OMPdesk.exe", { startedMs: 1_000 }),
			row(700, MAIN, 1, "conhost.exe", { startedMs: 9_000 }),
			row(710, 700, 1, "chrome.exe", { startedMs: 2_000 }),
		];
		expect(processOwners(rows, [], [], MAIN).get(710)).toEqual({ kind: "other" });
	});
});

describe("when the record is written", () => {
	it("writes as memory turns short, then every five minutes while it stays short", () => {
		const clock = new RecordClock();
		expect(clock.due(0, false)).toBe(false);
		expect(clock.due(5_000, true)).toBe(true);
		expect(clock.due(10_000, true)).toBe(false);
		expect(clock.due(5_000 + RECORD_EVERY_MS - 1, true)).toBe(false);
		expect(clock.due(5_000 + RECORD_EVERY_MS, true)).toBe(true);
		// Fine again, then short again: a new spell is recorded at once.
		expect(clock.due(5_000 + RECORD_EVERY_MS + 5_000, false)).toBe(false);
		expect(clock.due(5_000 + RECORD_EVERY_MS + 10_000, true)).toBe(true);
	});
});
