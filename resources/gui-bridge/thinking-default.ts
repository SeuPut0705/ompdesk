/**
 * OMPdesk's thinking defaults wired to stock omp (rules and values:
 * thinking-default-core.ts): `defaultThinkingLevel` = auto, and the auto
 * classifier's ceiling `providers.autoThinkingMaxEffort` = max.
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
 * applies to every auto turn of the process.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import {
	applyThinkingDefault,
	asThinkingDefaultSetting,
	configuredIn,
	GUI_THINKING_DEFAULTS,
	releaseThinkingDefault,
	settleThinkingDefault,
	type ThinkingDefaultSetting,
} from "./thinking-default-core";

/** The persisted layers stock exposes (config.yml, project config). */
interface PersistedLayers {
	getGlobalSettings?(): unknown;
	getProjectSettings?(): unknown;
}

/** The handles this omp has for OMPdesk's defaults (a missing one is skipped). */
function handles(): ThinkingDefaultSetting[] {
	return Object.keys(GUI_THINKING_DEFAULTS).flatMap(id => {
		const setting = asThinkingDefaultSetting(lookup(id));
		return setting ? [setting] : [];
	});
}

/** Before the first session: hold OMPdesk's defaults on the process Settings unless a layer sets them. */
export function applyGuiThinkingDefault(pi: ExtensionAPI): void {
	const settings = handles();
	if (settings.length < Object.keys(GUI_THINKING_DEFAULTS).length) {
		pi.logger.warn("gui-bridge: this omp cannot hold every OMPdesk thinking default", {
			held: settings.map(setting => setting.id),
		});
	}
	for (const setting of settings) applyThinkingDefault(setting, pi.pi.Settings.instance);
}

/** Re-check against config.yml and the project config (Settings reads and writes call this). */
export function syncThinkingDefault(scope: object): void {
	const layers = scope as PersistedLayers;
	const global = layers.getGlobalSettings?.();
	const project = layers.getProjectSettings?.();
	for (const setting of handles()) {
		const persisted = configuredIn(global, setting.segments) || configuredIn(project, setting.segments);
		settleThinkingDefault(setting, scope, persisted);
	}
}

/** A Settings write of `settingId` is the user's choice: drop the default under it first. */
export function releaseThinkingDefaultFor(settingId: string, scope: object): void {
	if (!(settingId in GUI_THINKING_DEFAULTS)) return;
	const setting = asThinkingDefaultSetting(lookup(settingId));
	if (setting) releaseThinkingDefault(setting, scope);
}
