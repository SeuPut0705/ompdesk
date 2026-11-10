/**
 * An account's saved rate-limit resets ("reset passes", stock's saved resets):
 * one compact button, a ticket and the count (the owner's call, 10 Nov 2026:
 * no words on the row), whose tooltip says how many, how many are usable now
 * and the soonest expiry. It explains what one resets and that it spends a
 * pass, then spends it through the tab's omp (`redeem_reset_pass`: stock's
 * `/usage reset` path, on the host for a paired host's tab). Settings › Models
 * & accounts (ProviderAccounts) and Insights › Usage (UsageQuotas) show the
 * same control.
 *
 * Manual eligibility follows stock toResetUsageAccounts. Stock redeemResetCredit
 * decides whether there is anything to reset; automatic exhaustion policy is separate.
 */

import { Ticket } from "lucide-react";
import { useState } from "react";
import type { ResetPasses, ResetPassRedeemResult, UsageLimit } from "../../../../shared/rpc-types";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { usageLimitLabel } from "../../../lib/usage-labels";
import { toast, toastError } from "../../../stores/toast";
import { Button, ConfirmDialog } from "../../common";

type TFn = (key: string, params?: Record<string, string | number>) => string;

/** Localized names of the normalized limit ids stock's resets name (`formatUsageResetWindow`). */
const WINDOW_KEYS: Record<string, string> = {
	"anthropic:5h": "resetPasses.window.5h",
	"anthropic:7d": "resetPasses.window.7d",
	"anthropic:7d:opus": "resetPasses.window.7dOpus",
	"anthropic:7d:sonnet": "resetPasses.window.7dSonnet",
	"anthropic:reset:seven_day_overage_included": "resetPasses.window.7dOverage",
};

/** Refusals and outcomes with their own sentence; anything else shows stock's. */
const OUTCOME_KEYS: Record<string, string> = {
	not_redeemable: "resetPasses.outcome.notRedeemable",
	// Stock's own word for the same refusal (a Claude redeem is checked by stock alone).
	ineligible: "resetPasses.outcome.notRedeemable",
	offer_changed: "resetPasses.outcome.offerChanged",
	nothing_to_reset: "resetPasses.outcome.nothingToReset",
	already_redeemed: "resetPasses.outcome.alreadyRedeemed",
	no_credit: "resetPasses.outcome.noCredit",
	credit_list_failed: "resetPasses.outcome.listFailed",
	account_unavailable: "resetPasses.outcome.accountUnavailable",
	reset_in_progress: "resetPasses.outcome.inProgress",
	reset_unconfirmed: "resetPasses.outcome.unconfirmed",
	network_error: "resetPasses.outcome.unconfirmed",
	malformed_response: "resetPasses.outcome.unconfirmed",
};

/** "2 reset passes · expires 10/12" (month/day, the soonest pass). */
export function resetPassSummary(passes: ResetPasses, t: TFn): string {
	const parts = [passes.count === 1 ? t("resetPasses.countOne") : t("resetPasses.count", { count: passes.count })];
	if (passes.usableCount !== passes.count) parts.push(t("resetPasses.usableNow", { count: passes.usableCount }));
	if (passes.expiresAt !== undefined) {
		const date = new Date(passes.expiresAt);
		parts.push(t("resetPasses.expires", { date: `${date.getMonth() + 1}/${date.getDate()}` }));
	}
	return parts.join(" · ");
}

/** What one pass resets, by name: the account's own limit titles where the provider's names are unknown. */
function windowsText(passes: ResetPasses, limits: readonly UsageLimit[], t: TFn): string {
	if (passes.clears.length === 0) return t("resetPasses.windowsAll");
	return passes.clears
		.map(id => {
			if (WINDOW_KEYS[id]) return t(WINDOW_KEYS[id]);
			const limit = limits.find(entry => entry.id === id);
			return limit ? usageLimitLabel(limit, t) : id;
		})
		.join(", ");
}

export function ResetPassControl({
	providerId,
	providerName,
	credentialId,
	account,
	passes,
	limits,
	disabled,
	onRedeemed,
}: {
	/** Login or credential provider id (the bridge maps one to the other). */
	providerId: string;
	providerName: string;
	credentialId: number;
	/** The account's label. */
	account: string;
	passes: ResetPasses;
	limits: readonly UsageLimit[];
	/** omp is not connected. */
	disabled: boolean;
	/** Re-reads the quotas after a spend; resolves to the account's refreshed limits. */
	onRedeemed: () => Promise<readonly UsageLimit[] | undefined>;
}) {
	const t = useT();
	const tabRpc = useTabRpc();
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const hint = passes.redeemable
		? undefined
		: t("resetPasses.unavailable", { reason: passes.unavailableReason ?? t("resetPasses.unavailableUnknown") });

	const redeem = async () => {
		setBusy(true);
		try {
			const response = await tabRpc.redeemResetPass(providerId, credentialId, passes.creditId);
			if (!response.success) {
				toastError({ title: t("resetPasses.failed"), error: response });
				return;
			}
			const result = response.data as ResetPassRedeemResult;
			if (!result.ok) {
				const key = OUTCOME_KEYS[result.code];
				const sentence = key ? t(key) : result.message;
				toastError({
					title: t("resetPasses.failed"),
					error: result.reason ? `${sentence} (${result.reason})` : sentence,
					variant: "warning",
				});
				return;
			}
			const refreshed = await onRedeemed().catch(() => undefined);
			const quota = (refreshed ?? [])
				.filter(limit => limit.usedFraction !== undefined)
				.map(limit =>
					t("providers.accounts.windowLeft", {
						window: usageLimitLabel(limit, t),
						percent: Math.round(Math.max(0, Math.min(1, limit.usedFraction ?? 0)) * 100),
					}),
				)
				.join(" · ");
			toast({
				variant: "success",
				title: t("resetPasses.done", { account }),
				message: quota ? t("resetPasses.doneQuota", { quota }) : t("resetPasses.doneNoQuota"),
			});
		} catch (cause) {
			toastError({ title: t("resetPasses.failed"), error: cause });
		} finally {
			setBusy(false);
			setConfirming(false);
		}
	};

	return (
		<span className="inline-flex min-w-0 items-center" data-reset-passes={credentialId}>
			<Button
				aria-label={t("resetPasses.useFor", { account })}
				disabled={disabled || busy || !passes.redeemable}
				icon={<Ticket />}
				loading={busy}
				onClick={() => setConfirming(true)}
				size="sm"
				title={[resetPassSummary(passes, t), hint].filter(Boolean).join("\n")}
				variant="secondary"
			>
				<span className="tabular-nums" data-reset-pass-count>
					{passes.count}
				</span>
			</Button>
			<ConfirmDialog
				busy={busy}
				confirmLabel={t("resetPasses.use")}
				message={[
					t("resetPasses.confirmSpend", { account, provider: providerName, count: passes.count }),
					t("resetPasses.confirmResets", { windows: windowsText(passes, limits, t) }),
					...(passes.title ? [t("resetPasses.confirmPass", { title: passes.title })] : []),
					...(passes.early ? [t("resetPasses.confirmEarly")] : []),
					t("resetPasses.autoRedeem"),
				].join("\n\n")}
				onCancel={() => setConfirming(false)}
				onConfirm={() => void redeem()}
				open={confirming}
				title={t("resetPasses.confirmTitle")}
				warning={t("resetPasses.confirmWarning")}
			/>
		</span>
	);
}
