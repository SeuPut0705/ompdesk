/**
 * Settings, model catalog, providers, usage and model roles over the live
 * session. Ported from the fork's rpc-extensions.ts / rpc-model-roles.ts /
 * rpc-mode.ts (settings, catalog, logout cases). Wire shapes match
 * `src/shared/rpc-types.ts` (SettingsSchemaResult, ProvidersResult, …).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveUsedFraction, type UsageLimit, type UsageReport } from "@oh-my-pi/pi-ai";
import { getOAuthCredentialProvider, getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { orderedSettings } from "@oh-my-pi/pi-coding-agent/config/all-settings";
import { getKnownRoleIds, getRoleInfo, roleCandidatePool } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SETTING_TABS, TAB_GROUPS, TAB_METADATA } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { getAgentDir, MAIN_CONFIG_FILENAMES } from "@oh-my-pi/pi-utils";
import { accountLabel, matchReportAccount, reportIdentity, type StoredAccount } from "./accounts-core";
import { guard } from "./health";
import { shownRoleValue, storedRoleValue } from "./role-values";
import { releaseThinkingDefaultFor, syncThinkingDefault } from "./thinking-default";
import type { BridgeEnv, BridgeMethods } from "./types";

type Rec = Record<string, unknown>;
type Layer = "global" | "project" | "overlay" | "runtime";

const asRecord = (value: unknown): Rec => (typeof value === "object" && value !== null ? (value as Rec) : {});

// ============================================================================
// Settings
// ============================================================================

interface SettingLike {
	id: string;
	segments: readonly string[];
	type: string;
	default: unknown;
	enumValues?: readonly string[];
	ui?: Rec & { options?: unknown };
	isCredential?: boolean;
	definition?: Rec;
	get(scope: unknown): unknown;
	set(scope: unknown, value: unknown): void;
	assertWritable?(value: unknown): void;
	/** Runtime-only layer (not persisted); stock 18.7+. */
	override?(scope: unknown, value: unknown): void;
	clearOverride?(scope: unknown): void;
	/** Whether the environment or any settings layer sets this value. */
	isConfigured?(scope: unknown): boolean;
}

// ============================================================================
// Image generation: on whenever a connected account can make images
// ============================================================================

const IMAGE_SETTING = "generate_image.enabled";
/** Settings instances whose image-tool switch this bridge holds as a runtime override. */
const autoImageOverrides = new WeakSet<object>();

/**
 * Stock ships `generate_image` off. While the user has not decided either way
 * (no layer configures the setting) and an image model is reachable with the
 * user's credentials (e.g. a ChatGPT login brings `openai-codex/gpt-image-2`),
 * hold it on as a runtime override: never written to config.yml, dropped again
 * when the last image model goes away, and released the moment the user sets it
 * in Settings. Stock's tool-gate listener adds or removes the tool live.
 */
export function syncImageGeneration(session: AgentSession): void {
	const setting = lookup(IMAGE_SETTING) as unknown as SettingLike | undefined;
	if (
		!setting ||
		typeof setting.override !== "function" ||
		typeof setting.clearOverride !== "function" ||
		typeof setting.isConfigured !== "function"
	)
		return;
	const scope = session.settings as unknown as object;
	const reachable = roleCandidatePool("image", session.settings, session.modelRegistry).length > 0;
	if (autoImageOverrides.has(scope)) {
		if (reachable) return;
		setting.clearOverride(scope);
		autoImageOverrides.delete(scope);
		return;
	}
	if (!reachable || setting.isConfigured(scope)) return;
	setting.override(scope, true);
	autoImageOverrides.add(scope);
}

/** The user's own write replaces an automatic choice (image tool, thinking default) instead of hiding under it. */
function releaseAutoOverride(session: AgentSession, setting: SettingLike): void {
	const scope = session.settings as unknown as object;
	releaseThinkingDefaultFor(setting.id, scope);
	if (setting.id !== IMAGE_SETTING || !autoImageOverrides.has(scope)) return;
	setting.clearOverride?.(scope);
	autoImageOverrides.delete(scope);
}

