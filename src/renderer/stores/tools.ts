import { createStore } from "zustand/vanilla";
import type { AgentMessage, AgentSessionEvent, ToolCallContent } from "../../shared/rpc-types";
import { resultDetails } from "../lib/format";
import { parseStreamingArgs, streamingParseStep } from "../lib/streaming-json";
import { createScopedStoreHook } from "./session-runtime-context";

export interface ToolEntry {
	toolName: string;
	args: Record<string, unknown>;
	/** Stock's execution intent, separate from tool arguments. */
	intent?: string;
	/**
	 * `aborted` is the terminal state of a call that never reported a result:
	 * the turn was interrupted, or the process died before execution finished.
	 * History rebuilds must never leave such a call `running` — the card would
	 * spin forever and keep a live clock subscribed.
	 */
	status: "pending" | "running" | "done" | "error" | "aborted";
	/** Accumulated raw args JSON string during streaming (before execution starts). */
	streamingArgs: string;
	result: unknown;
	isError: boolean;
	startTime: number;
	endTime: number | null;
}

function resultStatus(result: unknown, isError: boolean | undefined): ToolEntry["status"] {
	return resultDetails(result)?.__interrupted === true ? "aborted" : isError ? "error" : "done";
}

/** A transcript call's entry: its result, when the transcript has one, else terminal `aborted`. */
function transcriptEntry(
	block: ToolCallContent,
	message: AgentMessage,
	result: AgentMessage | undefined,
	now: number,
): ToolEntry {
	const startTime = timestampMs(message.timestamp, now);
	return {
		toolName: block.name,
		args: block.arguments,
		intent: block.intent,
		status: result ? resultStatus(result, result.isError) : "aborted",
		streamingArgs: "",
		// Keep the same `{content, details}` envelope as the live path so
		// renderers read history identically (details: diffs, exit codes,
		// todo phases, counts — previously dropped here). It points at
		// the transcript message, so the payload is held once.
		result: result ? { content: result.content ?? null, details: result.details ?? null } : null,
		isError: result?.isError ?? false,
		startTime,
		endTime: result ? timestampMs(result.timestamp, startTime) : null,
	};
}

/** Results by call id, in transcript order: repeated raw ids pair by occurrence. */
function resultsByCallId(messages: readonly AgentMessage[]): Map<string, AgentMessage[]> {
	const results = new Map<string, AgentMessage[]>();
	for (const message of messages) {
		if (message.role !== "toolResult" || !message.toolCallId) continue;
		const list = results.get(message.toolCallId);
		if (list) list.push(message);
		else results.set(message.toolCallId, [message]);
	}
	return results;
}

export interface ToolsStore {
	/**
	 * Terminal entries (`done`, `error`, `aborted`) by key. Live events update
	 * this map in place, so a batch never copies the session's whole history and
	 * the map keeps its identity; every in-place change bumps `finishedVersion`.
	 * Entries themselves are immutable (a change stores a new object). Read one
	 * entry with `selectToolEntry`; readers of the whole map also select
	 * `finishedVersion`. Only the store writes to it.
	 */
	finishedTools: Map<string, ToolEntry>;
	finishedVersion: number;
	/** Transcript hydration boundary: returning views wait for this before counting missed work. */
	hydrationVersion: number;
	/** Pending/running entries by key: the small live set, replaced when one changes. */
	liveTools: ReadonlyMap<string, ToolEntry>;
	/**
	 * Latest `tool_execution_update` payload per key, kept out of the entries so
	 * streaming output never replaces an entry or either map. Dropped once
	 * `agent_end` commits the run's results.
	 */
	partialResults: ReadonlyMap<string, unknown>;
	/** Bumps on every batch that writes an entry; the `keepChangedSince` token. */
	revision: number;
	/**
	 * Rebuild the entries from a transcript. `turnIsLive` marks the trailing
	 * unanswered calls of the streaming turn as still running; every other
	 * unanswered call is terminal `aborted`. `keepChangedSince` is `revision` as
	 * it was when the transcript fetch began, and marks the rebuild as racing
	 * live events: entries live events wrote after that, and in-flight calls the
	 * transcript does not contain yet, survive the rebuild with their execution
	 * routing. Everything else is rebuilt from the transcript.
	 */
	hydrateMessages: (messages: AgentMessage[], options?: { turnIsLive?: boolean; keepChangedSince?: number }) => void;
	/**
	 * Add an older history page, `older`, in front of the transcript the entries
	 * were hydrated from, `loaded`. Entries already there keep their objects, so
	 * nothing on screen re-renders for a page prepended above it. A page that could
	 * re-pair the loaded calls with results (a call id seen before, a result for a
	 * call outside the page, a call answered outside it) rebuilds from the whole
	 * transcript instead, as `hydrateMessages` with the same options.
	 */
	prependMessages: (
		older: AgentMessage[],
		loaded: AgentMessage[],
		options?: { turnIsLive?: boolean; keepChangedSince?: number },
	) => void;
	applyEvents: (events: AgentSessionEvent[]) => void;
	/** Resolve a stock call id to its latest occurrence-specific entry key. */
	entryKeyForCallId: (id: string) => string;
	reset: () => void;
}

