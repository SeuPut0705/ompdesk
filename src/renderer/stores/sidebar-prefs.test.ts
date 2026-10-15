/**
 * sidebar-prefs store contract: pin toggles, the workspace MRU clock,
 * workspace aliases, persistence payloads, and hydrate-from-blob. A rejected
 * prefs write must undo the optimistic toggle (the sidebar would otherwise
 * show a pin that disappears on the next launch).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "../lib/i18n";
import { PREFS_BOOT_RETRY_MS } from "../lib/prefs-read";
import { useSidebarPrefs } from "./sidebar-prefs";
import { useToastStore } from "./toast";

const get = vi.fn(async (_key: string) => null as unknown);
const set = vi.fn(async (_key: string, _value: unknown) => {});
(globalThis as Record<string, unknown>).window = { omp: { prefs: { get, set } } };

afterEach(() => {
	get.mockReset();
	set.mockReset();
	useSidebarPrefs.getState().reset();
	useToastStore.setState({ toasts: [] });
});

describe("sidebar-prefs store", () => {
	beforeEach(() => useSidebarPrefs.setState({ hydrated: true }));

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

	it("hydrates from the persisted blob once, drops retired keys, and tolerates missing prefs", async () => {
		useSidebarPrefs.getState().reset();
		get.mockResolvedValueOnce({
			pinnedGroups: ["/work/pinned"],
			pinnedSessions: ["/s/p.jsonl"],
			groupAliases: { "/work/a": "Alias" },
			workspaceLastUsed: { "/work/a": 100, bad: "yesterday" },
			// Retired pref: read past, never written back.
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

		useSidebarPrefs.getState().touchWorkspace("/work/b");
		const written = set.mock.calls.at(-1)?.[1];
		expect(written).toEqual(expect.objectContaining({ pinnedSessions: ["/s/p.jsonl"] }));
		expect(written).not.toHaveProperty("sessionLastUsed");

		// A pref that was never stored hydrates to empty defaults, never a throw.
		useSidebarPrefs.getState().reset();
		get.mockResolvedValueOnce(undefined);
		await useSidebarPrefs.getState().hydrate();
		expect(useSidebarPrefs.getState().hydrated).toBe(true);
		expect(useSidebarPrefs.getState().pinnedGroups).toEqual([]);
	});

	it("archives and restores sessions by id, persisting the set and the flat-recent grouping", async () => {
		await useSidebarPrefs.getState().setSessionsArchived(["s1", "s2"], true);
		await useSidebarPrefs.getState().setSessionsArchived(["s2", "s3"], true);
		expect(useSidebarPrefs.getState().archivedSessions).toEqual(["s1", "s2", "s3"]);
		await useSidebarPrefs.getState().setSessionsArchived(["s2"], false);
		expect(useSidebarPrefs.getState().archivedSessions).toEqual(["s1", "s3"]);
		expect(set).toHaveBeenLastCalledWith("sidebar", expect.objectContaining({ archivedSessions: ["s1", "s3"] }));

		await useSidebarPrefs.getState().setGrouping("recent");
		expect(set).toHaveBeenLastCalledWith("sidebar", expect.objectContaining({ grouping: "recent" }));

		useSidebarPrefs.getState().reset();
		get.mockResolvedValueOnce({ archivedSessions: ["s9", 4], grouping: "sideways" });
		await useSidebarPrefs.getState().hydrate();
		expect(useSidebarPrefs.getState().archivedSessions).toEqual(["s9"]);
		expect(useSidebarPrefs.getState().grouping).toBe("projects");
	});

	it("rolls back an archive the prefs store refused to save", async () => {
		set.mockRejectedValueOnce(new Error("disk full"));
		await useSidebarPrefs.getState().setSessionsArchived(["s1"], true);
		expect(useSidebarPrefs.getState().archivedSessions).toEqual([]);
		expect(useToastStore.getState().toasts.map(toast => toast.title)).toEqual([translate("sidebar.archiveFailed")]);
	});

	it("rolls back a group pin when the prefs write is rejected", async () => {
		useSidebarPrefs.setState({ pinnedGroups: ["/work/kept"] });
		set.mockRejectedValueOnce(new Error("disk full"));

		await useSidebarPrefs.getState().toggleGroupPin("/work/a");

		expect(set).toHaveBeenCalledWith("sidebar", expect.objectContaining({ pinnedGroups: ["/work/kept", "/work/a"] }));
		expect(useSidebarPrefs.getState().pinnedGroups).toEqual(["/work/kept"]);
		expect(useToastStore.getState().toasts).toContainEqual(
			expect.objectContaining({
				variant: "error",
				title: translate("sidebar.pinFailed"),
				message: translate("toast.failedRetry"),
				detail: "disk full",
			}),
		);
	});

	it("keeps an earlier pin and reports a rename that the store refused to save", async () => {
		useSidebarPrefs.setState({ pinnedSessions: ["/s/kept.jsonl"], groupAliases: { "/work/a": "Frontend" } });
		set.mockRejectedValueOnce(new Error("EPERM"));

		await useSidebarPrefs.getState().setGroupAlias("/work/a", "Platform");

		expect(useSidebarPrefs.getState().groupAliases).toEqual({ "/work/a": "Frontend" });
		expect(useSidebarPrefs.getState().pinnedSessions).toEqual(["/s/kept.jsonl"]);
		expect(useToastStore.getState().toasts).toContainEqual(
			expect.objectContaining({
				variant: "error",
				title: translate("sidebar.renameFailed"),
				message: translate("toast.failedRetry"),
				detail: "EPERM",
			}),
		);
	});
});

describe("sidebar-prefs store with unreadable prefs", () => {
	const stored = {
		pinnedGroups: ["/work/pinned"],
		pinnedSessions: ["/s/p.jsonl"],
		groupAliases: { "/work/a": "Alias" },
		archivedSessions: ["s9"],
		groupOrder: ["/work/b", "/work/a"],
	};

	afterEach(() => {
		vi.useRealTimers();
	});

	/** The boot read against a failing prefs bridge, through every bounded retry. */
	async function failBootRead(): Promise<void> {
		vi.useFakeTimers();
		get.mockRejectedValue(new Error("io"));
		const hydrating = useSidebarPrefs.getState().hydrate();
		await vi.advanceTimersByTimeAsync(60_000);
		await hydrating;
	}

	it("stays un-hydrated after a failed read and retries with a bounded backoff", async () => {
		await failBootRead();
		expect(useSidebarPrefs.getState().hydrated).toBe(false);
		expect(get).toHaveBeenCalledTimes(1 + PREFS_BOOT_RETRY_MS.length);

		get.mockResolvedValue(stored);
		await useSidebarPrefs.getState().hydrate();
		expect(useSidebarPrefs.getState().hydrated).toBe(true);
		expect(useSidebarPrefs.getState().pinnedGroups).toEqual(["/work/pinned"]);
	});

	it("never writes defaults over stored data after a failed read", async () => {
		await failBootRead();

		await useSidebarPrefs.getState().toggleGroupPin("/work/new");
		await useSidebarPrefs.getState().toggleSessionPin("/s/new.jsonl");
		await useSidebarPrefs.getState().setGroupAlias("/work/a", "Renamed");
		await useSidebarPrefs.getState().setGroupOrder(["/work/a"]);
		await useSidebarPrefs.getState().setSessionsArchived(["s1"], true);
		await useSidebarPrefs.getState().setGrouping("recent");
		await useSidebarPrefs.getState().toggleRailPin("usage");
		useSidebarPrefs.getState().touchWorkspace("/work/new");

		expect(set).not.toHaveBeenCalled();
		expect(useSidebarPrefs.getState().hydrated).toBe(false);
		expect(useSidebarPrefs.getState().pinnedGroups).toEqual([]);
		// One refusal per action the user took; the recency hint stays silent.
		expect(useToastStore.getState().toasts.map(toast => toast.title)).toContain(translate("sidebar.pinFailed"));
		expect(useToastStore.getState().toasts.at(-1)?.detail).toBe(translate("prefs.unreadable"));
	});

	it("reads again before a write and merges the change into what is stored", async () => {
		await failBootRead();
		expect(useSidebarPrefs.getState().hydrated).toBe(false);

		get.mockResolvedValueOnce(stored);
		await useSidebarPrefs.getState().toggleGroupPin("/work/new");

		expect(useSidebarPrefs.getState().hydrated).toBe(true);
		expect(set).toHaveBeenCalledTimes(1);
		expect(set).toHaveBeenCalledWith(
			"sidebar",
			expect.objectContaining({
				pinnedGroups: ["/work/pinned", "/work/new"],
				pinnedSessions: ["/s/p.jsonl"],
				groupAliases: { "/work/a": "Alias" },
				archivedSessions: ["s9"],
				groupOrder: ["/work/b", "/work/a"],
			}),
		);
	});

	it("reads before the first write when nothing has hydrated yet", async () => {
		get.mockResolvedValueOnce(stored);
		await useSidebarPrefs.getState().setSessionsArchived(["s1"], true);
		expect(set).toHaveBeenCalledWith(
			"sidebar",
			expect.objectContaining({ archivedSessions: ["s9", "s1"], pinnedGroups: ["/work/pinned"] }),
		);
	});
});
