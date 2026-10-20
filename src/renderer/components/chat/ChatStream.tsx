import { type Range, useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import {
	ArrowDown,
	BookOpen,
	Bug,
	ChevronRight,
	Code2,
	History,
	Languages,
	Lightbulb,
	ListTodo,
	PenLine,
	SearchCode,
	Sparkles,
	WifiOff,
} from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentMessage, MessagesPage } from "../../../shared/rpc-types";
import { hydrateTabSession, loadOlderTranscript } from "../../hooks/session-hydration";
import { currentShellMode } from "../../hooks/use-shell-mode";
import { compactionActionKey } from "../../lib/compaction-action";
import { useDisplayPreference } from "../../lib/display-preferences";
import { cx, formatClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { prewarmMarkdown } from "../../lib/markdown";
import { abortActiveTurn, describeTurnError, isRenderableMessageText } from "../../lib/messages";
import { collapsibleReadTarget, groupReadRows, type ReadGroupEntry } from "../../lib/read-group";
import { useTabRpc } from "../../lib/tab-rpc";
import { summarizeMessagesOutput } from "../../lib/turn-meter";
import { useFirstRunStore } from "../../stores/first-run";
import { liveWorkKey, useLiveWorkStore } from "../../stores/live-work";
import { useMessagesStore } from "../../stores/messages";
import { useHostView } from "../../stores/remote";
import { useSessionStore } from "../../stores/session";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { useActiveTabKind, useAwaitingConnection, useResuming, useTabsStore } from "../../stores/tabs";
import { toastError } from "../../stores/toast";
import { type TodoSnapshot, useTodoStore } from "../../stores/todo";
import { type ToolEntry, toolEntryKey, useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { BrandMark, Button, Kbd, Skeleton, Spinner } from "../common";
import { FirstRunSetup, useFirstRunActive } from "../onboarding/FirstRunSetup";
import { ReadGroupCard } from "../tools/renderers/ReadGroupCard";
import { ToolCard } from "../tools/ToolCard";
import { ConversationNavigator } from "./ConversationNavigator";
import {
	buildConversationAnchors,
	buildHistoryRowKeys,
	buildHistoryRows,
	buildTranscriptRowKeys,
	claimRowEntrances,
	conversationReadingRowIndex,
	createRowEntranceState,
	findConversationAnchorIndex,
	type GestureTowardTail,
	type HistoryRow,
	isTranscriptAtLiveEdge,
	isVisibleTranscriptMessage,
	liveWorkTail,
	type MountedTranscriptRow,
	mergeTodoSnapshots,
	nextTranscriptIdentity,
	progressiveRange,
	type Row,
	replyMarkdownTail,
	reuseTranscriptRows,
	scrollTranscriptToTail,
	shouldRePinTranscript,
} from "./chat-stream-utils";
import { type ContentAnchor, contentAnchor } from "./content-anchor";
import { ExecutionGroup } from "./ExecutionGroup";
import { WorkCardPending } from "./LiveStepPeek";
import { MessageBubble } from "./MessageBubble";
import { PendingMailNotes } from "./PendingMailNotes";
import { installPaneKeys } from "./pane-keys";
import { StreamingText } from "./StreamingText";
import { installSelectionDrag, selectionRowSpan } from "./selection-drag";
import { ThinkingBlock } from "./ThinkingBlock";
import { TurnEndAnnouncer } from "./TurnEndAnnouncer";
import { estimateRowSize, RowSizeLearner, rowSizeKey } from "./transcript-row-estimate";
import { REVEAL_STEP_EVENT, type RevealStepRequest, revealStep, type StepReveal } from "./work/reveal-step";
import { StepGroups, useMountedCount } from "./work/StepGroups";
import { messageTimestampMs } from "./work/work-turn";

// TanStack's end check needs one CSS pixel for fractional scrollTop rounding.
// User intent is enforced separately by switching away from end anchoring.
const LIVE_EDGE_THRESHOLD_PX = 1;

/** Overscan rows not mounted yet that one commit may mount; on-screen rows never wait. */
const OVERSCAN_MOUNTS_PER_FRAME = 4;

/**
 * Rendered ahead of a history page's commit, one reply per task: the replies at the
 * page's end are the rows that commit mounts on screen when the page refolds the
 * rows the reader was on into an earlier card, and their markdown was most of it.
 */
function prewarmPageTail(page: MessagesPage): (() => void)[] {
	return replyMarkdownTail(page.messages, 6).map(source => () => prewarmMarkdown(source));
}

/** The reader's place across a history page prepend. */
interface PrependAnchor {
	/** Mounted rows from the viewport top down, each with the viewport top's distance below its top. */
	rows: { key: string; offset: number }[];
	/** The first of `rows` still keyed in the rebuilt transcript. */
	held?: { key: string; offset: number };
	/** The scroll offset when the page was requested, where the element still sits. */
	from: number;
	/**
	 * Where the prepend render read its range: an offset the anchor effect still
	 * has to write to the element, or null when the element is already there.
	 */
	moveTo?: number | null;
	/** The scroll offset was moved to `held`. */
	positioned?: boolean;
}

/**
 * Virtual-scroll message list. Stays pinned to the bottom while streaming
 * unless the user scrolls up; a floating "jump to latest" button appears when
 * unpinned. The in-flight assistant turn renders as live rows (thinking,
 * tool cards, streaming text) that unmount once message_end finalizes.
 */
export function ChatStream() {
	const tabId = useRuntimeTabId();
	const sessionId = useSessionStore(s => s.sessionId);
	// One transcript per session (nextTranscriptIdentity); a new identity remounts it.
	const [transcript, setTranscript] = useState({ sessionId, generation: 0 });
	const next = nextTranscriptIdentity(transcript, sessionId);
	if (next !== transcript) setTranscript(next);
	return <SessionTranscript key={`${tabId ?? ""}:${next.generation}`} />;
}

function SessionTranscript() {
	const t = useT();
	const tabId = useRuntimeTabId();
	const messages = useMessagesStore(s => s.messages);
	const liveMessages = useMessagesStore(s => s.liveMessages);
	const prevCursor = useMessagesStore(s => s.prevCursor);
	const isLoadingPage = useMessagesStore(s => s.isLoadingPage);
	const restoredAt = useMessagesStore(s => s.restoredAt);
	const pageError = useMessagesStore(s => s.pageError);
	const displayMessages = useMemo(() => [...messages, ...liveMessages], [messages, liveMessages]);
	const streamingMessage = useMessagesStore(s => s.streamingMessage);
	const hasStreamingText = useMessagesStore(s => isRenderableMessageText(s.streamingText));
	const hasStreamingThinking = useMessagesStore(s => isRenderableMessageText(s.streamingThinking));
	// Primitive-valued selector over the small live set: only the boolean this
	// row set cares about may re-render the whole transcript window.
	const hasLiveToolsForStream = useToolsStore(s => {
		if (!streamingMessage) return false;
		const streamStart = messageTimestampMs(streamingMessage);
		for (const entry of s.liveTools.values()) {
			if (entry.startTime >= streamStart) return true;
		}
		return false;
	});
	const isStreaming = useSessionStore(s => s.isStreaming);
	const awaitingModelSince = useSessionStore(s => s.awaitingModelSince);
	const retryInfo = useSessionStore(s => s.retryInfo);
	const compactionInfo = useSessionStore(s => s.compactionInfo);
	const pendingMail = useSessionStore(s => s.pendingMail);
	const awaitingConnection = useAwaitingConnection();
	const resuming = useResuming();
	const status = useSessionStore(s => s.status);
	const sessionId = useSessionStore(s => s.sessionId);
	// Shared agent compaction preference and GUI-local transcript detail.
	const collapseCompacted = useDisplayPreference("collapseCompacted");
	const transcriptDetail = useUiStore(s => s.transcriptDetail);
	const switchPending = useSessionStore(s => s.switchPending);
	// A tab that opens a session file that exists has history coming: its empty start is not "a new chat".
	const knownSession = useTabsStore(state => {
		const tab = state.tabs.find(entry => entry.id === tabId);
		return Boolean(tab?.sessionPath ?? tab?.pendingSessionPath);
	});
	const savedView = useSessionStore(s => s.transcriptView);
	const saveView = useSessionStore(s => s.saveTranscriptView);
	const [restoreView] = useState(() => (savedView?.sessionId === sessionId ? savedView : null));
	const [preCompactionOpen, setPreCompactionOpen] = useState(restoreView?.preCompactionOpen ?? false);
	const [expandedProcessKeys, setExpandedProcessKeys] = useState<Set<string>>(
		() => restoreView?.expandedProcessKeys ?? new Set(),
	);
	const [pinned, setPinned] = useState(restoreView?.pinned ?? true);
	const [visibleRowIndex, setVisibleRowIndex] = useState(Number.MAX_SAFE_INTEGER);
	// Virtualizer measurements and programmatic scrollToIndex both emit scroll
	// events. Only an actual wheel/touch/scrollbar/keyboard gesture may unpin the
	// transcript; otherwise a session hydrate can mistake its own layout shift
	// for user intent and strand the view in arbitrary history.
	const userScrollIntentRef = useRef(!pinned);
	// Where the reader was looking when they last moved the viewport themselves.
	const gestureAnchorRef = useRef<{ index: string; offset: number } | null>(null);
	// And which way they moved it: only a gesture toward the tail may re-engage
	// following, so a stray tail-follow write cannot masquerade as reader intent.
	const gestureTowardTailRef = useRef<GestureTowardTail>(null);

	const lastCompactionIndex = displayMessages.findLastIndex(message => message.role === "compactionSummary");
	const hiddenCount = collapseCompacted && !preCompactionOpen && lastCompactionIndex > 0 ? lastCompactionIndex : 0;
	const todoHistory = useTodoStore(s => s.history);
	const readTargets = useMessagesStore(s => s.readTargets);
	// The previous build's rows by key: rebuilt rows that did not change keep their
	// object so the memoized row components skip them (see reuseTranscriptRows).
	const builtRowsRef = useRef<ReadonlyMap<string, HistoryRow>>(new Map());
	const historyRows = useMemo<HistoryRow[]>(() => {
		const built = buildHistoryRows(
			hiddenCount > 0 ? displayMessages.slice(hiddenCount) : displayMessages,
			transcriptDetail,
			expandedProcessKeys,
		);
		// Read-tool grouping (TUI parity) folds consecutive collapsible reads into
		// one card — only in full mode; compact mode's ProcessGroup already folds
		// ALL consecutive tool work, so a second fold would nest redundantly.
		const grouped = transcriptDetail === "compact" ? built : (groupReadRows(built, readTargets) as HistoryRow[]);
		// Archived todo changes interleave by timestamp (transcript archive rows).
		const merged = mergeTodoSnapshots(grouped, todoHistory);
		const keys = buildHistoryRowKeys(merged);
		const reused = reuseTranscriptRows(builtRowsRef.current, merged, keys);
		builtRowsRef.current = new Map(reused.map((row, index) => [keys[index] ?? "", row]));
		return reused;
	}, [displayMessages, hiddenCount, transcriptDetail, todoHistory, expandedProcessKeys, readTargets]);

	// The assistant message exists as an empty shell from message_start until
	// the first delta — only real content swaps the status row for the
	// streaming rows, so the shell window never reads as dead air.
	const hasStreamedContent =
		streamingMessage != null &&
		(hasStreamingText ||
			hasStreamingThinking ||
			isVisibleTranscriptMessage(streamingMessage) ||
			hasLiveToolsForStream);

	// One status row for every "agent busy but nothing visible" window,
	// mirroring the TUI's loader line: auto-retry delay/attempt (warning),
	// auto-compaction maintenance, or waiting on the model's first event.
	// Priority matches the TUI, whose transient loaders replace the working
	// loader; tool-execution windows show running tool cards instead. The same
	// row carries the reports the bridge holds until the turn ends.
	const showStatusRow =
		awaitingConnection !== null ||
		resuming !== null ||
		retryInfo != null ||
		compactionInfo != null ||
		pendingMail.length > 0 ||
		(isStreaming && awaitingModelSince != null && !hasStreamedContent);
	// While a turn runs, its work stays ONE disclosure: the latest finalized
	// work row absorbs the streaming message's steps (and keeps the spinner
	// between steps) instead of a second live group mounting per step, so the
	// summary and its live log window never remount and flicker. Only the
	// reply text streams as its own row. History process rows exist in compact
	// detail only; full detail keeps per-message rows.
	const { liveTail, lastWorkRow } = liveWorkTail(historyRows, isStreaming);
	const tailRowIndex = liveTail ? (hiddenCount > 0 ? 1 : 0) + lastWorkRow : -1;
	const showStreamingRow = hasStreamedContent && (!liveTail || hasStreamingText);
	// Transcript state owns this handoff; virtualization never changes the dock.
	const carriesContext =
		liveTail ||
		(showStreamingRow &&
			transcriptDetail === "compact" &&
			(hasStreamingThinking ||
				hasLiveToolsForStream ||
				(Array.isArray(streamingMessage?.content) &&
					streamingMessage.content.some(block => block.type === "toolCall"))));
	useLayoutEffect(() => {
		const key = liveWorkKey(tabId);
		useLiveWorkStore.getState().setCarried(key, carriesContext);
		return () => useLiveWorkStore.getState().setCarried(key, false);
	}, [tabId, carriesContext]);

	// Streaming deltas rerender this component for the live row, but they do not
	// change finalized history. Keep the O(history) row/key projection stable so
	// a long transcript does not get rebuilt for every token.
	const { rows, rowKeys } = useMemo(() => {
		const nextRows: Row[] = [];
		if (hiddenCount > 0) {
			nextRows.push({ kind: "expander", count: hiddenCount });
		}
		nextRows.push(...historyRows);
		if (showStreamingRow && streamingMessage) {
			nextRows.push({ kind: "streaming", message: streamingMessage });
		}
		if (showStatusRow) {
			nextRows.push({ kind: "pending" });
		}
		return {
			rows: nextRows,
			rowKeys: buildTranscriptRowKeys(nextRows),
		};
	}, [hiddenCount, historyRows, showStreamingRow, showStatusRow, streamingMessage]);
	// One live card per session: only the newest work row (the live tail, else the
	// last process/streaming row) may still run; every earlier card is resolved.
	const currentWorkRow = liveTail
		? tailRowIndex
		: rows.findLastIndex(row => row.kind === "process" || row.kind === "streaming");

	const parentRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLDivElement>(null);
	const conversationAnchors = useMemo(() => buildConversationAnchors(rows, rowKeys), [rows, rowKeys]);
	const tailRowKey = rowKeys.at(-1);
	const activeConversationIndex = useMemo(
		() => findConversationAnchorIndex(conversationAnchors, visibleRowIndex),
		[conversationAnchors, visibleRowIndex],
	);
	const viewRef = useRef({ pinned, preCompactionOpen, expandedProcessKeys });
	viewRef.current = { pinned, preCompactionOpen, expandedProcessKeys };
	const emptyRef = useRef(true);
	emptyRef.current = rows.length === 0;

	// Whether the tail belongs to the follower. An upward gesture is the only thing
	// that revokes it: `pinned` carries the reader's intent, and the measured edge is
	// the fallback for a stale unpinned flag from a restored view. Reading only the
	// measured edge let one frame of lag strand the stream — a follow write lands on
	// the edge of the layout it was issued against, which trails a row that is still
	// growing, so the view fell outside the edge slack and the tail was abandoned for
	// the rest of the run.
	const followsTail = useCallback(
		(metrics: Parameters<typeof isTranscriptAtLiveEdge>[0]) =>
			viewRef.current.pinned || (isTranscriptAtLiveEdge(metrics) && gestureTowardTailRef.current !== false),
		[],
	);

	const followedSizeRef = useRef(0);
	// A web page's transcript column on a phone or tablet (its width, kept by the resize observer below; null in a
	// desktop window) and what its rows measured by kind: the row estimates' inputs (transcript-row-estimate.ts).
	const columnWidthRef = useRef<number | null>(null);
	const shellMode = currentShellMode();
	const columnRef = useRef<{ width: number; phone: boolean } | null>(null);
	columnRef.current =
		shellMode === null ? null : { width: columnWidthRef.current ?? window.innerWidth, phone: shellMode === "phone" };
	const rowSizesRef = useRef(new RowSizeLearner());
	const placeRowsPendingRef = useRef(false);
	// The row a reader who scrolled up keeps in place while a commit's changed rows are measured (content-anchor.ts),
	// and the rows and keys the last commit showed, to tell which rows the next one changed.
	const contentAnchorRef = useRef<ContentAnchor | null>(null);
	const shownRowsRef = useRef<{ rows: readonly Row[]; keys: readonly string[] }>({ rows: [], keys: [] });
	const contentHoldFrameRef = useRef(0);
	const handleVirtualizerChange = useCallback(
		(instance: Virtualizer<HTMLDivElement, Element>) => {
			// Measurements land in the virtualizer's ResizeObserver callback, after layout
			// and before paint, and one above the viewport moves the scroll offset right
			// there, while React places the rows a render later: the frame between painted
			// rows at their old positions (overlapping, or over the moved offset, so the
			// reader's rows jumped for a frame). Place the mounted rows before that paint,
			// once per batch of measurements (each one reads layout, so writing between
			// them made every read a layout). Only their transforms, which need no layout;
			// the canvas height waits for React.
			if (!placeRowsPendingRef.current) {
				placeRowsPendingRef.current = true;
				queueMicrotask(() => {
					placeRowsPendingRef.current = false;
					for (const item of instance.getVirtualItems()) {
						const row = instance.elementsCache.get(item.key);
						const transform = `translateY(${item.start}px)`;
						if (row instanceof HTMLElement && row.style.transform !== transform) row.style.transform = transform;
					}
					// A commit changed rows under a reader who scrolled up: the row they read stays put through
					// the measurements that follow, in the frame they land in (content-anchor.ts).
					const anchor = contentAnchorRef.current;
					const held = anchor ? instance.measurementsCache[anchor.index] : undefined;
					if (anchor && held?.key === anchor.key) {
						const target = held.start - anchor.offset;
						if (Math.abs(target - (instance.scrollOffset ?? 0)) >= 0.5) instance.scrollToOffset(target);
					}
				});
			}
			const el = parentRef.current;
			const range = instance.range;
			const size = instance.getTotalSize();
			if (range) {
				// The virtualizer's own geometry, not the element's: this runs on every
				// measurement and scroll event, and reading the element there forced a
				// layout whenever a commit had just changed the rows.
				const next = conversationReadingRowIndex(range, {
					scrollHeight: size,
					scrollTop: instance.scrollOffset ?? 0,
					clientHeight: instance.scrollRect?.height ?? 0,
				});
				setVisibleRowIndex(current => (current === next ? current : next));
			}
			// A row measured taller (streamed text): pin in this same frame. The
			// canvas observer below only sees the growth once React re-renders the
			// sizer — a frame later, longer on a slow renderer — and meanwhile the
			// new text is painted below the fold.
			if (size === followedSizeRef.current) return;
			followedSizeRef.current = size;
			if (!el || userScrollIntentRef.current || !followsTail(el)) return;
			scrollTranscriptToTail(instance, el);
		},
		[followsTail],
	);

	const STARTERS = [
		{ icon: Code2, title: t("chat.starter.understand.title"), prompt: t("chat.starter.understand.prompt") },
		{ icon: Bug, title: t("chat.starter.fix.title"), prompt: t("chat.starter.fix.prompt") },
		{ icon: Sparkles, title: t("chat.starter.build.title"), prompt: t("chat.starter.build.prompt") },
		{ icon: SearchCode, title: t("chat.starter.review.title"), prompt: t("chat.starter.review.prompt") },
	] as const;
	const CHAT_STARTERS = [
		{ icon: BookOpen, title: t("chat.starter.explain.title"), prompt: t("chat.starter.explain.prompt") },
		{ icon: PenLine, title: t("chat.starter.draft.title"), prompt: t("chat.starter.draft.prompt") },
		{ icon: Lightbulb, title: t("chat.starter.brainstorm.title"), prompt: t("chat.starter.brainstorm.prompt") },
		{ icon: Languages, title: t("chat.starter.translate.title"), prompt: t("chat.starter.translate.prompt") },
	] as const;
	/** Chat tabs get a conversation-oriented empty state (agent starters assume a project). */
	const isChat = useActiveTabKind() === "chat";
	const starters = isChat ? CHAT_STARTERS : STARTERS;
	/** No provider yet: the inline first-run setup takes the empty state's place. */
	const firstRunActive = useFirstRunActive();
	const firstRunOpen = useFirstRunStore(state => state.phase) !== "idle";

	// A history page about to be prepended (see `capturePrependAnchor`): until the
	// effect below has positioned it, the row the reader is on stays where it is.
	const prependAnchorRef = useRef<PrependAnchor | null>(null);
	// Overscan fills in over frames (see progressiveRange): the rows the last commit
	// mounted, whether the range held rows back, and a round that asks for the next.
	const mountedRowKeysRef = useRef<ReadonlySet<string>>(new Set());
	const overscanDeferredRef = useRef(false);
	const [overscanRound, setOverscanRound] = useState(0);
	// Rows a text selection covers stay mounted while it lasts (A105, selection-drag.ts):
	// unmounting one would take the selection's end, or the text it spans, out of the page.
	const [selectionPin, setSelectionPin] = useState<readonly string[]>([]);
	// The rows the running turn grows (its live work card, the streaming reply) stay mounted
	// wherever the reader scrolled: unmounted, a row's growth is never measured, so the scroll
	// extent below a reader who scrolled up stops following the output.
	const streamingRowIndex = showStreamingRow && streamingMessage ? (hiddenCount > 0 ? 1 : 0) + historyRows.length : -1;
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new round re-runs the range against the rows mounted since.
	const rangeExtractor = useCallback(
		(range: Range) => {
			// The commit that prepends a page mounts no new overscan rows: its task already
			// receives and lays out the page; they follow from the next frame on.
			const prepending = prependAnchorRef.current !== null && !prependAnchorRef.current.positioned;
			const { indexes, deferred } = progressiveRange(
				range,
				index => String(rowKeys[index] ?? index),
				mountedRowKeysRef.current,
				prepending ? 0 : OVERSCAN_MOUNTS_PER_FRAME,
			);
			overscanDeferredRef.current = deferred;
			const liveOutside =
				(tailRowIndex >= 0 && !indexes.includes(tailRowIndex)) ||
				(streamingRowIndex >= 0 && !indexes.includes(streamingRowIndex));
			if (selectionPin.length === 0 && !liveOutside) return indexes;
			const pinned = new Set(indexes);
			if (tailRowIndex >= 0) pinned.add(tailRowIndex);
			if (streamingRowIndex >= 0) pinned.add(streamingRowIndex);
			for (const key of selectionPin) {
				const index = rowKeys.indexOf(key);
				if (index >= 0) pinned.add(index);
			}
			return [...pinned].sort((a, b) => a - b);
		},
		[rowKeys, overscanRound, selectionPin, tailRowIndex, streamingRowIndex],
	);
	const virtualizer = useVirtualizer({
		count: rows.length,
		initialOffset: restoreView?.scrollOffset ?? 0,
		initialMeasurementsCache: restoreView?.measurements,
		getItemKey: index => rowKeys[index] ?? index,
		// The reader's gesture is the only thing that may move the viewport away from
		// the tail, so the virtualizer never anchors on its own: an end anchor
		// reconciles on every measurement, and one of those reconciliations landing in
		// the same frame as a wheel-up drags the reader back to the live edge. Tail
		// following is the explicit, gesture-vetoed effect below instead, and the
		// render that prepends a history page anchors itself (below this hook).
		anchorTo: "start",
		// Appends are followed by the explicit `pinned` effect below. Keeping the
		// virtualizer's independent append follower enabled made a small manual
		// scroll-up lose to streaming growth before React could unpin the view.
		followOnAppend: false,
		scrollEndThreshold: LIVE_EDGE_THRESHOLD_PX,
		// Row measurements can arrive while React is committing hydrated history.
		// Async rerenders avoid react-dom flushSync re-entry and the stale compositor
		// layers it produced on large transcripts.
		useFlushSync: false,
		getScrollElement: () => parentRef.current,
		// TanStack rounds border-box heights down below .5px; that leaves the
		// final absolute row outside its canvas and creates phantom scroll overflow.
		// A row mounting in a commit keeps the size the virtualizer already has: its
		// ResizeObserver reports the laid-out size before the frame paints, while
		// reading it here laid out every row the commit mounted inside the commit,
		// adding the frame's layout to the task that rendered them.
		measureElement: (element, entry, instance) => {
			if (entry) {
				const size = Math.ceil(entry.borderBoxSize[0]?.blockSize ?? element.getBoundingClientRect().height);
				const row = rows[instance.indexFromElement(element)];
				if (row && columnRef.current !== null) rowSizesRef.current.add(rowSizeKey(row), size);
				return size;
			}
			const size = instance.measurementsCache[instance.indexFromElement(element)]?.size;
			return size !== undefined && typeof ResizeObserver !== "undefined"
				? size
				: Math.ceil(element.getBoundingClientRect().height);
		},
		// Estimates sit just under what rows usually measure (a finished work card is rarely under 136px, an assistant
		// reply under 145px, a user turn is about 63px): a row's range is read at estimates first, and an estimate a
		// quarter of the size mounted four times the rows a screen needs. That is the page commit's own cost when an
		// older page refolds the rows on screen into an earlier card. A phone or tablet page guesses from the text and
		// what the transcript measured (transcript-row-estimate.ts): the desktop's guesses missed there by 164 px a turn.
		estimateSize: i => estimateRowSize(rows[i], columnRef.current, key => rowSizesRef.current.mean(key)),
		overscan: 8,
		rangeExtractor,
		onChange: handleVirtualizerChange,
	});
	// The render that prepends a history page moves the scroll offset with the page
	// before the range is read, so it lays out the rows the reader is looking at:
	// against the stale offset it mounted the new page's first screenful and dropped
	// the reader's rows, to mount them again once the offset caught up. It holds the
	// first row on screen that kept its key: the older page can fold the reader's top
	// rows into an earlier one (a steer joins the work row of the turn it
	// interrupted). Holding none would leave the view at the page's top, where a
	// wheel scrolls nothing and so never asks for the next page. The element itself
	// is moved by the anchor effect below.
	const pendingAnchor = prependAnchorRef.current;
	if (pendingAnchor && !pendingAnchor.positioned && pendingAnchor.moveTo === undefined && !isLoadingPage) {
		pendingAnchor.held ??= pendingAnchor.rows.find(row => rowKeys.includes(row.key));
		const held = pendingAnchor.held;
		// getTotalSize lays the rows out for this render's options first.
		const start =
			held && virtualizer.getTotalSize() > 0
				? virtualizer.measurementsCache[rowKeys.indexOf(held.key)]?.start
				: undefined;
		if (held && start !== undefined) {
			const target = Math.max(0, start + held.offset);
			pendingAnchor.moveTo = Math.abs(target - pendingAnchor.from) >= 0.5 ? target : null;
			virtualizer.scrollOffset = target;
		}
	}
	// A pinned view without a saved position (a session opened, a window reloaded)
	// reads the first rows it gets from the tail. Ranged at offset 0, that commit
	// mounted and laid out the top of the page only for the tail follow a frame
	// later to replace them with the rows the reader sees. The follow below still
	// moves the element there before the frame paints.
	const tailStartPendingRef = useRef(restoreView === null && pinned);
	if (tailStartPendingRef.current && rows.length > 0) {
		tailStartPendingRef.current = false;
		if (!userScrollIntentRef.current)
			virtualizer.scrollOffset = Math.max(0, virtualizer.getTotalSize() - (virtualizer.scrollRect?.height ?? 0));
	}
	const dockFocus = useUiStore(state => state.dockFocus);
	const revealedTodoFocus = useRef(useUiStore.getState().dockFocus?.seq ?? null);
	useLayoutEffect(() => {
		if (!carriesContext || dockFocus?.id !== "todo" || revealedTodoFocus.current === dockFocus.seq) return;
		// Reveal an off-screen virtualized owner first; its WorkTodo then opens
		// and scrolls the editable row into view using this same focus signal.
		const index = liveTail ? tailRowIndex : rows.findLastIndex(row => row.kind === "streaming");
		if (index < 0) return;
		const offset = virtualizer.getOffsetForIndex(index, "start")?.[0];
		if (offset !== undefined) virtualizer.scrollToOffset(offset);
		revealedTodoFocus.current = dockFocus.seq;
	}, [dockFocus, carriesContext, liveTail, tailRowIndex, rows, virtualizer]);
	const totalSize = virtualizer.getTotalSize();
	const virtualItems = virtualizer.getVirtualItems();
	useLayoutEffect(() => {
		mountedRowKeysRef.current = new Set(virtualItems.map(item => String(item.key)));
	}, [virtualItems]);
	// Held-back overscan rows mount on the next frame, a few at a time.
	useEffect(() => {
		if (!overscanDeferredRef.current) return;
		const frame = requestAnimationFrame(() => setOverscanRound(round => round + 1));
		return () => cancelAnimationFrame(frame);
	});
	const capturePrependAnchor = useCallback(() => {
		// Capture immediately before applying the page, after pending scroll and
		// measurement work has settled while its request was in flight. Rows sit at
		// the virtualizer's measured starts, so read those: a DOM read here forced a
		// layout inside the page's task.
		const scrollOffset = virtualizer.scrollOffset ?? 0;
		const rows = virtualizer
			.getVirtualItems()
			.flatMap(item =>
				item.end > scrollOffset + 4 ? [{ key: String(item.key), offset: scrollOffset - item.start }] : [],
			);
		prependAnchorRef.current = rows.length > 0 ? { rows, from: scrollOffset } : null;
	}, [virtualizer]);
	const requestOlder = useCallback(async () => {
		if (!prevCursor || isLoadingPage) return;
		await loadOlderTranscript(tabId ?? undefined, capturePrependAnchor, prewarmPageTail);
	}, [prevCursor, isLoadingPage, tabId, capturePrependAnchor]);
	useLayoutEffect(() => {
		const anchor = prependAnchorRef.current;
		if (!anchor || isLoadingPage || totalSize === 0) return;
		const element = parentRef.current;
		if (!element) return;
		// No row kept its key (see the render above): nothing to hold.
		const held = anchor.held;
		const index = held ? rowKeys.indexOf(held.key) : -1;
		if (!held || index < 0) {
			prependAnchorRef.current = null;
			return;
		}
		if (!anchor.positioned && anchor.moveTo !== undefined) {
			// Write the offset the render read its range at (see the render above) on
			// the next frame, before it paints: a scroll write lays the page out, and in
			// this commit that added the whole page's layout to the task that rendered
			// it. Not cancelled with this effect, since until it lands the element holds
			// the new rows at the old offset; a wheel turned meanwhile already moved the
			// element, and that movement is kept.
			const { moveTo, from } = anchor;
			if (moveTo !== null)
				requestAnimationFrame(() => {
					if (element.isConnected) virtualizer.scrollToOffset(moveTo + element.scrollTop - from);
				});
			anchor.positioned = true;
		}
		gestureAnchorRef.current = null;
		let frame = 0;
		let settledFrames = 0;
		const restore = () => {
			if (prependAnchorRef.current !== anchor) return;
			let delta: number | undefined;
			for (const row of element.querySelectorAll<HTMLElement>("[data-row-key]")) {
				if (row.dataset.rowKey === held.key) {
					delta = row.getBoundingClientRect().top - element.getBoundingClientRect().top + held.offset;
					break;
				}
			}
			if (delta !== undefined && Math.abs(delta) < 0.5) settledFrames++;
			else {
				settledFrames = 0;
				if (delta !== undefined) virtualizer.scrollToOffset(element.scrollTop + delta);
			}
			if (settledFrames >= 2) prependAnchorRef.current = null;
			else frame = requestAnimationFrame(restore);
		};
		// The prepend render already placed the held row; corrections for rows
		// measured above it start next frame, after the offset write above.
		frame = requestAnimationFrame(restore);
		return () => cancelAnimationFrame(frame);
	}, [rowKeys, isLoadingPage, virtualizer, totalSize]);
	// A commit that changed rows on screen while the reader is away from the live edge holds the row they read
	// (content-anchor.ts) until its rows are measured: the measurement microtask above keeps it in place within the
	// frame, and this loop lets go once two frames pass with it where it was. A gesture lets go at once.
	useLayoutEffect(() => {
		const shown = shownRowsRef.current;
		shownRowsRef.current = { rows, keys: rowKeys };
		const element = parentRef.current;
		if (!element || viewRef.current.pinned || prependAnchorRef.current || shown.rows.length === 0) return;
		// By content: a rebuild hands the rows of a split reply (its steps, its text) new objects even when nothing in
		// them changed, and those are no reason to hold. Only rows the reader can see are compared.
		const changed = (index: number) => {
			const key = rowKeys[index];
			const before = shown.rows[shown.keys[index] === key ? index : shown.keys.indexOf(key ?? "")];
			const row = rows[index];
			return before !== row && JSON.stringify(before) !== JSON.stringify(row);
		};
		const scrollOffset = virtualizer.scrollOffset ?? element.scrollTop;
		const anchor = contentAnchor(virtualizer.getVirtualItems(), scrollOffset, element.clientHeight, changed);
		if (!anchor) return;
		// The loop outlives this commit: a streamed delta right after a re-read commits again before the re-read's rows
		// are measured, and must not let go of the reader's row.
		contentAnchorRef.current = anchor;
		cancelAnimationFrame(contentHoldFrameRef.current);
		let settled = 0;
		const hold = () => {
			if (contentAnchorRef.current !== anchor) return;
			const held = virtualizer.measurementsCache[anchor.index];
			const target = held?.key === anchor.key ? held.start - anchor.offset : undefined;
			if (target === undefined) {
				contentAnchorRef.current = null;
				return;
			}
			if (Math.abs(target - (virtualizer.scrollOffset ?? 0)) < 0.5) settled++;
			else {
				settled = 0;
				virtualizer.scrollToOffset(target);
			}
			if (settled >= 2) contentAnchorRef.current = null;
			else contentHoldFrameRef.current = requestAnimationFrame(hold);
		};
		contentHoldFrameRef.current = requestAnimationFrame(hold);
	}, [rows, rowKeys, virtualizer]);
	useEffect(() => () => cancelAnimationFrame(contentHoldFrameRef.current), []);
	useLayoutEffect(
		() => () => {
			const scrollOffset = virtualizer.scrollOffset ?? 0;
			const anchor = virtualizer.getVirtualItemForOffset(scrollOffset);
			saveView({
				sessionId,
				...viewRef.current,
				scrollOffset,
				anchorKey: typeof anchor?.key === "string" ? anchor.key : undefined,
				anchorOffset: anchor ? scrollOffset - anchor.start : 0,
				measurements: virtualizer.takeSnapshot(),
			});
		},
		[sessionId, saveView, virtualizer],
	);
	const restoredAnchor = useRef(false);
	useLayoutEffect(() => {
		if (restoredAnchor.current || !restoreView || restoreView.pinned) return;
		const index = rowKeys.indexOf(restoreView.anchorKey ?? "");
		if (index < 0) return;
		const offset = virtualizer.getOffsetForIndex(index, "start")?.[0];
		if (offset === undefined) return;
		virtualizer.scrollToOffset(offset + restoreView.anchorOffset);
		restoredAnchor.current = true;
	}, [restoreView, rowKeys, virtualizer]);

	// Follow appended rows and same-count tail replacements (notably the
	// pending -> streaming transition) while the viewport sits at the live edge.
	useEffect(() => {
		if (rows.length === 0 || totalSize === 0) return;
		void sessionId;
		void tailRowKey;
		const frame = requestAnimationFrame(() => {
			const el = parentRef.current;
			// A wheel gesture can arrive before React cleans up this queued frame. Checked
			// first: the edge test reads layout, and every measurement while the reader
			// scrolls history re-ran this frame.
			if (!el || userScrollIntentRef.current) return;
			if (!followsTail(el)) return;
			scrollTranscriptToTail(virtualizer, el);
		});
		return () => cancelAnimationFrame(frame);
	}, [virtualizer, followsTail, rows.length, tailRowKey, sessionId, totalSize]);

	// Row measurements, fonts and images move the live edge after React has
	// committed the new rows. Observe the canvas sizer — the scroll container's
	// own box is `h-full` and never changes when content is appended. The
	// container itself resizes when the layout around it does — workspace dock
	// cards appearing, expanding or collapsing, the composer growing — and that
	// moves the live edge too: a shrink keeps scrollTop, so without a re-pin the
	// tail sits hidden under the new height until more text happens to arrive.
	useEffect(() => {
		const el = parentRef.current;
		const canvas = canvasRef.current;
		if (!el || !canvas || typeof ResizeObserver === "undefined") return;
		let viewportHeight = el.clientHeight;
		columnWidthRef.current = el.clientWidth;
		const observer = new ResizeObserver(() => {
			const previousHeight = viewportHeight;
			viewportHeight = el.clientHeight;
			columnWidthRef.current = el.clientWidth;
			if (userScrollIntentRef.current) return;
			// Nothing to follow: the first-run setup and the empty canvas open at the top.
			if (emptyRef.current) return;
			// Judge the edge against the taller of the two viewports: a shrink pushes the
			// tail out of a view that was riding it by exactly the height the layout
			// took, and that is not the reader leaving the live edge.
			const metrics = {
				scrollHeight: el.scrollHeight,
				scrollTop: el.scrollTop,
				clientHeight: Math.max(previousHeight, viewportHeight),
			};
			if (followsTail(metrics)) scrollTranscriptToTail(virtualizer, el);
		});
		observer.observe(canvas);
		observer.observe(el);
		return () => observer.disconnect();
	}, [virtualizer, followsTail]);

	// Entrance motion for content that genuinely arrives. Marking is imperative and
	// one-shot per row key so it never replays when the virtualizer recycles a row
	// back into the viewport, and never resets a fade that is still running.
	const lastAppended = useMessagesStore(s => s.lastAppended);
	const liveAppendRef = useRef(lastAppended);
	const entranceRef = useRef(createRowEntranceState(sessionId, rowKeys));
	useLayoutEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const slots = new Map<string, HTMLElement>();
		const mounted: MountedTranscriptRow[] = [];
		for (const slot of canvas.querySelectorAll<HTMLElement>("[data-transcript-kind][data-row-key]")) {
			const key = slot.dataset.rowKey;
			const index = Number(slot.dataset.index);
			if (key === undefined || !Number.isFinite(index)) continue;
			slots.set(key, slot);
			mounted.push({ index, key });
		}
		const claims = claimRowEntrances(entranceRef.current, {
			sessionId,
			// `lastAppended` is untouched by hydration and pagination, so a change
			// here is a message this window has not shown before.
			live: isStreaming || lastAppended !== liveAppendRef.current,
			rowKeys,
			mounted,
		});
		liveAppendRef.current = lastAppended;
		for (const key of claims) slots.get(key)?.classList.add("omp-row-arrive");
	});

	// The row the reader is looking at, plus how far it sits from the top of the
	// viewport. Row indices are stable while a transcript streams, so this survives
	// the virtualizer swapping height estimates for measurements.
	const readingAnchor = useCallback((el: HTMLElement) => {
		const top = el.getBoundingClientRect().top;
		for (const row of el.querySelectorAll<HTMLElement>("[data-index]")) {
			const box = row.getBoundingClientRect();
			if (box.bottom > top + 4) return { index: row.dataset.index ?? "", offset: box.top - top };
		}
		return null;
	}, []);

	const handleScroll = useCallback(() => {
		if (!userScrollIntentRef.current) return;
		const el = parentRef.current;
		if (!el) return;
		if (!viewRef.current.pinned && el.scrollTop < 240 && prevCursor && !isLoadingPage && !pageError) {
			void requestOlder();
		}
		const anchor = readingAnchor(el);
		if (anchor) {
			const looked = gestureAnchorRef.current;
			gestureAnchorRef.current = anchor;
			// Same row, same place in it: the document moved under the reader, which
			// happens when measurements replace estimates above the viewport. Reading
			// that as "the reader came back" re-pins a view they just took.
			if (looked && looked.index === anchor.index && Math.abs(looked.offset - anchor.offset) < 2) return;
		}
		const nextPinned = shouldRePinTranscript(gestureTowardTailRef.current, isTranscriptAtLiveEdge(el));
		setPinned(nextPinned);
		// Reaching the live edge by a tailward gesture hands layout growth back to
		// the follower until another explicit gesture.
		if (nextPinned) userScrollIntentRef.current = false;
	}, [readingAnchor, prevCursor, isLoadingPage, pageError, requestOlder]);

	// Every reader gesture takes the viewport: block the follower, forget the previous
	// reading anchor, and record which way they moved so only a trip back to the tail
	// can hand it over again.
	const beginGesture = useCallback((towardTail: GestureTowardTail) => {
		prependAnchorRef.current = null;
		contentAnchorRef.current = null;
		userScrollIntentRef.current = true;
		gestureAnchorRef.current = null;
		gestureTowardTailRef.current = towardTail;
	}, []);

	// A gesture can end without ever producing a scroll delta: a downward flick
	// while already at the bottom, or a scrollbar press that never moves. Since
	// handleScroll is the only other place the latch clears, an unlatched scroll
	// would leave the transcript latched forever — `pinned` stays true (so "jump
	// to latest" never appears) and both follow paths stay blocked.
	const endScrollGesture = useCallback(() => {
		const el = parentRef.current;
		userScrollIntentRef.current = false;
		gestureAnchorRef.current = null;
		if (el && isTranscriptAtLiveEdge(el)) setPinned(true);
	}, []);

	// Text drag-selection: scroll at the edges, and hold the view still for the drag
	// (streamed output would otherwise pull the page, and the selection, along).
	useEffect(() => {
		const el = parentRef.current;
		if (!el) return;
		return installSelectionDrag(el, {
			onStart: () => {
				beginGesture(null);
				setPinned(false);
			},
			onEnd: endScrollGesture,
		});
	}, [beginGesture, endScrollGesture]);

	// The rows the selection covers, kept mounted until it collapses or leaves the transcript.
	// New rows re-read a pinned selection's span; without a pin there is nothing to re-read
	// (`selectionchange` sets one), and reading the selection forces a layout on every row
	// change, a session open included.
	const hasSelectionPin = selectionPin.length > 0;
	useEffect(() => {
		const el = parentRef.current;
		if (!el) return;
		const document = el.ownerDocument;
		const update = () => {
			const span = selectionRowSpan(document.getSelection(), el, rowKeys);
			if (span === null) return;
			setSelectionPin(current =>
				current.length === span.length && current.every((key, index) => key === span[index]) ? current : span,
			);
		};
		if (hasSelectionPin) update();
		document.addEventListener("selectionchange", update);
		return () => document.removeEventListener("selectionchange", update);
	}, [rowKeys, hasSelectionPin]);

	const releaseTailPin = useCallback(() => {
		beginGesture(null);
		setPinned(false);
	}, [beginGesture]);

	const handleWheel = useCallback(
		(event: React.WheelEvent<HTMLDivElement>) => {
			if (event.deltaY === 0) return; // A horizontal wheel claims nothing.
			if (event.deltaY > 0) {
				// Toward the tail needs no veto: an unpinned follower never moves the view,
				// and `handleScroll` re-pins once the movement lands. Latching here could
				// strand the transcript for good — a wheel that stops a few pixels short of
				// the edge emits no further scroll event to release the latch, so a pinned
				// view would stop following with nothing for the reader to act on.
				gestureTowardTailRef.current = true;
				return;
			}
			beginGesture(false);
			setPinned(false);
		},
		[beginGesture],
	);

	const handleScrollPointerDown = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			const right = event.currentTarget.getBoundingClientRect().right;
			if (event.clientX >= right - 20) {
				beginGesture(null);
				setPinned(false);
			}
		},
		[beginGesture],
	);

	const handleScrollKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			if (["ArrowDown", "PageDown", "End", " "].includes(event.key)) {
				gestureTowardTailRef.current = true;
				return;
			}
			if (["ArrowUp", "PageUp", "Home"].includes(event.key)) {
				beginGesture(false);
				setPinned(false);
			}
		},
		[beginGesture],
	);

	// Printable keys typed on transcript chrome go to the composer; PageUp/PageDown in the composer page here.
	useEffect(() => {
		const pane = parentRef.current?.closest<HTMLElement>(".omp-session-pane");
		if (!pane) return;
		return installPaneKeys(pane, (direction, event) => {
			const scroller = parentRef.current;
			if (!scroller) return;
			event.preventDefault();
			if (direction === "up") {
				beginGesture(false);
				setPinned(false);
			} else gestureTowardTailRef.current = true;
			scroller.scrollBy({ top: (direction === "up" ? -1 : 1) * scroller.clientHeight * 0.9 });
		});
	}, [beginGesture]);

	const jumpToLatest = useCallback(() => {
		prependAnchorRef.current = null;
		contentAnchorRef.current = null;
		userScrollIntentRef.current = false;
		gestureAnchorRef.current = null;
		gestureTowardTailRef.current = true;
		setPinned(true);
		const el = parentRef.current;
		if (el) scrollTranscriptToTail(virtualizer, el);
	}, [virtualizer]);

	// A send reclaims the live edge even when the user had scrolled up. Mounted
	// keyed per tab+session, so seeding from the mount-time value keeps a
	// historical nonce from yanking a restored mid-transcript view to the bottom.
	const pinNonce = useSessionStore(s => s.transcriptPinNonce);
	const lastPinNonce = useRef(pinNonce);
	useEffect(() => {
		if (lastPinNonce.current === pinNonce) return;
		lastPinNonce.current = pinNonce;
		jumpToLatest();
	}, [pinNonce, jumpToLatest]);

	const jumpToConversation = useCallback(
		(rowIndex: number) => {
			prependAnchorRef.current = null;
			userScrollIntentRef.current = false;
			gestureAnchorRef.current = null;
			gestureTowardTailRef.current = null;
			setPinned(false);
			// One offset scroll, not scrollToIndex: its reconcile loop keeps re-aiming at
			// the row for ~5s while rows above it are measured, and would drag back a
			// reader who scrolls on in the meantime (same trap as scrollToEnd).
			const offset = virtualizer.getOffsetForIndex(rowIndex, "start")?.[0];
			if (offset !== undefined) virtualizer.scrollToOffset(offset);
		},
		[virtualizer],
	);
	const updateProcessExpanded = useCallback((key: string, expanded: boolean) => {
		setExpandedProcessKeys(current => {
			if (current.has(key) === expanded) return current;
			const next = new Set(current);
			if (expanded) next.add(key);
			else next.delete(key);
			return next;
		});
	}, []);

	// The work board's failed check (`requestRevealStep`): scroll to the work card holding the call, open it and show
	// the call. The card may be collapsed, or not mounted at all far up a long transcript; its row is found here.
	const [stepReveal, setStepReveal] = useState<{ rowKey: string; key: string } | null>(null);
	const revealRows = useRef({ rows, rowKeys });
	revealRows.current = { rows, rowKeys };
	useEffect(() => {
		const onReveal = (event: Event) => {
			const request = event instanceof CustomEvent ? (event.detail as RevealStepRequest | null) : null;
			if (!request || request.tabId !== tabId) return;
			const { rows: current, rowKeys: keys } = revealRows.current;
			const index = current.findIndex(row => row.kind === "process" && row.toolCallIds.includes(request.key));
			const rowKey = index < 0 ? undefined : keys[index];
			// Not inside a work card (full transcript detail lists tool cards as rows): show it where it is.
			if (rowKey === undefined) {
				revealStep(parentRef.current, request.key);
				return;
			}
			updateProcessExpanded(rowKey, true);
			jumpToConversation(index);
			setStepReveal({ rowKey, key: request.key });
		};
		window.addEventListener(REVEAL_STEP_EVENT, onReveal);
		return () => window.removeEventListener(REVEAL_STEP_EVENT, onReveal);
	}, [tabId, updateProcessExpanded, jumpToConversation]);

	// Messages hydrate via hydrateSession (use-rpc-events) on sidecar ready —
	// no separate fetch here (that would double-download the transcript).

	return (
		<div className="omp-transcript-editorial relative min-h-0 flex-1 bg-transparent">
			<TurnEndAnnouncer />
			<div
				ref={parentRef}
				aria-label={t("chat.transcript.label")}
				onScroll={handleScroll}
				onWheel={handleWheel}
				onTouchMove={releaseTailPin}
				onTouchEnd={endScrollGesture}
				onPointerDown={handleScrollPointerDown}
				onPointerUp={endScrollGesture}
				onPointerCancel={endScrollGesture}
				onKeyDown={handleScrollKeyDown}
				tabIndex={0}
				className="omp-transcript-scroll h-full overflow-y-auto overscroll-contain"
			>
				<TranscriptHistoryStatus
					error={pageError}
					loading={isLoadingPage}
					// With nothing loaded the failed read was the transcript's first: read it again, not an older page.
					onRetry={() => void (rows.length === 0 && tabId ? hydrateTabSession(tabId) : requestOlder())}
					updating={restoredAt !== null || switchPending !== null}
				/>
				{status === "starting" && !firstRunOpen && rows.length === 0 && !switchPending && knownSession && (
					<TranscriptSkeleton />
				)}
				{/* An open first-run step stays up while omp starts (right after machine setup installed it): its
				    providers fill in when the session is ready. */}
				{(status !== "starting" || firstRunOpen) &&
					rows.length === 0 &&
					!isStreaming &&
					!switchPending &&
					firstRunActive && <FirstRunSetup />}
				{(status !== "starting" || (!knownSession && !firstRunOpen)) &&
					rows.length === 0 &&
					!isStreaming &&
					!switchPending &&
					!(pageError && knownSession) &&
					!firstRunActive && (
						<div className="omp-empty-canvas flex min-h-full flex-col justify-center pb-20">
							<BrandMark size={36} className="omp-empty-logo mb-5 text-(--sc-text)" />
							<h1 className="font-display text-sc-3xl font-semibold tracking-(--sc-tracking-tight) text-(--sc-text)">
								{isChat ? t("chat.empty.title.chat") : t("chat.empty.title")}
							</h1>
							<div className="omp-starter-grid mt-8 grid auto-rows-fr grid-cols-2 gap-(--sc-space-3) max-sm:grid-cols-1">
								{starters.map(({ icon: Icon, title, prompt }) => (
									<button
										key={title}
										type="button"
										onClick={() =>
											window.dispatchEvent(
												new CustomEvent("omp:fill-composer", { detail: { text: prompt, tabId } }),
											)
										}
										className="omp-starter-card group flex items-start gap-3 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) p-4 text-left transition-colors duration-(--sc-duration-fast) hover:border-(--sc-border) hover:bg-(--sc-hover) active:bg-(--sc-pressed)"
									>
										<span className="omp-starter-icon flex size-8 shrink-0 items-center justify-center rounded-(--sc-radius-md) bg-(--sc-surface-2) text-(--sc-text-muted)">
											<Icon aria-hidden className="size-(--sc-icon-md)" />
										</span>
										<span className="min-w-0">
											<span className="block text-sc-md font-medium text-(--sc-text)">{title}</span>
											<span className="omp-starter-description mt-0.5 line-clamp-2 text-sc-sm text-(--sc-text-muted)">
												{prompt}
											</span>
										</span>
									</button>
								))}
							</div>
						</div>
					)}
				<div
					ref={canvasRef}
					className="omp-transcript-canvas"
					style={{ height: totalSize, position: "relative", width: "100%" }}
				>
					{/* The rows' containing block keeps one size: the canvas height changes with every
					    measurement and page, and as the rows' containing block it laid every mounted
					    row out again each time. */}
					<div
						className="omp-transcript-rows"
						style={{ position: "absolute", top: 0, left: 0, width: "100%", height: 0 }}
					>
						{virtualItems.map(item => {
							const row = rows[item.index];
							if (!row) return null;
							const rowKey = rowKeys[item.index] ?? String(item.key);
							return (
								<div
									key={item.key}
									data-index={item.index}
									data-row-key={rowKey}
									data-transcript-kind={row.kind}
									ref={virtualizer.measureElement}
									style={{
										position: "absolute",
										top: 0,
										left: 0,
										width: "100%",
										transform: `translateY(${item.start}px)`,
									}}
								>
									<div className="omp-transcript-row w-full">
										{row.kind === "message" ? (
											<MessageBubble message={row.message} reaction={row.reaction} runningIndicator="dot" />
										) : row.kind === "readGroup" ? (
											<ReadGroupCard entries={row.entries} runningIndicator="dot" usage={row.usage} />
										) : row.kind === "process" ? (
											<ProcessGroup
												expanded={expandedProcessKeys.has(rowKey)}
												live={item.index === tailRowIndex}
												onExpandedChange={updateProcessExpanded}
												reveal={stepReveal?.rowKey === rowKey ? stepReveal : null}
												row={row}
												rowKey={rowKey}
												superseded={item.index < currentWorkRow}
											/>
										) : row.kind === "streaming" && transcriptDetail === "compact" && !liveTail ? (
											// The in-flight reply's work renders through the same component and
											// frame, under the same row key, as the process row it finalizes into:
											// the card keeps its React identity across message_end.
											<ProcessGroup
												expanded={expandedProcessKeys.has(rowKey)}
												live
												onExpandedChange={updateProcessExpanded}
												reveal={stepReveal?.rowKey === rowKey ? stepReveal : null}
												row={STREAMING_WORK_ROW}
												rowKey={rowKey}
												streaming
											/>
										) : row.kind === "streaming" ? (
											<StreamingRows />
										) : row.kind === "todoSnapshot" ? (
											<TodoSnapshotCard entry={row.entry} />
										) : row.kind === "expander" ? (
											<Button
												className="omp-history-expander"
												icon={<History />}
												onClick={() => setPreCompactionOpen(true)}
												size="sm"
												variant="secondary"
											>
												{t("chat.compaction.showEarlier", {
													count: row.count,
													plural: row.count === 1 ? "" : "s",
												})}
											</Button>
										) : (
											<>
												<TurnStatusRow attached={liveTail} />
												<PendingMailNotes />
											</>
										)}
									</div>
								</div>
							);
						})}
					</div>
				</div>
			</div>
			<button
				type="button"
				onClick={jumpToLatest}
				aria-label={t("chat.jumpToLatest")}
				className={cx(
					"absolute bottom-5 left-1/2 flex h-9 -translate-x-1/2 items-center gap-2 rounded-full border border-[var(--omp-border)] bg-[var(--omp-bg-elevated)] px-4 text-omp-md font-medium text-[var(--omp-text)] shadow-[var(--omp-shadow-md)] transition-all hover:bg-[var(--omp-selected-bg)]",
					pinned ? "pointer-events-none translate-y-12 opacity-0" : "translate-y-0 opacity-100",
				)}
			>
				<ArrowDown size={14} />
				{t("chat.jumpToLatest")}
			</button>
			<ConversationNavigator
				activeIndex={activeConversationIndex}
				anchors={conversationAnchors}
				onNavigate={jumpToConversation}
			/>
		</div>
	);
}

