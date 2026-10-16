import { createStore } from "zustand/vanilla";
import type { AgentMessage, AgentSessionEvent, MessagesPage, ReadGroupTarget } from "../../shared/rpc-types";
import { messageIdentity, sameDelivery, sameMessageContent } from "../lib/message-identity";
import { applyTurnMeterEvent, EMPTY_TURN_METER, type TurnMeter } from "../lib/turn-meter";
import { createScopedStoreHook } from "./session-runtime-context";

export interface MessagesStore {
	messages: AgentMessage[];
	/** Uncommitted local echo and message_end deliveries for the active run. */
	liveMessages: AgentMessage[];
	/**
	 * Messages appended by the most recent applyEvents/appendMessage call —
	 * the voice auto-speak watcher's clean signal: hydration/pagination
	 * replaces `messages` wholesale without touching this field, so watchers
	 * only ever see genuinely new finalized messages (never history).
	 */
	lastAppended: AgentMessage[];
	streamingMessage: AgentMessage | null;
	streamingText: string;
	streamingThinking: string;
	prevCursor: string | undefined;
	pageError: string | null;
	isLoadingPage: boolean;
	/** Output-token meter for the running (or last) agent run; lib/turn-meter. */
	turnMeter: TurnMeter;
	/**
	 * Stock read metadata (gui-bridge stream-metadata.ts) by call id for the running turn's
	 * delivered messages, which carry none: transcripts and committed `agent_end` messages
	 * have it on the call itself. Read grouping falls back to it (lib/read-group.ts).
	 */
	readTargets: ReadonlyMap<string, ReadGroupTarget | null>;
	applyEvents: (events: AgentSessionEvent[]) => void;
	prependPage: (page: MessagesPage) => void;
	appendMessage: (message: AgentMessage) => void;
	removeMessage: (message: AgentMessage) => void;
	appendLiveMessage: (message: AgentMessage) => void;
	removeLiveMessage: (message: AgentMessage) => void;
	/** Clear partial assistant stream buffers without touching committed or live rows. */
	clearStreaming: () => void;
	/**
	 * Another window shows this tab too (multi-viewer). Its prompts are delivered here as user messages
	 * this window never echoed, so an echo is claimed only by the delivery with its own text.
	 */
	sharedTab: boolean;
	setSharedTab: (shared: boolean) => void;
	/**
	 * Texts this window sent on a shared tab without a local echo (a steer or follow-up): their deliveries
	 * are this window's own, not another viewer's (`appendLiveMessages`).
	 */
	ownSends: string[];
	noteOwnSend: (text: string) => void;
	/** Drop delivered live rows after an idle transcript hydrate; keep unsent local echo. */
	clearDeliveredLiveMessages: () => void;
	/**
	 * Apply a fetched committed transcript. In-flight stable rows are merged by
	 * mergeFetchedTranscript before this replacement.
	 */
	reconcileFetched: (fetched: AgentMessage[]) => void;
	reset: () => void;
}

const initialState = {
	messages: [] as AgentMessage[],
	liveMessages: [] as AgentMessage[],
	lastAppended: [] as AgentMessage[],
	streamingMessage: null as AgentMessage | null,
	streamingText: "",
	streamingThinking: "",
	prevCursor: undefined as string | undefined,
	pageError: null as string | null,
	isLoadingPage: false,
	turnMeter: EMPTY_TURN_METER,
	ownSends: [] as string[],
	readTargets: new Map() as ReadonlyMap<string, ReadGroupTarget | null>,
};

function isOptimisticUser(message: AgentMessage): boolean {
	return message.role === "user" && message.optimistic === true;
}

/**
 * Whether `list` already holds the stock message a frame carries: a snapshot overtook the
 * frame, or the frame is a replay. Stream frames carry a partial, so `partial` matches the
 * identity alone; `message_end` carries the final message, which must match in content too.
 * A local echo still waiting for its delivery is not one.
 */
function holds(list: readonly AgentMessage[], message: AgentMessage, partial: boolean): boolean {
	const identity = messageIdentity(message);
	if (identity === undefined) return false;
	for (let index = list.length - 1; index >= 0; index--) {
		const entry = list[index];
		if (entry?.role !== message.role || entry.timestamp !== message.timestamp) continue;
		if (isOptimisticUser(entry) && !entry.optimisticDelivered) continue;
		if (partial ? messageIdentity(entry) === identity : sameDelivery(entry, message)) return true;
	}
	return false;
}

