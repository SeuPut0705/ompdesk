/**
 * Settings, model catalog, providers, usage and model roles over the live
 * session. Ported from the fork's rpc-extensions.ts / rpc-model-roles.ts /
 * rpc-mode.ts (settings, catalog, logout cases). Wire shapes match
 * `src/shared/rpc-types.ts` (SettingsSchemaResult, ProvidersResult, …).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveUsedFraction, type UsageLimit, type UsageReport } from "@oh-my-pi/pi-ai";
import { usageResetAtMs } from "@oh-my-pi/pi-ai/auth/usage-report";
import { getOAuthCredentialProvider, getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { orderedSettings } from "@oh-my-pi/pi-coding-agent/config/all-settings";
import {
	disabledProviderIds,
	extractExplicitThinkingSelector,
	resolveModelOverride,
	resolveRoleChain,
	resolveRoleSelection,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import {
	CHAT_MODEL_ROLE_IDS,
	getKnownRoleIds,
	getRoleInfo,
	MODEL_ROLE_IDS,
	roleCandidatePool,
} from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	formatActiveAccountLabel,
	reportMatchesActiveAccount,
} from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/active-oauth-account";
import { listLogoutAccounts, logoutCredential } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/logout";
import { SETTING_TABS, TAB_GROUPS, TAB_METADATA } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { getAgentDir, MAIN_CONFIG_FILENAMES } from "@oh-my-pi/pi-utils";
import { matchReportAccount, type StoredAccount } from "./accounts-core";
import { guard, probe } from "./health";
import { idleSettingChanged } from "./idle-compaction";
import { customRoleIdError, PRESET_ROLES, presetRole } from "./model-role-contracts";
import { releaseDelegationForWrite } from "./modes/delegation";
import { asRecord, requiredString } from "./params";
import { type ResetPasses, shapeResetPasses } from "./reset-passes-core";
import { effectiveRole, type RoleStock } from "./role-effective";
import { shownRoleValue, storedRoleValue } from "./role-values";
import { recapSettingChanged } from "./session-recap";
import { heldDefaultNotes, releaseThinkingDefaultFor, syncThinkingDefault } from "./thinking-default";
import type { BridgeEnv, BridgeMethods } from "./types";

type Rec = Record<string, unknown>;
type Layer = "global" | "project" | "overlay" | "runtime";

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

/** The user's own write replaces an automatic choice (image tool, thinking default, delegation strength) instead of hiding under it. */
function releaseAutoOverride(session: AgentSession, setting: SettingLike): void {
	const scope = session.settings as unknown as object;
	releaseThinkingDefaultFor(setting.id, scope);
	releaseDelegationForWrite(setting.id, scope);
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
			// OMPdesk would hold a default here but this omp cannot serve it (thinking-default.ts).
			note: heldDefaultNotes()[setting.id],
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
	idleSettingChanged(id);
	recapSettingChanged(id);
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

// Stock get_available_models blocks on refresh; this richer bounded catalog is required for responsive GUI discovery.
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
		windowId: limit.window?.id ?? limit.scope.windowId,
		windowLabel: limit.window?.label,
		resetsAt: limit.window?.resetsAt,
		status: limit.status,
		notes: limit.notes,
	};
}

/** Lazy loading isolates a missing reset export from the other usage/account features. */
async function resetProjector(
	env: BridgeEnv,
): Promise<((report: UsageReport, account: StoredAccount | undefined) => ResetPasses | undefined) | undefined> {
	if ((await probe(env, ["resetPasses"])).length > 0) return undefined;
	const { toResetUsageAccounts } = await import("@oh-my-pi/pi-coding-agent/slash-commands/helpers/reset-usage");
	return (report, account) => {
		if (!report.resetCredits) return undefined;
		const [selected] = toResetUsageAccounts([
			{
				...report.resetCredits,
				provider: report.provider,
				credentialId: account?.credentialId ?? 0,
				...account,
				active: account?.active ?? false,
				credits: report.resetCredits.credits ?? [],
			},
		]);
		return shapeResetPasses(selected);
	};
}

