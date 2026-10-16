/**
 * Extensions kept current (src/main/ext-update/): the marketplaces, plugins, skills and MCP servers of this
 * computer's omp. The schedule is the tool CLIs' (launch after machine setup, then every 4 h, a per-item
 * back-off, failures recorded, deferred items retried), the work is stock's own (marketplace refresh,
 * `PluginManager.upgrade`, `MarketplaceManager.upgradePlugin`, `updateSkillPackages`) run in the stock helper's
 * `extensions` worker, or the owner's own command for an MCP server's global binary (run as
 * `SetupService.runToolUpdate`). OMPdesk never writes the user's MCP config and never moves a pinned version.
 * Each computer updates its own; a paired host does its own. The renderer shows this state and may ask for
 * "Update now" by row key; it never names a command, a path or a version to install.
 */

/** Settings › Updates & about › Update extensions automatically (default on); a stored `false` turns it off. */
export const EXTENSION_AUTO_UPDATE_PREF = "extensionAutoUpdate";

/** Display order. */
export const EXTENSION_KINDS = ["marketplace", "plugin", "skill", "mcp"] as const;
export type ExtensionKind = (typeof EXTENSION_KINDS)[number];

/**
 * How OMPdesk keeps a row current.
 * - `catalog`: a marketplace's catalog, refreshed by stock's `MarketplaceManager.updateMarketplace`.
 * - `marketplace`: a plugin installed from a marketplace, upgraded by stock's `upgradePlugin`.
 * - `npm-plugin` / `git-plugin`: a plugin installed by `omp plugin install <pkg|git url>`, upgraded by stock's `PluginManager.upgrade`.
 * - `registry`: a skill installed from a skills registry (`skills.json`), updated by stock's `updateSkillPackages`.
 * - `npm` / `bun` / `brew` / `brew-cask` / `winget` / `pipx` / `uv` / `pip`: an MCP server's global binary, updated by the package manager that owns it.
 */
export type ExtensionMethod =
	| "catalog"
	| "marketplace"
	| "npm-plugin"
	| "git-plugin"
	| "registry"
	| "npm"
	| "bun"
	| "brew"
	| "brew-cask"
	| "winget"
	| "pipx"
	| "uv"
	| "pip";

/**
 * Why OMPdesk leaves a listed row alone (the row has no method then, except `pinned`, which is still checked).
 * - `pinned`: the user pinned a version or ref (an exact or tagged npm version, a git commit or tag, a
 *   skill's exact version, an MCP package `pkg@1.2.3`); a newer one is only shown as "update available".
 * - `follows-plugin`: skills a plugin provides move with that plugin.
 * - `follows-latest`: an unpinned `npx`/`bunx`/`uvx` MCP package resolves the newest version at every start.
 * - `builtin`: part of the OMPdesk release (the built-in REA MCP server).
 * - `local`: plain local files with no source recorded (skills in a folder): never updated.
 * - `linked`: a plugin linked from a local path.
 * - `remote`: an MCP server reached by URL: nothing on this computer to update.
 * - `system` / `bundled` / `not-writable` / `unknown-install`: the cli-tools meaning (`CliSkipReason`).
 * - `unversioned`: a marketplace plugin whose catalog publishes no version, so a newer one cannot be told.
 */
export type ExtensionSkipReason =
	| "pinned"
	| "follows-plugin"
	| "follows-latest"
	| "builtin"
	| "local"
	| "linked"
	| "remote"
	| "system"
	| "bundled"
	| "not-writable"
	| "unknown-install"
	| "unversioned";

/**
 * - `check`: looking up the newest version failed (`detail`).
 * - `install`: the update failed or could not start (`detail`).
 * - `not-updated`: it finished, but the item still reports the old version.
 * - `needs-approval`: a new skill version ships scripts; stock asks the user, OMPdesk never approves for them.
 * - `cancelled`: stopped by quitting.
 */
export type ExtensionFailureReason = "check" | "install" | "not-updated" | "needs-approval" | "cancelled";

export interface ExtensionFailure {
	reason: ExtensionFailureReason;
	detail?: string;
}

/**
 * The last check's outcome.
 * - `available`: a pinned row's newer version; nothing was changed.
 * - `deferred`: a newer version exists but `why` holds it back: `running` = the MCP server's process runs and
 *   its update would replace files it loads; `omp-busy` = omp itself is being installed. Tried again at the next check.
 */
export type ExtensionResult =
	| { kind: "current" }
	| { kind: "refreshed" }
	| { kind: "updated"; from: string | null; to: string }
	| { kind: "available"; latest: string }
	| { kind: "deferred"; latest: string | null; why: "running" | "omp-busy" }
	| { kind: "failed"; failure: ExtensionFailure };

export interface ExtensionRow {
	/** Opaque and stable across scans (`<kind>:<id>[:<scope>[:<project>]]`); the only handle "Update now" takes. */
	key: string;
	kind: ExtensionKind;
	/** The marketplace name, the plugin id (`name@marketplace` or the npm/git package name), the skill id, the MCP server name. */
	name: string;
	/** Where it lives or what it runs: `user`, a project's folder name, or an MCP server's package (`pkg@1.2.3`, `pkg`). Display only. */
	detail: string | null;
	/** Count of items a grouped row stands for (plugin-provided skills, local skills); null for a single item. */
	count: number | null;
	/** The version installed now; null when unknown (a marketplace catalog has none; a git plugin may not). */
	installed: string | null;
	/** The newest version as of the last check; null before one, or when only the item's own updater knows. */
	latest: string | null;
	method: ExtensionMethod | null;
	skip: ExtensionSkipReason | null;
	phase: "idle" | "checking" | "updating";
	checkedAt: number | null;
	last: ExtensionResult | null;
}

export interface ExtensionUpdateState {
	/** The pref: whether scheduled checks may update. "Update now" works either way. */
	enabled: boolean;
	/** This launch checks on a timer (packaged app, or a test launch that opts in). */
	scheduled: boolean;
	/** In `EXTENSION_KINDS` order, then by name. */
	rows: ExtensionRow[];
}
