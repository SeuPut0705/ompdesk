/**
 * OMPdesk's thinking default wired to stock omp (rules: thinking-default-core.ts).
 *
 * Timing: stock `main.ts` initializes Settings, then loads the `-e` extensions
 * (index.ts awaits `applyGuiThinkingDefault` inside the factory), and only then
 * calls createAgentSession, whose initial pick (`sdk.ts` pickInitialThinkingLevel)
 * falls back to `defaultThinkingLevel`. The first session therefore already
 * starts on `auto`, and so do `new_session` (keeps the configured selection),
 * `switch_session` into a transcript without a thinking entry, and subagents
 * (`task/executor.ts` createSubagentSettings snapshots the parent's effective
 * default unless the agent definition or the caller picks a level).
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import {
	applyThinkingDefault,
	asThinkingDefaultSetting,
	configuredIn,
	releaseThinkingDefault,
	settleThinkingDefault,
} from "./thinking-default-core";

const SETTING_ID = "defaultThinkingLevel";

/** The persisted layers stock exposes (config.yml, project config). */
interface PersistedLayers {
	getGlobalSettings?(): unknown;
	getProjectSettings?(): unknown;
}

/** Before the first session: hold `auto` on the process Settings unless a layer sets the level. */
export function applyGuiThinkingDefault(pi: ExtensionAPI): void {
	const setting = asThinkingDefaultSetting(lookup(SETTING_ID));
	if (!setting) {
		pi.logger.warn("gui-bridge: this omp cannot hold the auto thinking default");
		return;
	}
	applyThinkingDefault(setting, pi.pi.Settings.instance);
}

/** Re-check against config.yml and the project config (Settings reads and writes call this). */
export function syncThinkingDefault(scope: object): void {
	const setting = asThinkingDefaultSetting(lookup(SETTING_ID));
	if (!setting) return;
	const layers = scope as PersistedLayers;
	const persisted =
		configuredIn(layers.getGlobalSettings?.(), setting.segments) ||
		configuredIn(layers.getProjectSettings?.(), setting.segments);
	settleThinkingDefault(setting, scope, persisted);
}

/** A Settings write of `settingId` is the user's choice: drop the default under it first. */
export function releaseThinkingDefaultFor(settingId: string, scope: object): void {
	if (settingId !== SETTING_ID) return;
	const setting = asThinkingDefaultSetting(lookup(SETTING_ID));
	if (setting) releaseThinkingDefault(setting, scope);
}
