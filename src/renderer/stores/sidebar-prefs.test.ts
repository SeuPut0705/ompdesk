/**
 * sidebar-prefs store contract: pin toggles, MRU access times, workspace
 * aliases, persistence payloads, and hydrate-from-blob. A rejected prefs write
 * must undo the optimistic toggle (the sidebar would otherwise show a pin that
 * disappears on the next launch).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { translate } from "../lib/i18n";
import { useSidebarPrefs } from "./sidebar-prefs";
import { useToastStore } from "./toast";

const get = vi.fn(async (_key: string) => null as unknown);
const set = vi.fn(async (_key: string, _value: unknown) => {});
(globalThis as Record<string, unknown>).window = { omp: { prefs: { get, set } } };

afterEach(() => {
	get.mockClear();
	set.mockClear();
	useSidebarPrefs.getState().reset();
	useToastStore.setState({ toasts: [] });
});

describe("sidebar-prefs store", () => {
	it("toggles group and session pins, persisting each change", () => {
		useSidebarPrefs.getState().toggleGroupPin("/work/a");
		expect(useSidebarPrefs.getState().pinnedGroups).toEqual(["/work/a"]);
		expect(set).toHaveBeenCalledWith("sidebar", expect.objectContaining({ pinnedGroups: ["/work/a"] }));

		useSidebarPrefs.getState().toggleGroupPin("/work/a");
		expect(useSidebarPrefs.getState().pinnedGroups).toEqual([]);
		expect(set).toHaveBeenCalledWith("sidebar", expect.objectContaining({ pinnedGroups: [] }));

		useSidebarPrefs.getState().toggleSessionPin("/s/one.jsonl");
		useSidebarPrefs.getState().toggleSessionPin("/s/two.jsonl");
		expect(useSidebarPrefs.getState().pinnedSessions).toEqual(["/s/one.jsonl", "/s/two.jsonl"]);
	});

	it("sets and clears workspace aliases, dropping empty values", () => {
		useSidebarPrefs.getState().setGroupAlias("/work/a", "  Frontend  ");
		expect(useSidebarPrefs.getState().groupAliases).toEqual({ "/work/a": "Frontend" });
		expect(set).toHaveBeenCalledWith("sidebar", expect.objectContaining({ groupAliases: { "/work/a": "Frontend" } }));

		useSidebarPrefs.getState().setGroupAlias("/work/a", null);
		expect(useSidebarPrefs.getState().groupAliases).toEqual({});

		useSidebarPrefs.getState().setGroupAlias("/work/a", "   ");
		expect(useSidebarPrefs.getState().groupAliases).toEqual({});
	});

	it("touches workspaces with a monotonic persisted MRU clock", () => {
		useSidebarPrefs.setState({ workspaceLastUsed: { "/work/old": Date.now() + 60_000 } });

		useSidebarPrefs.getState().touchWorkspace("/work/new");
		const timestamp = useSidebarPrefs.getState().workspaceLastUsed["/work/new"];
		expect(timestamp).toBeGreaterThan(useSidebarPrefs.getState().workspaceLastUsed["/work/old"] ?? 0);
		expect(set).toHaveBeenLastCalledWith(
			"sidebar",
			expect.objectContaining({ workspaceLastUsed: expect.objectContaining({ "/work/new": timestamp }) }),
		);
	});

	it("hydrates from the persisted blob once and tolerates missing prefs", async () => {
		get.mockResolvedValueOnce({
			pinnedGroups: ["/work/pinned"],
			pinnedSessions: ["/s/p.jsonl"],
			groupAliases: { "/work/a": "Alias" },
			workspaceLastUsed: { "/work/a": 100, bad: "yesterday" },
			sessionLastUsed: { "/s/p.jsonl": 200 },
		});
		await useSidebarPrefs.getState().hydrate();
		expect(useSidebarPrefs.getState().pinnedGroups).toEqual(["/work/pinned"]);
		expect(useSidebarPrefs.getState().pinnedSessions).toEqual(["/s/p.jsonl"]);
		expect(useSidebarPrefs.getState().groupAliases).toEqual({ "/work/a": "Alias" });
		expect(useSidebarPrefs.getState().workspaceLastUsed).toEqual({ "/work/a": 100 });

		// Second hydrate is a no-op (already hydrated).
		const calls = get.mock.calls.length;
		await useSidebarPrefs.getState().hydrate();
		expect(get.mock.calls.length).toBe(calls);

		// Unreadable prefs degrade to empty defaults, never a throw.
		useSidebarPrefs.getState().reset();
		get.mockRejectedValueOnce(new Error("io"));
		await useSidebarPrefs.getState().hydrate();
		expect(useSidebarPrefs.getState().hydrated).toBe(true);
		expect(useSidebarPrefs.getState().pinnedGroups).toEqual([]);
	});

	it("rolls back a group pin when the prefs write is rejected", async () => {
		useSidebarPrefs.setState({ pinnedGroups: ["/work/kept"] });
		set.mockRejectedValueOnce(new Error("disk full"));

		await useSidebarPrefs.getState().toggleGroupPin("/work/a");

		expect(set).toHaveBeenCalledWith("sidebar", expect.objectContaining({ pinnedGroups: ["/work/kept", "/work/a"] }));
		expect(useSidebarPrefs.getState().pinnedGroups).toEqual(["/work/kept"]);
		expect(useToastStore.getState().toasts).toContainEqual(
			expect.objectContaining({ variant: "error", title: translate("sidebar.pinFailed"), message: "disk full" }),
		);
	});

	it("keeps an earlier pin and reports a rename that the store refused to save", async () => {
		useSidebarPrefs.setState({ pinnedSessions: ["/s/kept.jsonl"], groupAliases: { "/work/a": "Frontend" } });
		set.mockRejectedValueOnce(new Error("EPERM"));

		await useSidebarPrefs.getState().setGroupAlias("/work/a", "Platform");

		expect(useSidebarPrefs.getState().groupAliases).toEqual({ "/work/a": "Frontend" });
		expect(useSidebarPrefs.getState().pinnedSessions).toEqual(["/s/kept.jsonl"]);
		expect(useToastStore.getState().toasts).toContainEqual(
			expect.objectContaining({ variant: "error", title: translate("sidebar.renameFailed"), message: "EPERM" }),
		);
	});
});
