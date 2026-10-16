/**
 * OMPdesk's runtime-override defaults wired to stock omp (rules, values and the
 * list: thinking-default-core.ts): `defaultThinkingLevel` = auto, the auto
 * classifier's ceiling `providers.autoThinkingMaxEffort` = max, goal continuation
 * over RPC, and the stock features OMPdesk turns on (token usage, LSP diagnostics
 * on edit, format on write, ast_grep, the advisor).
 * Stock Setting.pinDefault can only pin its schema's high/xhigh defaults; GUI auto/max
 * requires a runtime override so CLI defaults and explicit user configuration stay untouched.
 *
 * Timing: stock `main.ts` initializes Settings, then loads the `-e` extensions
 * (index.ts awaits `applyGuiThinkingDefault` inside the factory), and only then
 * calls createAgentSession, whose initial pick (`sdk.ts` pickInitialThinkingLevel)
 * falls back to `defaultThinkingLevel`. The first session therefore already
 * starts on `auto`, and so do `new_session` (keeps the configured selection),
 * `switch_session` into a transcript without a thinking entry, and subagents
 * (`task/executor.ts` createSubagentSettings snapshots the parent's effective
 * default unless the agent definition or the caller picks a level). The
 * ceiling is read per classification (`auto-thinking/classifier.ts`), so it
 * applies to every auto turn of the process. Tool sets (ast_grep) and the
 * advisor are built by createAgentSession and read their settings there.
 * `applyProtocolDefaults("rpc")` (stock main.ts) pinned `advisor.enabled` off
 * before the extensions load; the override here replaces that pin.
 * Not held, because stock reads them before the extensions load or only the
 * terminal UI reads them: `telemetry.otlpExportEnabled` (main.ts
 * initTelemetryExport), `display.showTurnTime` and `read.toolResultPreview` (TUI renderers).
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import {
	applyThinkingDefault,
	asThinkingDefaultSetting,
	configuredIn,
	GUI_THINKING_DEFAULTS,
	NATIVE_DEFAULTS,
	releaseThinkingDefault,
	settleThinkingDefault,
	type ThinkingDefaultSetting,
} from "./thinking-default-core";

/** The persisted layers stock exposes (config.yml, project config). */
interface PersistedLayers {
	getGlobalSettings?(): unknown;
	getProjectSettings?(): unknown;
}

/** Per held id this omp cannot serve: why it stays at stock's value (Settings shows it as a note). */
const unavailable: Record<string, string> = {};

/** The held defaults this omp could not take up, as setting id → note code (settings.ts adds it to the schema). */
export function heldDefaultNotes(): Readonly<Record<string, string>> {
	return unavailable;
}

/** The setting ids OMPdesk holds a default for on this omp. */
function heldIds(): string[] {
	return Object.keys(GUI_THINKING_DEFAULTS).filter(id => unavailable[id] === undefined);
}

/** The handles this omp has for OMPdesk's defaults (a missing one is skipped). */
function handles(): ThinkingDefaultSetting[] {
	return heldIds().flatMap(id => {
		const setting = asThinkingDefaultSetting(lookup(id));
		return setting ? [setting] : [];
	});
}

/** The layers' persisted view of one setting (config.yml, project config). */
function persistedIn(layers: PersistedLayers, setting: ThinkingDefaultSetting): boolean {
	return (
		configuredIn(layers.getGlobalSettings?.(), setting.segments) ||
		configuredIn(layers.getProjectSettings?.(), setting.segments)
	);
}

/** Feature-detect the native addon behind a held default: a vanished export keeps stock's value. */
async function detectNatives(pi: ExtensionAPI): Promise<void> {
	// Dynamic on purpose: the addon is a per-platform package, and a failed load must degrade to stock's value.
	const natives: Record<string, unknown> | undefined = await import("@oh-my-pi/pi-natives").catch(() => undefined);
	for (const [id, member] of Object.entries(NATIVE_DEFAULTS)) {
		if (typeof natives?.[member] === "function") continue;
		unavailable[id] = "native";
		pi.logger.warn("gui-bridge: native addon lacks a feature OMPdesk's default needs", { setting: id, member });
	}
}

/** Before the first session: hold OMPdesk's defaults on the process Settings unless a layer sets them. */
export async function applyGuiThinkingDefault(pi: ExtensionAPI): Promise<void> {
	await detectNatives(pi);
	const settings = handles();
	if (settings.length < heldIds().length) {
		pi.logger.warn("gui-bridge: this omp cannot hold every OMPdesk default", {
			held: settings.map(setting => setting.id),
		});
	}
	const scope = pi.pi.Settings.instance;
	for (const setting of settings) applyThinkingDefault(setting, scope, persistedIn(scope, setting));
}

/** Re-check against config.yml and the project config (Settings reads and writes call this). */
export function syncThinkingDefault(scope: object): void {
	const layers = scope as PersistedLayers;
	for (const setting of handles()) settleThinkingDefault(setting, scope, persistedIn(layers, setting));
}

/** A Settings write of `settingId` is the user's choice: drop the default under it first. */
export function releaseThinkingDefaultFor(settingId: string, scope: object): void {
	if (!(settingId in GUI_THINKING_DEFAULTS)) return;
	const setting = asThinkingDefaultSetting(lookup(settingId));
	if (setting) releaseThinkingDefault(setting, scope);
}
