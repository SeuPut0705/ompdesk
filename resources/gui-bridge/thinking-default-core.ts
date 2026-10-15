/**
 * OMPdesk's thinking defaults, pure half (thinking-default.ts wires it to stock
 * omp). Sessions OMPdesk spawns differ from stock in two settings unless the
 * user set them:
 *
 * - `defaultThinkingLevel` = `auto` (stock: `high`): per-turn classification.
 * - `providers.autoThinkingMaxEffort` = `max` (stock: `xhigh`): the `auto`
 *   classifier may resolve every effort the model supports, up to its top tier.
 *
 * Both are runtime overrides on the omp process's Settings: never written to
 * config.yml, so the omp CLI outside OMPdesk keeps stock behavior.
 * - Any layer that already sets a value (environment, `--config` overlay,
 *   project config, config.yml) is the user's choice and wins; so does a later
 *   write through OMPdesk's Settings, which releases the override first.
 * - `settleThinkingDefault` re-checks against the persisted layers: a value the
 *   user wrote into config.yml or a project config meanwhile releases the
 *   override, and a reset back to "not configured" takes it up again.
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
};

/** The stock `Setting` handle members used here (`lookup("defaultThinkingLevel")`). */
export interface ThinkingDefaultSetting {
	id: string;
	segments: readonly string[];
	/** Whether the environment or any settings layer (runtime, overlay, project, global) sets the value. */
	isConfigured(scope: object): boolean;
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
	return value as ThinkingDefaultSetting;
}

/** Per Settings instance, the setting ids whose OMPdesk default is held as a runtime override. */
const held = new WeakMap<object, Set<string>>();

function isHeld(setting: ThinkingDefaultSetting, scope: object): boolean {
	return held.get(scope)?.has(setting.id) === true;
}

/** Hold OMPdesk's default on `scope` while no layer sets the value; true when the default is in effect. */
export function applyThinkingDefault(setting: ThinkingDefaultSetting, scope: object): boolean {
	if (isHeld(setting, scope)) return true;
	const value = GUI_THINKING_DEFAULTS[setting.id];
	if (value === undefined || setting.isConfigured(scope)) return false;
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
	applyThinkingDefault(setting, scope);
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
