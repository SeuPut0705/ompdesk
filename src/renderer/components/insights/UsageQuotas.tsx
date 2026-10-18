/**
 * Insights › Usage: provider quota reports — one card per stored account
 * (several sign-ins of one provider each get their own) with limit bars,
 * reset countdowns, how old each report is and provider notes. Reports come
 * from stock's usage cache through the tab's one usage poll
 * (hooks/use-usage-reports.ts): read when the page mounts, when it shows
 * another session tab, and live while it is open; the explicit refresh has
 * stock probe every provider now. The session's own
 * token/cost figures live in Insights › Stats › This session. An account with
 * saved rate-limit resets shows them and can spend one (ResetPassControl).
 */

import { Gauge, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { UsageLimit, UsageReport } from "../../../shared/rpc-types";
import { useUsage, useUsageRead } from "../../hooks/use-usage-reports";
import { formatClock, formatSpan } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useNowTick } from "../../lib/now-tick";
import { usageLimitLabel } from "../../lib/usage-labels";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";
import { Badge, Banner, Button, EmptyState, ErrorDetail, ProgressBar, SkeletonRows } from "../common";
import { ResetPassControl, resetPassSummary } from "../settings/providers/ResetPasses";

type Translate = (key: string, params?: Record<string, string | number>) => string;

function resetCountdown(resetsAt: number | undefined, t: Translate, now: number): string | null {
	if (!resetsAt) return null;
	const ms = resetsAt - now;
	if (ms <= 0) return t("usage.resetting");
	return t("usage.resetsIn", { time: formatSpan(ms) });
}

export function limitValueText(limit: UsageLimit, t: Translate): string {
	const hasUnit = Boolean(limit.unit && limit.unit !== "unknown");
	if (!hasUnit && limit.usedFraction !== undefined) {
		return t("usage.valueUsed", { value: `${Number((limit.usedFraction * 100).toFixed(1))}%` });
	}
	const unit = limit.unit === "percent" ? "%" : hasUnit ? ` ${limit.unit}` : "";
	if (limit.used !== undefined && limit.limit !== undefined) {
		return `${limit.used.toFixed(limit.unit === "percent" ? 1 : 0)}${unit} / ${limit.limit.toFixed(0)}${unit}`;
	}
	if (limit.used !== undefined) return t("usage.valueUsed", { value: `${limit.used.toFixed(1)}${unit}` });
	if (limit.usedFraction !== undefined) return `${(limit.usedFraction * 100).toFixed(1)}%`;
	return t("usage.valueUnknown");
}

const STATUS_KEY: Record<string, string> = {
	exhausted: "usage.status.exhausted",
	warning: "usage.status.warning",
};

function Notes({ notes }: { notes: string[] | undefined }) {
	if (!notes || notes.length === 0) return null;
	return (
		<ul className="flex flex-col gap-0.5">
			{notes.map(note => (
				<li className="text-sc-xs text-(--sc-text-muted)" key={note}>
					{note}
				</li>
			))}
		</ul>
	);
}

function LimitRow({ limit, t, now }: { limit: UsageLimit; t: Translate; now: number }) {
	const fraction = limit.usedFraction ?? (limit.used !== undefined && limit.limit ? limit.used / limit.limit : 0);
	const countdown = resetCountdown(limit.resetsAt, t, now);
	const label = usageLimitLabel(limit, t);
	return (
		<li className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
			<div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
				<span className="min-w-0 flex-1 basis-32 text-sc-md font-medium break-words text-(--sc-text)">{label}</span>
				<div className="ml-auto flex flex-wrap items-center justify-end gap-2">
					{limit.status && limit.status !== "ok" && (
						<Badge variant={limit.status === "exhausted" ? "error" : "warning"}>
							{STATUS_KEY[limit.status] ? t(STATUS_KEY[limit.status]) : limit.status}
						</Badge>
					)}
					<span className="text-sc-sm tabular-nums text-(--sc-text-secondary)">{limitValueText(limit, t)}</span>
				</div>
			</div>
			<ProgressBar ariaLabel={label} value={fraction} valueText="" />
			{countdown && <span className="text-sc-xs text-(--sc-text-muted)">{countdown}</span>}
			<Notes notes={limit.notes} />
		</li>
	);
}

