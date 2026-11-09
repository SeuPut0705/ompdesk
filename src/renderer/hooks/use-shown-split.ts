import type { SplitNode } from "../../shared/split-layout";
import { useTabsStore } from "../stores/tabs";
import { isDrawerMode } from "./shell-queries";
import { useShellMode } from "./use-shell-mode";

/**
 * The split the window shows: the tab list's split, except where the shell is a drawer (a phone, a narrow window),
 * which shows the focused tab alone and keeps the split for when it widens again. `SplitWorkspace` draws it and the
 * sidebar marks its panes selected (`row-selection.ts`), so a pane that is not on screen never reads as selected.
 */
export function useShownSplit(): SplitNode | null {
	const split = useTabsStore(state => state.split);
	const drawer = isDrawerMode(useShellMode());
	return drawer ? null : split;
}
