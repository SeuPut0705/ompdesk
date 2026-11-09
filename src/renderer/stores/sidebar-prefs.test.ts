/**
 * sidebar-prefs store contract: pin toggles, the workspace MRU clock,
 * workspace aliases, the change each action sends to main, and hydrate-from-blob. A rejected
 * change must undo the optimistic toggle (the sidebar would otherwise
 * show a pin that disappears on the next launch).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "../lib/i18n";
import { PREFS_BOOT_RETRY_MS } from "../lib/prefs-read";
import { useSidebarPrefs } from "./sidebar-prefs";
import { useToastStore } from "./toast";

const get = vi.fn(async (_key: string) => null as unknown);
const updateSidebar = vi.fn(async (_change: unknown) => {});
(globalThis as Record<string, unknown>).window = { omp: { prefs: { get, updateSidebar } } };

afterEach(() => {
	get.mockReset();
	updateSidebar.mockReset();
	useSidebarPrefs.getState().reset();
	useToastStore.setState({ toasts: [] });
});

describe("sidebar-prefs store", () => {
	beforeEach(() => useSidebarPrefs.setState({ hydrated: true }));

	it("toggles group and session pins, sending each as a set the other windows can repeat", () => {
		useSidebarPrefs.getState().toggleGroupPin("/work/a");
		expect(useSidebarPrefs.getState().pinnedGroups).toEqual(["/work/a"]);
		expect(updateSidebar).toHaveBeenLastCalledWith({ op: "set-group-pinned", cwd: "/work/a", pinned: true });

		useSidebarPrefs.getState().toggleGroupPin("/work/a");
		expect(useSidebarPrefs.getState().pinnedGroups).toEqual([]);
		expect(updateSidebar).toHaveBeenLastCalledWith({ op: "set-group-pinned", cwd: "/work/a", pinned: false });

		useSidebarPrefs.getState().toggleSessionPin("/s/one.jsonl");
		useSidebarPrefs.getState().toggleSessionPin("/s/two.jsonl");
		expect(useSidebarPrefs.getState().pinnedSessions).toEqual(["/s/one.jsonl", "/s/two.jsonl"]);
		expect(updateSidebar).toHaveBeenLastCalledWith({ op: "set-session-pinned", path: "/s/two.jsonl", pinned: true });
	});

	it("hides a session from other agents and shows it again, sending the list main reads", () => {
		useSidebarPrefs.getState().toggleAgentHidden("/s/secret.jsonl");
		expect(useSidebarPrefs.getState().agentHidden).toEqual(["/s/secret.jsonl"]);
		expect(updateSidebar).toHaveBeenLastCalledWith({ op: "set-agent-hidden", path: "/s/secret.jsonl", hidden: true });
		useSidebarPrefs.getState().toggleAgentHidden("/s/secret.jsonl");
		expect(useSidebarPrefs.getState().agentHidden).toEqual([]);
		expect(updateSidebar).toHaveBeenLastCalledWith({
			op: "set-agent-hidden",
			path: "/s/secret.jsonl",
			hidden: false,
		});
	});

	it("sets and clears workspace aliases, dropping empty values", () => {
		useSidebarPrefs.getState().setGroupAlias("/work/a", "  Frontend  ");
		expect(useSidebarPrefs.getState().groupAliases).toEqual({ "/work/a": "Frontend" });
		expect(updateSidebar).toHaveBeenLastCalledWith({ op: "set-group-alias", cwd: "/work/a", alias: "  Frontend  " });

		useSidebarPrefs.getState().setGroupAlias("/work/a", null);
		expect(useSidebarPrefs.getState().groupAliases).toEqual({});

		useSidebarPrefs.getState().setGroupAlias("/work/b", "   ");
		expect(useSidebarPrefs.getState().groupAliases).toEqual({});
	});

	it("touches workspaces with a monotonic MRU clock, sending only the workspace", () => {
		useSidebarPrefs.setState({ workspaceLastUsed: { "/work/old": Date.now() + 60_000 } });

		useSidebarPrefs.getState().touchWorkspace("/work/new");
		const timestamp = useSidebarPrefs.getState().workspaceLastUsed["/work/new"];
		expect(timestamp).toBeGreaterThan(useSidebarPrefs.getState().workspaceLastUsed["/work/old"] ?? 0);
		expect(updateSidebar).toHaveBeenLastCalledWith({ op: "touch-workspace", cwd: "/work/new" });
	});

	it("sends the order of one list and the order of the projects, whole as the user set it", async () => {
		await useSidebarPrefs.getState().setSessionOrder("/work/a", ["/s/2.jsonl", "/s/1.jsonl", "/s/2.jsonl"]);
		expect(useSidebarPrefs.getState().sessionOrder).toEqual({ "/work/a": ["/s/2.jsonl", "/s/1.jsonl"] });
		expect(updateSidebar).toHaveBeenLastCalledWith({
			op: "set-session-order",
			list: "/work/a",
			order: ["/s/2.jsonl", "/s/1.jsonl", "/s/2.jsonl"],
		});

		await useSidebarPrefs.getState().setGroupOrder(["/work/b", "/work/a"]);
		expect(useSidebarPrefs.getState().groupOrder).toEqual(["/work/b", "/work/a"]);
		expect(updateSidebar).toHaveBeenLastCalledWith({ op: "set-group-order", order: ["/work/b", "/work/a"] });
	});

	it("keeps the footer pins in their own order and sends each as a set", async () => {
		await useSidebarPrefs.getState().toggleRailPin("schedules");
		await useSidebarPrefs.getState().toggleRailPin("files");
		expect(useSidebarPrefs.getState().railPins).toEqual(["usage", "files", "schedules"]);
		expect(updateSidebar).toHaveBeenLastCalledWith({ op: "set-rail-pin", pin: "files", pinned: true });
		await useSidebarPrefs.getState().toggleRailPin("usage");
		expect(useSidebarPrefs.getState().railPins).toEqual(["files", "schedules"]);
		expect(updateSidebar).toHaveBeenLastCalledWith({ op: "set-rail-pin", pin: "usage", pinned: false });
	});

	it("hydrates from the persisted blob once and tolerates missing prefs", async () => {
		useSidebarPrefs.getState().reset();
		get.mockResolvedValueOnce({
			pinnedGroups: ["/work/pinned"],
			pinnedSessions: ["/s/p.jsonl"],
			groupAliases: { "/work/a": "Alias" },
			workspaceLastUsed: { "/work/a": 100, bad: "yesterday" },
			// Retired pref: read past, never kept.
			sessionLastUsed: { "/s/p.jsonl": 200 },
		});
		await useSidebarPrefs.getState().hydrate();
		expect(useSidebarPrefs.getState().pinnedGroups).toEqual(["/work/pinned"]);
		expect(useSidebarPrefs.getState().pinnedSessions).toEqual(["/s/p.jsonl"]);
		expect(useSidebarPrefs.getState().groupAliases).toEqual({ "/work/a": "Alias" });
		expect(useSidebarPrefs.getState().workspaceLastUsed).toEqual({ "/work/a": 100 });
		expect(useSidebarPrefs.getState()).not.toHaveProperty("sessionLastUsed");

		// Second hydrate is a no-op (already hydrated).
		const calls = get.mock.calls.length;
		await useSidebarPrefs.getState().hydrate();
		expect(get.mock.calls.length).toBe(calls);

		// Hydrating writes nothing: the stored blob changes only through a change the user made.
		expect(updateSidebar).not.toHaveBeenCalled();

		// A pref that was never stored hydrates to empty defaults, never a throw.
		useSidebarPrefs.getState().reset();
		get.mockResolvedValueOnce(undefined);
		await useSidebarPrefs.getState().hydrate();
		expect(useSidebarPrefs.getState().hydrated).toBe(true);
		expect(useSidebarPrefs.getState().pinnedGroups).toEqual([]);
	});

	it("pins the usage block until a saved choice says otherwise", async () => {
		// Nothing stored, or a blob from before the pins existed: usage is on, the rest off.
		expect(useSidebarPrefs.getState().railPins).toEqual(["usage"]);
		get.mockResolvedValueOnce({ pinnedGroups: [] });
		useSidebarPrefs.getState().reset();
		await useSidebarPrefs.getState().hydrate();
		expect(useSidebarPrefs.getState().railPins).toEqual(["usage"]);

		// A saved choice is kept as it is: usage turned off stays off, even with nothing else pinned.
		for (const saved of [[], ["files"]]) {
			useSidebarPrefs.getState().reset();
			get.mockResolvedValueOnce({ railPins: saved });
			await useSidebarPrefs.getState().hydrate();
			expect(useSidebarPrefs.getState().railPins).toEqual(saved);
		}
	});

	it("archives and restores sessions by id, sending the ids", async () => {
		await useSidebarPrefs.getState().setSessionsArchived(["s1", "s2"], true);
		await useSidebarPrefs.getState().setSessionsArchived(["s2", "s3"], true);
		expect(useSidebarPrefs.getState().archivedSessions).toEqual(["s1", "s2", "s3"]);
		await useSidebarPrefs.getState().setSessionsArchived(["s2"], false);
		expect(useSidebarPrefs.getState().archivedSessions).toEqual(["s1", "s3"]);
		expect(updateSidebar).toHaveBeenLastCalledWith({ op: "set-sessions-archived", ids: ["s2"], archived: false });

		useSidebarPrefs.getState().reset();
		get.mockResolvedValueOnce({ archivedSessions: ["s9", 4] });
		await useSidebarPrefs.getState().hydrate();
		expect(useSidebarPrefs.getState().archivedSessions).toEqual(["s9"]);
	});

	it("sends nothing for a change that changes nothing", async () => {
		useSidebarPrefs.setState({ pinnedGroups: ["/work/a"], archivedSessions: ["s1"] });
		await useSidebarPrefs.getState().setSessionsArchived(["s1"], true);
		await useSidebarPrefs.getState().setSessionsArchived(["s2"], false);
		await useSidebarPrefs.getState().setGroupAlias("/work/a", null);
		expect(updateSidebar).not.toHaveBeenCalled();
	});

	it("rolls back an archive main refused to save", async () => {
		updateSidebar.mockRejectedValueOnce(new Error("disk full"));
		await useSidebarPrefs.getState().setSessionsArchived(["s1"], true);
		expect(useSidebarPrefs.getState().archivedSessions).toEqual([]);
		expect(useToastStore.getState().toasts.map(toast => toast.title)).toEqual([translate("sidebar.archiveFailed")]);
	});

	it("rolls back a group pin when main rejects the change", async () => {
		useSidebarPrefs.setState({ pinnedGroups: ["/work/kept"] });
		updateSidebar.mockRejectedValueOnce(new Error("disk full"));

		await useSidebarPrefs.getState().toggleGroupPin("/work/a");

		expect(updateSidebar).toHaveBeenCalledWith({ op: "set-group-pinned", cwd: "/work/a", pinned: true });
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

	it("keeps an earlier pin and reports a rename that main refused to save", async () => {
		useSidebarPrefs.setState({ pinnedSessions: ["/s/kept.jsonl"], groupAliases: { "/work/a": "Frontend" } });
		updateSidebar.mockRejectedValueOnce(new Error("EPERM"));

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
		sessionOrder: { "/work/a": ["/s/2.jsonl", "/s/1.jsonl"] },
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

	it("sends no change after a failed read: a toggle is decided from state it does not know", async () => {
		await failBootRead();

		await useSidebarPrefs.getState().toggleGroupPin("/work/new");
		await useSidebarPrefs.getState().toggleSessionPin("/s/new.jsonl");
		await useSidebarPrefs.getState().toggleAgentHidden("/s/new.jsonl");
		await useSidebarPrefs.getState().setGroupAlias("/work/a", "Renamed");
		await useSidebarPrefs.getState().setGroupOrder(["/work/a"]);
		await useSidebarPrefs.getState().setSessionOrder("/work/a", ["/s/1.jsonl"]);
		await useSidebarPrefs.getState().setSessionsArchived(["s1"], true);
		await useSidebarPrefs.getState().toggleRailPin("usage");
		useSidebarPrefs.getState().touchWorkspace("/work/new");

		expect(updateSidebar).not.toHaveBeenCalled();
		expect(useSidebarPrefs.getState().hydrated).toBe(false);
		expect(useSidebarPrefs.getState().pinnedGroups).toEqual([]);
		// One refusal per action the user took; the recency hint stays silent.
		expect(useToastStore.getState().toasts.map(toast => toast.title)).toContain(translate("sidebar.pinFailed"));
		expect(useToastStore.getState().toasts.at(-1)?.detail).toBe(translate("prefs.unreadable"));
	});

	it("reads again before a change and decides it from what is stored", async () => {
		await failBootRead();
		expect(useSidebarPrefs.getState().hydrated).toBe(false);

		get.mockResolvedValueOnce(stored);
		await useSidebarPrefs.getState().toggleGroupPin("/work/pinned");

		expect(useSidebarPrefs.getState().hydrated).toBe(true);
		expect(updateSidebar).toHaveBeenCalledTimes(1);
		expect(updateSidebar).toHaveBeenCalledWith({ op: "set-group-pinned", cwd: "/work/pinned", pinned: false });
		expect(useSidebarPrefs.getState().pinnedGroups).toEqual([]);
		expect(useSidebarPrefs.getState().pinnedSessions).toEqual(["/s/p.jsonl"]);
		expect(useSidebarPrefs.getState().sessionOrder).toEqual({ "/work/a": ["/s/2.jsonl", "/s/1.jsonl"] });
	});

	it("reads before the first change when nothing has hydrated yet", async () => {
		get.mockResolvedValueOnce(stored);
		await useSidebarPrefs.getState().setSessionsArchived(["s1"], true);
		expect(updateSidebar).toHaveBeenCalledWith({ op: "set-sessions-archived", ids: ["s1"], archived: true });
		expect(useSidebarPrefs.getState().archivedSessions).toEqual(["s9", "s1"]);
		expect(useSidebarPrefs.getState().pinnedGroups).toEqual(["/work/pinned"]);
	});
});
