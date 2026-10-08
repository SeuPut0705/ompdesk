/**
 * Every stored sign-in of one connected subscription provider, under its row
 * in Settings › Models & providers: each account's remaining quota, the one
 * this tab's session is using, and the ones omp is skipping after they hit a
 * limit. omp itself picks between the accounts by the quota each has left;
 * this list only shows that and adds or removes accounts. "Add another
 * account" is the same sign-in flow (a different identity adds a row); remove
 * logs out that one credential, and the last one disconnects the provider.
 */

import { Trash2, UserPlus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderAccount, ProviderAccountsResult, ProviderInfo } from "../../../../shared/rpc-types";
import { type InlineFailure, inlineFailure } from "../../../lib/error-detail";
import { formatClock } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { toast, toastError } from "../../../stores/toast";
import { Badge, Banner, Button, ConfirmDialog, ErrorDetail, IconButton, Spinner } from "../../common";

type TFn = (key: string, params?: Record<string, string | number>) => string;

const percent = (fraction: number) => Math.round(Math.max(0, Math.min(1, fraction)) * 100);

/** Remaining share per window when the report has windows, else the tightest window's remainder. */
function quotaText(account: ProviderAccount, t: TFn): string | null {
	const windows = account.limits.filter(limit => limit.usedFraction !== undefined);
	if (windows.length > 0) {
		return windows
			.map(limit =>
				t("providers.accounts.windowLeft", {
					window: limit.label,
					percent: percent(1 - (limit.usedFraction ?? 0)),
				}),
			)
			.join(" · ");
	}
	return account.remainingFraction === undefined
		? null
		: t("providers.accounts.remaining", { percent: percent(account.remainingFraction) });
}

function AccountRow({
	account,
	busy,
	disabled,
	onRemove,
}: {
	account: ProviderAccount;
	busy: boolean;
	disabled: boolean;
	onRemove: () => void;
}) {
	const t = useT();
	const quota = quotaText(account, t);
	return (
		<li className="flex items-center gap-2 py-1.5">
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="flex min-w-0 flex-wrap items-center gap-1.5">
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
				{quota && <span className="text-sc-xs tabular-nums text-(--sc-text-muted)">{quota}</span>}
			</div>
			{busy ? (
				<Spinner size="sm" />
			) : (
				<IconButton
					disabled={disabled}
					icon={<Trash2 />}
					label={t("providers.accounts.remove", { account: account.label })}
					onClick={onRemove}
					size="sm"
				/>
			)}
		</li>
	);
}

export function ProviderAccounts({
	provider,
	revision,
	sidecarReady,
	adding,
	onAdd,
	onChanged,
}: {
	provider: ProviderInfo;
	/** Bumped after a sign-in or sign-out elsewhere on the page: read the accounts again. */
	revision: number;
	sidecarReady: boolean;
	/** A sign-in for this provider is in flight. */
	adding: boolean;
	onAdd: () => void;
	/** After an account is removed: the provider row may no longer be connected. */
	onChanged: () => Promise<unknown>;
}) {
	const t = useT();
	const tabRpc = useTabRpc();
	const [result, setResult] = useState<ProviderAccountsResult | null>(null);
	const [error, setError] = useState<InlineFailure | null>(null);
	const [loading, setLoading] = useState(false);
	const [pendingRemove, setPendingRemove] = useState<ProviderAccount | null>(null);
	const [removing, setRemoving] = useState<number | null>(null);
	const requestVersion = useRef(0);

	const load = useCallback(async () => {
		const version = ++requestVersion.current;
		setLoading(true);
		try {
			const response = await tabRpc.getProviderAccounts(provider.id);
			if (version !== requestVersion.current) return;
			if (!response.success) {
				setError(inlineFailure(response, t("providers.accounts.loadFailed")));
				return;
			}
			setError(null);
			setResult(response.data as ProviderAccountsResult);
		} catch (cause) {
			if (version === requestVersion.current) setError(inlineFailure(cause, t("providers.accounts.loadFailed")));
		} finally {
			if (version === requestVersion.current) setLoading(false);
		}
	}, [provider.id, t, tabRpc]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is the re-read signal.
	useEffect(() => {
		if (sidecarReady) void load();
	}, [load, revision, sidecarReady]);

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
		<section aria-label={t("providers.accounts.label", { provider: provider.name })} className="pr-2.5 pb-2 pl-9">
			{error && (
				<Banner title={error.message} variant="danger">
					<ErrorDetail error={error.cause} />
				</Banner>
			)}
			{loading && result === null && !error ? (
				<Spinner label={t("common.loading")} size="sm" />
			) : (
				accounts.length > 0 && (
					<ul className="flex flex-col divide-y divide-(--sc-divider)">
						{accounts.map(account => (
							<AccountRow
								account={account}
								busy={removing === account.credentialId}
								disabled={!sidecarReady || removing !== null}
								key={account.credentialId}
								onRemove={() => setPendingRemove(account)}
							/>
						))}
					</ul>
				)
			)}
			{result?.usageError && (
				<p className="text-sc-xs text-(--sc-text-muted)">{t("providers.accounts.quotaUnavailable")}</p>
			)}
			<div className="mt-1 flex flex-col items-start gap-1">
				<Button
					disabled={!sidecarReady || adding}
					icon={<UserPlus />}
					onClick={onAdd}
					size="sm"
					title={sidecarReady ? undefined : t("providers.notConnected")}
					variant="ghost"
				>
					{t("providers.accounts.add")}
				</Button>
				<p className="text-sc-xs text-(--sc-text-muted)">{t("providers.accounts.rotation")}</p>
			</div>
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
