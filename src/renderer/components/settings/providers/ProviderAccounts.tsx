/**
 * The stored sign-ins of one connected subscription provider, as a group of Settings › Models & accounts
 * (ProvidersSection): the provider's header (brand, account count, "Add account", the provider's own
 * ⋯: refresh quotas, sign out of every account) and an account row under it each (ConnectedRow) with every
 * live quota window it reports and its reset (model-scoped ones too, each window in the same column down the
 * list), the one this tab's session is using, and its saved resets. An account omp is skipping after it hit a
 * limit reads from its full gauge; a badge says so only when no gauge does (the owner's call, 10 Nov 2026: the
 * reset under the gauge already says until when). omp itself picks between the accounts; the rows only show that and add or
 * remove accounts. "Add account" is the same sign-in flow (a different identity adds a row); removing
 * logs out that one credential, and the last one disconnects the provider. The read lives in
 * `useProviderAccounts`, owned by the provider's group; it is always live (lib/usage-reports.ts): each
 * account says how old its quota is in the quota's tooltip, and "Refresh quotas" has stock probe the
 * provider now. On omp 18.8.1+ each account with an identity key offers to copy it (the name
 * `task.agentAccountPools` matches) and a shortcut to the Account pools editor. An account with saved
 * rate-limit resets shows them and can spend one (ResetPasses.tsx); one with money or credits left says how much
 * (`CreditsFigure`). Names in toasts and dialogs are the brand (`group.shortName`), as in the list.
 */

import { Copy, RefreshCw, Trash2, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountCredits, ProviderAccount, ProviderAccountsResult, UsageLimit } from "../../../../shared/rpc-types";
import { type InlineFailure, inlineFailure } from "../../../lib/error-detail";
import { copyText, formatClock, formatCredits, formatSpan } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useNowTick } from "../../../lib/now-tick";
import { useTabRpc } from "../../../lib/tab-rpc";
import { accountGauges, gaugeColumns } from "../../../lib/usage-windows";
import { toast, toastError } from "../../../stores/toast";
import {
	Badge,
	Button,
	ConfirmDialog,
	type ContextMenuItem,
	InlineNotice,
	MAX_USAGE_COLUMNS,
	NEAR_FRACTION,
	Tooltip,
	UsageGauges,
	usageTooltip,
} from "../../common";
import { bareEmail } from "../../layout/AccountLimit";
import { useSettingsNavigate } from "../settings-navigation";
import { ConnectedRow, ProviderGroupItem } from "./ConnectedRow";
import type { ProviderGroup } from "./provider-groups";
import { ResetPassControl } from "./ResetPasses";

/**
 * The windows the row gauges: the report's limits, else (an account that only reports what is left of its quota)
 * one window holding the share used.
 */
