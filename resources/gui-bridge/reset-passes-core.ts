/** Thin GUI wire projection of stock toResetUsageAccounts, plus confirmation binding. */

/** Stock `UsageResetCreditDetail`, the fields used here. */
export interface ResetCreditDetail {
	id?: string;
	title?: string;
	program?: string;
	remainingCount?: number;
	usable?: boolean;
	requiresLimit?: boolean;
	clears?: string[];
	expiresAt?: string;
	status?: string;
}

/** Stock `UsageResetCredits`, the fields used here. */
export interface ResetCreditsInfo {
	availableCount: number;
	redeemableCount?: number;
	nextCreditId?: string;
	eligible?: boolean;
	reason?: string;
	cooldownUntil?: string;
	credits?: ResetCreditDetail[];
}

/** Wire shape: `ResetTicket` in src/shared/rpc-types.ts. */
export interface ResetTicket {
	clears: string[];
	title?: string;
	count: number;
	expiresAt?: number;
	early: boolean;
	creditId?: string;
}

/** Wire shape: `ResetPasses` in src/shared/rpc-types.ts. */
export interface ResetPasses {
	count: number;
	usableCount: number;
	expiresAt?: number;
	title?: string;
	clears: string[];
	early: boolean;
	creditId?: string;
	redeemable: boolean;
	unavailableReason?: string;
	tickets?: ResetTicket[];
}

const expiryMs = (credit: ResetCreditDetail): number => {
	const at = credit.expiresAt ? Date.parse(credit.expiresAt) : Number.NaN;
	return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
};

/**
 * The account's passes by kind: what one resets tells kinds apart (a Claude Fable reset and a full reset), and passes
 * that reset the same limits are one ticket with their count and soonest expiry. A ticket names a pass (`creditId`)
 * only where stock marks one of its kind usable now: stock decides what can be spent, never this list. Stock's Claude
 * redeem spends the one grant Claude names next (pi-ai auth/resets.ts: any other id is `offer_changed`), so that is
 * the only ticket with a pass to spend until stock takes a chosen grant.
 */
export function resetTickets(credits: readonly ResetCreditDetail[]): ResetTicket[] {
	const kinds = new Map<string, ResetCreditDetail[]>();
	for (const credit of credits) {
		if (credit.status === "expired" || credit.status === "redeemed" || (credit.remainingCount ?? 1) <= 0) continue;
		const kind = [...(credit.clears ?? [])].sort().join(" ");
		kinds.set(kind, [...(kinds.get(kind) ?? []), credit]);
	}
	return [...kinds.values()]
		.map((passes): ResetTicket => {
			const soonest = passes.reduce((first, pass) => (expiryMs(pass) < expiryMs(first) ? pass : first));
			const spendable = passes.find(pass => pass.usable === true && pass.id);
			const shown = spendable ?? soonest;
			return {
				clears: shown.clears ?? [],
				...(shown.title ? { title: shown.title } : {}),
				count: passes.reduce((sum, pass) => sum + (pass.remainingCount ?? 1), 0),
				...(Number.isFinite(expiryMs(soonest)) ? { expiresAt: expiryMs(soonest) } : {}),
				early: shown.requiresLimit === false,
				...(spendable?.id ? { creditId: spendable.id } : {}),
			};
		})
		.sort(
			(a, b) =>
				Number(b.creditId !== undefined) - Number(a.creditId !== undefined) ||
				(a.expiresAt ?? Number.POSITIVE_INFINITY) - (b.expiresAt ?? Number.POSITIVE_INFINITY),
		);
}

/**
 * The selector, not GUI quota heuristics, determines whether manual redemption is offered. `credits` is the account's
 * whole list (the selector row carries only the next one): more than one kind among them becomes `tickets`.
 */
export function shapeResetPasses(
	account: ResetUsageAccount | undefined,
	credits: readonly ResetCreditDetail[] = [],
): ResetPasses | undefined {
	if (!account || account.availableCount <= 0) return undefined;
	const expiresAt = account.expiresAt ? Date.parse(account.expiresAt) : Number.NaN;
	const tickets = resetTickets(credits);
	return {
		count: account.availableCount,
		usableCount: account.redeemableCount,
		...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
		...(account.credit?.title ? { title: account.credit.title } : {}),
		clears: account.credit?.clears ?? [],
		early: account.credit?.requiresLimit === false,
		...(account.target.creditId ? { creditId: account.target.creditId } : {}),
		redeemable: !account.error && account.redeemableCount > 0,
		...(account.unavailableReason ? { unavailableReason: account.unavailableReason } : {}),
		...(tickets.length > 1 ? { tickets } : {}),
	};
}

// ============================================================================
// Redeem
// ============================================================================

/** Stock `ResetCreditTarget`. */
export interface ResetTarget {
	provider: string;
	credentialId: number;
	creditId?: string;
	accountId?: string;
	email?: string;
	orgId?: string;
}

