/**
 * What the model setup reads from the live session besides `model_roles`
 * (bridge method `model_setup_facts`, RPC `get_model_setup_facts`).
 * Dependency-free: the bridge, main and the renderer import this one file.
 *
 * Billing is decided from stock's own auth data, never from a host name or the
 * catalog's list price (subscription models carry a list price too), and fails
 * closed: anything not provably a subscription or a catalog-defined keyless
 * local runtime on its stock endpoint is `metered`.
 */

export type Billing = "subscription" | "free" | "metered";

/** Why a provider has its billing class; the renderer words it behind the row's ⓘ. */
export type BillingBasis =
	/** Stock OAuth login and no key of any other kind for the provider. */
	| "oauth"
	/** OAuth plus a stored, env or config key: stock may fall through to the key once every account is blocked. */
	| "oauth-and-key"
	| "api-key"
	| "env"
	| "config"
	| "runtime"
	/** A `models.yml` provider entry or a provider stock's catalog does not define, whatever its address. */
	| "custom-endpoint"
	/** A catalog provider whose endpoint was moved (models.yml or a stock endpoint env var), whatever its address. */
	| "base-url-changed"
	/** A catalog-defined keyless local runtime on its stock endpoint (ollama, LM Studio, llama.cpp, Apple on-device). */
	| "local-keyless"
	| "unknown";

export interface ProviderBilling {
	billing: Billing;
	basis: BillingBasis;
}

/** One model of any listed role's candidate pool. */
export interface SetupModelFacts {
	provider: string;
	id: string;
	name: string;
	/** Stock `modelKind`. */
	kind: string;
	/** Stock `identity.class`: the vendor lineage (`"unknown"` when stock cannot tell). */
	family?: string;
	/** Catalog intelligence score. */
	int?: number;
	/** Measured output tokens/s (`model_perf`), else the catalog's. */
	tps?: number;
	contextWindow?: number;
	/** List price, $ per million tokens; a subscription model has one too, so it ranks relative cost only. */
	inputPrice?: number;
	outputPrice?: number;
	/** Takes image input. */
	image: boolean;
}

export interface SetupRoleFacts {
	/** The value config.yml (global, else project) holds, thinking suffix included; absent = nothing persisted. */
	persisted?: string;
}

export interface ModelSetupFacts {
	/** Every provider of any listed role's pool. */
	providers: Record<string, ProviderBilling>;
	/** Keyed by `provider/id`. */
	models: Record<string, SetupModelFacts>;
	/** Keyed by role id, every role `model_roles` lists. */
	roles: Record<string, SetupRoleFacts>;
	/**
	 * Judge-kind models stock's own judge defaults name (`rolePriorityDefaults("judge")`, each entry resolved over
	 * the judge pool), in stock's order: the pinned versions only (Jev 1.14 today, never `jev-latest`).
	 */
	judgePins: string[];
}

/** One provider's share of a session's journal (`session_spend`, RPC `get_session_spend`). */
export interface ProviderSessionSpend {
	billing: Billing;
	/** Stock's display name (the provider registry's, the one Settings' provider rows show), else the id. */
	name: string;
	/** USD over the whole journal: a metered provider's charge, a subscription's API-price estimate. */
	cost: number;
	/** USD of the entries since the host's local midnight. */
	today: number;
}

export interface SessionSpend {
	/** Providers this session's journal spent on, each with its billing class. */
	providers: Record<string, ProviderSessionSpend>;
	/** Every provider stock's catalog knows → its billing class, so a child's model can be classed too. */
	billing: Record<string, Billing>;
}
