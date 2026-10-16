import { useMemo } from "react";
import type {
	InlineCompletion,
	NextPromptUnavailable,
} from "../../../resources/gui-bridge/modes/next-prompt-contracts";
import { type TabRpc, useTabRpc } from "../lib/tab-rpc";
import { useNextPromptStore } from "../stores/next-prompt";
import { useSessionStore } from "../stores/session";

/** What the composer reads and calls for prompt suggestions (see stores/next-prompt.ts for the memory). */
export interface NextPromptView {
	/** The bridge reports suggestions on for THIS tab (a paired host's tab follows the host's pref).
	 * false while unknown or unsupported: the legacy `next-prompt` widget path stays. */
	builtin: boolean;
	/** The session's best candidate (the placeholder), only while the tab is ready and idle. */
	best?: string;
	/** The other candidates, shown as chips. */
	chips: readonly string[];
	/** Inline completion is effective for this tab. */
	inline: boolean;
	/** The last failure, cleared by the next success; only while the built-in is on. */
	unavailable?: { reason: NextPromptUnavailable; detail?: string };
	/** A suggestion was accepted (Tab/→ or chip). Deliberately a no-op: accepting fills the composer
	 * and the entry stays in memory until a submit or a run clears it, so a deleted draft brings it back. */
	accepted(): void;
	/** A `!` bash command finished. */
	refreshAfterBash(): void;
	/** The inline continuation for `draft`, or null; aborting `signal` also cancels the bridge's request. */
	completeInline(draft: string, requestId: string, signal: AbortSignal): Promise<string | null>;
	/** Cancel a pending inline request on the bridge. */
	cancelInline(): void;
}

/** Tell the tab's bridge a user `!` bash command finished (its output may change what comes next).
 * An omp without the feature answers unsupported_omp; nothing to show then. */
export function refreshNextPromptAfterBash(rpc: TabRpc): void {
	void rpc.command({ type: "refresh_next_prompt", reason: "bash" }).catch(() => {});
}

function cancelInlineRequest(rpc: TabRpc): void {
	void rpc.command({ type: "cancel_next_prompt", scope: "inline" }).catch(() => {});
}

const NO_CHIPS: readonly string[] = [];

export function useNextPrompt(): NextPromptView {
	const rpc = useTabRpc();
	const config = useSessionStore(s => s.nextPrompt);
	const failure = useSessionStore(s => s.nextPromptUnavailable);
	const status = useSessionStore(s => s.status);
	const isStreaming = useSessionStore(s => s.isStreaming);
	const key = useSessionStore(s => s.sessionFile || s.sessionId || undefined);
	const stored = useNextPromptStore(s => (key ? s.suggestions[key] : undefined));

	const builtin = config?.suggestions === true;
	const inline = builtin && config?.inline === true;
	const candidates = status === "ready" && !isStreaming ? stored?.candidates : undefined;
	const best = candidates?.[0];
	const chips = useMemo(() => (candidates && candidates.length > 1 ? candidates.slice(1) : NO_CHIPS), [candidates]);
	const unavailable = builtin ? (failure ?? undefined) : undefined;

	return useMemo<NextPromptView>(
		() => ({
			builtin,
			best,
			chips,
			inline,
			unavailable,
			accepted: () => {},
			refreshAfterBash: () => refreshNextPromptAfterBash(rpc),
			cancelInline: () => cancelInlineRequest(rpc),
			completeInline: async (draft, requestId, signal) => {
				if (signal.aborted) return null;
				const onAbort = () => cancelInlineRequest(rpc);
				signal.addEventListener("abort", onAbort, { once: true });
				try {
					const response = await rpc.command({ type: "complete_inline", draft, requestId });
					if (signal.aborted || !response.success) return null;
					return (response.data as InlineCompletion | undefined)?.text ?? null;
				} catch {
					return null;
				} finally {
					signal.removeEventListener("abort", onAbort);
				}
			},
		}),
		[builtin, best, chips, inline, unavailable, rpc],
	);
}
