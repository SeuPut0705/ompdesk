import { Archive, ChevronRight, FileText, GitBranch, Terminal } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useState } from "react";
import type { AgentMessage, ImageContent, MessageContent, ToolCallContent } from "../../../shared/rpc-types";
import { AnsiText, hasAnsi } from "../../lib/ansi";
import { cx, extractResultImage, formatClock, formatTokens, uiLocale } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { MarkdownRenderer } from "../../lib/markdown";
import { forkSessionFromMessageInNewTab, isRenderableMessageText } from "../../lib/messages";
import { extractModelMentions, type ModelMentionChip } from "../../lib/model-mentions";
import { PREVIEW_SCROLL_LG } from "../../lib/preview";
import { useTabRpc } from "../../lib/tab-rpc";
import { useSessionStore } from "../../stores/session";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { toast, toastError } from "../../stores/toast";
import { toolEntryKey } from "../../stores/tools";
import { Badge, Button, CopyButton, IconButton } from "../common";
import { referencedFiles } from "../tools/chat-media";
import { type RunningIndicator, ToolCard } from "../tools/ToolCard";
import { ToolImage } from "../tools/ToolImage";
import { CustomMessageCard, isCustomMessageCardType } from "./CustomMessageCard";
import { ReplyFiles } from "./ReplyFiles";
import { ThinkingBlock } from "./ThinkingBlock";
import { TodoReminderNote } from "./TodoReminderNote";
import { TurnErrorNotice } from "./TurnErrorNotice";
import { parseTodoReminder } from "./todo-reminder";
import { UsageRow } from "./UsageRow";
import { isSilentAbort } from "./work-turn";

export interface MessageBubbleProps {
	message: AgentMessage;
	/** Suppress per-message footer/padding inside an expanded Process group. */
	compact?: boolean;
	/** The timeline or process group can own the one animated running state. */
	runningIndicator?: RunningIndicator;
	/** Opening assistant emoji projected onto this user turn. */
	reaction?: string;
}

const COMPACTION_METHOD_KEYS: Record<string, string> = {
	remote: "chat.context.compactionMethod.remote",
	soft: "chat.context.compactionMethod.soft",
	handoff: "chat.context.compactionMethod.handoff",
	snapcompact: "chat.context.compactionMethod.snapcompact",
	shake: "chat.context.compactionMethod.shake",
};

/**
 * An attached picture. Stock restores a journal's blob references when it loads
 * the session; one that survives (its blob was collected), empty data, or bytes
 * that do not decode show as the unavailable-image chip, never a broken image.
 */
function InlineImage({ image }: { image: ImageContent }) {
	const t = useT();
	return (
		<ToolImage
			src={extractResultImage(image)?.src ?? null}
			path=""
			label={t("chat.attachedImage")}
			className="my-1 max-h-48 max-w-64 rounded-(--sc-radius-md) border border-(--sc-border-subtle) object-contain"
		/>
	);
}

/** ToolCard subscribes to the tools store itself, so the tool result lands inline. */
function ToolCardWithResult({ call, runningIndicator }: { call: ToolCallContent; runningIndicator: RunningIndicator }) {
	return (
		<ToolCard
			toolCallId={toolEntryKey(call)}
			toolName={call.name}
			args={call.arguments}
			runningIndicator={runningIndicator}
		/>
	);
}

const FILE_PREVIEW_CHARS = 12_000;

/** Calm hairline card shared by `!`/`$` executions and context summaries. */
const CONTEXT_CARD_CLASS =
	"omp-transcript-content min-w-0 overflow-hidden rounded-(--sc-radius-lg) border border-(--sc-border-subtle)";

