import { type SettingsStore, useSettingsStore } from "../stores/settings";
import { toastError } from "../stores/toast";
import { type GuiDisplayPreferences, useUiStore } from "../stores/ui";
import { translate } from "./i18n";

/**
 * Display preferences OMPdesk keeps itself, each with the omp setting it reads until set here. The run state in the
 * window title and progress on the app icon are always on (omp's `tui.titleState`/`terminal.showProgress` do not
 * reach the GUI), so they are not preferences.
 */
export const GUI_DISPLAY_BOOL_PATHS = {
	hideThinkingBlock: "hideThinkingBlock",
	proseOnlyThinking: "proseOnlyThinking",
	showTokenUsage: "display.showTokenUsage",
	collapseCompacted: "display.collapseCompacted",
	goalStatusInFooter: "goal.statusInFooter",
	emojiAutocomplete: "emojiAutocomplete",
} as const;
export type GuiDisplayBoolField = keyof typeof GUI_DISPLAY_BOOL_PATHS;
export const GUI_DISPLAY_BOOL_FIELDS = Object.keys(GUI_DISPLAY_BOOL_PATHS) as GuiDisplayBoolField[];
/** omp settings the GUI covers with its own preference or fixed behaviour; the raw stock list leaves them out. */
export const GUI_DISPLAY_LEGACY_PATHS = [
	...Object.values(GUI_DISPLAY_BOOL_PATHS),
	"tui.titleState",
	"terminal.showProgress",
	"paste.largeMenuThreshold",
];

/** An absent new preference reads the legacy Agent value without writing back to it. */
export function useDisplayPreference<K extends keyof GuiDisplayPreferences & keyof SettingsStore>(
	key: K,
): SettingsStore[K] {
	const legacy = useSettingsStore(state => state[key]);
	const local = useUiStore(state => state.displayPreferences[key]);
	return (local ?? legacy) as SettingsStore[K];
}

export function readDisplayPreference<K extends keyof GuiDisplayPreferences & keyof SettingsStore>(
	key: K,
): SettingsStore[K] {
	return (useUiStore.getState().displayPreferences[key] ?? useSettingsStore.getState()[key]) as SettingsStore[K];
}

export function hydrateDisplayPreferences(raw: unknown): void {
	if (!raw || typeof raw !== "object") return;
	const values = raw as Record<string, unknown>;
	const parsed: GuiDisplayPreferences = {};
	for (const key of GUI_DISPLAY_BOOL_FIELDS) if (typeof values[key] === "boolean") parsed[key] = values[key];
	if (typeof values.mobileEnterSends === "boolean") parsed.mobileEnterSends = values.mobileEnterSends;
	if (
		typeof values.pasteMenuThreshold === "number" &&
		Number.isInteger(values.pasteMenuThreshold) &&
		values.pasteMenuThreshold >= 0
	)
		parsed.pasteMenuThreshold = values.pasteMenuThreshold;
	// A delayed boot read must never replace a choice already made in this window.
	useUiStore.setState(state => ({ displayPreferences: { ...parsed, ...state.displayPreferences } }));
}

/** Commit preferences before displaying success; one key write cannot overwrite another. */
export async function saveGuiPreference(key: string, value: unknown, apply: () => void): Promise<boolean> {
	try {
		await window.omp.prefs.set(key, value);
		apply();
		return true;
	} catch (error) {
		toastError({ title: translate("settings.saveFailed"), error });
		return false;
	}
}

export function setDisplayPreference<K extends keyof GuiDisplayPreferences>(
	key: K,
	value: GuiDisplayPreferences[K],
): Promise<boolean> {
	return saveGuiPreference(`displayPreferences.${key}`, value, () =>
		useUiStore.setState(state => ({ displayPreferences: { ...state.displayPreferences, [key]: value } })),
	);
}