type ToolEntries = Pick<ToolsStore, "finishedTools" | "liveTools">;

/** One entry by key, live or finished. */
export function selectToolEntry(state: ToolEntries, key: string): ToolEntry | undefined {
	return state.liveTools.get(key) ?? state.finishedTools.get(key);
}

/** Split entries into the store's live set and finished map, keeping their order. */
export function toolEntriesState(entries: Iterable<readonly [string, ToolEntry]>): ToolEntries {
	const finishedTools = new Map<string, ToolEntry>();
	const liveTools = new Map<string, ToolEntry>();
	for (const [key, entry] of entries) {
		const live = entry.status === "pending" || entry.status === "running";
		(live ? liveTools : finishedTools).set(key, entry);
	}
	return { finishedTools, liveTools };
}

function timestampMs(value: string | number | undefined, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

/**
 * Provider tool-call ids are only required to be unique inside one assistant
 * message. Some providers therefore reuse ids such as `read:0` on every turn.
 * The GUI keeps the full transcript in one store, so raw ids cannot be keys
 * on their own: later calls would overwrite earlier results.
 *
 * Call objects are bound to occurrence-specific store keys. The first
 * occurrence retains the raw id for compatibility; later occurrences get an
 * internal suffix. Live execution events still arrive with the raw id and are
 * routed through the queues below.
 */
const callEntryKeys = new WeakMap<object, string>();
const OCCURRENCE_KEY_PREFIX = "\u0000omp-tool:";

/** Resolve the occurrence-specific store key for one transcript tool call. */
export function toolEntryKey(call: { id: string }): string {
	return callEntryKeys.get(call) ?? call.id;
}

/** The stock call id and the occurrence an entry key was allocated for. */
function parseEntryKey(key: string): { callId: string; occurrence: number } {
	if (!key.startsWith(OCCURRENCE_KEY_PREFIX)) return { callId: key, occurrence: 0 };
	const parsed: unknown = JSON.parse(key.slice(OCCURRENCE_KEY_PREFIX.length));
	return Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "number"
		? { callId: parsed[0], occurrence: parsed[1] }
		: { callId: key, occurrence: 0 };
}

/** The stock call id an occurrence-specific store key was allocated for. */
export function callIdOfEntryKey(key: string): string {
	return parseEntryKey(key).callId;
}

/**
 * One call of one stock message: the message's creation timestamp (the identity the messages
 * store and the transcript share) with the call id, unique inside a message.
 */
function callIdentity(message: AgentMessage, callId: string): string | undefined {
	return message.timestamp === undefined ? undefined : `${String(message.timestamp)}\u0000${callId}`;
}

export const createToolsStore = () => {
	let nextOccurrenceByCallId = new Map<string, number>();
	let latestEntryKeyByCallId = new Map<string, string>();
	let streamEntryKeysByIndex = new Map<number, string>();
	/** Timestamp of the assistant message `streamEntryKeysByIndex` belongs to. */
	let streamMessageTimestamp: AgentMessage["timestamp"] | undefined;
	let queuedExecutionKeysByCallId = new Map<string, string[]>();
	let runningEntryKeyByCallId = new Map<string, string>();
	let readTargets = new Map<string, { path: string; selector?: string } | null>();
	/** Revision of the last live write per key since the last rebuild (`keepChangedSince`). */
	let writtenAt = new Map<string, number>();
	/**
	 * Keys finished by `tool_execution_end` since the last `agent_end`, per raw
	 * call id in end order. `agent_end` points them at the committed result
	 * messages so the event's own copy of the payload can be released.
	 */
	let uncommittedKeysByCallId = new Map<string, string[]>();
	/**
	 * Keys of calls whose assistant message has ended (its `message_end`, or a transcript),
	 * by `callIdentity`. A late frame behind a snapshot, or a replayed one, finds the call's
	 * entry here instead of opening a second entry that would take its execution events.
	 */
	let endedCallKeys = new Map<string, string>();
	/**
	 * Timestamps of the assistant messages that ended. Their late or replayed stream frames
	 * change nothing, nor the stream of the message after them.
	 */
	let endedMessages = new Set<string>();

	const resetEntryKeyTracking = (): void => {
		nextOccurrenceByCallId = new Map();
		latestEntryKeyByCallId = new Map();
		streamEntryKeysByIndex = new Map();
		streamMessageTimestamp = undefined;
		queuedExecutionKeysByCallId = new Map();
		runningEntryKeyByCallId = new Map();
		writtenAt = new Map();
		uncommittedKeysByCallId = new Map();
		endedCallKeys = new Map();
		endedMessages = new Set();
		readTargets = new Map();
	};

	const allocateEntryKey = (callId: string): string => {
		const occurrence = nextOccurrenceByCallId.get(callId) ?? 0;
		nextOccurrenceByCallId.set(callId, occurrence + 1);
		const key = occurrence === 0 ? callId : `${OCCURRENCE_KEY_PREFIX}${JSON.stringify([callId, occurrence])}`;
		latestEntryKeyByCallId.set(callId, key);
		return key;
	};

	const bindCallEntryKey = (call: object, callId: string, key: string): void => {
		callEntryKeys.set(call, key);
		latestEntryKeyByCallId.set(callId, key);
	};

	const queueExecutionKey = (callId: string, key: string): void => {
		const queue = queuedExecutionKeysByCallId.get(callId);
		if (queue) queue.push(key);
		else queuedExecutionKeysByCallId.set(callId, [key]);
	};

	const queueUncommittedKey = (callId: string, key: string): void => {
		const queue = uncommittedKeysByCallId.get(callId);
		if (queue) queue.push(key);
		else uncommittedKeysByCallId.set(callId, [key]);
	};

	/**
	 * The entry a `tool_execution_start` runs: the call its message queued, else the latest call
	 * with this id that has no result yet — including the `aborted` placeholders a history
	 * rebuild leaves behind, so a late start promotes that card instead of opening a second one
	 * for the same invocation. Undefined when that call already reported its result: a start
	 * behind a snapshot that holds the result, or a replay (a new call always ends its message
	 * first, and a tab that missed that end rebuilds from the transcript on return).
	 */
	const takeExecutionKey = (callId: string, lookup: (key: string) => ToolEntry | undefined): string | undefined => {
		const queue = queuedExecutionKeysByCallId.get(callId);
		const queued = queue?.shift();
		if (queue?.length === 0) queuedExecutionKeysByCallId.delete(callId);
		if (queued) return queued;

		const latest = latestEntryKeyByCallId.get(callId);
		const latestEntry = latest ? lookup(latest) : undefined;
		if (!latest || !latestEntry) return allocateEntryKey(callId);
		return latestEntry.status === "done" || latestEntry.status === "error" ? undefined : latest;
	};

	/**
	 * Join stock read metadata (gui-bridge stream-metadata.ts) to its call. It travels on the
	 * bridge socket, not stdout, so it can come before or after the call's own frames, and no
	 * snapshot reports a call that has not started yet: a call without an entry takes it at
	 * execution start, and a rebuild joins it again.
	 */
	const joinReadTarget = (
		callId: string,
		target: { path: string; selector?: string } | null,
		lookup: (key: string) => ToolEntry | undefined,
		write: (key: string, entry: ToolEntry) => void,
	): void => {
		readTargets.set(callId, target);
		const running = runningEntryKeyByCallId.get(callId);
		const key = running ?? latestEntryKeyByCallId.get(callId);
		const existing = key ? lookup(key) : undefined;
		if (!key || !existing) return;
		write(key, { ...existing, args: { ...existing.args, __ompReadGroup: target } });
		if (running) readTargets.delete(callId);
	};

	return createStore<ToolsStore>()((set, get) => ({
		finishedTools: new Map(),
		finishedVersion: 0,
		hydrationVersion: 0,
		liveTools: new Map(),
		partialResults: new Map(),
		revision: 0,
		entryKeyForCallId: id => latestEntryKeyByCallId.get(id) ?? id,
		hydrateMessages: (messages, options) => {
			const now = Date.now();
			const since = options?.keepChangedSince;
			const state = get();
			const previousRunning = runningEntryKeyByCallId;
			const previousQueued = queuedExecutionKeysByCallId;
			const previousStreaming = streamEntryKeysByIndex;
			const previousStreamTimestamp = streamMessageTimestamp;
			const previousWritten = writtenAt;
			const previousUncommitted = uncommittedKeysByCallId;
			const previousEnded = endedCallKeys;
			const previousEndedMessages = endedMessages;
			const previousReadTargets = readTargets;
			resetEntryKeyTracking();

			// Pair repeated raw ids by occurrence, not with a last-write-wins map.
			const results = resultsByCallId(messages);
			const resultIndexes = new Map<string, number>();

			const tools = new Map<string, ToolEntry>();
			// A committed assistant message whose calls were never answered is a
			// dead letter — unless the turn that produced it is still running and
			// nothing but its calls' results was committed after it (parallel calls
			// answer one by one). Only that trailing case stays live.
			let trailingUnanswered: string[] = [];
			let trailingMessage: AgentMessage | null = null;
			for (const message of messages) {
				if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
				if (message.timestamp !== undefined) endedMessages.add(String(message.timestamp));
				const unanswered: string[] = [];
				for (const block of message.content) {
					if (block.type !== "toolCall") continue;
					const key = allocateEntryKey(block.id);
					bindCallEntryKey(block, block.id, key);
					const identity = callIdentity(message, block.id);
					if (identity) endedCallKeys.set(identity, key);
					const resultIndex = resultIndexes.get(block.id) ?? 0;
					const result = results.get(block.id)?.[resultIndex];
					resultIndexes.set(block.id, resultIndex + 1);
					if (!result) unanswered.push(key);
					tools.set(key, transcriptEntry(block, message, result, now));
				}
				if (unanswered.length > 0) {
					trailingUnanswered = unanswered;
					trailingMessage = message;
				}
			}
			const trailingIndex = trailingMessage ? messages.lastIndexOf(trailingMessage) : -1;
			if (
				options?.turnIsLive &&
				trailingIndex >= 0 &&
				messages.slice(trailingIndex + 1).every(message => message.role === "toolResult")
			) {
				for (const key of trailingUnanswered) {
					const entry = tools.get(key);
					if (entry) tools.set(key, { ...entry, status: "running" });
				}
			}
			const partialResults = new Map<string, unknown>();
			if (since !== undefined) {
				const kept = new Set<string>();
				const transcriptKeys = new Set(tools.keys());
				const keep = (key: string, entry: ToolEntry): void => {
					kept.add(key);
					tools.set(key, entry);
				};
				for (const [key, revision] of previousWritten) {
					if (revision <= since) continue;
					const entry = selectToolEntry(state, key);
					// A persisted result settles a call that has none of its own (an end event
					// was missed). Preserve fresher wire evidence, not an in-flight placeholder.
					const settled = tools.get(key)?.result;
					if (entry && !(settled && entry.result == null)) keep(key, entry);
				}
				// In-flight calls the transcript does not contain yet.
				for (const [key, entry] of state.liveTools) if (!kept.has(key) && !tools.has(key)) keep(key, entry);
				// A call that reported its result live while the snapshot does not hold the result
				// message yet (stock persists it right after the end event): that result stands.
				for (const [identity, key] of previousEnded) {
					if (kept.has(key) || endedCallKeys.get(identity) !== key || tools.get(key)?.result != null) continue;
					const entry = selectToolEntry(state, key);
					if (entry?.status === "done" || entry?.status === "error") keep(key, entry);
				}
				// Kept calls the transcript does not hold keep their keys: later frames for them
				// resolve there, and the next call with the same id gets the next key, not theirs.
				for (const key of kept) {
					if (transcriptKeys.has(key)) continue;
					const { callId, occurrence } = parseEntryKey(key);
					if (occurrence < (nextOccurrenceByCallId.get(callId) ?? 0)) continue;
					nextOccurrenceByCallId.set(callId, occurrence + 1);
					latestEntryKeyByCallId.set(callId, key);
				}
				for (const [callId, key] of previousRunning) {
					if (!kept.has(key)) continue;
					runningEntryKeyByCallId.set(callId, key);
					latestEntryKeyByCallId.set(callId, key);
				}
				for (const [callId, keys] of previousQueued) {
					for (const key of keys) if (kept.has(key)) queueExecutionKey(callId, key);
				}
				for (const [callId, keys] of previousUncommitted) {
					for (const key of keys) if (kept.has(key)) queueUncommittedKey(callId, key);
				}
				for (const [identity, key] of previousEnded)
					if (kept.has(key) && !endedCallKeys.has(identity)) endedCallKeys.set(identity, key);
				for (const timestamp of previousEndedMessages) endedMessages.add(timestamp);
				for (const key of kept)
					if (state.partialResults.has(key)) partialResults.set(key, state.partialResults.get(key));
				const streaming = [...previousStreaming].filter(([, key]) => kept.has(key));
				if (streaming.length > 0) {
					streamEntryKeysByIndex = new Map(streaming);
					streamMessageTimestamp = previousStreamTimestamp;
				}
				// Read metadata no snapshot carries for a call that has not started yet.
				for (const [callId, target] of previousReadTargets)
					joinReadTarget(
						callId,
						target,
						key => tools.get(key),
						(key, entry) => tools.set(key, entry),
					);
			}
			set({
				...toolEntriesState(tools),
				finishedVersion: state.finishedVersion + 1,
				hydrationVersion: state.hydrationVersion + 1,
				partialResults,
			});
		},
		prependMessages: (older, loaded, options) => {
			const rebuild = () => get().hydrateMessages([...older, ...loaded], options);
			if (loaded.length === 0) return rebuild();
			const results = resultsByCallId(older);
			const calls = new Map<string, number>();
			for (const message of older) {
				if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
				for (const block of message.content) {
					if (block.type !== "toolCall") continue;
					// The same raw id again would shift the occurrence keys of the loaded calls.
					if (nextOccurrenceByCallId.has(block.id)) return rebuild();
					calls.set(block.id, (calls.get(block.id) ?? 0) + 1);
				}
			}
			for (const callId of results.keys()) if (!calls.has(callId)) return rebuild();
			const unanswered = new Set<string>();
			for (const [callId, count] of calls) if ((results.get(callId)?.length ?? 0) < count) unanswered.add(callId);
			if (
				unanswered.size > 0 &&
				loaded.some(message => message.role === "toolResult" && unanswered.has(message.toolCallId ?? ""))
			)
				return rebuild();
			const now = Date.now();
			const resultIndexes = new Map<string, number>();
			const entries: [string, ToolEntry][] = [];
			for (const message of older) {
				if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
				if (message.timestamp !== undefined) endedMessages.add(String(message.timestamp));
				for (const block of message.content) {
					if (block.type !== "toolCall") continue;
					const key = allocateEntryKey(block.id);
					bindCallEntryKey(block, block.id, key);
					const identity = callIdentity(message, block.id);
					if (identity) endedCallKeys.set(identity, key);
					const resultIndex = resultIndexes.get(block.id) ?? 0;
					resultIndexes.set(block.id, resultIndex + 1);
					entries.push([key, transcriptEntry(block, message, results.get(block.id)?.[resultIndex], now)]);
				}
			}
			if (entries.length === 0) return;
			// Older calls are never the streaming turn's: every one is terminal.
			const state = get();
			set({
				finishedTools: new Map([...entries, ...state.finishedTools]),
				finishedVersion: state.finishedVersion + 1,
			});
		},
		applyEvents: events => {
			const state = get();
			// The finished map changes in place; the live set and the partial
			// slots are copied on first write. Batches without tool events (the
			// common case — text/thinking deltas) write nothing and publish nothing.
			const finished = state.finishedTools;
			let live: Map<string, ToolEntry> | null = null;
			let partials: Map<string, unknown> | null = null;
			let finishedChanged = false;
			let wrote = false;
			const revision = state.revision + 1;
			const liveNow = (): ReadonlyMap<string, ToolEntry> => live ?? state.liveTools;
			const writableLive = () => (live ??= new Map(state.liveTools));
			const lookup = (key: string): ToolEntry | undefined => liveNow().get(key) ?? finished.get(key);
			const put = (key: string, entry: ToolEntry): void => {
				wrote = true;
				writtenAt.set(key, revision);
				if (entry.status === "pending" || entry.status === "running") {
					writableLive().set(key, entry);
					if (finished.delete(key)) finishedChanged = true;
					return;
				}
				if (liveNow().has(key)) writableLive().delete(key);
				finished.set(key, entry);
				finishedChanged = true;
			};

			for (const event of events) {
				switch (event.type) {
					case "read_group_metadata":
						joinReadTarget(event.toolCallId, event.target, lookup, put);
						break;
					case "message_start": {
						// Only assistant messages stream. A late or replayed start of an ended message,
						// or of the one streaming now, leaves the stream's call keys alone.
						const timestamp = event.message.timestamp;
						if (
							event.message.role !== "assistant" ||
							timestamp === streamMessageTimestamp ||
							endedMessages.has(String(timestamp))
						)
							break;
						streamEntryKeysByIndex.clear();
						streamMessageTimestamp = timestamp;
						break;
					}
					case "message_update": {
						// Its message ended already (a snapshot holds it, or this is a replay): nothing streams.
						if (endedMessages.has(String(event.message.timestamp))) break;
						// A tab that sat in the background missed this message's
						// message_start (and maybe the previous one's message_end), so
						// the index → key map can still hold the last message's calls.
						// Same new-message test as the messages store: the timestamp.
						if (streamMessageTimestamp !== event.message.timestamp) {
							streamEntryKeysByIndex.clear();
							streamMessageTimestamp = event.message.timestamp;
						}
						const ame = event.assistantMessageEvent;
						if (ame.type === "toolcall_delta") {
							// The wire shape is `{contentIndex, delta, partial}` (pi-ai):
							// `partial` is the full streamed message so far and its
							// content[contentIndex] toolCall block carries the final
							// tool-call id from the very first delta.
							const block = Array.isArray(ame.partial?.content) ? ame.partial.content[ame.contentIndex] : null;
							if (block?.type !== "toolCall") break;
							let key = streamEntryKeysByIndex.get(ame.contentIndex);
							if (!key) {
								key = allocateEntryKey(block.id);
								streamEntryKeysByIndex.set(ame.contentIndex, key);
							}
							bindCallEntryKey(block, block.id, key);
							const existing = lookup(key);
							const previous = existing?.streamingArgs ?? "";
							const streamingArgs = previous + (ame.delta ?? "");
							// The deltas are the wire's only source of a streaming call's arguments
							// (`partial.arguments` stays `{}` for short calls): show them as they arrive.
							const args =
								streamingParseStep(streamingArgs.length) === streamingParseStep(previous.length)
									? undefined
									: parseStreamingArgs(streamingArgs);
							if (existing) {
								put(key, { ...existing, ...(args ? { args } : {}), streamingArgs });
							} else {
								put(key, {
									toolName: block.name ?? "unknown",
									args: args ?? {},
									intent: block.intent,
									status: "pending",
									streamingArgs,
									result: null,
									isError: false,
									startTime: Date.now(),
									endTime: null,
								});
							}
						}
						break;
					}
					case "message_end": {
						if (event.message.role !== "assistant" || !Array.isArray(event.message.content)) break;
						const timestamp = String(event.message.timestamp);
						if (endedMessages.has(timestamp)) {
							// A late or replayed end of a message the store already holds: its entries
							// keep their state and execution routes, and the stream after it its keys;
							// this copy's calls only resolve to those entries.
							for (const block of event.message.content) {
								if (block.type !== "toolCall") continue;
								const ended = endedCallKeys.get(callIdentity(event.message, block.id) ?? "");
								if (ended) callEntryKeys.set(block, ended);
							}
							break;
						}
						if (event.message.timestamp !== undefined) endedMessages.add(timestamp);
						for (const [contentIndex, block] of event.message.content.entries()) {
							if (block.type !== "toolCall") continue;
							const identity = callIdentity(event.message, block.id);
							const key = streamEntryKeysByIndex.get(contentIndex) ?? allocateEntryKey(block.id);
							bindCallEntryKey(block, block.id, key);
							queueExecutionKey(block.id, key);
							if (identity) endedCallKeys.set(identity, key);
							const existing = lookup(key);
							if (existing) {
								// Bridge read metadata can reach the call before its message ends.
								const readGroup = existing.args.__ompReadGroup;
								put(key, {
									...existing,
									toolName: block.name,
									args:
										readGroup !== undefined && !("__ompReadGroup" in block.arguments)
											? { ...block.arguments, __ompReadGroup: readGroup }
											: block.arguments,
									intent: block.intent ?? existing.intent,
								});
							} else {
								put(key, {
									toolName: block.name,
									args: block.arguments,
									intent: block.intent,
									status: "pending",
									streamingArgs: "",
									result: null,
									isError: false,
									startTime: timestampMs(event.message.timestamp, Date.now()),
									endTime: null,
								});
							}
						}
						streamEntryKeysByIndex.clear();
						break;
					}
					case "tool_execution_start": {
						const key = takeExecutionKey(event.toolCallId, lookup);
						if (!key) break;
						latestEntryKeyByCallId.set(event.toolCallId, key);
						runningEntryKeyByCallId.set(event.toolCallId, key);
						const existing = lookup(key);
						const existingArgs = existing?.args;
						put(key, {
							toolName: event.toolName,
							intent: event.intent,
							args: readTargets.has(event.toolCallId)
								? { ...event.args, __ompReadGroup: readTargets.get(event.toolCallId) }
								: existingArgs && "__ompReadGroup" in existingArgs
									? { ...event.args, __ompReadGroup: existingArgs.__ompReadGroup }
									: event.args,
							status: "running",
							streamingArgs: "",
							result: null,
							isError: false,
							// A replayed start leaves the running clock where it was.
							startTime: existing?.status === "running" ? existing.startTime : Date.now(),
							endTime: null,
						});
						readTargets.delete(event.toolCallId);
						break;
					}
					case "tool_execution_update": {
						const key =
							runningEntryKeyByCallId.get(event.toolCallId) ?? latestEntryKeyByCallId.get(event.toolCallId);
						const status = key ? lookup(key)?.status : undefined;
						if (key && (status === "running" || status === "pending")) {
							partials ??= new Map(state.partialResults);
							partials.set(key, event.partialResult);
							writtenAt.set(key, revision);
							wrote = true;
						}
						break;
					}
					case "tool_execution_end": {
						const key =
							runningEntryKeyByCallId.get(event.toolCallId) ?? latestEntryKeyByCallId.get(event.toolCallId);
						const existing = key ? lookup(key) : undefined;
						// A settled call keeps its result and its end time: this end is late or a replay.
						if (key && existing && existing.status !== "done" && existing.status !== "error") {
							put(key, {
								...existing,
								status: resultStatus(event.result, event.isError),
								result: event.result,
								isError: event.isError ?? false,
								endTime: Date.now(),
							});
							queueUncommittedKey(event.toolCallId, key);
						}
						runningEntryKeyByCallId.delete(event.toolCallId);
						break;
					}
					case "agent_end": {
						// The run's results are committed now: point finished entries at
						// the committed messages (the transcript keeps those) instead of
						// the end events' own copies, and release their partial slots.
						// Results are matched from the newest backwards: a tab that was
						// in the background saw only the run's later end events.
						const committed = event.messages ?? [];
						for (let index = committed.length - 1; index >= 0; index--) {
							const message = committed[index];
							if (message?.role !== "toolResult" || !message.toolCallId) continue;
							const key = uncommittedKeysByCallId.get(message.toolCallId)?.pop();
							const entry = key ? finished.get(key) : undefined;
							if (
								!key ||
								!entry ||
								!message.entryId ||
								entry.toolName !== (message.toolName ?? entry.toolName) ||
								entry.isError !== (message.isError ?? false)
							)
								continue;
							finished.set(key, {
								...entry,
								result: { content: message.content ?? null, details: message.details ?? null },
							});
							finishedChanged = true;
						}
						uncommittedKeysByCallId = new Map();
						const current = partials ?? state.partialResults;
						if (current.size > 0) {
							partials = new Map();
							for (const [key, partial] of current) if (liveNow().has(key)) partials.set(key, partial);
						}
						break;
					}
					default:
						break;
				}
			}

			if (!wrote && !finishedChanged && !live && !partials) return;
			set({
				...(live ? { liveTools: live } : {}),
				...(partials ? { partialResults: partials } : {}),
				...(finishedChanged ? { finishedVersion: state.finishedVersion + 1 } : {}),
				...(wrote ? { revision } : {}),
			});
		},
		reset: () => {
			resetEntryKeyTracking();
			const state = get();
			set({
				finishedTools: new Map(),
				finishedVersion: state.finishedVersion + 1,
				hydrationVersion: 0,
				liveTools: new Map(),
				partialResults: new Map(),
				revision: state.revision + 1,
			});
		},
	}));
};

const defaultToolsStore = createToolsStore();
export const useToolsStore = createScopedStoreHook("tools", defaultToolsStore);