function ExecutionBubble({ message }: { message: AgentMessage }) {
	const t = useT();
	const rpc = useTabRpc();
	// Local placeholder appended by the composer while a `!` bash or `$` eval
	// is in flight (use-composer-submit): Cancel stops it the way stock's Esc
	// does (abortBash / abortEval); the hydrated transcript record replaces it.
	const running = message.running === true;
	const [abortSent, setAbortSent] = useState(false);
	const python = message.role === "pythonExecution";
	const input = python ? message.code : message.command;
	const status = running
		? t("chat.exec.running")
		: message.cancelled
			? t("chat.exec.cancelled")
			: message.exitCode == null
				? t("chat.exec.finished")
				: t("chat.exec.exit", { code: message.exitCode });
	const failed = !running && (message.cancelled || (message.exitCode != null && message.exitCode !== 0));

	return (
		<div className="omp-execution-turn px-6 py-4">
			<div className={CONTEXT_CARD_CLASS}>
				<div className="flex min-h-10 items-center gap-2 border-b border-(--sc-divider) px-3 py-1.5">
					<Terminal aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
					<span className="text-sc-sm font-medium text-(--sc-text)">
						{python ? t("chat.exec.python") : t("chat.exec.shell")}
					</span>
					<span className="ml-auto flex items-center gap-2">
						<Badge dot={running} pulse={running} variant={running ? "info" : failed ? "error" : "success"}>
							{status}
						</Badge>
						{running && (
							<Button
								disabled={abortSent}
								onClick={() => {
									setAbortSent(true);
									void (python ? rpc.abortEval() : rpc.abortBash());
								}}
								size="sm"
								variant="ghost"
							>
								{t("common.cancel")}
							</Button>
						)}
					</span>
				</div>
				{input && (
					<pre className="border-b border-(--sc-divider) bg-(--sc-surface-1) px-3 py-2.5 font-mono text-sc-sm break-words whitespace-pre-wrap text-(--sc-text)">
						{python ? input : `$ ${input}`}
					</pre>
				)}
				{!running && (
					<pre
						className={cx(
							"px-3 py-2.5 font-mono text-sc-sm break-words whitespace-pre-wrap text-(--sc-text-secondary)",
							PREVIEW_SCROLL_LG,
						)}
					>
						{message.output && hasAnsi(message.output) ? (
							<AnsiText text={message.output} />
						) : (
							message.output || t("chat.exec.noOutput")
						)}
						{message.truncated ? `\n${t("chat.exec.truncated")}` : ""}
					</pre>
				)}
			</div>
		</div>
	);
}

