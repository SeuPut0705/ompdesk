/**
 * Model roles OMPdesk adds beyond stock's built-ins (dependency-free: main, the
 * renderer and the packaged bridge import this one file).
 *
 * An OMPdesk role is stock's own `modelRoles.<id>` held as a runtime override
 * on every omp OMPdesk runs (`ompdesk-roles.ts`): never written to config.yml,
 * so the omp CLI stays stock, and never over a value the user's config.yml or
 * project config sets for the id. While nothing is picked the role follows its
 * chain (`chain` after the role itself); a pick goes first and the chain stays
 * behind it, so `@<id>` always lands on a model the account can run. Stock's
 * `@<id>` resolution, subagent inheritance and the agent `model:` lists then
 * treat it like any role.
 *
 * Picks live in one JSON file per computer (`OMP_GUI_OMPDESK_ROLES`, a path in
 * OMPdesk's userData) that every omp this computer runs reads at each turn, so
 * a pick on any tab, or a paired device's tab on this host, reaches them all.
 */

export interface OmpdeskRole {
	id: string;
	/** Stock-style English display name (the renderer translates it like a built-in role's). */
	name: string;
	/** `@<id>` first, then the roles it follows while empty, in order. */
	chain: readonly string[];
}

export const OMPDESK_ROLES: readonly OmpdeskRole[] = [
	// Cross-family code review: the advisor is stock's "distinct strong model", so an empty review follows it.
	{ id: "review", name: "Review", chain: ["@review", "@advisor", "@slow", "@task"] },
];

export const OMPDESK_ROLE_IDS: readonly string[] = OMPDESK_ROLES.map(role => role.id);

/**
 * Bundled stock agents that ship without a `model:` line and so run on the parent session's model, held to a
 * tier through stock's `task.agentModelOverrides` (agent name → model list, first available wins).
 */
export const AGENT_TIERS: Readonly<Record<string, readonly string[]>> = {
	"security-reviewer": ["@review", "@slow"],
};

/** Env var naming the picks file (absolute path) for every omp OMPdesk spawns. */
export const OMPDESK_ROLES_ENV = "OMP_GUI_OMPDESK_ROLES";

/** File name of the picks file in OMPdesk's userData. */
export const OMPDESK_ROLES_FILE = "ompdesk-roles.json";

/** The runtime value held for `role`: the pick (if any), then the chain after the role itself. */
export function heldRoleValue(role: OmpdeskRole, pick: string | undefined): string {
	return [...(pick ? [pick] : []), ...role.chain.slice(1)].join(",");
}

/** The picks file's content as role id → model selector; anything else in it is ignored. */
export function parseRolePicks(raw: unknown): Record<string, string> {
	const picks: Record<string, string> = {};
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return picks;
	for (const id of OMPDESK_ROLE_IDS) {
		const value = (raw as Record<string, unknown>)[id];
		// A selector is one model (`provider/id[:level]`): no list, no role alias, nothing to inject.
		if (typeof value === "string" && /^[^\s,@]+$/.test(value)) picks[id] = value;
	}
	return picks;
}
