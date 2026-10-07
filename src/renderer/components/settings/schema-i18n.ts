/**
 * Language-aware lookups for backend-provided settings schema text. English
 * comes from the schema itself; the ko overlay falls back to it per entry.
 */

import type { Lang } from "../../lib/i18n";
import { KO_GROUP_TITLES, KO_SETTINGS } from "./schema-ko";
import { KO_SCHEMA_OPTION_TEXT } from "./schema-option-ko";

type SettingText = { label: string; description?: string };

const SETTINGS: Record<Lang, Record<string, SettingText>> = { en: {}, ko: KO_SETTINGS };
const GROUP_TITLES: Record<Lang, Record<string, string>> = { en: {}, ko: KO_GROUP_TITLES };
const OPTION_TEXT: Record<Lang, Readonly<Record<string, string>>> = { en: {}, ko: KO_SCHEMA_OPTION_TEXT };

/** Translated label/description for a setting path, if the language has one. */
export function schemaSettingText(lang: Lang, path: string): SettingText | undefined {
	return SETTINGS[lang][path];
}

export function schemaGroupTitle(lang: Lang, group: string): string {
	return GROUP_TITLES[lang][group] ?? group;
}

/** Translated enum option label/description, keyed by its English text. */
export function schemaOptionText(lang: Lang, text: string): string {
	return OPTION_TEXT[lang][text] ?? text;
}

/** Every translated label/description for a setting path, for language-agnostic search. */
export function schemaSearchTexts(path: string): string[] {
	const entry = KO_SETTINGS[path];
	return entry ? [entry.label, entry.description ?? ""] : [];
}