/** A committed prompt keeps the "from another viewer" mark its live delivery carried (a reload names the sender). */
function withViewerOrigins(committed: AgentMessage[], live: readonly AgentMessage[]): AgentMessage[] {
	const flagged = live.filter(message => message.fromOtherViewer);
	if (flagged.length === 0) return committed;
	return committed.map(message =>
		message.role === "user" &&
		!message.fromOtherViewer &&
		flagged.some(entry => userText(entry) === userText(message))
			? { ...message, fromOtherViewer: true }
			: message,
	);
}

/** The typed text of a user message: a string, or the text blocks of a block list (attachments are not text). */
function userText(message: AgentMessage): string {
	const { content } = message;
	if (typeof content === "string") return content;
	return (content ?? []).map(block => (block.type === "text" ? block.text : "")).join("");
}

/**
 * The delivery of a user message claims this window's oldest echo still waiting for it. On a tab no other
 * window shows, that is the next non-steering user message (the host may have expanded the text, so
 * nothing else is compared). On a shared tab another viewer's prompt can arrive first, so only the
 * delivery with the echo's own text claims it, steering or not (a window whose view of the run was a beat
 * behind echoed a prompt that the host queued as steering). A delivery nothing claims and this window did not
 * send (`ownSends`: texts it sent without an echo, e.g. a steer) is another viewer's prompt: it appends,
 * marked `fromOtherViewer`. `ownSends` is consumed in place.
 */
function appendLiveMessages(
	messages: AgentMessage[],
	delivered: AgentMessage[],
	shared: boolean,
	ownSends: string[],
): AgentMessage[] {
	let next = messages;
	for (const message of delivered) {
		const text = shared && message.role === "user" ? userText(message) : "";
		const waiting = (entry: AgentMessage) => isOptimisticUser(entry) && !entry.optimisticDelivered;
		const optimisticIndex =
			message.role !== "user"
				? -1
				: shared
					? next.findIndex(entry => waiting(entry) && userText(entry) === text)
					: message.steering
						? -1
						: next.findIndex(waiting);
		if (optimisticIndex >= 0) {
			const optimistic = next[optimisticIndex];
			next = [...next];
			next[optimisticIndex] = {
				...message,
				optimistic: true,
				optimisticDelivered: true,
				optimisticAfterEntryId: optimistic?.optimisticAfterEntryId,
			};
			continue;
		}
		const own = shared && message.role === "user" ? ownSends.indexOf(text) : -1;
		if (own >= 0) ownSends.splice(own, 1);
		const fromOther = shared && message.role === "user" && own < 0 && message.promptFrom === undefined;
		next = [...next, fromOther ? { ...message, fromOtherViewer: true } : message];
	}
	return next;
}

/** Match the delivered prompt after its anchor, without consuming an unrelated queued prompt. */
function optimisticUserWasCommitted(message: AgentMessage, fetched: AgentMessage[]): boolean {
	if (!isOptimisticUser(message) || message.optimisticAfterEntryId === undefined) return false;
	const anchorIndex =
		message.optimisticAfterEntryId === null
			? -1
			: fetched.findIndex(entry => entry.entryId === message.optimisticAfterEntryId);
	if (message.optimisticAfterEntryId !== null && anchorIndex < 0) return false;
	return fetched
		.slice(anchorIndex + 1)
		.some(entry => entry.entryId !== undefined && sameMessageContent(message, entry));
}

function upsertCommittedMessages(current: AgentMessage[], committed: AgentMessage[]): AgentMessage[] {
	const persisted = committed.filter(message => message.entryId);
	if (persisted.length === 0) return current;
	const indexByEntryId = new Map<string, number>();
	current.forEach((message, index) => {
		if (message.entryId) indexByEntryId.set(message.entryId, index);
	});
	const next = [...current];
	for (const message of persisted) {
		if (!message.entryId) continue;
		const index = indexByEntryId.get(message.entryId);
		if (index === undefined) {
			indexByEntryId.set(message.entryId, next.length);
			next.push(message);
		} else {
			next[index] = message;
		}
	}
	return next;
}

