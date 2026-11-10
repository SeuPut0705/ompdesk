/**
 * The one project-header menu, for this computer's list (Sidebar.tsx) and a paired host's (SidebarDevices.tsx, the
 * phone's page draws both): the list gathers the project's facts and the actions it supports, and this decides what
 * the menu holds and in what order. An action the list does not support is absent, never a disabled item (a host
 * has no rename or pin of its own).
 *
 * Groups, each set apart: new sessions · edit (rename, pin, move up and down, archive all) · Delete, last. There is
 * ONE Delete: it takes the project out of its computer's project list, and its confirm (`ProjectDeleteDialog`)
 * offers to delete the project's saved sessions with it. There is no separate "Remove from sidebar".
 */
import { Archive, ArrowDown, ArrowUp, GitBranchPlus, Pencil, Pin, PinOff, SquareTerminal, Trash2 } from "lucide-react";
import type { ContextMenuItem } from "../../common";

/** What is true of the project; every list answers these the same way. */
export interface ProjectMenuFacts {
	pinned: boolean;
	canMoveUp: boolean;
	canMoveDown: boolean;
	/** Sessions "Archive all" can take (none held by a tab): zero disables the item. */
	archivable: number;
}

/** What the list can do with a project; an absent action leaves its item out. */
export interface ProjectMenuActions {
	newAgent?: () => void;
	newWorktree?: () => void;
	rename?: () => void;
	togglePin?: () => void;
	moveUp?: () => void;
	moveDown?: () => void;
	archiveAll?: () => void;
	/** Opens the delete confirm. */
	remove: () => void;
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface ProjectMenuInput {
	facts: ProjectMenuFacts;
	actions: ProjectMenuActions;
	t: Translate;
}

export function projectMenuItems({ facts, actions, t }: ProjectMenuInput): ContextMenuItem[] {
	const create: ContextMenuItem[] = [];
	if (actions.newAgent)
		create.push({
			id: "group-new-agent",
			label: t("sidebar.menu.newAgentHere"),
			icon: SquareTerminal,
			onSelect: actions.newAgent,
		});
	if (actions.newWorktree)
		create.push({
			id: "group-new-worktree",
			label: t("sidebar.menu.newWorktreeHere"),
			icon: GitBranchPlus,
			onSelect: actions.newWorktree,
		});

	const edit: ContextMenuItem[] = [];
	if (actions.rename)
		edit.push({ id: "group-rename", label: t("sidebar.menu.rename"), icon: Pencil, onSelect: actions.rename });
	if (actions.moveUp)
		edit.push({
			id: "group-move-up",
			label: t("sidebar.menu.moveUp"),
			icon: ArrowUp,
			disabled: !facts.canMoveUp,
			onSelect: actions.moveUp,
		});
	if (actions.moveDown)
		edit.push({
			id: "group-move-down",
			label: t("sidebar.menu.moveDown"),
			icon: ArrowDown,
			disabled: !facts.canMoveDown,
			onSelect: actions.moveDown,
		});
	if (actions.togglePin)
		edit.push({
			id: "group-pin",
			label: facts.pinned ? t("sidebar.menu.unpin") : t("sidebar.menu.pin"),
			icon: facts.pinned ? PinOff : Pin,
			onSelect: actions.togglePin,
		});
	if (actions.archiveAll)
		edit.push({
			id: "group-archive-all",
			label: t("sidebar.menu.archiveAll"),
			icon: Archive,
			disabled: facts.archivable === 0,
			disabledReason: t("sidebar.archiveAllNone"),
			onSelect: actions.archiveAll,
		});

	const remove: ContextMenuItem[] = [
		{ id: "group-delete", label: t("common.delete"), icon: Trash2, danger: true, onSelect: actions.remove },
	];

	return [create, edit, remove]
		.filter(group => group.length > 0)
		.flatMap(group => group.map((item, index) => (index === 0 ? { ...item, separatorBefore: true } : item)));
}
