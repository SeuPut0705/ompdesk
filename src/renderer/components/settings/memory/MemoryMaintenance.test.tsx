import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useMemoryPageStore } from "../../../stores/memory-page";
import { MemoryMaintenance } from "./MemoryMaintenance";
import {
	cleanup,
	click,
	fakeMemoryApi,
	installApi,
	memoryState,
	mount,
	PROJECT,
	q,
	qa,
	text,
	type,
} from "./memory-test-harness";

let api = fakeMemoryApi();

beforeEach(() => {
	api = fakeMemoryApi();
	installApi(api);
});
afterEach(cleanup);

const mountIt = () => mount(<MemoryMaintenance project={PROJECT} state={memoryState()} />);

describe("Memory › Maintenance", () => {
	it("keeps every row to one line: descriptions are tooltips", async () => {
		await mountIt();
		expect(qa("[data-setting-desc]")).toHaveLength(0);
	});

	it("runs the lint check and lists findings that open their pages", async () => {
		api.lint.mockResolvedValue([
			{ kind: "duplicate", severity: "warning", message: "Two pages share a title", pages: ["notes/a.md"] },
		]);
		await mountIt();
		await click(q("[data-memory-lint-run]"));
		expect(api.lint).toHaveBeenCalledWith(PROJECT);
		expect(text("[data-memory-finding]")).toContain("Two pages share a title");
		await click(qa("[data-memory-finding] button")[0] ?? null);
		expect(useMemoryPageStore.getState().pending).toMatchObject({ ...PROJECT, path: "notes/a.md" });
	});

	it("says so when the check finds nothing", async () => {
		await mountIt();
		await click(q("[data-memory-lint-run]"));
		expect(q("[data-memory-lint-none]")).not.toBeNull();
	});

	it("shows nothing about the upkeep until it changed something", async () => {
		await mountIt();
		expect(q("#setting-memory-care")).toBeNull();
		expect(q("[data-memory-care-undo]")).toBeNull();
	});

	it("shows one line of what the upkeep did and undoes its page changes", async () => {
		api.care.mockResolvedValue({
			at: "2026-10-20T06:00:00Z",
			retired: 2,
			flagged: 0,
			backfilled: 340,
			pages: [
				{ ...PROJECT, path: "decisions/a.md", title: "Pairing code" },
				{ ...PROJECT, path: "decisions/b.md", title: "Manual update" },
			],
		});
		await mountIt();
		expect(text("[data-memory-maintenance]")).toContain(
			"Tidied by itself this week: 2 out-of-date pages hidden · 340 conclusions filled in from older conversations",
		);
		await click(q("[data-memory-care-undo]"));
		expect(api.undoCare).toHaveBeenCalledTimes(1);
	});

	it("the sweep needs a preview that found something, then asks before running", async () => {
		api.sweep.mockImplementation(async (_project, dryRun) => ({
			dryRun,
			evaluated: 9,
			evicted: 2,
			compacted: 0,
			merged: 0,
			expired: 0,
			observationsPruned: 0,
		}));
		await mountIt();
		expect(q("[data-memory-sweep-run]")?.hasAttribute("disabled")).toBe(true);
		await click(q("[data-memory-sweep-preview]"));
		expect(api.sweep).toHaveBeenLastCalledWith(PROJECT, true);
		expect(text("[data-memory-sweep-result]")).toContain("Would evict 2");
		expect(q("[data-memory-sweep-run]")?.hasAttribute("disabled")).toBe(false);
		await click(q("[data-memory-sweep-run]"));
		expect(api.sweep).toHaveBeenCalledTimes(1);
		await click(
			qa("button")
				.filter(item => item.textContent?.trim() === "Run sweep")
				.at(-1) ?? null,
		);
		expect(api.sweep).toHaveBeenLastCalledWith(PROJECT, false);
	});

	it("an empty preview leaves Run sweep off", async () => {
		await mountIt();
		await click(q("[data-memory-sweep-preview]"));
		expect(q("[data-memory-sweep-run]")?.hasAttribute("disabled")).toBe(true);
	});

	it("purge needs the typed word", async () => {
		await mountIt();
		await click(q("[data-memory-purge]"));
		const confirm = q("[data-memory-purge-confirm]");
		expect(confirm?.hasAttribute("disabled")).toBe(true);
		await type(q("[data-memory-purge-input]"), "nope");
		expect(q("[data-memory-purge-confirm]")?.hasAttribute("disabled")).toBe(true);
		await type(q("[data-memory-purge-input]"), "delete");
		expect(q("[data-memory-purge-confirm]")?.hasAttribute("disabled")).toBe(false);
		await click(q("[data-memory-purge-confirm]"));
		expect(api.purge).toHaveBeenCalledOnce();
	});
});
