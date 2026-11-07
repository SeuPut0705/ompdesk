import { describe, expect, it, vi } from "vitest";
import { type ProjectMenuActions, type ProjectMenuFacts, projectMenuItems } from "./project-menu";

const t = (key: string) => key;

const facts: ProjectMenuFacts = { pinned: false, canMoveUp: true, canMoveDown: true, archivable: 2 };
const noop = () => {};
const every: ProjectMenuActions = {
	newAgent: noop,
	newWorktree: noop,
	rename: noop,
	togglePin: noop,
	moveUp: noop,
	moveDown: noop,
	archiveAll: noop,
	remove: noop,
};

const build = (over: Partial<ProjectMenuFacts> = {}, actions: ProjectMenuActions = every) =>
	projectMenuItems({ facts: { ...facts, ...over }, actions, t });

describe("projectMenuItems", () => {
	it("lists new sessions, edits, then one Delete last, each group set apart", () => {
		const items = build();
		expect(items.map(item => item.id)).toEqual([
			"group-new-agent",
			"group-new-worktree",
			"group-rename",
			"group-move-up",
			"group-move-down",
			"group-pin",
			"group-archive-all",
			"group-delete",
		]);
		expect(items.filter(item => item.separatorBefore).map(item => item.id)).toEqual([
			"group-new-agent",
			"group-rename",
			"group-delete",
		]);
		expect(items.at(-1)).toMatchObject({ label: "common.delete", danger: true });
	});

	it("has no separate Remove from sidebar: Delete is the only way a project leaves", () => {
		expect(build().map(item => item.label)).not.toContain("sidebar.menu.removeProject");
		expect(build().filter(item => item.id === "group-delete")).toHaveLength(1);
	});

	it("leaves out an action the list does not support, never a disabled item (a host's project)", () => {
		const items = projectMenuItems({
			facts: { ...facts, pinned: false, archivable: 0 },
			actions: { moveUp: noop, moveDown: noop, remove: noop },
			t,
		});
		expect(items.map(item => item.id)).toEqual(["group-move-up", "group-move-down", "group-delete"]);
		expect(items.filter(item => item.separatorBefore).map(item => item.id)).toEqual([
			"group-move-up",
			"group-delete",
		]);
	});

	it("is just Delete when nothing else is supported", () => {
		expect(projectMenuItems({ facts, actions: { remove: noop }, t }).map(item => item.id)).toEqual(["group-delete"]);
	});

	it("disables a move that has nowhere to go and Archive all with nothing to archive", () => {
		const items = build({ canMoveUp: false, canMoveDown: false, archivable: 0 });
		const byId = (id: string) => items.find(item => item.id === id);
		expect(byId("group-move-up")?.disabled).toBe(true);
		expect(byId("group-move-down")?.disabled).toBe(true);
		expect(byId("group-archive-all")?.disabled).toBe(true);
		expect(byId("group-delete")?.disabled).toBeUndefined();
	});

	it("names Unpin for a pinned project and runs each action it is given", () => {
		const remove = vi.fn();
		const items = projectMenuItems({ facts: { ...facts, pinned: true }, actions: { ...every, remove }, t });
		expect(items.find(item => item.id === "group-pin")?.label).toBe("sidebar.menu.unpin");
		items.find(item => item.id === "group-delete")?.onSelect();
		expect(remove).toHaveBeenCalledOnce();
	});
});
