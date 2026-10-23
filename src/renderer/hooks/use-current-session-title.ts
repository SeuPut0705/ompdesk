import { useT } from "../lib/i18n";
import { sessionDisplayTitle, shownSessionName } from "../lib/session-title";
import { useSessionStore } from "../stores/session";
import { useSessionList } from "./use-session-list";

/**
 * The attached session's name as the sidebar shows it: the name the session
 * holds, else its stored title, else its first prompt, else a placeholder.
 * The title bar and Insights read this, so one session never has three names.
 */
export function useCurrentSessionTitle(): string {
	const t = useT();
	const sessionId = useSessionStore(s => s.sessionId);
	const sessionName = useSessionStore(s => s.sessionName);
	// Global, like the sidebar: the row is found by id whichever project the tab is in.
	const { sessions } = useSessionList("global");
	const current = sessions.find(session => session.id === sessionId);
	const name = sessionName?.trim();
	if (name) return shownSessionName(name);
	return current ? sessionDisplayTitle(current, t("sidebar.untitled")) : t("sidebar.newSession");
}