interface CredentialsLike {
	generation: number;
	reload(): Promise<void>;
	onGeneration?(listener: (generation: number) => void): () => void;
}

/** Credential stores already watched (one listener per process, whatever the session). */
const watchedCredentials = new WeakSet<object>();

/** Re-read the catalog after a login/logout, then follow it. */
async function followCredentials(session: AgentSession): Promise<void> {
	const registry = session.modelRegistry;
	registry.refreshInBackground("online-if-uncached");
	await registry.awaitBackgroundRefresh();
	syncImageGeneration(session);
}

/**
 * Connecting an account turns image generation on without a restart, wherever
 * the login happened: a login in this omp (`/login`, Settings in this tab) bumps
 * the credential generation, which we watch; a login in another tab's omp is
 * only on disk, so main asks every tab to re-read (`image_generation_sync`).
 */
export async function refreshImageGeneration(session: AgentSession): Promise<void> {
	const credentials = session.modelRegistry.authStorage.credentials as unknown as CredentialsLike;
	if (!watchedCredentials.has(credentials) && typeof credentials.onGeneration === "function") {
		watchedCredentials.add(credentials);
		credentials.onGeneration(() => {
			void followCredentials(session).catch(() => {});
		});
	}
	const before = credentials.generation;
	await credentials.reload();
	// reload() bumps the generation when the store changed, and the watcher follows.
	if (credentials.generation === before) syncImageGeneration(session);
}

interface SettingsLike {
	getProvenance?(setting: unknown): string;
	overlayLayers?(): { global: Rec; overrides: Rec };
	flush?(): Promise<void>;
}

function byPath(root: Rec | undefined, segments: readonly string[]): unknown {
	let cursor: unknown = root;
	for (const segment of segments) {
		if (typeof cursor !== "object" || cursor === null) return undefined;
		cursor = (cursor as Rec)[segment];
	}
	return cursor;
}

function globalConfigPath(): string {
	const dir = getAgentDir();
	const files = MAIN_CONFIG_FILENAMES.map(name => path.join(dir, name));
	return files.find(file => fs.existsSync(file)) ?? files[0];
}

/**
 * Stock omp only reports the winning layer (`getProvenance`), so the full
 * layer list is rebuilt from the instance's own global/runtime layers
 * (`overlayLayers`) plus the winning project/overlay layer.
 */
function provenanceReader(settings: SettingsLike, globalPath: string) {
	const own = typeof settings.overlayLayers === "function" ? settings.overlayLayers() : undefined;
	return (setting: SettingLike) => {
		const present = new Set<Layer>();
		const globalValue = byPath(own?.global, setting.segments);
		if (globalValue !== undefined && globalValue !== null) present.add("global");
		if (byPath(own?.overrides, setting.segments) !== undefined) present.add("runtime");
		const winner = settings.getProvenance?.(setting);
		if (winner === "global" || winner === "project" || winner === "overlay" || winner === "runtime") {
			present.add(winner);
		}
		const layers = (["global", "project", "overlay", "runtime"] as const).filter(layer => present.has(layer));
		return present.has("global") ? { layers, globalValue, globalPath } : { layers };
	};
}

function optionsOf(setting: SettingLike): Array<{ value: string; label: string; description?: string }> | undefined {
	const uiOptions = setting.ui?.options;
	if (Array.isArray(uiOptions)) {
		return uiOptions.map(raw => {
			const option = asRecord(raw);
			return {
				value: String(option.value),
				label: String(option.label ?? option.value),
				...(typeof option.description === "string" ? { description: option.description } : {}),
			};
		});
	}
	return setting.enumValues?.map(value => ({ value, label: value }));
}

