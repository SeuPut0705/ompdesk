/**
 * Credit use, pure half (credit-spend.ts wires it to stock omp). Settings › Models & accounts › Credit use: the
 * owner's rule (12 Nov 2026) is that no money leaves an account because OMPdesk kept working past the plan, unless
 * he turned that on. Off is the default.
 *
 * Stock serves past the plan in two ways. A ChatGPT account whose plan windows are spent but which holds credits
 * reads as allowed (pi-ai usage/openai-codex.ts `hasPlanCreditOverage`), so stock's selector never blocks it. And
 * whatever any report says, stock's selector ends on a last-resort pass that takes a blocked account (auth/select.ts
 * `resolveOAuth` passes with `allowBlocked: true`), and with one account it reads no usage at all
 * (`#oauthUsagePolicy`: `credentials.length > 1`), so a spent account is sent the request and the provider serves
 * it from credits (ChatGPT) or extra usage (Claude).
 *
 * Off therefore means: an account whose plan is spent is limited, decided here from the account's own usage report
 * ({@link planSpentUntil}) or from Claude's answer that extra usage served the last request ({@link overageUntil}).
 * The request it would carry is refused with a usage-limit error ({@link planSpentError}), which stock itself
 * handles: it blocks the account until the reset, moves the session to an account with plan left, or runs
 * `retry.fallbackChains` (`fallbackOn: usage-limit`), or shows the error.
 *
 * No omp imports (not even types), no Bun globals: the GUI's vitest runs this file (src/main/bridge-credit-spend.test.ts).
 */

/** Spawn env: `1` lets accounts run on credits and extra usage (stock); anything else is off. */
export const CREDIT_SPEND_ENV = "OMP_GUI_CREDIT_SPEND";

/** The providers whose accounts can serve past their plan: ChatGPT on credits, Claude on extra usage. */
export const CREDIT_PROVIDERS = ["openai-codex", "anthropic"] as const;
export type CreditProvider = (typeof CREDIT_PROVIDERS)[number];

export function isCreditProvider(provider: string): provider is CreditProvider {
	return (CREDIT_PROVIDERS as readonly string[]).includes(provider);
}

let enabled = process.env[CREDIT_SPEND_ENV] === "1";

export function creditSpendEnabled(): boolean {
	return enabled;
}

/** `{enabled: boolean}` from main; anything else is refused rather than read as off. */
export function setCreditSpend(params: unknown): { enabled: boolean } {
	const next = typeof params === "object" && params !== null && "enabled" in params ? params.enabled : undefined;
	if (typeof next !== "boolean") throw new Error("credit_spend_set needs {enabled: boolean}");
	enabled = next;
	return { enabled };
}

/** The slice of stock's `UsageLimit` read here. */
export interface PlanLimitLike {
	id: string;
	status?: string;
	scope: { shared?: boolean };
	amount: { usedFraction?: number; used?: number; limit?: number };
	window?: { resetsAt?: number };
}

/** The slice of stock's `UsageReport` read here. */
export interface PlanReportLike {
	limits: readonly PlanLimitLike[];
	metadata?: Record<string, unknown>;
}

/** Codex's plan windows (pi-ai usage/openai-codex.ts `buildUsageLimit`); its spend cap and extra meters are not plan. */
const CODEX_PLAN_LIMITS: Readonly<Record<string, true>> = {
	"openai-codex:primary": true,
	"openai-codex:secondary": true,
};

/** Claude's plan is its shared windows (5 hours, 7 days); the extra-usage row and per-model rows are not. */
function isPlanLimit(provider: CreditProvider, limit: PlanLimitLike): boolean {
	return provider === "openai-codex" ? Object.hasOwn(CODEX_PLAN_LIMITS, limit.id) : limit.scope.shared === true;
}

function spent(limit: PlanLimitLike): boolean {
	if (limit.status === "exhausted") return true;
	const { usedFraction, used, limit: cap } = limit.amount;
	const fraction = usedFraction ?? (used !== undefined && cap !== undefined && cap > 0 ? used / cap : undefined);
	return fraction !== undefined && fraction >= 1;
}

/** How long a plan Codex calls spent stays limited when no window names a reset: stock's own default block. */
export const UNTIMED_SPENT_MS = 30 * 60_000;

/**
 * Until when the account's plan is spent, from its usage report: the latest reset among its plan windows at 100 %, or
 * (Codex) the plan verdict `limitReached` read without credits; `undefined` while the plan still serves. A window
 * whose reset has passed is not spent.
 */
