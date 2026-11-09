import { describe, expect, it } from "vitest";
import type { RuntimeLogReport } from "./runtime-log-core";
import { type SidebarPrefsStorage, updateSidebarPrefs } from "./sidebar-prefs";

function rig(initial?: unknown) {
	const data = new Map<string, unknown>(initial === undefined ? [] : [["sidebar", structuredClone(initial)]]);
	const writes: unknown[] = [];
	const logged: RuntimeLogReport[] = [];
	const storage: SidebarPrefsStorage = {
		get: key => data.get(key),
		set: (key, value) => {
			writes.push(value);
			data.set(key, structuredClone(value));
		},
	};
	return {
		writes,
		logged,
		stored: () => data.get("sidebar") as Record<string, unknown>,
		send: (change: unknown, from: "window" | "web" = "window") =>
			updateSidebarPrefs(storage, change, from, report => logged.push(report)),
	};
}

describe("updateSidebarPrefs", () => {
	it("applies a change to what is stored now and keeps every other field", () => {
		const r = rig({
			pinnedGroups: ["/work/a"],
			sessionOrder: { "/work/a": ["/s/1", "/s/2"] },
			agentHidden: ["/s/secret"],
			groupAliases: { "/work/a": "Alpha" },
		});

		r.send({ op: "set-session-pinned", path: "/s/1", pinned: true });
		r.send({ op: "set-session-order", list: "/work/b", order: ["/s/9", "/s/8"] });

		expect(r.stored()).toMatchObject({
			pinnedGroups: ["/work/a"],
			pinnedSessions: ["/s/1"],
			sessionOrder: { "/work/a": ["/s/1", "/s/2"], "/work/b": ["/s/9", "/s/8"] },
			agentHidden: ["/s/secret"],
			groupAliases: { "/work/a": "Alpha" },
			railPins: ["usage"],
		});
	});

	it("writes a stored blob that still names a retired key without it", () => {
		const r = rig({ pinnedGroups: ["/work/a"], grouping: "recent" });
		r.send({ op: "set-group-pinned", cwd: "/work/b", pinned: true });
		expect(r.stored()).toMatchObject({ pinnedGroups: ["/work/a", "/work/b"] });
		expect(r.stored()).not.toHaveProperty("grouping");
	});

	it("writes and logs nothing for a change that changes nothing", () => {
		const r = rig({ pinnedSessions: ["/s/1"], archivedSessions: ["s1"] });
		r.send({ op: "set-session-pinned", path: "/s/1", pinned: true });
		r.send({ op: "set-sessions-archived", ids: ["s1"], archived: true });
		r.send({ op: "set-sessions-archived", ids: ["s2"], archived: false });
		r.send({ op: "set-group-alias", cwd: "/work/a", alias: "  " });
		expect(r.writes).toEqual([]);
		expect(r.logged).toEqual([]);
	});

	it("refuses what is not a change and leaves the blob alone", () => {
		const r = rig({ pinnedGroups: ["/work/a"] });
		for (const payload of [
			undefined,
			"pinnedGroups",
			{ op: "set-everything", blob: {} },
			{ op: "set-group-pinned", cwd: "", pinned: true },
			{ op: "set-group-pinned", cwd: "/work/a", pinned: "yes" },
			{ op: "set-rail-pin", pin: "nope", pinned: true },
			{ op: "set-session-order", list: "/work/a", order: [1, 2] },
			{ pinnedGroups: [], sessionOrder: {} },
		]) {
			expect(() => r.send(payload), JSON.stringify(payload)).toThrow(/invalid_preference_key/);
		}
		expect(r.writes).toEqual([]);
	});

	it("logs one info line for each change that moves an order, a pin or the archive, and none for the workspace clock", () => {
		const r = rig();
		r.send({ op: "set-session-order", list: "/work/a", order: ["/s/1", "/s/2", "/s/3"] });
		r.send({ op: "set-group-order", order: ["/work/b", "/work/a"] }, "web");
		r.send({ op: "set-sessions-archived", ids: ["s1", "s2"], archived: true });
		r.send({ op: "set-session-pinned", path: "/s/1", pinned: true });
		r.send({ op: "set-group-pinned", cwd: "/work/a", pinned: true });
		r.send({ op: "touch-workspace", cwd: "/work/a" });
		r.send({ op: "set-group-alias", cwd: "/work/a", alias: "Alpha" });

		expect(r.logged).toEqual([
			{
				source: "sidebar",
				message: "set-session-order",
				details: { level: "info", list: "/work/a", count: 3, from: "window" },
			},
			{ source: "sidebar", message: "set-group-order", details: { level: "info", count: 2, from: "web" } },
			{
				source: "sidebar",
				message: "set-sessions-archived",
				details: { level: "info", count: 2, on: true, from: "window" },
			},
			{
				source: "sidebar",
				message: "set-session-pinned",
				details: { level: "info", count: 1, on: true, from: "window" },
			},
			{
				source: "sidebar",
				message: "set-group-pinned",
				details: { level: "info", count: 1, on: true, from: "window" },
			},
		]);
		expect(JSON.stringify(r.logged)).not.toContain("/s/1");
	});
});
