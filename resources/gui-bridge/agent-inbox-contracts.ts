export const INBOX_PROVENANCE_SOURCE = "ompdesk.native-inbox";
export const INBOX_CONTEXT_ENTRY = "ompdesk.inbox-context";

export type InboxContent =
	| string
	| ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];

export interface InboxReceiver {
	sessionPath: string;
	device?: string;
	/** The receiving process and session incarnation returned by agent_control.inbox_status. */
	instance: string;
}

/** Supplied only by the private native outbox -> authenticated Host -> bridge route, never a stock prompt. */
export interface NativeInboxEntry {
	deliveryId: string;
	sender: { session: string; device?: string };
	intent: "immediate" | "follow_up";
	kind: "prompt" | "report";
	/** Existing native report wake intent. A passive report must not start an idle turn. Prompts use true. */
	triggerTurn: boolean;
	content: InboxContent;
	/** Existing user-attributed/no-ID delivery has no authoritative object binding. Preserve its original. */
	legacy?: true;
}

export interface NativeInboxRequest {
	receiver: InboxReceiver;
	/** Native inventory order, including entries already handed to this receiver instance. */
	entries: NativeInboxEntry[];
}

export interface InboxContextReceipt {
	requestId: string;
	sessionPath: string;
	instance: string;
	ids: string[];
	/** Context membership plus the first real provider output, not semantic understanding. */
	evidence: "context-id-and-provider-output";
}

export type InboxEntryState = "accepted" | "journaled" | "context_observed" | "legacy_ambiguous" | "failed";

export interface NativeInboxReply {
	receiver: InboxReceiver;
	entries: { deliveryId: string; state: InboxEntryState; error?: string }[];
	/** Stock-journal receipts only. This is not the native Disk/Memory responsibility-transfer ACK. */
	receipts: InboxContextReceipt[];
}
