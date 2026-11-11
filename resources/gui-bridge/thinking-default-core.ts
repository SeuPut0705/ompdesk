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
 * - `title.icons` = `boring` (stock: `nf+emoji`): session titles are plain text,
 *   with no icon and code card and no extra title-model request for one.
 * - `async.widgets` off (stock: on, omp ≥ 18.12.3): stock writes each background
 *   job's live widget with a `widget`-role model call once anything views the job,
 *   and the GUI's jobs poll (stock `inspectAsyncJob`, which always views) does, for
 *   widgets the GUI never draws (bridge-job-widgets-stock.test.ts).
 * - `computer.enabled` on (stock: off): the built-in `computer` eval prelude, except in an omp started on the
 *   agent-desktop engine (`OMP_GUI_COMPUTER_USE`, src/shared/computer-use.ts), where it is held off; that omp's
 *   fallback to the built-in prelude turns it on (`noteComputerUseFallback`, modes/computer-use.ts).
 * - `codexResets.*` / `claudeResets.*` auto-redeem = `no` (stock: `unset`, which asks before spending whenever a
 *   limit blocks every account or a saved reset nears its expiry): OMPdesk never suggests spending a reset (the
 *   owner's rule); a person spends one from Settings, or turns auto-redeem on there.
 * - `launch.persist` off (stock: on for every non-interactive host since omp 18.18.9): a named service an agent
 *   starts ends with the last omp of its project, so nothing a session started outlives OMPdesk.
 *
 * All are runtime overrides on the omp process's Settings: never written to
 * config.yml, so the omp CLI outside OMPdesk keeps stock behavior.
 * - Any layer that already sets a value (environment, `--config` overlay,
 *   project config, config.yml) is the user's choice and wins; so does a later
 *   write through OMPdesk's Settings, which releases the override first.
 * - `settleThinkingDefault` re-checks against the persisted layers: a value the
 *   user wrote into config.yml or a project config meanwhile releases the
 *   override, and a reset back to "not configured" takes it up again.
 * - A value stock itself puts on the runtime layer for an RPC host ({@link STOCK_HOST_VALUES}: the
 *   `protocolDefault` soft pin of `advisor.enabled`, `main.ts`'s `launch.persist` override) makes the setting
 *   read as configured, but it is no layer's value: OMPdesk's default replaces it while no persisted layer
 *   sets the setting, and a persisted value replaces it too, since a runtime value hides the user's own.
 *
 * No omp imports (not even types), no Bun globals: the GUI's vitest exercises
 * this file directly (src/main/bridge-thinking-default.test.ts).
 */

import { COMPUTER_USE_ENV, parseComputerUseEnv } from "./modes/computer-use-contracts";

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
	// The built-in engine's value. An omp started on agent-desktop holds it off instead (`defaultValueOf`).
	"computer.enabled": true,
	// Stock pins it off for RPC/ACP hosts (`protocolDefault`); a pinned default is not the user's choice.
	"advisor.enabled": true,
	// Plain session titles: no icon/code card, and no card request to the title model.
	"title.icons": "boring",
	// Stock's live job widgets cost a model call per job the GUI's jobs poll views; the GUI never draws them.
	"async.widgets": false,
	// Stock's main.ts keeps a non-interactive host's services past its exit (omp 18.18.9); OMPdesk's children never
	// outlive it, so a service ends with the last omp of its project, as in the terminal.
	"launch.persist": false,
	// Stock's `unset` asks to spend a saved reset on a blocked turn and on every usage poll that finds one expiring.
	// Held off, so nothing suggests it; the per-window ids are omp 18.18.7's, the two plain ones the omp before it.
	"codexResets.autoRedeem": "no",
	"codexResets.autoRedeem5h": "no",
	"codexResets.autoRedeemWeekly": "no",
	"claudeResets.autoRedeem": "no",
	"claudeResets.autoRedeem5h": "no",
	"claudeResets.autoRedeemWeekly": "no",
	"claudeResets.autoRedeemFable": "no",
};

/**
 * The value stock itself puts on the runtime layer of an RPC host: `advisor.enabled`'s `protocolDefault` pin
 * (`applyProtocolDefaults("rpc")`, the schema default) and `launch.persist`, which `main.ts` overrides on for
 * every non-interactive host (omp 18.18.9). Both run before the `-e` extensions load.
 */
export const STOCK_HOST_VALUES: Readonly<Record<string, unknown>> = {
	"advisor.enabled": false,
	"launch.persist": true,
};

/** Held defaults that need a native feature, and the export that proves it (see thinking-default.ts). */
export const NATIVE_DEFAULTS: Readonly<Record<string, string>> = { "astGrep.enabled": "astGrep" };

/** The held setting whose value follows the Computer use engine (modes/computer-use.ts). */
const COMPUTER_ENABLED = "computer.enabled";

/** This process's agent-desktop engine could not serve it: the built-in prelude's held value is on again. */
let computerUseFellBack = false;

export function noteComputerUseFallback(): void {
	computerUseFellBack = true;
}

/**
 * The value OMPdesk holds for `id`: {@link GUI_THINKING_DEFAULTS}, except `computer.enabled` while this omp runs on
 * the agent-desktop engine (`OMP_GUI_COMPUTER_USE`, set at spawn) and it has not fallen back: stock's prelude is off
 * then, so two engines never drive the desktop side by side.
 */
export function defaultValueOf(id: string): unknown {
	if (id === COMPUTER_ENABLED && parseComputerUseEnv(process.env[COMPUTER_USE_ENV]) === "agent-desktop") {
		return computerUseFellBack;
	}
	return GUI_THINKING_DEFAULTS[id];
}

/** The stock `Setting` handle members used here (`lookup("defaultThinkingLevel")`). */
export interface ThinkingDefaultSetting {
	id: string;
	segments: readonly string[];
	/** Whether the environment or any settings layer (runtime, overlay, project, global) sets the value. */
	isConfigured(scope: object): boolean;
	/** Effective value (needed for {@link STOCK_HOST_VALUES} settings). */
	get?(scope: object): unknown;
	/** Layer supplying the effective value (needed for {@link STOCK_HOST_VALUES} settings). */
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
		String(candidate.id) in STOCK_HOST_VALUES &&
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

/** Whether the runtime layer holds only stock's own host value for `setting` ({@link STOCK_HOST_VALUES}). */
function stockHostValueOnly(setting: ThinkingDefaultSetting, scope: object): boolean {
	if (!(setting.id in STOCK_HOST_VALUES)) return false;
	if (typeof setting.get !== "function" || typeof setting.provenance !== "function") return false;
	return setting.provenance(scope) === "runtime" && Object.is(setting.get(scope), STOCK_HOST_VALUES[setting.id]);
}

/**
 * Hold OMPdesk's default on `scope` while no layer sets the value; true when the default is in effect.
 * `persisted`: config.yml or a project config sets the value right now.
 */
export function applyThinkingDefault(setting: ThinkingDefaultSetting, scope: object, persisted = false): boolean {
	if (isHeld(setting, scope)) return true;
	const value = defaultValueOf(setting.id);
	if (value === undefined) return false;
	if (setting.isConfigured(scope)) {
		if (!stockHostValueOnly(setting, scope)) return false;
		if (persisted) {
			// Stock's runtime value would hide the user's own.
			setting.clearOverride(scope);
			return false;
		}
	}
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
 * The held value changed (`defaultValueOf`): put it on a setting this omp holds, so stock's own listeners reconcile.
 * A setting some layer sets is the user's and stays; one not held yet is taken up now, as `settleThinkingDefault` does.
 */
export function refreshThinkingDefault(setting: ThinkingDefaultSetting, scope: object, persisted: boolean): void {
	if (isHeld(setting, scope)) {
		setting.override(scope, defaultValueOf(setting.id));
		return;
	}
	applyThinkingDefault(setting, scope, persisted);
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
