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
 *
 * An account that holds more than one kind of pass (`passes.tickets`: a Claude Fable reset and a full reset) lists
 * them in that dialog, one card per kind, and spends the one picked.
 *
 * The dialog describes and spends the passes it was opened on, never the live ones: the accounts are read again on
 * usage polls, and a pass that took another's place under an open dialog must not be the one Confirm spends. When a
 * pass the dialog offers leaves the account's offer, the dialog closes and says the offer changed.
 */

import { Hourglass, Ticket } from "lucide-react";
import { useEffect, useState } from "react";
import type { ResetPasses, ResetPassRedeemResult, ResetTicket, UsageLimit } from "../../../../shared/rpc-types";
import { formatSpanCompact } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { usageLimitLabel } from "../../../lib/usage-labels";
import { toast, toastError } from "../../../stores/toast";
import { Button, ChoiceCards, ConfirmDialog, Tooltip } from "../../common";

type TFn = (key: string, params?: Record<string, string | number>) => string;

const DAY_MS = 24 * 60 * 60_000;

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
	// The provider's own answers to a claim OMPdesk sent for a picked pass (pi-ai `consumeClaudeResetCredit`).
	unavailable: "resetPasses.outcome.unconfirmed",
	cooldown: "resetPasses.outcome.notRedeemable",
	auth_error: "resetPasses.outcome.accountUnavailable",
};

/** "2 reset passes · expires 10/12" (month/day, the soonest pass); `usable` between them when it differs. */
function countAndExpiry(count: number, expiresAt: number | undefined, t: TFn, usable = count): string {
	const parts = [count === 1 ? t("resetPasses.countOne") : t("resetPasses.count", { count })];
	if (usable !== count) parts.push(t("resetPasses.usableNow", { count: usable }));
	if (expiresAt !== undefined) {
		const date = new Date(expiresAt);
		parts.push(t("resetPasses.expires", { date: `${date.getMonth() + 1}/${date.getDate()}` }));
	}
	return parts.join(" · ");
}

export function resetPassSummary(passes: ResetPasses, t: TFn): string {
	return countAndExpiry(passes.count, passes.expiresAt, t, passes.usableCount);
}

/** What one pass resets, by name: the account's own limit titles where the provider's names are unknown. */
function windowsText(clears: readonly string[], limits: readonly UsageLimit[], t: TFn): string {
	if (clears.length === 0) return t("resetPasses.windowsAll");
	return clears
		.map(id => {
			if (WINDOW_KEYS[id]) return t(WINDOW_KEYS[id]);
			const limit = limits.find(entry => entry.id === id);
			return limit ? usageLimitLabel(limit, t) : id;
		})
		.join(", ");
}

/** A ticket's name among an account's tickets: what it resets, which is what makes it a kind. */
const ticketKind = (ticket: ResetTicket): string => [...ticket.clears].sort().join(" ");

/** The passes an account's offer names: the one stock spends next and each kind's. */
const passIds = (passes: ResetPasses): string[] =>
	[passes.creditId, ...(passes.tickets ?? []).map(ticket => ticket.creditId)].filter(id => id !== undefined);