function settingsSchema(session: AgentSession) {
	syncThinkingDefault(session.settings);
	const provenance = provenanceReader(session.settings as unknown as SettingsLike, globalConfigPath());
	const entries = (orderedSettings() as unknown as SettingLike[]).map(setting => {
		const ui = setting.ui;
		const definition = setting.definition ?? {};
		return {
			path: setting.id,
			type: setting.type,
			value: setting.get(session.settings),
			provenance: provenance(setting),
			default: setting.default,
			label: typeof ui?.label === "string" ? ui.label : setting.id,
			description: typeof ui?.description === "string" ? ui.description : undefined,
			tab: typeof ui?.tab === "string" ? ui.tab : undefined,
			group: typeof ui?.group === "string" ? ui.group : undefined,
			options: optionsOf(setting),
			secret: setting.isCredential === true,
			advanced: !ui,
			condition: typeof ui?.condition === "string" ? ui.condition : undefined,
			ordered: ui?.ordered === true ? true : undefined,
			tuiOnly: definition.tuiOnly === true ? true : undefined,
			restartRequired: definition.restartRequired === true ? true : undefined,
		};
	});
	const tabs = SETTING_TABS.map(tab => ({
		id: tab,
		label: TAB_METADATA[tab].label,
		groups: [...TAB_GROUPS[tab]],
	}));
	return { entries, tabs };
}

function advisorState(session: AgentSession): { advisorEnabled?: boolean; advisorActive?: boolean } {
	const advisor = session as unknown as { isAdvisorEnabled?(): boolean; isAdvisorActive?(): boolean };
	return {
		...(typeof advisor.isAdvisorEnabled === "function" ? { advisorEnabled: advisor.isAdvisorEnabled() } : {}),
		...(typeof advisor.isAdvisorActive === "function" ? { advisorActive: advisor.isAdvisorActive() } : {}),
	};
}

function getSettings(session: AgentSession, paths: string[] | undefined) {
	syncThinkingDefault(session.settings);
	const ids = paths ?? orderedSettings().map(setting => setting.id);
	const provenance = provenanceReader(session.settings as unknown as SettingsLike, globalConfigPath());
	const values: Rec = {};
	const provenances: Rec = {};
	for (const id of ids) {
		const setting = lookup(id) as unknown as SettingLike | undefined;
		if (!setting) continue;
		values[id] = setting.get(session.settings);
		provenances[id] = provenance(setting);
	}
	return { values, provenance: provenances, ...advisorState(session) };
}

async function setSetting(env: BridgeEnv, session: AgentSession, id: string, value: unknown) {
	const setting = lookup(id) as unknown as SettingLike | undefined;
	if (!setting) throw new Error(`Unknown setting path: ${id}`);
	// `undefined` removes the global override (stock `Setting.set` unsets it); stock
	// `assertWritable` rejects it as a value, so only a real value is validated.
	if (value !== undefined) setting.assertWritable?.(value);
	releaseAutoOverride(session, setting);
	setting.set(session.settings, value);
	const settings = session.settings as unknown as SettingsLike;
	const intended = settings.overlayLayers && byPath(settings.overlayLayers().global, setting.segments);
	await settings.flush?.();
	// Stock's save skips a change it takes for stale after an external config.yml
	// edit and adopts the file, so the write silently reverts. Its own previous
	// write has tripped that check on Windows; the user's edit is the newest, so
	// apply it once more against the file as it now is.
	if (settings.overlayLayers && !Bun.deepEquals(byPath(settings.overlayLayers().global, setting.segments), intended)) {
		setting.set(session.settings, value);
		await settings.flush?.();
	}
	// A reset (`undefined`) leaves the thinking level unset again: OMPdesk's default returns.
	syncThinkingDefault(session.settings);
	env.emit({ type: "config_update", model: session.model, thinkingLevel: session.thinkingLevel });
	const provenance = provenanceReader(settings, globalConfigPath());
	return {
		path: id,
		value: setting.get(session.settings),
		savedValue: value,
		provenance: provenance(setting),
		...(id === "advisor.enabled" ? advisorState(session) : {}),
	};
}

// ============================================================================
// Model catalog / providers
// ============================================================================

const DISCOVERY_WAIT_MS = 4_000;
/** Monotonic across sidecar restarts too: the renderer drops snapshots older than the last applied one. */
let lastGeneration = 0;
const nextGeneration = () => {
	lastGeneration = Math.max(lastGeneration + 1, Date.now());
	return lastGeneration;
};
let watchedRefresh: Promise<void> | undefined;

