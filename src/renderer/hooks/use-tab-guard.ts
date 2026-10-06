import { useCallback } from "react";
import { type SessionStore, useSessionStore } from "../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../stores/session-runtime-context";
import { useTabsStore } from "../stores/tabs";

/**
 * Guards await-then-write dock actions against tab switches AND in-place
 * session replacements: capture the origin AT ACTION START (not at render —
 * a re-render during the await must not move the origin), verify before
 * settling. Without this, a response resolving after the user switched
 * tabs/sessions mutates or rolls back whichever session is foreground.
 */
export interface TabOrigin {
	tabId: string;
	sessionId: string | null;
}

export function useTabGuard(): {
	capture: () => TabOrigin | null;
	isActive: (origin: TabOrigin | null) => boolean;
} {
	const runtimeTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	const capture = useCallback((): TabOrigin | null => {
		const tabId = runtimeTabId ?? activeTabId;
		if (!tabId) return null;
		return {
			tabId,
			sessionId:
				sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().sessionId ??
				useSessionStore.getState().sessionId,
		};
	}, [runtimeTabId, activeTabId]);
	const isActive = useCallback((origin: TabOrigin | null): boolean => {
		if (!origin) return false;
		const runtime = sessionRuntimeStore<SessionStore>(origin.tabId, "session");
		return (runtime?.getState().sessionId ?? useSessionStore.getState().sessionId) === origin.sessionId;
	}, []);
	return { capture, isActive };
}
