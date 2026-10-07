/**
 * The close-a-tab rules, shared by ⌘W, File → Close Tab and the sidebar menu.
 *
 * A tab whose run is live dies with its close, so the first ⌘W only arms it
 * (a toast says to press again); a worktree-bound tab detours to the cleanup
 * prompt (plan/20) instead of orphaning the checkout; and at the single-tab
 * floor there is no tab left to close, so ⌘W closes the window.
 */

import { useSessionStore } from "../stores/session";
import { type SessionTab, useTabsStore } from "../stores/tabs";
import { toast } from "../stores/toast";
import { useUiStore } from "../stores/ui";
import { translate } from "./i18n";
import { tabSignalPresentation } from "./tab-signal";

/** Foreground knowledge the pool's status pushes lag behind: the active tab's
 *  own stream, which only the renderer sees the instant it starts. */
export interface LiveTabRuntime {
	activeTabId: string | null;
	streaming: boolean;
	compacting: boolean;
}

/** True when closing this tab destroys work, so the close needs a confirmation. */
export function tabNeedsCloseConfirm(tab: SessionTab, live: LiveTabRuntime): boolean {
	const activeRuntime = tab.id === live.activeTabId && (live.streaming || live.compacting);
	return tabSignalPresentation(tab, activeRuntime).running || tab.status === "starting";
}

/** What a close request ended up doing. `"window"` = the last tab, so ⌘W closed
 *  its window instead. */
export type TabCloseOutcome = "closed" | "worktree-prompt" | "armed" | "window" | "nothing";

/** Execute a close the user already committed to (chip ✓, or ⌘W on an armed tab). */
export function performTabClose(tab: SessionTab): TabCloseOutcome {
	const ui = useUiStore.getState();
	ui.cancelCloseTab();
	if (tab.worktree) {
		ui.openWorktreeClosePrompt(tab.id);
		return "worktree-prompt";
	}
	void useTabsStore.getState().closeTab(tab.id);
	return "closed";
}

/** ⌘W / File → Close Tab: close the active tab under the shared rules. */
export function closeActiveTab(): TabCloseOutcome {
	const { tabs, activeTabId } = useTabsStore.getState();
	const session = useSessionStore.getState();
	const target = tabs.find(tab => tab.id === activeTabId);
	if (!target) return "nothing";
	if (tabs.length <= 1) {
		window.close();
		return "window";
	}
	const live: LiveTabRuntime = {
		activeTabId,
		streaming: session.isStreaming,
		compacting: session.isCompacting,
	};
	const ui = useUiStore.getState();
	if (tabNeedsCloseConfirm(target, live) && ui.armedCloseTab?.tabId !== target.id) {
		ui.armCloseTab(target.id);
		toast({ variant: "warning", message: translate("tabs.confirmClose") });
		return "armed";
	}
	return performTabClose(target);
}
