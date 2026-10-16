/**
 * The work board's account row: the subscription account this session uses now (the provider of the current
 * model; the report stock marks `active`, else the first with limits) and its tightest usage window as a thin
 * meter. The other windows sit in the tooltip; a click opens Settings › Models & accounts. It reads the same
 * `get_usage` reports as the sidebar pin and polls only through `useLiveUsage`; a provider with no usage
 * windows (an API key) shows nothing.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { UsageLimit, UsageReport } from "../../../shared/rpc-types";
import { formatSpan } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { usageLimitLabel } from "../../lib/usage-labels";
import { inUseReport, useLiveUsage } from "../../lib/usage-reports";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";
import { ProviderMark } from "../settings/providers/ProviderMark";

/** From here the window is near its limit (warning); at 100 % it is the limit (danger). */
const NEAR_FRACTION = 0.8;

/**
 * "me@example.com (me…)" shows as "me@example.com": a parenthesized name that only repeats the start of the
 * address's local part adds nothing. Any other suffix stays.
 */
export function shortAccountLabel(label: string): string {
	const match = /^(\S+@\S+)\s*\((.*)\)?$/.exec(label);
	if (!match) return label;
	const local = (match[1]?.split("@")[0] ?? "").toLowerCase();
	const inner = (match[2] ?? "")
		.replace(/[….)]+$/, "")
		.trim()
		.toLowerCase();
	return inner === "" || local.startsWith(inner) ? (match[1] ?? label) : label;
}

/** A window's length in hours from its canonical id, or Infinity for one stock made up. */
function windowHours(limit: UsageLimit): number {
	const id = limit.windowId ?? "";
	const span = /^(\d+)([hd])$/.exec(id);
	if (span) return Number(span[1]) * (span[2] === "h" ? 1 : 24);
	if (id === "daily") return 24;
	if (id === "weekly" || id === "1w") return 168;
	if (id === "monthly") return 720;
	return Number.POSITIVE_INFINITY;
}

/** "5H", "7D": the window's own short name — from its id, else the first word of its label. */
export function shortWindowLabel(limit: UsageLimit): string {
	const id = limit.windowId ?? "";
	const span = /^(\d+)([hd])$/.exec(id);
	if (span) return `${span[1]}${span[2]?.toUpperCase()}`;
	if (id === "daily") return "1D";
	if (id === "weekly" || id === "1w") return "7D";
	if (id === "monthly") return "30D";
	return (limit.windowLabel ?? limit.label).split(/[\s(]/)[0]?.slice(0, 4).toUpperCase() ?? "";
}

/**
 * The windows the row gauges: the two tightest of the account's whole-account limits (a per-model tier such as
 * `7d:opus` only when nothing else is measured), shortest window first. The gauge fills with the share used,
 * as the Settings accounts row does.
 */
export function accountWindows(limits: readonly UsageLimit[]): { limit: UsageLimit; fraction: number }[] {
	const measured = limits.flatMap(limit => {
		const fraction =
			limit.usedFraction ?? (limit.used !== undefined && limit.limit ? limit.used / limit.limit : null);
		return fraction === null ? [] : [{ limit, fraction }];
	});
	const plain = measured.filter(entry => entry.limit.id.split(":").length <= 2);
	return (plain.length > 0 ? plain : measured)
		.sort((a, b) => b.fraction - a.fraction)
		.slice(0, 2)
		.sort((a, b) => windowHours(a.limit) - windowHours(b.limit));
}

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

	const windows = report ? accountWindows(report.limits) : [];
	if (!report || windows.length === 0) return null;

	const now = Date.now();
	const resets = (resetsAt: number | undefined) =>
		resetsAt === undefined
			? null
			: resetsAt > now
				? t("usage.resetsIn", { time: formatSpan(resetsAt - now) })
				: t("usage.resetting");
	const fullLabel = report.account?.trim() || report.provider;
	const account = shortAccountLabel(fullLabel);
	const tooltip = [
		fullLabel,
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
			onClick={() => useUiStore.getState().openProviders()}
			title={tooltip}
			type="button"
		>
			<span className="omp-work-board-account-name">
				<ProviderMark
					className="omp-work-board-provider"
					provider={{ id: report.provider, name: report.provider }}
				/>
				<span className="min-w-0 flex-1 truncate">{account}</span>
			</span>
			<span className="omp-work-board-gauges" data-count={windows.length}>
				{windows.map(({ limit, fraction }) => {
					const percent = Math.round(Math.min(1, fraction) * 100);
					const name = usageLimitLabel(limit, t);
					return (
						<span
							className="omp-work-board-gauge"
							data-state={fraction >= 1 ? "limit" : fraction >= NEAR_FRACTION ? "near" : "ok"}
							data-window={limit.windowId ?? limit.id}
							key={limit.id}
						>
							<span
								aria-label={name}
								aria-valuemax={100}
								aria-valuemin={0}
								aria-valuenow={percent}
								aria-valuetext={`${percent}%`}
								className="omp-work-board-gauge-bar"
								role="progressbar"
							>
								<span className="omp-work-board-gauge-fill" style={{ width: `${percent}%` }} />
								<span className="omp-work-board-gauge-text">
									<span>{shortWindowLabel(limit)}</span>
									<span>{percent}%</span>
								</span>
							</span>
							<span className="omp-work-board-gauge-reset">{resets(limit.resetsAt)}</span>
						</span>
					);
				})}
			</span>
		</button>
	);
}
