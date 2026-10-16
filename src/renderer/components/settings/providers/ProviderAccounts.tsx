/**
 * The stored sign-ins of one connected subscription provider, as rows of the flat list in
 * Settings › Models & providers (ProvidersSection): each account is one ConnectedRow with its
 * tightest live quota and its reset, the one this tab's session is using, and the ones omp is
 * skipping after they hit a limit. omp itself picks between the accounts; the rows only show
 * that and add or remove accounts. "Add another account" is the same sign-in flow (a different
 * identity adds a row); removing logs out that one credential, and the last one disconnects the
 * provider. The read lives in `useProviderAccounts`, owned by the provider's rows; it is always
 * live (lib/usage-reports.ts): each account says how old its quota is in the quota's tooltip,
 * and "Refresh quotas" has stock probe the provider now. On omp 18.8.1+ each account with an
 * identity key offers to copy it (the name `task.agentAccountPools` matches) and a shortcut to
 * the Account pools editor. An account with saved rate-limit resets shows them and can spend one
 * (ResetPasses.tsx).
 */

import { Copy, RefreshCw, Trash2, UserPlus, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderAccount, ProviderAccountsResult, ProviderInfo, UsageLimit } from "../../../../shared/rpc-types";
import { type InlineFailure, inlineFailure } from "../../../lib/error-detail";
import { copyText, formatClock, formatSpan } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useNowTick } from "../../../lib/now-tick";
import { useTabRpc } from "../../../lib/tab-rpc";
import { accountWindows } from "../../../lib/usage-windows";
import { toast, toastError } from "../../../stores/toast";
import { Badge, Button, ConfirmDialog, type ContextMenuItem, InlineNotice } from "../../common";
import { UsageGauges, usageTooltip } from "../../common/UsageGauges";
import { useSettingsNavigate } from "../settings-navigation";
import { ConnectedRow } from "./ConnectedRow";
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

/** The account's windows as shared gauges (share used, reset beneath each); the tooltip lists every window and the read's age. */
function QuotaCell({ account, now }: { account: ProviderAccount; now: number }) {
	const t = useT();
	const limits = quotaLimits(account);
	if (accountWindows(limits).length === 0) return null;
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
			className="order-4 flex w-full shrink-0 flex-col gap-1 pl-[1.875rem] @xl:order-3 @xl:w-64 @xl:pl-0"
			data-quota-updated={account.fetchedAt === undefined ? undefined : formatClock(account.fetchedAt)}
			title={title}
		>
			<UsageGauges limits={limits} resets />
		</div>
	);
}

/**
 * The rows of one subscription provider: an account each, or one row naming the provider while
 * its accounts are being read, could not be read, or none are stored.
 */
export function ProviderAccountRows({
	provider,
	state,
	sidecarReady,
	adding,
	onAdd,
	onChanged,
	onSignOutAll,
}: {
	provider: ProviderInfo;
	state: ProviderAccountsState;
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
	const { result, error, loading, load } = state;
	const [pendingRemove, setPendingRemove] = useState<ProviderAccount | null>(null);
	const [removing, setRemoving] = useState<number | null>(null);
	const accounts = result?.accounts ?? [];
	const now = useNowTick(accounts.length > 0);

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
				message: t("providers.accounts.removed", { account: account.label, provider: provider.name }),
			});
			await Promise.allSettled([onChanged(), load()]);
		} catch (cause) {
			toastError({ title: t("providers.accounts.removeFailed"), error: cause });
		} finally {
			setRemoving(null);
		}
	};

	const refresh: ContextMenuItem = {
		id: "refresh",
		label: t("providers.accounts.refresh", { provider: provider.name }),
		icon: RefreshCw,
		disabled: !sidecarReady,
		onSelect: () => void load({ refresh: true }),
	};
	const addAccount: ContextMenuItem = {
		id: "add",
		label: t("providers.accounts.add"),
		icon: UserPlus,
		disabled: !sidecarReady || adding,
		onSelect: onAdd,
	};
	const signOutAll: ContextMenuItem = {
		id: "sign-out-all",
		label: t("providers.logoutAll"),
		icon: Trash2,
		danger: true,
		disabled: !sidecarReady,
		onSelect: onSignOutAll,
	};

	if (accounts.length === 0) {
		return (
			<ConnectedRow
				account={error ? error.message : undefined}
				busy={loading && result === null}
				menu={[refresh, addAccount]}
				provider={provider}
			/>
		);
	}
	return (
		<>
			{accounts.map(account => (
				<ConnectedRow
					account={account.label}
					accountTitle={account.detail}
					badges={
						<>
							{account.inUse && <Badge variant="success">{t("providers.accounts.inUse")}</Badge>}
							{account.state === "depleted" && (
								<Badge variant="warning">
									{account.limitedUntil !== undefined
										? t("providers.accounts.limitedUntil", { time: formatClock(account.limitedUntil) })
										: t("providers.accounts.limited")}
								</Badge>
							)}
							{account.state === "reserve" && <Badge variant="warning">{t("providers.accounts.low")}</Badge>}
						</>
					}
					below={
						account.resetPasses && (
							<ResetPassControl
								account={account.label}
								credentialId={account.credentialId}
								disabled={!sidecarReady}
								limits={account.limits}
								onRedeemed={async (): Promise<readonly UsageLimit[] | undefined> =>
									(await load())?.accounts.find(entry => entry.credentialId === account.credentialId)?.limits
								}
								passes={account.resetPasses}
								providerId={provider.id}
								providerName={provider.name}
							/>
						)
					}
					busy={removing === account.credentialId}
					key={account.credentialId}
					menu={[
						refresh,
						addAccount,
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
							separatorBefore: true,
							disabled: !sidecarReady || removing !== null,
							onSelect: () => setPendingRemove(account),
						},
						...(accounts.length > 1 ? [signOutAll] : []),
					]}
					provider={provider}
					quota={<QuotaCell account={account} now={now} />}
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
			<ConfirmDialog
				busy={pendingRemove !== null && removing === pendingRemove.credentialId}
				confirmLabel={t("providers.accounts.removeConfirm")}
				message={
					accounts.length > 1
						? t("providers.accounts.removeBody", { account: pendingRemove?.label ?? "", provider: provider.name })
						: t("providers.accounts.removeLastBody", {
								account: pendingRemove?.label ?? "",
								provider: provider.name,
							})
				}
				onCancel={() => setPendingRemove(null)}
				onConfirm={() => {
					if (pendingRemove) void remove(pendingRemove);
				}}
				open={pendingRemove !== null}
				title={t("providers.accounts.removeTitle")}
			/>
		</>
	);
}
