/**
 * Which model judges `ompdesk_compare` (agent-control.ts `agent_control.judge`). Pure and dependency-free so the
 * rules are testable without a session.
 *
 * The judge is a second opinion on work the caller's model directed, so it is picked from stock's `advisor` chain
 * (configured advisor, else configured `slow`, else `slow`'s built-in list), then `slow`'s own chain, preferring a
 * model whose family differs from the main model's, as stock's advisor intends.
 */

/** Roles tried in order; the first credentialed cross-family candidate wins, else the first credentialed one. */
export const JUDGE_ROLES = ["advisor", "slow"] as const;

/** What a model's lineage is read from: stock's `Model.identity.class` (the vendor lineage; "unknown" unclassified). */
export interface FamilyBearing {
	identity?: { class?: string };
}

/** The model's lineage, or null when stock has none for it (missing, empty or "unknown"). */
export function modelFamily(model: FamilyBearing | null | undefined): string | null {
	const family = model?.identity?.class;
	if (typeof family !== "string") return null;
	const trimmed = family.trim();
	return trimmed === "" || trimmed.toLowerCase() === "unknown" ? null : trimmed;
}

/** Whether two models come from different lineages; null when either lineage is unknown (not evidence of either). */
export function crossFamily(a: FamilyBearing | null | undefined, b: FamilyBearing | null | undefined): boolean | null {
	const first = modelFamily(a);
	const second = modelFamily(b);
	return first === null || second === null ? null : first !== second;
}
