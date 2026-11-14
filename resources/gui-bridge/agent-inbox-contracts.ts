export const INBOX_PROVENANCE_SOURCE = "ompdesk.native-inbox";
export const INBOX_CONTEXT_ENTRY = "ompdesk.inbox-context";

/** Receiving-store locations supplied by the trusted service constructor, never a source or tool argument. */
export interface NativeInboxFiles {
	ledger: string;
	uploadUserData: string;
}

export interface NativeInboxKey {
	kind: "prompt" | "report";
	deliveryId: string;
}

/** Native source-kind and opaque ID together identify a provider-context entry. */
export function inboxIdentity(key: NativeInboxKey): string {
	return JSON.stringify([key.kind, key.deliveryId]);
}

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
interface NativeInboxEntryFields {
	deliveryId: string;
	sender: { session: string; device?: string };
	intent: "immediate" | "follow_up";
	/** Existing native report wake intent. A passive report must not start an idle turn. Prompts use true. */
	triggerTurn: boolean;
	content: InboxContent;
	/** Existing user-attributed/no-ID delivery has no authoritative object binding. Preserve its original. */
	legacy?: true;
}

export type NativeInboxEntry = NativeInboxEntryFields &
	({ kind: "prompt" } | { kind: "report"; details: Record<string, unknown> });

export interface NativeInboxRequest {
	receiver: InboxReceiver;
	/** Native inventory order, including entries already handed to this receiver instance. */
	entries: NativeInboxEntry[];
}

/** The existing native AttachmentRef/AttachedSet wire shape. These paths are server-issued upload refs only. */
export interface NativeInboxAttachmentRef {
	sha256: string;
	name: string;
	mimeType: string;
	size: number;
}

export interface InboxAddress {
	deviceId: string;
	sessionPath: string;
}

export interface InboxLogicalMessage {
	producer: InboxAddress;
	target: InboxAddress;
	requestId: string | null;
	intent: "immediate" | "follow_up";
	triggerTurn: boolean;
	payload:
		| { kind: "prompt"; text: string }
		| {
				kind: "report";
				text: string;
				details: Record<string, unknown>;
				instruction: string | null;
				card: string | null;
		  };
}

export interface NativeInboxTransferEntry {
	/** First derived stock presentation. A replay never replaces the receiver's original. */
	entry: NativeInboxEntry;
	/** Captured by the producer's native admission, never derived from a text prefix or a display title. */
	logical: InboxLogicalMessage;
	dispatch: number | null;
	attachments?: {
		images: NativeInboxAttachmentRef[];
		files: (NativeInboxAttachmentRef & { path: string; landedAt: number })[];
	};
}

/** Private native responsibility transfer. It is never forwarded directly to the stock bridge. */
export interface NativeInboxTransfer {
	receiver: InboxReceiver;
	entries: NativeInboxTransferEntry[];
	/** All image/file hashes have a server-issued upload ref; owner namespace comes only from the authenticated route. */
	uploads: { sha256: string; path: string }[];
}

export interface InboxContextReceipt {
	requestId: string;
	sessionPath: string;
	instance: string;
	/** Encoded source-kind/ID pairs returned by inboxIdentity, not unqualified source IDs. */
	ids: string[];
	/** Context membership plus the first real provider output, not semantic understanding. */
	evidence: "context-id-and-provider-output";
}

export type InboxEntryState = "accepted" | "journaled" | "context_observed" | "legacy_ambiguous" | "failed";

export interface NativeInboxReply {
	receiver: InboxReceiver;
	entries: (NativeInboxKey & { state: InboxEntryState; error?: string })[];
	/** Stock-journal receipts only. This is not the native Disk/Memory responsibility-transfer ACK. */
	receipts: InboxContextReceipt[];
}

/** Receiving native journal responsibility, never a bridge or provider-context receipt. */
export interface NativeInboxAcceptance {
	persistence: "disk" | "memory";
	receiver: InboxReceiver;
	deliveries: { key: NativeInboxKey; dispatch: number | null }[];
}
