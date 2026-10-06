/**
 * Plugins and marketplaces for the GUI inventory: listing, marketplace
 * actions, enable/disable, per-plugin features and settings, and plugin GUI
 * theme tokens. Ported from the omp-gui fork's rpc-domains / rpc-actions /
 * rpc-marketplace / rpc-plugins.
 *
 * `omp plugin` covers most of this, but its marketplace listing, discovery and
 * config output have no JSON form, and the effective-plugin diff behind each
 * result's `activation` needs the loader; so it runs here, in-process, and
 * every successful mutation ends in the same reload `/reload-plugins` runs.
 */
import * as path from "node:path";
import { clearPluginRootsAndCaches } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { getEnabledPlugins } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { PluginManager, validateSetting } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import { classifySource, parsePluginId } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import type { InstalledPlugin } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/types";
import { pathIsWithin } from "@oh-my-pi/pi-utils";
import { guard } from "../health";
import type { BridgeMethods } from "../types";
import {
	classifyPluginActivation,
	createMarketplaceManager,
	errorMessage,
	optScope,
	optString,
	paramsOf,
	reloadPluginState,
	requireString,
} from "./shared";

/** Accept a `name@marketplace` id verbatim; a bare name needs the `marketplace` field. */
function resolvePluginId(plugin: string | undefined, marketplace: string | undefined): string {
	if (!plugin?.trim()) throw new Error("Missing `plugin` for this marketplace action.");
	if (plugin.includes("@")) return plugin;
	if (!marketplace?.trim()) {
		throw new Error(`Plugin "${plugin}" is not qualified; pass \`marketplace\` or a "name@marketplace" id.`);
	}
	return `${plugin}@${marketplace}`;
}

/**
 * Find an installed plugin by npm name or marketplace id. PluginManager.list()
 * omits marketplace runtime symlinks, so those resolve from the installed
 * registry and their cached package manifest.
 */
async function findPlugin(manager: PluginManager, pluginId: string, cwd: string): Promise<InstalledPlugin | undefined> {
	if (!pluginId.trim()) return undefined;
	const name = parsePluginId(pluginId)?.name ?? pluginId;
	const plugins = await manager.list();
	const npmPlugin = plugins.find(plugin => plugin.name === pluginId) ?? plugins.find(plugin => plugin.name === name);
	if (npmPlugin) return npmPlugin;

	const marketplace = await createMarketplaceManager(cwd);
	const summary = (await marketplace.listInstalledPlugins()).find(candidate => candidate.id === pluginId);
	const entry = summary?.entries[0];
	if (!entry) return undefined;
	const pkg: unknown = await Bun.file(path.join(entry.installPath, "package.json"))
		.json()
		.catch(() => undefined);
	const pkgName = pkg && typeof pkg === "object" && "name" in pkg ? pkg.name : undefined;
	const packageName = (typeof pkgName === "string" && pkgName.trim()) || name;
	const effective = (await getEnabledPlugins(cwd)).find(
		plugin => plugin.path === entry.installPath || plugin.name === packageName,
	);
	return effective ?? (await manager.getPlugin(packageName, { path: entry.installPath }));
}

const SECRET_SETTING_KEY = /key|token|secret|password/i;

function isSecretSetting(key: string, schema: { secret?: boolean } | undefined): boolean {
	return schema?.secret === true || SECRET_SETTING_KEY.test(key);
}

/** Run a plugin mutation; domain failures resolve `{ ok: false, error }`. */
async function pluginMutation(run: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
	try {
		return await run();
	} catch (error) {
		return { ok: false, error: errorMessage(error) };
	}
}

