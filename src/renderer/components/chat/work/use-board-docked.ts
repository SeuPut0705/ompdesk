import { useLayoutEffect, useState } from "react";
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
		const read = () => setDocked(pane.hasAttribute("data-work-board"));
		read();
		const observer = new MutationObserver(read);
		observer.observe(pane, { attributes: true, attributeFilter: ["data-work-board"] });
		return () => observer.disconnect();
	}, [tabId]);
	return docked;
}
