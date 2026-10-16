import { useCallback, useEffect, useRef, useState } from "react";
import type { UsageReport } from "../../shared/rpc-types";
import { useTabRpc } from "../lib/tab-rpc";
import { useLiveUsage } from "../lib/usage-reports";
import { useSessionStore } from "../stores/session";

/**
 * This tab's usage reports (`get_usage`: one per provider account, the one its session uses marked `active`),
 * read when the surface mounts and kept current by `useLiveUsage` alone; a failed read keeps what is shown.
 * `null` until the first read lands.
 */
export function useUsageReports(): UsageReport[] | null {
	const tabRpc = useTabRpc();
	const ready = useSessionStore(s => s.status) === "ready";
	const [reports, setReports] = useState<UsageReport[] | null>(null);
	const latest = useRef(0);

	const load = useCallback(async (): Promise<boolean> => {
		if (!ready) return false;
		const call = ++latest.current;
		try {
			const response = await tabRpc.getUsage();
			if (call !== latest.current || !response.success) return false;
			const data: unknown = response.data;
			setReports(
				typeof data === "object" && data !== null && "reports" in data && Array.isArray(data.reports)
					? data.reports
					: [],
			);
			return true;
		} catch {
			return false;
		}
	}, [ready, tabRpc.getUsage]);

	useEffect(() => {
		void load();
	}, [load]);
	useLiveUsage(load, ready);
	return reports;
}