/** Stable "nothing live" set for rows that don't watch the tools store. */
const NO_LIVE_TOOLS: ReadonlyMap<string, ToolEntry> = new Map();

type LiveCard = { id: string; name: string; args: Record<string, unknown> };

/**
 * The streaming message's work so far. `streamingMessage.content` only fills
 * at message_end; mid-stream the live tool calls accumulate in the tools
 * store's live set (toolcall_delta → pending while args stream,
 * tool_execution_start → running), so those entries count too. Entries from
 * before this stream started (hydrated history that never finished) are
 * excluded by start time.
 */
function liveProcessParts(streamingMessage: AgentMessage, liveTools: ReadonlyMap<string, ToolEntry>) {
	const content = Array.isArray(streamingMessage.content) ? streamingMessage.content : [];
	const toolCalls = content.filter(block => block.type === "toolCall");
	const streamStart = messageTimestampMs(streamingMessage);
	const contentIds = new Set(toolCalls.map(block => toolEntryKey(block)));
	const streamTools: Array<{ id: string; entry: ToolEntry }> = [];
	for (const [id, entry] of liveTools) {
		if (contentIds.has(id)) continue;
		if (entry.startTime < streamStart) continue;
		streamTools.push({ id, entry });
	}
	const allCards: LiveCard[] = [
		...toolCalls.map(block => ({
			id: toolEntryKey(block),
			name: block.name,
			args: block.arguments as Record<string, unknown>,
		})),
		...streamTools.map(({ id, entry }) => ({
			id,
			name: entry.toolName,
			args: entry.args as Record<string, unknown>,
		})),
	];
	return { toolCalls, streamTools, allCards };
}

