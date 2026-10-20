import type { ReactNode } from "react";
import { SessionRuntimeContext, SessionRuntimeProvider, useTabSessionRuntime } from "../stores/session-runtime-context";
import { ensureTabRuntime } from "../stores/tab-runtime";

/**
 * Provide a tab's current runtime. A session change on the same tab (a drop,
 * `/new`, a resume) replaces the runtime without a tab switch or a status
 * change, so a provider that read the runtime once would keep handing the
 * retired one to everything below it, whose every command then refuses as
 * "the originating session was replaced".
 */
export function TabRuntimeProvider({ tabId, children }: { tabId: string; children: ReactNode }) {
	const runtime = useTabSessionRuntime(tabId) ?? ensureTabRuntime(tabId);
	return <SessionRuntimeProvider runtime={runtime}>{children}</SessionRuntimeProvider>;
}

/**
 * The focused tab's runtime for the whole app surface, none while the first tab list is on its way. One element type
 * whatever the tab: a wrapper that appeared with the first tab remounted the whole app then (a phone's drawer, opened
 * right after the page loaded, closed again; every surface lost its state).
 */
export function FocusedRuntimeProvider({ tabId, children }: { tabId: string | null; children: ReactNode }) {
	const live = useTabSessionRuntime(tabId);
	const runtime = tabId ? (live ?? ensureTabRuntime(tabId)) : null;
	return <SessionRuntimeContext.Provider value={runtime}>{children}</SessionRuntimeContext.Provider>;
}
