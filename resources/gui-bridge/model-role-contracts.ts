/**
 * What Settings › Models & accounts knows about model roles beyond stock's own
 * metadata (dependency-free: the renderer and the packaged bridge import this
 * one file; tested by src/main/model-role-contracts.test.ts).
 *
 * Stock owns the roles themselves: ids, names, `accepts`, the empty-role
 * fallbacks and `@role` resolution (`config/model-roles.ts`,
 * `config/model-resolver.ts`). OMPdesk adds only the grouping of the built-in
 * roles by purpose (stock only splits chat/kind). OMPdesk lists and offers no
 * custom role: a `modelRoles.<name>` the user set elsewhere is left to stock,
 * which still honours it as `@name`.
 */

export type RoleGroupId = "conversation" | "agent" | "io";

/**
 * Stock's built-in roles OMPdesk does not list: `memory` belongs to stock's own memory backends, which OMPdesk
 * replaced with ai-memory (no LLM involved). Stock keeps the role; Settings and the model setup just skip it.
 */
export const HIDDEN_ROLE_IDS: readonly string[] = ["memory"];

/** Stock's built-in roles OMPdesk lists, grouped by purpose, in display order. */
export const ROLE_GROUPS: readonly { id: RoleGroupId; roles: readonly string[] }[] = [
	{ id: "conversation", roles: ["default", "slow", "smol", "plan"] },
	{ id: "agent", roles: ["task", "advisor", "commit", "tiny"] },
	{ id: "io", roles: ["vision", "image", "web", "speech", "dictation", "judge"] },
];

/** Every stock built-in role: the listed ones in display order, then the hidden ones. */
export const BUILTIN_ROLE_IDS: readonly string[] = [...ROLE_GROUPS.flatMap(group => group.roles), ...HIDDEN_ROLE_IDS];

/**
 * The group a built-in role is listed under. One this table does not know (a
 * newer omp's) follows stock's own split: model-kind roles under input &
 * output, the rest under agent work.
 */
export function roleGroup(id: string, stockSection: "chat" | "kind"): RoleGroupId {
	return ROLE_GROUPS.find(group => group.roles.includes(id))?.id ?? (stockSection === "kind" ? "io" : "agent");
}

/**
 * The candidate stock prefers first for an empty built-in role when no provider holds credentials for it, so the
 * role runs on a later one (`role-effective.ts`). Stock's own chain and catalog supply every field.
 */
export interface SkippedPreferred {
	/** The preferred candidate's display name (stock's catalog name, else its id). */
	name: string;
	/** `provider/id`. */
	model: string;
	/** Stock's `modelKind` of that class of candidate (`judge` for a native judge model). */
	kind: string;
	/** Provider ids that hold the preferred class of candidate, in stock's preference order; a key for any one of them lifts the skip. */
	providers: string[];
}
