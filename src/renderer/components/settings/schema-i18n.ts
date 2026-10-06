/**
 * Language-aware lookups for backend-provided settings schema text. English
 * comes from the schema itself; zh/ko overlays fall back to it per entry.
 */

import type { Lang } from "../../lib/i18n";
import { KO_GROUP_TITLES, KO_SETTINGS } from "./schema-ko";
import { KO_SCHEMA_OPTION_TEXT } from "./schema-option-ko";
import { ZH_SCHEMA_OPTION_TEXT } from "./schema-option-zh";
import { ZH_GROUP_TITLES, ZH_SETTINGS } from "./schema-zh";

type SettingText = { label: string; description?: string };

const SETTINGS: Record<Lang, Record<string, SettingText>> = { en: {}, zh: ZH_SETTINGS, ko: KO_SETTINGS };
const GROUP_TITLES: Record<Lang, Record<string, string>> = { en: {}, zh: ZH_GROUP_TITLES, ko: KO_GROUP_TITLES };
const OPTION_TEXT: Record<Lang, Readonly<Record<string, string>>> = {
	en: {},
	zh: ZH_SCHEMA_OPTION_TEXT,
	ko: KO_SCHEMA_OPTION_TEXT,
};

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
	return [ZH_SETTINGS[path], KO_SETTINGS[path]].flatMap(entry =>
		entry ? [entry.label, entry.description ?? ""] : [],
	);
}
