/**
 * Locale parity guard. The GUI ships en/zh/ko locales as flat key→string maps;
 * drift between them silently renders raw keys in the UI. For each of zh and
 * ko, asserts:
 *
 * 1. It exposes exactly en's key set (both directions).
 * 2. No empty values.
 * 3. Its {placeholders} are a subset of en's (Chinese/Korean legitimately drop
 *    plural markers like {plural}, but must never invent new params).
 * 4. For the namespaces internationalized in the language-switcher wave,
 *    it must genuinely translate — no value may be identical to its English
 *    source unless allowlisted as a proper noun / acronym / symbol.
 */

import { describe, expect, it } from "vitest";
import { en } from "./en";
import { ko } from "./ko";
import { zh } from "./zh";

/** Namespaces completed or extended in the i18n-switcher wave. */
const TRANSLATED_NAMESPACES = [
	"titlebar.",
	"sidebar.",
	"input.",
	"fork.",
	"handoff.",
	"sessionTree.",
	"themePicker.",
	"planApproval.",
	"lang.",
	"common.",
	"modelCompare.",
	"invPanel.",
	"extPanel.",
	"modesPanel.",
	// Broader component wave: dialogs, stats, chat, tools, panels, layout.
	"approval.",
	"extDialog.",
	"sessionPicker.",
	"branchPicker.",
	"rename.",
	"sessionInfo.",
	"modelPicker.",
	"palette.",
	"stats.",
	"statsPop.",
	"chat.",
	"tools.",
	"todoPanel.",
	"logPanel.",
	"filesPanel.",
	"planPanel.",
	"subagent.",
	"subagentPanel.",
	"agentHub.",
	"dag.",
	"diffPanel.",
	"sidecar.",
	"panel.",
	"usage.",
	"providers.",
	"modelValue.",
	"tree.",
	// Parity-closeout waves (B1/A1/B2) and C1/B3 slices.
	"hotkeys.",
	"import.",
	"editor.",
	"readGroup.",
	"mcp.",
	"marketplace.",
	"pluginDetail.",
	"settings.launch.",
	"codeblock.",
];

/** Proper nouns, acronyms, and symbols legitimately identical across locales. */
const ALLOW_IDENTICAL: Record<string, true> = {
	"providers.badge.oauth": true, // OAuth — brand name
	"modelCompare.noRole": true, // "—" — punctuation, no letters
	"extPanel.tabs.mcp": true, // MCP — protocol acronym
	"input.modes.tab.vibe": true, // Vibe — feature name
	"input.mode.python.badge": true, // $ Python — prefix symbol + language name
	"stats.col.ttft": true, // TTFT — latency acronym
	"stats.col.tps": true, // Tok/s — unit symbol
	"stats.overview.ttftSub": true, // TTFT {time} — acronym + placeholder
	"stats.requests.detail.api": true, // API — protocol acronym
	"chat.exec.python": true, // Python — language name
	"chat.exec.shell": true, // Shell — universal term in zh dev UIs
	"tools.label.github": true, // GitHub — brand name
	"tools.label.vibe": true, // Vibe — feature name
	"themePicker.theme.nord.label": true, // Nord — theme name
	"themePicker.theme.solarized.label": true, // Solarized — theme name
	"themePicker.theme.latte.label": true, // Latte — theme name
	"mcp.wizard.urlPlaceholder": true, // example URL — not prose
};

const LATIN_LETTER = /[a-zA-Z]/;

/** Drops `{placeholder}` tokens so only prose is checked — they are code, not English words. */
function proseOf(value: string): string {
	return value.replace(/\{\w+\}/g, "");
}

function placeholdersOf(value: string): Set<string> {
	return new Set([...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]));
}

const TRANSLATIONS = { zh, ko } as const;

describe.each(Object.entries(TRANSLATIONS))("locale parity: %s", (lang, locale) => {
	it(`exposes the same keys in en and ${lang}`, () => {
		expect(Object.keys(en).filter(key => !(key in locale))).toEqual([]);
		expect(Object.keys(locale).filter(key => !(key in en))).toEqual([]);
	});

	it("has no empty values", () => {
		for (const [key, value] of Object.entries(en)) {
			expect(value.trim(), `en["${key}"] is empty`).not.toBe("");
		}
		for (const [key, value] of Object.entries(locale)) {
			expect(value.trim(), `${lang}["${key}"] is empty`).not.toBe("");
		}
	});

	it(`keeps ${lang} placeholders a subset of en placeholders`, () => {
		for (const key of Object.keys(en)) {
			const enParams = placeholdersOf(en[key]);
			const params = placeholdersOf(locale[key] ?? "");
			const invented = [...params].filter(param => !enParams.has(param));
			expect(invented, `${lang}["${key}"] invents placeholders`).toEqual([]);
		}
	});

	it("translates the switcher-wave namespaces instead of copying English", () => {
		for (const key of Object.keys(en)) {
			if (!TRANSLATED_NAMESPACES.some(ns => key.startsWith(ns))) continue;
			if (ALLOW_IDENTICAL[key]) continue;
			if (!LATIN_LETTER.test(proseOf(en[key]))) continue;
			expect(locale[key], `${lang}["${key}"] duplicates the English source`).not.toBe(en[key]);
		}
	});
});
