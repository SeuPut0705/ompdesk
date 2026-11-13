/**
 * Insights › Usage: provider quota reports — one card per stored account
 * (several sign-ins of one provider each get their own) with limit bars,
 * reset countdowns, how old each report is and provider notes. Reports come
 * from stock's usage cache through the tab's one usage poll
 * (hooks/use-usage-reports.ts): read when the page mounts, when it shows
 * another session tab, and live while it is open; the explicit refresh
 * (`UsageRefresh`, at the end of the Insights tab row) has stock probe every
 * provider now. The session's own
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
import { Badge, Banner, Button, Card, EmptyState, ErrorDetail, IconButton, ProgressBar, SkeletonRows } from "../common";
import { ResetPassControl, resetPassSummary } from "../settings/providers/ResetPasses";

type Translate = (key: string, params?: Record<string, string | number>) => string;

function resetCountdown(resetsAt: number | undefined, t: Translate, now: number): string | null {
	if (!resetsAt) return null;
	const ms = resetsAt - now;
	if (ms <= 0) return t("usage.resetting");
	return t("usage.resetsIn", { time: formatSpan(ms) });
}

/** The rotation's answers that carry a line; the rest (one account, no account yet, no model) say nothing. */
const ROTATION_REASONS: ReadonlySet<string> = new Set([
	"better",
	"near-limit",
	"much-better",
	"same",
	"within-margin",
	"mid-turn",
	"no-better",
	"usage-unreadable",
	"explicit",
	"restricted",
	"policy",
	"blocked",
	"subagents",
	"cold",
	"no-choice",
	"pin-refused",
	"mode",
	"unknown-provenance",
]);

/** Why this session is on the account of its card, in words (en/ko keys `usage.rotation.*`); null without a line. */
export function rotationReason(rotation: UsageReport["rotation"], t: Translate): string | null {
	return rotation && ROTATION_REASONS.has(rotation.why) ? t(`usage.rotation.${rotation.why}`) : null;
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
		<li className="flex flex-col gap-1.5 py-2 first:pt-0 last:pb-0 [html[data-input=touch]_&]:py-3">
			<div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
				{/* The reset time rides the label's line, so a window is two lines: words, then its bar. */}
				<span className="min-w-0 flex-1 basis-32 break-words">
					<span className="text-sc-md font-medium text-(--sc-text)">{label}</span>
					{countdown && (
						<span className="text-sc-xs text-(--sc-text-muted)" data-limit-reset>
							{" · "}
							{countdown}
						</span>
					)}
				</span>
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
	const reason = report.active ? rotationReason(report.rotation, t) : null;
	// Stock's provider display name (the catalog's login names); the id when the catalog has none.
	const providerName = useModelStore(
		state => state.providers.find(provider => provider.id === report.provider)?.name ?? report.provider,
	);
	return (
		<Card as="section" className="flex flex-col gap-3" padding="lg" radius="lg">
			<header className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<h3 className="min-w-0 text-sc-md font-semibold break-words text-(--sc-text)">{providerName}</h3>
				{report.account && (
					<span className="min-w-0 text-sc-sm break-all text-(--sc-text-muted)">{report.account}</span>
				)}
				{report.active && <Badge variant="success">{t("usage.inUse")}</Badge>}
				<span className="ml-auto flex items-center gap-2">
					{report.fetchedAt > 0 && (
						<span
							className="text-sc-xs tabular-nums text-(--sc-text-muted)"
							data-usage-updated
							title={formatClock(report.fetchedAt)}
						>
							{t("usage.updatedAgo", { time: formatSpan(now - report.fetchedAt) })}
						</span>
					)}
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
							<Badge variant="info">{resetPassSummary(report.resetPasses, t)}</Badge>
						))}
				</span>
			</header>
			{reason && (
				<p
					className="text-sc-xs break-words text-(--sc-text-muted)"
					data-usage-rotation={report.rotation?.why}
					title={report.rotation ? formatClock(report.rotation.at) : undefined}
				>
					{reason}
				</p>
			)}
			<Notes notes={report.notes} />
			{limits.length > 0 && (
				<ul className="flex flex-col divide-y divide-(--sc-divider)">
					{limits.map(limit => (
						<LimitRow key={limit.id} limit={limit} now={now} t={t} />
					))}
				</ul>
			)}
		</Card>
	);
}

/** Usage's re-read at the end of the Insights tab row: stock probes every provider first. */
export function UsageRefresh() {
	const t = useT();
	const ready = useSessionStore(s => s.status) === "ready";
	const feed = useUsage(usage => usage);
	const readUsage = useUsageRead();
	const [reading, setReading] = useState(false);
	const refresh = async () => {
		setReading(true);
		try {
			await readUsage(true);
		} finally {
			setReading(false);
		}
	};
	return (
		<IconButton
			disabled={!ready}
			icon={<RefreshCw />}
			label={t("common.refresh")}
			loading={reading || (ready && feed.reports === null && feed.error === null)}
			onClick={() => void refresh()}
			size="sm"
		/>
	);
}

export function UsageQuotas() {
	const t = useT();
	const status = useSessionStore(s => s.status);
	const ready = status === "ready";
	const openInsights = useUiStore(s => s.openInsights);
	const feed = useUsage(usage => usage);
	const readUsage = useUsageRead();
	const refreshProviders = useModelStore(s => s.refreshProviders);
	// Read through a ref: the catalog arriving must not re-run the catalog read below.
	const providerCount = useRef(0);
	providerCount.current = useModelStore(s => s.providers.length);
	const now = useNowTick(true);
	const reports = ready ? feed.reports : null;
	// omp still installing (`waiting`) or just starting after it: nothing to read yet, and nothing failed.
	const error = ready ? feed.error : status === "waiting" || status === "starting" ? null : t("usage.notConnected");
	const loading = ready && feed.reports === null && feed.error === null;

	// The cards name providers from the catalog; read it once when nothing has yet.
	useEffect(() => {
		if (reports && reports.length > 0 && providerCount.current === 0)
			void refreshProviders(false).catch(() => undefined);
	}, [reports, refreshProviders]);

	return (
		<div className="flex flex-col gap-4">
			{error && (
				<Banner live title={t("usage.loadFailed")} variant="danger">
					<ErrorDetail error={error} />
				</Banner>
			)}
			{loading && <SkeletonRows className="py-4" label={t("common.loading")} widths={[58, 72, 44, 66]} />}
			{reports && reports.length === 0 && (
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
							onRedeemed={async () => {
								const read = await readUsage(false);
								return read.ok
									? read.reports.find(
											entry =>
												entry.provider === report.provider && entry.credentialId === report.credentialId,
										)?.limits
									: undefined;
							}}
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
