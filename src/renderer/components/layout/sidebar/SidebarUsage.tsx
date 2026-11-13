/**
 * Sidebar footer usage block (mixdog's "Rail bars", pin `usage`, on by default): every subscription account that
 * reports usage windows, grouped by provider the way Settings › Models & accounts lists them (the shared
 * `ProviderGroupItem` and `ConnectedRow`, `compact`): a provider header that folds its accounts (the fold is
 * remembered, `usageGroups`), and under it one row per account with the address whole (it wraps, never an
 * ellipsis; the full label is the tooltip), "In use" on the account this tab's session is pinned to, and every
 * measured window as a gauge with its reset beneath (5H, 7D, a model's own weekly limit), a window at its limit in
 * the danger fill and one near it in warning, as in Settings (`AccountQuota.tsx`). The provider this tab uses comes
 * first; inside a group the accounts keep a fixed order, so a reading never moves a row. The accounts scroll inside
 * a capped height, so many of them never take the sidebar. A row's reason line (why the session is on that account)
 * is `ConnectedRow`'s `reason` slot. API-key providers have no windows and are not listed; with no account at all the
 * block renders nothing. The header's gear opens Settings › Models & accounts. Reads go through `useUsageReports`
 * (live quotas, no polling of its own).
 */

import { Settings2 } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useMemo } from "react";
import type { ProviderInfo, UsageReport } from "../../../../shared/rpc-types";
import { useUsageReports } from "../../../hooks/use-usage-reports";
import { useT } from "../../../lib/i18n";
import { type UsageAccountGroup, usageAccountGroups } from "../../../lib/usage-reports";
import { gaugeColumns } from "../../../lib/usage-windows";
import { useModelStore } from "../../../stores/model";
import { useSidebarFolds } from "../../../stores/sidebar-folds";
import { useUiStore } from "../../../stores/ui";
import { DisclosureButton, IconButton } from "../../common";
import {
	AccountBadges,
	type AccountQuotaSource,
	accountNames,
	accountStanding,
	QuotaCell,
	quotaLimits,
} from "../../settings/providers/AccountQuota";
import { ConnectedRow, ProviderGroupItem } from "../../settings/providers/ConnectedRow";
import { type ProviderGroup, providerPlan, shortProviderName } from "../../settings/providers/provider-groups";

/** Gauge columns on one line of the sidebar's width; a provider with more wraps the rest under them. */
const SIDEBAR_USAGE_COLUMNS = 3;

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

function UsageGroup({ group, providers }: { group: UsageAccountGroup; providers: readonly ProviderInfo[] }) {
	const folded = useSidebarFolds(s => s.usageGroups[group.provider] === true);
	const sources = group.accounts.map(({ report, inUse }) => sourceOf(report, inUse));
	const labels = group.accounts.map(({ report }) => report.account?.trim() || report.provider);
	const names = accountNames(labels);
	const columns = gaugeColumns(sources.map(quotaLimits));
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
			{group.accounts.map(({ report, inUse }, index) => {
				const source = sources[index] as AccountQuotaSource;
				return (
					<ConnectedRow
						account={names[index]?.address ?? labels[index] ?? report.provider}
						accountSuffix={names[index]?.suffix}
						accountTitle={labels[index]}
						badges={<AccountBadges account={source} />}
						compact
						key={`${report.provider}:${report.credentialId ?? labels[index]}`}
						quota={
							<QuotaCell
								account={source}
								columns={columns}
								compact
								maxColumns={SIDEBAR_USAGE_COLUMNS}
								now={now}
								tracks={0}
							/>
						}
						quotaColumns={columns.length}
						rowProps={{
							"data-in-use": inUse || undefined,
							"data-rail-account": `${report.provider}:${report.account ?? ""}`,
							"data-usage-account": report.credentialId ?? labels[index],
							"data-usage-standing": accountStanding(source),
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
			<div className="flex items-center gap-0.5">
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
