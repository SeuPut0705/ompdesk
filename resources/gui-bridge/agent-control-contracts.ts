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
 * The bridge frame listing the no-turn reports (progress, note) it holds until the receiver's running turn ends
 * (`{type, items: PendingMail[]}`, an empty list once they are in the transcript); bridge method
 * `agent_control.mail_pending` answers the same list.
 */
export const MAIL_PENDING_EVENT = "mail_pending";

export interface PendingMail {
	/** The report's id (`details.id`). */
	id: string;
	/** The sender's title, else its tab id. */
	from: string;
	kind: string;
}

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