function discoveryStates(session: AgentSession) {
	const registry = session.modelRegistry as unknown as {
		getDiscoverableProviders?(): string[];
		getProviderDiscoveryState?(provider: string): Rec | undefined;
	};
	if (typeof registry.getDiscoverableProviders !== "function") return [];
	const states: Rec[] = [];
	for (const provider of registry.getDiscoverableProviders()) {
		const state = registry.getProviderDiscoveryState?.(provider);
		if (!state) continue;
		states.push({
			provider,
			status: state.status,
			optional: state.optional === true,
			stale: state.stale === true,
			...(typeof state.fetchedAt === "number" ? { fetchedAt: state.fetchedAt } : {}),
			models: Array.isArray(state.models) ? state.models : [],
			...(typeof state.error === "string" ? { error: state.error } : {}),
		});
	}
	return states;
}

function catalogSnapshot(session: AgentSession, refreshPending: boolean) {
	return {
		models: session.getAvailableModels(),
		discoveryStates: discoveryStates(session),
		refreshPending,
		generation: nextGeneration(),
	};
}

function buildProviders(session: AgentSession) {
	const authStorage = session.modelRegistry.authStorage;
	const loginProviders = getOAuthProviders();
	const loginIds = new Set(loginProviders.map(provider => provider.id));
	const loginNameById = new Map(loginProviders.map(provider => [provider.id, provider.name]));
	const modelCount = new Map<string, number>();
	for (const model of session.getAvailableModels()) {
		modelCount.set(model.provider, (modelCount.get(model.provider) ?? 0) + 1);
	}
	const ids = new Set<string>([...modelCount.keys(), ...loginIds]);
	try {
		for (const credential of authStorage.credentials.list()) ids.add(credential.provider);
	} catch {
		// Credential listing is best-effort; providers with models still show.
	}
	const disabled = new Set((lookup("disabledProviders")?.get(session.settings) as string[] | undefined) ?? []);
	const providers = [...ids].map(id => {
		const authenticated = authStorage.keys.source(id) !== undefined;
		const identity = authenticated ? authStorage.oauth.identity(id, session.sessionId) : undefined;
		return {
			id,
			name: loginNameById.get(id) ?? id,
			authenticated,
			authKind: authenticated ? (identity ? "oauth" : "apikey") : undefined,
			account: identity?.email ?? identity?.accountId,
			loginAvailable: loginIds.has(id),
			disabled: disabled.has(id),
			baseUrl: session.modelRegistry.getProviderBaseUrl(id),
			modelCount: modelCount.get(id) ?? 0,
		};
	});
	providers.sort((a, b) => {
		if (a.authenticated !== b.authenticated) return a.authenticated ? -1 : 1;
		return b.modelCount - a.modelCount;
	});
	return providers;
}

function emitCatalogUpdate(env: BridgeEnv, session: AgentSession): void {
	// Logins, logouts and settled refreshes all land here: the image tool follows.
	syncImageGeneration(session);
	env.emit({ type: "model_catalog_update", ...catalogSnapshot(session, false), providers: buildProviders(session) });
}

/** Push the catalog once a refresh that outlived the bounded wait settles (fork `watchCatalogRefresh`). */
function watchRefresh(env: BridgeEnv, session: AgentSession, refresh: Promise<void>): void {
	if (watchedRefresh === refresh) return;
	watchedRefresh = refresh;
	void refresh
		.catch(() => undefined)
		.finally(() => {
			if (watchedRefresh === refresh) watchedRefresh = undefined;
			try {
				emitCatalogUpdate(env, session);
			} catch {
				// Session gone (switch/shutdown): the next catalog read reports the state.
			}
		});
}

async function refreshCatalog(env: BridgeEnv, session: AgentSession, forceRefresh: boolean) {
	const registry = session.modelRegistry;
	const credentials = registry.authStorage.credentials;
	const before = credentials.generation;
	await credentials.reload();
	const authChanged = credentials.generation !== before;
	registry.refreshInBackground(forceRefresh || authChanged ? "online" : "online-if-uncached");
	const refresh = registry.awaitBackgroundRefresh();
	const timeout = Promise.withResolvers<false>();
	const timer = setTimeout(() => timeout.resolve(false), DISCOVERY_WAIT_MS);
	const completed = await Promise.race([
		refresh.then(
			() => true,
			() => true,
		),
		timeout.promise,
	]).finally(() => clearTimeout(timer));
	if (!completed) watchRefresh(env, session, refresh);
	syncImageGeneration(session);
	return catalogSnapshot(session, !completed);
}

