/**
 * What an account has left to spend beyond its plan windows, read from the limits of stock's usage report. Pure: no
 * omp imports, so the GUI's own vitest runs it on made-up limits (src/main/bridge-account-credits.test.ts).
 *
 * Which limits are money or credits left is a table by stock's limit id, because the shape alone cannot tell them
 * apart: Factory reports its prepaid balance as a cap of itself (`used: 0`, `limit` = `remaining`), Claude its extra
 * usage as spend against a monthly cap. A provider stock reports no such limit for (ChatGPT Codex, whose
 * `credits.balance` lives only in the report's `raw`, which stock's usage cache drops; OpenRouter, which has no usage
 * report) has no credits here.
 */
import type { AccountCredits } from "../../src/shared/rpc-types";

/** The slice of stock's `UsageLimit` this reads. */
export interface CreditLimitLike {
	id: string;
	amount: { remaining?: number; limit?: number; unit: string };
}

const CREDIT_LIMITS: Readonly<Record<string, AccountCredits["kind"]>> = {
	// pi-ai usage/claude.ts buildClaudeExtraUsageLimit: extra usage spent against the monthly cap (`remaining` only
	// when capped), usd.
	"anthropic:extra": "monthlyCap",
	// usage/factory-droid.ts: `extraUsageBalanceCents`, usd, with `used: 0` and `limit` = the balance.
	"factory-droid:extra-balance": "balance",
	// usage/charm-hyper.ts, usage/commandcode.ts: the API key's balance in credits.
	"charm-hyper:credits": "balance",
	"commandcode:balance": "balance",
};

/** How a stock limit counts as credits, or `undefined` for a quota window. */
export function creditKind(limitId: string): AccountCredits["kind"] | undefined {
	return Object.hasOwn(CREDIT_LIMITS, limitId) ? CREDIT_LIMITS[limitId] : undefined;
}

function positive(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** The account's credits while something is left: a balance above zero, or a cap with something left of it. */
export function accountCredits(limits: readonly CreditLimitLike[]): AccountCredits | undefined {
	for (const { id, amount } of limits) {
		const kind = creditKind(id);
		const { remaining, limit, unit } = amount;
		if (!kind || (unit !== "usd" && unit !== "credits") || !positive(remaining)) continue;
		if (kind === "balance") return { kind, limitId: id, remaining, unit };
		if (positive(limit)) return { kind, limitId: id, remaining, limit, unit };
	}
	return undefined;
}
