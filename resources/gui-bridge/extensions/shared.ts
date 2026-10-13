/**
 * Helpers shared by the extensions-domain bridge methods (skills, hooks, MCP,
 * plugins, marketplaces, agents, themes). Ports of the omp-gui fork's
 * rpc-domains/rpc-actions plumbing onto stock omp internals.
 */
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import {
	clearPluginRootsAndCaches,
	resolveActiveProjectRegistryPath,
	resolveOrDefaultProjectRegistryPath,
} from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import {
	resolvePluginManifestEntries,
	type ScopedInstalledPlugin,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/** The GUI's params object; anything else reads as empty. */
export function paramsOf(params: unknown): Record<string, unknown> {
	return typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
}

export function optString(params: Record<string, unknown>, key: string): string | undefined {
	const value = params[key];
	return typeof value === "string" ? value : undefined;
}

export function requireString(params: Record<string, unknown>, key: string): string {
	const value = params[key];
	if (typeof value !== "string") throw new Error(`\`${key}\` must be a string`);
	return value;
}

export function optScope(params: Record<string, unknown>): "user" | "project" | undefined {
	const scope = params.scope;
	return scope === "user" || scope === "project" ? scope : undefined;
}

/** Read a registered setting off the live session settings; `undefined` when the id is unknown to this omp. */
export function readSetting<T>(session: AgentSession, id: string): T | undefined {
	return lookup(id)?.get(session.settings) as T | undefined;
}

/**
 * Toggle an id in `disabledExtensions` (the extension dashboard's channel for
 * `skill:<name>` / `hook:<type>:<tool>:<name>`) and flush to config.yml.
 */
export async function setExtensionDisabled(
	session: AgentSession,
	extensionId: string,
	enabled: boolean,
): Promise<{ enabled: boolean; provenance: string }> {
	const setting = lookup("disabledExtensions");
	if (!setting) throw new Error("This omp version has no disabledExtensions setting");
	setting.setMember(session.settings, extensionId, { member: !enabled });
	await session.settings.flush();
	return {
		enabled: !(setting.get(session.settings) as string[]).includes(extensionId),
		provenance: setting.provenance(session.settings),
	};
}

/**
 * Stock RPC's `reloadPluginState` (what `/reload-plugins` runs headlessly):
 * drop plugin-root caches, then rediscover skills and file slash commands.
 * The refresh fires the session's command-metadata listeners, so stock RPC
 * pushes a fresh `available_commands_update` to the GUI on its own.
 */
export async function reloadPluginState(session: AgentSession): Promise<void> {
	const projectPath = await resolveActiveProjectRegistryPath(session.sessionManager.getCwd());
	clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
	await session.refreshSkillsAndCommands();
}

/** The marketplace manager `omp plugin` builds, rooted at the session cwd. */
export async function createMarketplaceManager(cwd: string): Promise<MarketplaceManager> {
	return new MarketplaceManager({
		marketplacesRegistryPath: getMarketplacesRegistryPath(),
		installedRegistryPath: getInstalledPluginsRegistryPath(),
		projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(cwd),
		marketplacesCacheDir: getMarketplacesCacheDir(),
		pluginsCacheDir: getPluginsCacheDir(),
		clearPluginRootsCache: clearPluginRootsAndCaches,
	});
}

export type PluginActivation = "live" | "restart-required";

/**
 * Whether a manifest ships executable entry points (extensions/tools/hooks) on
 * the base manifest or on a feature that would load. Those bind only at
 * session creation, so touching them needs a sidecar restart; commands and
 * skills hot-reload.
 */
function pluginRequiresRestart(plugin: ScopedInstalledPlugin): boolean {
	return (["extensions", "tools", "hooks"] as const).some(key => resolvePluginManifestEntries(plugin, key).length > 0);
}

function sameFeatures(left: string[] | null, right: string[] | null): boolean {
	if (left === null || right === null) return left === right;
	if (left.length !== right.length) return false;
	const rightSet = new Set(right);
	return left.every(feature => rightSet.has(feature));
}

/** Classify a completed plugin mutation by diffing the effective runtime state on each side. */
export function classifyPluginActivation(
	before: readonly ScopedInstalledPlugin[],
	after: readonly ScopedInstalledPlugin[],
): PluginActivation {
	const beforeByName = new Map(before.map(plugin => [plugin.name, plugin]));
	const afterByName = new Map(after.map(plugin => [plugin.name, plugin]));
	for (const name of new Set([...beforeByName.keys(), ...afterByName.keys()])) {
		const previous = beforeByName.get(name);
		const next = afterByName.get(name);
		if (
			previous &&
			next &&
			previous.path === next.path &&
			previous.version === next.version &&
			sameFeatures(previous.enabledFeatures, next.enabledFeatures)
		) {
			continue;
		}
		if ((previous && pluginRequiresRestart(previous)) || (next && pluginRequiresRestart(next))) {
			return "restart-required";
		}
	}
	return "live";
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
