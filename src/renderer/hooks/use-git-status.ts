import { useEffect, useRef, useState } from "react";
import type { RpcGitStatus } from "../../shared/rpc-types";
import { acceptsActiveTabEvents, onActiveTabRouteSettled } from "../lib/tab-routing";
import { pollWhileVisible } from "../lib/visible-poll";
import { useSessionStore } from "../stores/session";
import { useTabsStore } from "../stores/tabs";

/**
 * Live git state of the active tab (the PR create dialog): polls the ACTIVE
 * tab's sidecar `get_git_status` every 2.5s while the window is shown
 * (porcelain is ~10-30ms), resets on tab/cwd change (no stale cross-tab
 * flash), and refetches on the streaming true→false edge — a finished run
 * likely touched files. Background tabs are never polled.
 */
export function useGitStatus(): { status: RpcGitStatus | null; refresh: () => void } {
	const activeTabId = useTabsStore(s => s.activeTabId);
	const cwd = useSessionStore(s => s.cwd);
	const isStreaming = useSessionStore(s => s.isStreaming);
	const [status, setStatus] = useState<RpcGitStatus | null>(null);
	const refreshRef = useRef<() => void>(() => {});

	useEffect(() => {
		void activeTabId;
		void cwd;
		let cancelled = false;
		const refresh = async () => {
			if (!acceptsActiveTabEvents()) return;
			const requestTabId = useTabsStore.getState().activeTabId;
			try {
				const response = await window.omp.rpc.getGitStatus();
				if (!cancelled && acceptsActiveTabEvents() && useTabsStore.getState().activeTabId === requestTabId) {
					setStatus(response.success ? (response.data as RpcGitStatus) : null);
				}
			} catch {
				if (!cancelled && useTabsStore.getState().activeTabId === requestTabId) setStatus(null);
			}
		};
		refreshRef.current = () => void refresh();
		setStatus(null);
		void refresh();
		const unsubscribeRoute = onActiveTabRouteSettled(() => void refresh());
		const stopPoll = pollWhileVisible(() => void refresh(), 2500);
		return () => {
			cancelled = true;
			unsubscribeRoute();
			stopPoll();
		};
	}, [activeTabId, cwd]);

	const wasStreaming = useRef(false);
	useEffect(() => {
		if (wasStreaming.current && !isStreaming) refreshRef.current();
		wasStreaming.current = isStreaming;
	}, [isStreaming]);

	return { status, refresh: () => refreshRef.current() };
}
