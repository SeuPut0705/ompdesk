/**
 * The model a role really runs on, through stock's own resolution, for
 * Settings › Models & accounts › Model roles.
 *
 * Nothing here re-derives a rule: each role is resolved with the selector list
 * the stock call site uses, through stock's `resolveModelOverride` (which expands
 * `@role`, applies an empty role's inheritance and built-in priority list, and
 * skips what does not match), or `resolveRoleSelection` for the commit message
 * path. The tables below only record which call site reads which selectors:
 *
 * - vision: `utils/image-question.ts` tries `@vision`, `@default`, then the active model
 * - commit: `commit/model-selection.ts` `resolvePrimaryModel` →
 *   `resolveRoleSelection(["commit", "smol", ...CHAT_MODEL_ROLE_IDS])`
 * - default, plan, task: the role alone; a session without a match keeps the
 *   model it has (`interactive-mode.ts` plan mode, `resolveEffectiveAgentModelSelection`)
 * - every other built-in: `resolveRoleChain(role)` / `resolveModelRoleValue("@role")`
 * - a custom role: what an agent listing it lists (`roleSelectors`); with none
 *   of them matching, an agent runs on the session model (stock's
 *   `activeModelPattern` fallback)
 *
 * A pin test (src/main/bridge-model-roles-stock.test.ts) runs the real omp and
 * compares these answers with the stock functions' own.
 */

import { roleSelectors } from "./model-role-contracts";

interface ModelLike {
	provider: string;
	id: string;
	name?: string;
}

interface Resolution {
	model?: ModelLike;
	thinkingLevel?: string;
	explicitThinkingLevel: boolean;
}

/** The slice of stock this module calls; settings.ts binds the real functions to the session and each role's candidate pool. */
export interface RoleStock {
	/** `resolveModelOverride(selectors, { getAvailable: () => pool(role) }, settings)`. */
	resolve(role: string, selectors: string[]): Resolution;
	/** `resolveRoleSelection(roles, settings, pool(role))`. */
	selectRole(
		role: string,
		roles: readonly string[],
	): { role: string; model: ModelLike; thinkingLevel?: string } | undefined;
	chatRoleIds: readonly string[];
	/** The role's configured value, trimmed; undefined while empty. */
	configured(role: string): string | undefined;
	sessionModel(): ModelLike | undefined;
}

export interface RoleEffective {
	/** `provider/id`. */
	model?: string;
	name?: string;
	/** Only when the resolved selector names a level; otherwise the session's thinking level applies. */
	thinkingLevel?: string;
	/**
	 * configured: the role's own value answered; fallback: its empty-role
	 * resolution (or an agent's next listed role) answered; session: nothing
	 * matched and the model already running is used; none: no model.
	 */
	source: "configured" | "fallback" | "session" | "none";
	/** The role whose value answered, when it is not this role. */
	via?: string;
	/** The role holds a value but no available model matches it (signed out, model gone). */
	unavailable?: boolean;
}

const SELECTORS: Record<string, string[]> = {
	default: ["@default"],
	vision: ["@vision", "@default"],
};

/** Roles whose callers keep running the session's model when nothing matches. */
const SESSION_FALLBACK: Record<string, true> = { default: true, plan: true, task: true, vision: true };

function shown(model: ModelLike, thinkingLevel: string | undefined, explicit: boolean) {
	return {
		model: `${model.provider}/${model.id}`,
		...(model.name && model.name !== model.id ? { name: model.name } : {}),
		...(explicit && thinkingLevel ? { thinkingLevel } : {}),
	};
}

export function effectiveRole(stock: RoleStock, role: string, builtin: boolean): RoleEffective {
	const configured = stock.configured(role) !== undefined;
	if (role === "commit") {
		const picked = stock.selectRole(role, ["commit", "smol", ...stock.chatRoleIds]);
		if (picked) {
			const own = picked.role === role;
			return {
				...shown(picked.model, picked.thinkingLevel, picked.thinkingLevel !== undefined),
				source: own ? "configured" : "fallback",
				...(own ? {} : { via: picked.role }),
			};
		}
		return { source: "none", ...(configured ? { unavailable: true } : {}) };
	}
	const selectors = SELECTORS[role] ?? (builtin ? [`@${role}`] : roleSelectors(role));
	for (const [index, selector] of selectors.entries()) {
		const resolved = stock.resolve(role, [selector]);
		if (!resolved.model) continue;
		const own = index === 0;
		return {
			...shown(resolved.model, resolved.thinkingLevel, resolved.explicitThinkingLevel),
			source: own && configured ? "configured" : "fallback",
			...(own ? {} : { via: selector.slice(1) }),
		};
	}
	const running = stock.sessionModel();
	const unavailable = configured ? { unavailable: true } : {};
	if (running && (!builtin || SESSION_FALLBACK[role])) {
		return { ...shown(running, undefined, false), source: "session", ...unavailable };
	}
	return { source: "none", ...unavailable };
}
