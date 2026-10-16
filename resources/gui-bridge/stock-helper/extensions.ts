/**
 * The `extensions` worker (`host.ts extensions`): everything the extension updater (src/main/ext-update/)
 * asks of this computer's omp without a session: what is installed (marketplaces, plugins, registry skills,
 * MCP servers), the catalog refresh, the plugin and skill version checks and their upgrades. The contracts
 * are in extensions-contracts.ts; the pure decisions (pins, origins) in extension-specs.ts.
 *
 * Stock does every mutation (`MarketplaceManager.updateMarketplace` / `upgradePlugin`, `PluginManager.upgrade`,
 * `updateSkillPackages`); this file only reads stock's state, shapes it, and decides what OMPdesk must not
 * touch. Stock modules are imported at call time from the user's omp (`OMP_PACKAGE_ROOT`), never at module
 * load: the stock and terminals workers must start on an install that has none of them. No answer carries an
 * env value, a header, a token or a URL credential.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { classifyActivation, type PluginActivation, pluginRequiresRestart } from "../extensions/activation-core";
import {
	classifySkillOrigin,
	isExactSkillVersion,
	isLinkedSpec,
	isPinnedGitRef,
	isPinnedNpmSpec,
	isUnversionedInstall,
} from "./extension-specs";
import type {
	HelperInventory,
	HelperMarketplace,
	HelperMcpServer,
	HelperPlugin,
	HelperRegistrySkill,
	MarketplaceRefreshResult,
	PluginCheckResult,
	PluginSelector,
	PluginUpgradeResult,
	SkillCheckResult,
	SkillSelector,
	SkillUpdateResult,
} from "./extensions-contracts";

const AGENT = "@oh-my-pi/pi-coding-agent";
const UTILS = "@oh-my-pi/pi-utils";

/** One metadata request to an npm registry. */
const REGISTRY_TIMEOUT_MS = 30_000;

// ─── The user's stock, as far as this worker reads it ───────────────────────────────────────────────────────

interface MarketplaceRegistryEntry {
	name: string;
	sourceUri: string;
	updatedAt: string;
}
interface InstalledPluginEntry {
	version: string;
	enabled?: boolean;
}
interface InstalledPluginSummary {
	id: string;
	scope: "user" | "project";
	entries: InstalledPluginEntry[];
}
interface MarketplaceManagerOptions {
	marketplacesRegistryPath: string;
	installedRegistryPath: string;
	projectInstalledRegistryPath?: string;
	marketplacesCacheDir: string;
	pluginsCacheDir: string;
	clearPluginRootsCache?: (extraPaths?: readonly string[]) => void;
}
interface StockMarketplaceManager {
	listMarketplaces(): Promise<MarketplaceRegistryEntry[]>;
	updateMarketplace(name: string): Promise<MarketplaceRegistryEntry>;
	listInstalledPlugins(): Promise<InstalledPluginSummary[]>;
	checkForUpdates(): Promise<Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string }>>;
	upgradePlugin(pluginId: string, scope?: "user" | "project"): Promise<InstalledPluginEntry>;
}
interface MarketplaceModule {
	MarketplaceManager: new (options: MarketplaceManagerOptions) => StockMarketplaceManager;
	getInstalledPluginsRegistryPath(): string;
	getMarketplacesCacheDir(): string;
	getMarketplacesRegistryPath(): string;
	getPluginsCacheDir(): string;
}
interface HelpersModule {
	clearPluginRootsAndCaches(extraPaths?: readonly string[]): void;
	resolveActiveProjectRegistryPath(cwd: string): Promise<string | null>;
}
interface StockInstalledPlugin {
	name: string;
	version: string;
	enabled: boolean;
}
interface ScopedPlugin {
	name: string;
	path: string;
	version: string;
	enabledFeatures: string[] | null;
}
interface LoaderModule {
	getEnabledPlugins(cwd: string): Promise<ScopedPlugin[]>;
	resolvePluginManifestEntries(plugin: ScopedPlugin, key: "extensions" | "tools" | "hooks"): readonly unknown[];
}
interface StockPluginManager {
	list(): Promise<StockInstalledPlugin[]>;
	upgrade(name: string): Promise<{ from: string | undefined; plugin: StockInstalledPlugin; changed: boolean }>;
}
interface ManagerModule {
	PluginManager: new (cwd?: string) => StockPluginManager;
}
interface GitUrlModule {
	parseGitUrl(source: string): { ref?: string } | null;
}
interface UtilsModule {
	getPluginsPackageJson(): string;
	getMCPConfigPath(scope: "user" | "project", cwd?: string): string;
}
interface NpmRegistry {
	url: string;
	authorization?: string;
}
interface NpmRegistryModule {
	loadNpmRegistryResolver(): Promise<(pkg: string) => NpmRegistry>;
	npmRegistryPackageUrl(registry: NpmRegistry, pkg: string, tag?: string): string;
}

