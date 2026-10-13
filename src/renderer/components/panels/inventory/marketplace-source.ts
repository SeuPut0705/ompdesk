/**
 * Pure helpers behind the Plugins & resources interactive Marketplaces tab,
 * kept DOM-free so the contract tests exercise them directly.
 *
 * classifyMarketplaceSource mirrors the agent-side classifySource
 * (coding-agent src/extensibility/plugins/marketplace/fetcher.ts): a bare
 * name is NOT a valid source — the agent throws; the GUI rejects inline in
 * the add-marketplace form before the RPC ever fires.
 */

export type MarketplaceSourceKind = "url" | "git" | "github" | "local";

/**
 * Windows-style absolute paths, detected cross-platform:
 *   C:\path, C:/path → drive-letter + colon + separator
 *   \\server\share   → UNC path
 * (Same regex as the agent — path.isAbsolute is POSIX-only.)
 */
const WIN_ABS_RE = /^[A-Za-z]:[/\\]|^\\\\/;

/**
 * GitHub owner/repo shorthand: alphanumeric + hyphens/dots, one slash.
 * Protocol sources are ruled out by the earlier checks (same as the agent).
 */
const GITHUB_SHORTHAND_RE = /^[a-z0-9-]+\/[a-z0-9._-]+$/i;

/**
 * Classify a marketplace source string with the agent's rule order;
 * returns null exactly where the agent's classifySource throws
 * ("Unrecognized source format") — i.e. a bare name is invalid.
 */
export function classifyMarketplaceSource(source: string): MarketplaceSourceKind | null {
	const trimmed = source.trim();
	// Rule 1: HTTP(S) — .json suffix → url, everything else → git.
	if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
		try {
			const { pathname } = new URL(trimmed);
			return pathname.endsWith(".json") ? "url" : "git";
		} catch {
			return "git";
		}
	}
	// Rule 2: SCP-style SSH git URLs.
	if (trimmed.startsWith("git@") || trimmed.startsWith("ssh://")) return "git";
	// Rule 3: GitHub owner/repo shorthand (no protocol, no leading slash).
	if (GITHUB_SHORTHAND_RE.test(trimmed)) return "github";
	// Rule 4: explicit relative or home-relative paths.
	if (trimmed.startsWith("./") || trimmed.startsWith("~/")) return "local";
	// Rule 5: absolute paths — POSIX leading slash or Windows drive/UNC.
	if (trimmed.startsWith("/") || WIN_ABS_RE.test(trimmed)) return "local";
	return null;
}

/** Mutating actions offered for one row of marketplace_action list_available. */
export type MarketplacePluginAction = "install" | "upgrade" | "uninstall";

/**
 * Row-action mapping for the wire's installed flag
 * (RpcMarketplacePluginInfo.installed): catalog-only rows can be installed;
 * installed rows can be upgraded (reinstall moves them to the catalog
 * version) or uninstalled.
 */
export function availablePluginActions(installed: boolean): readonly MarketplacePluginAction[] {
	return installed ? ["upgrade", "uninstall"] : ["install"];
}
