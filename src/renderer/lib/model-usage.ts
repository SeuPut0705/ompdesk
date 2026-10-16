/**
 * Per-model usage for the Insights page (Usage by model): the main agent's stock session stats plus every
 * subagent's own usage, grouped by the model it ran on, and the selector the `task` tool and model roles use for a
 * catalog model.
 */
import type { ModelInfo, SubagentSnapshot } from "../../shared/rpc-types";

/** The `provider/id` selector stock's role and `task` model values use for a catalog model. */
export function modelSelector(model: Pick<ModelInfo, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

export interface ModelUsageRow {
	/** Serving selector; the main agent's own row uses its current model. */
	model: string;
	/** The main agent's row (stock session stats). */
	main: boolean;
	/** Subagents that ran on this model. */
	agents: number;
	requests: number;
	tokens: number;
	cost: number;
	/** Fraction of all tokens in the split, 0–1. */
	share: number;
}

export interface MainUsage {
	model: string;
	requests: number;
	tokens: number;
	cost: number;
}

/**
 * Per-model usage for one session. Subagents without a resolved model (not started yet) are left out. Largest
 * token share first.
 */
export function usageByModel(main: MainUsage | null, subagents: Iterable<SubagentSnapshot>): ModelUsageRow[] {
	const rows = new Map<string, ModelUsageRow>();
	const row = (model: string, isMain: boolean): ModelUsageRow => {
		const key = `${isMain ? "main" : "sub"}\u0000${model}`;
		let existing = rows.get(key);
		if (!existing) {
			existing = { model, main: isMain, agents: 0, requests: 0, tokens: 0, cost: 0, share: 0 };
			rows.set(key, existing);
		}
		return existing;
	};
	if (main) {
		const entry = row(main.model, true);
		entry.requests += main.requests;
		entry.tokens += main.tokens;
		entry.cost += main.cost;
	}
	for (const agent of subagents) {
		const progress = agent.progress;
		if (!progress?.resolvedModel) continue;
		const entry = row(progress.resolvedModel, false);
		entry.agents += 1;
		entry.requests += progress.requests;
		entry.tokens += progress.tokens;
		entry.cost += progress.cost;
	}
	const list = [...rows.values()];
	const total = list.reduce((sum, entry) => sum + entry.tokens, 0);
	for (const entry of list) entry.share = total > 0 ? entry.tokens / total : 0;
	return list.sort((a, b) => b.tokens - a.tokens || Number(b.main) - Number(a.main) || a.model.localeCompare(b.model));
}
