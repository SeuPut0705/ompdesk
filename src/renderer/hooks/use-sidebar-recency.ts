import { useEffect, useRef } from "react";
import { useSessionStore } from "../stores/session";
import { useSidebarPrefs } from "../stores/sidebar-prefs";
import { useTabsStore } from "../stores/tabs";

/** Persist the workspace/session most recently attached by the user. */
export function useSidebarRecency(): void {
	const tabs = useTabsStore(state => state.tabs);
	const activeTabId = useTabsStore(state => state.activeTabId);
	const sessionCwd = useSessionStore(state => state.cwd);
	const sessionFile = useSessionStore(state => state.sessionFile);
	const hydrated = useSidebarPrefs(state => state.hydrated);
	const touchWorkspace = useSidebarPrefs(state => state.touchWorkspace);
	const touchSession = useSidebarPrefs(state => state.touchSession);
	const lastWorkspace = useRef<string | null>(null);
	const lastSession = useRef<string | null>(null);

	useEffect(() => {
		void useSidebarPrefs.getState().hydrate();
	}, []);

	const activeTab = tabs.find(tab => tab.id === activeTabId);
	const kind = activeTab?.kind ?? "agent";
	const cwd = activeTab?.cwd || sessionCwd;

	useEffect(() => {
		if (!hydrated) return;

		const workspace = kind === "agent" && cwd ? cwd : null;
		if (sessionFile && lastSession.current !== sessionFile) {
			lastSession.current = sessionFile;
			lastWorkspace.current = workspace;
			touchSession(sessionFile, workspace ?? undefined);
			return;
		}
		if (!sessionFile) lastSession.current = null;

		if (lastWorkspace.current === workspace) return;
		lastWorkspace.current = workspace;
		if (workspace) touchWorkspace(workspace);
	}, [cwd, hydrated, kind, sessionFile, touchSession, touchWorkspace]);
}
