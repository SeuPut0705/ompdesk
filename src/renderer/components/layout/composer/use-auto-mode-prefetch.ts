/**
 * Moves the automatic mode choice's judge round trip out of the send (lib/auto-mode-client.ts `prefetchAutoMode`,
 * gui-bridge modes/auto-mode.ts `modes.auto_mode_prefetch`): every typing pause sends the draft as the send will carry
 * it, so the decision at Enter is answered from stock's judgment cache (the omp warms its judge by itself as its session
 * starts). The order of a send is unchanged: the decision, then its mode, then the prompt.
 * This computer's own windows and tabs only: a paired host's tab, or a paired phone's page, would spend that device's
 * daily model requests on every pause.
 */
import { useEffect } from "react";
import { AUTO_MODE_PREFETCH_DEBOUNCE_MS, prefetchAutoMode } from "../../../lib/auto-mode-client";
import { danglingPasteFragment } from "../../../lib/paste-blobs";
import type { TabRpc } from "../../../lib/tab-rpc";
import { type SessionStore, useSessionStore } from "../../../stores/session";
import { sessionRuntimeStore } from "../../../stores/session-runtime-context";
import { useTabsStore } from "../../../stores/tabs";
import { webRuntime } from "../../../web/runtime";

export function useAutoModePrefetch({
	text,
	isStreaming,
	status,
	tabId,
	rpc,
	expand,
}: {
	text: string;
	isStreaming: boolean;
	status: string;
	tabId: string | null | undefined;
	rpc: TabRpc;
	/** The draft as the send carries it (the submit's own expansion). */
	expand: (draft: string) => string;
}): void {
	const local = useTabsStore(state => !state.tabs.find(tab => tab.id === tabId)?.device) && webRuntime() === null;

	useEffect(() => {
		if (!tabId || !local || status !== "ready") return;
		const draft = text.trim();
		if (!draft || danglingPasteFragment(draft)) return;
		const timer = setTimeout(() => {
			void prefetchAutoMode({
				message: expand(draft),
				isStreaming,
				session: sessionRuntimeStore<SessionStore>(tabId, "session") ?? useSessionStore,
				rpc,
			});
		}, AUTO_MODE_PREFETCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [text, isStreaming, status, tabId, local, rpc, expand]);
}
