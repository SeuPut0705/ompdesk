/**
 * The model setup's planner: one model per role from the connected accounts'
 * models by fixed rules, no model call, the same answer for the same input.
 * Pure (no omp import): the input is `get_model_roles` (any role id, stock's or
 * OMPdesk's) plus `get_model_setup_facts` and the usage reports' headroom, so
 * main's metering test and the renderer run the very same function.
 *
 * Full auto (`full`) plans over subscription and free models only; a metered
 * model (API key, OpenRouter, any custom or moved endpoint) never reaches it.
 * Model kind roles (image, speech, judge, …) stay on stock's own chain there.
 * Picked (`picked`) plans over the models the person ticked, metered included.
 */
import { HIDDEN_ROLE_IDS } from "../../resources/gui-bridge/model-role-contracts";
import type {
	Billing,
	BillingBasis,
	ModelSetupFacts,
	SetupModelFacts,
} from "../../resources/gui-bridge/model-setup-contracts";

export type PlanMode = "full" | "picked";

export interface PlanRoleInput {
	id: string;
	section: "chat" | "kind";
	hidden?: boolean;
	/** The role's candidate pool as `provider/id`, stock's order. */
	candidates: readonly string[];
	/** What the role holds now (any thinking suffix). */
	current?: string;
}

export interface RolePlanInput {
	mode: PlanMode;
	roles: readonly PlanRoleInput[];
	facts: ModelSetupFacts;
	/** `picked` only: the models the person allowed. */
	picked?: readonly string[];
	/** The model the default role runs on now. */
	defaultModel?: string;
	/** Provider → remaining fraction (0–1) of its roomiest account's tightest window; absent = not reported. */
	headroom?: Readonly<Record<string, number>>;
	/** Role → the model OMPdesk's last apply on this machine wrote. */
	lastApplied?: Readonly<Record<string, string>>;
}

export type PlanRule =
	/** The default role keeps the model it runs on. */
	| "default"
	/** Strongest models (slow, plan): within 85 % of the top intelligence. */
	| "strong"
	/** Strong, from another vendor than the default when one qualifies. */
	| "advisor"
	/** Cheapest model within 70 % of the top intelligence (smol, tiny, commit). */
	| "cheap"
	/** Most intelligence per price within 95 % of the top (task). */
	| "task"
	/** The default's model when it reads images, else the strongest that does. */
	| "vision"
	/** A chat role these rules do not name: the default role's model. */
	| "chat"
	/** A model kind role: stock's own chain, nothing written. */
	| "stock"
	| "no-candidate";

/** The facts a row's reason sentence is built from (rendered behind its ⓘ). */
export interface PlanReason {
	rule: PlanRule;
	billing?: Billing;
	basis?: BillingBasis;
	int?: number;
	/** Highest intelligence in the role's allowed pool. */
	topInt?: number;
	outputPrice?: number;
	/** The pool's dearest output price, for a cheap pick; the cheapest, for a strong one. */
	comparePrice?: number;
	/** The chosen model's provider headroom, when reported. */
	headroom?: number;
	/** Advisor only: the chosen model's vendor differs from the default's. */
	crossVendor?: boolean;
	contextWindow?: number;
}

export interface PlanRow {
	role: string;
	/** `provider/id` to write; null = leave the role to stock (nothing written). */
	model: string | null;
	/** What the role holds now. */
	current?: string;
	/** config.yml holds a value OMPdesk's last apply did not write: kept unless the person ticks it. */
	manual: boolean;
	/** Ticked by default: something to write, not manual, not already that model. */
	checked: boolean;
	reason: PlanReason;
}

/** A model setup role value without its `:thinking` suffix (stock `splitThinkingSuffix`), so `p/m:high` equals `p/m`. */
const THINKING_SUFFIX = /:(?:off|minimal|low|medium|high|xhigh|max|auto)$/;
export function baseSelector(value: string | undefined): string | undefined {
	return value?.trim().replace(THINKING_SUFFIX, "") || undefined;
}

type Tier = "default" | "strong" | "advisor" | "cheap" | "task" | "vision";

