/**
 * A clicked notification about a tab (finished, failed, waiting for input) brings that tab forward; main already
 * raised the window. On a phone the click can arrive before the page lists that tab: a cold start (the service
 * worker opens `/#/open?tab=<id>`; the strip holds only the last run's ghosts, which `switchTab` ignores) or a tab
 * main has just added (its list reaches the page a moment later). So it waits for the tab to be listed. A later
 * click, the person picking another tab meanwhile, or `NOTIFIED_TAB_WAIT_MS` (the tab was closed) drops it.
 */
import type { SessionTab } from "../stores/tabs";
import { useTabsStore } from "../stores/tabs";
import { useUiStore } from "../stores/ui";

export const NOTIFIED_TAB_WAIT_MS = 30_000;

let cancelPending: (() => void) | null = null;

const listed = (tabs: readonly SessionTab[], tabId: string) => tabs.some(tab => tab.id === tabId && tab.ghost !== true);

export function openNotifiedTab(tabId: string, waitMs = NOTIFIED_TAB_WAIT_MS): void {
	cancelPending?.();
	cancelPending = null;
	const open = () => {
		useUiStore.getState().closeDestination();
		void useTabsStore.getState().switchTab(tabId);
	};
	const before = useTabsStore.getState();
	if (listed(before.tabs, tabId)) {
		open();
		return;
	}
	const stop = () => {
		unsubscribe();
		clearTimeout(timer);
		if (cancelPending === stop) cancelPending = null;
	};
	const unsubscribe = useTabsStore.subscribe(state => {
		if (listed(state.tabs, tabId)) {
			stop();
			open();
			return;
		}
		// The person picked a tab themselves (not a ghost's adoption, which keeps the selection's place).
		const picked = state.tabs.find(tab => tab.id === state.activeTabId);
		if (
			state.activeTabId !== before.activeTabId &&
			picked &&
			picked.ghost !== true &&
			before.tabs.some(tab => tab.ghost !== true)
		)
			stop();
	});
	const timer = setTimeout(stop, waitMs);
	cancelPending = stop;
}