export function planSpentUntil(
	provider: CreditProvider,
	report: PlanReportLike | null | undefined,
	now: number,
): number | undefined {
	if (!report) return undefined;
	let until: number | undefined;
	let nextReset: number | undefined;
	for (const limit of report.limits) {
		if (!isPlanLimit(provider, limit)) continue;
		const resetsAt = limit.window?.resetsAt;
		if (resetsAt === undefined || resetsAt <= now) continue;
		nextReset = Math.min(nextReset ?? resetsAt, resetsAt);
		if (spent(limit)) until = Math.max(until ?? resetsAt, resetsAt);
	}
	if (until !== undefined) return until;
	if (provider === "openai-codex" && report.metadata?.limitReached === true)
		return nextReset ?? now + UNTIMED_SPENT_MS;
	return undefined;
}

/** The plan windows every model of the account shares, by the claim Claude names, with the header of their reset. */
const SHARED_CLAIM: Readonly<Record<string, string>> = {
	five_hour: "anthropic-ratelimit-unified-5h-reset",
	seven_day: "anthropic-ratelimit-unified-7d-reset",
};

/** A model's own weekly window, by its claim: spent for that model only. */
const MODEL_CLAIM: Readonly<Record<string, string>> = {
	seven_day_opus: "anthropic-ratelimit-unified-7d-reset",
	seven_day_sonnet: "anthropic-ratelimit-unified-7d-reset",
};

/**
 * Whether the window a response claims is one every model of the account shares. Any other claim (a model's own
 * weekly window, one this build has not heard of) says only that the model that was served is past its plan, so the
 * account's other models are left alone.
 */
export function overageCoversAccount(headers: Readonly<Record<string, string>>): boolean {
	return Object.hasOwn(SHARED_CLAIM, headers["anthropic-ratelimit-unified-representative-claim"]?.trim() ?? "");
}

function epochSecondsMs(value: string | undefined, now: number): number | undefined {
	const seconds = value === undefined ? Number.NaN : Number(value.trim());
	return Number.isFinite(seconds) && seconds * 1000 > now ? seconds * 1000 : undefined;
}

/**
 * Until when Claude serves on extra usage what the response claims, from its headers: `overage-in-use: true` means
 * the plan window the response claims (`representative-claim`) is spent, until that window's reset (else the unified
 * reset, else stock's default block). `undefined` when the response was served on the plan. Whether that is the whole
 * account or the served model only: {@link overageCoversAccount}.
 */
export function overageUntil(headers: Readonly<Record<string, string>>, now: number): number | undefined {
	if (headers["anthropic-ratelimit-unified-overage-in-use"]?.trim() !== "true") return undefined;
	const claim = headers["anthropic-ratelimit-unified-representative-claim"]?.trim() ?? "";
	const claimed = Object.hasOwn(SHARED_CLAIM, claim)
		? SHARED_CLAIM[claim]
		: Object.hasOwn(MODEL_CLAIM, claim)
			? MODEL_CLAIM[claim]
			: undefined;
	return (
		(claimed ? epochSecondsMs(headers[claimed], now) : undefined) ??
		epochSecondsMs(headers["anthropic-ratelimit-unified-reset"], now) ??
		now + UNTIMED_SPENT_MS
	);
}

/**
 * A Codex `/wham/usage` answer as stock's parser should read it while credit use is off: the same answer without its
 * `credits` block, so a spent plan reads spent (`hasPlanCreditOverage` is false without it). Anything else unchanged.
 */
export function withoutCredits(payload: unknown): unknown {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload) || !("credits" in payload)) {
		return payload;
	}
	const { credits: _credits, ...rest } = payload;
	return rest;
}

/** Brand names in the refusal, as the person knows the accounts. */
const BRAND: Readonly<Record<CreditProvider, string>> = { "openai-codex": "ChatGPT", anthropic: "Claude" };
const PAID: Readonly<Record<CreditProvider, string>> = { "openai-codex": "credits", anthropic: "extra usage" };

/**
 * The error a refused request raises. Stock reads its wording as a usage limit (pi-ai error/rate-limit.ts
 * `USAGE_LIMIT_PATTERN`: `usage_limit_reached`), so it rotates or falls back; the caller appends stock's own
 * `retry-after-ms` hint so the block lasts until the reset.
 */
export function planSpentError(provider: CreditProvider, until: number, now: number): string {
	const minutes = Math.max(1, Math.ceil((until - now) / 60_000));
	const wait = minutes >= 120 ? `${Math.round(minutes / 60)} hours` : `${minutes} minutes`;
	return `usage_limit_reached: this ${BRAND[provider]} account's plan limit is used up for about ${wait}, and OMPdesk's Credit use setting is off, so it does not run on ${PAID[provider]}.`;
}
