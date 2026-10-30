import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_DEVICE } from "../lib/sidebar-memory";

const saved = new Map<string, unknown>();
const local = new Map<string, string>();
const get = vi.fn(async (key: string) => saved.get(key));
const set = vi.fn(async (key: string, value: unknown) => void saved.set(key, structuredClone(value)));

beforeEach(() => {
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => local.get(key) ?? null,
		setItem: (key: string, value: string) => void local.set(key, value),
	});
	vi.stubGlobal("window", { omp: { prefs: { get, set } } });
});

afterEach(() => {
	saved.clear();
	local.clear();
	get.mockClear();
	set.mockClear();
	vi.unstubAllGlobals();
	vi.resetModules();
});

/** A relaunch: every module is evaluated again over the same storage. */
async function launch() {
	vi.resetModules();
	const { useSidebarFolds } = await import("./sidebar-folds");
	const { useSidebarSubagentsStore } = await import("./sidebar-subagents");
	return { folds: useSidebarFolds, families: useSidebarSubagentsStore };
}

describe("remembered folds", () => {
	it("keeps every fold across a relaunch, first frame included", async () => {
		const first = await launch();
		const folds = first.folds.getState();
		folds.setGroupFolded("/work/a", true);
		folds.setGroupFolded("/work/b", false);
		folds.setDeviceFolded(LOCAL_DEVICE, true);
		folds.setDeviceFolded("dev-1", true);
		folds.setDeviceGroupFolded("dev-1", "/srv/app", true);
		folds.setChatsFolded(LOCAL_DEVICE, true);
		folds.setArchivedOpen(true);
		folds.setDeviceArchivedOpen("dev-1", true);
		folds.setStarterOpen(true);
		folds.setUsageCollapsed(true);

		// The next start reads the mirror synchronously: no pref read yet.
		const second = await launch();
		const state = second.folds.getState();
		expect(state.groups).toEqual({ "/work/a": true, "/work/b": false });
		expect(state.devices).toEqual({ [LOCAL_DEVICE]: true, "dev-1": true });
		expect(state.deviceGroups).toEqual({ "dev-1\n/srv/app": true });
		expect(state.chats).toEqual({ [LOCAL_DEVICE]: true });
		expect(state.deviceArchived).toEqual({ "dev-1": true });
		expect([state.archivedOpen, state.starterOpen, state.usageCollapsed]).toEqual([true, true, true]);
		expect(get).not.toHaveBeenCalled();
	});

	it("takes the saved pref over the mirror once read, unless the user already edited", async () => {
		saved.set("sidebarFolds", { groups: { "/from/pref": true } });
		const first = await launch();
		await first.folds.getState().hydrate();
		expect(first.folds.getState().groups).toEqual({ "/from/pref": true });
		expect(local.get("omp.sidebarFolds")).toContain("/from/pref");

		const second = await launch();
		second.folds.getState().setGroupFolded("/edited", false);
		saved.set("sidebarFolds", { groups: { "/stale": true } });
		await second.folds.getState().hydrate();
		expect(second.folds.getState().groups).toEqual({ "/from/pref": true, "/edited": false });
	});

	it("leaves the mirror alone when the pref cannot be read", async () => {
		local.set("omp.sidebarFolds", JSON.stringify({ groups: { "/kept": true } }));
		get.mockRejectedValueOnce(new Error("io"));
		const run = await launch();
		await run.folds.getState().hydrate();
		expect(run.folds.getState().groups).toEqual({ "/kept": true });
		expect(set).not.toHaveBeenCalled();
	});

	it("prunes the folds of folders and hosts that no longer exist, this device always stays", async () => {
		const { folds } = await launch();
		const state = folds.getState();
		state.setGroupFolded("/work/live", true);
		state.setGroupFolded("/work/gone", true);
		state.setDeviceFolded(LOCAL_DEVICE, true);
		state.setDeviceFolded("dev-live", true);
		state.setDeviceFolded("dev-gone", true);
		state.setDeviceGroupFolded("dev-live", "/a", true);
		state.setDeviceGroupFolded("dev-gone", "/b", true);
		state.setDeviceArchivedOpen("dev-live", true);
		state.setDeviceArchivedOpen("dev-gone", true);

		const exists = (key: string) => ["/work/live", "/repo"].includes(key);
		folds.getState().pruneGroups(exists);
		folds.getState().syncHosts([{ id: "dev-live", name: "live" }]);

		expect(folds.getState().groups).toEqual({ "/work/live": true });
		expect(folds.getState().devices).toEqual({ [LOCAL_DEVICE]: true, "dev-live": true });
		expect(folds.getState().deviceGroups).toEqual({ "dev-live\n/a": true });
		expect(folds.getState().deviceArchived).toEqual({ "dev-live": true });
		// The pruned record is what the next start reads.
		const next = await launch();
		expect(next.folds.getState().groups).toEqual({ "/work/live": true });
		expect(next.folds.getState().devices).toEqual({ [LOCAL_DEVICE]: true, "dev-live": true });
	});

	it("keeps the device order across a relaunch, first frame included, and drops an unpaired device", async () => {
		const { folds } = await launch();
		folds.getState().setDeviceOrder(["dev-b", LOCAL_DEVICE, "dev-gone"]);
		expect(set).toHaveBeenLastCalledWith(
			"sidebarFolds",
			expect.objectContaining({ deviceOrder: ["dev-b", LOCAL_DEVICE, "dev-gone"] }),
		);

		// Before any pref read, the mirror already paints the order.
		let next = await launch();
		expect(next.folds.getState().deviceOrder).toEqual(["dev-b", LOCAL_DEVICE, "dev-gone"]);

		next.folds.getState().syncHosts([{ id: "dev-b", name: "b" }]);
		expect(next.folds.getState().deviceOrder).toEqual(["dev-b", LOCAL_DEVICE]);
		next = await launch();
		expect(next.folds.getState().deviceOrder).toEqual(["dev-b", LOCAL_DEVICE]);
	});

	it("reads a malformed saved order as no order", async () => {
		local.set("omp.sidebarFolds", JSON.stringify({ deviceOrder: ["dev-a", 3, "", "dev-a", null] }));
		expect((await launch()).folds.getState().deviceOrder).toEqual(["dev-a"]);
		local.set("omp.sidebarFolds", JSON.stringify({ deviceOrder: "dev-a" }));
		expect((await launch()).folds.getState().deviceOrder).toEqual([]);
	});
});