/** A work row's turn frame; the pending card takes the same one so the run fills it in place. */
const WORK_TURN_CLASS =
	"omp-process-turn ps-(--omp-editorial-inset) pe-(--omp-editorial-edge) pt-(--omp-prompt-gap) pb-0.5";

/** The in-flight reply's row before message_end: nothing finalized yet, its work is all live. */
export const STREAMING_WORK_ROW: Extract<HistoryRow, { kind: "process" }> = {
	kind: "process",
	messages: [],
	stepCount: 0,
	failedEvents: 0,
	toolCallIds: [],
	toolNames: [],
};

/** The in-flight reply's text as its own answer turn, where its finalized answer row lands. */
function StreamingReply() {
	return (
		<div className="omp-streaming-turn omp-assistant-turn group flex px-6">
			<div className="omp-transcript-content min-w-0">
				<StreamingText />
			</div>
		</div>
	);
}

/**
 * Memoized: the transcript re-renders on every virtual range change while the
 * reader scrolls, and an unchanged work row (same row object, see
 * reuseTranscriptRows) has nothing new to show.
 *
 * The streaming row renders here too (`streaming`, with STREAMING_WORK_ROW), so a
 * work card that starts in the in-flight reply is the same element once that
 * reply finalizes into this row.
 */
export const ProcessGroup = memo(function ProcessGroup({
	expanded,
	live = false,
	onExpandedChange,
	row,
	rowKey,
	superseded = false,
	streaming = false,
	reveal = null,
}: {
	expanded: boolean;
	/**
	 * The running turn's latest work row: it keeps the spinner between steps
	 * and absorbs the streaming message's thinking and tool calls, so the turn
	 * shows one live group (and one live log) instead of a new one per step.
	 */
	live?: boolean;
	onExpandedChange: (rowKey: string, expanded: boolean) => void;
	row: Extract<HistoryRow, { kind: "process" }>;
	rowKey: string;
	superseded?: boolean;
	/** The in-flight reply's own row: its streamed text follows the card as the answer turn. */
	streaming?: boolean;
	/** A step asked for from outside the transcript (the work board): the card opens and shows it. */
	reveal?: StepReveal | null;
}) {
	const changeExpanded = useCallback((next: boolean) => onExpandedChange(rowKey, next), [onExpandedChange, rowKey]);
	const output = useMemo(() => summarizeMessagesOutput(row.messages), [row.messages]);
	// Non-live rows select constants, so tool and token events never re-render them.
	const streamingMessage = useMessagesStore(s => (live ? s.streamingMessage : null));
	const hasThinking = useMessagesStore(s => live && isRenderableMessageText(s.streamingThinking));
	const hasText = useMessagesStore(s => live && isRenderableMessageText(s.streamingText));
	const liveTools = useToolsStore(s => (live && streamingMessage ? s.liveTools : NO_LIVE_TOOLS));
	const liveCards = streamingMessage ? liveProcessParts(streamingMessage, liveTools).allCards : [];
	const known = new Set(row.toolCallIds);
	const toolCallIds =
		liveCards.length === 0
			? row.toolCallIds
			: [...row.toolCallIds, ...liveCards.map(card => card.id).filter(id => !known.has(id))];
	const hasWork = row.messages.length > 0 || liveCards.length > 0 || hasThinking;
	return (
		<>
			{hasWork ? (
				<div className={WORK_TURN_CLASS}>
					<ExecutionGroup
						expanded={expanded}
						failureCount={row.failedEvents}
						stoppedAt={row.stoppedAt}
						live={live}
						onExpandedChange={changeExpanded}
						output={output}
						notes={row.notes}
						superseded={superseded}
						stepCount={row.stepCount + liveCards.length + (hasThinking ? 1 : 0)}
						thinkingLive={hasThinking && !hasText}
						toolCallIds={toolCallIds}
						revealRequest={reveal}
						todoSnapshots={row.todoSnapshots}
					>
						<div className="omp-process-group">
							{live ? <ProcessMessages messages={row.messages} /> : <StepGroups messages={row.messages} />}
							{hasThinking || liveCards.length > 0 ? (
								<div className="omp-process-group--live">
									{hasThinking ? <ThinkingBlock live /> : null}
									{liveCards.map(card => (
										<ToolCard
											args={card.args}
											key={card.id}
											runningIndicator="dot"
											toolCallId={card.id}
											toolName={card.name}
										/>
									))}
								</div>
							) : null}
						</div>
					</ExecutionGroup>
				</div>
			) : null}
			{streaming && hasText ? <StreamingReply /> : null}
		</>
	);
});

