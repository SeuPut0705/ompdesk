/** UI languages shipped by the GUI, in switcher cycle order. Shared by main (menus, tray) and renderer. */
export const UI_LANGUAGES = ["en", "ko"] as const;

export type UiLanguage = (typeof UI_LANGUAGES)[number];

/** Autonyms shown in language pickers. */
export const UI_LANGUAGE_NAMES: Record<UiLanguage, string> = { en: "English", ko: "한국어" };

export function isUiLanguage(value: unknown): value is UiLanguage {
	return typeof value === "string" && (UI_LANGUAGES as readonly string[]).includes(value);
}

/** Maps an OS/browser locale tag (`ko-KR`, `en-GB`, …) to a UI language, falling back to English. */
export function uiLanguageFromLocale(locale: string | undefined): UiLanguage {
	const tag = (locale ?? "").toLowerCase();
	if (tag.startsWith("ko")) return "ko";
	return "en";
}

/** Next language in the switcher cycle. */
export function nextUiLanguage(lang: UiLanguage): UiLanguage {
	return UI_LANGUAGES[(UI_LANGUAGES.indexOf(lang) + 1) % UI_LANGUAGES.length];
}

/** BCP 47 tag for Intl formatting. */
export const UI_LANGUAGE_INTL: Record<UiLanguage, string> = { en: "en-US", ko: "ko-KR" };
