import { useT } from "../lib/i18n";
import { sessionDisplayParts, sessionTitleParts, type TitleParts, withEndedBotMark } from "../lib/session-title";
import { useSessionStore } from "../stores/session";
import { useTabsStore } from "../stores/tabs";
import { useSessionList } from "./use-session-list";
import { useTabListRows } from "./use-tab-list-rows";

/**
 * The attached session's name as the sidebar shows it: the name the session
 * holds, else its stored title, else its first prompt, else a placeholder. A
 * name the person set comes with the automatic title beside it (`auto`). A
 * conversation the bot ended says so, as its tab does (`withEndedBotMark`, read
 * from the list of the computer the tab runs on).
 * The title bar and Insights read this, so one session never has three names.
 */
export function useCurrentSessionTitle(): TitleParts {
	const t = useT();
	const sessionId = useSessionStore(s => s.sessionId);
	const sessionName = useSessionStore(s => s.sessionName);
	const autoTitle = useSessionStore(s => s.autoTitle);
	// Global, like the sidebar: the row is found by id whichever project the tab is in.
	const { sessions } = useSessionList("global");
	const listedRowOf = useTabListRows();
	const active = useTabsStore(s => s.tabs.find(tab => tab.id === s.activeTabId));
	const current = sessions.find(session => session.id === sessionId);
	const name = sessionName?.trim();
	const parts = name
		? sessionTitleParts(name, autoTitle ?? current?.autoTitle)
		: current
			? sessionDisplayParts(current, t("sidebar.untitled"))
			: { title: t("sidebar.newSession") };
	return withEndedBotMark(parts, active ? listedRowOf(active) : current);
}
