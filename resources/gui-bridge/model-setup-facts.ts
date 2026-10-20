/**
 * `model_setup_facts`: what the model setup reads from the live session besides `model_roles`
 * (contract: model-setup-contracts.ts). Every model of every listed role's candidate pool, each provider's billing
 * class from stock's own auth data (rules in model-setup-billing-core.ts), the value config.yml holds per role and
 * the judge models stock's own defaults pin.
 *
 * Read-only and offline: no model request, no OAuth refresh, no discovery. Billing fails closed per provider: any
 * error reading stock's data leaves that provider `metered` with basis `unknown`.
 */
import * as path from "node:path";
import { getEnvApiKey, getProviderDefinition } from "@oh-my-pi/pi-ai";
import { type Model, modelKind } from "@oh-my-pi/pi-catalog/types";
import { resolveModelOverride, rolePriorityDefaults } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { roleCandidatePool } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { ModelsConfigFile } from "@oh-my-pi/pi-coding-agent/config/models-config";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { guard } from "./health";
import {
	type AuthSourceKind,
	classifyProvider,
	endpointEnvMoved,
	IN_PROCESS_LOCAL,
	KEYLESS_RUNTIME_ENDPOINT_ENV,
	type ProviderStockFacts,
	UNKNOWN_BILLING,
} from "./model-setup-billing-core";
import type { ModelSetupFacts, ProviderBilling, SessionSpend, SetupModelFacts } from "./model-setup-contracts";
import { dayStart, spendByProvider } from "./session-spend-core";
import { roleMetadata } from "./settings";
import type { BridgeMethods } from "./types";

/** `models.yml` providers: name → whether the entry sets a `baseUrl`; undefined when the file cannot be read. */
function modelsYmlProviders(): Map<string, boolean> | undefined {
	const { value, status } = ModelsConfigFile.relocate(path.join(getAgentDir(), "models.yml")).tryLoad();
	if (status === "error") return undefined;
	const providers = new Map<string, boolean>();
	for (const [name, entry] of Object.entries(value?.providers ?? {})) providers.set(name, Boolean(entry.baseUrl));
	return providers;
}

/** Stock's view of one provider's auth, for {@link classifyProvider}. */
function stockFacts(
	session: AgentSession,
	provider: string,
	yml: Map<string, boolean>,
	discoverable: ReadonlySet<string>,
): ProviderStockFacts {
	const { authStorage } = session.modelRegistry;
	const stored = authStorage.credentials.list(provider);
	const keyless = authStorage.keys.keyless(provider);
	return {
		source: authStorage.keys.source(provider, { env: "aliases" })?.kind as AuthSourceKind | undefined,
		storedOAuth: stored.some(row => row.credential.type === "oauth"),
		storedKey: !keyless && stored.some(row => row.credential.type === "api_key"),
		envKey: Boolean(getEnvApiKey(provider)),
		modelsYml: yml.has(provider),
		modelsYmlBaseUrl: yml.get(provider) === true,
		catalog: getProviderDefinition(provider) !== undefined,
		keylessRuntime:
			(Object.hasOwn(KEYLESS_RUNTIME_ENDPOINT_ENV, provider) && discoverable.has(provider)) ||
			IN_PROCESS_LOCAL[provider] === true,
		endpointEnvMoved: endpointEnvMoved(provider, process.env),
	};
}

/** Billing of each of `providers`, decided from stock's auth data; a provider stock's data cannot be read for is metered. */
export function providerBillings(session: AgentSession, providers: Iterable<string>): Record<string, ProviderBilling> {
	const yml = modelsYmlProviders();
	const discoverable = new Set(session.modelRegistry.getDiscoverableProviders());
	const billings: Record<string, ProviderBilling> = {};
	for (const provider of providers) {
		try {
			billings[provider] = yml
				? classifyProvider(stockFacts(session, provider, yml, discoverable))
				: UNKNOWN_BILLING;
		} catch {
			billings[provider] = UNKNOWN_BILLING;
		}
	}
	return billings;
}

const finite = (value: number | null | undefined): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

type Pool = readonly Model[];