interface SkillPackument {
	distTags: Record<string, string>;
}
interface StockSkillClient {
	packument(scope: string, name: string): Promise<SkillPackument>;
	close(): void;
}
interface SkillClientModule {
	SkillshareClient: { create(): Promise<StockSkillClient> };
}
interface SkillChange {
	id: string;
	from?: string;
	to: string;
}
interface InstalledSkillInfo {
	id: string;
	range?: string;
	version?: string;
	scope: "project" | "user";
}
interface SkillInstallerModule {
	listInstalledSkills(cwd: string): Promise<InstalledSkillInfo[]>;
	resolveSkillVersion(packument: SkillPackument, request: string): { version: string };
	updateSkillPackages(
		client: StockSkillClient,
		options: { names: string[]; global: boolean; cwd: string; yes?: boolean },
		hooks: { confirmScripts(request: unknown): Promise<boolean>; warn(message: string): void },
	): Promise<SkillChange[]>;
}
interface SkillManifestModule {
	getProjectSkillsInstallPaths(cwd: string): Promise<{ dir: string }>;
}

interface SourceMeta {
	provider: string;
	path: string;
	level: "user" | "project" | "native";
	pluginName?: string;
}
interface StockSkill {
	filePath: string;
	_source?: SourceMeta;
}
interface StockSettings {
	extensionsSourceLevel(): "user" | "project";
}
interface SettingsModule {
	Settings: { loadReadOnly(options: { cwd: string }): Promise<StockSettings> };
}
interface Handle<T> {
	get(settings: StockSettings): T;
}
interface ExtensionSettingsModule {
	cfgSkills: Handle<{ customDirectories?: string[] } & Record<string, unknown>>;
	cfgDisabledExtensions: Handle<readonly string[]>;
	cfgExtensions: Handle<unknown>;
}
interface SkillsModule {
	loadSkills(options: Record<string, unknown>): Promise<{ skills: StockSkill[] }>;
}
interface McpServerItem {
	name: string;
	command?: string;
	args?: string[];
	url?: string;
	transport?: string;
	_source: SourceMeta;
}
interface DiscoveryModule {
	initializeWithSettings(settings: StockSettings): () => void;
	loadCapability<T>(
		id: string,
		options: { cwd: string; includeDisabled?: boolean; filter?: (item: T & { _source: SourceMeta }) => boolean },
	): Promise<{ items: Array<T & { _source: SourceMeta }> }>;
}
interface McpConfigModule {
	loadAllMCPConfigs(
		cwd: string,
		options: { enableProjectConfig: boolean; filterExa: boolean },
	): Promise<{ configs: Record<string, { type?: string }> }>;
}

/** Import `specifier` from the user's omp and check the named exports are functions (or present). */
async function load<T>(specifier: string, ...exports: string[]): Promise<T> {
	const root = process.env.OMP_PACKAGE_ROOT;
	if (!root) throw new Error("OMP_PACKAGE_ROOT is required");
	// Runtime-selected: the modules belong to the user's resolved omp installation.
	let file: string;
	try {
		file = Bun.resolveSync(specifier, path.join(root, "package.json"));
	} catch {
		throw new Error(`Installed omp has no ${specifier}`);
	}
	const mod = (await import(file)) as Record<string, unknown>;
	for (const name of exports) {
		if (mod[name] === undefined) throw new Error(`Installed omp has no ${name} in ${specifier}`);
	}
	// The caller names the shape it reads; the exports it needs were checked above.
	return mod as unknown as T;
}