/** Preserve only committed rows appended after a transcript request began. */
export function mergeFetchedTranscript(
	fetched: AgentMessage[],
	before: AgentMessage[],
	current: AgentMessage[],
): AgentMessage[] {
	const prefixIntact =
		current.length >= before.length &&
		before.every((message, index) => {
			const currentMessage = current[index];
			if (!currentMessage) return false;
			return message.entryId || currentMessage.entryId
				? message.entryId !== undefined && message.entryId === currentMessage.entryId
				: message === currentMessage;
		});
	if (!prefixIntact) return fetched;
	const fetchedIds = new Set(fetched.flatMap(message => (message.entryId ? [message.entryId] : [])));
	const tail = current.slice(before.length).filter(message => message.entryId && !fetchedIds.has(message.entryId));
	return tail.length === 0 ? fetched : [...fetched, ...tail];
}

export const createMessagesStore = () =>
	createStore<MessagesStore>()((set, get) => ({
		...initialState,
		sharedTab: false,
		setSharedTab: shared => set(state => (state.sharedTab === shared ? state : { sharedTab: shared })),
		noteOwnSend: text => set(state => ({ ownSends: [...state.ownSends.slice(-31), text] })),
		applyEvents: events => {
			const state = get();
			const ownSends = [...state.ownSends];
			let { messages, liveMessages, streamingMessage, streamingText, streamingThinking, turnMeter, readTargets } =
				state;
			const now = Date.now();
			for (const event of events) {
				// A frame for a message that already ended changes nothing: neither the rows,
				// the stream nor the meter (a late frame behind a snapshot, or a replay). Nor
				// does a replayed start of the message streaming now.
				const streamingThis =
					(event.type === "message_start" || event.type === "message_update" || event.type === "message_end") &&
					streamingMessage !== null &&
					streamingMessage.timestamp === event.message.timestamp;
				let redelivered = false;
				if (event.type === "message_end") {
					redelivered = holds(messages, event.message, false) || holds(liveMessages, event.message, false);
				} else if (
					(event.type === "message_start" || event.type === "message_update") &&
					event.message.role === "assistant"
				) {
					redelivered = streamingThis
						? event.type === "message_start"
						: holds(messages, event.message, true) || holds(liveMessages, event.message, true);
				}
				if (redelivered) {
					// A snapshot's copy overtook the end of the stream shown here: that stream closes.
					if (event.type === "message_end" && streamingThis) {
						turnMeter = applyTurnMeterEvent(turnMeter, event, now);
						streamingMessage = null;
						streamingText = "";
						streamingThinking = "";
					}
					continue;
				}
				turnMeter = applyTurnMeterEvent(turnMeter, event, now);
				switch (event.type) {
					case "read_group_metadata": {
						const known = readTargets.get(event.toolCallId);
						const same =
							readTargets.has(event.toolCallId) &&
							known?.path === event.target?.path &&
							known?.selector === event.target?.selector;
						if (!same) readTargets = new Map(readTargets).set(event.toolCallId, event.target);
						break;
					}
					case "message_start":
						// Only assistant messages stream. Other deliveries are atomic.
						if (event.message.role !== "assistant") break;
						streamingMessage = event.message;
						streamingText = "";
						streamingThinking = "";
						break;
					case "message_update": {
						const update = event.assistantMessageEvent;
						const partial = event.message;
						// A tab that sat in the background never saw this message's
						// message_start (its frames are not forwarded), so the first
						// update it gets opens the stream — or replaces the shell of a
						// message that ended meanwhile. The snapshot already holds this
						// update's delta, so seed the buffers from it instead.
						if (
							partial.role === "assistant" &&
							Array.isArray(partial.content) &&
							(streamingMessage === null || streamingMessage.timestamp !== partial.timestamp)
						) {
							streamingMessage = { ...partial, content: [] };
							streamingText = "";
							streamingThinking = "";
							for (const block of partial.content) {
								if (block.type === "text") streamingText += block.text;
								else if (block.type === "thinking") streamingThinking += block.thinking;
							}
							break;
						}
						if (update.type === "text_delta") streamingText += update.delta;
						else if (update.type === "thinking_delta") streamingThinking += update.delta;
						break;
					}
					case "message_end":
						liveMessages = appendLiveMessages(liveMessages, [event.message], state.sharedTab, ownSends);
						if (event.message.role === "assistant") {
							streamingMessage = null;
							streamingText = "";
							streamingThinking = "";
						}
						break;
					case "agent_end":
						if (event.messages) {
							messages = upsertCommittedMessages(messages, withViewerOrigins(event.messages, liveMessages));
							if (event.messages.some(message => message.entryId)) {
								// A prompt queued locally after this run ended is not part of its commit.
								liveMessages = liveMessages.filter(
									message =>
										isOptimisticUser(message) &&
										!message.optimisticDelivered &&
										!optimisticUserWasCommitted(message, messages),
								);
								// The committed messages carry their read metadata themselves.
								if (readTargets.size > 0) readTargets = new Map();
							}
						}
						streamingMessage = null;
						streamingText = "";
						streamingThinking = "";
						break;
				}
			}
			if (
				messages === state.messages &&
				liveMessages === state.liveMessages &&
				streamingMessage === state.streamingMessage &&
				streamingText === state.streamingText &&
				streamingThinking === state.streamingThinking &&
				turnMeter === state.turnMeter &&
				readTargets === state.readTargets
			)
				return;
			// Preserve wire order above; publish only once per presentation frame.
			const appended = messages.slice(state.messages.length);
			set({
				messages,
				liveMessages,
				streamingMessage,
				streamingText,
				streamingThinking,
				turnMeter,
				readTargets,
				...(ownSends.length === state.ownSends.length ? {} : { ownSends }),
				...(appended.length > 0 ? { lastAppended: appended } : {}),
			});
		},
		prependPage: page =>
			set(state => {
				const ids = new Set(state.messages.flatMap(message => (message.entryId ? [message.entryId] : [])));
				const older = page.messages.filter(message => {
					if (!message.entryId) return !state.messages.includes(message);
					if (ids.has(message.entryId)) return false;
					ids.add(message.entryId);
					return true;
				});
				return {
					messages: [...older, ...state.messages],
					prevCursor: page.prevCursor,
					isLoadingPage: false,
					pageError: null,
				};
			}),
		appendMessage: message => set(s => ({ messages: [...s.messages, message], lastAppended: [message] })),
		/** Drop a locally appended placeholder (e.g. the composer's running-eval bubble) by identity. */
		removeMessage: message =>
			set(s => {
				const messages = s.messages.filter(entry => entry !== message);
				return messages.length === s.messages.length ? s : { messages };
			}),
		appendLiveMessage: message => set(s => ({ liveMessages: [...s.liveMessages, message] })),
		removeLiveMessage: message => set(s => ({ liveMessages: s.liveMessages.filter(entry => entry !== message) })),
		clearStreaming: () => set({ streamingMessage: null, streamingText: "", streamingThinking: "" }),
		clearDeliveredLiveMessages: () =>
			set(s => ({
				liveMessages: s.liveMessages.filter(message => isOptimisticUser(message) && !message.optimisticDelivered),
			})),
		reconcileFetched: fetched => {
			const state = get();
			const committedByIdentity = new Map<string, AgentMessage[]>();
			for (const message of fetched) {
				const identity = messageIdentity(message);
				if (!message.entryId || !identity) continue;
				const matches = committedByIdentity.get(identity);
				if (matches) matches.push(message);
				else committedByIdentity.set(identity, [message]);
			}
			const liveMessages = state.liveMessages.filter(message => {
				const identity = messageIdentity(message);
				const matches = identity ? committedByIdentity.get(identity) : undefined;
				const index = matches?.findIndex(entry => sameMessageContent(message, entry)) ?? -1;
				if (index >= 0) {
					matches?.splice(index, 1);
					return false;
				}
				return !optimisticUserWasCommitted(message, fetched);
			});
			const messagesUnchanged =
				fetched.length === state.messages.length &&
				fetched.every((message, index) => message === state.messages[index]);
			if (messagesUnchanged && liveMessages.length === state.liveMessages.length) return;
			set({
				messages: fetched,
				liveMessages: liveMessages.length === state.liveMessages.length ? state.liveMessages : liveMessages,
			});
		},
		reset: () => set(initialState),
	}));

const defaultMessagesStore = createMessagesStore();
export const useMessagesStore = createScopedStoreHook("messages", defaultMessagesStore);
