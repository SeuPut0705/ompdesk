/**
 * The one session-row menu, for this computer's list (Sidebar.tsx) and a paired host's (SidebarDevices.tsx): the
 * list gathers the row's facts and the actions it supports, and this decides what the menu holds and in what order.
 * An action the list does not support is absent, never a disabled item (a host has no "Show in folder"); an item the
 * list supports but this row cannot take right now is disabled with its reason (Move to project… while a tab holds
 * the session).
 *
 * Groups, each set apart: open and view (split, new window, the open tab's split and close) · edit (rename, pin,
 * move up and down, move to project, archive, hide from agents, make secretary) · show in folder · diagnostics (one item; Option/Alt
 * while choosing it saves the anonymized bundle) · delete, last. Clicking a row already opens it, so the menu has no
 * "Open" or "Open in new tab".
 */
import {
	Archive,
	ArchiveRestore,
	ArrowDown,
	ArrowUp,
	BriefcaseBusiness,
	Columns2,
	ExternalLink,
	Eye,
	EyeOff,
	FileArchive,
	FolderInput,
	FolderSearch,
	PanelRightClose,
	Pencil,
	Pin,
	PinOff,
	Rows2,
	Trash2,
	X,
} from "lucide-react";
import { type KeymapPlatform, PLATFORM } from "../../../lib/keymap";
import type { ContextMenuItem, MenuSelectModifiers } from "../../common/ContextMenu";

/** What is true of the row; every list answers these the same way. */
export interface SessionMenuFacts {
	/** The session has a file on its computer (not a tab's row before its first write): its edits and delete apply. */
	stored: boolean;
	/** A tab of this window holds the session. */
	hasTab: boolean;
	/** That tab's turn runs, or the session waits on the person: no close and no delete. */
	busy: boolean;
	/** That tab is the focused one. */
	tabFocused: boolean;
	/** That tab is a pane of the split on screen. */
	tabInSplit: boolean;
	/** A split is on screen. */
	splitShown: boolean;
	/** Closing the tab leaves another one in the window. */
	canCloseTab: boolean;
	/** A chat: it lives in no project, so it cannot move to one. */
	chat: boolean;
	pinned: boolean;
	archived: boolean;
	agentHidden: boolean;
	/** The session is the owner's secretary (agent-control/secretary.ts). */
	secretary: boolean;
	canMoveUp: boolean;
	canMoveDown: boolean;
}

