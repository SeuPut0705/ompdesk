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
 * - OMPdesk's own roles: `effectiveOmpdeskRole` (custom `modelRoles.<id>` the user set outside OMPdesk are not listed)
 *
 * An empty built-in role also reports `skipped`: the first candidate of stock's own chain over every model the role
 * accepts (`resolveRoleChain` over the whole catalog, credentials ignored) when the chain over the credentialed pool
 * answers with another kind of model (`modelKind`) because no provider holds credentials for it.
 *
 * A pin test (src/main/bridge-model-roles-stock.test.ts) runs the real omp and
 * compares these answers with the stock functions' own.
 */

import type { SkippedPreferred } from "./model-role-contracts";

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

interface ChainModel extends ModelLike {
	/** Stock's `modelKind` of the model. */
	kind: string;
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
	/**
	 * `resolveRoleChain(role, settings, pool)` twice, in stock's attempt order: over every model the role accepts
	 * whether or not a provider holds credentials for it (providers turned off in settings left out), and over
	 * the credentialed pool the role really draws from.
	 */
	chains(role: string): { preferred: ChainModel[]; usable: ChainModel[] };
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
	/** Set for an empty built-in role whose preferred candidate lacks credentials while another class answers. */
	skipped?: SkippedPreferred;
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

const same = (a: ModelLike, b: ModelLike) => a.provider === b.provider && a.id === b.id;

/**
 * Stock's first choice for the role, when no credentials exist for it and the model answering is of another
 * class. A chat role's first choice (Claude Haiku for Fast, say) and a later chat model are one class, so they
 * never show it; the native judge model (`modelKind` judge) is not interchangeable with the chat or tiny
 * model the `judge` chain ends on (`textJudgeRoleChain` in stock's judgment module keeps it that way).
 */
function skippedPreferred(stock: RoleStock, role: string): SkippedPreferred | undefined {
	const { preferred, usable } = stock.chains(role);
	const [lead] = preferred;
	const answering = usable[0];
	if (!lead || !answering || lead.kind === "chat" || answering.kind === lead.kind) return undefined;
	if (usable.some(model => same(model, lead))) return undefined;
	const providers: string[] = [];
	for (const model of preferred) {
		if (model.kind !== lead.kind) break;
		if (!usable.some(candidate => same(candidate, model)) && !providers.includes(model.provider)) {
			providers.push(model.provider);
		}
	}
	return {
		name: lead.name && lead.name !== lead.id ? lead.name : lead.id,
		model: `${lead.provider}/${lead.id}`,
		kind: lead.kind,
		providers,
	};
}

function resolveEffective(stock: RoleStock, role: string): RoleEffective {
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
	const selectors = SELECTORS[role] ?? [`@${role}`];
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
	if (running && SESSION_FALLBACK[role]) {
		return { ...shown(running, undefined, false), source: "session", ...unavailable };
	}
	return { source: "none", ...unavailable };
}

export function effectiveRole(stock: RoleStock, role: string): RoleEffective {
	const effective = resolveEffective(stock, role);
	if (!effective.model || stock.configured(role) !== undefined) return effective;
	const skipped = skippedPreferred(stock, role);
	return skipped ? { ...effective, skipped } : effective;
}

/**
 * An OMPdesk role (ompdesk-role-contracts.ts): `@<id>` resolved through stock as every agent resolves it (its held
 * value is the pick, then its chain), reported against the pick (`configured`) or the chain role that answered.
 */
export function effectiveOmpdeskRole(
	stock: RoleStock,
	role: string,
	chain: readonly string[],
	pick: string | undefined,
): RoleEffective {
	const resolved = stock.resolve(role, [`@${role}`]);
	const unavailable = pick ? { unavailable: true } : {};
	if (!resolved.model) return { source: "none", ...unavailable };
	const model = resolved.model;
	const answered = (selector: string) => {
		const found = stock.resolve(role, [selector]).model;
		return found !== undefined && same(found, model);
	};
	const out = shown(model, resolved.thinkingLevel, resolved.explicitThinkingLevel);
	if (pick && answered(pick)) return { ...out, source: "configured" };
	const via = chain.slice(1).find(answered);
	return { ...out, source: "fallback", ...(via ? { via: via.replace(/^@/, "") } : {}), ...unavailable };
}
