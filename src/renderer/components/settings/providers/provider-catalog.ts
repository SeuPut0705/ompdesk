/**
 * Pure provider/model rules shared by the providers section, the first-run
 * setup and the startup default-model guard. No React, no IPC.
 */

import type { CustomProviderView } from "../../../../shared/ipc-types";
import type { ModelInfo, ProviderDiscoveryState, ProviderInfo } from "../../../../shared/rpc-types";

/**
 * Providers offered first to someone who has none yet: the subscriptions and
 * gateways most people already have, in omp's own `/login` order, with the
 * names omp lists them under.
 */
const RECOMMENDED_PROVIDERS: readonly (readonly [id: string, name: string])[] = [
	["anthropic", "Anthropic"],
	["openai-codex", "OpenAI Codex"],
	["github-copilot", "GitHub Copilot"],
	["openrouter", "OpenRouter"],
	["google-gemini-cli", "Google Gemini CLI"],
	["deepseek", "DeepSeek"],
];

export const RECOMMENDED_PROVIDER_IDS: readonly string[] = RECOMMENDED_PROVIDERS.map(([id]) => id);

/**
 * The first-run provider step's rows before omp answers (its first boot right
 * after machine setup installed it): the recommended providers, signed out.
 * The live catalog replaces them as soon as the session is ready.
 */
export const STARTER_PROVIDERS: readonly ProviderInfo[] = [
	...RECOMMENDED_PROVIDERS,
	["xai-oauth", "xAI Grok OAuth"] as const,
	["xai", "xAI API"] as const,
].map(([id, name]) => ({
	id,
	name,
	authenticated: false,
	loginAvailable: true,
	disabled: false,
	modelCount: 0,
}));

/**
 * The providers the sign-in pickers put on top as their own group, in this order. Ids and login
 * kinds are stock's (pi-catalog `auth/*.kdl`, `/login` roster): `openai-codex` and `anthropic` are
 * subscription OAuth, `google-gemini-cli` is Google's own browser sign-in (stock's plain `google`
 * has no login), `openrouter` yields a durable API key (browser sign-in or paste), and Grok has
 * both: `xai-oauth` (device-code sign-in, primary) and `xai` (API key). A card's name is
 * `providerLabel` of stock's live provider row: OMPdesk writes no plan or tier wording of its own,
 * so a plan renamed in stock's catalog shows here after an omp update. `kind` picks the one-line description.
 */
export const FEATURED_PROVIDERS: readonly {
	id: string;
	kind: "subscription" | "apiKey";
	/** A second stock login for the same company, offered as the card's quieter second action. */
	apiKeyId?: string;
}[] = [
	{ id: "openai-codex", kind: "subscription" },
	{ id: "anthropic", kind: "subscription" },
	{ id: "openrouter", kind: "apiKey" },
	{ id: "google-gemini-cli", kind: "subscription" },
	{ id: "xai-oauth", kind: "subscription", apiKeyId: "xai" },
];

/**
 * Smallest context window a coding session can work in. A system prompt plus
 * tool schemas alone is ~8k tokens, so smaller (on-device) models fail on the
 * first prompt; they stay pickable by hand but are never chosen automatically.
 */
export const MIN_SERVING_CONTEXT = 32_000;

/** Normalize a provider row from any omp/bridge version (older rows omit flags). */
export function toProviderInfo(value: unknown): ProviderInfo | null {
	if (!value || typeof value !== "object") return null;
	const row = value as Record<string, unknown>;
	if (typeof row.id !== "string" || typeof row.name !== "string") return null;
	return {
		...(row as Partial<ProviderInfo>),
		id: row.id,
		name: row.name,
		authenticated: row.authenticated === true,
		loginAvailable: row.loginAvailable === true,
		disabled: row.disabled === true,
		modelCount: typeof row.modelCount === "number" ? row.modelCount : 0,
	};
}

/**
 * Providers that can actually answer a prompt: an enabled provider with a
 * stored credential, or a models.yml endpoint that needs none (`auth: none`).
 * Keyless discovered providers (Apple on-device) are deliberately absent.
 */
