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

/**
 * A session title as it shows: the name the person set and, beside it, the automatic title the bridge keeps writing
 * (`SessionInfo.autoTitle`). `auto` is absent when there is none or it says the same.
 */
export interface TitleParts {
	title: string;
	auto?: string;
}

/** `title` with `autoTitle` beside it, once both read as something and differ after `shownSessionName`. */
export function sessionTitleParts(title: string, autoTitle: string | null | undefined): TitleParts {
	const shown = shownSessionName(title);
	const auto = shownSessionName(autoTitle ?? "");
	return shown && auto && auto !== shown ? { title: shown, auto } : { title: shown };
}

/** The parts as one string, for tooltips, aria-labels, switchers, the document title and search haystacks. */
export function combinedTitle(parts: TitleParts): string {
	return parts.auto ? `${parts.title} · ${parts.auto}` : parts.title;
}

/**
 * `sessionDisplayTitle` as parts: the automatic title joins only a title the session stores. A first-prompt, task or
 * placeholder name stands alone: nothing was renamed, so there is no second name to show.
 */
export function sessionDisplayParts(
	session: Pick<SessionInfo, "title" | "firstMessage" | "autoTitle">,
	untitled: string,
): TitleParts {
	const title = sessionDisplayTitle(session, untitled);
	return shownSessionName(session.title ?? "") ? sessionTitleParts(title, session.autoTitle) : { title };
}

/** {@link sessionDisplayParts} as one string, for announcements, aria-labels and tooltips. */
export function sessionDisplayLabel(
	session: Pick<SessionInfo, "title" | "firstMessage" | "autoTitle">,
	untitled: string,
): string {
	return combinedTitle(sessionDisplayParts(session, untitled));
}

/** True once a session has user-visible conversation content (the no-text sentinel counts). */
export function sessionHasContent(session: Pick<SessionInfo, "title" | "firstMessage" | "messageCount">): boolean {
	return session.messageCount > 0 || Boolean(session.title?.trim() || firstPrompt(session));
}
