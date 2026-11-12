/**
 * Stock's fallback models (`session/settings.ts`: `retry.fallbackChains`, `retry.fallbackOn`, `retry.modelFallback`,
 * `retry.fallbackRevertPolicy`), as Settings › Models & accounts › Fallback models reads and edits them. Pure: no
 * React, no IPC. The record is stock's and the only store: each key (a model `provider/id`, a `provider/*` group, a
 * role, `default`, or anything else stock accepts) maps to the ordered selectors stock tries after it. Edits change
 * one key of the global layer and keep every other key, and every value they do not edit, exactly as read.
 */

export const FALLBACK_CHAINS_PATH = "retry.fallbackChains";
export const FALLBACK_ON_PATH = "retry.fallbackOn";
export const MODEL_FALLBACK_PATH = "retry.modelFallback";
/** Stock's `retry.enabled`: off, a failed request never walks a chain (only a model with no credential switches). */
export const RETRY_ENABLED_PATH = "retry.enabled";
export const FALLBACK_REVERT_PATH = "retry.fallbackRevertPolicy";

/** Stock's `retry.fallbackOn` values, in the order the control offers them. */
export const FALLBACK_TRIGGERS = ["usage-limit", "any", "except-usage-limit"] as const;
export type FallbackTrigger = (typeof FALLBACK_TRIGGERS)[number];

export function isFallbackTrigger(value: unknown): value is FallbackTrigger {
	return FALLBACK_TRIGGERS.some(trigger => trigger === value);
}

export type ChainRecord = Readonly<Record<string, unknown>>;

/**
 * What a key (or a chain entry) names, as far as this editor reads it. `verbatim` is everything it shows as written
 * and never rewrites: an id-prefix wildcard (`openrouter/google/*`), a thinking suffix (`…:high`), anything else.
 */
export type SelectorKind =
	| { kind: "model"; provider: string; id: string }
	| { kind: "provider"; provider: string }
	| { kind: "default" }
	| { kind: "role"; role: string }
	| { kind: "verbatim" };

/** How a chain key reads (stock: a key with a `/` is a model selector, any other key a role). */
export function selectorKind(key: string): SelectorKind {
	const slash = key.indexOf("/");
	if (slash < 0)
		return key === "default" ? { kind: "default" } : key ? { kind: "role", role: key } : { kind: "verbatim" };
	const provider = key.slice(0, slash);
	const rest = key.slice(slash + 1);
	if (!provider || !rest || key.includes(":")) return { kind: "verbatim" };
	if (rest === "*") return { kind: "provider", provider };
	if (rest.includes("*")) return { kind: "verbatim" };
	return { kind: "model", provider, id: rest };
}

/** One key of the record and its list; `chain` is `null` when the value is not a list of strings (stock cannot read it). */
export interface ChainRow {
	key: string;
	chain: readonly string[] | null;
}

export function asChainRecord(value: unknown): ChainRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as ChainRecord) : {};
}

export function chainOf(value: unknown): readonly string[] | null {
	return Array.isArray(value) && value.every(item => typeof item === "string") ? value : null;
}

export function chainRows(record: ChainRecord): ChainRow[] {
	return Object.entries(record).map(([key, value]) => ({ key, chain: chainOf(value) }));
}

/** `record` with `key` set to `chain`: its place kept, a new key last, every other key untouched. */
export function withChain(record: ChainRecord, key: string, chain: readonly string[]): Record<string, unknown> {
	return { ...record, [key]: [...chain] };
}

export function withoutChain(record: ChainRecord, key: string): Record<string, unknown> {
	const next = { ...record };
	delete next[key];
	return next;
}

/** What set_setting gets: the record, or `undefined` (unset) once no key is left, never `{}` in config.yml. */
export function serializeChains(record: ChainRecord): Record<string, unknown> | undefined {
	return Object.keys(record).length > 0 ? { ...record } : undefined;
}

/** `chain` with the entry at `index` moved by `delta` places; unchanged when that leaves the list. */
export function moveEntry(chain: readonly string[], index: number, delta: -1 | 1): string[] {
	const target = index + delta;
	const next = [...chain];
	if (index < 0 || index >= next.length || target < 0 || target >= next.length) return next;
	[next[index], next[target]] = [next[target] as string, next[index] as string];
	return next;
}

