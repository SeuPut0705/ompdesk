import { describe, expect, it, vi } from "vitest";
import { type SessionMenuActions, type SessionMenuFacts, sessionMenuItems } from "./session-menu";

const t = (key: string, params?: Record<string, string | number>) =>
	params ? `${key}:${Object.values(params).join(",")}` : key;

const stored: SessionMenuFacts = {
	stored: true,
	hasTab: false,
	busy: false,
	tabFocused: false,
	tabInSplit: false,
	splitShown: false,
	canCloseTab: true,
	chat: false,
	pinned: false,
	archived: false,
	agentHidden: false,
	secretary: false,
	canMoveUp: true,
	canMoveDown: true,
};

const noop = () => {};
const every: SessionMenuActions = {
	openSplit: noop,
	openWindow: noop,
	splitTab: noop,
	unsplit: noop,
	closeTab: noop,
	rename: noop,
	togglePin: noop,
	moveUp: noop,
	moveDown: noop,
	moveToProject: noop,
	toggleArchive: noop,
	toggleAgentHidden: noop,
	reveal: noop,
	saveBundle: noop,
	remove: noop,
};

const build = (facts: Partial<SessionMenuFacts>, actions: SessionMenuActions = every, altHint = true) =>
	sessionMenuItems({ facts: { ...stored, ...facts }, actions, t, altHint, platform: "mac" });
const ids = (facts: Partial<SessionMenuFacts>, actions?: SessionMenuActions) =>
	build(facts, actions).map(item => item.id);

