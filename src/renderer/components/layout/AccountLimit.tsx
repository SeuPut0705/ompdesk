/**
 * The work board's account row: the subscription account this session uses now (the provider of the current
 * model; the report stock marks `active`, else the first with limits) and its tightest usage window as a thin
 * meter. The other windows sit in the tooltip; a click opens Settings › Models & accounts. It reads the same
 * `get_usage` reports as the sidebar pin and polls only through `useLiveUsage`; a provider with no usage
 * windows (an API key) shows nothing.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { UsageReport } from "../../../shared/rpc-types";
import { formatSpan } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { usageLimitLabel } from "../../lib/usage-labels";
import { inUseReport, tightestLimit, useLiveUsage } from "../../lib/usage-reports";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";
import { ProviderMark } from "../settings/providers/ProviderMark";

/** From here the window is near its limit (warning); at 100 % it is the limit (danger). */
const NEAR_FRACTION = 0.8;

export function AccountLimit() {
	const t = useT();
	const tabRpc = useTabRpc();
	const ready = useSessionStore(s => s.status) === "ready";
	const provider = useModelStore(s => s.model?.provider ?? null);
	const [report, setReport] = useState<UsageReport | null>(null);
	const latest = useRef(0);

	const load = useCallback(async (): Promise<boolean> => {
		if (!ready) return false;
		const call = ++latest.current;
		try {
			const response = await tabRpc.getUsage();
			if (call !== latest.current || !response.success) return false;
			const data: unknown = response.data;
			const reports: UsageReport[] =
				typeof data === "object" && data !== null && "reports" in data && Array.isArray(data.reports)
					? data.reports
					: [];
			setReport(inUseReport(reports, provider) ?? null);
			return true;
		} catch {
			return false;
		}
	}, [ready, provider, tabRpc.getUsage]);

	useEffect(() => {
		void load();
	}, [load]);
	useLiveUsage(load, ready);

	const tight = report ? tightestLimit(report) : null;
	if (!report || !tight) return null;

	const now = Date.now();
	const percent = Math.round(Math.min(1, tight.fraction) * 100);
	const resets = (resetsAt: number | undefined) =>
		resetsAt === undefined
			? null
			: resetsAt > now
				? t("usage.resetsIn", { time: formatSpan(resetsAt - now) })
				: t("usage.resetting");
	const state = tight.fraction >= 1 ? "limit" : tight.fraction >= NEAR_FRACTION ? "near" : "ok";
	const resetText = resets(tight.limit.resetsAt);
	const headline = [`${percent}%`, resets(tight.limit.resetsAt)].filter(Boolean).join(" · ");
	const account = report.account?.trim() || report.provider;
	const tooltip = [
		account,
		...report.limits.map(limit => {
			const fraction =
				limit.usedFraction ?? (limit.used !== undefined && limit.limit ? limit.used / limit.limit : null);
			return [
				usageLimitLabel(limit, t),
				fraction === null ? null : `${Math.round(fraction * 100)}%`,
				resets(limit.resetsAt),
			]
				.filter(Boolean)
				.join(" · ");
		}),
	].join("\n");

	return (
		<button
			className="omp-work-board-account"
			data-board-account={report.provider}
			data-state={state}
			onClick={() => useUiStore.getState().openProviders()}
			title={tooltip}
			type="button"
		>
			<ProviderMark className="omp-work-board-provider" provider={{ id: report.provider, name: report.provider }} />
			<span className="min-w-0 flex-1 truncate">{account}</span>
			<span className="omp-work-board-meta">{`${percent}%`}</span>
			<span className="omp-work-board-account-foot">
				<span
					aria-label={usageLimitLabel(tight.limit, t)}
					aria-valuemax={100}
					aria-valuemin={0}
					aria-valuenow={percent}
					aria-valuetext={headline}
					className="omp-work-board-meter"
					role="progressbar"
				>
					<span style={{ width: `${percent}%` }} />
				</span>
				{resetText ? <span className="omp-work-board-meta">{resetText}</span> : null}
			</span>
		</button>
	);
}
