/**
 * What a session needs from the person, decided once: the title bar badge, the sidebar row, the window title, the
 * tray and the work board's Needs you all read `sessionAttention`, so a session that needs the person says so in the
 * same words everywhere, and a waiting child or a failed check reaches the title bar and the sidebar as a question does.
 */

import { type ExtensionUiStore, isApprovalRequest, isUserBlockingRequest } from "../stores/extension-ui";

/** A prompt of the session's own: a tool approval or a plan up for review, else a question. */
export type AskKind = "question" | "approval";

export type AttentionKind = AskKind | "childWaiting" | "checkFailed";

export interface Attention {
	/** What the person is asked first. */
	kind: AttentionKind;
	/** Everything that needs the person: asks, waiting children and a failed check (the board's Needs you count). */
	count: number;
}

export interface AttentionState {
	/** The session's own prompts in the order it raised them; the first is the card on screen. */
	asks: readonly AskKind[];
	childrenWaiting: number;
	/** The newest check failed. Outside the work board only while the session is idle (`useSessionAttention`). */
	checkFailed: boolean;
}

/**
 * The session's own prompt comes first (it is the card on this screen), then a child waiting on the person, then a
 * failed check, which waits for nobody: it is said last, and outside the board never over work that goes on.
 */
export function sessionAttention(state: AttentionState): Attention | null {
	const count = state.asks.length + state.childrenWaiting + (state.checkFailed ? 1 : 0);
	const kind: AttentionKind | undefined =
		state.asks[0] ?? (state.childrenWaiting > 0 ? "childWaiting" : state.checkFailed ? "checkFailed" : undefined);
	return kind ? { kind, count } : null;
}

/** The session's own prompt, which only the person can answer: a session waiting on one counts as busy. */
export function isAsk(kind: AttentionKind | undefined): kind is AskKind {
	return kind === "question" || kind === "approval";
}

/**
 * The session works: its turn streams, compacts or waits to retry. Work outranks a failed check on every surface
 * outside the board (the title bar, the sidebar row, the window title, the dock badge, the tray), so they share it.
 */
export function sessionWorking(session: {
	isStreaming: boolean;
	isCompacting: boolean;
	retryInfo: object | null;
}): boolean {
	return session.isStreaming || session.isCompacting || session.retryInfo !== null;
}

/** The session's own prompts: its blocking requests (a sign-in's own left out), then a plan up for review. */
export function pendingAsks(
	extensionUi: Pick<ExtensionUiStore, "pendingRequests" | "loginRequestIds">,
	planPending: boolean,
): AskKind[] {
	const asks = extensionUi.pendingRequests
		.filter(request => isUserBlockingRequest(extensionUi, request))
		.map((request): AskKind => (isApprovalRequest(request) ? "approval" : "question"));
	if (planPending) asks.push("approval");
	return asks;
}

/** The locale key of each kind's one wording. */
export const ATTENTION_LABEL_KEY: Record<AttentionKind, string> = {
	question: "attention.question",
	approval: "attention.approval",
	childWaiting: "attention.childWaiting",
	checkFailed: "attention.checkFailed",
};
