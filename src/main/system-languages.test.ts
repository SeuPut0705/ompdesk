import { describe, expect, it, vi } from "vitest";
import { acceptLanguages, applyAcceptLanguages, seedSpellchecker, spellcheckerLanguage } from "./system-languages";

/** The slice of Electron's `Session` the helpers use. */
function fakeSession(languages: string[], available = ["de", "de-DE", "en-GB", "en-US", "fr", "fr-FR", "pt-BR"]) {
	return {
		availableSpellCheckerLanguages: available,
		getSpellCheckerLanguages: vi.fn(() => languages),
		setSpellCheckerLanguages: vi.fn(),
		getUserAgent: vi.fn(() => "Mozilla/5.0 OMPdesk"),
		setUserAgent: vi.fn(),
	};
}

describe("system languages", () => {
	it("lists each system language, its bare language, then English, as Chromium's own defaults read", () => {
		expect(acceptLanguages(["de-DE", "en-GB"])).toBe("de-DE,de,en-GB,en,en-US");
		expect(acceptLanguages(["ko-KR"])).toBe("ko-KR,ko,en-US,en");
		expect(acceptLanguages(["pt_BR", "pt-PT", "en-US"])).toBe("pt-BR,pt,pt-PT,en-US,en");
		expect(acceptLanguages([])).toBe("");
	});

	it("matches the first system language to a spellchecker dictionary the way Chromium does", () => {
		const available = ["de", "de-DE", "en-GB", "en-US", "fr", "fr-FR", "pt-BR"];
		expect(spellcheckerLanguage(["de-DE", "en-US"], available)).toBe("de-DE");
		expect(spellcheckerLanguage(["de-CH"], available)).toBe("de");
		expect(spellcheckerLanguage(["pt-PT"], available)).toBe("pt-BR");
		expect(spellcheckerLanguage(["ko-KR", "en-US"], available)).toBeUndefined();
		expect(spellcheckerLanguage([], available)).toBeUndefined();
	});

	it("re-seeds the Windows spellchecker the trimmed locales left on en-US, and nothing else", () => {
		const fresh = fakeSession(["en-US"]);
		seedSpellchecker(fresh as never, ["de-DE", "en-US"], "win32");
		expect(fresh.setSpellCheckerLanguages).toHaveBeenCalledWith(["de-DE"]);

		const empty = fakeSession([]);
		seedSpellchecker(empty as never, ["fr-FR"], "win32");
		expect(empty.setSpellCheckerLanguages).toHaveBeenCalledWith(["fr-FR"]);

		// A list Electron seeded from a full locale set before, an English system, a language
		// without a dictionary, and macOS (its own spellchecker) all stay as they are.
		for (const [languages, preferred, platform] of [
			[["de-DE"], ["fr-FR"], "win32"],
			[["en-US"], ["en-US"], "win32"],
			[["en-US"], ["ko-KR"], "win32"],
			[["en-US"], ["de-DE"], "darwin"],
		] as const) {
			const session = fakeSession([...languages]);
			seedSpellchecker(session as never, preferred, platform);
			expect(session.setSpellCheckerLanguages).not.toHaveBeenCalled();
		}
	});

	it("sends the system languages as Accept-Language and keeps the session's user agent", () => {
		const session = fakeSession([]);
		applyAcceptLanguages(session as never, ["de-DE"]);
		expect(session.setUserAgent).toHaveBeenCalledWith("Mozilla/5.0 OMPdesk", "de-DE,de,en-US,en");
		const none = fakeSession([]);
		applyAcceptLanguages(none as never, []);
		expect(none.setUserAgent).not.toHaveBeenCalled();
	});
});