function quotaLimits(account: ProviderAccount): UsageLimit[] {
	if (account.limits.some(limit => limit.usedFraction !== undefined)) return account.limits;
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

/**
 * What every account row of the list shares, so the same window stands in the same column from one provider to the
 * next (Claude's three gauges over ChatGPT's two): the gauge columns of the provider that has most, and whether any
 * account has credits left or a reset pass.
 */
export interface AccountRowLayout {
	quotaColumns: number;
	credits: boolean;
	pass: boolean;
}

export function accountRowLayout(results: readonly (ProviderAccountsResult | null)[]): AccountRowLayout {
	const lists = results.map(result => result?.accounts ?? []);
	return {
		quotaColumns: Math.min(
			MAX_USAGE_COLUMNS,
			Math.max(0, ...lists.map(accounts => gaugeColumns(accounts.map(quotaLimits)).length)),
		),
		credits: lists.some(accounts => accounts.some(account => account.credits !== undefined)),
		pass: lists.some(accounts => accounts.some(account => account.resetPasses !== undefined)),
	};
}

export interface ProviderAccountsState {
	result: ProviderAccountsResult | null;
	error: InlineFailure | null;
	loading: boolean;
	/**
	 * Re-reads the accounts; resolves to the new result, `null` when the read failed
	 * or a newer one superseded it. `refresh` has stock probe the provider first; a
	 * `quiet` read (the live poll) leaves `loading` alone.
	 */
	load: (options?: { refresh?: boolean; quiet?: boolean }) => Promise<ProviderAccountsResult | null>;
}

/**
 * The stored accounts of one provider. Reads while `enabled` (connected, lists
 * accounts, omp ready) and again whenever `revision` changes: a sign-in or
 * sign-out elsewhere on the page. The quotas stay current with the tab's usage
 * poll: each move of `usagePolls` (`UsageFeed.polls`, hooks/use-usage-reports.ts)
 * re-reads them quietly.
 */
export function useProviderAccounts(
	providerId: string,
	enabled: boolean,
	revision: number,
	usagePolls: number,
): ProviderAccountsState {
	const t = useT();
	const tabRpc = useTabRpc();
	const [result, setResult] = useState<ProviderAccountsResult | null>(null);
	const [error, setError] = useState<InlineFailure | null>(null);
	const [loading, setLoading] = useState(false);
	const requestVersion = useRef(0);

	const load = useCallback(
		async ({ refresh = false, quiet = false } = {}): Promise<ProviderAccountsResult | null> => {
			const version = ++requestVersion.current;
			if (!quiet) setLoading(true);
			try {
				const response = await tabRpc.getProviderAccounts(providerId, refresh);
				if (version !== requestVersion.current) return null;
				if (!response.success) {
					setError(inlineFailure(response, t("providers.accounts.loadFailed")));
					return null;
				}
				const next = response.data as ProviderAccountsResult;
				setError(null);
				setResult(next);
				return next;
			} catch (cause) {
				if (version === requestVersion.current) setError(inlineFailure(cause, t("providers.accounts.loadFailed")));
				return null;
			} finally {
				if (version === requestVersion.current) setLoading(false);
			}
		},
		[providerId, t, tabRpc],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is the re-read signal.
	useEffect(() => {
		if (enabled) void load();
	}, [enabled, load, revision]);
	const seenPolls = useRef(usagePolls);
	useEffect(() => {
		if (seenPolls.current === usagePolls) return;
		seenPolls.current = usagePolls;
		if (enabled) void load({ quiet: true });
	}, [usagePolls, enabled, load]);

	return { result, error, loading, load };
}

/**
 * The account's windows as shared gauges (share used, reset beneath each), each in its column of the provider's
 * set, on the track count the whole list shares; the tooltip lists every window and the read's age.
 */
function QuotaCell({
	account,
	columns,
	tracks,
	now,
}: {
	account: ProviderAccount;
	columns: readonly string[];
	tracks: number;
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
			<UsageGauges columns={columns} limits={limits} resets tracks={tracks} />
		</div>
	);
}

/** In use, and what no gauge of the row says: skipped after a limit, or low, with no window at or near its end. */
function AccountBadges({ account }: { account: ProviderAccount }) {
	const t = useT();
	const gauges = accountGauges(quotaLimits(account));
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

/**
 * What the account has left to spend, one quiet labelled figure ("Credits $35.20"); its tooltip says what it is: the
 * month's extra usage left of its cap, prepaid credits, or credits the provider does not count ("Credits Unlimited").
 */
function CreditsFigure({ credits }: { credits: AccountCredits }) {
	const t = useT();
	const left =
		credits.kind === "unlimited"
			? t("providers.accounts.creditsUnlimited")
			: formatCredits(credits.remaining, credits.unit);
	const what =
		credits.kind === "monthlyCap"
			? t("providers.accounts.creditsMonthlyCap", { left, limit: formatCredits(credits.limit, credits.unit) })
			: credits.kind === "unlimited"
				? t("providers.accounts.creditsUnlimitedWhat")
				: t("providers.accounts.creditsBalance", { left });
	return (
		<Tooltip content={what}>
			<Badge data-account-credits={credits.kind} size="xs" variant="muted">
				{t("providers.accounts.credits")}
				<span className="text-(--sc-text-secondary) tabular-nums">{left}</span>
			</Badge>
		</Tooltip>
	);
}

/**
 * One subscription provider as a group: the header (brand, count, "Add account", provider actions) and an
 * account row each under it, or the header alone naming the problem while the accounts are being read, could
 * not be read, or none are stored.
 */
export function ProviderAccountRows({
	group,
	state,
	layout,
	sidecarReady,
	adding,
	onAdd,
	onChanged,
	onSignOutAll,
}: {
	group: ProviderGroup;
	state: ProviderAccountsState;
	layout: AccountRowLayout;
	sidecarReady: boolean;
	/** A sign-in for this provider is in flight. */
	adding: boolean;
	onAdd: () => void;
	/** After an account is removed: the provider may no longer be connected. */
	onChanged: () => Promise<unknown>;
	/** Provider-wide sign-out (the section confirms it). */
	onSignOutAll: () => void;
}) {
	const t = useT();
	const tabRpc = useTabRpc();
	const navigate = useSettingsNavigate();
	const { provider, shortName, fullName } = group;
	const { result, error, loading, load } = state;
	const [pendingRemove, setPendingRemove] = useState<ProviderAccount | null>(null);
	const [removing, setRemoving] = useState<number | null>(null);
	const accounts = result?.accounts ?? [];
	const names = accountNames(accounts.map(account => account.label));
	const now = useNowTick(accounts.length > 0);

	// The provider's own windows, in the first of the columns the whole list shares.
	const columns = gaugeColumns(accounts.map(quotaLimits));
	const remove = async (account: ProviderAccount) => {
		setPendingRemove(null);
		setRemoving(account.credentialId);
		try {
			const response = await tabRpc.logout(provider.id, account.credentialId);
			if (!response.success) {
				toastError({ title: t("providers.accounts.removeFailed"), error: response });
				return;
			}
			toast({
				variant: "success",
				message: t("providers.accounts.removed", { account: account.label, provider: shortName }),
			});
			await Promise.allSettled([onChanged(), load()]);
		} catch (cause) {
			toastError({ title: t("providers.accounts.removeFailed"), error: cause });
		} finally {
			setRemoving(null);
		}
	};

	// The provider's own actions (the header's ⋯); an account's ⋯ holds only that account's.
	const providerMenu: ContextMenuItem[] = [
		{
			id: "refresh",
			label: t("providers.accounts.refresh", { provider: shortName }),
			icon: RefreshCw,
			disabled: !sidecarReady,
			onSelect: () => void load({ refresh: true }),
		},
		...(accounts.length > 0
			? [
					{
						id: "sign-out-all",
						label: t("providers.logoutAll"),
						icon: Trash2,
						danger: true,
						separatorBefore: true,
						disabled: !sidecarReady,
						onSelect: onSignOutAll,
					},
				]
			: []),
	];
	const header = {
		group,
		count: accounts.length,
		menu: providerMenu,
		onAdd,
		addDisabled: !sidecarReady || adding,
	};

	if (accounts.length === 0) {
		return (
			<ProviderGroupItem {...header} busy={loading && result === null} detail={error ? error.message : undefined} />
		);
	}
	return (
		<ProviderGroupItem
			{...header}
			after={
				<ConfirmDialog
					busy={pendingRemove !== null && removing === pendingRemove.credentialId}
					confirmLabel={t("providers.accounts.removeConfirm")}
					message={
						accounts.length > 1
							? t("providers.accounts.removeBody", { account: pendingRemove?.label ?? "", provider: shortName })
							: t("providers.accounts.removeLastBody", {
									account: pendingRemove?.label ?? "",
									provider: shortName,
								})
					}
					onCancel={() => setPendingRemove(null)}
					onConfirm={() => {
						if (pendingRemove) void remove(pendingRemove);
					}}
					open={pendingRemove !== null}
					title={t("providers.accounts.removeTitle")}
				/>
			}
		>
			{accounts.map((account, index) => (
				<ConnectedRow
					account={names[index]?.address ?? account.label}
					accountSuffix={names[index]?.suffix}
					accountTitle={[account.label, account.detail].filter(Boolean).join("\n")}
					actionName={`${fullName} ${[names[index]?.address, names[index]?.suffix].filter(Boolean).join(" ")}`}
					badges={<AccountBadges account={account} />}
					pass={
						!layout.pass ? undefined : account.resetPasses ? (
							<ResetPassControl
								account={account.label}
								credentialId={account.credentialId}
								disabled={!sidecarReady}
								expiry
								limits={account.limits}
								onRedeemed={async (): Promise<readonly UsageLimit[] | undefined> =>
									(await load())?.accounts.find(entry => entry.credentialId === account.credentialId)?.limits
								}
								passes={account.resetPasses}
								providerId={provider.id}
								providerName={shortName}
							/>
						) : null
					}
					busy={removing === account.credentialId}
					credits={
						!layout.credits ? undefined : account.credits ? <CreditsFigure credits={account.credits} /> : null
					}
					key={account.credentialId}
					menu={[
						...(typeof account.identityKey === "string"
							? [
									{
										id: "copy-key",
										label: t("providers.accounts.copyKey", { account: account.label }),
										icon: Copy,
										onSelect: () => {
											// Token-free: the key is the pool name `omp usage accounts` prints.
											void copyText(account.identityKey ?? "").then(ok =>
												ok
													? toast({ variant: "success", message: t("common.copied") })
													: toast({ variant: "error", message: t("common.copyFailed") }),
											);
										},
									},
									{
										id: "account-pools",
										label: t("providers.accounts.pools"),
										icon: Users,
										onSelect: () => navigate("models", "settings-models-account-pools"),
									},
								]
							: []),
						{
							id: "remove",
							label: t("providers.accounts.remove", { account: account.label }),
							icon: Trash2,
							danger: true,
							separatorBefore: typeof account.identityKey === "string",
							disabled: !sidecarReady || removing !== null,
							onSelect: () => setPendingRemove(account),
						},
					]}
					quota={<QuotaCell account={account} columns={columns} now={now} tracks={layout.quotaColumns} />}
					quotaColumns={layout.quotaColumns}
					rowProps={{ "data-provider-account": account.credentialId }}
				/>
			))}
			{result?.usageError && (
				<li>
					<InlineNotice title={t("providers.accounts.quotaUnavailable")} tone="info" />
				</li>
			)}
			{error && (
				<li>
					<InlineNotice
						action={
							<Button
								disabled={!sidecarReady || loading}
								icon={<RefreshCw />}
								onClick={() => void load()}
								size="sm"
								variant="ghost"
							>
								{t("common.retry")}
							</Button>
						}
						detail={error.cause}
						title={error.message}
						tone="danger"
					/>
				</li>
			)}
		</ProviderGroupItem>
	);
}
