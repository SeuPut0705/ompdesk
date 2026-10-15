import { useEffect, useRef } from "react";
import type { StoreApi } from "zustand/vanilla";
import { createTabRpc } from "../lib/tab-rpc";
import type { ComposerStore } from "../stores/composer";
import { sessionRuntime, sessionRuntimeStore } from "../stores/session-runtime-context";
import { useTabsStore } from "../stores/tabs";

interface Watch {
	/** The session and composer store this watch reports for. */
	sessionId: string;
	store: StoreApi<ComposerStore>;
	unsubscribe: () => void;
}

/**
 * Tells each tab's bridge whether its composer draft is empty. Stock's idle
 * compaction timer (re-armed by resources/gui-bridge/idle-compaction.ts) skips
 * a session whose input holds text, as the terminal UI does with its editor;
 * the bridge cannot see the GUI draft, so this reports every empty ⇄ non-empty
 * change, and the current state again once a tab's session is ready (a new tab,
 * a restarted omp, a switched session). Mounted once, by App.
 */
export function useIdleCompactionDraft(): void {
	const tabs = useTabsStore(state => state.tabs);
	const watches = useRef(new Map<string, Watch>());

	useEffect(() => {
		const open = new Set<string>();
		for (const tab of tabs) {
			open.add(tab.id);
			const current = watches.current.get(tab.id);
			const runtime = sessionRuntime(tab.id);
			const store = sessionRuntimeStore<ComposerStore>(tab.id, "composer");
			const sessionId = tab.sessionId ?? "";
			if (tab.status !== "ready" || !runtime || !store) {
				// Its omp may be new once it is ready again: report afresh then.
				current?.unsubscribe();
				watches.current.delete(tab.id);
				continue;
			}
			if (current && current.sessionId === sessionId && current.store === store) continue;
			current?.unsubscribe();
			const rpc = createTabRpc(runtime.command);
			let reported: boolean | undefined;
			const report = () => {
				const empty = store.getState().draft.trim() === "";
				if (empty === reported) return;
				reported = empty;
				// An omp without the feature answers unsupported_omp; the health toast already says so.
				void rpc.command({ type: "set_idle_compaction_draft", empty }).catch(() => {});
			};
			report();
			watches.current.set(tab.id, { sessionId, store, unsubscribe: store.subscribe(report) });
		}
		for (const [id, watch] of watches.current) {
			if (open.has(id)) continue;
			watch.unsubscribe();
			watches.current.delete(id);
		}
	}, [tabs]);

	useEffect(() => {
		const current = watches.current;
		return () => {
			for (const watch of current.values()) watch.unsubscribe();
			current.clear();
		};
	}, []);
}
