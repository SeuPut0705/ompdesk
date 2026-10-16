import type { SessionInfo } from "../../shared/ipc-types";
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

/** One display-title contract shared by the sidebar and top tab strip. */
export function sessionDisplayTitle(session: Pick<SessionInfo, "title" | "firstMessage">, untitled: string): string {
	return session.title?.trim() || promptDisplayText(firstPrompt(session)).trim() || untitled;
}

/** True once a session has user-visible conversation content. */
export function sessionHasContent(session: Pick<SessionInfo, "title" | "firstMessage" | "messageCount">): boolean {
	return session.messageCount > 0 || Boolean(session.title?.trim() || firstPrompt(session));
}
