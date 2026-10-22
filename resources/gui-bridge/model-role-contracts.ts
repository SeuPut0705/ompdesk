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

/**
 * `get_model_roles` on the wire. Every role lists its candidate models, and most roles take the same chat models, so
 * the plain answer repeats one list once a role: a paired device's Settings read 882 KB for it from a host with many
 * providers. A caller that asks (`compact: true`) gets each model once (`candidateModels`) and each role's
 * candidates as indexes into it; {@link expandModelRoles} turns that back into the plain answer. An older host
 * ignores the flag and answers plain, which expanding leaves as it is; an older device never asks. The bridge
 * compacts, the RPC client (`src/shared/rpc-client.ts`) expands.
 */

export interface WireCandidate {
	provider: string;
	id: string;
	name?: string;
	kind?: string;
}

/** What compacting needs of a role: its candidates, whatever else it carries. */
export interface RoleWithCandidates<C = WireCandidate> {
	candidates?: C[];
}

export interface CompactModelRoles<R> {
	roles: Array<Omit<R, "candidates"> & { candidates?: number[] }>;
	candidateModels: WireCandidate[];
}

/** Each distinct candidate once, each role's candidates as indexes into that list, in the order the role lists them. */
export function compactModelRoles<R extends RoleWithCandidates>(roles: R[]): CompactModelRoles<R> {
	const candidateModels: WireCandidate[] = [];
	const index = new Map<string, number>();
	const at = (candidate: WireCandidate): number => {
		const key = JSON.stringify([candidate.provider, candidate.id, candidate.name ?? null, candidate.kind ?? null]);
		let found = index.get(key);
		if (found === undefined) {
			found = candidateModels.length;
			candidateModels.push(candidate);
			index.set(key, found);
		}
		return found;
	};
	return {
		roles: roles.map(role => {
			if (!role.candidates) return role as Omit<R, "candidates">;
			return { ...role, candidates: role.candidates.map(at) };
		}),
		candidateModels,
	};
}

/** The plain answer of `get_model_roles` from either form; anything that is not the compact form passes through. */
export function expandModelRoles(data: unknown): unknown {
	if (typeof data !== "object" || data === null) return data;
	const { roles, candidateModels, ...rest } = data as { roles?: unknown; candidateModels?: unknown };
	if (!Array.isArray(roles) || !Array.isArray(candidateModels)) return data;
	return {
		...rest,
		roles: roles.map(role => {
			const candidates = (role as { candidates?: unknown }).candidates;
			if (!Array.isArray(candidates)) return role;
			return {
				...role,
				candidates: candidates.flatMap(i =>
					typeof i === "number" && candidateModels[i] ? [candidateModels[i]] : [],
				),
			};
		}),
	};
}