/** Where a run that needs a working directory but has no project uses: the user's home, never a project. */
const neutralCwd = () => os.homedir();

// ─── Parameters ─────────────────────────────────────────────────────────────────────────────────────────────

function record(params: unknown): Record<string, unknown> {
	if (typeof params !== "object" || params === null || Array.isArray(params)) throw new Error("Invalid parameters");
	return params as Record<string, unknown>;
}

function stringParam(params: Record<string, unknown>, key: string): string {
	const value = params[key];
	if (typeof value !== "string" || value === "") throw new Error(`Missing ${key}`);
	return value;
}

function scopeParam(params: Record<string, unknown>): "user" | "project" {
	if (params.scope !== "user" && params.scope !== "project") throw new Error("Invalid scope");
	return params.scope;
}

function cwdParam(params: Record<string, unknown>): string | null {
	return typeof params.cwd === "string" && params.cwd !== "" ? params.cwd : null;
}

function pluginSelector(params: unknown): PluginSelector {
	const input = record(params);
	const channel = input.channel;
	if (channel !== "marketplace" && channel !== "npm" && channel !== "git") throw new Error("Invalid plugin channel");
	return { channel, id: stringParam(input, "id"), scope: scopeParam(input), cwd: cwdParam(input) };
}

function skillSelector(params: unknown): SkillSelector {
	const input = record(params);
	const scope = scopeParam(input);
	const cwd = cwdParam(input);
	if (scope === "project" && cwd === null) throw new Error("A project scope needs its folder");
	return { id: stringParam(input, "id"), scope, cwd };
}

/** `cwds`, resolved and deduplicated in order. */
function inventoryCwds(params: unknown): string[] {
	const value = record(params ?? {}).cwds;
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every(item => typeof item === "string")) throw new Error("Invalid cwds");
	return [...new Set((value as string[]).filter(Boolean).map(cwd => path.resolve(cwd)))];
}

// ─── Marketplaces and marketplace plugins ───────────────────────────────────────────────────────────────────

/** The manager `omp plugin` builds (`createMarketplaceManager` in extensions/shared.ts), with an explicit project registry. */
async function marketplaceManager(projectRegistryPath: string | null): Promise<StockMarketplaceManager> {
	const [mod, helpers] = await Promise.all([
		load<MarketplaceModule>(
			`${AGENT}/extensibility/plugins/marketplace`,
			"MarketplaceManager",
			"getInstalledPluginsRegistryPath",
			"getMarketplacesCacheDir",
			"getMarketplacesRegistryPath",
			"getPluginsCacheDir",
		),
		load<HelpersModule>(
			`${AGENT}/discovery/helpers`,
			"clearPluginRootsAndCaches",
			"resolveActiveProjectRegistryPath",
		),
	]);
	return new mod.MarketplaceManager({
		marketplacesRegistryPath: mod.getMarketplacesRegistryPath(),
		installedRegistryPath: mod.getInstalledPluginsRegistryPath(),
		...(projectRegistryPath ? { projectInstalledRegistryPath: projectRegistryPath } : {}),
		marketplacesCacheDir: mod.getMarketplacesCacheDir(),
		pluginsCacheDir: mod.getPluginsCacheDir(),
		clearPluginRootsCache: helpers.clearPluginRootsAndCaches,
	});
}

/** The project registry a `cwd` resolves to (stock's own rule), or null. */
async function projectRegistryPath(cwd: string): Promise<string | null> {
	const helpers = await load<HelpersModule>(`${AGENT}/discovery/helpers`, "resolveActiveProjectRegistryPath");
	return helpers.resolveActiveProjectRegistryPath(cwd);
}

/** The manager for a selector's scope; a project scope without a project registry is an error. */
async function managerFor(selector: { scope: "user" | "project"; cwd: string | null }) {
	if (selector.scope === "user") return marketplaceManager(null);
	const registry = selector.cwd ? await projectRegistryPath(selector.cwd) : null;
	if (!registry) throw new Error("This project has no plugin registry");
	return marketplaceManager(registry);
}