/**
 * A report younger than this already answers a refresh: its provider's cache
 * is left alone. Claude's usage endpoint answers 429 for a minute after a
 * burst (pi-ai usage/claude.ts `FAILURE_BACKOFF_MS`), so repeated clicks and
 * the TUI's own polls would otherwise spend the account's probes for nothing.
 */
const REFRESH_FRESH_MS = 60_000;

/**
 * The last report read per stored account (`provider\0credentialId`). Stock's
 * `usage.invalidate` drops its own last-good copy, so an account whose
 * refreshed probe the provider rate-limits reads as no report until stock
 * probes it again (pi-ai auth/usage-cache.ts `clearReports`; stock's last-good
 * retention, `USAGE_LAST_GOOD_RETENTION_MS`, covers only uninvalidated
 * failures). The GUI shows this one instead, with its own `fetchedAt`, so the
 * age says how old it is; for at most {@link REPORT_RETAIN_MS}, and never for
 * an account that is gone. Stock's ranking keeps its own view.
 */
const lastReports = new Map<string, UsageReport>();
const REPORT_RETAIN_MS = 10 * 60_000;

/** The report to show for one stored account: stock's, else the last one read while still recent. */
function showReport(provider: string, credentialId: number, report: UsageReport | null): UsageReport | null {
	const key = `${provider}\0${credentialId}`;
	if (report) {
		lastReports.set(key, report);
		return report;
	}
	const last = lastReports.get(key);
	return last && Date.now() - last.fetchedAt < REPORT_RETAIN_MS ? last : null;
}

/** `UsageReport` in src/shared/rpc-types.ts, minus the limits' shape this module owns (shapeLimit). */
interface WireUsageReport {
	provider: string;
	fetchedAt: number;
	limits: Rec[];
	resetAt?: number;
	notes?: string[];
	account?: string;
	credentialId?: number;
	active?: boolean;
	lastUsedAt?: number;
	resetPasses?: ResetPasses;
}

/**
 * When the account last served a request, from the three signals stock and the GUI keep: the pin of this session
 * (`lastUsedAtMs`), the response headers stock merged into the account's report (`headersUpdatedAt`, shared by
 * every omp through stock's cache) and even rotation's ledger of assignments. Undefined when none names it.
 */
function lastUsedAt(
	report: UsageReport,
	account: StoredAccount | undefined,
	assigned: ReadonlyMap<number, number>,
): number | undefined {
	const headers = report.metadata?.headersUpdatedAt;
	const times = [
		account?.lastUsedAtMs,
		typeof headers === "number" ? headers : undefined,
		account ? assigned.get(account.credentialId) : undefined,
	].filter((time): time is number => typeof time === "number" && Number.isFinite(time));
	return times.length > 0 ? Math.max(...times) : undefined;
}

function shapeReport(
	report: UsageReport,
	account: StoredAccount | undefined,
	projectReset: ((report: UsageReport, account: StoredAccount | undefined) => ResetPasses | undefined) | undefined,
	assigned: ReadonlyMap<number, number>,
): WireUsageReport {
	const resetPasses = projectReset?.(report, account);
	const usedAt = lastUsedAt(report, account, assigned);
	return {
		provider: report.provider,
		fetchedAt: report.fetchedAt,
		limits: report.limits.map(shapeLimit),
		// When every exhausted window has reset (stock's own rule); absent while not limited.
		resetAt: usageResetAtMs(report.limits, Date.now()),
		notes: report.notes,
		account:
			formatActiveAccountLabel(account) ??
			(account ? `#${account.credentialId}` : formatActiveAccountLabel(report.metadata)),
		...(account ? { credentialId: account.credentialId } : {}),
		...(account?.active ? { active: true } : {}),
		...(usedAt !== undefined ? { lastUsedAt: usedAt } : {}),
		...(resetPasses ? { resetPasses } : {}),
	};
}

