/**
 * `task.agentAccountPools` (omp 18.8.1+): agent name → provider id → the
 * OAuth identity keys that agent (and its advisors, title generation, nested
 * subagents and resumed sessions) may authenticate with. omp matches a key
 * exactly against `resolveCredentialIdentityKey` (the string `omp usage
 * accounts` prints and the bridge reports per account). A listed provider uses
 * only those accounts and never an API key; an empty list allows none, so the
 * editor drops a provider once its last account is unchecked (none checked =
 * unrestricted). A `null` agent entry clears a lower layer's pool; it is kept
 * as is until that agent is edited.
 */

import { z } from "zod";

export const AGENT_ACCOUNT_POOLS_PATH = "task.agentAccountPools";

export type ProviderPools = Readonly<Record<string, readonly string[]>>;
export type AgentAccountPools = Readonly<Record<string, ProviderPools | null>>;

/** omp's own validator (`validateAgentAccountPools`): non-empty, untrimmed-free keys. */
const identityKey = z
	.string()
	.min(1)
	.refine(key => key.trim() === key);
const poolsSchema = z.record(z.string(), z.union([z.null(), z.record(z.string(), z.array(identityKey))]));

/**
 * The stored map, or `null` when it is not one omp would load (the editor then
 * leaves it to the Advanced JSON row instead of overwriting it). An absent value
 * reads as no pools.
 */
export function parseAgentAccountPools(value: unknown): AgentAccountPools | null {
	if (value === undefined || value === null) return {};
	const parsed = poolsSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

/** The keys `agent` is held to for `provider`, or `undefined` when that provider is unrestricted for it. */
export function poolFor(pools: AgentAccountPools, agent: string, provider: string): readonly string[] | undefined {
	const providers = Object.hasOwn(pools, agent) ? pools[agent] : null;
	return providers && Object.hasOwn(providers, provider) ? providers[provider] : undefined;
}

/** Whether `identityKey` is in `agent`'s pool for `provider` (omp's exact match). */
export function poolIncludes(pools: AgentAccountPools, agent: string, provider: string, identityKey: string): boolean {
	return poolFor(pools, agent, provider)?.includes(identityKey) === true;
}

/** Providers `agent` is restricted on (an own, non-null entry). */
export function restrictedProviders(pools: AgentAccountPools, agent: string): string[] {
	const providers = Object.hasOwn(pools, agent) ? pools[agent] : null;
	return providers ? Object.keys(providers) : [];
}

const withoutKey = <T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> => {
	const next: Record<string, T> = {};
	for (const [name, value] of Object.entries(record)) if (name !== key) next[name] = value;
	return next;
};

/**
 * `pools` with `identityKey` added to or removed from `agent`'s `provider`
 * pool. Removing the last key drops the provider (an empty list would allow
 * no account), and an agent left without providers drops out entirely.
 */
export function togglePoolAccount(
	pools: AgentAccountPools,
	agent: string,
	provider: string,
	identityKey: string,
	allowed: boolean,
): AgentAccountPools {
	const providers: ProviderPools = (Object.hasOwn(pools, agent) ? pools[agent] : null) ?? {};
	const current = Object.hasOwn(providers, provider) ? providers[provider] : [];
	const keys = allowed
		? current.includes(identityKey)
			? current
			: [...current, identityKey]
		: current.filter(key => key !== identityKey);
	const nextProviders = keys.length > 0 ? { ...providers, [provider]: keys } : withoutKey(providers, provider);
	return Object.keys(nextProviders).length > 0 ? { ...pools, [agent]: nextProviders } : withoutKey(pools, agent);
}

/** `pools` with `agent` unrestricted (its entry removed). */
export function clearAgentPool(pools: AgentAccountPools, agent: string): AgentAccountPools {
	return withoutKey(pools, agent);
}

/**
 * The value set_setting writes: `undefined` (drop the override from
 * config.yml) when no agent has a pool left, else the map itself.
 */
export function serializeAgentAccountPools(pools: AgentAccountPools): AgentAccountPools | undefined {
	return Object.keys(pools).length > 0 ? pools : undefined;
}