export const methods: BridgeMethods = guard("plugins", {
	/** Both install channels, like `/plugins list`: npm packages and marketplace installs. */
	get_plugins: async (_params, env) => {
		const cwd = env.session().sessionManager.getCwd();
		const plugins: Record<string, unknown>[] = [];
		for (const plugin of await new PluginManager(cwd).list()) {
			plugins.push({ name: plugin.name, marketplace: "npm", enabled: plugin.enabled, version: plugin.version });
		}
		for (const summary of await (await createMarketplaceManager(cwd)).listInstalledPlugins()) {
			const entry = summary.entries[0];
			const parsed = parsePluginId(summary.id);
			plugins.push({
				id: summary.id,
				name: parsed?.name ?? summary.id,
				marketplace: parsed?.marketplace ?? "marketplace",
				enabled: entry?.enabled !== false,
				version: entry?.version ?? "",
				scope: summary.scope,
				shadowedBy: summary.shadowedBy,
			});
		}
		return { plugins };
	},

	/** `pluginCount` is omitted until the catalog is cached (marketplace add/update fetches it). */
	get_marketplaces: async (_params, env) => {
		const manager = await createMarketplaceManager(env.session().sessionManager.getCwd());
		const marketplaces = await Promise.all(
			(await manager.listMarketplaces()).map(async entry => ({
				name: entry.name,
				source: entry.sourceUri,
				pluginCount: await manager.listAvailablePlugins(entry.name).then(
					plugins => plugins.length,
					() => undefined,
				),
			})),
		);
		return { marketplaces };
	},

	/** Never throws for domain failures: they resolve `{ ok: false, error }`. */
	marketplace_action: async (params, env) => {
		const p = paramsOf(params);
		const action = p.action;
		const marketplace = optString(p, "marketplace");
		const plugin = optString(p, "plugin");
		const session = env.session();
		const cwd = session.sessionManager.getCwd();
		const result = await pluginMutation(async () => {
			if (action === "add") {
				const source = optString(p, "source");
				if (!source?.trim()) return { ok: false, error: "Missing `source` for marketplace add." };
				// Rejects bare names with guidance before the manager probes the fs.
				classifySource(source);
			}
			const manager = await createMarketplaceManager(cwd);
			switch (action) {
				case "add":
					await manager.addMarketplace(optString(p, "source") ?? "");
					return { ok: true };
				case "remove":
					if (!marketplace?.trim()) return { ok: false, error: "Missing `marketplace` for remove." };
					await manager.removeMarketplace(marketplace);
					return { ok: true };
				case "update":
					if (marketplace?.trim()) await manager.updateMarketplace(marketplace);
					else await manager.updateAllMarketplaces();
					return { ok: true };
				case "install":
				case "uninstall":
				case "upgrade": {
					if (action === "install" && !plugin?.trim())
						return { ok: false, error: "Missing `plugin` for install." };
					if (action === "install" && !marketplace?.trim()) {
						return { ok: false, error: "Missing `marketplace` for install." };
					}
					const before = await getEnabledPlugins(cwd);
					if (action === "install") await manager.installPlugin(plugin ?? "", marketplace ?? "");
					else if (action === "uninstall") await manager.uninstallPlugin(resolvePluginId(plugin, marketplace));
					else await manager.upgradePlugin(resolvePluginId(plugin, marketplace));
					return { ok: true, activation: classifyPluginActivation(before, await getEnabledPlugins(cwd)) };
				}
				case "list_available": {
					// Cache-backed: reflects the last add/update fetch.
					const installedIds = new Set((await manager.listInstalledPlugins()).map(summary => summary.id));
					const entries = await manager.listMarketplaces();
					if (marketplace && !entries.some(entry => entry.name === marketplace)) {
						return { ok: false, error: `Marketplace "${marketplace}" not found` };
					}
					const plugins: Record<string, unknown>[] = [];
					for (const entry of entries) {
						if (marketplace && entry.name !== marketplace) continue;
						for (const available of await manager.listAvailablePlugins(entry.name)) {
							plugins.push({
								name: available.name,
								description: available.description,
								version: available.version,
								installed: installedIds.has(`${available.name}@${entry.name}`),
								author: available.author?.name || undefined,
								license: available.license,
								repository: available.repository,
								homepage: available.homepage,
								category: available.category,
								tags: available.tags?.length ? available.tags : undefined,
							});
						}
					}
					return { ok: true, plugins };
				}
				default:
					return { ok: false, error: `Unknown marketplace action: ${String(action)}` };
			}
		});
		if (result.ok && action !== "list_available") await reloadPluginState(session);
		return result;
	},

	/** Marketplace installs address by `name@marketplace` (`/plugins enable`); anything else is an npm package. */
	set_plugin_enabled: async (params, env) => {
		const p = paramsOf(params);
		const id = requireString(p, "pluginId");
		if (!id.trim()) throw new Error("Plugin id cannot be empty");
		const enabled = p.enabled === true;
		const session = env.session();
		const cwd = session.sessionManager.getCwd();
		const before = await getEnabledPlugins(cwd);
		let channel: "npm" | "marketplace";
		if (parsePluginId(id)) {
			await (await createMarketplaceManager(cwd)).setPluginEnabled(id, enabled, optScope(p));
			channel = "marketplace";
		} else {
			await new PluginManager(cwd).setEnabled(id, enabled);
			clearPluginRootsAndCaches();
			channel = "npm";
		}
		const activation = classifyPluginActivation(before, await getEnabledPlugins(cwd));
		await reloadPluginState(session);
		return { id, enabled, channel, activation };
	},

	/**
	 * Declarative GUI theme tokens (`gui.theme`, a JSON asset inside the
	 * plugin) from the plugins the runtime would load. Stock manifests carry no
	 * typed `gui` field; the key passes through untyped. Bad or escaping assets
	 * skip only their plugin.
	 */
	get_gui_themes: async (_params, env) => {
		const themes: Array<{ id: string; tokens: Record<string, string> }> = [];
		for (const plugin of await getEnabledPlugins(env.session().sessionManager.getCwd())) {
			const gui = "gui" in plugin.manifest ? plugin.manifest.gui : undefined;
			const themePath = gui && typeof gui === "object" && "theme" in gui ? gui.theme : undefined;
			if (typeof themePath !== "string" || themePath.length === 0) continue;
			const resolved = path.resolve(plugin.path, themePath);
			if (!pathIsWithin(plugin.path, resolved)) continue;
			try {
				const parsed: unknown = await Bun.file(resolved).json();
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
				themes.push({
					id: plugin.name,
					tokens: Object.fromEntries(
						Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
					),
				});
			} catch {
				// Optional asset; its failure must not break the inventory.
			}
		}
		return { themes };
	},

	/** Features with live state, the settings schema, and non-secret values; secrets only appear in `configuredKeys`. */
	get_plugin_detail: async (params, env) => {
		const pluginId = requireString(paramsOf(params), "pluginId");
		const cwd = env.session().sessionManager.getCwd();
		const manager = new PluginManager(cwd);
		const plugin = await findPlugin(manager, pluginId, cwd);
		if (!plugin) throw new Error(`Plugin "${pluginId}" not found.`);
		const enabledSet = plugin.enabledFeatures === null ? null : new Set(plugin.enabledFeatures);
		const features = Object.entries(plugin.manifest.features ?? {}).map(([id, feature]) => ({
			id,
			description: feature.description,
			enabled: enabledSet ? enabledSet.has(id) : feature.default === true,
		}));
		const configured = await manager.getPluginSettings(plugin.name);
		const schema = plugin.manifest.settings;
		return {
			id: plugin.name,
			enabled: plugin.enabled,
			features,
			settingsSchema: schema
				? Object.fromEntries(
						Object.entries(schema).map(([key, setting]) => {
							if (!isSecretSetting(key, setting)) return [key, setting];
							const { default: _secretDefault, ...redacted } = setting;
							return [key, redacted];
						}),
					)
				: undefined,
			values: Object.fromEntries(Object.entries(configured).filter(([key]) => !isSecretSetting(key, schema?.[key]))),
			configuredKeys: Object.keys(configured),
		};
	},

	set_plugin_features: async (params, env) => {
		const p = paramsOf(params);
		const pluginId = requireString(p, "pluginId");
		const features = Array.isArray(p.features) ? p.features.filter(f => typeof f === "string") : [];
		const session = env.session();
		const cwd = session.sessionManager.getCwd();
		const result = await pluginMutation(async () => {
			const manager = new PluginManager(cwd);
			const plugin = await findPlugin(manager, pluginId, cwd);
			if (!plugin) return { ok: false, error: `Plugin "${pluginId}" not found.` };
			const before = await getEnabledPlugins(cwd);
			await manager.setEnabledFeatures(plugin.name, features);
			clearPluginRootsAndCaches();
			return { ok: true, activation: classifyPluginActivation(before, await getEnabledPlugins(cwd)) };
		});
		if (result.ok) await reloadPluginState(session);
		return result;
	},

	/** Validated against the manifest schema; unknown keys and invalid values ride `error`. */
	set_plugin_setting: async (params, env) => {
		const p = paramsOf(params);
		const pluginId = requireString(p, "pluginId");
		const key = requireString(p, "key");
		const session = env.session();
		const cwd = session.sessionManager.getCwd();
		const result = await pluginMutation(async () => {
			if (!key.trim()) return { ok: false, error: "Setting key cannot be empty" };
			const manager = new PluginManager(cwd);
			const plugin = await findPlugin(manager, pluginId, cwd);
			if (!plugin) return { ok: false, error: `Plugin "${pluginId}" not found.` };
			const settings = plugin.manifest.settings;
			const schema = settings?.[key];
			if (settings && !schema) {
				return {
					ok: false,
					error: `Unknown setting "${key}" for plugin "${plugin.name}". Available: ${Object.keys(settings).join(", ")}`,
				};
			}
			if (schema) {
				const validation = validateSetting(p.value, schema);
				if (!validation.valid) {
					return { ok: false, error: `Invalid value for "${key}": ${validation.error ?? "schema mismatch"}` };
				}
			}
			await manager.setPluginSetting(plugin.name, key, p.value);
			return { ok: true };
		});
		if (result.ok) await reloadPluginState(session);
		return result;
	},

	delete_plugin_setting: async (params, env) => {
		const p = paramsOf(params);
		const pluginId = requireString(p, "pluginId");
		const key = requireString(p, "key");
		const session = env.session();
		const cwd = session.sessionManager.getCwd();
		const result = await pluginMutation(async () => {
			if (!key.trim()) return { ok: false, error: "Setting key cannot be empty" };
			const manager = new PluginManager(cwd);
			const plugin = await findPlugin(manager, pluginId, cwd);
			if (!plugin) return { ok: false, error: `Plugin "${pluginId}" not found.` };
			await manager.deletePluginSetting(plugin.name, key);
			return { ok: true };
		});
		if (result.ok) await reloadPluginState(session);
		return result;
	},
});
