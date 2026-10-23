import { describe, expect, it } from "vitest";
import { fillText } from "../shared/fill-text";
import { MAIN_TEXT, type MainTextKey } from "./i18n-text";

describe("main's English counts of one", () => {
	it("say the noun in the singular and never pick a verb for the count", () => {
		const cases: Array<[MainTextKey, Record<string, number>]> = [
			["quit.workingBody", { working: 1, total: 1, windows: 1 }],
			["restart.body", { working: 1, total: 1 }],
		];
		for (const [key, params] of cases) {
			const text = fillText(MAIN_TEXT[key].en, params);
			expect(text, key).not.toMatch(/\b1 (?:of 1 )?[a-z]+s\b/);
			expect(text, key).not.toMatch(/\(s\)/);
			expect(text, key).not.toMatch(/\b1 [a-z]+ are\b/);
		}
	});

	it("say the plural for more than one", () => {
		const text = fillText(MAIN_TEXT["quit.workingBody"].en, { working: 2, total: 3, windows: 2 });
		expect(text).toContain("3 sessions");
		expect(text).toContain("2 windows");
	});
});
