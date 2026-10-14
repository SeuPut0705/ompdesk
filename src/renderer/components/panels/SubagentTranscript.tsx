import { useTabRpc } from "../../lib/tab-rpc";
import { useRuntimeTabId, withSessionRuntime } from "../../stores/session-runtime-context";
/**
 * Lazily loaded subagent transcript (byte pagination), shown in the
 * transcript sheet. Loaded pages also feed the tool-call ownership registry
 * so nested spawn edges resolve progressively.
 */

import { FileWarning, RefreshCw } from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentMessage, SubagentSnapshot } from "../../../shared/rpc-types";
import { errorDetail } from "../../lib/error-detail";
import { basename, extractResultImages, resultDetails } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { ReplyFiles } from "../chat/ReplyFiles";
import { Banner, Button, EmptyState, Spinner } from "../common";
import { referencedFiles } from "../tools/chat-media";
import { ToolImage } from "../tools/ToolImage";
import { ToolResultMedia } from "../tools/ToolMedia";
import { registerTranscriptToolCalls } from "./subagent-graph";

function messageText(message: AgentMessage): string {
	if (typeof message.content === "string") return message.content.trim();
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter(part => part.type === "text")
		.map(part => (part.type === "text" ? part.text : ""))
		.join("\n")
		.trim();
}

/** Characters of a message's text the sheet shows. */
const TEXT_LIMIT = 1200;
/** The main transcript's attached-picture size (MessageBubble's InlineImage). */
const PICTURE_CLASS = "max-h-48 max-w-64 rounded-(--sc-radius-md) border border-(--sc-border-subtle) object-contain";

/**
 * What the main transcript shows beside a message's text, in the sheet too:
 * attached and tool-result pictures, the audio/video a tool produced or read,
 * and the files a reply names.
 */
function MessageMedia({
	message,
	callArgs,
}: {
	message: AgentMessage;
	callArgs: ReadonlyMap<string, Record<string, unknown>>;
}): ReactNode {
	const t = useT();
	const parts: ReactNode[] = [];
	if (message.role === "toolResult") {
		if (message.isError) return null;
		const mediaPath = resultDetails(message)?.mediaPath;
		const path = typeof mediaPath === "string" ? mediaPath : "";
		for (const image of extractResultImages(message)) {
			parts.push(
				<ToolImage
					className={PICTURE_CLASS}
					key={image.key}
					label={basename(path) || undefined}
					path={path}
					src={image.src}
				/>,
			);
		}
		parts.push(
			<ToolResultMedia
				args={callArgs.get(message.toolCallId ?? "") ?? {}}
				key="media"
				result={message}
				toolName={message.toolName ?? ""}
			/>,
		);
	} else if (Array.isArray(message.content)) {
		for (const [index, part] of message.content.entries()) {
			if (part.type !== "image") continue;
			const src = extractResultImages(part)[0]?.src ?? null;
			parts.push(
				<ToolImage
					className={PICTURE_CLASS}
					key={`image-${index}`}
					label={t("chat.attachedImage")}
					path=""
					src={src}
				/>,
			);
		}
		if (message.role === "assistant") {
			parts.push(<ReplyFiles key="files" references={referencedFiles(messageText(message))} />);
		}
	}
	return parts.length ? <div className="omp-subagent-media">{parts}</div> : null;
}

interface TranscriptState {
	loading: boolean;
	messages: AgentMessage[];
	nextByte: number;
	hasMore: boolean;
}

