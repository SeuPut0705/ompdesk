/**
 * What an agent's sidebar arrangement does in the window: the sidebar prefs store runs it as the project's and the
 * session's menus do, a pin is set rather than toggled, and the agent-hidden list is never touched.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSidebarPrefs } from "../stores/sidebar-prefs";
import { applySidebarArrange } from "./agent-app";

const get = vi.fn(async (_key: string) => null as unknown);
const set = vi.fn(async (_key: string, _value: unknown) => {});
const list = vi.fn(async (_scope: string) => [] as { path: string; id: string }[]);
(globalThis as Record<string, unknown>).window = { omp: { prefs: { get, set }, sessions: { list } } };

afterEach(() => {
	get.mockReset();
	set.mockReset();
	list.mockReset();
	useSidebarPrefs.getState().reset();
});

describe("applySidebarArrange", () => {
	it("sets a project pin once, however often it is asked", async () => {
		useSidebarPrefs.setState({ hydrated: true });
		await applySidebarArrange({ op: "pin-project", path: "/work/a", pinned: true });
		await applySidebarArrange({ op: "pin-project", path: "/work/a", pinned: true });
		expect(useSidebarPrefs.getState().pinnedGroups).toEqual(["/work/a"]);
		await applySidebarArrange({ op: "pin-project", path: "/work/a", pinned: false });
		await applySidebarArrange({ op: "pin-project", path: "/work/a", pinned: false });
		expect(useSidebarPrefs.getState().pinnedGroups).toEqual([]);
		expect(set).toHaveBeenCalledTimes(2);
	});

	it("pins a session, names and orders projects, keeping the hosts' order entries and agent-hidden list", async () => {
		useSidebarPrefs.setState({
			hydrated: true,
			groupOrder: ["/work/old", "host\n/h/app"],
			agentHidden: ["/s/secret.jsonl"],
		});
		await applySidebarArrange({ op: "pin-session", sessionPath: "/s/one.jsonl", pinned: true });
		await applySidebarArrange({ op: "rename-project", path: "/work/a", name: "Frontend" });
		await applySidebarArrange({ op: "order-projects", paths: ["/work/b", "/work/a"] });
		const state = useSidebarPrefs.getState();
		expect(state.pinnedSessions).toEqual(["/s/one.jsonl"]);
		expect(state.groupAliases).toEqual({ "/work/a": "Frontend" });
		expect(state.groupOrder).toEqual(["/work/b", "/work/a", "host\n/h/app"]);
		expect(state.agentHidden).toEqual(["/s/secret.jsonl"]);
		expect(set).toHaveBeenLastCalledWith(
			"sidebar",
			expect.objectContaining({
				groupOrder: ["/work/b", "/work/a", "host\n/h/app"],
				agentHidden: ["/s/secret.jsonl"],
			}),
		);

		await applySidebarArrange({ op: "rename-project", path: "/work/a", name: null });
		expect(useSidebarPrefs.getState().groupAliases).toEqual({});
	});

	it("archives and restores sessions by the ids the session list holds for their paths", async () => {
		useSidebarPrefs.setState({ hydrated: true });
		list.mockResolvedValue([
			{ path: "/s/one.jsonl", id: "one" },
			{ path: "/s/two.jsonl", id: "two" },
		]);
		await applySidebarArrange({
			op: "archive-sessions",
			sessionPaths: ["/s/one.jsonl", "/s/gone.jsonl"],
			archived: true,
		});
		expect(useSidebarPrefs.getState().archivedSessions).toEqual(["one"]);
		await applySidebarArrange({ op: "archive-sessions", sessionPaths: ["/s/one.jsonl"], archived: false });
		expect(useSidebarPrefs.getState().archivedSessions).toEqual([]);
	});
});
