/**
 * What Settings › Models & accounts knows about model roles beyond stock's own
 * metadata (dependency-free: the renderer and the packaged bridge import this
 * one file; tested by src/main/model-role-contracts.test.ts).
 *
 * Stock owns the roles themselves: ids, names, tags, sections, `accepts`, the
 * empty-role fallbacks and `@role` resolution (`config/model-roles.ts`,
 * `config/model-resolver.ts`); the bridge reads every one of them at runtime
 * (`settings.ts` `roleMetadata`), so a role a newer omp adds is listed without a
 * change here. OMPdesk adds only an ordering preference that groups the roles by
 * purpose (stock only splits chat/kind), the roles it hides, each with why, and
 * its own runtime roles (ompdesk-role-contracts.ts). A `modelRoles.<name>` the
 * user set elsewhere is left to stock, which still honours it as `@name`.
 */

export type RoleGroupId = "conversation" | "agent" | "io";

/** Stock roles OMPdesk does not list, each with the reason (src/main/model-roles-stock-coverage.test.ts checks one is given). */
export const HIDDEN_ROLES: Readonly<Record<string, string>> = {
	memory:
		"Serves stock's own memory backends, which OMPdesk replaced with ai-memory (no LLM involved). Stock keeps the role; Settings and the model setup skip it.",
};

export const HIDDEN_ROLE_IDS: readonly string[] = Object.keys(HIDDEN_ROLES);

/**
 * Ordering preference only: the purpose group and place of the roles OMPdesk knows today. A role not in it (a
 * newer omp's) is still listed, grouped by stock's section (`roleGroup`) after these, in stock's order.
 */
export const ROLE_GROUPS: readonly { id: RoleGroupId; roles: readonly string[] }[] = [
	{ id: "conversation", roles: ["default", "slow", "smol", "plan"] },
	{ id: "agent", roles: ["task", "advisor", "commit", "tiny", "widget"] },
	{ id: "io", roles: ["vision", "image", "web", "speech", "dictation", "judge"] },
];

/** The preferred display order across groups; roles outside it sort after, in the order stock lists them. */
export const ROLE_ORDER: readonly string[] = ROLE_GROUPS.flatMap(group => group.roles);

/** The group a role is listed under: its place in `ROLE_GROUPS`, else stock's split (model-kind roles under input & output, the rest under agent work). */
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
