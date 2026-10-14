/**
 * Every stored sign-in of one connected subscription provider, expanded under
 * its row in Settings › Models & providers: each account's remaining quota
 * per window as a bar, the one this tab's session is using, and the ones omp
 * is skipping after they hit a limit. omp itself picks between the accounts;
 * this list only shows that and adds or removes accounts. "Add another
 * account" is the same sign-in flow (a different identity adds a row);
 * remove logs out that one credential, and the last one disconnects the
 * provider. The read lives in `useProviderAccounts`, owned by the provider
 * row, so the collapsed row can name the account count. On omp 18.8.1+ each
 * account with an identity key offers to copy it (the name
 * `task.agentAccountPools` matches; see AccountPoolsEditor). An account with
 * saved rate-limit resets shows them and can spend one (ResetPasses.tsx).
 */

import { Copy, RefreshCw, Trash2, UserPlus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderAccount, ProviderAccountsResult, ProviderInfo, UsageLimit } from "../../../../shared/rpc-types";
import { type InlineFailure, inlineFailure } from "../../../lib/error-detail";
import { copyText, formatClock } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { usageLimitLabel } from "../../../lib/usage-labels";
import { toast, toastError } from "../../../stores/toast";
import { Badge, Button, ConfirmDialog, IconButton, ProgressBar, Spinner } from "../../common";
import { InlineNotice } from "../InlineNotice";
import { ResetPassControl } from "./ResetPasses";

type TFn = (key: string, params?: Record<string, string | number>) => string;

const percent = (fraction: number) => Math.round(Math.max(0, Math.min(1, fraction)) * 100);

/** One quota bar: a window's used share, labelled by what is left. */
interface QuotaWindow {
	key: string;
	label: string;
	used: number;
}

/** Per-window used share when the report has windows, else the tightest window's remainder. */
function quotaWindows(account: ProviderAccount, t: TFn): QuotaWindow[] {
	const windows = account.limits.filter(limit => limit.usedFraction !== undefined);
	if (windows.length > 0) {
		return windows.map(limit => {
			const used = limit.usedFraction ?? 0;
			return {
				key: limit.id,
				label: t("providers.accounts.windowLeft", {
					window: usageLimitLabel(limit, t),
					percent: percent(1 - used),
				}),
				used,
			};
		});
	}
	if (account.remainingFraction === undefined) return [];
	return [
		{
			key: "remaining",
			label: t("providers.accounts.remaining", { percent: percent(account.remainingFraction) }),
			used: 1 - account.remainingFraction,
		},
	];
}

export interface ProviderAccountsState {
	result: ProviderAccountsResult | null;
	error: InlineFailure | null;
	loading: boolean;
	/** Re-reads the accounts; resolves to the new result, `null` when the read failed or a newer one superseded it. */
	load: () => Promise<ProviderAccountsResult | null>;
}

/**
 * The stored accounts of one provider. Reads while `enabled` (connected, lists
 * accounts, omp ready) and again whenever `revision` changes: a sign-in or
 * sign-out elsewhere on the page.
 */
