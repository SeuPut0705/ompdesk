import { useT } from "../lib/i18n";
import { sessionDisplayParts, sessionTitleParts, type TitleParts } from "../lib/session-title";
import { useSessionStore } from "../stores/session";
import { useSessionList } from "./use-session-list";

/**
 * The attached session's name as the sidebar shows it: the name the session
 * holds, else its stored title, else its first prompt, else a placeholder. A
 * name the person set comes with the automatic title beside it (`auto`).
 * The title bar and Insights read this, so one session never has three names.
 */
export function useCurrentSessionTitle(): TitleParts {
	const t = useT();
	const sessionId = useSessionStore(s => s.sessionId);
	const sessionName = useSessionStore(s => s.sessionName);
	const autoTitle = useSessionStore(s => s.autoTitle);
	// Global, like the sidebar: the row is found by id whichever project the tab is in.
	const { sessions } = useSessionList("global");
	const current = sessions.find(session => session.id === sessionId);
	const name = sessionName?.trim();
	if (name) return sessionTitleParts(name, autoTitle ?? current?.autoTitle);
	return current ? sessionDisplayParts(current, t("sidebar.untitled")) : { title: t("sidebar.newSession") };
}
