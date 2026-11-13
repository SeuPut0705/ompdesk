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

/**
 * The most one attachment of `ompdesk_session_send` / `ompdesk_report` may weigh. Its base64 (a third more) is one
 * `agent_control.attachment` answer, and one `host.files.upload` frame, inside the link's 16 MiB frame.
 */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** The pictures a model reads inline (stock `prompt.images`, a mail's image blocks); any other file is landed by path. */
export const ATTACHMENT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type AttachmentImageType = (typeof ATTACHMENT_IMAGE_TYPES)[number];

export function isAttachmentImageType(type: string): type is AttachmentImageType {
	return (ATTACHMENT_IMAGE_TYPES as readonly string[]).includes(type);
}

/** The picture type a file's first bytes name (its extension may lie), or undefined for anything else. */
export function sniffImageType(head: Uint8Array): AttachmentImageType | undefined {
	const at = (offset: number, ...bytes: number[]): boolean => bytes.every((byte, i) => head[offset + i] === byte);
	if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
	if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
	if (at(0, 0x47, 0x49, 0x46, 0x38) && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61) return "image/gif";
	if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
	return undefined;
}

/** One attachment as the caller's omp read it (`agent_control.attachment`): where its owner's tools can find the bytes. */
export interface AttachmentWire {
	name: string;
	mimeType: string;
	dataBase64: string;
	sha256: string;
}
