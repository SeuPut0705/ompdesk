import { NO_TEXT_PROMPT } from "../../../resources/gui-bridge/session-list-contracts";
import { agentTaskTitle } from "../../shared/agent-control";
import type { SessionInfo } from "../../shared/ipc-types";
import { translate } from "./i18n";
import { promptDisplayText } from "./prompt-text";

/**
 * Stock's listing writes this English placeholder when its prefix scan finds no first prompt; the bridge blanks it,
 * an older paired host still sends it. It is never a title or content.
 */
const NO_MESSAGES = "(no messages)";

function firstPrompt(session: Pick<SessionInfo, "firstMessage">): string {
	const text = session.firstMessage.trim();
	return text === NO_MESSAGES ? "" : text;
}

/**
 * One display-title contract shared by the sidebar and top tab strip. The bridge's `NO_TEXT_PROMPT` sentinel (a
 * session whose first message is an image or file) reads as its localized label.
 */
export function sessionDisplayTitle(session: Pick<SessionInfo, "title" | "firstMessage">, untitled: string): string {
	const prompt = firstPrompt(session);
	if (prompt === NO_TEXT_PROMPT) return session.title?.trim() || translate("session.noTextPrompt");
	// A session another session's agent opened reads as its task, not the whole first message.
	return session.title?.trim() || agentTaskTitle(prompt) || promptDisplayText(prompt).trim() || untitled;
}

/** True once a session has user-visible conversation content (the no-text sentinel counts). */
export function sessionHasContent(session: Pick<SessionInfo, "title" | "firstMessage" | "messageCount">): boolean {
	return session.messageCount > 0 || Boolean(session.title?.trim() || firstPrompt(session));
}