/**
 * A live card's steps as they arrive, one bubble per message, mounted a slice per task after the
 * click's frame (see `useMountedCount`). A finished card lines its steps up by intent instead.
 */
function ProcessMessages({ messages }: { messages: readonly AgentMessage[] }) {
	const mounted = useMountedCount(messages.length);
	return messages
		.slice(0, mounted)
		.map((message, index) => (
			<MessageBubble
				compact
				key={typeof message.id === "string" ? message.id : `${String(message.timestamp ?? "process")}-${index}`}
				message={message}
				runningIndicator="dot"
			/>
		));
}

/**
 * The in-flight assistant turn outside a compact work card. Full detail shows
 * its thinking block, any tool calls already emitted and the live text tail;
 * compact detail streams only the text here, because the turn's work row
 * (ProcessGroup, the streaming row's own or the live tail) shows the work.
 * Replaces itself with a finalized MessageBubble on message_end.
 */
export function StreamingRows() {
	const streamingMessage = useMessagesStore(s => s.streamingMessage);
	const streamingThinking = useMessagesStore(s => s.streamingThinking);
	const hasText = useMessagesStore(s => isRenderableMessageText(s.streamingText));
	const transcriptDetail = useUiStore(s => s.transcriptDetail);
	// Live-set subscription is intentional here: this ONE live row renders
	// every pending/running card. Per-row isolation lives in ToolCard.
	const liveTools = useToolsStore(s => (transcriptDetail === "full" ? s.liveTools : NO_LIVE_TOOLS));
	if (!streamingMessage) return null;
	if (transcriptDetail !== "full") return <StreamingReply />;
	const { toolCalls, streamTools, allCards } = liveProcessParts(streamingMessage, liveTools);

	const hasThinking = isRenderableMessageText(streamingThinking);
	const turnClass = !hasText && !hasThinking ? "omp-assistant-turn--compact" : "omp-assistant-turn";

	// Live read grouping (same predicate as the finalized path): consecutive
	// collapsible reads fold into one ReadGroupCard even mid-turn.
	const groupedLiveCards = (() => {
		const segments: Array<
			{ type: "group"; entries: ReadGroupEntry[] } | { type: "card"; card: (typeof allCards)[number] }
		> = [];
		let run: ReadGroupEntry[] = [];
		const flush = () => {
			if (run.length > 0) {
				segments.push({ type: "group", entries: run });
				run = [];
			}
		};
		for (const card of allCards) {
			const read = card.name === "read" ? collapsibleReadTarget(card.args) : null;
			if (read) {
				run.push({ callId: card.id, toolKey: card.id, ...read, args: card.args });
				continue;
			}
			flush();
			segments.push({ type: "card", card });
		}
		flush();
		// Keep the live shape identical to finalized `groupReadRows`: even one
		// collapsible read uses ReadGroupCard, preventing a card-type swap at
		// message_end.
		if (!segments.some(segment => segment.type === "group")) return null;
		return segments.map((segment, index) =>
			segment.type === "group" ? (
				<ReadGroupCard
					inset
					key={`rg-${segment.entries[0]?.callId ?? index}`}
					entries={segment.entries}
					runningIndicator="dot"
				/>
			) : (
				<ToolCard
					key={segment.card.id}
					toolCallId={segment.card.id}
					toolName={segment.card.name}
					args={segment.card.args}
					runningIndicator="dot"
				/>
			),
		);
	})();

	const toolCards = groupedLiveCards ?? (
		<>
			{toolCalls.map(block => (
				<ToolCard
					key={toolEntryKey(block)}
					toolCallId={toolEntryKey(block)}
					toolName={block.name}
					args={block.arguments}
					runningIndicator="dot"
				/>
			))}
			{streamTools.map(({ id, entry }) => (
				<ToolCard key={id} toolCallId={id} toolName={entry.toolName} args={entry.args} runningIndicator="dot" />
			))}
		</>
	);

	return (
		<div className={cx("omp-streaming-turn group flex px-6", turnClass)}>
			<div className="omp-transcript-content min-w-0">
				{/* streamingMessage.content only fills at message_end; mid-stream the
				    thinking deltas accumulate in the streamingThinking buffer, which
				    ThinkingBlock reads itself when live. */}
				{hasThinking ? <ThinkingBlock live /> : null}
				{toolCards}
				<StreamingText />
			</div>
		</div>
	);
}

