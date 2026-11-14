/**
 * Every measured subscription account, grouped by provider, with shared window headings and compact account rows.
 * Names are shortened only here; each row retains the full account as its accessible name and tooltip.
 * Quotas and reset times come from the shared account renderer. Reads go through `useUsageReports`.
 */

import { Settings2 } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useMemo } from "react";
import type { ProviderInfo, UsageReport } from "../../../../shared/rpc-types";
import { useUsageReports } from "../../../hooks/use-usage-reports";
import { useT } from "../../../lib/i18n";
import { accountGauges, gaugeColumn, gaugeColumns, shortWindowLabel } from "../../../lib/usage-windows";
import { useModelStore } from "../../../stores/model";
import { useSidebarFolds } from "../../../stores/sidebar-folds";
import { useUiStore } from "../../../stores/ui";
import { DisclosureButton, IconButton, MAX_USAGE_COLUMNS, NEAR_FRACTION } from "../../common";
import { type AccountQuotaSource, QuotaCell, quotaLimits } from "../../settings/providers/AccountQuota";
import { ConnectedRow, ProviderGroupItem } from "../../settings/providers/ConnectedRow";
import { type ProviderGroup, providerPlan, shortProviderName } from "../../settings/providers/provider-groups";
import { bareEmail } from "../AccountLimit";
import { type UsageAccountGroup, usageAccountGroups } from "./usage-groups";

/** What a row says of a usage report: the account's quota, and its state while omp skips it after a limit. */
function sourceOf(report: UsageReport, inUse: boolean): AccountQuotaSource {
	const limited = report.resetAt !== undefined;
	return {
		limits: report.limits,
		fetchedAt: report.fetchedAt,
		inUse,
		...(limited ? { state: "depleted" as const, limitedUntil: report.resetAt } : {}),
	};
}

/** The group a provider is drawn as: its stock name when the catalog lists it, else its id. */
function groupOf(id: string, providers: readonly ProviderInfo[]): ProviderGroup {
	const info = providers.find(provider => provider.id === id);
	const provider: ProviderInfo = info ?? {
		id,
		name: id,
		authenticated: true,
		loginAvailable: false,
		disabled: false,
		modelCount: 0,
	};
	return {
		provider,
		shortName: shortProviderName(provider),
		fullName: provider.name,
		plan: providerPlan(provider),
		kind: "accounts",
	};
}

function shortAccountNames(labels: readonly string[]): string[] {
	return labels.map((label, index) => {
		const stem = bareEmail(label).split("@")[0] || label;
		return `${stem.slice(0, 4)}·${index + 1}`;
	});
}

function accountStanding(account: AccountQuotaSource): "limited" | "low" | "ok" {
	const gauges = accountGauges(quotaLimits(account));
	if (account.state === "depleted" || gauges.some(gauge => gauge.fraction >= 1)) return "limited";
	if (account.state === "reserve" || gauges.some(gauge => gauge.fraction >= NEAR_FRACTION)) return "low";
	return "ok";
}

function UsageGroup({ group, providers }: { group: UsageAccountGroup; providers: readonly ProviderInfo[] }) {
	const t = useT();
	const folded = useSidebarFolds(s => s.usageGroups[group.provider] === true);
	const sources = group.accounts.map(({ report, inUse }) => sourceOf(report, inUse));
	const labels = group.accounts.map(({ report }) => report.account?.trim() || report.provider);
	const names = shortAccountNames(labels);
	const limits = sources.map(quotaLimits);
	const columns = gaugeColumns(limits);
	const headings = accountGauges(limits.flat());
	const now = Date.now();
	return (
		<ProviderGroupItem
			compact
			count={group.accounts.length}
			fold={{
				open: !folded,
				onToggle: () => useSidebarFolds.getState().setUsageGroupFolded(group.provider, !folded),
			}}
			group={groupOf(group.provider, providers)}
		>
			{columns.length <= MAX_USAGE_COLUMNS && (
				<li aria-hidden className="omp-sidebar-usage-columns">
					<span />
					<div style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
						{columns.map(column => (
							<span key={column}>
								{shortWindowLabel(headings.find(entry => gaugeColumn(entry.limit) === column)!.limit)}
							</span>
						))}
					</div>
				</li>
			)}
			{group.accounts.map(({ report, inUse }, index) => {
				const source = sources[index] as AccountQuotaSource;
				const standing = accountStanding(source);
				const limited = standing === "limited";
				return (
					<ConnectedRow
						account={names[index] ?? labels[index] ?? report.provider}
						accountTitle={labels[index]}
						badges={
							(source.inUse || limited) && (
								<span
									className={`omp-account-state ${limited ? "text-(--sc-warning)" : "text-(--sc-success)"}`}
								>
									{source.inUse && limited && <span aria-label={t("providers.accounts.inUse")}>● </span>}
									{limited ? t("usage.limitedShort") : t("providers.accounts.inUse")}
								</span>
							)
						}
						compact
						key={`${report.provider}:${report.credentialId ?? labels[index]}`}
						quota={<QuotaCell account={source} columns={columns} compact now={now} tracks={0} />}
						quotaColumns={columns.length}
						rowProps={{
							"data-in-use": inUse || undefined,
							"data-rail-account": `${report.provider}:${report.account ?? ""}`,
							"data-usage-account": report.credentialId ?? labels[index],
							"data-usage-standing": standing,
						}}
					/>
				);
			})}
		</ProviderGroupItem>
	);
}

export function SidebarUsage({
	onContextMenu,
	onKeyDown,
}: {
	onContextMenu?: (event: MouseEvent<HTMLElement>) => void;
	onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
}) {
	const t = useT();
	const provider = useModelStore(s => s.model?.provider ?? null);
	const providers = useModelStore(s => s.providers);
	const reports = useUsageReports();
	const groups = useMemo(() => (reports ? usageAccountGroups(reports, provider) : []), [reports, provider]);
	// The block folds to its header; the fold is remembered (`stores/sidebar-folds.ts`).
	const collapsed = useSidebarFolds(s => s.usageCollapsed);
	if (groups.length === 0) return null;
	return (
		<div
			className="omp-sidebar-usage"
			data-collapsed={collapsed || undefined}
			data-rail-pin="usage"
			onContextMenu={onContextMenu}
			onKeyDown={onKeyDown}
		>
			<div className="flex shrink-0 items-center gap-0.5">
				<DisclosureButton
					chevron="end"
					chevronClassName="size-(--sc-icon-sm)"
					className="h-6 min-w-0 flex-1 gap-1 rounded-(--sc-radius-md) px-2 text-sc-xs font-medium text-(--sc-text-muted) hover:text-(--sc-text)"
					data-sidebar-usage-toggle
					onToggle={() => useSidebarFolds.getState().setUsageCollapsed(!collapsed)}
					open={!collapsed}
				>
					<span className="min-w-0 flex-1 truncate text-left">{t("sidebar.pin.usage")}</span>
				</DisclosureButton>
				<IconButton
					data-sidebar-usage-open
					icon={<Settings2 />}
					label={t("sidebar.pin.usageOpen")}
					onClick={() => useUiStore.getState().openProviders()}
					size="sm"
				/>
			</div>
			{!collapsed && (
				<ul aria-label={t("sidebar.pin.usage")} className="omp-sidebar-usage-groups" data-sidebar-usage-scroll>
					{groups.map(group => (
						<UsageGroup group={group} key={group.provider} providers={providers} />
					))}
				</ul>
			)}
		</div>
	);
}
