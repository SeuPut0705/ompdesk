/**
 * ChatStream pure helpers: transcript row construction, todo snapshot
 * interleaving, and timeline marker derivation. Extracted verbatim from
 * ChatStream.tsx so the renderer keeps only its UI and state wiring.
 */

import type { AgentMessage, MessageContent } from "../../../shared/rpc-types";
import { resultDetails } from "../../lib/format";
import { messageIdentity } from "../../lib/message-identity";
import { isRenderableMessageText, messageText, splitReaction } from "../../lib/messages";
import type { ReadGroupEntry, ReadGroupUsage } from "../../lib/read-group";
import type { TodoSnapshot } from "../../stores/todo";
import { type ToolEntry, toolEntryKey } from "../../stores/tools";
import type { TranscriptDetail } from "../../stores/ui";
import { isCustomMessageCardType } from "./CustomMessageCard";
import { asyncResultJobs, completionFailureCount, isCompletionMessage } from "./completion-events";
import { parseTodoReminder } from "./todo-reminder";
import { isWorkReply, messageTimestampMs } from "./work-turn";

interface ProcessMeta {
	stepCount: number;
	failedEvents: number;
	toolCallIds: string[];
	toolNames: string[];
	/** Timestamp of stock's empty aborted reply; partial content means the model, not a tool, was cut. */
	stoppedAt?: number;
	/** Todo changes belong to this work run permanently, including after completion. */
	todoSnapshots?: readonly TodoSnapshot[];
	notes?: readonly AgentMessage[];
	/** User turn boundary, including user messages hidden from the rendered transcript. */
	turnStartedAt?: number;
}

type TimelineState = "done" | "running" | "error" | "launch";

export interface TimelineMarkerSeed {
	state: TimelineState;
	timestamp?: number | string;
	toolIds: string[];
}

export interface ConversationAnchor {
	key: string;
	rowIndex: number;
	preview: string;
	timestamp?: number | string;
}

const CONVERSATION_PREVIEW_LIMIT = 180;

/** Slack still counted as "the live edge" when deciding whether to follow the tail.
 * A single CSS pixel was brittle: row re-measurement, font loading and fractional
 * scrollTop routinely leave a few pixels under the last row, which read as "the
 * user scrolled away" and stopped all tail following. */
export const LIVE_EDGE_SLACK_PX = 24;

/** True at the live edge, within the tail-following slack. */
export function isTranscriptAtLiveEdge(metrics: {
	scrollHeight: number;
	scrollTop: number;
	clientHeight: number;
}): boolean {
	return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < LIVE_EDGE_SLACK_PX;
}

/** Direction of the reader's last viewport gesture: `true` toward the tail, `false`
 * away from it, `null` when the movement was not attributed to a gesture at all (a
 * restored view, a scrollbar press, a touch flick). */
export type GestureTowardTail = boolean | null;

/** Re-engaging the tail is a claim about reader intent, so it takes a gesture toward
 * the tail rather than a viewport that merely happens to sit there. A tail-follow
 * write that slips into the same frame as an upward gesture lands at the live edge;
 * re-pinning from that position clears the gesture latch, every later append then
 * follows the tail again, and the view the reader just took is lost for the rest of
 * the run. Unattributed moves stay unpinned — releasing a drag or a flick at the edge
 * is the gesture that re-engages there. */
export function shouldRePinTranscript(gestureTowardTail: GestureTowardTail, atLiveEdge: boolean): boolean {
	return atLiveEdge && gestureTowardTail === true;
}

/** Puts the transcript at its live edge with one offset write — the only way the
 * follower may move the viewport. Never `scrollToEnd()`: TanStack runs it as an index
 * scroll whose reconcile loop re-targets the bottom on every frame the content grows,
 * for up to five seconds, and no reader gesture cancels it. Mid-stream the tail grows
 * every frame, so the loop is nearly always live, and a wheel-up landing inside it was
 * dragged straight back to the bottom by the next chunk. An offset scroll's reconcile
 * keeps its first target and only settles sub-pixel rounding, so after this write the
 * gesture-vetoed follow paths in ChatStream are the only thing that chases the tail. */