describe("sessionMenuItems", () => {
	it("lists a stored session no tab holds in groups: open, edit, show in folder, delete last", () => {
		const items = build({});
		expect(items.map(item => item.id)).toEqual([
			"session-open-split",
			"session-open-window",
			"session-rename",
			"session-pin",
			"session-move-up",
			"session-move-down",
			"session-move",
			"session-archive",
			"session-agent-hidden",
			"session-reveal",
			"session-delete",
		]);
		// Each group starts with a divider; no item inside a group has one.
		expect(items.filter(item => item.separatorBefore).map(item => item.id)).toEqual([
			"session-open-split",
			"session-rename",
			"session-reveal",
			"session-delete",
		]);
		expect(items.at(-1)?.danger).toBe(true);
	});

	it("has no Open, Open in new tab or Copy path", () => {
		for (const id of ids({}, every)) expect(id).not.toMatch(/^session-(open|open-tab|copy-path)$/);
	});

	it("leaves out an action the list does not support instead of disabling it", () => {
		const host: SessionMenuActions = { ...every, reveal: undefined, toggleAgentHidden: undefined };
		expect(ids({}, host)).toEqual([
			"session-open-split",
			"session-open-window",
			"session-rename",
			"session-pin",
			"session-move-up",
			"session-move-down",
			"session-move",
			"session-archive",
			"session-delete",
		]);
		expect(ids({}, { remove: noop })).toEqual(["session-delete"]);
		expect(ids({}, {})).toEqual([]);
	});

	it("gives a session a tab holds its split and close items, not Open in split view, and one diagnostics item", () => {
		const held = build({ hasTab: true });
		expect(held.map(item => item.id)).toEqual([
			"session-open-window",
			"session-split-right",
			"session-split-bottom",
			"session-close-tab",
			"session-rename",
			"session-pin",
			"session-move-up",
			"session-move-down",
			"session-move",
			"session-archive",
			"session-agent-hidden",
			"session-reveal",
			"session-dump-bundle",
			"session-delete",
		]);
		// A tab's session cannot move to another project or be archived while the tab holds it.
		expect(held.find(item => item.id === "session-move")?.disabled).toBe(true);
		expect(held.find(item => item.id === "session-archive")?.disabled).toBe(true);
	});

	it("has no diagnostics item without a tab, and never a disabled stand-in or an anonymized twin", () => {
		expect(ids({ hasTab: false })).not.toContain("session-dump-bundle");
		expect(ids({ hasTab: true }).filter(id => id.includes("dump"))).toEqual(["session-dump-bundle"]);
	});

	it("saves the anonymized bundle when Option/Alt was held while choosing the diagnostics item", () => {
		const saveBundle = vi.fn();
		const item = build({ hasTab: true }, { saveBundle }).find(entry => entry.id === "session-dump-bundle");
		item?.onSelect({ altKey: false });
		item?.onSelect({ altKey: true });
		item?.onSelect();
		expect(saveBundle.mock.calls).toEqual([[false], [true], [false]]);
	});

	it("names the Alt variant as the item's hint: ⌥ on macOS, Alt on Windows, none on a touch screen", () => {
		const hint = (platform: "mac" | "windows", altHint = true) =>
			sessionMenuItems({
				facts: { ...stored, hasTab: true },
				actions: every,
				t,
				altHint,
				platform,
			}).find(item => item.id === "session-dump-bundle")?.hint;
		expect(hint("mac")).toBe("diagnosticBundle.anonymizeHint:⌥");
		expect(hint("windows")).toBe("diagnosticBundle.anonymizeHint:Alt");
		expect(hint("mac", false)).toBeUndefined();
	});

	it("offers Restore for an archived session no tab holds, Archive otherwise", () => {
		expect(ids({ archived: true })).toContain("session-restore");
		expect(ids({ archived: true })).not.toContain("session-archive");
		expect(ids({ archived: true, hasTab: true })).toContain("session-archive");
		expect(ids({ archived: false })).toContain("session-archive");
	});

	it("keeps pins on top: a move that would cross the pinned edge is disabled, not absent", () => {
		const items = build({ canMoveUp: false, canMoveDown: true });
		expect(items.find(item => item.id === "session-move-up")?.disabled).toBe(true);
		expect(items.find(item => item.id === "session-move-down")?.disabled).toBe(false);
	});

	it("has no Move to project… for a chat", () => {
		expect(ids({ chat: true })).not.toContain("session-move");
	});

	it("disables Close and Delete while the session runs, with the reason", () => {
		const items = build({ hasTab: true, busy: true });
		for (const id of ["session-close-tab", "session-delete"]) {
			const item = items.find(entry => entry.id === id);
			expect(item?.disabled).toBe(true);
			expect(item?.disabledReason).toBe("sidebar.menu.taskRunning");
		}
	});

	it("a row with no file yet (a new tab) has only what a tab can do: no edits, no delete", () => {
		expect(ids({ stored: false, hasTab: true })).toEqual([
			"session-split-right",
			"session-split-bottom",
			"session-close-tab",
			"session-agent-hidden",
			"session-dump-bundle",
		]);
	});

	it("offers Remove split while a split is on screen, and no split items for the focused tab or a pane already in it", () => {
		expect(ids({ hasTab: true, tabFocused: true, splitShown: true })).toEqual(
			expect.arrayContaining(["session-unsplit"]),
		);
		expect(ids({ hasTab: true, tabFocused: true })).not.toContain("session-split-right");
		expect(ids({ hasTab: true, tabInSplit: true, splitShown: true })).not.toContain("session-split-right");
		expect(ids({ hasTab: true, canCloseTab: false })).not.toContain("session-close-tab");
	});

	it("names a saved session the secretary, or lets it go, only where the list supports it", () => {
		const toggleSecretary = vi.fn();
		const withSecretary = { ...every, toggleSecretary };
		const make = build({}, withSecretary).find(item => item.id === "session-secretary");
		expect(make?.label).toBe("sidebar.menu.makeSecretary");
		make?.onSelect?.();
		expect(toggleSecretary).toHaveBeenCalledTimes(1);
		expect(build({ secretary: true }, withSecretary).find(item => item.id === "session-secretary")?.label).toBe(
			"sidebar.menu.stopSecretary",
		);
		// A paired host's rows pass no action; a tab with no file yet has nothing to name.
		expect(ids({})).not.toContain("session-secretary");
		expect(ids({ stored: false, hasTab: true }, withSecretary)).not.toContain("session-secretary");
	});
});
