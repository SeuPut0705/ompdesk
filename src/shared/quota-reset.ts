import type { UsageReport } from "./rpc-types";

/** How long a usage-limit stop waits when no usage report names a reset (a short rate limit, or no report at all). */
export const QUOTA_FALLBACK_MS = 15 * 60_000;

/**
 * When the provider's usage limit lets `provider` run again: stock may rotate to any of the provider's accounts, so the
 * first account to reset frees the session. Unknown (undefined) while any account is not limited — the stop was then a
 * short rate limit, not a quota — or no report names a reset. The renderer's resume booking and Autopilot's wait in main
 * both read it.
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
