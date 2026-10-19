import type { ComposerStore } from "../stores/composer";
import { sessionRuntimeStore } from "../stores/session-runtime-context";

/**
 * A close main made on its own (`AgentControlViewEvent.auto`: an opened session's work landed) is refused for a tab
 * the person is using: the one on screen, a pane of the split on screen, or one whose composer holds text. Main
 * checks the same facts, but the person may have switched to the tab since.
 */
export function autoCloseHeld(tabId: string, shownTabIds: readonly string[]): boolean {
	if (shownTabIds.includes(tabId)) return true;
	const composer = sessionRuntimeStore<ComposerStore>(tabId, "composer");
	return (composer?.getState().draft.trim() ?? "") !== "";
}