async function installedMarketplacePlugin(
	manager: StockMarketplaceManager,
	id: string,
	scope: "user" | "project",
): Promise<InstalledPluginEntry> {
	const summary = (await manager.listInstalledPlugins()).find(item => item.id === id && item.scope === scope);
	const entry = summary?.entries[0];
	if (!entry) throw new Error(`Plugin "${id}" is not installed in ${scope} scope`);
	return entry;
}

/** A source URL without its `user:token@` part (a marketplace may have been added from a credentialed URL). */
function withoutCredentials(source: string): string {
	try {
		const url = new URL(source);
		if (!url.username && !url.password) return source;
		url.username = "";
		url.password = "";
		return url.href;
	} catch {
		return source;
	}
}

// ─── npm and git plugins ────────────────────────────────────────────────────────────────────────────────────

/** `dependencies` of the user's `plugins/package.json`: what stock recorded for every npm/git/linked install. */
async function recordedSpecs(): Promise<Record<string, string>> {
	const utils = await load<UtilsModule>(UTILS, "getPluginsPackageJson");
	let text: string;
	try {
		text = await fs.readFile(utils.getPluginsPackageJson(), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
		throw error;
	}
	const parsed: unknown = JSON.parse(text);
	if (typeof parsed !== "object" || parsed === null || !("dependencies" in parsed)) return {};
	const dependencies = parsed.dependencies;
	if (typeof dependencies !== "object" || dependencies === null) return {};
	const specs: Record<string, string> = {};
	for (const [name, spec] of Object.entries(dependencies)) if (typeof spec === "string") specs[name] = spec;
	return specs;
}

async function pluginManager(cwd: string | null): Promise<StockPluginManager> {
	const mod = await load<ManagerModule>(`${AGENT}/extensibility/plugins/manager`, "PluginManager");
	return new mod.PluginManager(cwd ?? neutralCwd());
}

async function channelOfSpec(spec: string | undefined): Promise<"npm" | "git" | "linked"> {
	if (spec === undefined || isLinkedSpec(spec)) return "linked";
	const gitUrl = await load<GitUrlModule>(`${AGENT}/extensibility/plugins/git-url`, "parseGitUrl");
	return gitUrl.parseGitUrl(spec) ? "git" : "npm";
}

/** The installed version and recorded spec of one npm/git plugin. */
async function recordedPlugin(id: string, cwd: string | null) {
	const [plugins, specs] = await Promise.all([(await pluginManager(cwd)).list(), recordedSpecs()]);
	const plugin = plugins.find(item => item.name === id);
	if (!plugin) throw new Error(`Plugin "${id}" is not installed`);
	return { installed: plugin.version || null, spec: specs[id] ?? null };
}

/** Whether OMPdesk must leave a recorded npm/git plugin alone (see extension-specs.ts). */
async function pinnedPlugin(channel: "npm" | "git", spec: string, installed: string | null): Promise<boolean> {
	if (channel === "npm") return isPinnedNpmSpec(spec, installed);
	const gitUrl = await load<GitUrlModule>(`${AGENT}/extensibility/plugins/git-url`, "parseGitUrl");
	return isPinnedGitRef(gitUrl.parseGitUrl(spec)?.ref);
}

/** `dist-tags.latest` of `name` on the registry stock resolves for it (the user's .npmrc / bunfig). */
async function npmLatest(name: string): Promise<string | null> {
	const registryModule = await load<NpmRegistryModule>(
		`${AGENT}/cli/npm-registry`,
		"loadNpmRegistryResolver",
		"npmRegistryPackageUrl",
	);
	const registry = (await registryModule.loadNpmRegistryResolver())(name);
	const response = await fetch(registryModule.npmRegistryPackageUrl(registry, name), {
		headers: {
			accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8",
			...(registry.authorization ? { authorization: registry.authorization } : {}),
		},
		signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`npm registry answered ${response.status} for ${name}`);
	const body: unknown = await response.json();
	const tags = typeof body === "object" && body !== null && "dist-tags" in body ? body["dist-tags"] : null;
	const latest = typeof tags === "object" && tags !== null && "latest" in tags ? tags.latest : null;
	return typeof latest === "string" ? latest : null;
}

// ─── Skills ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Run `fn` with stock's read-only settings for `cwd` bound for capability loading (a session's own binding). */
async function withSettings<T>(cwd: string, fn: (settings: StockSettings) => Promise<T>): Promise<T> {
	const [settingsModule, discovery] = await Promise.all([
		load<SettingsModule>(`${AGENT}/config/settings`, "Settings"),
		load<DiscoveryModule>(`${AGENT}/discovery`, "initializeWithSettings", "loadCapability"),
	]);
	const settings = await settingsModule.Settings.loadReadOnly({ cwd });
	const release = discovery.initializeWithSettings(settings);
	try {
		return await fn(settings);
	} finally {
		release();
	}
}

/**
 * Skills a session in `cwd` would discover, as `runSkillsCommand` (`cli/skill-list.ts`) lists them but on
 * read-only settings: that function opens the writable settings singleton (agent.db, migrations), and the
 * first cwd would then win for every later one. Needs `_source`, which its result omits.
 */
async function discoverSkills(cwd: string): Promise<StockSkill[]> {
	const [skillsModule, settingsHandles] = await Promise.all([
		load<SkillsModule>(`${AGENT}/extensibility/skills`, "loadSkills"),
		load<ExtensionSettingsModule>(
			`${AGENT}/extensibility/settings`,
			"cfgSkills",
			"cfgDisabledExtensions",
			"cfgExtensions",
		),
	]);
	return withSettings(cwd, async settings => {
		const skillsSettings = settingsHandles.cfgSkills.get(settings);
		const customDirectories = skillsSettings.customDirectories?.map(dir =>
			path.isAbsolute(dir) ? dir : path.resolve(cwd, dir),
		);
		const { skills } = await skillsModule.loadSkills({
			...skillsSettings,
			...(customDirectories?.length ? { customDirectories } : {}),
			cwd,
			disabledExtensions: [...settingsHandles.cfgDisabledExtensions.get(settings)],
			extensionRoots: {
				explicit: [],
				mode: "merge",
				configured: settingsHandles.cfgExtensions.get(settings),
				configuredLevel: settings.extensionsSourceLevel(),
			},
		});
		return skills;
	});
}

async function installedSkills(cwd: string | null): Promise<InstalledSkillInfo[]> {
	const installer = await load<SkillInstallerModule>(`${AGENT}/skillshare/installer`, "listInstalledSkills");
	return installer.listInstalledSkills(cwd ?? neutralCwd());
}

/** `@scope/name` → `[scope, name]`. */
function splitSkillId(id: string): [string, string] {
	const match = /^@([^/]+)\/(.+)$/.exec(id);
	if (!match?.[1] || !match[2]) throw new Error(`Invalid skill id "${id}"`);
	return [match[1], match[2]];
}

async function withSkillClient<T>(fn: (client: StockSkillClient) => Promise<T>): Promise<T> {
	const clientModule = await load<SkillClientModule>(`${AGENT}/skillshare/client`, "SkillshareClient");
	const client = await clientModule.SkillshareClient.create();
	try {
		return await fn(client);
	} finally {
		client.close();
	}
}

async function skillPackument(client: StockSkillClient, id: string): Promise<SkillPackument> {
	const [scope, name] = splitSkillId(id);
	try {
		return await client.packument(scope, name);
	} catch (error) {
		// `fetchPackument` in stock's skillshare/installer.ts (not exported) words a missing package this way.
		if (error instanceof Error && "status" in error && error.status === 404) {
			throw new Error(`${id} was not found in the registry`);
		}
		throw error;
	}
}

// ─── MCP servers ────────────────────────────────────────────────────────────────────────────────────────────

/** Servers the user's omp loads outside any project: their config, plugins' and other tools' (enabled or not). */
async function mcpInventory(): Promise<HelperMcpServer[]> {
	const [discovery, mcpConfig, utils] = await Promise.all([
		load<DiscoveryModule>(`${AGENT}/discovery`, "initializeWithSettings", "loadCapability"),
		load<McpConfigModule>(`${AGENT}/mcp/config`, "loadAllMCPConfigs"),
		load<UtilsModule>(UTILS, "getMCPConfigPath"),
	]);
	const cwd = neutralCwd();
	const userPath = utils.getMCPConfigPath("user", cwd);
	return withSettings(cwd, async () => {
		const [all, active] = await Promise.all([
			discovery.loadCapability<McpServerItem>("mcps", {
				cwd,
				includeDisabled: true,
				filter: server => server._source.level !== "project",
			}),
			mcpConfig.loadAllMCPConfigs(cwd, { enableProjectConfig: false, filterExa: false }),
		]);
		const seen = new Set<string>();
		const servers: HelperMcpServer[] = [];
		for (const item of all.items) {
			if (seen.has(item.name)) continue;
			seen.add(item.name);
			const live = Object.hasOwn(active.configs, item.name) ? active.configs[item.name] : undefined;
			servers.push({
				name: item.name,
				type: live?.type ?? item.transport ?? (item.url ? "http" : "stdio"),
				command: item.command ?? null,
				args: Array.isArray(item.args) ? item.args.filter(arg => typeof arg === "string") : [],
				url: item.url ? withoutCredentials(item.url) : null,
				enabled: live !== undefined,
				sourcePath: item._source.path || null,
				origin: item._source.path === userPath ? "user" : "other",
			});
		}
		return servers.sort((a, b) => a.name.localeCompare(b.name));
	});
}

// ─── Methods ────────────────────────────────────────────────────────────────────────────────────────────────

async function inventory(params: unknown): Promise<HelperInventory> {
	const cwds = inventoryCwds(params);
	const probeCwds = cwds.length > 0 ? cwds : [neutralCwd()];
	const marketplaceModule = await load<MarketplaceModule>(
		`${AGENT}/extensibility/plugins/marketplace`,
		"getInstalledPluginsRegistryPath",
	);
	const userRegistry = marketplaceModule.getInstalledPluginsRegistryPath();
	const userManager = await marketplaceManager(null);

	const marketplaces: HelperMarketplace[] = (await userManager.listMarketplaces()).map(entry => ({
		name: entry.name,
		source: withoutCredentials(entry.sourceUri),
		updatedAt: entry.updatedAt,
	}));

	const plugins: HelperPlugin[] = [];
	const pushMarketplacePlugins = (
		summaries: InstalledPluginSummary[],
		scope: "user" | "project",
		cwd: string | null,
	) => {
		for (const summary of summaries) {
			const entry = summary.entries[0];
			if (summary.scope !== scope || !entry) continue;
			plugins.push({
				channel: "marketplace",
				id: summary.id,
				scope,
				cwd,
				installed: entry.version || null,
				spec: null,
				enabled: entry.enabled !== false,
			});
		}
	};
	pushMarketplacePlugins(await userManager.listInstalledPlugins(), "user", null);
	const projectRegistries = new Map<string, string>();
	for (const cwd of cwds) {
		const registry = await projectRegistryPath(cwd);
		if (registry && registry !== userRegistry && !projectRegistries.has(registry))
			projectRegistries.set(registry, cwd);
	}
	for (const [registry, cwd] of projectRegistries) {
		pushMarketplacePlugins(await (await marketplaceManager(registry)).listInstalledPlugins(), "project", cwd);
	}

	// npm, git and linked installs live in the user's plugins dir only (`PluginManager` has no project scope).
	const [installed, specs] = await Promise.all([(await pluginManager(cwds[0] ?? null)).list(), recordedSpecs()]);
	for (const plugin of installed) {
		const spec = specs[plugin.name];
		plugins.push({
			channel: await channelOfSpec(spec),
			id: plugin.name,
			scope: "user",
			cwd: null,
			installed: plugin.version || null,
			spec: spec ?? null,
			enabled: plugin.enabled,
		});
	}

	const registrySkills: HelperRegistrySkill[] = [];
	const seenSkills = new Set<string>();
	const manifestModule = await load<SkillManifestModule>(
		`${AGENT}/skillshare/manifest`,
		"getProjectSkillsInstallPaths",
	);
	for (const cwd of probeCwds) {
		const projectDir = await manifestModule
			.getProjectSkillsInstallPaths(cwd)
			.then(paths => paths.dir)
			.catch(() => null);
		for (const skill of await installedSkills(cwd)) {
			const key = skill.scope === "project" ? `project\0${projectDir}\0${skill.id}` : `user\0${skill.id}`;
			if (skill.scope === "project" && projectDir === null) continue;
			if (seenSkills.has(key)) continue;
			seenSkills.add(key);
			registrySkills.push({
				id: skill.id,
				scope: skill.scope,
				cwd: skill.scope === "project" ? cwd : null,
				range: skill.range ?? null,
				installed: skill.version ?? null,
			});
		}
	}

	// Counts are display only: a folder whose settings or skills fail to load leaves the others' counts.
	const discovered = new Map<string, "plugin" | "local">();
	for (const cwd of probeCwds) {
		let skills: StockSkill[];
		try {
			skills = await discoverSkills(cwd);
		} catch {
			continue;
		}
		for (const skill of skills) {
			const origin = classifySkillOrigin(skill._source?.provider ?? "", skill._source?.pluginName);
			if (origin !== "registry") discovered.set(skill.filePath, origin);
		}
	}
	const origins = [...discovered.values()];

	return {
		marketplaces,
		plugins,
		registrySkills,
		pluginSkills: origins.filter(origin => origin === "plugin").length,
		localSkills: origins.filter(origin => origin === "local").length,
		mcpServers: await mcpInventory(),
	};
}

async function marketplaceRefresh(params: unknown): Promise<MarketplaceRefreshResult> {
	const name = stringParam(record(params), "name");
	const entry = await (await marketplaceManager(null)).updateMarketplace(name);
	return { updatedAt: entry.updatedAt };
}

async function pluginCheck(params: unknown): Promise<PluginCheckResult> {
	const selector = pluginSelector(params);
	if (selector.channel === "marketplace") {
		const manager = await managerFor(selector);
		const installed = (await installedMarketplacePlugin(manager, selector.id, selector.scope)).version || null;
		const outdated = (await manager.checkForUpdates()).find(
			update => update.pluginId === selector.id && update.scope === selector.scope,
		);
		return {
			installed,
			latest: outdated ? outdated.to : installed,
			pinned: false,
			unversioned: outdated === undefined && isUnversionedInstall(installed),
		};
	}
	const { installed, spec } = await recordedPlugin(selector.id, selector.cwd);
	// A plugin with no `plugins/package.json` record is a linked one (stock keeps it in the lock config only).
	if (spec === null || isLinkedSpec(spec))
		throw new Error(`${selector.id} is linked from a local path; nothing to check`);
	const pinned = await pinnedPlugin(selector.channel, spec, installed);
	// git: stock decides inside `upgrade`, which re-resolves the recorded ref.
	const latest = selector.channel === "npm" ? await npmLatest(selector.id) : null;
	return { installed, latest, pinned, unversioned: false };
}

async function pluginUpgrade(params: unknown): Promise<PluginUpgradeResult> {
	const selector = pluginSelector(params);
	const [helpers, loader] = await Promise.all([
		load<HelpersModule>(
			`${AGENT}/discovery/helpers`,
			"clearPluginRootsAndCaches",
			"resolveActiveProjectRegistryPath",
		),
		load<LoaderModule>(`${AGENT}/extensibility/plugins/loader`, "getEnabledPlugins", "resolvePluginManifestEntries"),
	]);
	const projectRegistry =
		selector.scope === "project" && selector.cwd ? await projectRegistryPath(selector.cwd) : null;
	// A fresh read on each side of the mutation: stock caches the effective plugin list per folder.
	const snapshot = async (): Promise<ScopedPlugin[]> => {
		helpers.clearPluginRootsAndCaches(projectRegistry ? [projectRegistry] : undefined);
		return loader.getEnabledPlugins(selector.cwd ?? neutralCwd());
	};

	if (selector.channel === "marketplace") {
		const manager = await managerFor(selector);
		const before = await snapshot();
		const from = (await installedMarketplacePlugin(manager, selector.id, selector.scope)).version || null;
		const upgraded = await manager.upgradePlugin(selector.id, selector.scope);
		const after = await snapshot();
		const to = upgraded.version || null;
		return { from, to, changed: from !== to, activation: activationOf(before, after, loader) };
	}

	if (selector.scope !== "user") throw new Error("npm and git plugins are installed for the user only");
	const { installed, spec } = await recordedPlugin(selector.id, selector.cwd);
	if (spec === null || isLinkedSpec(spec))
		throw new Error(`${selector.id} is linked from a local path; nothing to upgrade`);
	if (await pinnedPlugin(selector.channel, spec, installed)) {
		throw new Error(`${selector.id} is pinned (${spec}); it is not upgraded`);
	}
	const before = await snapshot();
	const upgraded = await (await pluginManager(selector.cwd)).upgrade(selector.id);
	const after = await snapshot();
	return {
		from: upgraded.from ?? null,
		to: upgraded.plugin.version || null,
		changed: upgraded.changed,
		activation: activationOf(before, after, loader),
	};
}

function activationOf(before: ScopedPlugin[], after: ScopedPlugin[], loader: LoaderModule): PluginActivation {
	return classifyActivation(before, after, plugin =>
		pluginRequiresRestart(plugin, loader.resolvePluginManifestEntries),
	);
}

async function skillCheck(params: unknown): Promise<SkillCheckResult> {
	const selector = skillSelector(params);
	const installer = await load<SkillInstallerModule>(`${AGENT}/skillshare/installer`, "resolveSkillVersion");
	const info = (await installedSkills(selector.cwd)).find(
		skill => skill.id === selector.id && skill.scope === selector.scope,
	);
	if (!info) throw new Error(`${selector.id} is not installed in ${selector.scope} scope`);
	const packument = await withSkillClient(client => skillPackument(client, selector.id));
	const range = info.range ?? null;
	return {
		installed: info.version ?? null,
		latest: packument.distTags.latest ?? null,
		within: range === null ? null : installer.resolveSkillVersion(packument, range).version,
		pinned: isExactSkillVersion(range),
	};
}

async function skillUpdate(params: unknown): Promise<SkillUpdateResult> {
	const selector = skillSelector(params);
	const installer = await load<SkillInstallerModule>(`${AGENT}/skillshare/installer`, "updateSkillPackages");
	const before = (await installedSkills(selector.cwd)).find(
		skill => skill.id === selector.id && skill.scope === selector.scope,
	);
	try {
		const changes = await withSkillClient(client =>
			installer.updateSkillPackages(
				client,
				{ names: [selector.id], global: selector.scope === "user", cwd: selector.cwd ?? neutralCwd(), yes: false },
				// A version that ships scripts needs a person's yes: answer no, and say so below.
				{ confirmScripts: async () => false, warn: () => {} },
			),
		);
		const change = changes.find(item => item.id === selector.id);
		if (!change) {
			const version = before?.version ?? null;
			return { blocked: null, from: version, to: version, changed: false };
		}
		return { blocked: null, from: change.from ?? null, to: change.to, changed: change.from !== change.to };
	} catch (error) {
		// `applyPlans` in stock's skillshare/installer.ts: "Installation of @scope/name@1.2.3 was declined".
		const declined = /@([^@\s]+) was declined$/.exec(error instanceof Error ? error.message : "");
		if (declined?.[1]) return { blocked: "needs-approval", version: declined[1] };
		throw error;
	}
}

export const methods: Record<string, (params: unknown) => Promise<unknown>> = {
	"extensions.inventory": inventory,
	"extensions.marketplace.refresh": marketplaceRefresh,
	"extensions.plugin.check": pluginCheck,
	"extensions.plugin.upgrade": pluginUpgrade,
	"extensions.skill.check": skillCheck,
	"extensions.skill.update": skillUpdate,
};