function ContextBubble({ message }: { message: AgentMessage }) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const isFiles = message.role === "fileMention";
	const compactionMethodKey = message.method ? COMPACTION_METHOD_KEYS[message.method] : undefined;
	const compactionMethod = message.method
		? compactionMethodKey
			? t(compactionMethodKey)
			: message.method
		: undefined;
	const label =
		message.role === "compactionSummary"
			? compactionMethod && message.tokensBefore !== undefined && message.tokensAfter !== undefined
				? t("chat.context.compactedByFromTo", {
						method: compactionMethod,
						before: formatTokens(message.tokensBefore),
						after: formatTokens(message.tokensAfter),
					})
				: compactionMethod
					? t("chat.context.compactedBy", { method: compactionMethod })
					: message.tokensBefore
						? t("chat.context.compactedFrom", { tokens: message.tokensBefore.toLocaleString(uiLocale()) })
						: t("chat.context.compacted")
			: message.role === "branchSummary"
				? t("chat.context.branchSummary")
				: t("chat.context.referencedFiles");
	const Icon = isFiles ? FileText : Archive;

	return (
		<div className="omp-context-turn px-6 py-3">
			<div className={cx(CONTEXT_CARD_CLASS, "px-3.5 py-3")}>
				<div className="mb-2 flex items-center gap-1.5 text-sc-sm font-medium text-(--sc-text-muted)">
					<Icon aria-hidden className="size-(--sc-icon-sm) shrink-0" />
					{label}
				</div>
				{isFiles ? (
					<div className="space-y-1.5">
						{(message.files ?? []).map(file => (
							<details
								className="group overflow-hidden rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-(--sc-surface-1)"
								key={file.path}
							>
								<summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 font-mono text-sc-sm text-(--sc-text) [&::-webkit-details-marker]:hidden">
									<ChevronRight
										aria-hidden
										className="omp-disclosure-chevron size-(--sc-icon-sm) shrink-0 text-(--sc-text-subtle) group-open:rotate-90"
									/>
									<span className="min-w-0 break-all">
										{file.path}
										{file.skippedReason ? (
											<span className="font-(family-name:--sc-font-sans) text-(--sc-text-muted)">
												{` — ${file.skippedReason}`}
											</span>
										) : null}
									</span>
								</summary>
								<pre
									className={cx(
										"border-t border-(--sc-divider) px-3 py-2.5 font-mono text-sc-xs break-words whitespace-pre-wrap text-(--sc-text-secondary)",
										PREVIEW_SCROLL_LG,
									)}
								>
									{file.content.slice(0, FILE_PREVIEW_CHARS)}
									{file.content.length > FILE_PREVIEW_CHARS ? `\n${t("chat.context.previewTruncated")}` : ""}
								</pre>
							</details>
						))}
					</div>
				) : message.role === "branchSummary" ? (
					// The summary is the whole card: stock's branch summary has no short form.
					<div className={PREVIEW_SCROLL_LG}>
						<MarkdownRenderer content={message.summary ?? ""} />
					</div>
				) : (
					<>
						{message.shortSummary && <MarkdownRenderer content={message.shortSummary} />}
						{typeof message.warning === "string" && (
							<p role="status" className="text-sc-md text-(--sc-warning)">
								{message.warning}
							</p>
						)}
						{message.summary && (
							<>
								<button
									type="button"
									aria-expanded={expanded}
									onClick={() => setExpanded(open => !open)}
									className="-ms-1.5 mt-1 flex min-h-7 w-fit max-w-full items-center gap-2 rounded-(--sc-radius-sm) px-1.5 text-left text-sc-sm text-(--sc-text-muted) transition-colors duration-(--sc-duration-instant) hover:bg-(--sc-hover) hover:text-(--sc-text-secondary) aria-expanded:text-(--sc-text-secondary)"
								>
									<ChevronRight
										aria-hidden
										className={cx(
											"omp-disclosure-chevron size-(--sc-icon-sm) shrink-0 text-(--sc-text-subtle)",
											expanded && "rotate-90",
										)}
									/>
									{t("chat.context.details")}
								</button>
								{expanded && (
									<div className={cx("mt-2", PREVIEW_SCROLL_LG)}>
										<MarkdownRenderer content={message.summary} />
									</div>
								)}
							</>
						)}
					</>
				)}
			</div>
		</div>
	);
}

/**
 * Hover/focus-revealed message actions (time, copy, branch). Positioned over
 * the turn's own padding by CSS (`.omp-message-actions`) so an idle message is
 * exactly as tall as its content; opacity + :focus-within, never display:none.
 */
function MessageActions({
	className,
	copyText,
	onBranch,
	branchDisabled,
	timestamp,
}: {
	className: string;
	/** The message's text, built when the user copies it. */
	copyText: () => string;
	onBranch?: () => void;
	branchDisabled: boolean;
	timestamp: string;
}) {
	const t = useT();
	return (
		// select-none: a selection through the turn copies the message, never its clock.
		<div className={cx("omp-message-actions flex select-none items-center gap-0.5", className)}>
			{timestamp && <time className="px-1 text-sc-xs tabular-nums text-(--sc-text-subtle)">{timestamp}</time>}
			<CopyButton label={t("chat.copyMessage")} text={copyText} />
			{onBranch && (
				<IconButton
					className="disabled:cursor-wait"
					disabled={branchDisabled}
					icon={<GitBranch />}
					label={t("chat.branchFromHere")}
					onClick={onBranch}
					size="sm"
				/>
			)}
		</div>
	);
}

/**
 * One finalized message. User messages are a compact soft bubble on the
 * right; assistant messages are content-first (no bubble) and render text,
 * thinking, images, and tool rows. Standalone toolResult messages are folded
 * into their matching row through the tools store.
 */
