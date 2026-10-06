import { type SettingsStore, useSettingsStore } from "../stores/settings";
import { toast } from "../stores/toast";
import { type GuiDisplayPreferences, useUiStore } from "../stores/ui";
import { translate } from "./i18n";

export const GUI_DISPLAY_BOOL_FIELDS = [
	"hideThinkingBlock",
	"proseOnlyThinking",
	"showTokenUsage",
	"collapseCompacted",
	"titleState",
	"goalStatusInFooter",
	"showProgress",
	"emojiAutocomplete",
] as const;
export const GUI_DISPLAY_LEGACY_PATHS = [
	"hideThinkingBlock",
	"proseOnlyThinking",
	"display.showTokenUsage",
	"display.collapseCompacted",
	"tui.titleState",
	"goal.statusInFooter",
	"terminal.showProgress",
	"emojiAutocomplete",
	"paste.largeMenuThreshold",
];

/** An absent new preference reads the legacy Agent value without writing back to it. */
export function useDisplayPreference<K extends keyof GuiDisplayPreferences>(key: K): SettingsStore[K] {
	const legacy = useSettingsStore(state => state[key]);
	const local = useUiStore(state => state.displayPreferences[key]);
	return (local ?? legacy) as SettingsStore[K];
}

export function readDisplayPreference<K extends keyof GuiDisplayPreferences>(key: K): SettingsStore[K] {
	return (useUiStore.getState().displayPreferences[key] ?? useSettingsStore.getState()[key]) as SettingsStore[K];
}

export function hydrateDisplayPreferences(raw: unknown): void {
	if (!raw || typeof raw !== "object") return;
	const values = raw as Record<string, unknown>;
	const parsed: GuiDisplayPreferences = {};
	for (const key of GUI_DISPLAY_BOOL_FIELDS) if (typeof values[key] === "boolean") parsed[key] = values[key];
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
		toast({ variant: "error", title: translate("settings.saveFailed"), message: String(error) });
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
