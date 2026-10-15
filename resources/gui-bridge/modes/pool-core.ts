/**
 * Model pool, pure half: the wire shape, its normalization, how a pool is
 * persisted in (and restored from) the session journal, and the orchestration
 * instruction the main agent receives while the pool is on.
 *
 * Routing rides the task tool's own per-item `model` field (`provider/model`
 * selector, top of stock's model precedence), so no agent definitions are
 * generated and nothing outside this session changes. No omp imports, no Bun
 * globals: the GUI's vitest exercises this file directly
 * (src/renderer/lib/model-pool.test.ts).
 */
import {
	EMPTY_POOL,
	isPresetRole,
	normalizePool,
	POOL_ROLE_HINTS,
	type PoolState,
	poolIsActive,
} from "../pool-contracts";

/** `customType` of the journal entry recording the session's pool; the latest one on the branch wins. */
export const POOL_ENTRY_TYPE = "ompdesk.model-pool";

export interface JournalEntry {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
}

/** The pool recorded on a branch (root → leaf): the last entry wins; none recorded = empty, off. */
export function poolFromEntries(entries: readonly JournalEntry[]): PoolState {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type === "custom" && entry.customType === POOL_ENTRY_TYPE) return normalizePool(entry.data);
	}
	return { ...EMPTY_POOL, members: [] };
}

export function roleHint(role: string): string {
	return isPresetRole(role) ? POOL_ROLE_HINTS[role] : role;
}

/** The system-prompt section that turns the main agent into the pool's orchestrator; `undefined` when inactive. */
export function buildPoolInstruction(pool: PoolState): string | undefined {
	if (!poolIsActive(pool)) return undefined;
	const roster = pool.members.map(member => `- \`${member.selector}\` (${member.name}): ${roleHint(member.role)}`);
	return [
		"<model-pool>",
		"The user turned on a model pool for this session: they want work spread across the models below in parallel, and they accept the extra token cost. You are the orchestrator, not the worker.",
		"",
		"Pool models (selector, name: strength):",
		...roster,
		"",
		"For every request that needs tool use or has more than one part, however small:",
		"1. Decompose it into independent subtasks with clear boundaries.",
		"2. Assign each subtask to the pool model whose strength fits it best, weighing cost: cheap, fast models for exploration and mechanical work; strong models for hard reasoning.",
		"3. Dispatch them in parallel in a single `task` call, setting each item's `model` to that member's selector exactly as listed. Use at least two different pool models whenever there are two or more subtasks.",
		"4. Integrate the results yourself and cross-check them; when correctness matters, have a different pool model review another model's output before you answer.",
		"",
		"If a subtask fails because its model errored (model not found / 404, auth, quota or rate limit, overload) rather than because of the work itself, do not retry that model: re-dispatch the same subtask to another pool member in your next `task` call, stop assigning work to the failed model for the rest of the session, and tell the user which model failed and where its work went. If every pool model fails, say so plainly instead of doing the work yourself.",
		"",
		"Do not do the subtasks' work with your own tools; use them only to verify or integrate. Delegate only to these selectors. Only pure conversation (greetings, questions answerable from context alone) may be answered directly.",
		"</model-pool>",
	].join("\n");
}
