/**
 * Enforces the Korean glossary (`ko-glossary.ts`, human copy in the session notes) over every
 * Korean string the app ships: the locale, the settings-schema text and the main-process
 * labels. One name per concept, 해요체 only, no hedged particles.
 */

import { describe, expect, it } from "vitest";
import { MAIN_TEXT } from "../../main/i18n-text";
import { TRAY_LABELS } from "../../main/tray-labels";
import { KO_SETTINGS } from "../components/settings/schema-ko";
import { KO_SCHEMA_OPTION_TEXT } from "../components/settings/schema-option-ko";
import { en } from "./en";
import { ko } from "./ko";
import { formalEnding, HEDGED_PARTICLE, KO_GLOSSARY } from "./ko-glossary";

/** Every Korean string with where it lives, so a failure names the key. */
function koTexts(): [string, string][] {
	const texts: [string, string][] = Object.entries(ko).map(([key, value]) => [`ko.${key}`, value]);
	for (const [key, entry] of Object.entries(KO_SETTINGS)) {
		texts.push([`schema.${key}.label`, entry.label]);
		if (entry.description) texts.push([`schema.${key}.description`, entry.description]);
	}
	for (const [key, value] of Object.entries(KO_SCHEMA_OPTION_TEXT)) texts.push([`schema-option.${key}`, value]);
	for (const [key, value] of Object.entries(MAIN_TEXT)) texts.push([`main.${key}`, value.ko]);
	for (const [key, value] of Object.entries(TRAY_LABELS)) {
		if (typeof value.ko === "string") texts.push([`tray.${key}`, value.ko]);
	}
	return texts;
}

describe("ko glossary", () => {
	const texts = koTexts();

	it("reads a real corpus", () => {
		expect(texts.length).toBeGreaterThan(5000);
	});

	for (const entry of KO_GLOSSARY) {
		it(`names ${entry.concept} ${entry.term}, never a second spelling`, () => {
			const offenders = texts
				.filter(([, value]) => entry.avoid.test(value))
				.map(([key, value]) => `${key}: ${value}`);
			expect(offenders).toEqual([]);
		});
	}

	it("has no hedged particle like 을(를) anywhere", () => {
		const offenders = texts
			.filter(([, value]) => HEDGED_PARTICLE.test(value))
			.map(([key, value]) => `${key}: ${value}`);
		expect(offenders).toEqual([]);
	});

	it("speaks 해요체, never 합니다체", () => {
		const offenders = texts
			.filter(([, value]) => formalEnding(value) !== null)
			.map(([key, value]) => `${key}: ${value}`);
		expect(offenders).toEqual([]);
	});

	it("catches the endings it exists for", () => {
		expect(formalEnding("보내지 못했습니다")).toBe("습니다");
		expect(formalEnding("끕니다")).toBe("끕니다");
		expect(formalEnding("결과가 아니다")).toBeNull();
		expect(formalEnding("보내지 못했어요")).toBeNull();
	});
});

describe("en wording", () => {
	// 237 messages say "Couldn't"; the few "Could not" stragglers read as another voice.
	it("says Couldn't, never Could not", () => {
		const offenders = Object.entries(en)
			.filter(([, value]) => /\b[Cc]ould not\b/.test(value))
			.map(([key, value]) => `${key}: ${value}`);
		expect(offenders).toEqual([]);
	});
});
