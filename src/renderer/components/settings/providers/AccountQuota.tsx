/**
 * What one subscription account's row says about its quota, shared by every list of accounts: Settings › Models &
 * accounts (ProviderAccounts.tsx) and the sidebar's usage block (layout/sidebar/SidebarUsage.tsx), both drawn as
 * `ConnectedRow`s under a `ProviderGroupItem`. An account is read through {@link AccountQuotaSource}, which a stored
 * account (`ProviderAccount`) and a usage report (`UsageReport`, mapped by the sidebar) both give, so the gauges, the
 * reset beneath each, the tooltip and the state marks are one implementation.
 */

import type { AccountUsageState, UsageLimit } from "../../../../shared/rpc-types";
import { formatClock, formatSpan } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { accountGauges } from "../../../lib/usage-windows";
import { Badge, NEAR_FRACTION, UsageGauges, usageTooltip } from "../../common";
import { bareEmail } from "../../layout/AccountLimit";

/** What a row needs of an account to say its quota and state. */
export interface AccountQuotaSource {
	limits: readonly UsageLimit[];
	/** Unused share of the tightest window, for an account that reports no window of its own. */
	remainingFraction?: number;
	/** When stock last read the quota, epoch ms. */
	fetchedAt?: number;
	/** This tab's session is pinned to the account. */
	inUse?: boolean;
	state?: AccountUsageState;
	/** While omp skips the account after it hit a limit: when it is tried again. */
	limitedUntil?: number;
}

/**
 * The windows the row gauges: the report's limits, else (an account that only reports what is left of its quota)
 * one window holding the share used.
 */
export function quotaLimits(account: Pick<AccountQuotaSource, "limits" | "remainingFraction">): UsageLimit[] {
	if (account.limits.some(limit => limit.usedFraction !== undefined)) return [...account.limits];
	if (account.remainingFraction === undefined) return [];
	return [{ id: "quota", label: "Quota", windowId: "quota", usedFraction: 1 - account.remainingFraction }];
}

/**
 * What a row names each account by: the bare address, and the label's parenthetical ("team", "pro") muted after it only
 * where another account of the provider shares that address, so two logins with one email are told apart.
 */
export function accountNames(labels: readonly string[]): { address: string; suffix?: string }[] {
	const addresses = labels.map(bareEmail);
	return labels.map((label, index) => {
		const address = addresses[index] ?? label;
		const shared = addresses.filter(other => other === address).length > 1;
		const suffix = shared ? /\(([^)]*)\)\s*$/.exec(label.trim())?.[1]?.trim() : undefined;
		return suffix ? { address, suffix } : { address };
	});
}

/** Short local identifiers; a stable row number distinguishes matching prefixes and duplicate sign-ins. */
export function shortAccountNames(labels: readonly string[]): string[] {
	return labels.map((label, index) => {
		const stem = bareEmail(label).split("@")[0] || label;
		return `${stem.slice(0, 4)}·${index + 1}`;
	});
}

/** How the account stands: out of room (a gauge at its limit, or omp skipping it), running low, or fine. */
export function accountStanding(account: AccountQuotaSource): "limited" | "low" | "ok" {
	const gauges = accountGauges(quotaLimits(account));
	if (account.state === "depleted" || gauges.some(gauge => gauge.fraction >= 1)) return "limited";
	if (account.state === "reserve" || gauges.some(gauge => gauge.fraction >= NEAR_FRACTION)) return "low";
	return "ok";
}

/**
 * The account's windows as shared gauges (share used, reset beneath each), each in its column of the provider's
 * set, on the track count the whole list shares; the tooltip lists every window and the read's age.
 */
export function QuotaCell({
	account,
	columns,
	tracks,
	compact = false,
	now,
}: {
	account: AccountQuotaSource;
	columns: readonly string[];
	tracks: number;
	/** Slim bars with small type (`UsageGauges compact`): the sidebar's width. */
	compact?: boolean;
	now: number;
}) {
	const t = useT();
	const limits = quotaLimits(account);
	if (accountGauges(limits).length === 0) return null;
	const title = [
		usageTooltip({ provider: "", fetchedAt: account.fetchedAt ?? 0, limits }, "", t)
			.split("\n")
			.slice(1)
			.join("\n"),
		account.fetchedAt === undefined ? null : t("usage.updatedAgo", { time: formatSpan(now - account.fetchedAt) }),
	]
		.filter(Boolean)
		.join("\n");
	return (
		<div
			data-quota-updated={account.fetchedAt === undefined ? undefined : formatClock(account.fetchedAt)}
			title={title}
		>
			<UsageGauges
				columns={columns}
				compact={compact}
				limits={limits}
				resets
				sharedLabels={compact}
				tracks={tracks}
			/>
		</div>
	);
}

/** In use, and what no gauge of the row says: skipped after a limit, or low, with no window at or near its end. */
export function AccountBadges({ account, compact = false }: { account: AccountQuotaSource; compact?: boolean }) {
	const t = useT();
	const gauges = accountGauges(quotaLimits(account));
	if (compact) {
		const limited = accountStanding(account) === "limited";
		return account.inUse || limited ? (
			<span className={`omp-account-state ${limited ? "text-(--sc-warning)" : "text-(--sc-success)"}`}>
				{account.inUse && limited && <span aria-label={t("providers.accounts.inUse")}>● </span>}
				{limited ? t("usage.limitedShort") : t("providers.accounts.inUse")}
			</span>
		) : null;
	}
	return (
		<>
			{account.inUse && <Badge variant="success">{t("providers.accounts.inUse")}</Badge>}
			{account.state === "depleted" && !gauges.some(gauge => gauge.fraction >= 1) && (
				<Badge variant="warning">
					{account.limitedUntil !== undefined
						? t("providers.accounts.limitedUntil", { time: formatClock(account.limitedUntil) })
						: t("providers.accounts.limited")}
				</Badge>
			)}
			{account.state === "reserve" && !gauges.some(gauge => gauge.fraction >= NEAR_FRACTION) && (
				<Badge variant="warning">{t("providers.accounts.low")}</Badge>
			)}
		</>
	);
}