export function ResetPassControl({
	providerId,
	providerName,
	credentialId,
	account,
	passes,
	limits,
	disabled,
	onRedeemed,
	expiry = false,
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
	/**
	 * Under the ticket, the time left until the soonest pass expires, on the line and in the type of a gauge's
	 * reset beside it (the accounts list; the owner's call, 10 Nov 2026). Whole days from two days on: a pass
	 * lasts months, and the slot is narrow.
	 */
	expiry?: boolean;
}) {
	const t = useT();
	const tabRpc = useTabRpc();
	/** The passes the open dialog was opened on; none while it is closed. */
	const [shown, setShown] = useState<ResetPasses>();
	const [busy, setBusy] = useState(false);
	/** The kind picked in the dialog; none picked means the first one that can be spent. */
	const [pick, setPick] = useState<string>();
	const hint = passes.redeemable
		? undefined
		: t("resetPasses.unavailable", { reason: passes.unavailableReason ?? t("resetPasses.unavailableUnknown") });
	const view = shown ?? passes;
	const tickets = view.tickets ?? [];
	const offered = tickets.filter(ticket => ticket.creditId !== undefined);
	const chosen =
		offered.find(ticket => ticketKind(ticket) === pick) ??
		offered.find(ticket => ticket.creditId === view.creditId) ??
		offered[0];
	/** The pass a confirm spends and describes: the chosen kind's, else the one stock spends by itself. */
	const spent = chosen ?? view;

	// A spend under way changes the offer itself; its own result reports it.
	const changed = shown !== undefined && !busy && passIds(shown).some(id => !passIds(passes).includes(id));
	useEffect(() => {
		if (!changed) return;
		setShown(undefined);
		toastError({
			title: t("resetPasses.failed"),
			error: t("resetPasses.outcome.offerChanged"),
			variant: "warning",
		});
	}, [changed, t]);

	const redeem = async () => {
		setBusy(true);
		try {
			const response = await tabRpc.redeemResetPass(providerId, credentialId, spent.creditId);
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
			setShown(undefined);
		}
	};

	const expiresAt = expiry ? passes.expiresAt : undefined;
	const expiresDate = expiresAt === undefined ? undefined : new Date(expiresAt);
	const expiresText =
		expiresDate && t("resetPasses.expires", { date: `${expiresDate.getMonth() + 1}/${expiresDate.getDate()}` });
	const left = expiresAt === undefined ? 0 : Math.max(0, expiresAt - Date.now());

	const summary = [resetPassSummary(passes, t), hint].filter(Boolean).join("\n");
	const inert = disabled || busy || !passes.redeemable;
	const passButton = (
		<Button
			aria-label={t("resetPasses.useFor", { account })}
			disabled={inert}
			disabledReason={summary}
			icon={<Ticket />}
			loading={busy}
			onClick={() => {
				setPick(undefined);
				setShown(passes);
			}}
			size="sm"
			variant="secondary"
		>
			<span className="tabular-nums" data-reset-pass-count>
				{passes.count}
			</span>
		</Button>
	);

	return (
		<span className="inline-flex min-w-0 flex-col items-end" data-reset-passes={credentialId}>
			{inert && !busy ? passButton : <Tooltip content={summary}>{passButton}</Tooltip>}
			{expiresAt !== undefined && (
				<span
					aria-label={expiresText}
					className="omp-usage-gauge-reset inline-flex items-center gap-0.5"
					data-reset-pass-expiry
					role="img"
					title={expiresText}
				>
					<Hourglass aria-hidden className="size-[0.85em] shrink-0" />
					{left >= 2 * DAY_MS ? `${Math.floor(left / DAY_MS)}d` : formatSpanCompact(left)}
				</span>
			)}
			<ConfirmDialog
				busy={busy}
				confirmLabel={t("resetPasses.use")}
				message={
					<>
						{t("resetPasses.confirmSpend", { account, provider: providerName, count: view.count })}
						{tickets.length > 0 ? (
							<div className="my-3 whitespace-normal" data-reset-tickets>
								<ChoiceCards
									aria-label={t("resetPasses.choose")}
									className="grid-cols-1"
									disabled={busy}
									onChange={setPick}
									optionAttr="data-reset-ticket"
									options={tickets.map(ticket => ({
										value: ticketKind(ticket),
										icon: <Ticket aria-hidden className="size-3.5 shrink-0" />,
										title: windowsText(ticket.clears, limits, t),
										hint: [ticket.title, countAndExpiry(ticket.count, ticket.expiresAt, t)]
											.filter(Boolean)
											.join(" · "),
										disabled: ticket.creditId === undefined,
									}))}
									value={chosen ? ticketKind(chosen) : null}
								/>
								{offered.length < tickets.length && (
									<p className="mt-1.5 text-sc-xs text-(--sc-text-muted)" data-reset-tickets-paused>
										{t("resetPasses.choosePaused")}
									</p>
								)}
							</div>
						) : (
							"\n\n"
						)}
						{[
							t("resetPasses.confirmResets", { windows: windowsText(spent.clears, limits, t) }),
							// A card already carries its pass's name.
							...(spent.title && tickets.length === 0
								? [t("resetPasses.confirmPass", { title: spent.title })]
								: []),
							...(spent.early ? [t("resetPasses.confirmEarly")] : []),
							t("resetPasses.autoRedeem"),
						].join("\n\n")}
					</>
				}
				onCancel={() => setShown(undefined)}
				onConfirm={() => void redeem()}
				open={shown !== undefined}
				title={t("resetPasses.confirmTitle")}
				warning={t("resetPasses.confirmWarning")}
			/>
		</span>
	);
}