/**
 * Live status row for the windows where the agent is busy but the transcript
 * has nothing to show yet — the GUI counterpart of the TUI's loader line:
 *
 * - retry: `Retrying (a/b) in Ns…` for the auto-retry delay/attempt window,
 *   with the humanized reason ("Can't connect") and the raw failure detail.
 *   Enhancement over the TUI: N counts down live instead of freezing at the
 *   initial delay.
 * - compaction: `{reason}{action}…` for auto-maintenance, same
 *   reason/action vocabulary as the TUI loader.
 * - waiting: between turn_start and the first streamed event, only a
 *   spinner — on the turn's last work row when there is one (`attached`, so
 *   this row renders nothing), else in place of the reply about to stream.
 *
 * Retry and compaction carry the Esc interrupt hint (App routes Esc →
 * rpc.abort), matching the TUI's `[esc]` / `(esc to cancel)` suffixes; retry
 * also offers recovery: change model, or stop the response.
 */
export function TurnStatusRow({ attached = false }: { attached?: boolean }) {
	const t = useT();
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const retryInfo = useSessionStore(s => s.retryInfo);
	const compactionInfo = useSessionStore(s => s.compactionInfo);
	const awaitingConnection = useAwaitingConnection();
	const resuming = useResuming();
	const waitHost = useHostView(useTabsStore(s => s.tabs.find(tab => tab.id === awaitingConnection)?.device));
	const awaitingModelSince = useSessionStore(s => s.awaitingModelSince);
	const now = Date.now();
	// Clock for the retry countdown only; it never runs for compaction or a
	// model wait (the row is mounted for the whole session).
	const [, setNowTick] = useState(0);
	useEffect(() => {
		if (!retryInfo) return;
		const timer = setTimeout(() => setNowTick(tick => tick + 1), 1000);
		return () => clearTimeout(timer);
	});

	let text: string;
	let reason: string | null = null;
	let detail: string | null = null;
	let announcement: string;

	// A turn that ended on a network error while offline (or just after a wake) is not a failure:
	// main (or the paired host running the tab) continues it once the connection is back, and this
	// is the only thing to say meanwhile.
	if (awaitingConnection !== null) {
		// A paired host's tab waits for the host's connection, not this computer's (turn-resume.ts).
		const waitText = waitHost ? t("chat.connectionWaitHost", { device: waitHost.name }) : t("chat.connectionWait");
		return (
			<div
				className="omp-status-turn flex flex-col gap-1.5 ps-(--omp-editorial-inset) pe-(--omp-editorial-edge) py-4 text-sc-md text-(--sc-text-muted)"
				data-connection-wait
			>
				<span aria-atomic="true" aria-live="polite" className="sr-only" role="status">
					{waitText}
				</span>
				<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
					<WifiOff aria-hidden className="size-(--sc-icon-sm) shrink-0" />
					<span className="text-(--sc-text-secondary)">{waitText}</span>
				</div>
				<div className="flex flex-wrap items-center gap-2 ps-6">
					<Button
						onClick={() => {
							window.omp.resume
								.cancelWait(awaitingConnection)
								.catch((cause: unknown) =>
									toastError({ title: t("chat.connectionWaitCancelFailed"), error: cause }),
								);
						}}
						size="sm"
						variant="ghost"
					>
						{t("common.cancel")}
					</Button>
				</div>
			</div>
		);
	}
	// A relaunch continues this tab's interrupted work (main's turn-resume): one calm row, the only resume
	// indicator (no toast), with the Stop the old toast offered; the turn's own rows replace it once it starts.
	if (resuming) {
		const resumeText = t("chat.resuming");
		return (
			<div
				className="omp-status-turn flex flex-wrap items-center gap-x-2.5 gap-y-1 ps-(--omp-editorial-inset) pe-(--omp-editorial-edge) py-4 text-sc-md text-(--sc-text-muted)"
				data-resuming
			>
				<span aria-atomic="true" aria-live="polite" className="sr-only" role="status">
					{resumeText}
				</span>
				<History aria-hidden className="size-(--sc-icon-sm) shrink-0" />
				<span className="text-(--sc-text-secondary)">{resumeText}</span>
				<Button
					onClick={() => {
						window.omp.resume
							.stop(resuming)
							.catch((cause: unknown) => toastError({ title: t("chat.resumingStopFailed"), error: cause }));
					}}
					size="sm"
					variant="ghost"
				>
					{t("input.abort")}
				</Button>
			</div>
		);
	}
	if (retryInfo) {
		const remainingSeconds = Math.max(0, Math.ceil((retryInfo.startedAt + retryInfo.delayMs - now) / 1000));
		text =
			remainingSeconds >= 60
				? t("chat.retry.scheduled", {
						attempt: retryInfo.attempt,
						maxAttempts: retryInfo.maxAttempts,
						time: formatClock(retryInfo.startedAt + retryInfo.delayMs),
					})
				: remainingSeconds > 0
					? t("chat.retry.pending", {
							attempt: retryInfo.attempt,
							maxAttempts: retryInfo.maxAttempts,
							seconds: remainingSeconds,
						})
					: t("chat.retry.inflight", { attempt: retryInfo.attempt, maxAttempts: retryInfo.maxAttempts });
		const cause = describeTurnError(retryInfo.errorMessage);
		reason = cause.kind === "unknown" ? null : t(cause.titleKey);
		detail = retryInfo.errorMessage || null;
		announcement = t("chat.retry.inflight", { attempt: retryInfo.attempt, maxAttempts: retryInfo.maxAttempts });
	} else if (compactionInfo?.reason === "manual") {
		text = compactionInfo.cancelling
			? t("chat.compaction.cancelling")
			: `${t(compactionInfo.action === "handoff" ? "chat.compaction.manual.handoff" : "chat.compaction.manual.compact")}…`;
		announcement = text;
	} else if (compactionInfo) {
		const compactionReason =
			compactionInfo.reason === "threshold" ? "" : t(`chat.compaction.reason.${compactionInfo.reason}`);
		text = `${compactionReason}${t(compactionActionKey(compactionInfo.action))}…`;
		announcement = text;
	} else if (awaitingModelSince != null) {
		if (attached) return null;
		// The card's own head in the exact frame the work card mounts in (the work row's
		// turn and group wrappers), so the run fills it in place.
		return (
			<div className={WORK_TURN_CLASS} data-awaiting-card>
				<span aria-atomic="true" aria-live="polite" className="sr-only" role="status">
					{t("chat.awaitingModel.announcement")}
				</span>
				<section className="omp-execution-group" data-state="running">
					<WorkCardPending />
				</section>
			</div>
		);
	} else {
		return null;
	}

	return (
		<div className="omp-status-turn flex flex-col gap-1.5 ps-(--omp-editorial-inset) pe-(--omp-editorial-edge) py-4 text-sc-md text-(--sc-text-muted)">
			<span aria-atomic="true" aria-live="polite" className="sr-only" role="status">
				{announcement}
			</span>
			<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
				<span aria-hidden className="flex size-(--sc-icon-sm) shrink-0 items-center justify-center">
					<Spinner size="sm" />
				</span>
				<span className="text-(--sc-text-secondary)">{text}</span>
				{reason ? <span>· {reason}</span> : null}
				{compactionInfo?.cancelling ? null : (
					<span className="flex items-center gap-1.5 text-sc-sm text-(--sc-text-subtle)">
						<Kbd shortcut="Esc" />
						{t("chat.interruptHint")}
					</span>
				)}
			</div>
			{detail ? (
				<div className="max-w-full truncate ps-6 text-sc-xs text-(--sc-text-subtle)" title={detail}>
					{detail}
				</div>
			) : null}
			{compactionInfo?.reason === "manual" && !retryInfo ? (
				<div className="flex flex-wrap items-center gap-2 ps-6">
					<Button
						disabled={compactionInfo.cancelling === true}
						onClick={() => void abortActiveTurn(rpc, tabId)}
						size="sm"
						variant="ghost"
					>
						{t("common.cancel")}
					</Button>
				</div>
			) : null}
			{retryInfo ? (
				<div className="flex flex-wrap items-center gap-2 ps-6">
					<Button onClick={() => useUiStore.getState().openModelPicker()} size="sm" variant="secondary">
						{t("turnError.action.changeModel")}
					</Button>
					<Button onClick={() => void abortActiveTurn(rpc, tabId)} size="sm" variant="ghost">
						{t("chat.status.stop")}
					</Button>
				</div>
			) : null}
		</div>
	);
}

