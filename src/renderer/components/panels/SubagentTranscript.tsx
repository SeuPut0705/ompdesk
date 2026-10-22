/**
 * One subagent's transcript, drawn by the main transcript's own components:
 * MessageBubble turns (markdown, thinking, tool cards), the compact work card
 * (`ProcessGroup`) or full per-message detail by the same `transcriptDetail`
 * switch, read groups, the editorial transcript styles and its scroll
 * behaviour (follows the live edge, "jump to latest" when the reader leaves
 * it). It is the body of the side panel's Subagent view and of the transcript
 * sheet.
 *
 * The tool cards and work card read their stores through the nearest session
 * runtime, so the view mounts them in a runtime of its own: the owning tab's
 * (RPC, subagent roster, settings) with the tools, messages and session
 * stores replaced by private ones that hold only this subagent's calls. The
 * owning tab's own run, goal and streaming text never bleed into the cards.
 */

import { FileWarning, RefreshCw } from "lucide-react";
import { memo, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { StoreApi } from "zustand/vanilla";
import type { AgentMessage, SubagentSnapshot } from "../../../shared/rpc-types";
import { errorDetail } from "../../lib/error-detail";
import { basename, extractResultImages, resultDetails } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { groupReadRows } from "../../lib/read-group";
import { createMessagesStore, type MessagesStore } from "../../stores/messages";
import { createSessionStore, type SessionStore } from "../../stores/session";
import {
	type RuntimeStoreKey,
	type SessionRuntime,
	SessionRuntimeProvider,
	useRuntimeTabId,
	useSessionRuntime,
	useTabCommand,
} from "../../stores/session-runtime-context";
import { createToolsStore, type ToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { ProcessGroup } from "../chat/ChatStream";
import {
	buildHistoryRowKeys,
	buildHistoryRows,
	type HistoryRow,
	liveWorkTail,
	reuseTranscriptRows,
} from "../chat/chat-stream-utils";
import { MessageBubble } from "../chat/MessageBubble";
import { Banner, Button, EmptyState, JumpToLatest, Spinner } from "../common";
import { ToolImage } from "../tools/media/ToolImage";
import { ToolResultMedia } from "../tools/media/ToolMedia";
import { ReadGroupCard } from "../tools/renderers/ReadGroupCard";
import { isLiveSubagentStatus } from "./subagent-graph";
import { useStickToBottom } from "./use-stick-to-bottom";
import type { SubagentTranscriptState } from "./use-subagent-transcript";

/** The main transcript's attached-picture size (MessageBubble's InlineImage). */
const PICTURE_CLASS = "max-h-48 max-w-64 rounded-(--sc-radius-md) border border-(--sc-border-subtle) object-contain";
const NO_KEYS: ReadonlySet<string> = new Set();

interface PrivateStores {
	tools: StoreApi<ToolsStore>;
	messages: StoreApi<MessagesStore>;
	session: StoreApi<SessionStore>;
}

function hydrate(stores: PrivateStores, messages: AgentMessage[], live: boolean): void {
	stores.tools.getState().hydrateMessages(messages, { turnIsLive: live });
	stores.messages.setState({ messages });
}

/**
 * The owning tab's runtime with this subagent's own tools, messages and session
 * stores. The tools store reads a call's result from the transcript, so a card
 * pairs with its result the way a reloaded main session does.
 */
function useSubagentRuntime(messages: AgentMessage[], live: boolean): SessionRuntime {
	const parent = useSessionRuntime();
	const fallbackTabId = useRuntimeTabId();
	const command = useTabCommand();
	const [stores] = useState<PrivateStores>(() => {
		const created: PrivateStores = {
			tools: createToolsStore(),
			messages: createMessagesStore(),
			session: createSessionStore(),
		};
		// Tool paths and media resolve against the owning session's working directory.
		const cwd = (parent?.stores.get("session") as StoreApi<SessionStore> | undefined)?.getState().cwd;
		if (cwd) created.session.setState({ cwd });
		// Hydrated before the first render so no card paints without its result.
		hydrate(created, messages, live);
		return created;
	});
	const hydrated = useRef<{ messages: AgentMessage[]; live: boolean }>({ messages, live });
	useLayoutEffect(() => {
		if (hydrated.current.messages === messages && hydrated.current.live === live) return;
		hydrated.current = { messages, live };
		hydrate(stores, messages, live);
	}, [messages, live, stores]);
	return useMemo(() => {
		const all = new Map<RuntimeStoreKey, StoreApi<unknown>>(parent?.stores);
		all.set("tools", stores.tools as StoreApi<unknown>);
		all.set("messages", stores.messages as StoreApi<unknown>);
		all.set("session", stores.session as StoreApi<unknown>);
		return { tabId: parent?.tabId ?? fallbackTabId ?? "", command, stores: all, recovering: parent?.recovering };
	}, [parent, fallbackTabId, command, stores]);
}

/**
 * What a collapsed work card hides: the pictures and the audio/video its tool
 * calls produced or read. Open, the cards show them themselves.
 */
function SubagentToolMedia({
	row,
	results,
}: {
	row: Extract<HistoryRow, { kind: "process" }>;
	results: ReadonlyMap<string, { call: Record<string, unknown>; result: AgentMessage }>;
}): ReactNode {
	const parts: ReactNode[] = [];
	for (const message of row.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const found = results.get(block.id);
			if (!found || found.result.isError) continue;
			const mediaPath = resultDetails(found.result)?.mediaPath;
			const path = typeof mediaPath === "string" ? mediaPath : "";
			for (const image of extractResultImages(found.result)) {
				parts.push(
					<ToolImage
						className={PICTURE_CLASS}
						key={`${block.id}-${image.key}`}
						label={basename(path) || undefined}
						path={path}
						src={image.src}
					/>,
				);
			}
			parts.push(
				<ToolResultMedia
					args={found.call}
					key={`${block.id}-media`}
					result={found.result}
					toolName={found.result.toolName ?? block.name}
				/>,
			);
		}
	}
	return parts.length ? (
		<div className="omp-subagent-media ps-(--omp-editorial-inset) pe-(--omp-editorial-edge)">{parts}</div>
	) : null;
}

/** Each call's own result, by the key its tool card uses (repeated ids pair by occurrence). */
function pairResults(
	messages: readonly AgentMessage[],
): Map<string, { call: Record<string, unknown>; result: AgentMessage }> {
	const queued = new Map<string, AgentMessage[]>();
	for (const message of messages) {
		if (message.role !== "toolResult" || !message.toolCallId) continue;
		const list = queued.get(message.toolCallId);
		if (list) list.push(message);
		else queued.set(message.toolCallId, [message]);
	}
	const paired = new Map<string, { call: Record<string, unknown>; result: AgentMessage }>();
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const result = queued.get(block.id)?.shift();
			if (result) paired.set(block.id, { call: block.arguments, result });
		}
	}
	return paired;
}