/** Stock `ResetCreditAccountStatus`, the fields used here. */
export interface ResetAccountStatus extends ResetCreditsInfo {
	provider: string;
	credentialId: number;
	credits: ResetCreditDetail[];
	active: boolean;
	error?: string;
}

/** Stock `ResetUsageAccount` (`toResetUsageAccounts`), the fields used here. */
export interface ResetUsageAccount {
	label: string;
	target: ResetTarget;
	error?: string;
	availableCount: number;
	redeemableCount: number;
	unavailableReason?: string;
	expiresAt?: string;
	credit?: ResetCreditDetail;
}

/** Stock `ResetCreditRedeemOutcome`. */
export interface ResetRedeemOutcome {
	ok: boolean;
	code: string;
	provider?: string;
	/** The account stock resolved the target to. */
	email?: string;
	reason?: string;
	cleared?: string[];
	creditId?: string;
}

/** The stock calls a redeem makes; reset-passes.ts binds them to the live session. */
export interface ResetPassSurface {
	/**
	 * Stock's redeem for this provider reads the live offer itself and refuses a changed, ineligible or missing one
	 * before it spends (Claude). OMPdesk then lists nothing first: its own list read every account of the provider on
	 * the same endpoint for the same answer, and that endpoint is rate-limited per source IP.
	 */
	verifiesOffer(provider: string): boolean;
	/** `AgentSession.listResetCredits(undefined, provider)`: live offers of the provider's stored accounts. */
	list(provider: string): Promise<ResetAccountStatus[]>;
	/** Stock `toResetUsageAccounts`. */
	accounts(statuses: ResetAccountStatus[]): ResetUsageAccount[];
	/** `AgentSession.redeemResetCredit`. */
	redeem(target: ResetTarget): Promise<ResetRedeemOutcome>;
	/** Stock `describeRedeemOutcome`. */
	describe(outcome: ResetRedeemOutcome, label: string): string;
}

export interface RedeemRequest {
	/** Credential provider (`getOAuthCredentialProvider` of the login provider). */
	provider: string;
	credentialId: number;
	/** The pass the user confirmed; a different live pick is refused unspent. */
	creditId?: string;
}

/** Wire shape: `ResetPassRedeemResult` in src/shared/rpc-types.ts. */
export interface RedeemResult {
	ok: boolean;
	code: string;
	message: string;
	reason?: string;
	cleared?: string[];
}

const refusal = (code: string, message: string, reason?: string): RedeemResult => ({
	ok: false,
	code,
	message,
	...(reason ? { reason } : {}),
});

const outcomeResult = (surface: ResetPassSurface, outcome: ResetRedeemOutcome, label: string): RedeemResult => ({
	ok: outcome.ok,
	code: outcome.code,
	message: surface.describe(outcome, label),
	...(outcome.reason ? { reason: outcome.reason } : {}),
	...(outcome.cleared?.length ? { cleared: outcome.cleared } : {}),
});

/**
 * Spend the pass the user confirmed. Where stock's redeem checks the live offer itself, the confirmed pass goes
 * straight to it; elsewhere the offer is read here first and a changed confirmation is refused before stock redeems.
 */
export async function redeemResetPass(surface: ResetPassSurface, request: RedeemRequest): Promise<RedeemResult> {
	const { provider, credentialId } = request;
	if (surface.verifiesOffer(provider)) {
		const outcome = await surface.redeem({
			provider,
			credentialId,
			...(request.creditId ? { creditId: request.creditId } : {}),
		});
		return outcomeResult(surface, outcome, outcome.email ?? `#${credentialId}`);
	}
	const status = (await surface.list(provider)).find(candidate => candidate.credentialId === credentialId);
	if (!status) return refusal("no_account", `Could not find the stored account #${credentialId}.`);
	const account = surface.accounts([status])[0];
	const label = account?.label ?? `#${credentialId}`;
	if (!account || status.error) {
		return refusal(
			"credit_list_failed",
			`${label}: couldn't load this account's saved resets (network/auth) — nothing was spent, try again.`,
			status.error,
		);
	}
	const passes = shapeResetPasses(account);
	if (!passes || passes.usableCount <= 0) {
		const reason = passes?.unavailableReason;
		return refusal(
			passes ? "not_redeemable" : "no_credit",
			passes
				? `${label}: no saved resets usable right now${reason ? ` (${reason})` : ""}.`
				: `${label}: no saved resets available to spend.`,
			reason,
		);
	}
	if (request.creditId !== undefined && account.target.creditId !== request.creditId) {
		return refusal("offer_changed", `${label}: the reset offer changed — nothing was spent; check it and try again.`);
	}
	return outcomeResult(surface, await surface.redeem(account.target), label);
}
