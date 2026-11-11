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

/** A pass still there to spend: something left on it, not expired. */
const live = (credit: ResetCreditDetail): boolean =>
	credit.status !== "expired" && credit.status !== "redeemed" && (credit.remainingCount ?? 1) > 0;

/** A pass a person may pick: live, named, and not paused by the provider. Whether it applies now is the provider's answer. */
const choosable = (credit: ResetCreditDetail): credit is ResetCreditDetail & { id: string } =>
	live(credit) && credit.status !== "paused" && Boolean(credit.id);

/**
 * The account's passes by kind: what one resets tells kinds apart (a Claude Fable reset and a full reset), and passes
 * that reset the same limits are one ticket with their count and soonest expiry. A ticket names the pass a spend of
 * its kind takes (`creditId`): the one stock marks usable (the one the provider names next), else the kind's soonest
 * to expire that can be picked. A kind whose passes are all paused names none.
 */
export function resetTickets(credits: readonly ResetCreditDetail[]): ResetTicket[] {
	const kinds = new Map<string, ResetCreditDetail[]>();
	for (const credit of credits) {
		if (!live(credit)) continue;
		const kind = [...(credit.clears ?? [])].sort().join(" ");
		kinds.set(kind, [...(kinds.get(kind) ?? []), credit]);
	}
	const sooner = <Pass extends ResetCreditDetail>(first: Pass, pass: Pass): Pass =>
		expiryMs(pass) < expiryMs(first) ? pass : first;
	return [...kinds.values()]
		.map(passes => {
			const soonest = passes.reduce(sooner);
			const pickable = passes.filter(choosable);
			const next = pickable.find(pass => pass.usable === true);
			const spent = next ?? (pickable.length > 0 ? pickable.reduce(sooner) : undefined);
			const shown = spent ?? soonest;
			const ticket: ResetTicket = {
				clears: shown.clears ?? [],
				...(shown.title ? { title: shown.title } : {}),
				count: passes.reduce((sum, pass) => sum + (pass.remainingCount ?? 1), 0),
				...(Number.isFinite(expiryMs(soonest)) ? { expiresAt: expiryMs(soonest) } : {}),
				early: shown.requiresLimit === false,
				...(spent ? { creditId: spent.id } : {}),
			};
			// The kind the provider spends next leads, then those that can be picked, each by its soonest expiry.
			return { ticket, rank: next ? 0 : spent ? 1 : 2 };
		})
		.sort(
			(a, b) =>
				a.rank - b.rank ||
				(a.ticket.expiresAt ?? Number.POSITIVE_INFINITY) - (b.ticket.expiresAt ?? Number.POSITIVE_INFINITY),
		)
		.map(entry => entry.ticket);
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
	/**
	 * One stored account's live offer, read once, and the spend of one pass of it: pi-ai `listClaudeResetCredits` and
	 * `consumeClaudeResetCredit` over that account's access (`authStorage.oauth.accessById`). A code when the account
	 * is gone (`no_account`), cannot sign in (`account_unavailable`) or its offer cannot be read (`credit_list_failed`).
	 */
	account(provider: string, credentialId: number): Promise<ChosenAccount | { code: string }>;
	/** After a spend: stock drops its cached usage, so the next read asks the provider and lifts the account's blocks. */
	settle(provider: string): Promise<void>;
}

/** pi-ai `ClaudeResetCreditList`, the fields used here. */
export interface ChosenOffer {
	nextCreditId?: string;
	credits: ResetCreditDetail[];
}

/** pi-ai `ClaudeResetConsumeResult`, the fields used here. */
export interface ChosenSpend {
	ok: boolean;
	code: string;
	status: number;
	cleared?: string[];
	reason?: string;
}

export interface ChosenAccount {
	email?: string;
	offer: ChosenOffer;
	/** Spends exactly `credit` under `requestId`, the provider's idempotency key. Never retried. */
	spend(credit: ResetCreditDetail & { id: string }, requestId: string): Promise<ChosenSpend>;
}

