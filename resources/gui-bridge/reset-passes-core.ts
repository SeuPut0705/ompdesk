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
	 * `AgentSession.redeemResetCredit`. Claude's reads the account's live offer once and spends only the pass it names
	 * next; Codex's spends a given pass unread, else reads the account's list and spends its soonest to expire.
	 */
	redeem(target: ResetTarget): Promise<ResetRedeemOutcome>;
	/** Stock `describeRedeemOutcome`. */
	describe(outcome: ResetRedeemOutcome, label: string): string;
	/**
	 * One stored account and the spend of one pass of it (pi-ai `consumeClaudeResetCredit` over the account's access,
	 * `authStorage.oauth.accessById`). `live` reads its offer once (pi-ai `listClaudeResetCredits`); when that read
	 * fails, or without `live`, the offer is the account's last usage report this bridge read (`storedAt`,
	 * last-reports.ts). A code when the account is gone (`no_account`) or cannot sign in (`account_unavailable`).
	 */
	account(provider: string, credentialId: number, live: boolean): Promise<ChosenAccount | { code: string }>;
	/** After a spend: stock drops its cached usage, so the next read asks the provider and lifts the account's blocks. */
	settle(provider: string): Promise<void>;
}

/** pi-ai `ClaudeResetCreditList`, the fields used here. */
export interface ChosenOffer {
	nextCreditId?: string;
	credits: ResetCreditDetail[];
	/** Not read live: the account's last usage report this bridge read (last-reports.ts), read at this time, epoch ms. */
	storedAt?: number;
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
	/** The live offer, else the stored one (`storedAt`); none when the live read failed and no report was read. */
	offer?: ChosenOffer;
	/** Spends exactly `credit` under `requestId`, the provider's idempotency key. Never retried. */
	spend(credit: ResetCreditDetail & { id: string }, requestId: string): Promise<ChosenSpend>;
}

/** What claims of a picked pass remember between calls, per omp (reset-passes.ts holds one). */
export interface ChosenClaims {
	/** Accounts with a chosen spend under way: a second one is refused, never sent. */
	running: Set<number>;
	/**
	 * By pass (`claimKey`): a claim this path sent that the provider never answered, with its request id and the uses
	 * the pass had left. Trying the same pass again repeats that claim under that id, whatever the provider names
	 * next by then, so it cannot spend a second use (stock's `#pendingClaudeResets` does this for its own claims).
	 */
	unsettled: Map<string, { requestId: string; left?: number }>;
	/**
	 * By pass: stock's redeem sent a claim the provider never answered. Stock keeps that claim's request id to itself,
	 * so this path never claims such a pass: a claim under a new id could spend a second use.
	 */
	stockUnsettled: Set<string>;
}

export const chosenClaims = (): ChosenClaims => ({
	running: new Set(),
	unsettled: new Map(),
	stockUnsettled: new Set(),
});

const claimKey = (credentialId: number, creditId: string): string => `${credentialId} ${creditId}`;

/** Answers after which a claim is over: it applied, or the provider said it will not. */
const SETTLED_CODES: Record<string, true> = {
	already_redeemed: true,
	nothing_to_reset: true,
	ineligible: true,
	cooldown: true,
};
const SETTLED_STATUSES: Record<number, true> = { 401: true, 403: true, 429: true };

/** Stock redeem answers on which stock drops a claim it held (auth/resets.ts), besides a reset that applied. */
const STOCK_SETTLED: Record<string, true> = { already_redeemed: true, nothing_to_reset: true };
/** Stock redeem answers that mean no claim reached the provider unanswered: none was sent, or it was refused. */
const STOCK_NOT_APPLIED: Record<string, true> = {
	offer_changed: true,
	credit_list_failed: true,
	no_account: true,
	account_unavailable: true,
	reset_in_progress: true,
	reset_unconfirmed: true,
	no_credit: true,
	ineligible: true,
	unsupported_provider: true,
	cooldown: true,
	auth_error: true,
	rate_limited: true,
	organization_unavailable: true,
};

