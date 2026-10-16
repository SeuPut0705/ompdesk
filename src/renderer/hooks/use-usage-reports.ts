import type { UsageReport } from "../../shared/rpc-types";
import { watchUsage } from "../lib/usage-reports";
import { useSessionStore } from "../stores/session";
import { TabPoll, useTabPoll } from "./use-tab-poll";

const usagePoll = new TabPoll<UsageReport[] | null>(null, (rpc, publish) => {
	let latest = 0;
	let stopped = false;
	const load = async (): Promise<boolean> => {
		const client = rpc();
		if (!client) return false;
		const call = ++latest;
		try {
			const response = await client.getUsage();
			if (stopped || call !== latest || !response.success) return false;
			const data: unknown = response.data;
			const reports =
				typeof data === "object" && data !== null && "reports" in data && Array.isArray(data.reports)
					? data.reports
					: [];
			publish(() => reports);
			return true;
		} catch {
			return false;
		}
	};
	void load();
	const unwatch = watchUsage(load);
	return () => {
		stopped = true;
		unwatch();
	};
});

/**
 * This tab's usage reports (`get_usage`: one per provider account, the one its session uses marked `active`),
 * read when the first surface showing them mounts and kept current by `watchUsage` alone, one poll per tab
 * however many surfaces show them (the sidebar's usage lines, the work board's account row); a failed read
 * keeps what is shown. `null` until the first read lands.
 */
export function useUsageReports(): UsageReport[] | null {
	const ready = useSessionStore(s => s.status) === "ready";
	return useTabPoll(usagePoll, ready);
}
