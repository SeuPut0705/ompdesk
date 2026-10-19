/**
 * Insights › Stats › This session: the attached session's numbers
 * (get_session_stats — the native /session info) and its context window
 * (get_context_report). Whole-journal totals (`history`: pre-compaction and
 * sibling branches included) lead; the live-context figures follow. The
 * figures re-read after every settled turn the same way the title bar does
 * (a settled append or the snapshot pulse), never mid-stream per delta.
 */

import { MessageSquare, RefreshCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { SessionStats } from "../../../shared/rpc-types";
import { useCurrentSessionTitle } from "../../hooks/use-current-session-title";
import { basename, formatTokens, formatUsd, uiLocale } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { useMessagesStore } from "../../stores/messages";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";
import { Banner, Button, EmptyState, ErrorDetail, IconButton, SkeletonRows } from "../common";
import { MetricCard, MetricGrid, SectionTitle } from "../stats/shared";
import { ContextBreakdown } from "./ContextBreakdown";
import { ModelUsage } from "./ModelUsage";

interface Fact {
	label: string;
	value: string;
	mono?: boolean;
}

function FactList({ facts }: { facts: Fact[] }) {
	return (
		<dl className="divide-y divide-(--sc-divider) rounded-(--sc-radius-lg) border border-(--sc-border-subtle)">
			{facts.map(fact => (
				<div className="flex items-baseline justify-between gap-4 px-4 py-2 text-sc-sm" key={fact.label}>
					<dt className="text-(--sc-text-muted)">{fact.label}</dt>
					<dd
						className={
							fact.mono
								? "min-w-0 truncate font-mono text-(--sc-text)"
								: "min-w-0 truncate tabular-nums text-(--sc-text)"
						}
						title={fact.value}
					>
						{fact.value}
					</dd>
				</div>
			))}
		</dl>
	);
}

function Columns({ children }: { children: ReactNode }) {
	// minmax(0, 1fr): an implicit auto track would grow to the widest unbreakable value and scroll the page sideways.
	return <div className="grid grid-cols-[minmax(0,1fr)] gap-x-6 gap-y-8 lg:grid-cols-2">{children}</div>;
}

function formatCredit(value: number): string {
	return value.toLocaleString(uiLocale(), { maximumFractionDigits: 4 });
}

export function SessionInsights() {
	const tabRpc = useTabRpc();
	const t = useT();
	const ready = useSessionStore(s => s.status) === "ready";
	const sessionTitle = useCurrentSessionTitle();
	const sessionId = useSessionStore(s => s.sessionId);
	const isStreaming = useSessionStore(s => s.isStreaming);
	const isCompacting = useSessionStore(s => s.isCompacting);
	const statsPulse = useSessionStore(s => s.statsPulse);
	const messageCount = useMessagesStore(s => s.messages.length);
	const openInsights = useUiStore(s => s.openInsights);
	const [stats, setStats] = useState<SessionStats | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [refreshKey, setRefreshKey] = useState(0);

	const load = useCallback(
		async (silent: boolean) => {
			if (!ready) return;
			if (!silent) setLoading(true);
			try {
				const response = await tabRpc.getSessionStats();
				if (response.success) {
					setStats(response.data as SessionStats);
					setError(null);
				} else if (!silent) setError(response.error);
			} catch (cause) {
				if (!silent) setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				if (!silent) setLoading(false);
			}
		},
		[ready, tabRpc.getSessionStats],
	);

	// A new session (or runtime) starts from a loud read.
	// biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the trigger.
	useEffect(() => {
		setStats(null);
		void load(false);
	}, [load, sessionId]);

	// Settled transcript appends and the snapshot pulse move the figures; mid-run
	// only the pulse may queue a read, so the agent's own traffic stays first.
	const trigger = isStreaming ? `streaming:${statsPulse}` : `idle:${messageCount}:${statsPulse}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: trigger paces the silent refetch.
	useEffect(() => {
		if (isCompacting) return;
		void load(true);
	}, [trigger, isCompacting]);

	const refresh = () => {
		void load(false);
		setRefreshKey(key => key + 1);
	};

	if (!ready) {
		return (
			<EmptyState
				actions={
					<Button onClick={() => openInsights("stats", "all")} size="sm" variant="secondary">
						{t("insights.session.viewAll")}
					</Button>
				}
				description={t("insights.session.notConnectedHint")}
				icon={<MessageSquare />}
				title={t("insights.session.notConnected")}
			/>
		);
	}
	if (!stats) {
		return error ? (
			<EmptyState
				actions={
					<Button icon={<RefreshCw />} onClick={refresh} size="sm" variant="secondary">
						{t("common.retry")}
					</Button>
				}
				description={
					<span role="alert">
						<ErrorDetail error={error} />
					</span>
				}
				icon={<MessageSquare />}
				title={t("insights.session.loadFailed")}
			/>
		) : (
			<SkeletonRows className="py-2" label={t("sessionInfo.loading")} widths={[60, 44, 70, 52]} />
		);
	}

	const history = stats.history;
	const totalTokens = history?.totalTokens ?? stats.tokens.total;
	const orchestration = history
		? history.orchestrationInput + history.orchestrationOutput + history.orchestrationCacheRead
		: 0;
	const routed = Object.entries(stats.routedModels ?? {}).sort(
		([aId, aCount], [bId, bCount]) => bCount - aCount || aId.localeCompare(bId),
	);

	return (
		<div className="flex flex-col">
			<div className="flex items-center gap-3">
				<h2 className="min-w-0 truncate text-sc-xl font-semibold text-(--sc-text)">{sessionTitle}</h2>
				<span
					className="shrink-0 rounded-(--sc-radius-xs) bg-(--sc-surface-3) px-1.5 py-0.5 font-mono text-sc-2xs text-(--sc-text-muted)"
					title={stats.sessionId}
				>
					#{stats.sessionId.slice(0, 8)}
				</span>
				<IconButton
					className="ml-auto"
					icon={<RefreshCw />}
					loading={loading}
					label={t("common.refresh")}
					onClick={refresh}
				/>
			</div>
			{error && (
				<Banner className="mt-3" live title={t("insights.session.loadFailed")} variant="warning">
					<ErrorDetail error={error} />
				</Banner>
			)}

			<div className="mt-4">
				<MetricGrid>
					<MetricCard
						label={t("usage.totalTokens")}
						sub={t("insights.session.inOut", {
							input: formatTokens(history?.input ?? stats.tokens.input),
							output: formatTokens(history?.output ?? stats.tokens.output),
						})}
						value={formatTokens(totalTokens)}
					/>
					<MetricCard label={t("usage.cost")} value={formatUsd(history?.cost ?? stats.cost)} />
					<MetricCard
						label={t("sessionInfo.section.messages")}
						sub={t("insights.session.turns", { user: stats.userMessages, assistant: stats.assistantMessages })}
						value={String(stats.totalMessages)}
					/>
					<MetricCard label={t("sessionInfo.toolCalls")} value={String(stats.toolCalls)} />
					<MetricCard
						label={t("usage.cacheRead")}
						value={formatTokens(history?.cacheRead ?? stats.tokens.cacheRead)}
					/>
					<MetricCard
						label={t("usage.premiumRequests")}
						value={String(history?.premiumRequests ?? stats.premiumRequests)}
					/>
				</MetricGrid>
			</div>
			{history && <p className="mt-3 text-sc-xs text-(--sc-text-muted)">{t("sessionInfo.scope")}</p>}

			<ModelUsage stats={stats} />

			<SectionTitle>{t("sessionInfo.contextWindow")}</SectionTitle>
			<ContextBreakdown refreshKey={refreshKey} />

			<div className="mt-8">
				<Columns>
					<section>
						<h3 className="mb-3 text-sc-md font-semibold text-(--sc-text)">{t("sessionInfo.section.tokens")}</h3>
						<FactList
							facts={[
								{ label: t("sessionInfo.input"), value: formatTokens(stats.tokens.input) },
								{ label: t("sessionInfo.output"), value: formatTokens(stats.tokens.output) },
								{ label: t("sessionInfo.reasoning"), value: formatTokens(stats.tokens.reasoning) },
								{ label: t("sessionInfo.cacheRead"), value: formatTokens(stats.tokens.cacheRead) },
								{ label: t("sessionInfo.cacheWrite"), value: formatTokens(stats.tokens.cacheWrite) },
								{ label: t("sessionInfo.total"), value: formatTokens(stats.tokens.total) },
								...(orchestration > 0
									? [{ label: t("usage.orchestration"), value: formatTokens(orchestration) }]
									: []),
							]}
						/>
					</section>
					<section>
						<h3 className="mb-3 text-sc-md font-semibold text-(--sc-text)">{t("sessionInfo.section.usage")}</h3>
						<FactList
							facts={[
								{ label: t("sessionInfo.premiumRequests"), value: String(stats.premiumRequests) },
								{ label: t("sessionInfo.cost"), value: formatUsd(stats.cost) },
								{ label: t("sessionInfo.toolResults"), value: String(stats.toolResults) },
								...(history?.compactions !== undefined
									? [{ label: t("sessionInfo.compactions"), value: String(history.compactions) }]
									: []),
								...(stats.credits
									? [
											{ label: t("sessionInfo.credits"), value: formatCredit(stats.credits.cost) },
											{
												label: t("sessionInfo.committedCredits"),
												value: formatCredit(stats.credits.committedCost),
											},
											{ label: t("sessionInfo.committedAcu"), value: formatCredit(stats.credits.acuCost) },
										]
									: []),
							]}
						/>
					</section>
					{routed.length > 0 && (
						<section>
							<h3 className="mb-3 text-sc-md font-semibold text-(--sc-text)">
								{t("sessionInfo.section.routedModels")}
							</h3>
							<FactList facts={routed.map(([id, count]) => ({ label: id, value: String(count) }))} />
						</section>
					)}
					<section>
						<h3 className="mb-3 text-sc-md font-semibold text-(--sc-text)">{t("sessionInfo.section.session")}</h3>
						<FactList
							facts={[
								{ label: t("sessionInfo.sessionId"), value: stats.sessionId, mono: true },
								...(stats.sessionFile
									? [{ label: t("sessionInfo.file"), value: basename(stats.sessionFile), mono: true }]
									: []),
								...(history
									? [
											{
												label: t("sessionInfo.sampledAt"),
												value: new Date(history.sampledAt).toLocaleTimeString(uiLocale()),
											},
										]
									: []),
							]}
						/>
					</section>
				</Columns>
			</div>
		</div>
	);
}
