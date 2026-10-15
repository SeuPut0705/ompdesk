/**
 * What Settings › Models & accounts knows about model roles beyond stock's own
 * metadata (dependency-free: the renderer, the agent templates and the packaged
 * bridge import this one file; tested by src/main/model-role-contracts.test.ts).
 *
 * Stock owns the roles themselves: ids, names, `accepts`, the empty-role
 * fallbacks and `@role` resolution (`config/model-roles.ts`,
 * `config/model-resolver.ts`). OMPdesk adds three things stock has no notion of:
 *
 * - the grouping of the built-in roles by purpose (stock only splits chat/kind),
 * - a preset of custom roles (`modelRoles.<name>`, selected as `@name`) that the
 *   specialist agent templates consume, so each agent type can run on its own
 *   model, and
 * - the rules for a custom role's id.
 *
 * A custom role is a name in `modelRoles`; stock treats `@name` as a role only
 * while that name holds a value, and otherwise leaves it in the selector list as
 * an unmatched pattern that resolution skips (`resolveConfiguredRolePattern`,
 * `getModelRoleAlias`). Every consumer therefore lists the role first and the
 * built-in roles it should follow when empty after it, e.g. `["@review",
 * "@slow", "@task"]`: nothing needs a model assigned to work.
 */

export type RoleGroupId = "conversation" | "agent" | "io";

/** Stock's 15 built-in roles, grouped by purpose, in display order. */
export const ROLE_GROUPS: readonly { id: RoleGroupId; roles: readonly string[] }[] = [
	{ id: "conversation", roles: ["default", "slow", "smol", "plan"] },
	{ id: "agent", roles: ["task", "advisor", "commit", "memory", "tiny"] },
	{ id: "io", roles: ["vision", "image", "web", "speech", "dictation", "judge"] },
];

export const BUILTIN_ROLE_IDS: readonly string[] = ROLE_GROUPS.flatMap(group => group.roles);

/**
 * The group a role is listed under. A built-in this table does not know (a
 * newer omp's) follows stock's own split: model-kind roles under input &
 * output, the rest under agent work.
 */
export function roleGroup(id: string, stockSection: "chat" | "kind", builtin: boolean): RoleGroupId | "custom" {
	if (!builtin) return "custom";
	return ROLE_GROUPS.find(group => group.roles.includes(id))?.id ?? (stockSection === "kind" ? "io" : "agent");
}

/** A role an OMPdesk agent template consumes. */
export interface PresetRole {
	/** The `modelRoles` key; agents select it as `@id`. */
	id: string;
	/** Built-in roles an agent follows, in order, while this role is empty. */
	fallback: readonly string[];
}

export const PRESET_ROLES: readonly PresetRole[] = [
	{ id: "explore", fallback: ["smol", "task"] },
	{ id: "review", fallback: ["slow", "task"] },
	{ id: "debug", fallback: ["slow", "task"] },
	{ id: "docs", fallback: ["smol", "task"] },
	{ id: "test", fallback: ["task"] },
	{ id: "design", fallback: ["task"] },
];

export function presetRole(id: string): PresetRole | undefined {
	return PRESET_ROLES.find(role => role.id === id);
}

/**
 * The selectors an agent of this role lists in its `model:` and that
 * Settings resolves through stock to show the effective model: the role, then
 * what a preset falls back to. A user-added role has no fallback of its own.
 */
export function roleSelectors(id: string): string[] {
	return [`@${id}`, ...(presetRole(id)?.fallback ?? []).map(role => `@${role}`)];
}

/** `@name` selectors read as a role only in this shape (lowercase, no `:`/`/`, so no thinking suffix or provider confusion). */
export const CUSTOM_ROLE_ID_PATTERN = /^[a-z][a-z0-9_]{0,23}$/;

export type CustomRoleIdError = "empty" | "format" | "builtin" | "exists";

/** Why `id` cannot name a new custom role, given the ids already known. */
export function customRoleIdError(id: string, known: readonly string[]): CustomRoleIdError | undefined {
	if (id.length === 0) return "empty";
	if (!CUSTOM_ROLE_ID_PATTERN.test(id)) return "format";
	if (BUILTIN_ROLE_IDS.includes(id) || id === "default") return "builtin";
	if (known.includes(id)) return "exists";
	return undefined;
}

/** The `@role` ids an agent's `model:` (string or list, comma-separated entries too) names, without thinking suffixes. */
export function modelRoleRefs(model: string | readonly string[] | undefined): string[] {
	const entries = (Array.isArray(model) ? model : [model ?? ""]).flatMap(value => String(value).split(","));
	const refs: string[] = [];
	for (const entry of entries) {
		const match = /^\s*@([A-Za-z0-9_-]+)/.exec(entry);
		if (match?.[1] && !refs.includes(match[1])) refs.push(match[1]);
	}
	return refs;
}
