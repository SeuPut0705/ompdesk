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

/** The word earlier builds put in front of an Autopilot run's name; the row's rocket says it now (23 Oct 2026). */
const RUN_PREFIX = /^(?:Autopilot|오토파일럿) · /;

/** A stored session name as it shows: no `Title:` prefix, no "Autopilot · " an earlier build wrote. */
export function shownSessionName(name: string): string {
	return stripTitlePrefix(name.trim()).replace(RUN_PREFIX, "").trim();
}

/** The bot's name as its fixed row and Settings show it: its session's own title, else `fallback` (the label "Bot"). */
export function botDisplayName(session: Pick<SessionInfo, "title"> | undefined, fallback: string): string {
	return shownSessionName(session?.title ?? "") || fallback;
}

/**
 * One display-title contract shared by the sidebar and top tab strip. The bridge's `NO_TEXT_PROMPT` sentinel (a
 * session whose first message is an image or file) reads as its localized label.
 */
export function sessionDisplayTitle(session: Pick<SessionInfo, "title" | "firstMessage">, untitled: string): string {
	const prompt = firstPrompt(session);
	const title = shownSessionName(session.title ?? "");
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