export function removeEntry(chain: readonly string[], index: number): string[] {
	return chain.filter((_, at) => at !== index);
}

export function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** What the precedence copy below needs to know besides the record. */
export interface ChainContext {
	/** The record as stock reads it (every layer merged). */
	chains: ChainRecord;
	/** The configured roles' models (`provider/id`), the roles `expandDefaultRetryFallbackChains` gives `default`'s list. */
	roleModels: Readonly<Record<string, string>>;
	/** Stock's kind roles (`isKindRole`: web, judge, image …), which never take a chain by their model. */
	kindRoles: ReadonlySet<string>;
	/** Stock's `hasProvider`, for telling `provider/*` from an id-prefix wildcard. */
	isProvider: (provider: string) => boolean;
}

/**
 * The key whose list stock walks when `selector` (`provider/id`) fails in a session on `roleHint`'s model. A copy of
 * stock `resolveRetryFallbackChainKey` (`session/retry-fallback-chains.ts`) with `expandDefaultRetryFallbackChains`,
 * because the renderer cannot import stock; `fallback-chains.test.ts` runs the same cases through the installed stock
 * function. Order: an exact model key, the longest matching `provider/*` (or `provider/prefix/*`), the role hint, a
 * role whose model matches (`default` first), then `default`. A role that takes `default`'s list by expansion
 * answers `"default"`, the key a person edits. Narrower than stock: it compares models without thinking levels, so it
 * answers `null` (cannot tell) when a model key carries a thinking suffix for this model; role models are compared by
 * `provider/id`.
 */
export function chainKeyFor(context: ChainContext, selector: string, roleHint?: string): string | null | undefined {
	const { chains } = context;
	const slash = selector.indexOf("/");
	if (slash <= 0) return undefined;
	const provider = selector.slice(0, slash);
	const id = selector.slice(slash + 1);

	let exact: string | undefined;
	for (const key of Object.keys(chains)) {
		if (!key.includes("/") || key.endsWith("/*")) continue;
		if (key === selector) exact ??= key;
		else if (key.startsWith(`${selector}:`)) return null;
	}
	if (exact) return exact;

	let wildcard: string | undefined;
	let longest = -1;
	for (const key of Object.keys(chains)) {
		if (!key.endsWith("/*") || !Array.isArray(chains[key])) continue;
		const template = key.slice(0, -2);
		const cut = template.indexOf("/");
		const known = cut < 0 || context.isProvider(template);
		const keyProvider = known ? template : template.slice(0, cut);
		const prefix = known ? undefined : template.slice(cut + 1);
		if (keyProvider !== provider) continue;
		if (prefix !== undefined && !id.startsWith(`${prefix}/`)) continue;
		const length = prefix?.length ?? 0;
		if (length > longest) {
			wildcard = key;
			longest = length;
		}
	}
	if (wildcard) return wildcard;

	const expanded: Record<string, unknown> = { ...chains };
	if (Array.isArray(chains.default)) {
		for (const role of Object.keys(context.roleModels)) {
			if (role !== "default" && !context.kindRoles.has(role) && expanded[role] === undefined) {
				expanded[role] = chains.default;
			}
		}
	}
	const configured = (key: string) => (Object.hasOwn(chains, key) ? key : "default");
	if (roleHint && Array.isArray(expanded[roleHint])) return configured(roleHint);
	let matched: string | undefined;
	for (const key of Object.keys(expanded)) {
		if (key.includes("/") || context.kindRoles.has(key)) continue;
		if (context.roleModels[key] !== selector) continue;
		if (key === "default") return "default";
		matched ??= key;
	}
	if (matched) return configured(matched);
	return Array.isArray(chains.default) && chains.default.length > 0 ? "default" : undefined;
}

/** Whether a key would apply to `selector` if no more specific key took it (the rows a person might expect to). */
export function keyCovers(context: ChainContext, key: string, selector: string, role?: string): boolean {
	const kind = selectorKind(key);
	switch (kind.kind) {
		case "model":
			return key === selector;
		case "provider":
			return selector.startsWith(`${kind.provider}/`);
		case "default":
			return true;
		case "role":
			return kind.role === role || context.roleModels[kind.role] === selector;
		case "verbatim":
			return false;
	}
}
