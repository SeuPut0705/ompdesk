import type {
	AgentMessage,
	ImageContent,
	RpcResponse,
	RpcSessionTreeNode,
	RpcSessionTreeResult,
} from "../../shared/rpc-types";
import { hydrateSession, resetRetryPending } from "../hooks/use-rpc-events";
import { useMessagesStore } from "../stores/messages";
import { useSessionStore } from "../stores/session";
import { withSessionRuntime } from "../stores/session-runtime-context";
import { useTabsStore } from "../stores/tabs";
import { toast, toastError } from "../stores/toast";
import { translate } from "./i18n";
import type { TabRpc } from "./tab-rpc";

/**
 * Message-level actions shared between the command palette and the global
 * keyboard shortcuts (App.tsx), so both ride the same retry semantics.
 */

/**
 * Display-worthy model text. Punctuation/whitespace-only fragments (".",
 * "…", "---") are provider/model filler between tool calls, while letters,
 * numbers, and emoji are user-visible content in any script.
 */
const MESSAGE_TEXT_CONTENT_CHAR = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;
export function isRenderableMessageText(text: string): boolean {
	return MESSAGE_TEXT_CONTENT_CHAR.test(text);
}

const REACTION_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const REACTION_GRAPHEME_RE = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3)/u;
const NEXT_REACTION_WHITESPACE_RE = /^[ \t]*\r?\n|^[ \t]+/;

/** Match the TUI contract: an opening emoji reacts to the preceding user bubble. */
export function splitReaction(text: string): { emoji?: string; body: string } {
	const head = text.trimStart();
	const emoji = REACTION_SEGMENTER.segment(head)[Symbol.iterator]().next().value?.segment;
	if (!emoji || !REACTION_GRAPHEME_RE.test(emoji)) return { body: text };
	const rest = head.slice(emoji.length);
	const whitespace = rest.match(NEXT_REACTION_WHITESPACE_RE)?.[0].length ?? 0;
	return { emoji, body: rest.slice(whitespace) };
}
/** Plain-text content of a message (user text lives in text blocks). */
export function messageText(message: AgentMessage): string {
	if (typeof message.content === "string") return message.content.trim();
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter(part => part.type === "text")
		.map(part => (part.type === "text" ? part.text : ""))
		.join("\n")
		.trim();
}