/**
 * One report per stored account; each keeps the identity its own metadata
 * names. `refresh` is stock's user-requested refresh (`omp usage invalidate`)
 * for each provider holding a report older than {@link REFRESH_FRESH_MS}: its
 * cache goes and stock probes its accounts again, one after another. An
 * account left without a report shows its last one (`lastReports`).
 */
async function usage(env: BridgeEnv, session: AgentSession, refresh: boolean) {
	const reports: WireUsageReport[] = [];
	try {
		const authStorage = session.modelRegistry.authStorage;
		const projectReset = await resetProjector(env).catch(() => undefined);
		// Dynamic on purpose (as resetProjector): account-rotation.ts needs omp internals a static import would make
		// settings.ts depend on; an omp lacking them just contributes no assignment times.
		const ledger = await import("./account-rotation").then(
			module => module.ledgerAssignedAt,
			() => undefined,
		);
		const assignedOf = (provider: string, accounts: readonly StoredAccount[]): ReadonlyMap<number, number> => {
			try {
				return ledger?.(provider, accounts) ?? new Map();
			} catch {
				return new Map();
			}
		};
		let raw = (await session.fetchUsageReports()) ?? [];
		const now = Date.now();
		const stale = new Set(
			refresh ? raw.filter(report => now - report.fetchedAt >= REFRESH_FRESH_MS).map(report => report.provider) : [],
		);
		if (stale.size > 0) {
			for (const provider of stale) await authStorage.usage.invalidate(provider);
			raw = (await session.fetchUsageReports()) ?? [];
		}
		const reportCount = new Map<string, number>();
		for (const report of raw) reportCount.set(report.provider, (reportCount.get(report.provider) ?? 0) + 1);
		const accountsByProvider = new Map<string, StoredAccount[]>();
		const accountsOf = (provider: string) => {
			let accounts = accountsByProvider.get(provider);
			if (!accounts) {
				accounts = authStorage.oauth.accounts(provider, session.sessionId);
				accountsByProvider.set(provider, accounts);
			}
			return accounts;
		};
		const shown = new Set<string>();
		for (const report of raw) {
			const account = matchReportAccount(
				report,
				accountsOf(report.provider),
				reportCount.get(report.provider) ?? 0,
				reportMatchesActiveAccount,
			);
			if (account) {
				showReport(report.provider, account.credentialId, report);
				shown.add(`${report.provider}\0${account.credentialId}`);
			}
			reports.push(
				shapeReport(report, account, projectReset, assignedOf(report.provider, accountsOf(report.provider))),
			);
		}
		for (const key of lastReports.keys()) {
			if (shown.has(key)) continue;
			const [provider = "", id] = key.split("\0");
			const account = accountsOf(provider).find(entry => entry.credentialId === Number(id));
			const last = account && showReport(provider, account.credentialId, null);
			if (last) reports.push(shapeReport(last, account, projectReset, assignedOf(provider, accountsOf(provider))));
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
	report(provider: string, credential: unknown, options?: { baseUrl?: string }): Promise<UsageReport | null>;
}

type IdentityKeyResolver = (provider: string, credential: { type: string }) => string | null;

/**
 * Stock `resolveCredentialIdentityKey` (exported since omp 18.8.1, with
 * `task.agentAccountPools`), or `undefined` on an omp without account pools.
 * Loaded lazily: a static import of the missing export would fail this whole
 * module on older omp.
 */
async function identityKeyResolver(env: BridgeEnv): Promise<IdentityKeyResolver | undefined> {
	if ((await probe(env, ["accountPools"])).length > 0) return undefined;
	// The package root: omp's bundle does not export `pi-ai/auth-storage`, whose import would be a second copy.
	const auth: Rec = await import("@oh-my-pi/pi-ai");
	const resolve = auth.resolveCredentialIdentityKey;
	return typeof resolve === "function"
		? (provider, credential) => {
				const key: unknown = resolve(provider, credential);
				return typeof key === "string" && key ? key : null;
			}
		: undefined;
}

/**
 * Per-account quota and health for one login provider: what stock RPC lacks
 * next to `get_logout_accounts` (main joins the two by credentialId). Health
 * is stock's own view (`health.model`): an account blocked by a usage limit is
 * `depleted` with `resetsAt` = when stock tries it again. On an omp with
 * account pools each account also carries its token-free identity key (the
 * string `omp usage accounts` prints; `null` for an API key or an OAuth
 * account without identity) and the result names the credential provider id
 * pools are keyed by. An account whose report lists saved rate-limit resets
 * carries them as `resetPasses` (reset-passes-core.ts).
 */
async function providerAccounts(env: BridgeEnv, session: AgentSession, loginProviderId: string, refresh: boolean) {
	const provider = getOAuthCredentialProvider(loginProviderId);
	const authStorage = session.modelRegistry.authStorage;
	await authStorage.credentials.reload();
	const [identityKey, projectReset] = await Promise.all([
		identityKeyResolver(env),
		resetProjector(env).catch(() => undefined),
	]);
	const sessionId = session.sessionId;
	// Stock keys its per-credential usage cache by base URL. fetchUsageReports, the
	// rate-limit headers every response feeds in, and credential selection all read
	// the provider's base URL; without it these reads hit a separate `default` entry
	// that no turn ever refreshes (stale quotas, and a second upstream probe).
	const baseUrl = session.modelRegistry.getProviderBaseUrl(provider);
	const pinned = authStorage.oauth.accounts(provider, sessionId).find(account => account.active)?.credentialId;
	const rows = authStorage.credentials.list(provider);
	const reporter = authStorage.usage as unknown as CredentialUsageReporter;
	const read = async (row: (typeof rows)[number]) =>
		showReport(provider, row.id, await reporter.report(provider, row.credential, { baseUrl }).catch(() => null));
	// `refresh`, as usage() explains: only when a report is older than REFRESH_FRESH_MS.
	const now = Date.now();
	if (
		refresh &&
		(await Promise.all(rows.map(read))).some(report => report && now - report.fetchedAt >= REFRESH_FRESH_MS)
	) {
		await authStorage.usage.invalidate(provider);
		// Stock's aggregate read probes an invalidated provider's accounts one after another.
		await session.fetchUsageReports();
	}
	const health = await authStorage.health
		.model(provider, {
			baseUrl,
			modelId: session.model?.provider === provider ? session.model.id : undefined,
			sessionId,
			// Not finite: stock applies the configured default reserve (`retry.usageReservePct`).
			reserveFraction: Number.NaN,
		})
		.catch(() => ({ state: "unknown" as const, accounts: [] }));
	const healthById = new Map(health.accounts.map(account => [account.credentialId, account]));
	// After `health.model`, these reads answer from stock's per-credential usage cache.
	const accounts = await Promise.all(
		rows.map(async row => {
			const report = await read(row);
			const accountHealth = healthById.get(row.id);
			const limits = report ? report.limits.map(shapeLimit) : [];
			const stored = authStorage.oauth
				.accounts(provider, sessionId)
				.find(account => account.credentialId === row.id);
			const resetPasses = report && projectReset?.(report, stored);
			return {
				credentialId: row.id,
				state: accountHealth?.state ?? "unknown",
				remainingFraction: accountHealth?.remainingFraction,
				resetsAt: accountHealth?.resetsAt,
				limits,
				...(report ? { fetchedAt: report.fetchedAt } : {}),
				...(identityKey
					? { identityKey: row.credential.type === "oauth" ? identityKey(provider, row.credential) : null }
					: {}),
				...(resetPasses ? { resetPasses } : {}),
			};
		}),
	);
	return {
		providerId: loginProviderId,
		...(identityKey ? { credentialProvider: provider } : {}),
		...(pinned !== undefined ? { pinnedCredentialId: pinned } : {}),
		accounts,
	};
}

// ============================================================================
// Model roles
// ============================================================================

/** A `modelTags.<id>` entry: stock reads `name`, `color` and `hidden`; `description` is OMPdesk's own and stock ignores it. */
interface RoleTag {
	name?: string;
	description?: string;
	color?: string;
	hidden?: boolean;
}

function roleTags(session: AgentSession): Record<string, RoleTag> {
	const setting = lookup("modelTags") as unknown as SettingLike | undefined;
	const raw = asRecord(setting?.get(session.settings));
	return Object.fromEntries(Object.entries(raw).map(([id, tag]) => [id, asRecord(tag) as RoleTag]));
}

const isBuiltinRole = (id: string) => (MODEL_ROLE_IDS as readonly string[]).includes(id);

/** Stock's known roles, then the preset custom roles the agent templates use that are not known yet (empty, so stock has no entry). */
function roleIds(session: AgentSession): string[] {
	const known = getKnownRoleIds(session.settings);
	return [...known, ...PRESET_ROLES.map(role => role.id).filter(id => !known.includes(id))];
}

function roleMetadata(session: AgentSession) {
	const tags = roleTags(session);
	return roleIds(session).map(id => {
		const { name, tag, color, hidden, section } = getRoleInfo(id, session.settings);
		const stored = tags[id];
		return {
			id,
			name,
			tag,
			color,
			hidden,
			section,
			builtin: isBuiltinRole(id),
			...(stored?.name ? { label: stored.name } : {}),
			...(stored?.description ? { description: stored.description } : {}),
		};
	});
}

/** Stock's resolution bound to this session; each role resolves over its own candidate pool, as its stock caller does. */
function roleStock(session: AgentSession): RoleStock {
	const { settings, modelRegistry } = session;
	const pool = (role: string) => roleCandidatePool(role, settings, modelRegistry);
	return {
		resolve: (role, selectors) => resolveModelOverride(selectors, { getAvailable: () => pool(role) }, settings),
		selectRole: (role, roles) => resolveRoleSelection(roles, settings, pool(role)),
		chatRoleIds: CHAT_MODEL_ROLE_IDS,
		configured: role => settings.getModelRole(role)?.trim() || undefined,
		sessionModel: () => session.model,
		chains: role => {
			const info = getRoleInfo(role, settings);
			const off = disabledProviderIds(settings);
			const chain = (models: Parameters<typeof resolveRoleChain>[2]) =>
				resolveRoleChain(role, settings, models).map(({ model }) => ({
					provider: model.provider,
					id: model.id,
					name: model.name,
					kind: modelKind(model),
				}));
			return {
				preferred: chain(
					modelRegistry.getAll("all").filter(model => info.accepts(model) && !off.has(model.provider)),
				),
				usable: chain(pool(role)),
			};
		},
	};
}

function modelRoles(session: AgentSession) {
	const stock = roleStock(session);
	return roleMetadata(session).map(role => ({
		...role,
		model: shownRoleValue(role.id, session.settings.getModelRole(role.id)),
		source: session.settings.getModelRoleSource(role.id),
		effective: effectiveRole(stock, role.id, role.builtin),
		candidates: roleCandidatePool(role.id, session.settings, session.modelRegistry).map(model => ({
			provider: model.provider,
			id: model.id,
			name: model.name,
			kind: modelKind(model),
		})),
	}));
}

function customRoleId(params: unknown): string {
	const id = requiredString(params, "id");
	const error = customRoleIdError(id, []);
	if (error) throw new Error(`"${id}" cannot be a custom role id (${error})`);
	return id;
}

// ============================================================================
// Methods
// ============================================================================

export const methods: BridgeMethods = {
	// Schema, reads and writes re-check OMPdesk's thinking defaults (syncThinkingDefault).
	...guard(["settings", "thinkingDefault"], {
		settings_schema: async (_params, env) => settingsSchema(env.session()),
		settings_get: async (params, env) => {
			const paths = asRecord(params).paths;
			return getSettings(
				env.session(),
				Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string") : undefined,
			);
		},
		settings_set: async (params, env) =>
			setSetting(env, env.session(), requiredString(params, "path"), asRecord(params).value),
	}),
	...guard("settings", {
		/** Main calls this when the bridge connects and after any tab's login or logout. */
		image_generation_sync: async (_params, env) => {
			await refreshImageGeneration(env.session());
			return {};
		},
	}),
	...guard("models", {
		models_catalog: async (params, env) => refreshCatalog(env, env.session(), asRecord(params).forceRefresh === true),
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
			const providerId = requiredString(params, "providerId");
			const accounts = await listLogoutAccounts(session.modelRegistry.authStorage, providerId, session.sessionId);
			for (const account of accounts) {
				await logoutCredential(session.modelRegistry, providerId, account.credentialId, session.sessionId);
			}
			emitCatalogUpdate(env, session);
			return { providerId };
		},
	}),
	...guard(["providers", "usage"], {
		provider_accounts: async (params, env) =>
			providerAccounts(env, env.session(), requiredString(params, "providerId"), asRecord(params).refresh === true),
	}),
	...guard("usage", {
		usage: async (params, env) => usage(env, env.session(), asRecord(params).refresh === true),
	}),
	...guard("modelRoles", {
		model_roles: async (_params, env) => ({ roles: modelRoles(env.session()) }),
		model_role_metadata: async (_params, env) => ({ roles: roleMetadata(env.session()) }),
		model_role_set: async (params, env) => {
			const session = env.session();
			const role = requiredString(params, "role");
			const modelId = asRecord(params).modelId;
			session.settings.setModelRole(
				role,
				storedRoleValue(role, typeof modelId === "string" && modelId ? modelId : undefined, value =>
					extractExplicitThinkingSelector(value, session.settings, {
						isLiteralModelId: (provider, id) =>
							session.modelRegistry
								.getAll()
								.some(model => (provider === undefined || model.provider === provider) && model.id === id),
					}),
				),
			);
			await session.settings.flush();
			env.emit({ type: "config_update", model: session.model, thinkingLevel: session.thinkingLevel });
			return { role, modelId: typeof modelId === "string" ? modelId : null };
		},
		/**
		 * Names a custom role (selected as `@id`): stock's `modelTags.<id>` display name, which also
		 * makes an empty role a known one, plus OMPdesk's own `description`. An empty name shows the id;
		 * a preset role with neither returns to its default entry.
		 */
		model_role_define: async (params, env) => {
			const session = env.session();
			const id = customRoleId(params);
			const fields = asRecord(params);
			const name = typeof fields.name === "string" ? fields.name.trim().slice(0, 40) : "";
			const description = typeof fields.description === "string" ? fields.description.trim().slice(0, 240) : "";
			const tags = roleTags(session);
			const { description: _previous, ...kept } = tags[id] ?? {};
			if (presetRole(id) && !name && !description) {
				delete tags[id];
			} else {
				tags[id] = { ...kept, name: name || id, ...(description ? { description } : {}) };
			}
			await setSetting(env, session, "modelTags", tags);
			return { id };
		},
		/** Removes a custom role: its model, its `modelTags` entry and its place in the quick-switch cycle. */
		model_role_forget: async (params, env) => {
			const session = env.session();
			const id = customRoleId(params);
			session.settings.setModelRole(id, undefined);
			const tags = roleTags(session);
			delete tags[id];
			await setSetting(env, session, "modelTags", tags);
			const cycle = lookup("cycleOrder") as unknown as SettingLike | undefined;
			const order = cycle?.get(session.settings);
			if (Array.isArray(order) && order.includes(id)) {
				await setSetting(
					env,
					session,
					"cycleOrder",
					order.filter(role => role !== id),
				);
			}
			return { id };
		},
	}),
};