export function scrollTranscriptToTail(
	virtualizer: { scrollToOffset(offset: number): void },
	viewport: { scrollHeight: number; clientHeight: number },
): void {
	virtualizer.scrollToOffset(viewport.scrollHeight - viewport.clientHeight);
}

/**
 * How far from the end of the transcript a live commit can hand over rows, and
 * the largest growth that still reads as one turn. A wider jump is a hydrate or
 * a page of history arriving.
 */
export const ROW_ENTRANCE_TAIL_ROWS = 6;

export interface MountedTranscriptRow {
	index: number;
	key: string;
}

/** Bookkeeping for which rows have already been treated as arriving content. */
export interface RowEntranceState {
	sessionId: string | undefined;
	rowCount: number;
	seen: Set<string>;
}

export interface RowEntrancePass {
	sessionId: string | undefined;
	/**
	 * Whether this commit grew the transcript out of a live run. Hydration and
	 * pagination replace the message list without announcing an arrival, so a
	 * restored view must never cascade.
	 */
	live: boolean;
	rowKeys: readonly string[];
	mounted: readonly MountedTranscriptRow[];
}

export function createRowEntranceState(sessionId: string | undefined, rowKeys: readonly string[]): RowEntranceState {
	return { sessionId, rowCount: rowKeys.length, seen: new Set(rowKeys) };
}

/**
 * Claim the mounted rows whose content just arrived at the tail.
 *
 * Rows are recycled through the viewport, so mounting is not an arrival: an
 * entrance keyed on mount replays on every scroll, which is what made the
 * transcript's entrance motion unusable. A claim therefore needs a live run, a
 * row set that moved by one turn's worth at most, a slot at the end of the
 * transcript, and a key that has never been mounted before.
 */
export function claimRowEntrances(state: RowEntranceState, pass: RowEntrancePass): string[] {
	const { sessionId, live, rowKeys, mounted } = pass;
	if (state.sessionId !== sessionId) {
		// Switching sessions restores a view; none of it is content arriving.
		state.sessionId = sessionId;
		state.rowCount = rowKeys.length;
		state.seen = new Set(rowKeys);
		return [];
	}
	const jumped = Math.abs(rowKeys.length - state.rowCount) > ROW_ENTRANCE_TAIL_ROWS;
	state.rowCount = rowKeys.length;
	const tailFrom = rowKeys.length - 1 - ROW_ENTRANCE_TAIL_ROWS;
	const admitting = live && !jumped;

	const claims: string[] = [];
	for (const row of mounted) {
		if (state.seen.has(row.key)) continue;
		state.seen.add(row.key);
		if (!admitting || row.index < tailFrom) continue;
		claims.push(row.key);
	}
	return claims;
}

export type HistoryRow =
	| { kind: "message"; message: AgentMessage; reaction?: string }
	| { kind: "readGroup"; entries: ReadGroupEntry[]; usage?: ReadGroupUsage[] }
	| ({ kind: "process"; messages: AgentMessage[] } & ProcessMeta)
	| { kind: "todoSnapshot"; entry: TodoSnapshot };

/** Virtualized row: finalized history or one of the live streaming rows. */
export type Row =
	| HistoryRow
	| { kind: "streaming"; message: AgentMessage }
	| { kind: "pending" }
	| { kind: "expander"; count: number };
function messageKey(message: AgentMessage): string {
	const identity = messageIdentity(message);
	if (identity) return identity;
	const firstTool = messageContent(message).find(block => block.type === "toolCall");
	if (firstTool?.type === "toolCall") return toolEntryKey(firstTool);
	return `${message.role}-${String(message.timestamp ?? "untimed")}`;
}