export function servingProviderIds(
	providers: readonly ProviderInfo[],
	configs: readonly CustomProviderView[],
): Set<string> {
	const ids = new Set<string>();
	for (const provider of providers) {
		if (provider.authenticated && !provider.disabled && provider.modelCount > 0) ids.add(provider.id);
	}
	const byId = new Map(providers.map(provider => [provider.id, provider]));
	for (const config of configs) {
		const provider = byId.get(config.id);
		if (config.auth === "none" && provider && !provider.disabled && provider.modelCount > 0) ids.add(config.id);
	}
	return ids;
}

/** A usable setup needs both a model and a non-disabled credential/config path. */
export function hasUsableModelProvider(
	providers: readonly ProviderInfo[],
	configs: readonly CustomProviderView[],
): boolean {
	return servingProviderIds(providers, configs).size > 0;
}

/** True when the model belongs to a serving provider and its window fits a coding session. */
export function canServe(model: ModelInfo, serving: ReadonlySet<string>): boolean {
	if (!serving.has(model.provider)) return false;
	return model.contextWindow == null || model.contextWindow >= MIN_SERVING_CONTEXT;
}

/** Display name for a model: its catalog name, else its id. */
export function modelDisplayName(model: Pick<ModelInfo, "id" | "name">): string {
	return model.name?.trim() || model.id;
}

/**
 * The model to start with when nobody chose one: only models that can serve,
 * the given provider's first when it has any (the one the user just
 * connected), then omp's recommendation, then the strongest by catalog score.
 * Ties keep catalog order.
 */
export function pickDefaultModel(
	models: readonly ModelInfo[],
	serving: ReadonlySet<string>,
	preferProvider?: string,
): ModelInfo | undefined {
	const candidates = models.filter(model => canServe(model, serving));
	const preferred = preferProvider ? candidates.filter(model => model.provider === preferProvider) : [];
	const pool = preferred.length > 0 ? preferred : candidates;
	let best: ModelInfo | undefined;
	for (const model of pool) {
		if (!best || rank(model) > rank(best)) best = model;
	}
	return best;
}

function rank(model: ModelInfo): number {
	const score = typeof model.int === "number" && Number.isFinite(model.int) ? model.int : 0;
	return (model.isRecommended ? 1_000 : 0) + score;
}

export interface ProviderGroups {
	/** Signed in (or otherwise credentialed), disabled ones included. */
	connected: ProviderInfo[];
	/** Not connected, from RECOMMENDED_PROVIDER_IDS, in that order. */
	recommended: ProviderInfo[];
	/** Everything else, alphabetical. */
	others: ProviderInfo[];
}

export function providerMatches(provider: ProviderInfo, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	return (
		provider.name.toLowerCase().includes(q) ||
		provider.id.toLowerCase().includes(q) ||
		(provider.baseUrl?.toLowerCase().includes(q) ?? false)
	);
}

/** Split the catalog for display: connected first, recommended next, the long tail last. */
export function groupProviders(providers: readonly ProviderInfo[], query = ""): ProviderGroups {
	const visible = providers.filter(provider => providerMatches(provider, query));
	const connected = visible.filter(provider => provider.authenticated);
	const rest = visible.filter(provider => !provider.authenticated);
	const recommended = RECOMMENDED_PROVIDER_IDS.flatMap(id => rest.filter(provider => provider.id === id));
	const others = rest
		.filter(provider => !RECOMMENDED_PROVIDER_IDS.includes(provider.id))
		.sort((a, b) => a.name.localeCompare(b.name));
	return { connected, recommended, others };
}

/** Only user-required discovery failures are worth a banner. */
export function providerDiscoveryErrors(states: readonly ProviderDiscoveryState[], fallbackMessage: string): string[] {
	return states
		.filter(state => state.status === "unavailable" && !state.optional)
		.map(state => `${state.provider}: ${state.error ?? fallbackMessage}`);
}
