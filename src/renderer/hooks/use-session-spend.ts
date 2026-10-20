import type { SessionSpend } from "../../../resources/gui-bridge/model-setup-contracts";
import type { RpcResponse } from "../../shared/rpc-types";
import { watchUsage } from "../lib/usage-reports";
import { useSessionStore } from "../stores/session";
import { TabPoll, useTabPoll } from "./use-tab-poll";

/**
 * This tab's `get_session_spend`, on the usage poll's schedule (interval, focus, back in view, a turn's end): one
 * read per tab however many surfaces show it (the work board's spend line, its rows, the Work tree). `null` until
 * the first read lands or while the omp cannot say (an older omp, a failed read keeps the last answer).
 */
const spendPoll = new TabPoll<SessionSpend | null>(null, (rpc, publish) => {
	let stopped = false;
	const load = async (): Promise<boolean> => {
		const client = rpc();
		if (!client) return false;
		let response: RpcResponse | null = null;
		try {
			response = await client.getSessionSpend();
		} catch {
			// No answer (an older host, a closing tab): nothing shows; the next read tries again.
		}
		if (stopped || !response?.success) return false;
		publish(() => response.data as SessionSpend);
		return true;
	};
	void load();
	const unwatch = watchUsage(load);
	return {
		read: () => void load(),
		stop: () => {
			stopped = true;
			unwatch();
		},
	};
});

export function useSessionSpend(active = true): SessionSpend | null {
	const ready = useSessionStore(s => s.status) === "ready";
	return useTabPoll(spendPoll, ready && active, spend => spend);
}