function transcriptRowBaseKey(row: Row): string {
	switch (row.kind) {
		case "message":
			return `message-${messageKey(row.message)}`;
		case "process":
			// Compact mode may replace one live assistant row with a process row,
			// or split it into process + answer rows. Key the first finalized row
			// by the same assistant identity so the viewport anchor survives both.
			return `message-${messageKey(row.messages[0]!)}`;
		case "readGroup":
			return `read-${row.entries.map(entry => entry.toolKey).join("-")}`;
		case "todoSnapshot":
			return `todo-snapshot-${row.entry.id}`;
		case "streaming":
			// message_start and message_end carry the same assistant identity.
			// Reusing it prevents the virtualizer from replacing one huge measured
			// streaming row with a fresh 72px estimate, briefly clamping scrollTop
			// to the end before the finalized row is measured.
			return `message-${messageKey(row.message)}`;
		case "pending":
			return row.kind;
		case "expander":
			return "pre-compaction-expander";
	}
}

export function buildTranscriptRowKeys(rows: readonly Row[]): string[] {
	const occurrences = new Map<string, number>();
	return rows.map(row => {
		const base = transcriptRowBaseKey(row);
		const occurrence = occurrences.get(base) ?? 0;
		occurrences.set(base, occurrence + 1);
		return occurrence === 0 ? base : `${base}-${occurrence}`;
	});
}

function sameRowField(a: unknown, b: unknown): boolean {
	return (
		Object.is(a, b) ||
		(Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((value, index) => Object.is(value, b[index])))
	);
}

/**
 * Rebuilt rows that say exactly what their previous build said (same kind, every
 * field the same value, arrays element for element) keep the previous object, so
 * memoized row components skip them. A history page prepend or a live tail update
 * rebuilds every row while the rows already on screen are unchanged.
 */
export function reuseTranscriptRows<T extends Row>(
	previous: ReadonlyMap<string, T>,
	rows: readonly T[],
	keys: readonly string[],
): T[] {
	return rows.map((row, index) => {
		const earlier = previous.get(keys[index] ?? "");
		if (!earlier || earlier.kind !== row.kind) return row;
		const fields = Object.keys(row);
		if (fields.length !== Object.keys(earlier).length) return row;
		for (const field of fields) if (!sameRowField(Reflect.get(earlier, field), Reflect.get(row, field))) return row;
		return earlier;
	});
}

/** One stable minimap anchor per user-authored turn in the rendered row set. */
export function buildConversationAnchors(rows: readonly Row[], rowKeys: readonly string[]): ConversationAnchor[] {
	const anchors: ConversationAnchor[] = [];
	for (const [rowIndex, row] of rows.entries()) {
		if (row.kind !== "message" || row.message.role !== "user") continue;
		anchors.push({
			key: rowKeys[rowIndex] ?? `conversation-${rowIndex}`,
			rowIndex,
			preview: conversationPreview(messageText(row.message)),
			timestamp: row.message.timestamp,
		});
	}
	return anchors;
}

function conversationPreview(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= CONVERSATION_PREVIEW_LIMIT) return normalized;
	return `${normalized.slice(0, CONVERSATION_PREVIEW_LIMIT - 1).trimEnd()}…`;
}

