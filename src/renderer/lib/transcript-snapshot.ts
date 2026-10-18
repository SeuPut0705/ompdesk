/**
 * The newest transcript page of each open session, kept as a snapshot (`lib/snapshot-cache.ts`, kind
 * `transcript`) so a relaunch, a tab restored from the tab snapshot and a session opened again paint their last
 * rows at the first frame; the hydrate's live page then reconciles in place (rows whose content is unchanged
 * keep their objects, so nothing re-renders or moves).
 *
 * A seeded transcript is the guess, never the history: the store holds it with `restoredAt` set, it carries no
 * `prevCursor` (a cursor is bound to the live session snapshot), and `commitHydration` replaces it wholesale
 * instead of retaining it as loaded history.
 */
import type { AgentMessage } from "../../shared/rpc-types";
import type { MessagesStore } from "../stores/messages";
import { sameMessageContent } from "./message-identity";
import { ENTRY_MAX_CHARS, snapshotNs, snapshots } from "./snapshot-cache";

/** Messages kept per session: the live tail page is 200 and the first paint needs far fewer. */
export const TRANSCRIPT_SNAPSHOT_MESSAGES = 120;
/** A budget under the entry cap leaves room for the scrub's replacements and the envelope. */
const TRANSCRIPT_SNAPSHOT_CHARS = Math.floor(ENTRY_MAX_CHARS * 0.85);
/** The writes wait for a quiet moment: a stream appends a row every few milliseconds. */
export const TRANSCRIPT_WRITE_DELAY_MS = 2500;

interface TabIdentity {
	sessionPath?: string;
	sessionId?: string;
	device?: string;
}

export function transcriptKey(tab: TabIdentity): string | null {
	if (tab.sessionPath) return `path:${tab.sessionPath}`;
	return tab.sessionId ? `id:${tab.sessionId}` : null;
}

/** The newest rows of `messages` that fit one entry; committed rows only, never an unsent echo. */
export function trimForSnapshot(messages: readonly AgentMessage[]): AgentMessage[] {
	const kept: AgentMessage[] = [];
	let chars = 0;
	for (let index = messages.length - 1; index >= 0 && kept.length < TRANSCRIPT_SNAPSHOT_MESSAGES; index--) {
		const message = messages[index] as AgentMessage;
		if (message.optimistic) continue;
		chars += JSON.stringify(message).length + 1;
		if (chars > TRANSCRIPT_SNAPSHOT_CHARS) break;
		kept.push(message);
	}
	return kept.reverse();
}

/** The arrays this module put into stores: `commitHydration` tells them from rows the user loaded. */
const seeded = new WeakSet<readonly AgentMessage[]>();

export const isSeededTranscript = (messages: readonly AgentMessage[]): boolean => seeded.has(messages);

export function readTranscriptSnapshot(tab: TabIdentity): { messages: AgentMessage[]; at: number } | null {
	const key = transcriptKey(tab);
	if (!key) return null;
	const hit = snapshots().read<AgentMessage[]>("transcript", snapshotNs(tab.device), key);
	if (!hit || !Array.isArray(hit.value) || hit.value.length === 0) return null;
	return { messages: hit.value, at: hit.at };
}

/**
 * Put the tab's last page into an empty messages store. Returns the rows seeded (the caller rebuilds the tools
 * store from them), or null when the store already shows something or nothing is known.
 */
export function seedTranscript(
	store: { getState(): MessagesStore; setState(patch: Partial<MessagesStore>): void },
	tab: TabIdentity,
): AgentMessage[] | null {
	const state = store.getState();
	if (state.messages.length > 0 || state.liveMessages.length > 0) return null;
	const snapshot = readTranscriptSnapshot(tab);
	if (!snapshot) return null;
	seeded.add(snapshot.messages);
	store.setState({ messages: snapshot.messages, prevCursor: undefined, restoredAt: snapshot.at });
	return snapshot.messages;
}

/** `fetched` with the seeded row's object wherever the content is the same, so unchanged rows do not re-render. */
export function reuseSeededRows(fetched: AgentMessage[], current: readonly AgentMessage[]): AgentMessage[] {
	if (!isSeededTranscript(current)) return fetched;
	const byId = new Map<string, AgentMessage>();
	for (const message of current) if (message.entryId) byId.set(message.entryId, message);
	return fetched.map(message => {
		const old = message.entryId ? byId.get(message.entryId) : undefined;
		return old && sameMessageContent(old, message) ? old : message;
	});
}

/** Coalesced, idle-time write of the tab's newest rows; the key is read when it runs (the path may be new by then). */
export function writeTranscriptSnapshot(tab: TabIdentity, messages: readonly AgentMessage[]): void {
	const key = transcriptKey(tab);
	if (!key || messages.length === 0 || seeded.has(messages)) return;
	snapshots().write("transcript", snapshotNs(tab.device), key, trimForSnapshot(messages));
}
