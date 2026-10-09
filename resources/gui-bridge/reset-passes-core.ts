/**
 * Saved rate-limit resets ("reset passes"), pure half. Codex and Claude bank
 * resets an account can spend to clear its limits at once; stock lists them in
 * each usage report (`UsageReport.resetCredits`) and spends one through
 * `AgentSession.redeemResetCredit` (`/usage reset`). This file shapes stock's
 * data for the GUI and runs the redeem over an injected stock surface
 * (reset-passes.ts wires the real one), with stock's own rules:
 *
 * - counts, soonest expiry and the provider's reason come from stock's
 *   `summarizeUsageResetCredits`;
 * - Claude spends only the grant its listing endpoint pins (`nextCreditId`),
 *   as stock's `toResetUsageAccounts` does;
 * - a pass whose provider does not say when it may be spent (Codex: no
 *   `requiresLimit`) is spent only while a limit it covers is reached, the
 *   condition stock's auto-redeem requires (`codex-auto-reset.ts`, a window at
 *   ≥ 99.9 % used); the backend answers `nothing_to_reset` otherwise.
 *
 * No omp imports, no Bun globals: the GUI's vitest exercises this file directly
 * (src/main/bridge-reset-passes.test.ts).
 */

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

/** Stock `UsageResetSummary` (pi-tui `summarizeUsageResetCredits`). */
export interface ResetSummary {
	bankedCount: number;
	redeemableCount: number;
	soonestExpiry?: string;
	unavailableReason?: string;
}

export type ResetSummarizer = (credits: ResetCreditsInfo | undefined) => ResetSummary | undefined;

/** One quota window, as the bridge shapes it. */
export interface LimitState {
	id: string;
	usedFraction?: number;
	status?: string;
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

/** Providers stock can list and spend saved resets for (`ResetCredits.list`). */
export const RESET_PROVIDERS: readonly string[] = ["openai-codex", "anthropic"];

/** Stock `WINDOW_EXHAUSTED_MIN_FRACTION`: a window counts as reached at 99.9 % used. */
const EXHAUSTED_FRACTION = 0.999;
/** A Codex reset clears the account's chat windows (5h and weekly), not extra metered features. */
const CODEX_CHAT_WINDOWS = ["openai-codex:primary", "openai-codex:secondary"];

/**
 * The GUI's view of an account's saved resets, or `undefined` when it has none
 * (or the provider reports none). `summary` is stock's summary of `credits`;
 * `limits` the account's quota windows.
 */
export function shapeResetPasses(
	provider: string,
	credits: ResetCreditsInfo | undefined,
	summary: ResetSummary | undefined,
	limits: readonly LimitState[],
): ResetPasses | undefined {
	if (!credits || !summary || summary.bankedCount <= 0) return undefined;
	const pinned = credits.nextCreditId;
	const selected = pinned
		? credits.credits?.find(credit => credit.id === pinned)
		: (credits.credits?.find(credit => credit.usable !== false) ?? credits.credits?.[0]);
	// Stock `toResetUsageAccounts`: never degrade a missing Claude pin into "spend whichever grant".
	const unpinnedClaude = provider === "anthropic" && !pinned;
	const usableCount = unpinnedClaude ? 0 : summary.redeemableCount;
	const unavailableReason =
		summary.unavailableReason ??
		(unpinnedClaude && summary.redeemableCount > 0
			? "the provider did not identify a grant that can be safely spent"
			: undefined) ??
		(usableCount === 0 ? "not usable right now" : undefined);
	const clears = selected?.clears?.length
		? selected.clears
		: provider === "openai-codex"
			? CODEX_CHAT_WINDOWS.filter(id => limits.some(limit => limit.id === id))
			: [];
	const covered = clears.length > 0 ? limits.filter(limit => clears.includes(limit.id)) : limits;
	// A provider that states `requiresLimit` already folded the wall into `usable`.
	const providerJudges = selected?.requiresLimit !== undefined;
	const expiresAt = summary.soonestExpiry ? Date.parse(summary.soonestExpiry) : Number.NaN;
	return {
		count: summary.bankedCount,
		usableCount,
		...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
		...(selected?.title ? { title: selected.title } : {}),
		clears,
		early: selected?.requiresLimit === false,
		...(pinned ? { creditId: pinned } : {}),
		redeemable:
			usableCount > 0 &&
			(providerJudges ||
				covered.some(
					limit => limit.status === "exhausted" || (limit.usedFraction ?? 0) >= EXHAUSTED_FRACTION,
				)),
		...(unavailableReason ? { unavailableReason } : {}),
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
	/** Live quota evidence from the reset discovery (Claude). */
	report?: { limits: readonly LimitState[] };
	error?: string;
}

/** Stock `ResetUsageAccount` (`toResetUsageAccounts`), the fields used here. */
export interface ResetUsageAccount {
	label: string;
	target: ResetTarget;
	error?: string;
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
	/** Stock `summarizeUsageResetCredits`. */
	summarize: ResetSummarizer;
	/** The account's cached quota windows (stock's per-credential usage report). */
	limits(provider: string, credentialId: number): Promise<readonly LimitState[]>;
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

/**
 * Stock's `/usage reset <provider>/<credential id>`: read the account's live
 * offer, refuse what stock would refuse (and spending without a reached limit
 * where the provider does not judge that itself), then spend through stock's
 * own redeem, which updates its blocks and usage cache. Business refusals come
 * back with `ok: false`; transport errors from the redeem throw.
 */
export async function redeemResetPass(surface: ResetPassSurface, request: RedeemRequest): Promise<RedeemResult> {
	const { provider, credentialId } = request;
	if (!RESET_PROVIDERS.includes(provider)) {
		return refusal("unsupported_provider", `${provider} has no saved rate-limit resets.`);
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
	const limits = status.report?.limits ?? (await surface.limits(provider, credentialId).catch(() => []));
	const passes = shapeResetPasses(provider, status, surface.summarize(status), limits);
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
	if (!passes.redeemable) {
		return refusal("not_limited", `${label}: none of the limits this reset covers is reached — nothing was spent.`);
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