/** OMPdesk's reading of stock's built-in chat roles; any other chat role takes the default's model. */
const TIERS: Readonly<Record<string, Tier>> = {
	default: "default",
	slow: "strong",
	plan: "strong",
	advisor: "advisor",
	smol: "cheap",
	tiny: "cheap",
	commit: "cheap",
	task: "task",
	vision: "vision",
};

/** Context a cheap role needs at least (a commit reads whole diffs; a title needs little). */
const CONTEXT_FLOOR: Readonly<Record<string, number>> = { commit: 100_000, tiny: 8_000 };

const STRONG_SHARE = 0.85;
const CHEAP_SHARE = 0.7;
const TASK_SHARE = 0.95;
/** A provider below this much headroom yields to one above it, when one qualifies. */
const MIN_HEADROOM = 0.2;

function providerOf(facts: ModelSetupFacts, selector: string): string {
	return facts.models[selector]?.provider ?? selector.slice(0, selector.indexOf("/"));
}

/** The billing class of `selector`'s provider; a provider the facts do not name is metered (fail closed). */
export function billingOf(facts: ModelSetupFacts, selector: string): Billing {
	return facts.providers[providerOf(facts, selector)]?.billing ?? "metered";
}

/** Whether full auto may use `selector` at all. */
export function fullAutoAllows(facts: ModelSetupFacts, selector: string): boolean {
	return billingOf(facts, selector) !== "metered";
}

interface Candidate {
	selector: string;
	model: SetupModelFacts;
	/** Index in stock's pool, the last tie-break. */
	order: number;
}

function int(candidate: Candidate): number {
	return candidate.model.int ?? Number.NEGATIVE_INFINITY;
}

function price(candidate: Candidate): number {
	return candidate.model.outputPrice ?? Number.POSITIVE_INFINITY;
}

function byOrder(a: Candidate, b: Candidate): number {
	return a.order - b.order;
}

function strongest(pool: readonly Candidate[]): Candidate | undefined {
	return [...pool].sort((a, b) => int(b) - int(a) || price(a) - price(b) || byOrder(a, b))[0];
}

function topInt(pool: readonly Candidate[]): number | undefined {
	const scored = pool.filter(candidate => candidate.model.int !== undefined);
	return scored.length > 0 ? Math.max(...scored.map(int)) : undefined;
}

/** Candidates at or above `share` of the pool's top intelligence; with no score known, the whole pool. */
function within(pool: readonly Candidate[], share: number): Candidate[] {
	const top = topInt(pool);
	return top === undefined ? [...pool] : pool.filter(candidate => int(candidate) >= top * share);
}

/** The role's allowed pool, with low-headroom providers dropped when another qualifies. */
function poolFor(input: RolePlanInput, role: PlanRoleInput): Candidate[] {
	const picked = input.mode === "picked" ? new Set(input.picked ?? []) : undefined;
	const pool = role.candidates.flatMap((selector, order): Candidate[] => {
		const model = input.facts.models[selector];
		if (!model) return [];
		if (picked ? !picked.has(selector) : !fullAutoAllows(input.facts, selector)) return [];
		return [{ selector, model, order }];
	});
	const roomy = pool.filter(candidate => (input.headroom?.[candidate.model.provider] ?? 1) >= MIN_HEADROOM);
	return roomy.length > 0 ? roomy : pool;
}

function defaultPick(input: RolePlanInput, pool: readonly Candidate[]): Candidate | undefined {
	const current = baseSelector(input.defaultModel);
	return pool.find(candidate => candidate.selector === current) ?? strongest(pool);
}