/**
 * Archived todo state rendered inline in the transcript where the change
 * happened (todo store history). Collapses to a one-line summary; expanding
 * shows the phase/task state at that time, read-only — the live dock card
 * above the composer carries the editable current list.
 */
const TodoSnapshotCard = memo(function TodoSnapshotCard({ entry }: { entry: TodoSnapshot }) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const total = entry.phases.reduce((n, phase) => n + phase.tasks.length, 0);
	const done = entry.phases.reduce(
		(n, phase) => n + phase.tasks.filter(task => task.status === "completed").length,
		0,
	);
	const cleared = total === 0;

	return (
		<div className="ml-(--omp-editorial-inset) mr-(--omp-editorial-edge) my-0.5">
			<button
				aria-expanded={expanded}
				className="flex min-h-7 w-fit max-w-full min-w-0 items-center gap-2 rounded-(--sc-radius-sm) px-1.5 text-sc-sm text-(--sc-text-subtle) transition-colors duration-(--sc-duration-instant) hover:bg-(--sc-hover) hover:text-(--sc-text-secondary) aria-expanded:text-(--sc-text-secondary) disabled:hover:bg-transparent disabled:hover:text-(--sc-text-subtle)"
				disabled={cleared}
				onClick={() => setExpanded(value => !value)}
				type="button"
			>
				<ListTodo aria-hidden className="size-(--sc-icon-sm) shrink-0" />
				<span className="truncate">{cleared ? t("todoSnapshot.cleared") : t("todoSnapshot.title")}</span>
				{!cleared && <span className="shrink-0 tabular-nums">{t("todoSnapshot.progress", { done, total })}</span>}
				{!cleared && (
					<ChevronRight
						aria-hidden
						className={cx(
							"omp-disclosure-chevron size-(--sc-icon-sm) shrink-0 text-(--sc-text-subtle)",
							expanded && "rotate-90",
						)}
					/>
				)}
			</button>
			{expanded && !cleared && (
				<div className="mt-0.5 mb-1 ml-(--omp-step-rule-inset) space-y-0.5 border-l border-(--sc-divider) pl-3">
					{entry.phases.map((phase, phaseIndex) => (
						<div key={`${phase.name}-${phaseIndex}`}>
							{entry.phases.length > 1 && (
								<div className="py-0.5 text-sc-xs font-medium text-(--sc-text-muted)">{phase.name}</div>
							)}
							{phase.tasks.map((task, taskIndex) => (
								<div key={`${task.content}-${taskIndex}`} className="flex items-center gap-2 py-0.5 text-sc-sm">
									<span
										aria-hidden
										className={cx(
											"size-1.5 shrink-0 rounded-full",
											task.status === "completed"
												? "bg-(--sc-success)"
												: task.status === "in_progress"
													? "bg-(--sc-accent)"
													: task.status === "abandoned"
														? "bg-(--sc-danger)"
														: task.status === "blocked"
															? "bg-(--sc-warning)"
															: "bg-(--sc-border)",
										)}
									/>
									<span
										className={cx(
											"min-w-0 flex-1 truncate",
											task.status === "completed" || task.status === "abandoned"
												? "text-(--sc-text-subtle) line-through"
												: "text-(--sc-text-secondary)",
										)}
										title={task.content}
									>
										{task.content}
									</span>
								</div>
							))}
						</div>
					))}
				</div>
			)}
		</div>
	);
});

