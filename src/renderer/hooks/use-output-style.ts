import { useEffect, useRef } from "react";
import { createTabRpc } from "../lib/tab-rpc";
import { useOutputStyleStore } from "../stores/output-style";
import { sessionRuntime } from "../stores/session-runtime-context";
import { useTabsStore } from "../stores/tabs";

/**
 * Hands the output style to every tab's bridge: once a tab's session is ready
 * (a new tab, a restarted omp, a switched session) and again whenever the
 * style changes. The bridge keeps it as module state per omp process, so a
 * restart forgets it and the next ready state sends it again. Mounted once, by App.
 */
export function useOutputStyle(): void {
	const style = useOutputStyleStore(state => state.style);
	const loaded = useOutputStyleStore(state => state.loaded);
	const tabs = useTabsStore(state => state.tabs);
	/** tab id → the `sessionId:style` last delivered there. */
	const delivered = useRef(new Map<string, string>());

	useEffect(() => {
		void useOutputStyleStore.getState().load();
	}, []);

	useEffect(() => {
		if (!loaded) return;
		const open = new Set<string>();
		for (const tab of tabs) {
			open.add(tab.id);
			if (tab.status !== "ready") {
				// Not ready (starting, restarting): its omp may be new, so deliver again once it is.
				delivered.current.delete(tab.id);
				continue;
			}
			const key = `${tab.sessionId ?? ""}:${style}`;
			if (delivered.current.get(tab.id) === key) continue;
			// A tab that never had a non-default style needs nothing: stock is the default.
			if (style === "default" && !delivered.current.has(tab.id)) {
				delivered.current.set(tab.id, key);
				continue;
			}
			const runtime = sessionRuntime(tab.id);
			if (!runtime) continue;
			delivered.current.set(tab.id, key);
			void createTabRpc(runtime.command)
				.command({ type: "set_output_style", style })
				.then(response => {
					// An omp without the feature answers unsupported_omp; the health toast already says so.
					if (!response.success) delivered.current.delete(tab.id);
				})
				.catch(() => delivered.current.delete(tab.id));
		}
		for (const id of delivered.current.keys()) if (!open.has(id)) delivered.current.delete(id);
	}, [tabs, style, loaded]);
}
