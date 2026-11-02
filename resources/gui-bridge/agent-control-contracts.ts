/**
 * Dependency-free contracts of the control tools' mailbox, shared by main (`src/main/agent-control/mail.ts`), the
 * renderer (the quiet transcript line) and the bridge (`agent-control.ts`).
 */

/** The custom message type of a report one session sent another (`ompdesk_report`). */
export const MAIL_CUSTOM_TYPE = "ompdesk.mail";

/**
 * The start of a message another session's agent sent (src/shared/agent-control.ts `wrapAgentMessage`): a prompt an
 * agent wrote, never a person, whatever the session.
 */
export const AGENT_MESSAGE_START = /^\s*<ompdesk-agent-message[\s>]/;

/**
 * Whether a session's journal already holds the report `id`: stock journals a `sendMessage` as a
 * `{type: "custom_message", customType, details, …}` entry (`CustomMessageEntry`, session/session-entries.ts).
 */
export function hasMailEntry(entries: readonly unknown[], id: string): boolean {
	return entries.some(entry => {
		if (typeof entry !== "object" || entry === null) return false;
		if (!("type" in entry) || entry.type !== "custom_message") return false;
		if (!("customType" in entry) || entry.customType !== MAIL_CUSTOM_TYPE) return false;
		const details = "details" in entry ? entry.details : undefined;
		return typeof details === "object" && details !== null && "id" in details && details.id === id;
	});
}

/**
 * The marker a message an opener sends its child carries (`[ompdesk dispatch d2: …]`, src/main/agent-control
 * `withDispatch`): the dispatch alone names that message among the child's.
 */
export function dispatchMark(dispatch: string): string {
	return `[ompdesk dispatch ${dispatch}:`;
}

/** The marker of a message sent with a request id (`[ompdesk request <id>]`): it names that one message. */
export function requestMark(id: string): string {
	return `[ompdesk request ${id}]`;
}

/**
 * The `marks` a session's journal holds in a prompt it took (a stock user message entry, `{type: "message", message:
 * {role: "user", content}}`): what tells main a message it sent arrived, whichever omp of the session took it.
 */
export function journaledMarks(entries: readonly unknown[], marks: readonly string[]): string[] {
	const texts: string[] = [];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null || !("type" in entry) || entry.type !== "message") continue;
		const message = "message" in entry ? entry.message : undefined;
		if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "user") continue;
		const content = "content" in message ? message.content : undefined;
		if (typeof content === "string") texts.push(content);
		else if (Array.isArray(content))
			for (const part of content)
				if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string")
					texts.push(part.text);
	}
	return marks.filter(mark => texts.some(text => text.includes(mark)));
}