export const SubagentTranscript = memo(function SubagentTranscript({
	agent,
	transcript,
}: {
	agent: SubagentSnapshot;
	transcript: SubagentTranscriptState;
}) {
	const t = useT();
	const { messages, loading, error } = transcript;
	const live = isLiveSubagentStatus(agent.status);
	const runtime = useSubagentRuntime(messages, live);
	const detail = useUiStore(s => s.transcriptDetail);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(NO_KEYS);
	const stick = useStickToBottom();

	// Rebuilt rows that did not change keep their object, so the memoized row components skip them.
	const built = useRef<ReadonlyMap<string, HistoryRow>>(new Map());
	const { rows, keys } = useMemo(() => {
		const rowsNow = buildHistoryRows(messages, detail, NO_KEYS);
		const grouped = detail === "compact" ? rowsNow : (groupReadRows(rowsNow) as HistoryRow[]);
		const rowKeys = buildHistoryRowKeys(grouped);
		const reused = reuseTranscriptRows(built.current, grouped, rowKeys);
		built.current = new Map(reused.map((row, index) => [rowKeys[index] ?? "", row]));
		return { rows: reused, keys: rowKeys };
	}, [messages, detail]);
	const results = useMemo(() => pairResults(messages), [messages]);
	const { liveTail, lastWorkRow } = liveWorkTail(rows, live);
	const currentWork = liveTail ? lastWorkRow : rows.findLastIndex(row => row.kind === "process");

	const setProcessExpanded = useMemo(
		() => (key: string, open: boolean) =>
			setExpanded(current => {
				if (current.has(key) === open) return current;
				const next = new Set(current);
				if (open) next.add(key);
				else next.delete(key);
				return next;
			}),
		[],
	);

	return (
		<SessionRuntimeProvider runtime={runtime}>
			<div className="omp-transcript-editorial omp-subagent-conversation relative min-h-0 flex-1">
				<div
					aria-label={t("chat.transcript.label")}
					className="omp-transcript-scroll absolute inset-0 overflow-y-auto overscroll-contain"
					ref={stick.scrollerRef}
					role="region"
					tabIndex={0}
					{...stick.scrollerProps}
				>
					<div className="py-2" ref={stick.contentRef}>
						{loading && messages.length === 0 && (
							<Spinner className="px-3 py-3" label={t("subagent.loadingTranscript")} size="sm" />
						)}
						{error &&
							(messages.length === 0 ? (
								<EmptyState
									actions={
										<Button icon={<RefreshCw />} onClick={transcript.reload} size="sm" variant="secondary">
											{t("common.retry")}
										</Button>
									}
									description={<span className="font-mono text-sc-xs select-text">{errorDetail(error)}</span>}
									icon={<FileWarning />}
									size="sm"
									title={t("subagent.transcriptFailed")}
								/>
							) : (
								/* Rows from the last good page stay on screen under the failure. */
								<div className="px-(--omp-editorial-inset) pb-2">
									<Banner live title={t("subagent.transcriptFailed")} variant="warning">
										<span className="font-mono text-sc-xs select-text">{errorDetail(error)}</span>
									</Banner>
								</div>
							))}
						{!error && messages.length === 0 && (
							<p className="px-(--omp-editorial-inset) py-3 text-sc-sm text-(--sc-text-muted)">
								{t("subagent.noEntries")}
							</p>
						)}
						{rows.map((row, index) => {
							const key = keys[index] ?? String(index);
							return (
								<div
									className="omp-transcript-row w-full"
									data-row-key={key}
									data-transcript-kind={row.kind}
									key={key}
								>
									{row.kind === "message" ? (
										<MessageBubble message={row.message} reaction={row.reaction} runningIndicator="dot" />
									) : row.kind === "readGroup" ? (
										<ReadGroupCard entries={row.entries} runningIndicator="dot" usage={row.usage} />
									) : row.kind === "process" ? (
										<>
											<ProcessGroup
												expanded={expanded.has(key)}
												live={liveTail && index === lastWorkRow}
												onExpandedChange={setProcessExpanded}
												row={row}
												rowKey={key}
												superseded={index < currentWork}
											/>
											{expanded.has(key) ? null : <SubagentToolMedia results={results} row={row} />}
										</>
									) : null}
								</div>
							);
						})}
						{transcript.hasMore && (
							<div className="flex justify-center px-(--omp-editorial-inset) py-2">
								<Button
									icon={<RefreshCw />}
									loading={transcript.busy}
									onClick={transcript.loadMore}
									size="sm"
									variant="secondary"
								>
									{t("subagent.loadMore")}
								</Button>
							</div>
						)}
					</div>
				</div>
				<JumpToLatest className="bottom-3" data-jump-to-latest onClick={stick.jumpToLatest} pinned={stick.pinned} />
			</div>
		</SessionRuntimeProvider>
	);
});
