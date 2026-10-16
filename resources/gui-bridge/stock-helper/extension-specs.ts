/**
 * Pure decisions of the extensions worker (extensions.ts), kept free of stock imports so tests and main can
 * read them without an omp install. Each one names the stock fact it rests on.
 */

/** What `plugins/package.json` records for a plugin stock installed from a local path (`PluginManager.upgrade` refuses it). */
const LINKED_SPEC = /^(file|link|workspace|portal):/i;

export function isLinkedSpec(spec: string): boolean {
	return LINKED_SPEC.test(spec);
}

/**
 * Whether an npm plugin's recorded spec is a pin only OMPdesk can honor by not calling `upgrade` (stock's
 * `PluginManager.upgrade` reinstalls the bare name at the registry's latest whatever the record says).
 *
 * Measured with bun 1.4.2 against a local registry (`bun install --no-cache <spec>`, what stock runs):
 * `pkg` and `pkg@latest` record `^<latest>`, `pkg@beta` (a dist-tag) records `^<tagged version>` (the tag
 * is lost: indistinguishable from a bare install), `pkg@1.2.3` records `1.2.3`, `pkg@^1.0.0` / `~1.0.0` /
 * `1` / `1.x` / `>=1.0.0` record themselves, `pkg@*` records `*`. So a bare install reads `^<installed>`
 * (not pinned); a hand-written `latest`, `*` or an empty value follows latest as well; anything else (an
 * exact version, another range, a dist-tag written by hand) is the user's pin.
 */
export function isPinnedNpmSpec(spec: string | null | undefined, installed: string | null): boolean {
	const value = (spec ?? "").trim();
	if (value === "" || value === "latest" || value === "*") return false;
	return value !== `^${installed}`;
}

/**
 * Whether a git plugin's ref fixes it to one revision (a 7-40 hex commit, or a version tag like `v1.2`,
 * `1.2.3`): stock's `upgrade` re-resolves the recorded ref, so such a ref can never move. A branch name or
 * no ref follows the repository.
 */
export function isPinnedGitRef(ref: string | undefined): boolean {
	if (ref === undefined || ref === "") return false;
	return /^[0-9a-f]{7,40}$/i.test(ref) || /^v?\d+\.\d+/.test(ref);
}

/**
 * Stock records a catalog entry that publishes no version as `0.0.0` (`installPlugin`: `resolveCatalogVersion
 * ?? "0.0.0"`), and `checkForUpdates` skips an entry without a catalog version, so an install at `0.0.0`
 * the catalog does not list as outdated has nothing to compare.
 */
export function isUnversionedInstall(installed: string | null): boolean {
	return installed === "0.0.0";
}

/**
 * A skill manifest range that is one exact version (`1.2.3`, `v1.2.3`, `1.2.3-beta.1+build`). Copy of
 * `EXACT_VERSION_RE` in stock's `skillshare/installer.ts` (not exported).
 */
export function isExactSkillVersion(range: string | null | undefined): boolean {
	return (
		range !== null && range !== undefined && /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(range)
	);
}

/** Capability providers whose skills come from an installed plugin (`discovery/{claude-plugins,agent-plugins,omp-plugins}.ts`). */
const PLUGIN_SKILL_PROVIDERS: Record<string, true> = {
	"claude-plugins": true,
	"agent-plugins": true,
	"omp-plugins": true,
};

/** Stock's skillshare provider id (`SKILLSHARE_PROVIDER_ID` in `discovery/skillshare.ts`): registry installs. */
const REGISTRY_SKILL_PROVIDER = "skillshare";

export type SkillOrigin = "registry" | "plugin" | "local";

/**
 * Where a discovered skill comes from, by its `_source`: registry installs (listed by id elsewhere), a
 * plugin's skills (they follow the plugin) or plain local files.
 */
export function classifySkillOrigin(provider: string, pluginName: string | undefined): SkillOrigin {
	if (provider === REGISTRY_SKILL_PROVIDER) return "registry";
	if (Object.hasOwn(PLUGIN_SKILL_PROVIDERS, provider) || (pluginName !== undefined && pluginName !== ""))
		return "plugin";
	return "local";
}