/**
 * Quiet notes over the top of the transcript, never a spinner and never in the flow (nothing moves when one comes or
 * goes): `updating` is the last known rows waiting for the live read (hidden for its first 0.7 s, so a fast read
 * shows nothing), `loading` the older page streaming in above the viewport, and the failure with Retry (an alert, so
 * a screen reader hears it).
 */
export function TranscriptHistoryStatus({
	loading,
	error,
	onRetry,
	updating = false,
}: {
	loading: boolean;
	error: string | null;
	onRetry: () => void;
	updating?: boolean;
}) {
	const t = useT();
	if (!loading && !error && !updating) return null;
	return (
		<div
			data-testid="transcript-history-status"
			role={error ? "alert" : "status"}
			className={cx(
				"pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-2 py-1.5 text-sc-xs text-(--sc-text-muted)",
				!loading && !error && "omp-updating-hint",
			)}
		>
			{error ? (
				<>
					<span>{t("chat.history.failed")}</span>
					<Button className="pointer-events-auto" size="sm" onClick={onRetry}>
						{t("common.retry")}
					</Button>
				</>
			) : (
				<span className="rounded-(--sc-radius-full) bg-(--sc-surface-2) px-2.5 py-0.5">
					{loading ? t("chat.history.loading") : t("chat.history.updating")}
				</span>
			)}
		</div>
	);
}