// ============================================================================
// Usage
// ============================================================================

function shapeLimit(limit: UsageLimit) {
	return {
		id: limit.id,
		label: limit.label,
		usedFraction: resolveUsedFraction(limit),
		used: limit.amount.used,
		limit: limit.amount.limit,
		unit: limit.amount.unit,
		remainingFraction: limit.amount.remainingFraction,
		windowLabel: limit.window?.label,
		resetsAt: limit.window?.resetsAt,
		status: limit.status,
		notes: limit.notes,
	};
}

/** One report per stored account; each keeps the identity its own metadata names. */
async function usage(session: AgentSession) {
	const reports: Rec[] = [];
	try {
		const raw = (await session.fetchUsageReports()) ?? [];
		const oauth = session.modelRegistry.authStorage.oauth;
		const reportCount = new Map<string, number>();
		for (const report of raw) reportCount.set(report.provider, (reportCount.get(report.provider) ?? 0) + 1);
		const accountsByProvider = new Map<string, StoredAccount[]>();
		for (const report of raw) {
			let accounts = accountsByProvider.get(report.provider);
			if (!accounts) {
				accounts = oauth.accounts(report.provider, session.sessionId);
				accountsByProvider.set(report.provider, accounts);
			}
			const identity = reportIdentity(report.metadata);
			const account = matchReportAccount(identity, accounts, reportCount.get(report.provider) ?? 0);
			reports.push({
				provider: report.provider,
				fetchedAt: report.fetchedAt,
				limits: report.limits.map(shapeLimit),
				notes: report.notes,
				account: account ? accountLabel(account) : (identity.email ?? identity.accountId ?? identity.orgName),
				...(account ? { credentialId: account.credentialId } : {}),
				...(account?.active ? { active: true } : {}),
				resetCreditsAvailable: report.resetCredits?.availableCount,
			});
		}
	} catch {
		// Provider usage fetch is best-effort; local session tallies always answer.
	}
	const stats = session.sessionManager.getUsageStatistics();
	return {
		reports,
		session: {
			input: stats.input,
			output: stats.output,
			cacheRead: stats.cacheRead,
			cacheWrite: stats.cacheWrite,
			totalTokens: stats.totalTokens,
			orchestrationTokens: stats.orchestrationInput + stats.orchestrationOutput + stats.orchestrationCacheRead,
			premiumRequests: stats.premiumRequests,
			cost: stats.cost,
		},
	};
}

/** Stock `UsageService.report` (one stored credential); not on the `UsageApi` interface. */
interface CredentialUsageReporter {
	report(provider: string, credential: unknown): Promise<UsageReport | null>;
}

/**
 * Per-account quota and health for one login provider: what stock RPC lacks
 * next to `get_logout_accounts` (main joins the two by credentialId). Health
 * is stock's own view (`health.model`): an account blocked by a usage limit is
 * `depleted` with `resetsAt` = when stock tries it again.
 */
async function providerAccounts(session: AgentSession, loginProviderId: string) {
	const provider = getOAuthCredentialProvider(loginProviderId);
	const authStorage = session.modelRegistry.authStorage;
	await authStorage.credentials.reload();
	const sessionId = session.sessionId;
	const pinned = authStorage.oauth.accounts(provider, sessionId).find(account => account.active)?.credentialId;
	const health = await authStorage.health
		.model(provider, {
			modelId: session.model?.provider === provider ? session.model.id : undefined,
			sessionId,
			// Not finite: stock applies the configured default reserve (`retry.usageReservePct`).
			reserveFraction: Number.NaN,
		})
		.catch(() => ({ state: "unknown" as const, accounts: [] }));
	const healthById = new Map(health.accounts.map(account => [account.credentialId, account]));
	const reporter = authStorage.usage as unknown as CredentialUsageReporter;
	// After `health.model`, these reads answer from stock's per-credential usage cache.
	const accounts = await Promise.all(
		authStorage.credentials.list(provider).map(async row => {
			const report = await reporter.report(provider, row.credential).catch(() => null);
			const accountHealth = healthById.get(row.id);
			return {
				credentialId: row.id,
				state: accountHealth?.state ?? "unknown",
				remainingFraction: accountHealth?.remainingFraction,
				resetsAt: accountHealth?.resetsAt,
				limits: report ? report.limits.map(shapeLimit) : [],
			};
		}),
	);
	return { providerId: loginProviderId, ...(pinned !== undefined ? { pinnedCredentialId: pinned } : {}), accounts };
}

