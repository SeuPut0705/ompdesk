/**
 * OMPdesk's runtime-override defaults, pure half (thinking-default.ts wires it to
 * stock omp). Sessions OMPdesk spawns differ from stock in the settings of
 * {@link GUI_THINKING_DEFAULTS} unless the user set them:
 *
 * - `defaultThinkingLevel` = `auto` (stock: `high`): per-turn classification.
 * - `providers.autoThinkingMaxEffort` = `max` (stock: `xhigh`): the `auto`
 *   classifier may resolve every effort the model supports, up to its top tier.
 * - `goal.continuationModes` lists `rpc` (stock: interactive only).
 * - Stock features OMPdesk turns on: token usage rows, LSP diagnostics after edits,
 *   LSP formatting on write, the ast_grep tool and the advisor.
 *
 * All are runtime overrides on the omp process's Settings: never written to
 * config.yml, so the omp CLI outside OMPdesk keeps stock behavior.
 * - Any layer that already sets a value (environment, `--config` overlay,
 *   project config, config.yml) is the user's choice and wins; so does a later
 *   write through OMPdesk's Settings, which releases the override first.
 * - `settleThinkingDefault` re-checks against the persisted layers: a value the
 *   user wrote into config.yml or a project config meanwhile releases the
 *   override, and a reset back to "not configured" takes it up again.
 * - A setting stock pins to its default for protocol hosts (`protocolDefault`,
 *   `advisor.enabled` over RPC) reads as configured through that soft pin, which is
 *   no layer's value: {@link PROTOCOL_PINNED} settings take it over while nothing
 *   but the pin sets them.
 *
 * No omp imports (not even types), no Bun globals: the GUI's vitest exercises
 * this file directly (src/main/bridge-thinking-default.test.ts).
 */

/** The setting ids OMPdesk holds a default for, and that default. */
export const GUI_THINKING_DEFAULTS: Readonly<Record<string, unknown>> = {
	defaultThinkingLevel: "auto",
	"providers.autoThinkingMaxEffort": "max",
	// Stock continues a goal between turns over RPC only when this lists "rpc" (its default is ["interactive"]).
	"goal.continuationModes": ["interactive", "rpc"],
	// Stock features that cost nothing to enable and work over RPC (the GUI shows the usage row from this value).
	"display.showTokenUsage": true,
	"lsp.diagnosticsOnEdit": true,
	"lsp.formatOnWrite": true,
	// The tool is a native addon shipped with omp (`@oh-my-pi/pi-natives`); thinking-default.ts feature-detects it.
	"astGrep.enabled": true,
	// Stock pins it off for RPC/ACP hosts (`protocolDefault`); a pinned default is not the user's choice.
	"advisor.enabled": true,
};

/** Settings stock soft-pins to their default for RPC hosts (`protocolDefault: ["rpc", "acp"]`). */
export const PROTOCOL_PINNED: Readonly<Record<string, true>> = { "advisor.enabled": true };

/** Held defaults that need a native feature, and the export that proves it (see thinking-default.ts). */
export const NATIVE_DEFAULTS: Readonly<Record<string, string>> = { "astGrep.enabled": "astGrep" };

/** The stock `Setting` handle members used here (`lookup("defaultThinkingLevel")`). */
export interface ThinkingDefaultSetting {
	id: string;
	segments: readonly string[];
	/** The schema default (a protocol pin holds exactly this value). */
	default?: unknown;
	/** Whether the environment or any settings layer (runtime, overlay, project, global) sets the value. */
	isConfigured(scope: object): boolean;
	/** Effective value (needed for {@link PROTOCOL_PINNED} settings). */
	get?(scope: object): unknown;
	/** Layer supplying the effective value (needed for {@link PROTOCOL_PINNED} settings). */
	provenance?(scope: object): string;
	override(scope: object, value: unknown): void;
	clearOverride(scope: object): void;
}

/** `value` as a thinking-default handle, or undefined when this omp lacks a member it needs. */
export function asThinkingDefaultSetting(value: unknown): ThinkingDefaultSetting | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as Partial<Record<keyof ThinkingDefaultSetting, unknown>>;
	if (typeof candidate.id !== "string" || !Array.isArray(candidate.segments)) return undefined;
	if (
		typeof candidate.isConfigured !== "function" ||
		typeof candidate.override !== "function" ||
		typeof candidate.clearOverride !== "function"
	)
		return undefined;
	if (
		PROTOCOL_PINNED[String(candidate.id)] === true &&
		(typeof candidate.get !== "function" || typeof candidate.provenance !== "function")
	)
		return undefined;
	return value as ThinkingDefaultSetting;
}

/** Per Settings instance, the setting ids whose OMPdesk default is held as a runtime override. */
const held = new WeakMap<object, Set<string>>();

function isHeld(setting: ThinkingDefaultSetting, scope: object): boolean {
	return held.get(scope)?.has(setting.id) === true;
}

/**
 * Whether the only thing setting `setting` is stock's protocol pin: a runtime value equal to the schema
 * default, with no environment, overlay, project or global layer behind it (`persisted` covers the last two).
 */
function pinnedOnly(setting: ThinkingDefaultSetting, scope: object, persisted: boolean): boolean {
	if (PROTOCOL_PINNED[setting.id] !== true || persisted) return false;
	if (typeof setting.get !== "function" || typeof setting.provenance !== "function") return false;
	return setting.provenance(scope) === "runtime" && Object.is(setting.get(scope), setting.default);
}

/**
 * Hold OMPdesk's default on `scope` while no layer sets the value; true when the default is in effect.
 * `persisted`: config.yml or a project config sets the value right now.
 */
export function applyThinkingDefault(setting: ThinkingDefaultSetting, scope: object, persisted = false): boolean {
	if (isHeld(setting, scope)) return true;
	const value = GUI_THINKING_DEFAULTS[setting.id];
	if (value === undefined) return false;
	if (setting.isConfigured(scope) && !pinnedOnly(setting, scope, persisted)) return false;
	setting.override(scope, value);
	const ids = held.get(scope) ?? new Set<string>();
	ids.add(setting.id);
	held.set(scope, ids);
	return true;
}

/** Drop the default before the user's own write lands, so the write is what takes effect. */
export function releaseThinkingDefault(setting: ThinkingDefaultSetting, scope: object): void {
	if (!held.get(scope)?.delete(setting.id)) return;
	setting.clearOverride(scope);
}

/**
 * Follow the persisted layers: `persisted` is whether config.yml or a project
 * config sets the value right now. A held default yields to such a value; with
 * none and no other layer setting it, the default is taken up (again).
 */
export function settleThinkingDefault(setting: ThinkingDefaultSetting, scope: object, persisted: boolean): void {
	if (isHeld(setting, scope)) {
		if (persisted) releaseThinkingDefault(setting, scope);
		return;
	}
	applyThinkingDefault(setting, scope, persisted);
}

/** Whether a raw settings layer (`getGlobalSettings()`, `getProjectSettings()`) sets the value at `segments`. */
export function configuredIn(layer: unknown, segments: readonly string[]): boolean {
	let cursor = layer;
	for (const segment of segments) {
		if (typeof cursor !== "object" || cursor === null) return false;
		cursor = (cursor as Record<string, unknown>)[segment];
	}
	return cursor !== undefined && cursor !== null;
}