/** Measured tokens/s the way stock's model browser reads it: the standard row, else the fastest tier's. */
function measuredTps(perf: ReadonlyMap<string, { tps: number }>, selector: string): number | undefined {
	const standard = perf.get(selector);
	if (standard) return finite(standard.tps);
	let fastest: number | undefined;
	for (const [key, stats] of perf) {
		if (key.startsWith(`${selector}@`) && (fastest === undefined || stats.tps > fastest)) fastest = finite(stats.tps);
	}
	return fastest;
}

function modelFacts(model: Model, perf: ReadonlyMap<string, { tps: number }>): SetupModelFacts {
	const selector = `${model.provider}/${model.id}`;
	const family = model.identity?.class;
	const int = finite(model.int);
	const tps = measuredTps(perf, selector) ?? finite(model.tps);
	const contextWindow = finite(model.contextWindow);
	const inputPrice = finite(model.cost?.input);
	const outputPrice = finite(model.cost?.output);
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
		kind: modelKind(model),
		...(family ? { family } : {}),
		...(int !== undefined ? { int } : {}),
		...(tps !== undefined ? { tps } : {}),
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(inputPrice !== undefined ? { inputPrice } : {}),
		...(outputPrice !== undefined ? { outputPrice } : {}),
		image: model.input.includes("image"),
	};
}

/**
 * The judge models stock's own judge defaults name, each entry resolved alone over the judge pool (aliases such as
 * `@tiny` stand for other roles' chains and are skipped): the pinned versions only, in stock's order.
 */
function judgePins(session: AgentSession, pool: Pool): string[] {
	const pins = new Set<string>();
	for (const entry of rolePriorityDefaults("judge")) {
		if (entry.startsWith("@")) continue;
		const { model } = resolveModelOverride([entry], { getAvailable: () => pool }, session.settings);
		if (model && modelKind(model) === "judge") pins.add(`${model.provider}/${model.id}`);
	}
	return [...pins];
}

export function modelSetupFacts(session: AgentSession): ModelSetupFacts {
	const { settings, modelRegistry } = session;
	const perf = settings.getStorage?.()?.getModelPerf() ?? new Map<string, { tps: number }>();
	const models: Record<string, SetupModelFacts> = {};
	const roles: ModelSetupFacts["roles"] = {};
	let judgePool: Pool = [];
	for (const { id } of roleMetadata(session)) {
		const pool = roleCandidatePool(id, settings, modelRegistry);
		if (id === "judge") judgePool = pool;
		for (const model of pool) {
			const selector = `${model.provider}/${model.id}`;
			models[selector] ??= modelFacts(model, perf);
		}
		const persisted = settings.getGlobalModelRole(id) ?? settings.getProjectModelRole?.(id);
		roles[id] = persisted ? { persisted } : {};
	}
	const providers = providerBillings(session, new Set(Object.values(models).map(model => model.provider)));
	return { providers, models, roles, judgePins: judgePins(session, judgePool) };
}

/**
 * This session's spend per provider with each provider's billing class: what a metered provider charged and what a
 * subscription's calls would cost at API prices, never added together. Read from the live journal (`getEntries`),
 * whole-journal like stock's own tally; judge calls are in it because stock journals them into the session they served.
 */
export function sessionSpend(session: AgentSession, now: number): SessionSpend {
	const spend = spendByProvider(session.sessionManager.getEntries(), dayStart(now));
	const known = new Set([...Object.keys(spend), ...session.modelRegistry.getAll().map(model => model.provider)]);
	const billings = providerBillings(session, known);
	const providers: SessionSpend["providers"] = {};
	for (const [provider, row] of Object.entries(spend))
		providers[provider] = { billing: billings[provider]?.billing ?? "metered", ...row };
	const billing: SessionSpend["billing"] = {};
	for (const [provider, row] of Object.entries(billings)) billing[provider] = row.billing;
	return { providers, billing };
}

export const methods: BridgeMethods = {
	...guard("modelSetupFacts", {
		model_setup_facts: async (_params, env) => modelSetupFacts(env.session()),
		session_spend: async (_params, env) => sessionSpend(env.session(), Date.now()),
	}),
};