function pick(
	input: RolePlanInput,
	role: PlanRoleInput,
	tier: Tier,
	pool: readonly Candidate[],
): { chosen?: Candidate; reason: Partial<PlanReason> } {
	switch (tier) {
		case "default":
			return { chosen: defaultPick(input, pool), reason: {} };
		case "strong": {
			const chosen = strongest(within(pool, STRONG_SHARE));
			const cheapest = Math.min(...pool.map(price));
			return { chosen, reason: Number.isFinite(cheapest) ? { comparePrice: cheapest } : {} };
		}
		case "advisor": {
			const strong = within(pool, STRONG_SHARE);
			const base = baseSelector(input.defaultModel);
			const family = base ? input.facts.models[base]?.family : undefined;
			const known = (value: string | undefined) => value !== undefined && value !== "unknown";
			const other = known(family)
				? strong.filter(candidate => known(candidate.model.family) && candidate.model.family !== family)
				: [];
			const chosen =
				strongest(other) ?? strongest(strong.filter(candidate => candidate.selector !== base)) ?? strongest(strong);
			return { chosen, reason: { crossVendor: other.length > 0 && chosen !== undefined && other.includes(chosen) } };
		}
		case "cheap": {
			const floor = CONTEXT_FLOOR[role.id];
			const roomy =
				floor === undefined
					? within(pool, CHEAP_SHARE)
					: within(pool, CHEAP_SHARE).filter(candidate => (candidate.model.contextWindow ?? 0) >= floor);
			const chosen = [...roomy].sort((a, b) => price(a) - price(b) || int(b) - int(a) || byOrder(a, b))[0];
			const dearest = Math.max(...pool.map(price).filter(Number.isFinite));
			return { chosen, reason: Number.isFinite(dearest) ? { comparePrice: dearest } : {} };
		}
		case "task": {
			const value = (candidate: Candidate) => {
				const cost = price(candidate);
				return cost > 0 ? int(candidate) / cost : Number.POSITIVE_INFINITY;
			};
			const chosen = [...within(pool, TASK_SHARE)].sort(
				(a, b) => value(b) - value(a) || int(b) - int(a) || byOrder(a, b),
			)[0];
			return { chosen, reason: {} };
		}
		case "vision": {
			const seeing = pool.filter(candidate => candidate.model.image);
			return { chosen: defaultPick(input, seeing), reason: {} };
		}
	}
}

/** One row per listed role (stock's hidden ones left out), in `roles` order. */
export function planRoles(input: RolePlanInput): PlanRow[] {
	return input.roles
		.filter(role => !role.hidden && !HIDDEN_ROLE_IDS.includes(role.id))
		.map(role => {
			const persisted = input.facts.roles[role.id]?.persisted;
			const manual =
				persisted !== undefined && baseSelector(persisted) !== baseSelector(input.lastApplied?.[role.id]);
			const base = { role: role.id, ...(role.current ? { current: role.current } : {}), manual };
			if (role.section === "kind") {
				return { ...base, model: null, checked: false, reason: { rule: "stock" as const } };
			}
			const tier = TIERS[role.id];
			const pool = poolFor(input, role);
			const { chosen, reason } = pick(input, role, tier ?? "default", pool);
			if (!chosen) return { ...base, model: null, checked: false, reason: { rule: "no-candidate" as const } };
			const provider = input.facts.providers[chosen.model.provider];
			const headroom = input.headroom?.[chosen.model.provider];
			const top = topInt(pool);
			return {
				...base,
				model: chosen.selector,
				checked: !manual && chosen.selector !== baseSelector(role.current),
				reason: {
					rule: tier ?? "chat",
					billing: provider?.billing ?? "metered",
					...(provider ? { basis: provider.basis } : {}),
					...(chosen.model.int !== undefined ? { int: chosen.model.int } : {}),
					...(top !== undefined ? { topInt: top } : {}),
					...(chosen.model.outputPrice !== undefined ? { outputPrice: chosen.model.outputPrice } : {}),
					...(chosen.model.contextWindow !== undefined ? { contextWindow: chosen.model.contextWindow } : {}),
					...(headroom !== undefined ? { headroom } : {}),
					...reason,
				},
			};
		});
}

/**
 * What changes the model setup would want to know about since its last apply:
 * the roles listed, the models each can use and their providers' billing.
 * Equal signatures = nothing new to offer.
 */
export function setupSignature(roles: readonly PlanRoleInput[], facts?: ModelSetupFacts): string {
	const parts = [...roles]
		.filter(role => !role.hidden && !HIDDEN_ROLE_IDS.includes(role.id))
		.sort((a, b) => a.id.localeCompare(b.id))
		.map(role => `${role.id}=${[...role.candidates].sort().join(",")}`);
	if (facts) {
		parts.push(
			Object.entries(facts.providers)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([provider, { billing }]) => `${provider}:${billing}`)
				.join(","),
		);
	}
	return parts.join("\n");
}
