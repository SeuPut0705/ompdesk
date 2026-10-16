/**
 * The `extensions.*` methods of the stock helper's `extensions` worker (extensions.ts), as main's
 * ExtensionUpdater (src/main/ext-update/) calls them. Types only, no omp imports: main and the worker both
 * import this file. Every method works on this computer's omp state with no tab open: user scope always, a
 * project's scope for each folder in `cwds` (the workspaces of the open local tabs). No answer carries a
 * credential, a token or an environment variable value; the MCP inventory carries `command`/`args`/`url`
 * only because main parses the package out of them (they never reach the renderer).
 *
 * Errors are thrown (the helper's `{id, error}` reply) with a plain message; the one coded outcome is a
 * skill update that stock would have asked a human about (`blocked: "needs-approval"`).
 */

/** How a plugin got installed, which decides how stock upgrades it. */
export type HelperPluginChannel = "marketplace" | "npm" | "git" | "linked";

export interface HelperMarketplace {
	name: string;
	/** The source the user added (`owner/repo`, a URL or a local path); display only. */
	source: string;
	/** Catalog's last refresh (ISO), as the registry holds it. */
	updatedAt: string;
}

export interface HelperPlugin {
	channel: HelperPluginChannel;
	/** `name@marketplace` for a marketplace install; the package name (or git package name) otherwise. */
	id: string;
	scope: "user" | "project";
	/** The `cwds` entry whose project registry holds this install; null for user scope. */
	cwd: string | null;
	/** The installed version; null when unreadable. */
	installed: string | null;
	/**
	 * What `plugins/package.json` records for an npm or git plugin (`^1.2.3`, `1.2.3`, `beta`,
	 * `github:owner/repo#v1.0.0`); null for the other channels.
	 */
	spec: string | null;
	enabled: boolean;
}

/** A skill installed from a skills registry (stock `skills.json` + `skills.lock.json`). */
export interface HelperRegistrySkill {
	/** `@scope/name`. */
	id: string;
	scope: "user" | "project";
	cwd: string | null;
	/** The manifest range: an exact version (pinned), a range, or a dist-tag. */
	range: string | null;
	/** The locked version; null when never installed. */
	installed: string | null;
}

export interface HelperMcpServer {
	name: string;
	/** `stdio`, `http` or `sse`. */
	type: string;
	command: string | null;
	args: string[];
	url: string | null;
	enabled: boolean;
	/** The config file or plugin dir the server came from; main marks the built-in REA by it. */
	sourcePath: string | null;
	/** `user`, `project` or `plugin` (a plugin or another tool's config provided it). */
	origin: "user" | "project" | "other";
}

export interface HelperInventory {
	marketplaces: HelperMarketplace[];
	plugins: HelperPlugin[];
	registrySkills: HelperRegistrySkill[];
	/** Skills a plugin provides. */
	pluginSkills: number;
	/** Skills from plain local files (native/claude/codex/... folders) with no source recorded. */
	localSkills: number;
	mcpServers: HelperMcpServer[];
}

/** `extensions.inventory`: everything installed, from local files only (no network). */
export interface InventoryParams {
	cwds: string[];
}

/** `extensions.marketplace.refresh`: stock's `MarketplaceManager.updateMarketplace(name)`. */
export interface MarketplaceRefreshParams {
	name: string;
}
export interface MarketplaceRefreshResult {
	updatedAt: string;
}

/** Selects one installed plugin for check/upgrade. */
export interface PluginSelector {
	channel: Exclude<HelperPluginChannel, "linked">;
	id: string;
	scope: "user" | "project";
	cwd: string | null;
}

/**
 * `extensions.plugin.check`: the newest version without installing anything. Marketplace: the catalog
 * (as last refreshed) against the install (stock `checkForUpdates`); npm: the registry stock resolves for
 * that package (the user's .npmrc/bunfig) `dist-tags.latest`; git: `latest` is null (stock decides inside
 * `upgrade`, which re-resolves the recorded ref).
 * `pinned` is true when the user pinned it: an npm spec other than `^<installed>`/`latest`/`*` (an exact
 * version, a range, a dist-tag) or a git ref that is a commit or a version tag, which stock's `upgrade` would
 * otherwise move to the registry's latest or re-resolve.
 * `unversioned`: a marketplace plugin whose catalog publishes no version.
 */
export interface PluginCheckResult {
	installed: string | null;
	latest: string | null;
	pinned: boolean;
	unversioned: boolean;
}

/**
 * `extensions.plugin.upgrade`: stock's own path (`MarketplaceManager.upgradePlugin(id, scope)` or
 * `PluginManager.upgrade(name)`), never for a pinned or linked plugin (the worker refuses). `activation` is
 * what a manual upgrade reports: `live` (commands/skills hot-reload with `/reload-plugins`) or
 * `restart-required` (the plugin ships extensions, tools or hooks, which bind at session creation).
 */
export interface PluginUpgradeResult {
	from: string | null;
	to: string | null;
	changed: boolean;
	activation: "live" | "restart-required";
}

export interface SkillSelector {
	id: string;
	scope: "user" | "project";
	cwd: string | null;
}

/**
 * `extensions.skill.check`: the registry's packument. `latest` is `dist-tags.latest`; `within` is what the
 * recorded range resolves to now (stock `resolveSkillVersion`), the version an update would install.
 * `pinned`: the range is an exact version.
 */
export interface SkillCheckResult {
	installed: string | null;
	latest: string | null;
	within: string | null;
	pinned: boolean;
}

/**
 * `extensions.skill.update`: stock's `updateSkillPackages` for this one id with `yes: false` and a
 * `confirmScripts` hook that answers no. A version that ships scripts is not installed: `blocked`.
 */
export type SkillUpdateResult =
	| { blocked: null; from: string | null; to: string | null; changed: boolean }
	| { blocked: "needs-approval"; version: string };

/** Method names, so main and the worker agree. */
export const EXTENSION_HELPER_METHODS = {
	inventory: "extensions.inventory",
	marketplaceRefresh: "extensions.marketplace.refresh",
	pluginCheck: "extensions.plugin.check",
	pluginUpgrade: "extensions.plugin.upgrade",
	skillCheck: "extensions.skill.check",
	skillUpdate: "extensions.skill.update",
} as const;