/** What chosen spends remember between calls, per omp (reset-passes.ts holds one). */
export interface ChosenClaims {
	/** Accounts with a chosen spend under way: a second one is refused, never sent. */
	running: Set<number>;
	/**
	 * A spend the provider never answered keeps its request id, so trying the same pass again repeats the same claim
	 * and cannot spend a second pass (stock's own `#pendingClaudeResets` does this for the pass named next).
	 */
	unsettled: Map<number, { creditId: string; requestId: string }>;
}

export const chosenClaims = (): ChosenClaims => ({ running: new Set(), unsettled: new Map() });

/** Answers after which a claim is over: it applied, or the provider said it will not. */
const SETTLED_CODES: Record<string, true> = {
	already_redeemed: true,
	nothing_to_reset: true,
	ineligible: true,
	cooldown: true,
};
const SETTLED_STATUSES: Record<number, true> = { 401: true, 403: true, 429: true };

/**
 * Spend the pass a person picked when it is not the one the provider names next. Stock's redeem refuses that
 * (`offer_changed`: it spends only `nextCreditId`), although Claude takes any grant of the account by id, which is how
 * Claude Code spends the kind a person picks there (the owner's rule, 11 Nov 2026: every kind listed can be spent).
 * So this path reads the account's offer once and sends that one pass's claim with stock's own request.
 *
 * Undefined when the offer does not name a different pass next, or the picked one is gone, spent or paused: stock's
 * refusal then stands.
 */
async function spendChosenPass(
	surface: ResetPassSurface,
	claims: ChosenClaims,
	provider: string,
	credentialId: number,
	creditId: string,
): Promise<ResetRedeemOutcome | undefined> {
	if (claims.running.has(credentialId)) return { ok: false, code: "reset_in_progress", provider };
	claims.running.add(credentialId);
	try {
		const account = await surface.account(provider, credentialId);
		if ("code" in account) return { ok: false, code: account.code, provider };
		const { offer } = account;
		const credit = offer.credits.find(candidate => candidate.id === creditId);
		if (!offer.nextCreditId || offer.nextCreditId === creditId || !credit || !choosable(credit)) return undefined;
		const held = claims.unsettled.get(credentialId);
		const requestId = held?.creditId === creditId ? held.requestId : crypto.randomUUID();
		claims.unsettled.set(credentialId, { creditId, requestId });
		// Stock's `usable` says "the one named next"; the claim's own guard reads it as "may be sent".
		const spend = await account.spend({ ...credit, usable: true }, requestId);
		if (spend.ok || SETTLED_CODES[spend.code] || SETTLED_STATUSES[spend.status])
			claims.unsettled.delete(credentialId);
		if (spend.ok) await surface.settle(provider);
		return {
			ok: spend.ok,
			code: spend.code,
			provider,
			creditId,
			...(account.email ? { email: account.email } : {}),
			...(spend.reason ? { reason: spend.reason } : {}),
			...(spend.cleared ? { cleared: spend.cleared } : {}),
		};
	} finally {
		claims.running.delete(credentialId);
	}
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
 * A confirmed pass stock refuses only because the provider names another one next is spent by `spendChosenPass`.
 */
export async function redeemResetPass(
	surface: ResetPassSurface,
	request: RedeemRequest,
	claims: ChosenClaims,
): Promise<RedeemResult> {
	const { provider, credentialId } = request;
	if (surface.verifiesOffer(provider)) {
		const refused = await surface.redeem({
			provider,
			credentialId,
			...(request.creditId ? { creditId: request.creditId } : {}),
		});
		const outcome =
			refused.code === "offer_changed" && request.creditId
				? ((await spendChosenPass(surface, claims, provider, credentialId, request.creditId)) ?? refused)
				: refused;
		return outcomeResult(surface, outcome, outcome.email ?? refused.email ?? `#${credentialId}`);
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
