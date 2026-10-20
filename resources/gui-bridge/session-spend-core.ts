/**
 * What a session's journal has spent, per provider (dependency-free; `session_spend` in model-setup-facts.ts adds
 * each provider's billing class).
 *
 * The entries are the ones stock's own whole-journal tally reads (`SessionManager.getUsageStatistics`, `entryUsage`
 * in session-manager.ts): assistant replies, `model_usage` rows (judge calls, auto-thinking, title checks and every
 * other off-transcript model call, journaled by `journalJudgmentUsage` into the session they served) and completed
 * `task` results. Stock's tally is one number; this splits it by the provider that served each call, so a metered
 * provider's charge never mixes with a subscription's API-price estimate. A `task` result counts through its
 * per-subagent `results[].usage` and `resolvedModel` (`SingleResult`); one without them names no provider and is
 * left out. Each cost is stock's: OpenRouter's billed `usage.cost` (`applyProviderReportedCost`, the decisions wire)
 * or the catalog's list price for the rest.
 */
export interface ProviderSpend {
	/** USD over the whole journal. */
	cost: number;
	/** USD of the entries at or after the day's start. */
	today: number;
}

interface Charge {
	provider: string;
	cost: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function costOf(usage: unknown): number {
	const total = record(record(usage)?.cost)?.total;
	return typeof total === "number" && Number.isFinite(total) && total > 0 ? total : 0;
}

/** `openrouter/qwen/qwen-4:high` → `openrouter`. */
function providerOfModel(model: unknown): string | undefined {
	if (typeof model !== "string") return undefined;
	const slash = model.indexOf("/");
	return slash > 0 ? model.slice(0, slash) : undefined;
}

function* charges(entry: Record<string, unknown>): Generator<Charge> {
	if (entry.type === "model_usage") {
		if (typeof entry.provider === "string") yield { provider: entry.provider, cost: costOf(entry.usage) };
		return;
	}
	if (entry.type !== "message") return;
	const message = record(entry.message);
	if (message?.role === "assistant") {
		if (typeof message.provider === "string") yield { provider: message.provider, cost: costOf(message.usage) };
		return;
	}
	if (message?.role !== "toolResult" || message.toolName !== "task") return;
	const results = record(message.details)?.results;
	if (!Array.isArray(results)) return;
	for (const result of results) {
		const row = record(result);
		const provider = providerOfModel(row?.resolvedModel);
		if (provider) yield { provider, cost: costOf(row?.usage) };
	}
}

export function spendByProvider(entries: readonly unknown[], dayStartMs: number): Record<string, ProviderSpend> {
	const spend: Record<string, ProviderSpend> = {};
	for (const value of entries) {
		const entry = record(value);
		if (!entry) continue;
		const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
		for (const { provider, cost } of charges(entry)) {
			if (cost === 0) continue;
			const row = spend[provider] ?? { cost: 0, today: 0 };
			row.cost += cost;
			if (at >= dayStartMs) row.today += cost;
			spend[provider] = row;
		}
	}
	return spend;
}

/** The local day's start, in the host's time zone. */
export function dayStart(now: number): number {
	const day = new Date(now);
	day.setHours(0, 0, 0, 0);
	return day.getTime();
}
