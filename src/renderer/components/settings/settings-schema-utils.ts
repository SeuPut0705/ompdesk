/** Settings schema helpers: condition-gated visibility and GUI support. */

import type { SettingEntry } from "../../../shared/rpc-types";
import { GUI_DISPLAY_LEGACY_PATHS } from "../../lib/display-preferences";

/**
 * Renderer counterpart of stock's private `CONDITIONS` table
 * (pi-coding-agent config/settings-ui.ts): the settings-backed visibility
 * gates a schema entry names in `condition`. Stock evaluates them against its
 * global settings instance, so the GUI re-evaluates them against its live
 * values; settings-schema-utils.test.ts pins each one to stock. `parent` is
 * the setting that opens the gate (the inactive row's "Configure" link).
 * Host gates (macOS, hasImageProtocol, nativeRendering) and the provenance
 * gate contextFilesExtraNotProject are not value-evaluable: unknown gates
 * keep the entry visible.
 */
const SETTING_CONDITIONS: Record<string, { parent: string; visible: (values: Record<string, unknown>) => boolean }> = {
	advisorEnabled: { parent: "advisor.enabled", visible: values => values["advisor.enabled"] === true },
	hindsightActive: { parent: "memory.backend", visible: values => values["memory.backend"] === "hindsight" },
	mnemopiActive: { parent: "memory.backend", visible: values => values["memory.backend"] === "mnemopi" },
	autolearnActive: { parent: "autolearn.enabled", visible: values => values["autolearn.enabled"] === true },
	autoThinkingActive: {
		parent: "defaultThinkingLevel",
		visible: values => values.defaultThinkingLevel === "auto",
	},
	usageAwareFallbackEnabled: {
		parent: "retry.usageAwareFallback",
		visible: values => values["retry.usageAwareFallback"] === true,
	},
	planModeEnabled: { parent: "plan.enabled", visible: values => values["plan.enabled"] === true },
	vimModeEnabled: { parent: "tui.vimMode", visible: values => values["tui.vimMode"] === true },
	planAutosaveEnabled: {
		parent: "plan.autosave",
		visible: values => values["plan.enabled"] === true && values["plan.autosave"] === true,
	},
};

/** An entry is hidden only while its condition names a settings-backed gate that resolves false. */
export function isSettingVisible(entry: SettingEntry, values: Record<string, unknown>): boolean {
	if (entry.condition === undefined) return true;
	return SETTING_CONDITIONS[entry.condition]?.visible(values) ?? true;
}

/** The setting that enables a condition gate, for linking an inactive row to it. */
export function conditionParent(condition: string | undefined): string | undefined {
	return condition === undefined ? undefined : SETTING_CONDITIONS[condition]?.parent;
}

/** Terminal display settings and equivalents owned by GUI preferences. */
const TERMINAL_DISPLAY_SETTINGS = new Set([
	...GUI_DISPLAY_LEGACY_PATHS,
	"tui.resizeScrollback",
	"statusLine.preset",
	"display.showTurnTime",
	"theme.dark",
	"theme.light",
	"tui.tight",
	"colorBlindMode",
	"spelling.typoDetection",
	"spelling.autocomplete",
	"spelling.autocorrect",
	// Vim mode's indicator is rendered only by the TUI status line. Keeping the
	// schema row out of the GUI prevents a control that can never affect this
	// renderer from being advertised under a conditional gate.
	"tui.vimModeDisplay",
	"tui.mouse",
	"tui.maxInlineImageColumns",
	"tui.maxInlineImageRows",
	"tui.maxInlineImages",
	"statusLine.leftSegments",
	"statusLine.rightSegments",
	"statusLine.segmentOptions",
]);

export function isSettingSupportedInGui(entry: { path?: string; tuiOnly?: boolean }): boolean {
	return entry.tuiOnly !== true && !TERMINAL_DISPLAY_SETTINGS.has(entry.path ?? "");
}

export function isSettingVisibleInGui(entry: SettingEntry, values: Record<string, unknown>): boolean {
	return isSettingSupportedInGui(entry) && isSettingVisible(entry, values);
}
