import { assignmentHeadline, stripTitlePrefix } from "../../../resources/gui-bridge/modes/subagent-title-contracts";
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
	const title = stripTitlePrefix(session.title?.trim() ?? "").trim();
	if (prompt === NO_TEXT_PROMPT) return title || translate("session.noTextPrompt");
	// A session another session's agent opened reads as its task, not the whole first message. One that was
	// not wrapped (a goal's objective) still names its `Title:` line, never the label.
	const text = promptDisplayText(prompt).trim();
	const named = stripTitlePrefix(text) === text ? text : assignmentHeadline(text);
	return title || agentTaskTitle(prompt) || named || untitled;
}

/** True once a session has user-visible conversation content (the no-text sentinel counts). */
export function sessionHasContent(session: Pick<SessionInfo, "title" | "firstMessage" | "messageCount">): boolean {
	return session.messageCount > 0 || Boolean(session.title?.trim() || firstPrompt(session));
}

/**
 * The sidebar's lane rule, one for this computer's list and a paired host's: a chat, or a session in that machine's
 * no-project workspace (`~/.omp/work`), sits in the Chat lane; everything else in Code.
 */
export function inChatLane(session: Pick<SessionInfo, "kind" | "cwd">, workspace: string | null): boolean {
	return session.kind === "chat" || (workspace !== null && session.cwd === workspace);
}
