import type { SessionSpend } from "../../../resources/gui-bridge/model-setup-contracts";
import type { RpcResponse } from "../../shared/rpc-types";
import { watchUsage } from "../lib/usage-reports";
import { useSessionStore } from "../stores/session";
import { TabPoll, useTabPoll } from "./use-tab-poll";

/**
 * This tab's `get_session_spend`, read when the tab's first surface showing it mounts and then on the usage poll's
 * schedule (interval, focus, back in view, a turn's end): one read per tab however many surfaces show it (the work
 * board's spend line, its rows, the Work tree). `null` until the first read lands or while the omp cannot say (an
 * older omp, a failed read keeps the last answer). Only the latest read's answer shows: an older one landing late
 * changes nothing.
 */
const spendPoll = new TabPoll<SessionSpend | null>(null, (rpc, publish) => {
	let latest = 0;
	let stopped = false;
	const load = async (): Promise<boolean> => {
		const client = rpc();
		if (!client) return false;
		const call = ++latest;
		let response: RpcResponse | null = null;
		try {
			response = await client.getSessionSpend();
		} catch {
			// No answer (an older host, a closing tab): nothing shows; the next read tries again.
		}
		if (stopped || call !== latest || !response?.success) return false;
		publish(() => response.data as SessionSpend);
		return true;
	};
	void load();
	const unwatch = watchUsage(load);
	return {
		stop: () => {
			stopped = true;
			unwatch();
		},
	};
});

/**
 * This tab's session spend. Scoped by the session id too: a tab that switches session in place (a new session, a
 * picked one) keeps its tab id, ready status and route, so without the scope the board would show the old session's
 * charges until the next poll, and a reply already on its way could paint them back.
 */
export function useSessionSpend(active = true): SessionSpend | null {
	const ready = useSessionStore(s => s.status) === "ready";
	const sessionId = useSessionStore(s => s.sessionId);
	return useTabPoll(spendPoll, ready && active, spend => spend, sessionId || "none");
}
