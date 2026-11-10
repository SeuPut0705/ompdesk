import { useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useTabsStore } from "../../../stores/tabs";

/**
 * Whether this tab's pane shows the docked work board: the board marks its pane `data-work-board` while it docks
 * beside the transcript (WorkBoard.tsx), never in the strip, a split too narrow or a phone. A surface that repeats
 * what the docked board lists (the transcript's children at work, the Mode tab's run controls) gives way to it, and
 * comes back the moment the board leaves for the strip. Read from the pane, because the board's form is measured
 * there; a popover portalled out of the pane finds it by its tab.
 */
export function useBoardDocked(): boolean {
	const runtimeTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	const tabId = runtimeTabId ?? activeTabId;
	const [docked, setDocked] = useState(false);
	useLayoutEffect(() => {
		const pane = tabId
			? [...document.querySelectorAll<HTMLElement>(".omp-session-pane")].find(
					element => element.getAttribute("data-tab-id") === tabId,
				)
			: undefined;
		if (!pane || typeof MutationObserver === "undefined") {
			setDocked(false);
			return;
		}
		setDocked(pane.hasAttribute("data-work-board"));
		// The board marks the pane in its own layout effect, which may run after this one in the same commit (both
		// mount with the tab), or later when it docks mid-turn. The observer's microtask runs before the frame is
		// painted and a render scheduled from it may not: flushed here, the lines never show for a frame beside the
		// board that lists them.
		const observer = new MutationObserver(() => flushSync(() => setDocked(pane.hasAttribute("data-work-board"))));
		observer.observe(pane, { attributes: true, attributeFilter: ["data-work-board"] });
		return () => observer.disconnect();
	}, [tabId]);
	return docked;
}
