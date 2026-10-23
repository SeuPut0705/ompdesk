/**
 * Locale parity guard. The GUI ships en/ko locales as flat key→string maps;
 * drift between them silently renders raw keys in the UI. For ko, asserts:
 *
 * 1. It exposes exactly en's key set (both directions).
 * 2. No empty values.
 * 3. Its {placeholders} are a subset of en's (Korean legitimately drops
 *    plural markers like {plural}, but must never invent new params).
 * 4. For the namespaces internationalized in the language-switcher wave,
 *    it must genuinely translate — no value may be identical to its English
 *    source unless allowlisted as a proper noun / acronym / symbol.
 */

import { describe, expect, it } from "vitest";
import { translate } from "../lib/i18n";
import { en } from "./en";
import { ko } from "./ko";

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
	"chat.",
	"tools.",
	"todoPanel.",
	"logPanel.",
	"filesPanel.",
	"planPanel.",
	"subagent.",
	"agentHub.",
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
	"input.mode.python.badge": true, // $ Python — prefix symbol + language name
	"stats.col.ttft": true, // TTFT — latency acronym
	"stats.overview.ttftSub": true, // TTFT {time} — acronym + placeholder
	"stats.col.tps": true, // tok/s — unit symbol, the same in every language
	"stats.overview.tokensPerSecond": true, // {rate} tok/s — placeholder + unit
	"modelPicker.speed": true, // ~{value} tok/s — placeholder + unit
	"chat.meter.rate": true, // {rate} tok/s — placeholder + unit
	"stats.requests.detail.api": true, // API — protocol acronym
	"githubAuth.version": true, // gh {version} — CLI name + placeholder
	"chat.exec.python": true, // Python — language name
	"chat.exec.shell": true, // Shell — universal term in dev UIs
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

const TRANSLATIONS = { ko } as const;

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

describe("ko steer wording", () => {
	// Stock's "steer" is one concept in the composer, the transcript, the queue, subagents and Settings.
	it("calls a steer 추가 지시 wherever en mentions one, and never 스티어링", () => {
		const steerKeys = Object.keys(en).filter(
			key => /steer/i.test(en[key]) || /^(input|subagent)\.(placeholder\.streaming|steer\.placeholder)$/.test(key),
		);
		expect(steerKeys.length).toBeGreaterThan(10);
		for (const key of steerKeys) {
			expect(ko[key], `ko["${key}"] (en: ${en[key]})`).toContain("추가 지시");
		}
		for (const [key, value] of Object.entries(ko)) expect(value, `ko["${key}"]`).not.toMatch(/스티어/);
	});

	it("labels the subagent steer box and its failure with the same term as its placeholder", () => {
		for (const key of ["subagent.steer.label", "subagent.steer.placeholder", "subagent.steer.failed"]) {
			expect(ko[key], key).toContain("추가 지시");
		}
	});
});

describe("ko machine setup copy", () => {
	// The setup screen names a fixed tool (Bun, omp, Git, GitHub CLI, Node.js), so a hedged
	// particle like 을(를) reads as unfinished on the first screen a new user sees. Word the
	// sentence around 설치 instead.
	it("has no hedged particles", () => {
		for (const [key, value] of Object.entries(ko)) {
			if (!key.startsWith("machineSetup.")) continue;
			expect(value, `ko["${key}"]`).not.toMatch(/(을\(를\)|이\(가\)|은\(는\)|와\(과\)|\(으\)로)/);
		}
	});
});

describe("ko stop wording", () => {
	// Stopping a run (turn, subagent, schedule run, side question) is 중단 everywhere; 중지 stays for
	// pausing or halting things that are not runs (page load, recording, port forwards).
	it("says 중단, never 중지, where a run is stopped", () => {
		const keys = [
			"input.abort",
			"chat.status.stop",
			"sidebar.subagents.stop",
			"btw.cancel",
			"btw.cancelled",
			"events.notificationError",
			"events.notificationErrorDetail",
			"tools.hub.state.stopping",
			"schedules.stop",
			"schedules.status.stopped",
			"agentHub.hub.abortTurn",
			"agentHub.hub.abortAgent",
		];
		for (const key of keys) {
			expect(ko[key], key).toContain("중단");
			expect(ko[key], key).not.toContain("중지");
		}
	});
});

describe("en file counts", () => {
	it("say '1 file', not '1 files'", () => {
		for (const key of ["filesPanel.count", "diffPanel.repositorySummary"]) {
			expect(en[key], key).toContain("{plural}");
		}
	});
});

describe("en counts of one", () => {
	it("say the noun in the singular wherever one can be counted", () => {
		const cases: Array<[string, Record<string, number | string>]> = [
			["modelCompare.count", { shown: 1, total: 1 }],
			["extPanel.countFiltered.hooks", { shown: 1, total: 1 }],
			["extPanel.countFiltered.mcp", { shown: 1, total: 1 }],
			["extPanel.countFiltered.commands", { shown: 1, total: 1 }],
			["sessionTree.shownOfTotal", { shown: 1, total: 1 }],
			["settings.skills.count", { shown: 1, total: 1 }],
			["github.issues.commentCount", { count: 1 }],
			["github.releases.downloads", { count: 1 }],
			["settings.search.count", { count: 1 }],
			["ssh.ready.hosts", { count: 1 }],
			["tools.eval.cells", { count: 1 }],
			["extensionUpdate.count", { count: 1 }],
			["import.messages", { count: 1 }],
			["workTree.orphans.removed", { count: 1 }],
			["todoCmd.exportCopied", { count: 1 }],
			["hostUi.update.running", { count: 1 }],
			["hostUi.quit.running", { count: 1 }],
		];
		for (const [key, params] of cases) {
			expect(en[key], key).toBeDefined();
			const text = translate(key, params);
			expect(text, key).not.toMatch(/\b1 (?:of 1 )?[a-z]+s\b/);
			expect(text, key).not.toMatch(/\b1 [a-z]+ are\b/);
		}
	});
});