function messagePreview(message: AgentMessage): string {
	const text = messageText(message).replace(/\s+/g, " ").trim();
	return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/**
 * Retry the last turn: re-send the most recent user message, interrupting the
 * active turn when streaming (TUI app.retry parity). `onEmpty` fires when the
 * session has no user message to retry; RPC failures throw for the caller to
 * surface. Pass the pane's `rpc` and `tabId` (an inline error card in a split
 * view) so the retry reads and targets that session, not the focused one.
 */
export async function retryLastTurn(
	onEmpty: () => void,
	rpc: Pick<TabRpc, "prompt" | "abortAndPrompt"> = window.omp.rpc,
	tabId?: string | null,
): Promise<void> {
	const snapshot = () => ({
		messages: useMessagesStore.getState().messages,
		streaming: useSessionStore.getState().isStreaming,
	});
	const { messages, streaming } = tabId ? withSessionRuntime(tabId, snapshot) : snapshot();
	const lastUser = [...messages].reverse().find(message => message.role === "user");
	const text = lastUser ? messageText(lastUser) : "";
	if (!text) {
		onEmpty();
		return;
	}
	const response = streaming ? await rpc.abortAndPrompt(text) : await rpc.prompt(text);
	if (!response.success) throw new Error(response.error);
}

export type TurnErrorKind =
	| "aborted"
	| "connection"
	| "contextOverflow"
	| "auth"
	| "rateLimit"
	| "overloaded"
	| "compaction"
	| "unknown";

/** Recovery offered next to a failed turn, fixing action first. */
export type TurnErrorAction = "retry" | "changeModel" | "openProviders" | "compact";

export interface TurnErrorDescription {
	kind: TurnErrorKind;
	/** i18n key of the ≤4-word title. */
	titleKey: string;
	/** i18n key of the one-sentence guidance (what happened + what to do). */
	guidanceKey: string;
	actions: readonly TurnErrorAction[];
	/** Raw provider text, kept for a collapsible detail; "" when there is none. */
	detail: string;
}

const TURN_ERROR_ACTIONS: Record<TurnErrorKind, readonly TurnErrorAction[]> = {
	aborted: [],
	connection: ["retry", "openProviders"],
	contextOverflow: ["compact", "changeModel"],
	auth: ["openProviders", "changeModel"],
	rateLimit: ["retry", "changeModel"],
	overloaded: ["retry", "changeModel"],
	compaction: ["changeModel", "retry"],
	unknown: ["retry", "changeModel"],
};

/** An HTTP status only counts at the start or right after a status/code/HTTP/error word — never inside "8,403 tokens". */
function statusPattern(codes: string): RegExp {
	return new RegExp(String.raw`(?:^|\b(?:status|code|http|error)\b\W{0,3}|\()(?:${codes})\b`, "i");
}

/**
 * First match wins, so the order resolves overlaps: a compaction failure
 * mentions "context", and a 429 can mention tokens per minute.
 */
const TURN_ERROR_PATTERNS: ReadonlyArray<readonly [Exclude<TurnErrorKind, "unknown">, readonly RegExp[]]> = [
	["aborted", [/request was aborted|operation was aborted|aborted by (?:the )?user|\babort ?error\b/i]],
	["compaction", [/compaction freed too little|compaction failed|failed to compact|could not compact/i]],
	["rateLimit", [statusPattern("429"), /rate[ _-]?limit|too many requests|quota|usage limit|insufficient_quota/i]],
	[
		"contextOverflow",
		[
			/prompt is too long|context[ _-](?:length|window)|maximum context|too many tokens|context_length_exceeded/i,
			/input is too long|exceeds? the (?:model'?s? )?(?:context|maximum)/i,
		],
	],
	[
		"auth",
		[
			statusPattern("401|403"),
			/invalid[ _-]?(?:x-)?api[ _-]?key|unauthori[sz]ed|authentication|\bforbidden\b/i,
			/no api key|api key (?:is )?(?:missing|not found|invalid)/i,
			/no models available|no (?:default )?model selected|not logged in|log ?in required|token (?:has )?expired/i,
		],
	],
	[
		"overloaded",
		[statusPattern("502|503|529"), /overloaded|service unavailable|temporarily unavailable|over capacity/i],
	],
	[
		"connection",
		[
			/unable to connect|econnrefused|econnreset|enotfound|eai_again|etimedout|getaddrinfo|fetch failed/i,
			/network ?error|socket hang up|timed? ?out|timeout|connection (?:refused|reset|closed|error|failed)/i,
		],
	],
];

/**
 * Humanize a failed or stopped turn: what kind of failure it was, a localized
 * title + one-sentence guidance (as i18n keys), and the recovery actions that
 * apply. Pure — the transcript error card, the turn-failed toast and the
 * compaction notice all read the same answer. A user abort is `aborted`
 * (rendered as a neutral "Stopped", never as an error).
 */
export function describeTurnError(errorMessage: string | undefined, stopReason?: string): TurnErrorDescription {
	const detail = (errorMessage ?? "").trim();
	let kind: TurnErrorKind = stopReason === "aborted" ? "aborted" : "unknown";
	if (kind === "unknown" && detail) {
		kind = TURN_ERROR_PATTERNS.find(([, patterns]) => patterns.some(pattern => pattern.test(detail)))?.[0] ?? kind;
	}
	return {
		kind,
		titleKey: `turnError.${kind}.title`,
		guidanceKey: `turnError.${kind}.guidance`,
		actions: TURN_ERROR_ACTIONS[kind],
		detail,
	};
}

/** Toast copy for a failed turn or compaction: humanized title + guidance, never raw provider English alone. */
export function turnErrorToast(
	errorMessage: string | undefined,
	stopReason?: string,
): { title: string; message: string; kind: TurnErrorKind } {
	const description = describeTurnError(errorMessage, stopReason);
	return {
		kind: description.kind,
		title: translate(description.titleKey),
		message: translate(description.guidanceKey),
	};
}

/** Abort the active turn and synchronously retire any live retry UI. */
export async function abortActiveTurn(
	rpc: Pick<TabRpc, "abort" | "abortRetry"> = window.omp.rpc,
	tabId?: string | null,
): Promise<RpcResponse> {
	const retrying = useSessionStore.getState().retryInfo !== null;
	if (retrying) {
		resetRetryPending(tabId ?? undefined);
		useSessionStore.setState({ retryInfo: null, awaitingModelSince: null });
		try {
			await rpc.abortRetry();
		} catch {
			// Generic abort below also cancels retry server-side.
		}
	}
	return rpc.abort();
}

/** Branch from a user entry, restoring its draft and refreshing the session. */
export async function branchSessionFromEntry(entryId: string): Promise<"branched" | "cancelled"> {
	const response = await window.omp.rpc.branch(entryId);
	if (!response.success) throw new Error(response.error);
	const data = response.data as { cancelled?: boolean; text?: string } | undefined;
	if (data?.cancelled) return "cancelled";
	if (data?.text !== undefined) {
		window.dispatchEvent(new CustomEvent("omp:fill-composer", { detail: { text: data.text } }));
	}
	await hydrateSession();
	return "branched";
}

/** Copy the tree path through one message into an independent session and open it in a new tab. */
export async function forkSessionFromEntryInNewTab(
	entryId: string,
	sourceTabId = useTabsStore.getState().activeTabId,
	rpc: Pick<TabRpc, "forkFrom"> = window.omp.rpc,
): Promise<"opened" | "saved"> {
	const tabs = useTabsStore.getState();
	if (!sourceTabId || tabs.activeTabId !== sourceTabId || useSessionStore.getState().switchPending !== null) {
		throw new Error("The active session changed while preparing the branch");
	}
	const sourceTab = tabs.tabs.find(tab => tab.id === sourceTabId);
	if (!sourceTab) throw new Error("The source session is no longer open");
	const response = await rpc.forkFrom(entryId);
	if (!response.success) throw new Error(response.error);
	const data = response.data as { sessionPath?: string } | undefined;
	if (!data?.sessionPath) throw new Error("fork_from did not return a session path");
	if (useTabsStore.getState().activeTabId !== sourceTabId || useSessionStore.getState().switchPending !== null) {
		return "saved";
	}
	const tabId = await useTabsStore.getState().openTab({
		cwd: sourceTab.cwd,
		sessionPath: data.sessionPath,
		kind: sourceTab.kind,
	});
	return tabId ? "opened" : "saved";
}

/** Resolve legacy transcript messages through the active OMP session tree, then fork them. */
export async function forkSessionFromMessageInNewTab(
	message: AgentMessage,
	rpc: Pick<TabRpc, "forkFrom" | "getSessionTree"> = window.omp.rpc,
	sourceTabId = useTabsStore.getState().activeTabId,
): Promise<"opened" | "saved"> {
	if (!sourceTabId || useSessionStore.getState().switchPending !== null) {
		throw new Error("The active session changed while preparing the branch");
	}
	let entryId = message.entryId;
	if (!entryId) {
		const response = await rpc.getSessionTree();
		if (!response.success) throw new Error(response.error);
		const data = response.data as RpcSessionTreeResult | undefined;
		const timestamp =
			typeof message.timestamp === "number" ? message.timestamp : Date.parse(message.timestamp ?? "") || 0;
		const candidates = (data?.tree ?? []).filter(
			(node: RpcSessionTreeNode) => node.onActiveBranch && node.role === message.role,
		);
		const timestampMatches = timestamp === 0 ? [] : candidates.filter(node => node.timestamp === timestamp);
		if (timestampMatches.length === 1) entryId = timestampMatches[0]?.entryId;
		const preview = messagePreview(message);
		const previewMatches = candidates.filter(node => node.textPreview === preview);
		if (!entryId && previewMatches.length === 1) entryId = previewMatches[0]?.entryId;
		if (!entryId && previewMatches.length > 1) {
			const transcript = useMessagesStore.getState().messages;
			const targetIndex = transcript.indexOf(message);
			if (targetIndex >= 0) {
				let occurrence = 0;
				for (let index = 0; index < targetIndex; index++) {
					const candidate = transcript[index];
					if (candidate?.role === message.role && messagePreview(candidate) === preview) occurrence++;
				}
				entryId = previewMatches[occurrence]?.entryId;
			}
		}
	}
	if (!entryId) throw new Error("Could not locate this message in the active session tree");
	return forkSessionFromEntryInNewTab(entryId, sourceTabId, rpc);
}

/** The queued steer/follow-up message pulled back by the dequeue RPC. */
interface DequeuedMessage {
	text: string;
	images?: ImageContent[];
}

/**
 * Restore a queued message into the composer (TUI app.message.dequeue / Alt+Up
 * parity): the RPC pops the last queued steer (else follow-up) with its
 * attachments and leaves the rest queued; it goes back into the composer for
 * editing — text prepended ahead of any draft, images appended to the image
 * strip. `onEmpty` fires when nothing was queued; RPC failures throw for the
 * caller to surface.
 */
export async function restoreQueuedMessages(onEmpty: () => void): Promise<void> {
	const response = await window.omp.rpc.dequeue();
	if (!response.success) throw new Error(response.error);
	const data = response.data as { messages?: DequeuedMessage[] } | undefined;
	const restored = data?.messages?.[0];
	if (!restored) {
		onEmpty();
		return;
	}
	// InputArea owns the "omp:fill-composer" listener.
	window.dispatchEvent(
		new CustomEvent("omp:fill-composer", {
			detail: { text: restored.text, images: restored.images, prepend: true },
		}),
	);
}

/**
 * Clear the conversation context in place (TUI /clear parity via the
 * clear_context RPC): drops the context, keeps the session id and transcript
 * file. Refused with a warning while streaming / a foreground execution runs
 * (server code "busy"); on success rehydrates the transcript + context bar
 * and reports the dropped count. Returns whether the context was cleared.
 */
export async function clearSessionContext(
	rpc: Pick<TabRpc, "clearContext"> = window.omp.rpc,
	hydrate: () => Promise<void> = hydrateSession,
): Promise<boolean> {
	const response = await rpc.clearContext();
	if (!response.success) {
		toastError({ title: translate("cmd.clear"), error: response, variant: "warning" });
		return false;
	}
	const data = response.data as { droppedCount?: number } | undefined;
	toast({ variant: "success", message: translate("input.clear.done", { count: data?.droppedCount ?? 0 }) });
	await hydrate();
	return true;
}