/** Remembers whether stock's redeem left a claim of this pass unanswered. Any answer not known to be safe counts. */
function noteStockAnswer(claims: ChosenClaims, key: string, outcome: ResetRedeemOutcome): void {
	if (outcome.ok || STOCK_SETTLED[outcome.code]) claims.stockUnsettled.delete(key);
	else if (!STOCK_NOT_APPLIED[outcome.code]) claims.stockUnsettled.add(key);
}

/**
 * How old a stored read may be for a confirmed pass to be spent from it. With every probe answering, the last read
 * the accounts list holds is never older than one usage poll (5 min, `USAGE_POLL_MS` in src/renderer/lib/
 * usage-reports.ts) plus the longest life of stock's cached report (pi-ai `USAGE_REPORT_TTL_MS`, 5 min + 25 % jitter):
 * 11.25 min. An older one means the provider has refused reads for a while, so what the dialog showed may not hold.
 */
export const STORED_OFFER_MAX_AGE_MS = 15 * 60_000;

/**
 * Programs whose claim carries no request id (pi-ai `consumeClaudeResetCredit`: Claude's session reset). A repeat
 * after a lost answer would be a second claim, so stock never sends one again (auth/resets.ts) and none is sent from
 * a stored read.
 */
const UNKEYED_PROGRAMS: Record<string, true> = { juniper_tide: true };

/**
 * Spend a confirmed pass by its id, with stock's own claim request, where stock's redeem does not: the provider names
 * another pass next (`offer_changed`: stock spends only `nextCreditId`, although Claude takes any grant of the account
 * by id, which is how Claude Code spends the kind a person picks; the owner's rule, 11 Nov 2026: every kind listed
 * can be spent), or stock's read of the offer failed (`credit_list_failed`: the provider turned the check away).
 *
 * `live` reads the account's offer once. When that read fails, or without `live` (stock's read just failed), the
 * offer is the account's last read in this bridge, the one the dialog was opened on or a newer one, while it is at
 * most {@link STORED_OFFER_MAX_AGE_MS} old; whether the pass applies is then the provider's answer to the claim.
 *
 * A claim of the pass this path sent before and never got answered is repeated under its own request id instead,
 * whatever the provider names next now; when a use of the pass is gone meanwhile, that claim applied and nothing
 * more is sent.
 *
 * Undefined when the offer lists the pass gone, spent, expired or paused, or (read live, with no claim of it
 * unanswered) does not name a different pass next: there is nothing for this path to send.
 */