/** Current user turn at or immediately before the reader's row (see `conversationReadingRowIndex`). */
export function findConversationAnchorIndex(anchors: readonly ConversationAnchor[], visibleRowIndex: number): number {
	if (anchors.length === 0) return -1;
	let low = 0;
	let high = anchors.length - 1;
	let match = 0;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		if (anchors[middle]!.rowIndex <= visibleRowIndex) {
			match = middle;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return match;
}

/** Transcript row the turn navigator treats as the reader's position: the first
 * row in view, except at the live edge, where it is the last. Trailing turns that
 * are short all fit below an earlier turn's tail, so the top row alone would leave
 * the current turn on an older one while the reader sits on the newest. */
export function conversationReadingRowIndex(
	range: { startIndex: number; endIndex: number },
	viewport: Parameters<typeof isTranscriptAtLiveEdge>[0],
): number {
	return isTranscriptAtLiveEdge(viewport) ? range.endIndex : range.startIndex;
}

/** Stable finalized-row identities used by the virtualizer and regression tests. */
export function buildHistoryRowKeys(rows: readonly HistoryRow[]): string[] {
	return buildTranscriptRowKeys(rows);
}

function messageContent(message: AgentMessage): MessageContent[] {
	if (Array.isArray(message.content)) return message.content;
	if (typeof message.content === "string") return [{ type: "text", text: message.content }];
	return [];
}

function splitMessageReaction(message: AgentMessage): { message: AgentMessage; reaction?: string } {
	if (message.role !== "assistant") return { message };
	if (typeof message.content === "string") {
		const split = splitReaction(message.content);
		return split.emoji ? { message: { ...message, content: split.body }, reaction: split.emoji } : { message };
	}
	if (!Array.isArray(message.content)) return { message };
	const index = message.content.findIndex(block => block.type === "text" && block.text.length > 0);
	const block = message.content[index];
	if (block?.type !== "text") return { message };
	const split = splitReaction(block.text);
	if (!split.emoji) return { message };
	const content = message.content.slice();
	content[index] = { ...block, text: split.body };
	return { message: { ...message, content }, reaction: split.emoji };
}

function messageToolIds(message: AgentMessage): string[] {
	return messageContent(message)
		.filter(block => block.type === "toolCall")
		.map(block => toolEntryKey(block));
}

/** A real narration/reasoning block starts a new visual execution phase. */
function hasProcessNarration(message: AgentMessage): boolean {
	return messageContent(message).some(block => {
		if (block.type === "text") return isRenderableMessageText(block.text);
		if (block.type === "thinking") return isRenderableMessageText(block.thinking);
		return false;
	});
}

/**
 * Keep zero-height/non-display messages out of the virtualizer. Estimating an
 * invisible toolResult row at 128px was the remaining source of blank bands
 * between cards; its content already lives in the matching ToolCard.
 */
export function isVisibleTranscriptMessage(message: AgentMessage): boolean {
	if (message.role === "toolResult") return false;
	// Stock's model-facing developer messages are never shown (TUI ui-helpers renders none); its
	// todo reminder is the one the live card showed, so it stays as that reminder.
	if (message.role === "developer") return parseTodoReminder(message) !== null;
	if ((message.role === "custom" || message.role === "hookMessage") && message.display === false) return false;
	if (
		message.role === "user" ||
		message.role === "bashExecution" ||
		message.role === "pythonExecution" ||
		message.role === "branchSummary" ||
		message.role === "compactionSummary" ||
		message.role === "fileMention" ||
		message.role === "custom" ||
		message.role === "hookMessage"
	) {
		return true;
	}
	if (message.errorMessage || message.steering) return true;
	return messageContent(message).some(block => {
		switch (block.type) {
			case "text":
				return isRenderableMessageText(block.text);
			case "thinking":
				return isRenderableMessageText(block.thinking);
			case "toolCall":
			case "image":
				return true;
		}
		return false;
	});
}

/** Whether the in-flight turn owns a real visible row right now. */
export function hasStreamingTranscriptContent(
	message: AgentMessage | null,
	streamingText: string,
	streamingThinking: string,
	liveTools: ReadonlyMap<string, ToolEntry>,
): boolean {
	if (!message) return false;
	if (isRenderableMessageText(streamingText) || isRenderableMessageText(streamingThinking)) return true;
	if (isVisibleTranscriptMessage(message)) return true;
	const streamStart = messageTimestampMs(message);
	for (const entry of liveTools.values()) {
		if ((entry.status === "pending" || entry.status === "running") && entry.startTime >= streamStart) return true;
	}
	return false;
}

function summarizeProcess(messages: AgentMessage[]): ProcessMeta {
	let thinkingCount = 0;
	let failedEvents = 0;
	const toolCallIds: string[] = [];
	const toolNames: string[] = [];
	for (const message of messages) {
		failedEvents += completionFailureCount(message);
		for (const block of messageContent(message)) {
			if (block.type === "thinking" && isRenderableMessageText(block.thinking)) thinkingCount++;
			if (block.type !== "toolCall") continue;
			toolCallIds.push(toolEntryKey(block));
			toolNames.push(block.name);
		}
	}
	return { stepCount: thinkingCount + toolCallIds.length, failedEvents, toolCallIds, toolNames };
}

/**
 * Build finalized transcript rows. Compact mode groups a run's reasoning and
 * tool-call messages into one visual phase while preserving the final answer.
 * A final assistant message containing both thinking and text is split: only
 * the thinking fragment joins the process row.
 */
export function buildHistoryRows(
	messages: AgentMessage[],
	detail: TranscriptDetail,
	preservedProcessStarts?: ReadonlySet<string>,
): HistoryRow[] {
	const rows: HistoryRow[] = [];
	// During-run notes and the run time each one is owned at (the shared run interval decides).
	const duringRunNotes = new Map<AgentMessage, number>();
	// Stock's persisted todo reminders, folded into the run they continued once rows exist.
	const reminders = new Set<AgentMessage>();
	let processMessages: AgentMessage[] = [];
	let reactionTargetIndex: number | undefined;
	let turnStartedAt: number | undefined;
	const flushProcess = () => {
		if (processMessages.length === 0) return;
		rows.push({ kind: "process", messages: processMessages, ...summarizeProcess(processMessages), turnStartedAt });
		processMessages = [];
	};

	for (let index = 0; index < messages.length; index++) {
		const incoming = messages[index];
		if (!incoming) continue;
		// Stock delivers a queued steer as a `steering` user message inside the
		// running loop. It redirects the open run instead of starting a turn.
		const steersRun =
			detail === "compact" && incoming.role === "user" && incoming.steering === true && processMessages.length > 0;
		if (incoming.role === "user" && !steersRun) {
			flushProcess();
			turnStartedAt = messageTimestampMs(incoming);
		}
		// Keep an explicitly opened live phase in place when it finalizes.
		if (preservedProcessStarts?.has(`message-${messageKey(incoming)}`)) flushProcess();
		let message = incoming;
		if (message.role === "assistant") {
			if (reactionTargetIndex !== undefined) {
				const split = splitMessageReaction(message);
				const target = rows[reactionTargetIndex];
				if (split.reaction && target?.kind === "message" && target.message.role === "user") {
					rows[reactionTargetIndex] = { ...target, reaction: split.reaction };
					message = split.message;
				}
			}
			reactionTargetIndex = undefined;
		}
		// toolResult/display:false/empty-filler messages must not split a process
		// run — they are invisible transport records, not transcript boundaries.
		if (!isVisibleTranscriptMessage(message)) continue;
		// Dedicated extension notices and mid-run steers belong to work, not a new
		// execution phase. Keep their transcript position until the shared run
		// interval assigns ownership.
		if (steersRun) {
			rows.push({ kind: "message", message });
			// A steer typed before the step it follows began streaming is still
			// delivered after that step: own it from its delivery position.
			const delivered = Math.max(...processMessages.map(entry => messageTimestampMs(entry)));
			duringRunNotes.set(message, Math.max(messageTimestampMs(message), delivered));
			continue;
		}
		// A todo reminder is not a phase boundary: the run it restarted continues the same card.
		if (detail === "compact" && parseTodoReminder(message)) {
			rows.push({ kind: "message", message });
			reminders.add(message);
			continue;
		}
		if (
			detail === "compact" &&
			isCustomMessageCardType(message.customType) &&
			processMessages.some(entry => messageContent(entry).some(block => block.type === "toolCall"))
		) {
			rows.push({ kind: "message", message });
			duringRunNotes.set(message, messageTimestampMs(message));
			continue;
		}
		if (
			detail !== "compact" ||
			message.role !== "assistant" ||
			message.errorMessage ||
			message.steering ||
			!Array.isArray(message.content)
		) {
			flushProcess();
			rows.push({ kind: "message", message });
			if (message.role === "user") reactionTargetIndex = rows.length - 1;
			continue;
		}

		const hasToolCall = message.content.some(block => block.type === "toolCall");
		const hasImage = message.content.some(block => block.type === "image");
		if (hasToolCall && !hasImage) {
			// Text accompanying a tool call is intermediate narration. Keep every
			// narrated phase in the same disclosure until the API delivers the final
			// answer, so a long run leaves one activity summary instead of a stack of
			// nearly identical completed rows.
			processMessages.push(message);
			continue;
		}

		const thinking = message.content.filter(
			block => block.type === "thinking" && isRenderableMessageText(block.thinking),
		);
		if (thinking.length > 0) {
			processMessages.push({ ...message, content: thinking });
			const coreMessage: AgentMessage = {
				...message,
				content: message.content.filter(block => block.type !== "thinking"),
			};
			if (isVisibleTranscriptMessage(coreMessage)) {
				flushProcess();
				rows.push({ kind: "message", message: coreMessage });
			}
			continue;
		}

		flushProcess();
		rows.push({ kind: "message", message });
	}
	flushProcess();
	// Stock's empty aborted reply after a tool stop is the run's own end: the card states
	// it as interrupted, so it never stands outside the card as a second "Stopped" row.
	const stops = new Set<number>();
	for (let index = 0; index < rows.length - 1; index++) {
		const row = rows[index];
		const next = rows[index + 1];
		if (
			row?.kind === "process" &&
			next?.kind === "message" &&
			next.message.role === "assistant" &&
			next.message.stopReason === "aborted" &&
			messageContent(next.message).length === 0
		) {
			rows[index] = { ...row, stoppedAt: messageTimestampMs(next.message) };
			stops.add(index + 1);
		}
	}
	return chargeJobFailures(
		foldTodoReminders(
			foldWorkNotes(stops.size ? rows.filter((_, index) => !stops.has(index)) : rows, duringRunNotes),
			reminders,
		),
		messages,
	);
}

/** One interval model for archived todos and custom notices. */
interface ProcessRun {
	index: number;
	start: number;
	turn: number;
	end: number;
	reply?: number;
}
function processRuns(rows: readonly HistoryRow[], notes?: ReadonlyMap<AgentMessage, number>) {
	const runs: ProcessRun[] = [];
	let turn = Number.NEGATIVE_INFINITY;
	for (const [index, row] of rows.entries()) {
		// A folded steer is part of its run, never a turn boundary.
		if (row.kind === "message" && row.message.role === "user" && !notes?.has(row.message)) {
			turn = messageTimestampMs(row.message);
			const previous = runs.at(-1);
			if (previous) previous.end = Math.min(previous.end, turn);
		} else if (row.kind === "process") {
			let start = Number.POSITIVE_INFINITY;
			for (const message of row.messages) {
				if (messageContent(message).some(block => block.type === "toolCall")) {
					start = Math.min(start, messageTimestampMs(message));
				}
			}
			if (!Number.isFinite(start) && row.messages[0]) start = messageTimestampMs(row.messages[0]);
			const boundary = row.turnStartedAt ?? turn;
			const previous = runs.at(-1);
			if (previous) previous.end = Math.min(previous.end, previous.turn === boundary ? start : boundary);
			runs.push({ index, start: Math.max(start, boundary), turn: boundary, end: Number.POSITIVE_INFINITY });
		} else if (row.kind === "message" && isWorkReply(row.message)) {
			const run = runs.at(-1);
			if (run) run.reply ??= messageTimestampMs(row.message);
		}
	}
	return runs;
}

function ownsRun(
	run: ProcessRun,
	timestamp: number,
	duringTurn?: boolean,
	capture?: Pick<TodoSnapshot, "turnStartedAt" | "endedAt">,
) {
	const capturedStart = capture?.turnStartedAt;
	if (capturedStart !== undefined) {
		// Capture provenance, not client receipt/assistant stream-start clocks,
		// bounds this turn. A hidden todo may precede its first visible tool.
		return (
			duringTurn !== false &&
			run.turn <= capturedStart &&
			run.start >= capturedStart &&
			run.start < (capture?.endedAt ?? Number.POSITIVE_INFINITY)
		);
	}
	return (
		duringTurn !== false &&
		timestamp >= run.start &&
		timestamp < run.end &&
		(duringTurn === true || run.reply === undefined || timestamp <= run.reply)
	);
}

function foldWorkNotes(rows: readonly HistoryRow[], duringRunNotes: ReadonlyMap<AgentMessage, number>): HistoryRow[] {
	const runs = processRuns(rows, duringRunNotes);
	const folded = rows.slice();
	const removed = new Set<number>();
	for (const [index, row] of rows.entries()) {
		const ownedAt = row.kind === "message" ? duringRunNotes.get(row.message) : undefined;
		if (row.kind !== "message" || ownedAt === undefined) continue;
		// Like todo.duringTurn, transcript-order evidence wins over a final
		// reply's stream-start timestamp; finishing must never eject a note.
		const run = runs.findLast(candidate => ownsRun(candidate, ownedAt, true));
		const work = run ? folded[run.index] : undefined;
		if (!run || work?.kind !== "process") continue;
		folded[run.index] = {
			...work,
			failedEvents: work.failedEvents + completionFailureCount(row.message),
			notes: [...(work.notes ?? []), row.message],
		};
		removed.add(index);
	}
	return folded.filter((_, index) => !removed.has(index));
}

/**
 * Stock persists its todo reminder between a run's stop and the run it restarts; live, the reminder
 * shows inside the running card. It belongs to the next work run of its turn, else the one it
 * followed; with neither (a text-only reply) it stays its own row.
 */
function foldTodoReminders(rows: readonly HistoryRow[], reminders: ReadonlySet<AgentMessage>): HistoryRow[] {
	if (reminders.size === 0) return rows as HistoryRow[];
	const folded = rows.slice();
	const removed = new Set<number>();
	for (const [index, row] of rows.entries()) {
		if (row.kind !== "message" || !reminders.has(row.message)) continue;
		const ownerToward = (step: 1 | -1) => {
			for (let at = index + step; at >= 0 && at < rows.length; at += step) {
				const candidate = rows[at];
				if (candidate?.kind === "process") return at;
				if (candidate?.kind === "message" && candidate.message.role === "user") return -1;
			}
			return -1;
		};
		const next = ownerToward(1);
		const owner = next === -1 ? ownerToward(-1) : next;
		const work = folded[owner];
		if (work?.kind !== "process") continue;
		const notes = work.notes ?? [];
		folded[owner] = { ...work, notes: next === -1 ? [...notes, row.message] : [row.message, ...notes] };
		removed.add(index);
	}
	return folded.filter((_, index) => !removed.has(index));
}

/**
 * A background job that fails after its run ended is that run's failure: stock's async-result
 * notice arrives later (usually waking a follow-up turn), so the run whose call started the job
 * (its result's `details.async.jobId`, tools/bash.ts `#buildBackgroundStartResult`) counts it.
 */
function chargeJobFailures(rows: readonly HistoryRow[], messages: readonly AgentMessage[]): HistoryRow[] {
	const failedJobs = rows.flatMap(row =>
		row.kind === "message"
			? asyncResultJobs(row.message).filter(job => job.status === "failed" && job.type !== "task")
			: [],
	);
	if (failedJobs.length === 0) return rows as HistoryRow[];
	const startedBy = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "toolResult" || !message.toolCallId) continue;
		const async = resultDetails(message)?.async;
		const jobId = typeof async === "object" && async !== null && "jobId" in async ? async.jobId : undefined;
		if (typeof jobId === "string") startedBy.set(jobId, message.toolCallId);
	}
	const charged = rows.slice();
	for (const job of failedJobs) {
		const callId = job.jobId === undefined ? undefined : startedBy.get(job.jobId);
		const owner = charged.findIndex(
			row =>
				row.kind === "process" &&
				row.messages.some(message =>
					messageContent(message).some(block => block.type === "toolCall" && block.id === callId),
				),
		);
		const work = charged[owner];
		if (callId === undefined || work?.kind !== "process") continue;
		charged[owner] = { ...work, failedEvents: work.failedEvents + 1 };
	}
	return charged;
}

