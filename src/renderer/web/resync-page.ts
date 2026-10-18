/**
 * One in-place resync pass of the web page (resync.ts `PageResync` runs it after a reconnect that missed events):
 * read again, from the host, everything the missed pushes would have changed — what a page load would have read at
 * start — without touching the composer, the scroll position or an open sheet.
 *
 * - the tab list, as the whole truth (`reconcileTabs({dropUnlisted})`: a restarted host gave its tabs new ids);
 * - every visible tab's session: state, transcript tail, queue, subagents, goal and settings (`hydrateTabSession`
 *   merges into what is shown and runs while a reply streams); a background tab reads its own when shown;
 * - the asks and approvals main still holds (`settleTabExtensionUiRequests`: missed ones appear, answered ones go);
 * - the paired-host snapshot and the shown session lists.
 *
 * Imported dynamically by web-boot.ts once the app has loaded (it reads the stores).
 */
import { hydrateTabSession } from "../hooks/session-hydration";
import { loadRemoteState } from "../stores/remote";
import { refreshHeldSessionLists } from "../stores/session-list";
import { settleTabExtensionUiRequests, useTabsStore, visibleTabIds } from "../stores/tabs";

/** False when the host could not list the tabs (the link dropped again): the pass is tried again. */
export async function resyncPage(): Promise<boolean> {
	if (!(await useTabsStore.getState().reconcileTabs({ dropUnlisted: true }))) return false;
	const state = useTabsStore.getState();
	const sessions = visibleTabIds(state).flatMap(tabId => {
		const status = state.tabs.find(tab => tab.id === tabId)?.status;
		return status === "ready" || status === "running" ? [hydrateTabSession(tabId)] : [];
	});
	const [open] = await Promise.all([window.omp.ui.openRequests(), loadRemoteState(), ...sessions]);
	settleTabExtensionUiRequests(open);
	refreshHeldSessionLists();
	return true;
}