async function spendChosenPass(
	surface: ResetPassSurface,
	claims: ChosenClaims,
	provider: string,
	credentialId: number,
	creditId: string,
	live: boolean,
): Promise<ResetRedeemOutcome | undefined> {
	if (claims.running.has(credentialId)) return { ok: false, code: "reset_in_progress", provider };
	claims.running.add(credentialId);
	try {
		const key = claimKey(credentialId, creditId);
		const account = await surface.account(provider, credentialId, live);
		if ("code" in account) return { ok: false, code: account.code, provider };
		const identity = { provider, creditId, ...(account.email ? { email: account.email } : {}) };
		const { offer } = account;
		const storedAt = offer?.storedAt;
		if (!offer || (storedAt !== undefined && Date.now() - storedAt > STORED_OFFER_MAX_AGE_MS)) {
			return { ...identity, ok: false, code: "stale_offer" };
		}
		const credit = offer.credits.find(candidate => candidate.id === creditId);
		const held = claims.unsettled.get(key);
		if (!credit || !choosable(credit) || expiryMs(credit) <= Date.now()) {
			// A claim of a pass that left the offer can never be answered (stock drops its own the same way). Only a
			// live read says it left: a stored one may be older than the claim.
			if (storedAt === undefined) claims.unsettled.delete(key);
			return undefined;
		}
		if (storedAt !== undefined && UNKEYED_PROGRAMS[credit.program ?? ""]) {
			return { ...identity, ok: false, code: "credit_list_failed" };
		}
		if (!held && storedAt === undefined && (!offer.nextCreditId || offer.nextCreditId === creditId)) return undefined;
		if (held?.left !== undefined && credit.remainingCount !== undefined && credit.remainingCount < held.left) {
			claims.unsettled.delete(key);
			await surface.settle(provider);
			return { ...identity, ok: false, code: "already_redeemed" };
		}
		const requestId = held?.requestId ?? crypto.randomUUID();
		const left = held ? held.left : credit.remainingCount;
		claims.unsettled.set(key, { requestId, ...(left !== undefined ? { left } : {}) });
		// Stock's `usable` says "the one named next"; the claim's own guard reads it as "may be sent".
		const spend = await account.spend({ ...credit, usable: true }, requestId);
		if (spend.ok || SETTLED_CODES[spend.code] || SETTLED_STATUSES[spend.status]) claims.unsettled.delete(key);
		if (spend.ok) await surface.settle(provider);
		return {
			...identity,
			ok: spend.ok,
			code: spend.code,
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
	/** The pass the person confirmed: the only one this redeem may spend. */
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

/** Outcomes only this bridge gives, worded for a viewer whose OMPdesk predates them (it shows `message`). */
const OWN_MESSAGES: Record<string, string> = {
	stale_offer:
		"the provider's check failed and no read of this account's passes from the last 15 minutes stands in for it, so nothing was spent",
};

const outcomeResult = (surface: ResetPassSurface, outcome: ResetRedeemOutcome, label: string): RedeemResult => ({
	ok: outcome.ok,
	code: outcome.code,
	message: OWN_MESSAGES[outcome.code] ? `${label}: ${OWN_MESSAGES[outcome.code]}.` : surface.describe(outcome, label),
	...(outcome.reason ? { reason: outcome.reason } : {}),
	...(outcome.cleared?.length ? { cleared: outcome.cleared } : {}),
});

/**
 * Spend the pass the person confirmed. Stock's redeem goes first: Claude's reads the live offer and spends the pass it
 * names next, Codex's spends its soonest (stock's Codex usage report carries no credit ids, so a Codex redeem names
 * none and needs that read). A confirmed pass stock refuses because the provider names another next, or could not
 * check because its read failed, is spent by `spendChosenPass`; in the second case from the last read the dialog was
 * built on, so a lookup the provider throttles never stands between a person and the pass they confirmed.
 *
 * One pass is never claimed under two request ids while an earlier claim of it may still have applied: a claim
 * `spendChosenPass` sent and never got answered is repeated by it before stock is asked (stock would send a new one
 * once the provider names that pass next), and a pass whose claim by stock went unanswered is never claimed here.
 */
export async function redeemResetPass(
	surface: ResetPassSurface,
	request: RedeemRequest,
	claims: ChosenClaims,
): Promise<RedeemResult> {
	const { provider, credentialId, creditId } = request;
	const result = (outcome: ResetRedeemOutcome, email?: string) =>
		outcomeResult(surface, outcome, outcome.email ?? email ?? `#${credentialId}`);
	if (creditId && claims.unsettled.has(claimKey(credentialId, creditId))) {
		return result(
			(await spendChosenPass(surface, claims, provider, credentialId, creditId, true)) ?? {
				ok: false,
				code: "offer_changed",
				provider,
			},
		);
	}
	const refused = await surface.redeem({ provider, credentialId, ...(creditId ? { creditId } : {}) });
	if (!creditId) return result(refused);
	const key = claimKey(credentialId, creditId);
	noteStockAnswer(claims, key, refused);
	const live = refused.code === "offer_changed";
	if (!live && refused.code !== "credit_list_failed") return result(refused);
	if (claims.stockUnsettled.has(key)) return result({ ...refused, code: "reset_unconfirmed" });
	return result(
		(await spendChosenPass(surface, claims, provider, credentialId, creditId, live)) ??
			// Stored: a newer read than the dialog's no longer lists the pass.
			(live ? refused : { ...refused, code: "offer_changed" }),
		refused.email,
	);
}