/**
 * Fold changes captured during a run permanently into its process row.
 * Idle edits remain standalone; for older snapshots the final reply closes ownership.
 */
export function mergeTodoSnapshots(rows: readonly HistoryRow[], snapshots: readonly TodoSnapshot[]): HistoryRow[] {
	if (snapshots.length === 0) return rows as HistoryRow[];
	// Decide ownership against the complete transcript, not the row last visited
	// while interleaving: an assistant's timestamp is its stream start, and user
	// turn boundaries can be hidden from the rendered row set.
	const runs = processRuns(rows);
	const folded = rows.slice();
	const standalone: TodoSnapshot[] = [];
	for (const snapshot of snapshots) {
		const run =
			runs.findLast(
				candidate =>
					candidate.start <= snapshot.ts && ownsRun(candidate, snapshot.ts, snapshot.duringTurn, snapshot),
			) ??
			(snapshot.turnStartedAt === undefined
				? undefined
				: runs.find(candidate => ownsRun(candidate, snapshot.ts, snapshot.duringTurn, snapshot)));
		const row = run ? folded[run.index] : undefined;
		if (run && row?.kind === "process") {
			folded[run.index] = { ...row, todoSnapshots: [...(row.todoSnapshots ?? []), snapshot] };
		} else standalone.push(snapshot);
	}
	const out: HistoryRow[] = [];
	let next = 0;
	for (const row of folded) {
		const ts =
			row.kind === "message"
				? messageTimestampMs(row.message)
				: row.kind === "process" && row.messages[0]
					? messageTimestampMs(row.messages[0])
					: undefined;
		while (ts !== undefined && next < standalone.length && standalone[next]!.ts < ts) {
			out.push({ kind: "todoSnapshot", entry: standalone[next++]! });
		}
		out.push(row);
	}
	for (; next < standalone.length; next++) out.push({ kind: "todoSnapshot", entry: standalone[next]! });
	return out;
}