export const SubagentTranscript = memo(function SubagentTranscript({ agent }: { agent: SubagentSnapshot }) {
	const t = useT();
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const generation = useRef(0);
	const [error, setError] = useState<string | null>(null);
	const [state, setState] = useState<TranscriptState>({
		loading: true,
		messages: [],
		nextByte: 0,
		hasMore: true,
	});
	const loadingRef = useRef(false);
	// Tool results name their call; its arguments say what a tts or write produced.
	const callArgs = useMemo(() => {
		const args = new Map<string, Record<string, unknown>>();
		for (const message of state.messages) {
			if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
			for (const part of message.content) if (part.type === "toolCall") args.set(part.id, part.arguments);
		}
		return args;
	}, [state.messages]);
	// `agent.status` changes arrive via prop updates after `load` has memoized —
	// track it in a ref so a running agent keeps a refresh affordance without
	// recreating `load` (which would re-run load(0) and duplicate messages).
	const statusRef = useRef(agent.status);
	useEffect(() => {
		statusRef.current = agent.status;
	}, [agent.status]);

	const load = useCallback(
		async (fromByte: number) => {
			if (loadingRef.current) return;
			loadingRef.current = true;
			const version = generation.current;
			setError(null);
			setState(prev => ({ ...prev, loading: true }));
			try {
				const response = await rpc.getSubagentMessages(agent.id, agent.sessionFile, fromByte);
				if (version !== generation.current) return;
				if (!response.success) {
					// Shown inline only: the sheet is what the user is looking at.
					setError(response.error);
					setState(prev => ({ ...prev, loading: false, hasMore: false }));
					return;
				}
				const data = response.data as {
					messages?: AgentMessage[];
					nextByte?: number;
					reset?: boolean;
				};
				const incoming = data.messages ?? [];
				if (tabId) withSessionRuntime(tabId, () => registerTranscriptToolCalls(agent.id, incoming));
				else registerTranscriptToolCalls(agent.id, incoming);
				setState(prev => ({
					loading: false,
					messages: data.reset || fromByte === 0 ? incoming : [...prev.messages, ...incoming],
					nextByte: data.nextByte ?? fromByte,
					// A still-running agent keeps its load-more affordance even when
					// caught up (0 new messages) — it doubles as the refresh button.
					hasMore: incoming.length > 0 || statusRef.current === "started",
				}));
			} catch (cause) {
				if (version === generation.current) {
					setError(String(cause));
					setState(previous => ({ ...previous, loading: false }));
				}
			} finally {
				if (version === generation.current) loadingRef.current = false;
			}
		},
		[agent.id, agent.sessionFile, rpc.getSubagentMessages, tabId],
	);

	useEffect(() => {
		generation.current++;
		loadingRef.current = false;
		setState({ loading: true, messages: [], nextByte: 0, hasMore: true });
		void load(0);
		return () => {
			generation.current++;
		};
	}, [load]);

	if (state.loading && state.messages.length === 0) {
		return <Spinner className="px-2 py-3" label={t("subagent.loadingTranscript")} size="sm" />;
	}

	return (
		<div className="space-y-1.5 px-2 py-2">
			{error &&
				(state.messages.length === 0 ? (
					<EmptyState
						actions={
							<Button icon={<RefreshCw />} onClick={() => void load(0)} size="sm" variant="secondary">
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
					<Banner live title={t("subagent.transcriptFailed")} variant="warning">
						<span className="font-mono text-sc-xs select-text">{errorDetail(error)}</span>
					</Banner>
				))}
			{!error && state.messages.length === 0 && (
				<div className="text-omp-sm text-(--omp-dim) italic">{t("subagent.noEntries")}</div>
			)}
			{state.messages.map((message, index) => {
				const text = messageText(message);
				const media = <MessageMedia callArgs={callArgs} message={message} />;
				const hasPictures =
					message.role === "toolResult" ||
					(Array.isArray(message.content) && message.content.some(part => part.type === "image"));
				if (!text && !hasPictures) return null;
				return (
					<div className="rounded-sm border-l-2 border-(--omp-border-muted) px-2 py-1" key={index}>
						<div className="mb-0.5 text-omp-xxs font-semibold tracking-wider text-(--omp-dim) uppercase">
							{message.role}
						</div>
						{text ? (
							<div className="text-omp-sm leading-snug break-words whitespace-pre-wrap text-(--omp-muted)">
								{text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text}
							</div>
						) : null}
						{media}
					</div>
				);
			})}
			{state.hasMore && (
				<button
					className="flex items-center gap-1.5 text-omp-sm text-(--omp-link) transition-colors hover:brightness-125 disabled:opacity-50"
					disabled={state.loading}
					onClick={() => void load(state.nextByte)}
					type="button"
				>
					{state.loading ? <Spinner size="sm" /> : <RefreshCw size={10} />}
					{t("subagent.loadMore")}
				</button>
			)}
		</div>
	);
});
