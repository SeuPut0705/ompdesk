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

// Stock TAB_GROUPS headings already use display labels; ungrouped entries use
// their stock tab id instead. These renderer labels cover that boundary.
const TAB_TITLES: Record<string, Record<Lang, string>> = {
	tasks: { en: "Tasks", ko: "작업" },
	memory: { en: "Memory", ko: "기억" },
	context: { en: "Context", ko: "컨텍스트" },
	model: { en: "Models", ko: "모델" },
	files: { en: "Files", ko: "파일" },
	shell: { en: "Shell", ko: "셸" },
	tools: { en: "Tools", ko: "도구" },
	providers: { en: "Providers", ko: "프로바이더" },
	interaction: { en: "Interaction", ko: "상호작용" },
	appearance: { en: "Appearance", ko: "화면" },
};

/** Translated label/description for a setting path, if the language has one. */
export function schemaSettingText(lang: Lang, path: string): SettingText | undefined {
	return SETTINGS[lang][path];
}

export function schemaGroupTitle(lang: Lang, group: string): string {
	const display = TAB_TITLES[group]?.[lang] ?? GROUP_TITLES[lang][group];
	if (display) return display;
	return group
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/[_.-]+/g, " ")
		.replace(/\b[a-z]/g, letter => letter.toUpperCase());
}

/** Translated enum option label/description, keyed by its English text. */
export function schemaOptionText(lang: Lang, text: string): string {
	return OPTION_TEXT[lang][text] ?? text;
}

// Stock MODEL_ROLES (pi-coding-agent config/model-roles.ts) names its built-in
// roles in English only; keyed by that name, so a custom role keeps its own.
const KO_ROLE_NAMES: Readonly<Record<string, string>> = {
	Default: "기본",
	Fast: "빠른 모델",
	Thinking: "사고 모델",
	Vision: "비전",
	Architect: "설계",
	Commit: "커밋",
	Tiny: "초소형",
	Memory: "메모리",
	Subtask: "하위 작업",
	Advisor: "어드바이저",
	"Image generation": "이미지 생성",
	"Web search": "웹 검색",
	Speech: "음성 합성",
	Dictation: "받아쓰기",
	Judge: "평가",
};
const ROLE_NAMES: Record<Lang, Readonly<Record<string, string>>> = { en: {}, ko: KO_ROLE_NAMES };

/** Display name of a model role: stock's English name, translated for a built-in role. */
export function modelRoleName(lang: Lang, name: string): string {
	return ROLE_NAMES[lang][name] ?? name;
}

/** Every translated label/description for a setting path, for language-agnostic search. */
export function schemaSearchTexts(path: string): string[] {
	const entry = KO_SETTINGS[path];
	return entry ? [entry.label, entry.description ?? ""] : [];
}
