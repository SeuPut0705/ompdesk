/**
 * Model pool, GUI side: role presets, member edits, matching a subagent's
 * resolved model back to its pool member, and the per-model usage split the
 * Insights page shows. The bridge owns the instruction and persistence
 * (`resources/gui-bridge/modes/pool-core.ts`); keep `POOL_ROLES` in step with
 * its `POOL_ROLE_HINTS` (model-pool.test.ts checks).
 */
import type { ModelInfo, RpcModelPoolMember, RpcModelPoolState, SubagentSnapshot } from "../../shared/rpc-types";

/** Preset roles, in menu order. A member's `role` is one of these or free text. */
export const POOL_ROLES = ["general", "explore", "reasoning", "coding", "review"] as const;
export type PoolRoleId = (typeof POOL_ROLES)[number];

export function isPresetRole(role: string): role is PoolRoleId {
	return (POOL_ROLES as readonly string[]).includes(role);
}

/** Bridge-side cap (`MAX_POOL_MEMBERS`). */
export const MAX_POOL_MEMBERS = 8;

export const EMPTY_MODEL_POOL: RpcModelPoolState = { enabled: false, members: [] };

/** The task tool's `model` selector for a catalog model. */
export function modelSelector(model: Pick<ModelInfo, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

/** Append a model (no-op when present or the pool is full); a new member starts as a general worker. */
export function addPoolMember(pool: RpcModelPoolState, member: Omit<RpcModelPoolMember, "role">): RpcModelPoolState {
	if (pool.members.length >= MAX_POOL_MEMBERS) return pool;
	if (pool.members.some(existing => existing.selector === member.selector)) return pool;
	return { ...pool, members: [...pool.members, { ...member, role: "general" }] };
}

/** Remove a model; a pool left with fewer than two models switches off. */
export function removePoolMember(pool: RpcModelPoolState, selector: string): RpcModelPoolState {
	const members = pool.members.filter(member => member.selector !== selector);
	return { enabled: pool.enabled && members.length >= 2, members };
}

export function setPoolMemberRole(pool: RpcModelPoolState, selector: string, role: string): RpcModelPoolState {
	return {
		...pool,
		members: pool.members.map(member => (member.selector === selector ? { ...member, role } : member)),
	};
}

/**
 * The pool member a subagent ran on. `resolvedModel` is the serving selector,
 * optionally with a thinking suffix (`provider/model:high`); model ids may
 * themselves contain `:`, so match the whole selector or selector + `:`.
 */
export function poolMemberFor(
	pool: RpcModelPoolState | null,
	resolvedModel: string | undefined,
): RpcModelPoolMember | undefined {
	if (!pool?.enabled || !resolvedModel) return undefined;
	return pool.members.find(
		member => resolvedModel === member.selector || resolvedModel.startsWith(`${member.selector}:`),
	);
}

export interface ModelUsageRow {
	/** Serving selector; the main agent's own row uses its current model. */
	model: string;
	/** Pool member for the model, when the pool is on and lists it. */
	member?: RpcModelPoolMember;
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
 * Per-model usage for one session: the main agent's stock session stats plus
 * every subagent's own usage, grouped by the model it ran on. Subagents without
 * a resolved model (not started yet) are left out. Largest token share first.
 */
export function usageByModel(
	main: MainUsage | null,
	subagents: Iterable<SubagentSnapshot>,
	pool: RpcModelPoolState | null,
): ModelUsageRow[] {
	const rows = new Map<string, ModelUsageRow>();
	const row = (model: string, isMain: boolean): ModelUsageRow => {
		const key = `${isMain ? "main" : "sub"}\u0000${model}`;
		let existing = rows.get(key);
		if (!existing) {
			existing = {
				model,
				member: poolMemberFor(pool, model),
				main: isMain,
				agents: 0,
				requests: 0,
				tokens: 0,
				cost: 0,
				share: 0,
			};
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