export function useProviderAccounts(providerId: string, enabled: boolean, revision: number): ProviderAccountsState {
	const t = useT();
	const tabRpc = useTabRpc();
	const [result, setResult] = useState<ProviderAccountsResult | null>(null);
	const [error, setError] = useState<InlineFailure | null>(null);
	const [loading, setLoading] = useState(false);
	const requestVersion = useRef(0);

	const load = useCallback(async (): Promise<ProviderAccountsResult | null> => {
		const version = ++requestVersion.current;
		setLoading(true);
		try {
			const response = await tabRpc.getProviderAccounts(providerId);
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
	}, [providerId, t, tabRpc]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is the re-read signal.
	useEffect(() => {
		if (enabled) void load();
	}, [enabled, load, revision]);

	return { result, error, loading, load };
}

function AccountRow({
	provider,
	account,
	busy,
	disabled,
	sidecarReady,
	onRemove,
	onRedeemed,
}: {
	provider: ProviderInfo;
	account: ProviderAccount;
	busy: boolean;
	disabled: boolean;
	sidecarReady: boolean;
	onRemove: () => void;
	/** After a reset pass is spent: re-reads the accounts, resolving to this account's limits. */
	onRedeemed: () => Promise<readonly UsageLimit[] | undefined>;
}) {
	const t = useT();
	const windows = quotaWindows(account, t);
	return (
		<li className="flex items-start gap-2 py-2">
			<div className="flex min-w-0 flex-1 flex-col gap-1.5">
				<div className="flex min-h-6 min-w-0 flex-wrap items-center gap-1.5">
					<span className="min-w-0 truncate text-sc-sm text-(--sc-text)" title={account.detail}>
						{account.label}
					</span>
					{account.inUse && <Badge variant="success">{t("providers.accounts.inUse")}</Badge>}
					{account.state === "depleted" && (
						<Badge variant="warning">
							{account.limitedUntil !== undefined
								? t("providers.accounts.limitedUntil", { time: formatClock(account.limitedUntil) })
								: t("providers.accounts.limited")}
						</Badge>
					)}
					{account.state === "reserve" && <Badge variant="warning">{t("providers.accounts.low")}</Badge>}
				</div>
				{account.resetPasses && (
					<ResetPassControl
						account={account.label}
						credentialId={account.credentialId}
						disabled={!sidecarReady}
						limits={account.limits}
						onRedeemed={onRedeemed}
						passes={account.resetPasses}
						providerId={provider.id}
						providerName={provider.name}
					/>
				)}
				{windows.length > 0 && (
					<ul className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-x-4 gap-y-1.5">
						{windows.map(window => (
							<li className="flex min-w-0 flex-col gap-1" key={window.key}>
								<span className="truncate text-sc-xs tabular-nums text-(--sc-text-muted)">{window.label}</span>
								<ProgressBar ariaLabel={window.label} height={4} value={window.used} valueText="" />
							</li>
						))}
					</ul>
				)}
			</div>
			{busy ? (
				<span className="flex size-(--sc-control-sm) items-center justify-center">
					<Spinner size="sm" />
				</span>
			) : (
				<>
					{typeof account.identityKey === "string" && (
						<IconButton
							icon={<Copy />}
							label={t("providers.accounts.copyKey", { account: account.label })}
							onClick={() => {
								// Token-free: the key is the pool name `omp usage accounts` prints.
								const key = account.identityKey;
								if (typeof key !== "string") return;
								void copyText(key).then(ok =>
									toast(
										ok
											? { variant: "success", message: t("providers.accounts.keyCopied") }
											: { variant: "error", message: t("providers.accounts.keyCopyFailed") },
									),
								);
							}}
							size="sm"
						/>
					)}
					<IconButton
						disabled={disabled}
						icon={<Trash2 />}
						label={t("providers.accounts.remove", { account: account.label })}
						onClick={onRemove}
						size="sm"
					/>
				</>
			)}
		</li>
	);
}

export function ProviderAccounts({
	provider,
	state,
	sidecarReady,
	adding,
	onAdd,
	onChanged,
	id,
}: {
	provider: ProviderInfo;
	state: ProviderAccountsState;
	sidecarReady: boolean;
	/** A sign-in for this provider is in flight. */
	adding: boolean;
	onAdd: () => void;
	/** After an account is removed: the provider row may no longer be connected. */
	onChanged: () => Promise<unknown>;
	/** The disclosure's `aria-controls` target. */
	id?: string;
}) {
	const t = useT();
	const tabRpc = useTabRpc();
	const { result, error, loading, load } = state;
	const [pendingRemove, setPendingRemove] = useState<ProviderAccount | null>(null);
	const [removing, setRemoving] = useState<number | null>(null);
	const accounts = result?.accounts ?? [];

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

	return (
		<section
			aria-label={t("providers.accounts.label", { provider: provider.name })}
			className="pr-2.5 pb-2 pl-9"
			id={id}
		>
			{error && (
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
			)}
			{loading && result === null && !error ? (
				<div className="py-2">
					<Spinner label={t("common.loading")} size="sm" />
				</div>
			) : (
				accounts.length > 0 && (
					<ul className="flex flex-col divide-y divide-(--sc-divider)">
						{accounts.map(account => (
							<AccountRow
								account={account}
								busy={removing === account.credentialId}
								disabled={!sidecarReady || removing !== null}
								key={account.credentialId}
								onRedeemed={async () =>
									(await load())?.accounts.find(entry => entry.credentialId === account.credentialId)?.limits
								}
								onRemove={() => setPendingRemove(account)}
								provider={provider}
								sidecarReady={sidecarReady}
							/>
						))}
					</ul>
				)
			)}
			{result?.usageError && <InlineNotice title={t("providers.accounts.quotaUnavailable")} tone="info" />}
			<Button
				className="-ml-2"
				disabled={!sidecarReady || adding}
				icon={<UserPlus />}
				onClick={onAdd}
				size="sm"
				title={sidecarReady ? undefined : t("providers.notConnected")}
				variant="ghost"
			>
				{t("providers.accounts.add")}
			</Button>
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
		</section>
	);
}