// ============================================================================
// Model roles
// ============================================================================

function roleMetadata(session: AgentSession) {
	return getKnownRoleIds(session.settings).map(id => {
		const { name, tag, color, hidden, section } = getRoleInfo(id, session.settings);
		return { id, name, tag, color, hidden, section };
	});
}

function modelRoles(session: AgentSession) {
	return roleMetadata(session).map(role => ({
		...role,
		model: shownRoleValue(role.id, session.settings.getModelRole(role.id)),
		source: session.settings.getModelRoleSource(role.id),
		candidates: roleCandidatePool(role.id, session.settings, session.modelRegistry).map(model => ({
			provider: model.provider,
			id: model.id,
			name: model.name,
			kind: modelKind(model),
		})),
	}));
}

// ============================================================================
// Methods
// ============================================================================

const str = (params: unknown, key: string): string => {
	const value = asRecord(params)[key];
	if (typeof value !== "string" || !value) throw new Error(`Missing ${key}`);
	return value;
};

export const methods: BridgeMethods = {
	...guard("settings", {
		settings_schema: async (_params, env) => settingsSchema(env.session()),
		settings_get: async (params, env) => {
			const paths = asRecord(params).paths;
			return getSettings(
				env.session(),
				Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string") : undefined,
			);
		},
		settings_set: async (params, env) => setSetting(env, env.session(), str(params, "path"), asRecord(params).value),
		/** Main calls this when the bridge connects and after any tab's login or logout. */
		image_generation_sync: async (_params, env) => {
			await refreshImageGeneration(env.session());
			return {};
		},
	}),
	...guard("models", {
		models_catalog: async (params, env) =>
			refreshCatalog(env, env.session(), asRecord(params).forceRefresh === true),
	}),
	...guard(["models", "providers"], {
		providers: async (params, env) => {
			const session = env.session();
			const catalog = await refreshCatalog(env, session, asRecord(params).forceRefresh === true);
			return { providers: buildProviders(session), ...catalog };
		},
		/** Explicit "disconnect the provider": removes every stored account (one account: stock `logout`). */
		provider_logout: async (params, env) => {
			const session = env.session();
			const providerId = str(params, "providerId");
			await session.modelRegistry.authStorage.credentials.remove(providerId);
			// Recompose without an authenticated network call so auth filtering updates immediately.
			await session.modelRegistry.refreshProvider(providerId, "offline");
			emitCatalogUpdate(env, session);
			return { providerId };
		},
	}),
	...guard(["providers", "usage"], {
		provider_accounts: async (params, env) => providerAccounts(env.session(), str(params, "providerId")),
	}),
	...guard("usage", {
		usage: async (_params, env) => usage(env.session()),
	}),
	...guard("modelRoles", {
		model_roles: async (_params, env) => ({ roles: modelRoles(env.session()) }),
		model_role_metadata: async (_params, env) => ({ roles: roleMetadata(env.session()) }),
		model_role_set: async (params, env) => {
			const session = env.session();
			const role = str(params, "role");
			const modelId = asRecord(params).modelId;
			session.settings.setModelRole(role, storedRoleValue(role, typeof modelId === "string" && modelId ? modelId : undefined));
			await session.settings.flush();
			env.emit({ type: "config_update", model: session.model, thinkingLevel: session.thinkingLevel });
			return { role, modelId: typeof modelId === "string" ? modelId : null };
		},
	}),
};
