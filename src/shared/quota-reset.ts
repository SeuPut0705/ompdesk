/**
 * A provider's limit and when it lets a turn run again: one rule for the resume of a failed turn (`TurnResume`,
 * src/main/turn-resume.ts), Autopilot's quota wait (src/main/autopilot.ts) and the error card's reset line.
 * Dependency-free, so main and the renderer read the same copy.
 */
import type { UsageReport } from "./rpc-types";

/** How long a usage-limit stop waits when no usage report names a reset (a short rate limit, or no report at all). */
export const QUOTA_FALLBACK_MS = 15 * 60_000;

/** How often, at most, a tab that waits for a limit looks whether it lifted before its time (turn-resume.ts). */
export const LIMIT_LOOK_MS = 10 * 60_000;

/**
 * When the provider's usage limit lets `provider` run again: stock may rotate to any of the provider's accounts, so the
 * first account to reset frees the session. Unknown (undefined) while any account is not limited — the stop was then a
 * short rate limit, not a quota — or no report names a reset.
 */
export function quotaResetAt(
	reports: readonly UsageReport[],
	provider: string | undefined,
	now: number,
): number | undefined {
	const accounts = reports.filter(report => report.provider === provider);
	if (accounts.length === 0) return undefined;
	let soonest: number | undefined;
	for (const { resetAt } of accounts) {
		if (resetAt === undefined || resetAt <= now) return undefined;
		soonest = soonest === undefined ? resetAt : Math.min(soonest, resetAt);
	}
	return soonest;
}

/** When a turn the provider's limit stopped is tried again: that reset, else {@link QUOTA_FALLBACK_MS} from now. */
export function quotaWaitUntil(reports: readonly UsageReport[], provider: string | undefined, now: number): number {
	return quotaResetAt(reports, provider, now) ?? now + QUOTA_FALLBACK_MS;
}

/** A provider's rate limit, quota or usage limit by its wording: what both waits take up. */
const LIMIT_WORDING =
	/\b429\b|rate[ _.-]?limit|too many requests|quota|usage limit|GoUsageLimitError|FreeUsageLimitError|ResourceExhausted/i;

export function isLimitWording(message: string | undefined): boolean {
	return message !== undefined && LIMIT_WORDING.test(message);
}

/**
 * An account out of money, which adding money clears and waiting never does: stock's billing cap
 * (pi-ai `error/rate-limit.ts` `isBillingCapUsageLimit`: out of credit, an insufficient balance, exhausted credits, a
 * spent prepaid balance, a spend ceiling, Anthropic's credits wall, `insufficient_quota`, HTTP 402) plus the billing
 * wordings the scheduled retry already refused. A copy because main judges a failed turn's text with no omp to ask;
 * `src/main/quota-reset-stock.test.ts` holds it against stock's function on the installed omp.
 */
const BILLING_CAP =
	/\b402\b|\bout of credit|\badd (?:more )?credit|\btop ?up\b|insufficient|available balance|out of budget|billing|\b(?:exceed\w*|not enough)\b[^\n]{0,40}\bcredits?\b|\bcredits?\b[^\n]{0,40}\b(?:exhausted|depleted)\b|\busage_pricing_required\b|\bprepaid balance\b[^\n]{0,40}\b(?:used up|exhausted|depleted)\b|spend(?:ing)?[\s_-]?(?:limit|cap)\b|\busage credits are required\b|\bcredits_required\b/i;

export function isBillingCap(message: string | undefined): boolean {
	return message !== undefined && BILLING_CAP.test(message);
}

/** Stock's hint on a failed reply (pi-ai `utils/retry-after.ts` appends ` retry-after-ms=<n>` from the provider's headers). */
const RETRY_AFTER = /\bretry-after-ms\s*[:=]\s*(\d+)\b/i;

/** How long after the failure the provider said to wait, in ms; undefined when the reply carries no such hint. */
export function retryAfterMs(message: string | undefined): number | undefined {
	const ms = Number(RETRY_AFTER.exec(message ?? "")?.[1]);
	return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}
