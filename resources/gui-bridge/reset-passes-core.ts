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
}

/** The selector, not GUI quota heuristics, determines whether manual redemption is offered. */
export function shapeResetPasses(account: ResetUsageAccount | undefined): ResetPasses | undefined {
	if (!account || account.availableCount <= 0) return undefined;
	const expiresAt = account.expiresAt ? Date.parse(account.expiresAt) : Number.NaN;
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
	reason?: string;
	cleared?: string[];
	creditId?: string;
}

/** The stock calls a redeem makes; reset-passes.ts binds them to the live session. */
export interface ResetPassSurface {
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

/** Refresh the stock offer and refuse a changed confirmation before stock redeems it. */
export async function redeemResetPass(surface: ResetPassSurface, request: RedeemRequest): Promise<RedeemResult> {
	const { provider, credentialId } = request;
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
		return refusal(
			"offer_changed",
			`${label}: the reset offer changed — nothing was spent; check it and try again.`,
		);
	}
	const outcome = await surface.redeem(account.target);
	return {
		ok: outcome.ok,
		code: outcome.code,
		message: surface.describe(outcome, label),
		...(outcome.reason ? { reason: outcome.reason } : {}),
		...(outcome.cleared?.length ? { cleared: outcome.cleared } : {}),
	};
}
