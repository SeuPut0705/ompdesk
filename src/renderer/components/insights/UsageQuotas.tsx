/**
 * Insights › Usage: provider quota reports — one card per stored account
 * (several sign-ins of one provider each get their own) with limit bars,
 * reset countdowns and provider notes. Quotas are live calls to each
 * provider's usage endpoint, so they are read when the tab mounts, when the
 * active session tab changes, and on the explicit refresh. The session's own
 * token/cost figures live in Insights › Stats › This session. An account with
 * saved rate-limit resets shows them and can spend one (ResetPassControl).
 */

import { Gauge, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { UsageLimit, UsageReport } from "../../../shared/rpc-types";
import { formatDuration } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useNowTick } from "../../lib/now-tick";
import { useTabRpc } from "../../lib/tab-rpc";
import { type SessionStore, useSessionStore } from "../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../stores/session-runtime-context";
import { useUiStore } from "../../stores/ui";
import { Badge, Banner, Button, EmptyState, ErrorDetail, ProgressBar, Spinner } from "../common";
import { ResetPassControl, resetPassSummary } from "../settings/providers/ResetPasses";

type Translate = (key: string, params?: Record<string, string | number>) => string;

function resetCountdown(resetsAt: number | undefined, t: Translate, now: number): string | null {
	if (!resetsAt) return null;
	const ms = resetsAt - now;
	if (ms <= 0) return t("usage.resetting");
	return t("usage.resetsIn", { time: formatDuration(ms) });
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
	return (
		<li className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
			<div className="flex items-center justify-between gap-3">
				<span className="min-w-0 truncate text-sc-md font-medium text-(--sc-text)">{limit.label}</span>
				<div className="flex shrink-0 items-center gap-2">
					{limit.status && limit.status !== "ok" && (
						<Badge variant={limit.status === "exhausted" ? "error" : "warning"}>
							{STATUS_KEY[limit.status] ? t(STATUS_KEY[limit.status]) : limit.status}
						</Badge>
					)}
					<span className="text-sc-sm tabular-nums text-(--sc-text-secondary)">{limitValueText(limit, t)}</span>
				</div>
			</div>
			<ProgressBar height={6} value={fraction} valueText={`${Math.round(fraction * 100)}%`} />
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
	return (
		<section className="flex flex-col gap-3 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) p-4">
			<header className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<h3 className="text-sc-md font-semibold text-(--sc-text)">{report.provider}</h3>
				{report.account && <span className="text-sc-sm text-(--sc-text-muted)">{report.account}</span>}
				{report.active && <Badge variant="success">{t("usage.inUse")}</Badge>}
			</header>
			{report.resetPasses &&
				(report.credentialId !== undefined ? (
					<ResetPassControl
						account={report.account ?? report.provider}
						credentialId={report.credentialId}
						disabled={!ready}
						limits={limits}
						onRedeemed={onRedeemed}
						passes={report.resetPasses}
						providerId={report.provider}
						providerName={report.provider}
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
	const tabRpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const t = useT();
	const ready = useSessionStore(s => s.status) === "ready";
	const sessionId = useSessionStore(s => s.sessionId);
	const openInsights = useUiStore(s => s.openInsights);
	const [reports, setReports] = useState<UsageReport[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const now = useNowTick(true);

	/** The tab/session a quota read was issued for. A late response from a tab
	 * that is no longer frontmost must not overwrite the new tab's numbers. */
	const ownerRef = useRef<string | null>(null);

	/** Reads the quotas; resolves to the reports, `null` when the read failed or a newer read took over. */
	const load = useCallback(async (): Promise<UsageReport[] | null> => {
		setLoading(true);
		setError(null);
		if (!ready) {
			setError(t("usage.notConnected"));
			setLoading(false);
			return null;
		}
		const owner = `${tabId}/${sessionId}`;
		ownerRef.current = owner;
		const originSession = sessionRuntimeStore<SessionStore>(tabId, "session") ?? useSessionStore;
		try {
			const res = await tabRpc.getUsage();
			if (ownerRef.current !== owner || originSession.getState().sessionId !== sessionId) return null;
			if (!res.success) {
				setError(res.error);
				return null;
			}
			const data: unknown = res.data;
			const next: UsageReport[] =
				typeof data === "object" && data !== null && "reports" in data && Array.isArray(data.reports)
					? data.reports
					: [];
			setReports(next);
			return next;
		} catch (cause) {
			if (ownerRef.current === owner) setError(String(cause));
			return null;
		} finally {
			if (ownerRef.current === owner) setLoading(false);
		}
	}, [ready, t, tabId, sessionId, tabRpc.getUsage]);

	// Mounting and moving to another tab behind the page are the two moments
	// that need a fresh read; `load` identity tracks the tab, its session and
	// the sidecar being ready. The previous tab's reports leave first.
	useEffect(() => {
		setReports(null);
		void load();
	}, [load]);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center gap-3">
				<p className="min-w-0 flex-1 text-sc-sm text-(--sc-text-muted)">{t("usage.providerQuotasHint")}</p>
				<Button
					disabled={!ready}
					icon={<RefreshCw />}
					loading={loading}
					onClick={() => void load()}
					size="sm"
					title={!ready ? t("usage.notConnected") : undefined}
					variant="secondary"
				>
					{t("usage.refresh")}
				</Button>
			</div>

			{error && (
				<Banner live title={t("usage.loadFailed")} variant="danger">
					<ErrorDetail error={error} />
				</Banner>
			)}
			{loading && reports === null && (
				<div className="flex justify-center py-12">
					<Spinner label={t("common.loading")} />
				</div>
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
								(await load())?.find(
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
