import { useEffect } from "react";
import { useTabRpc } from "../lib/tab-rpc";

/** While a child runs, a shown surface asks main for its step and cost this often (main pushes them only when they moved). */
export const LIVE_REVIEW_MS = 2_000;

/** One ask per opener tab, however many surfaces (the work board, the transcript's card) show its children. */
const asking = new Map<string, { holders: number; stop: () => void }>();

/**
 * Main reads a running child's step and cost again only while a surface showing them is mounted and its window is in
 * view: this asks for them (`agent_control_review {live: true}`); the answer comes as main's review push.
 */
export function useLiveReview(tabId: string | null, running: boolean): void {
	const rpc = useTabRpc();
	useEffect(() => {
		if (!running) return;
		const key = tabId ?? "";
		let entry = asking.get(key);
		if (!entry) {
			const ask = () => {
				if (document.visibilityState === "hidden") return;
				void rpc.command({ type: "agent_control_review", live: true }).catch(() => undefined);
			};
			const timer = window.setInterval(ask, LIVE_REVIEW_MS);
			document.addEventListener("visibilitychange", ask);
			entry = {
				holders: 0,
				stop: () => {
					window.clearInterval(timer);
					document.removeEventListener("visibilitychange", ask);
				},
			};
			asking.set(key, entry);
		}
		const held = entry;
		held.holders++;
		return () => {
			held.holders--;
			if (held.holders > 0) return;
			held.stop();
			asking.delete(key);
		};
	}, [rpc, tabId, running]);
}