/** Which finalized process row absorbs the running turn's live steps. */
export function liveWorkTail(
	rows: readonly HistoryRow[],
	isStreaming: boolean,
): { liveTail: boolean; lastWorkRow: number } {
	let lastWorkRow = rows.length - 1;
	while (lastWorkRow >= 0 && rows[lastWorkRow]?.kind === "todoSnapshot") lastWorkRow--;
	const liveTail = isStreaming && rows[lastWorkRow]?.kind === "process";
	return { liveTail, lastWorkRow };
}

/**
 * Map finalized history rows onto semantic timeline phases. Full detail keeps
 * every tool message visible, but punctuation-only continuations share the
 * phase's first marker and timestamp. Tool state is aggregated so a later
 * running/error call still updates that one marker.
 */
export function buildTimelineMarkers(rows: readonly HistoryRow[]): Array<TimelineMarkerSeed | null> {
	const markers: Array<TimelineMarkerSeed | null> = rows.map(() => null);
	let phaseOwner: number | null = null;

	for (let index = 0; index < rows.length; index++) {
		const row = rows[index];
		if (!row) continue;

		if (row.kind === "message" && (row.message.errorMessage || isCompletionMessage(row.message))) {
			phaseOwner = null;
			markers[index] = {
				state: row.message.errorMessage || completionFailureCount(row.message) > 0 ? "error" : "launch",
				timestamp: row.message.timestamp,
				toolIds: messageToolIds(row.message),
			};
			continue;
		}

		let timestamp: number | string | undefined;
		let toolIds: string[] = [];
		let startsPhase = false;
		let state: TimelineState = "done";
		if (row.kind === "process") {
			timestamp = row.messages[0]?.timestamp;
			toolIds = row.toolCallIds;
			startsPhase = true;
			if (row.failedEvents > 0) state = "error";
		} else if (row.kind === "readGroup") {
			timestamp = row.usage?.[0]?.timestamp;
			toolIds = row.entries.map(entry => entry.toolKey);
		} else if (row.kind === "message") {
			timestamp = row.message.timestamp;
			toolIds = messageToolIds(row.message);
			startsPhase = hasProcessNarration(row.message);
		}

		if (toolIds.length === 0 && row.kind !== "process") {
			phaseOwner = null;
			continue;
		}

		if (phaseOwner === null || startsPhase) {
			phaseOwner = index;
			markers[index] = { state, timestamp, toolIds: [...toolIds] };
			continue;
		}

		const owner = markers[phaseOwner];
		if (!owner) continue;
		owner.toolIds.push(...toolIds);
		owner.timestamp ??= timestamp;
	}

	return markers;
}
