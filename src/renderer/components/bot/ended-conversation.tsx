/**
 * A conversation the bot ended (`SessionInfo.bot` `past`, main's `agent-control/bot-rotation.ts`): kept read-only under
 * the bot for 7 days. Its pane shows a note where the composer would be (`EndedConversationNote`, in the bot's lazy
 * module), with a way to the bot's current conversation; main refuses a prompt to it as well (`bot_conversation_ended`).
 * This test is small and eager: the composer's place never flashes an input that would be refused.
 */
import { useEffect } from "react";
import { useStore } from "zustand";
import { sessionListFeed } from "../../stores/session-list";
import type { SessionTab } from "../../stores/tabs";
import { useBotDeskModule } from "./bot-tab";

/** The tab holds a conversation its computer's bot ended. */
export function useEndedBotConversation(tab: Pick<SessionTab, "sessionPath" | "device"> | undefined): boolean {
	const feed = sessionListFeed("global", tab?.device);
	useEffect(() => feed.retain(), [feed]);
	const path = tab?.sessionPath;
	return useStore(
		feed.store,
		state => path !== undefined && state.sessions.some(row => row.path === path && row.bot === "past"),
	);
}

/** The note in the composer's place: an empty strip of its height until the bot's module is here. */
export function EndedConversationSlot({ device }: { device?: string }) {
	const desk = useBotDeskModule(true);
	return desk ? (
		<desk.EndedConversationNote {...(device === undefined ? {} : { device })} />
	) : (
		<div aria-hidden className="omp-composer-shell h-11" data-bot-ended-note="" />
	);
}