function ProviderReportCard({
	report,
	t,
	now,
	ready,
	onRedeemed,
}: {
	report: UsageReport;
	t: Translate;
	now: number;
	ready: boolean;
	onRedeemed: () => Promise<readonly UsageLimit[] | undefined>;
}) {
	const limits = Array.isArray(report.limits) ? report.limits : [];
	// Stock's provider display name (the catalog's login names); the id when the catalog has none.
	const providerName = useModelStore(
		state => state.providers.find(provider => provider.id === report.provider)?.name ?? report.provider,
	);
	return (
		<section className="flex flex-col gap-3 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) p-4">
			<header className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<h3 className="min-w-0 text-sc-md font-semibold break-words text-(--sc-text)">{providerName}</h3>
				{report.account && (
					<span className="min-w-0 text-sc-sm break-all text-(--sc-text-muted)">{report.account}</span>
				)}
				{report.active && <Badge variant="success">{t("usage.inUse")}</Badge>}
				{report.fetchedAt > 0 && (
					<span
						className="ml-auto text-sc-xs tabular-nums text-(--sc-text-muted)"
						data-usage-updated
						title={formatClock(report.fetchedAt)}
					>
						{t("usage.updatedAgo", { time: formatSpan(now - report.fetchedAt) })}
					</span>
				)}
			</header>
			{report.resetPasses &&
				(report.credentialId !== undefined ? (
					<ResetPassControl
						account={report.account ?? providerName}
						credentialId={report.credentialId}
						disabled={!ready}
						limits={limits}
						onRedeemed={onRedeemed}
						passes={report.resetPasses}
						providerId={report.provider}
						providerName={providerName}
					/>
				) : (
					<Badge className="self-start" variant="info">
						{resetPassSummary(report.resetPasses, t)}
					</Badge>
				))}
			<Notes notes={report.notes} />
			{limits.length > 0 && (
				<ul className="flex flex-col divide-y divide-(--sc-divider)">
					{limits.map(limit => (
						<LimitRow key={limit.id} limit={limit} now={now} t={t} />
					))}
				</ul>
			)}
		</section>
	);
}

export function UsageQuotas() {
	const t = useT();
	const status = useSessionStore(s => s.status);
	const ready = status === "ready";
	const openInsights = useUiStore(s => s.openInsights);
	const feed = useUsage(usage => usage);
	const readUsage = useUsageRead();
	const [reading, setReading] = useState(false);
	const refreshProviders = useModelStore(s => s.refreshProviders);
	// Read through a ref: the catalog arriving must not re-run the catalog read below.
	const providerCount = useRef(0);
	providerCount.current = useModelStore(s => s.providers.length);
	const now = useNowTick(true);
	const reports = ready ? feed.reports : null;
	// omp still installing (`waiting`) or just starting after it: nothing to read yet, and nothing failed.
	const error = ready ? feed.error : status === "waiting" || status === "starting" ? null : t("usage.notConnected");
	const loading = reading || (ready && feed.reports === null && feed.error === null);

	// The cards name providers from the catalog; read it once when nothing has yet.
	useEffect(() => {
		if (reports && reports.length > 0 && providerCount.current === 0)
			void refreshProviders(false).catch(() => undefined);
	}, [reports, refreshProviders]);

	/**
	 * A read outside the poll; resolves to the reports, `null` when it failed. `refresh` has stock probe every
	 * provider first.
	 */
	const read = async (refresh: boolean): Promise<UsageReport[] | null> => {
		setReading(true);
		try {
			const result = await readUsage(refresh);
			return result.ok ? result.reports : null;
		} finally {
			setReading(false);
		}
	};

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center gap-3">
				<p className="min-w-0 flex-1 text-sc-sm text-(--sc-text-muted)">{t("usage.providerQuotasHint")}</p>
				<Button
					disabled={!ready}
					icon={<RefreshCw />}
					loading={loading}
					onClick={() => void read(true)}
					size="sm"
					title={!ready ? t("usage.notConnected") : undefined}
					variant="secondary"
				>
					{t("common.refresh")}
				</Button>
			</div>

			{error && (
				<Banner live title={t("usage.loadFailed")} variant="danger">
					<ErrorDetail error={error} />
				</Banner>
			)}
			{loading && reports === null && (
				<SkeletonRows className="py-4" label={t("common.loading")} widths={[58, 72, 44, 66]} />
			)}
			{reports && reports.length === 0 && !loading && (
				<EmptyState
					actions={
						<Button onClick={() => openInsights("stats", "session")} size="sm" variant="secondary">
							{t("usage.viewSession")}
						</Button>
					}
					description={t("usage.noApi")}
					icon={<Gauge />}
					title={t("usage.noApiTitle")}
				/>
			)}
			{reports && reports.length > 0 && (
				<div className="grid gap-4 lg:grid-cols-2">
					{reports.map((report, index) => (
						<ProviderReportCard
							key={`${report.provider}-${report.credentialId ?? report.account ?? index}`}
							now={now}
							onRedeemed={async () =>
								(await read(false))?.find(
									entry => entry.provider === report.provider && entry.credentialId === report.credentialId,
								)?.limits
							}
							ready={ready}
							report={report}
							t={t}
						/>
					))}
				</div>
			)}
		</div>
	);
}
