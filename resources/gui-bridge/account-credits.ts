/**
 * What an account has left to spend beyond its plan windows, read from the limits of stock's usage report. Pure: no
 * omp imports, so the GUI's own vitest runs it on made-up limits (src/main/bridge-account-credits.test.ts).
 *
 * Which limits are money or credits left is a table by stock's limit id, because the shape alone cannot tell them
 * apart: Factory reports its prepaid balance as a cap of itself (`used: 0`, `limit` = `remaining`), Claude its extra
 * usage as spend against a monthly cap. ChatGPT Codex has no such limit: its balance is the `credits` block of the
 * provider's own answer, which stock keeps as the report's `raw` and only on the fetch itself (its usage cache drops
 * `raw`), so {@link rawCredits} reads it there and last-reports.ts keeps it per account. OpenRouter, which has no
 * usage report, has no credits here.
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

/** The id an account's credits read from a report's `raw` carry, where stock has no limit for them. */
const CODEX_CREDITS_ID = "openai-codex:credits";

/**
 * `credits` of ChatGPT's `/wham/usage` (pi-ai usage/openai-codex.ts `CodexUsageCreditsPayload`), as the Codex CLI
 * shows it: nothing without `has_credits`, "unlimited" before any balance, else the balance while above zero.
 */
function codexCredits(raw: unknown): AccountCredits | undefined {
	const block = typeof raw === "object" && raw !== null ? (raw as { credits?: unknown }).credits : undefined;
	if (typeof block !== "object" || block === null) return undefined;
	const { has_credits, unlimited, balance } = block as {
		has_credits?: unknown;
		unlimited?: unknown;
		balance?: unknown;
	};
	if (has_credits !== true) return undefined;
	if (unlimited === true) return { kind: "unlimited", limitId: CODEX_CREDITS_ID };
	const remaining = typeof balance === "string" && balance.trim() ? Number(balance) : balance;
	return typeof remaining === "number" && positive(remaining)
		? { kind: "balance", limitId: CODEX_CREDITS_ID, remaining, unit: "credits" }
		: undefined;
}

const RAW_CREDITS: Readonly<Record<string, (raw: unknown) => AccountCredits | undefined>> = {
	"openai-codex": codexCredits,
};

/** Whether a provider's credits are only in its report's `raw`, so a cached report cannot name them. */
export function creditsInRaw(provider: string): boolean {
	return Object.hasOwn(RAW_CREDITS, provider);
}

/** The credits a fetched report's `raw` names, for a provider of {@link creditsInRaw}. */
export function rawCredits(provider: string, raw: unknown): AccountCredits | undefined {
	return creditsInRaw(provider) ? RAW_CREDITS[provider]?.(raw) : undefined;
}
