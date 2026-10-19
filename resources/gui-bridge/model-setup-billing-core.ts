/**
 * The model setup's billing rule table (dependency-free: no omp imports, tested through
 * src/main/model-setup-metering.test.ts on the installed omp).
 *
 * Input is what stock itself says about one provider (its auth source, stored credentials, env key, models.yml
 * entry, catalog definition); output is the provider's billing class. Decided from auth data, never from a host
 * name or the catalog's list price, and failing closed: anything not provably a subscription or a catalog-defined
 * keyless local runtime on its stock endpoint is `metered`.
 */
import type { ProviderBilling } from "./model-setup-contracts";

/** Stock's `CredentialOriginKind`: the leg of the auth cascade that currently answers for the provider. */
export type AuthSourceKind = "runtime" | "config" | "oauth" | "api_key" | "env";

export interface ProviderStockFacts {
	/** `authStorage.keys.source(provider, { env: "aliases" })?.kind`. */
	source?: AuthSourceKind;
	/** A stored OAuth login (any state). */
	storedOAuth: boolean;
	/** A stored API key, a keyless-mode marker excluded. */
	storedKey: boolean;
	/** `getEnvApiKey(provider)` finds a key in the environment. */
	envKey: boolean;
	/** `models.yml` holds a provider entry of this name. */
	modelsYml: boolean;
	/** That entry sets a `baseUrl`. */
	modelsYmlBaseUrl: boolean;
	/** Stock's catalog defines the provider (it has an auth rule). */
	catalog: boolean;
	/** Stock's registry takes the provider for a local runtime that needs no key (see {@link KEYLESS_RUNTIME_ENDPOINT_ENV}). */
	keylessRuntime: boolean;
	/** A stock endpoint env var moves the provider's endpoint off its default. */
	endpointEnvMoved: boolean;
}

/** The result for a provider stock's data could not be read: metered, nothing assumed. */
export const UNKNOWN_BILLING: ProviderBilling = { billing: "metered", basis: "unknown" };

/**
 * Catalog-defined keyless local runtimes (stock's registry registers each as an implicit local provider,
 * `config/model-registry.ts` `#addImplicitDiscoverableProviders`) and the env vars stock lets move their endpoint
 * off the default. Anything else is never free, whatever its address.
 */
export const KEYLESS_RUNTIME_ENDPOINT_ENV: Readonly<Record<string, readonly string[]>> = {
	ollama: ["OLLAMA_BASE_URL", "OLLAMA_HOST"],
	"lm-studio": ["LM_STUDIO_BASE_URL"],
	"llama.cpp": ["LLAMA_CPP_BASE_URL"],
	apple: [],
};

/**
 * Stock's catalog providers whose models run inside omp itself (`local://inference`: kokoro, parakeet, small
 * on-device models): keyless, with no endpoint to move. Stock registers them keyless unconditionally
 * (`#addImplicitDiscoverableProviders`). `web` is not one: its `web://search` routes to search APIs that may bill.
 */
export const IN_PROCESS_LOCAL: Readonly<Record<string, true>> = { local: true };

/** Whether a stock endpoint env var of `provider` is set (`env` is `process.env`). */
export function endpointEnvMoved(provider: string, env: Readonly<Record<string, string | undefined>>): boolean {
	return (KEYLESS_RUNTIME_ENDPOINT_ENV[provider] ?? []).some(name => Boolean(env[name]?.trim()));
}

/** The user decisions in order; the first rule that holds answers. */
export function classifyProvider(facts: ProviderStockFacts): ProviderBilling {
	// A provider stock's catalog does not define, or one models.yml configures, routes wherever its entry says:
	// a local proxy may forward to paid models, so no host (https, loopback, private) is ever trusted.
	if (!facts.catalog) return { billing: "metered", basis: "custom-endpoint" };
	if (facts.modelsYml) {
		return { billing: "metered", basis: facts.modelsYmlBaseUrl ? "base-url-changed" : "custom-endpoint" };
	}
	if (facts.endpointEnvMoved) return { billing: "metered", basis: "base-url-changed" };
	if (facts.source === "runtime") return { billing: "metered", basis: "runtime" };
	if (facts.source === "config") return { billing: "metered", basis: "config" };
	const key = facts.storedKey || facts.envKey || facts.source === "api_key" || facts.source === "env";
	if (facts.storedOAuth || facts.source === "oauth") {
		// Stock may fall through to the key once every OAuth account is blocked.
		return key ? { billing: "metered", basis: "oauth-and-key" } : { billing: "subscription", basis: "oauth" };
	}
	if (facts.storedKey || facts.source === "api_key") return { billing: "metered", basis: "api-key" };
	if (facts.envKey || facts.source === "env") return { billing: "metered", basis: "env" };
	if (facts.keylessRuntime) return { billing: "free", basis: "local-keyless" };
	return UNKNOWN_BILLING;
}