export const MessageBubble = memo(function MessageBubble({
	message,
	compact = false,
	reaction,
	runningIndicator = "spinner",
}: MessageBubbleProps) {
	const t = useT();
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const [branching, setBranching] = useState(false);
	const switchPending = useSessionStore(state => state.switchPending !== null);
	if (message.role === "bashExecution" || message.role === "pythonExecution") {
		return <ExecutionBubble message={message} />;
	}
	if (message.role === "branchSummary" || message.role === "compactionSummary" || message.role === "fileMention") {
		return <ContextBubble message={message} />;
	}
	if (message.role === "custom" || message.role === "hookMessage") {
		if (message.display === false) return null;
		// Dedicated cards for the TUI customType set; unknown types fall through
		// to the generic label + content bubble below.
		if (isCustomMessageCardType(message.customType)) {
			// Cards inside a work run live in its notes (WorkNotes); here they stand alone.
			return <CustomMessageCard message={message} />;
		}
	}
	if (message.role === "toolResult") return null;
	// A reminder no work run owns: the same line the live card showed, never stock's prompt text.
	const reminder = parseTodoReminder(message);
	if (reminder)
		return (
			<div className="omp-todo-reminder ps-(--omp-editorial-inset) pe-(--omp-editorial-edge)">
				<ul className="omp-transcript-content omp-work-notes-list" aria-label={t("todoPanel.reminder")}>
					<li className="omp-work-notes-item">
						<TodoReminderNote message={message} reminder={reminder} />
					</li>
				</ul>
			</div>
		);
	// Stock's other developer messages (plan-mode, checkpoint, auto-continue prompts) are for the model only.
	if (message.role === "developer") return null;

	const content: MessageContent[] = Array.isArray(message.content)
		? message.content
		: typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: [];
	const isUser = message.role === "user";
	const isAssistant = message.role === "assistant";
	const isSteering = Boolean(message.steering);
	// Stock renders nothing for a silent abort (pi-tui transcript-render-helpers): no "Stopped", no error.
	const silentAbort = isAssistant && isSilentAbort(message);
	const stopped = isAssistant && !silentAbort && message.stopReason === "aborted";
	const timestamp = formatClock(message.timestamp);
	// User delegations (`^provider/model`, persisted as <model …/> tags) render
	// as atomic chips; the raw tags/selectors are stripped from the body text.
	// Computed inline (no hook) because this component early-returns above.
	const userMentions = (() => {
		if (!isUser) return { chips: [] as ModelMentionChip[], blocks: content };
		const chips: ModelMentionChip[] = [];
		const blocks = content.map(block => {
			if (block.type !== "text") return block;
			const extracted = extractModelMentions(block.text);
			chips.push(...extracted.chips);
			return { ...block, text: extracted.body };
		});
		return { chips, blocks };
	})();
	const customLabel =
		message.role === "custom" || message.role === "hookMessage"
			? (message.customType ?? t("chat.extensionMessage"))
			: null;

	const messageText = () =>
		content
			.filter((block): block is Extract<MessageContent, { type: "text" }> => block.type === "text")
			.map(block => block.text)
			.join("\n\n");

	const handleBranch = async () => {
		if (branching || switchPending) return;
		setBranching(true);
		try {
			const result = await forkSessionFromMessageInNewTab(message, rpc, tabId);
			if (result === "saved") toast({ variant: "warning", message: t("chat.branchSaved") });
		} catch (cause) {
			toastError({ title: t("sessionTree.forkFailed"), error: cause });
		} finally {
			setBranching(false);
		}
	};

	if (isUser) {
		return (
			<div className="omp-user-turn group flex justify-end px-6 py-2.5">
				<div className="omp-user-bubble relative min-w-0 rounded-(--sc-radius-lg) bg-(--sc-surface-2) px-4 py-2.5 text-sc-lg text-(--sc-text)">
					{reaction ? (
						<span
							aria-label={reaction}
							className="omp-user-reaction absolute -top-3 -left-3 flex size-7 items-center justify-center rounded-full border border-(--sc-border-subtle) bg-(--sc-elevated) text-sc-md shadow-(--sc-shadow-sm)"
							role="img"
						>
							{reaction}
						</span>
					) : null}
					{(isSteering || userMentions.chips.length > 0) && (
						<div className="mb-1.5 flex flex-wrap items-center gap-1.5">
							{isSteering && <Badge variant="info">{t("chat.steering")}</Badge>}
							{userMentions.chips.map((chip, chipIndex) => {
								const name = chip.name ?? chip.selector ?? (chip.agent ? `@${chip.agent}` : "");
								return (
									<span key={chipIndex} title={t("chat.delegatedTo", { name })}>
										<Badge variant="accent">{name}</Badge>
									</span>
								);
							})}
						</div>
					)}
					{userMentions.blocks.map((block, i) => {
						if (block.type === "text") {
							return (
								<div key={i} className="omp-user-text">
									<MarkdownRenderer content={block.text} singleDollarTextMath={false} />
								</div>
							);
						}
						if (block.type === "image") {
							return <InlineImage key={i} image={block} />;
						}
						return null;
					})}
					<MessageActions
						branchDisabled={branching || switchPending}
						className="omp-user-actions"
						copyText={messageText}
						onBranch={() => void handleBranch()}
						timestamp={timestamp}
					/>
				</div>
			</div>
		);
	}

	// Assistant / system: render block by block.
	const blocks: ReactNode[] = [];
	let sawNonToolBlock = false;
	for (const block of content) {
		switch (block.type) {
			case "text": {
				if (isRenderableMessageText(block.text)) {
					blocks.push(<MarkdownRenderer key={blocks.length} content={block.text} />);
					sawNonToolBlock = true;
				}
				break;
			}
			case "thinking": {
				if (isRenderableMessageText(block.thinking)) {
					blocks.push(<ThinkingBlock key={blocks.length} text={block.thinking} />);
					sawNonToolBlock = true;
				}
				break;
			}
			case "toolCall": {
				blocks.push(
					<ToolCardWithResult key={toolEntryKey(block)} call={block} runningIndicator={runningIndicator} />,
				);
				break;
			}
			case "image": {
				blocks.push(<InlineImage key={blocks.length} image={block} />);
				sawNonToolBlock = true;
				break;
			}
		}
	}
	// Media and documents the reply links or quotes play or open under it, once each
	// (an image embed or a raw <video> already renders in place).
	const references = isAssistant
		? referencedFiles(
				content
					.flatMap(block => (block.type === "text" && isRenderableMessageText(block.text) ? [block.text] : []))
					.join("\n\n"),
			)
		: [];

	const failure = (Boolean(message.errorMessage) && !silentAbort) || stopped;
	if (blocks.length === 0 && !failure && !customLabel && !isSteering) return null;

	// Tool-only messages and messages nested inside an expanded Process group
	// carry no message actions: tool-only copy would be empty, and the Process
	// disclosure owns the grouped chrome and branch point.
	const compactChrome = compact || (!sawNonToolBlock && !failure && !customLabel && !isSteering);

	return (
		<div
			className={cx(
				"group relative flex px-6",
				!compactChrome && "omp-assistant-turn",
				compactChrome && "omp-assistant-turn--compact",
				compactChrome ? "py-1.5" : "py-3",
			)}
		>
			<div className="omp-transcript-content min-w-0">
				{customLabel && <div className="mb-1.5 text-sc-xs font-medium text-(--sc-text-muted)">{customLabel}</div>}
				{isSteering && (
					<div className="mb-2">
						<Badge variant="info">{t("chat.steeringResponse")}</Badge>
					</div>
				)}
				{blocks}
				<ReplyFiles references={references} />
				{failure && (
					<TurnErrorNotice
						errorMessage={message.errorMessage}
						stopReason={message.stopReason}
						timestamp={message.timestamp}
					/>
				)}
				<UsageRow message={message} />
			</div>
			{!compactChrome && (
				<MessageActions
					branchDisabled={branching || switchPending}
					className="omp-assistant-actions"
					copyText={messageText}
					onBranch={isAssistant ? () => void handleBranch() : undefined}
					timestamp={timestamp}
				/>
			)}
		</div>
	);
});