/** What the list can do with a session; an absent action leaves its item out. */
export interface SessionMenuActions {
	/** A stored session no tab holds, opened in a new tab beside the focused one and split in. */
	openSplit?: () => void;
	openWindow?: () => void;
	/** The open tab, split in beside the focused one. */
	splitTab?: (placement: "right" | "bottom") => void;
	unsplit?: () => void;
	closeTab?: () => void;
	rename?: () => void;
	/** Pins it, or lets it go when pinned. */
	togglePin?: () => void;
	moveUp?: () => void;
	moveDown?: () => void;
	/** Opens the list of projects it can go to. */
	moveToProject?: () => void;
	/** Archives it, or restores it when archived. */
	toggleArchive?: () => void;
	toggleAgentHidden?: () => void;
	/** Names it the secretary, or lets it go when it is; this computer's sessions only. */
	toggleSecretary?: () => void;
	reveal?: () => void;
	/** Saves the open tab's diagnostic bundle; `anonymized` when Option/Alt was held. */
	saveBundle?: (anonymized: boolean) => void;
	remove?: () => void;
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface SessionMenuInput {
	facts: SessionMenuFacts;
	actions: SessionMenuActions;
	t: Translate;
	/** Say on the diagnostics item that Option/Alt anonymizes it: false on a touch screen, which has no such key. */
	altHint: boolean;
	/** The platform whose Alt key the hint names. */
	platform?: KeymapPlatform;
}

/** The item's hint: "⌥ anonymized" on macOS, "Alt anonymized" on Windows. */
function anonymizeHint(t: Translate, platform: KeymapPlatform): string {
	return t("diagnosticBundle.anonymizeHint", { key: platform === "mac" ? "⌥" : "Alt" });
}

export function sessionMenuItems({
	facts,
	actions,
	t,
	altHint,
	platform = PLATFORM,
}: SessionMenuInput): ContextMenuItem[] {
	const view: ContextMenuItem[] = [];
	// A session an open tab holds splits through the tab's own items below instead.
	if (actions.openSplit && facts.stored && !facts.hasTab)
		view.push({
			id: "session-open-split",
			label: t("sidebar.menu.openSplit"),
			icon: Columns2,
			onSelect: actions.openSplit,
		});
	if (actions.openWindow && facts.stored)
		view.push({
			id: "session-open-window",
			label: t("sidebar.openInNewWindow"),
			icon: ExternalLink,
			onSelect: actions.openWindow,
		});
	const { splitTab, unsplit, closeTab } = actions;
	if (facts.hasTab) {
		if (splitTab && !facts.tabFocused && !facts.tabInSplit)
			for (const placement of ["right", "bottom"] as const)
				view.push({
					id: `session-split-${placement}`,
					label: t(placement === "right" ? "tabs.menu.splitRight" : "tabs.menu.splitBottom"),
					icon: placement === "right" ? Columns2 : Rows2,
					onSelect: () => splitTab(placement),
				});
		if (unsplit && facts.splitShown)
			view.push({
				id: "session-unsplit",
				label: t("tabs.menu.removeSplit"),
				icon: PanelRightClose,
				onSelect: unsplit,
			});
		if (closeTab && facts.canCloseTab)
			view.push({
				id: "session-close-tab",
				label: t("sidebar.menu.closeSession"),
				icon: X,
				disabled: facts.busy,
				disabledReason: t("sidebar.menu.taskRunning"),
				onSelect: closeTab,
			});
	}

	const edit: ContextMenuItem[] = [];
	if (facts.stored) {
		if (actions.rename)
			edit.push({ id: "session-rename", label: t("sidebar.rename"), icon: Pencil, onSelect: actions.rename });
		if (actions.togglePin)
			edit.push({
				id: "session-pin",
				label: facts.pinned ? t("sidebar.menu.unpin") : t("sidebar.menu.pin"),
				icon: facts.pinned ? PinOff : Pin,
				onSelect: actions.togglePin,
			});
		if (actions.moveUp)
			edit.push({
				id: "session-move-up",
				label: t("sidebar.menu.moveUp"),
				icon: ArrowUp,
				disabled: !facts.canMoveUp,
				onSelect: actions.moveUp,
			});
		if (actions.moveDown)
			edit.push({
				id: "session-move-down",
				label: t("sidebar.menu.moveDown"),
				icon: ArrowDown,
				disabled: !facts.canMoveDown,
				onSelect: actions.moveDown,
			});
		if (actions.moveToProject && !facts.chat)
			edit.push({
				id: "session-move",
				label: t("sidebar.menu.moveToProject"),
				icon: FolderInput,
				disabled: facts.hasTab,
				disabledReason: t("sidebar.moveOpenTab"),
				onSelect: actions.moveToProject,
			});
		if (actions.toggleArchive)
			edit.push(
				facts.archived && !facts.hasTab
					? {
							id: "session-restore",
							label: t("sidebar.menu.restore"),
							icon: ArchiveRestore,
							onSelect: actions.toggleArchive,
						}
					: {
							id: "session-archive",
							label: t("sidebar.menu.archive"),
							icon: Archive,
							disabled: facts.hasTab,
							disabledReason: t("sidebar.archiveOpenTab"),
							onSelect: actions.toggleArchive,
						},
			);
	}
	if (actions.toggleAgentHidden)
		edit.push({
			id: "session-agent-hidden",
			label: facts.agentHidden ? t("sidebar.menu.showToAgents") : t("sidebar.menu.hideFromAgents"),
			icon: facts.agentHidden ? Eye : EyeOff,
			onSelect: actions.toggleAgentHidden,
		});
	if (actions.toggleSecretary && facts.stored)
		edit.push({
			id: "session-secretary",
			label: facts.secretary ? t("sidebar.menu.stopSecretary") : t("sidebar.menu.makeSecretary"),
			icon: BriefcaseBusiness,
			onSelect: actions.toggleSecretary,
		});

	const other: ContextMenuItem[] =
		facts.stored && actions.reveal
			? [{ id: "session-reveal", label: t("sidebar.menu.reveal"), icon: FolderSearch, onSelect: actions.reveal }]
			: [];

	// Stock's `/dump` runs in the tab's own omp: a session no tab holds has nothing to dump, so it has no item.
	const { saveBundle } = actions;
	const diagnostics: ContextMenuItem[] =
		saveBundle && facts.hasTab
			? [
					{
						id: "session-dump-bundle",
						label: t("diagnosticBundle.save"),
						icon: FileArchive,
						...(altHint ? { hint: anonymizeHint(t, platform) } : {}),
						onSelect: (modifiers?: MenuSelectModifiers) => saveBundle(modifiers?.altKey === true),
					},
				]
			: [];

	const remove: ContextMenuItem[] =
		facts.stored && actions.remove
			? [
					{
						id: "session-delete",
						label: t("common.delete"),
						icon: Trash2,
						danger: true,
						disabled: facts.busy,
						disabledReason: t("sidebar.menu.taskRunning"),
						onSelect: actions.remove,
					},
				]
			: [];

	return [view, edit, other, diagnostics, remove]
		.filter(group => group.length > 0)
		.flatMap(group => group.map((item, index) => (index === 0 ? { ...item, separatorBefore: true } : item)));
}
