import { useEffect, useMemo } from "react";
import type { SessionSummary } from "../../shared/session-summary";
import { type SessionRun, sessionRun } from "../lib/session-run";
import { ensureHostSummaries, tabSummary, useHostedSessionsStore } from "../stores/hosted-sessions";
import { useRuntimeTabId } from "../stores/session-runtime-context";
import { type SessionTab, useTabsStore } from "../stores/tabs";

export interface TabRun {
	/** What the computer running the tab's session says of it; undefined until it said. */
	summary: SessionSummary | undefined;
	run: SessionRun;
}

/**
 * What a tab's session is doing, from its summary (`tabSummary`) by the one rule (`sessionRun`): the title bar, the
 * window title, the tray and a split pane's header read this, so none says something the session's sidebar row does
 * not. A tab on a paired host reads that host's summaries, read once for this window.
 */
export function useTabRun(tab: Pick<SessionTab, "id" | "sessionPath" | "device" | "unreadDone"> | undefined): TabRun {
	const device = tab?.device;
	useEffect(() => {
		if (device !== undefined) ensureHostSummaries(device);
	}, [device]);
	const summary = useHostedSessionsStore(state => (tab ? tabSummary(state, tab) : undefined));
	const unreadDone = tab?.unreadDone === true;
	return useMemo(() => ({ summary, run: sessionRun(summary, unreadDone) }), [summary, unreadDone]);
}

/** {@link useTabRun} of the focused session: the pane's tab, else the window's active one. */
export function useFocusedRun(): TabRun {
	const runtimeTabId = useRuntimeTabId();
	const tab = useTabsStore(state => {
		const id = runtimeTabId ?? state.activeTabId;
		return id ? state.tabs.find(entry => entry.id === id) : undefined;
	});
	return useTabRun(tab);
}