describe("remembered family folds", () => {
	it("keeps the open and hidden families across a relaunch and prunes sessions that are gone", async () => {
		const first = await launch();
		const families = first.families.getState();
		families.setExpanded("/s/a.jsonl", true);
		families.setExpanded("/s/gone.jsonl", true);
		families.setExpanded("tab:t1", true);
		families.setHidden("/s/b.jsonl", true);
		families.setHidden("/s/gone.jsonl", true);

		const second = await launch();
		expect([...second.families.getState().expanded]).toEqual(["/s/a.jsonl", "/s/gone.jsonl"]);
		expect([...second.families.getState().hidden]).toEqual(["/s/b.jsonl", "/s/gone.jsonl"]);

		second.families.getState().pruneFamilies(key => key !== "/s/gone.jsonl");
		expect([...second.families.getState().expanded]).toEqual(["/s/a.jsonl"]);
		expect([...second.families.getState().hidden]).toEqual(["/s/b.jsonl"]);

		const third = await launch();
		expect([...third.families.getState().expanded]).toEqual(["/s/a.jsonl"]);
		expect([...third.families.getState().hidden]).toEqual(["/s/b.jsonl"]);
		expect(saved.get("sidebarFamilies")).toEqual({ expanded: ["/s/a.jsonl"], hidden: ["/s/b.jsonl"] });
	});

	it("hydrates from the saved pref unless the user toggled first", async () => {
		saved.set("sidebarFamilies", { expanded: ["/s/pref.jsonl"], hidden: [] });
		const run = await launch();
		await run.families.getState().hydrate();
		expect([...run.families.getState().expanded]).toEqual(["/s/pref.jsonl"]);

		const again = await launch();
		again.families.getState().setExpanded("/s/mine.jsonl", true);
		saved.set("sidebarFamilies", { expanded: ["/s/stale.jsonl"], hidden: [] });
		await again.families.getState().hydrate();
		expect([...again.families.getState().expanded]).toEqual(["/s/pref.jsonl", "/s/mine.jsonl"]);
	});
});