/**
 * What an existing session's transcript looks like before anything of it is known (a first visit to it on this
 * device): the same column, a prompt and a reply's lines per turn. Still; it is replaced by the rows in place.
 */
export function TranscriptSkeleton() {
	const t = useT();
	return (
		<div
			aria-label={t("chat.history.loading")}
			className="mx-auto flex w-full flex-col gap-8 px-(--omp-column-pad) pt-10"
			data-testid="transcript-skeleton"
			role="status"
			style={{ maxWidth: "calc(var(--omp-column-reading) + 2 * var(--omp-column-pad))" }}
		>
			{[
				[34, [92, 78, 52]],
				[48, [96, 88, 70, 38]],
				[28, [90, 64]],
			].map(([prompt, lines], turn) => (
				<div aria-hidden className="flex flex-col gap-3" key={turn}>
					<Skeleton className="ml-auto h-9 rounded-(--sc-radius-lg)" style={{ width: `${prompt}%` }} />
					<div className="flex flex-col gap-2">
						{(lines as number[]).map((width, line) => (
							<Skeleton className="h-3" key={line} style={{ width: `${width}%` }} />
						))}
					</div>
				</div>
			))}
		</div>
	);
}

export type { HistoryRow, Row, TimelineMarkerSeed } from "./chat-stream-utils";
// Re-export transcript helpers for consumers/tests that import them from ChatStream.
export {
	buildConversationAnchors,
	buildHistoryRowKeys,
	buildHistoryRows,
	buildTimelineMarkers,
	buildTranscriptRowKeys,
	claimRowEntrances,
	conversationReadingRowIndex,
	createRowEntranceState,
	findConversationAnchorIndex,
	hasStreamingTranscriptContent,
	isTranscriptAtLiveEdge,
	LIVE_EDGE_SLACK_PX,
	liveWorkTail,
	mergeTodoSnapshots,
	nextTranscriptIdentity,
	ROW_ENTRANCE_TAIL_ROWS,
	scrollTranscriptToTail,
	shouldRePinTranscript,
} from "./chat-stream-utils";
