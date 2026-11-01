/**
 * The paired web page's link to the computer as the person sees it: nothing while it is up or for a drop that heals
 * within `LINK_NOTICE_GRACE_MS` (the transport reconnects at once, so a blip, a return from the background or a
 * network change is over before then), and the title bar's status turning to "Reconnecting to your computer…" once
 * it has stayed down that long, until the moment it is back. Counted from when the page first saw the link down,
 * so a view that mounts during a long outage shows it at once. Always null in a desktop window.
 */
import { useEffect, useReducer, useSyncExternalStore } from "react";
import { LINK_NOTICE_GRACE_MS } from "../../shared/link-notice";
import { webRuntime } from "./runtime";
import type { WsConnectionState } from "./ws-transport";

type DownState = Extract<WsConnectionState, "connecting" | "reconnecting">;

interface Down {
	state: DownState;
	since: number;
}

let down: Down | null = null;
let watching = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
	const runtime = webRuntime();
	if (runtime && !watching) {
		watching = true;
		const apply = (state: WsConnectionState) => {
			const next: Down | null =
				state === "connecting" || state === "reconnecting" ? { state, since: down?.since ?? Date.now() } : null;
			if (next?.state === down?.state) return;
			down = next;
			for (const notify of listeners) notify();
		};
		apply(runtime.connectionState());
		runtime.onConnectionState(apply);
	}
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** The link's state once it has stayed down past the grace; null while it is up, inside the grace, or on the desktop. */
export function useWebLinkLost(): DownState | null {
	const current = useSyncExternalStore(subscribe, () => down);
	const [, wake] = useReducer((count: number) => count + 1, 0);
	useEffect(() => {
		if (!current) return;
		const left = current.since + LINK_NOTICE_GRACE_MS - Date.now();
		if (left <= 0) return;
		const timer = setTimeout(wake, left);
		return () => clearTimeout(timer);
	}, [current]);
	return current && Date.now() - current.since >= LINK_NOTICE_GRACE_MS ? current.state : null;
}
