import { describe, expect, it } from "vitest";
import {
	deviceLanguageTag,
	parseReplyLanguagePref,
	REPLY_LANGUAGE_CHOICES,
	replyLanguageName,
	replyLanguageTag,
	resolveReplyLanguage,
} from "./reply-language";

describe("replyLanguageName", () => {
	it("names the language of a device tag, without the region", () => {
		expect(replyLanguageName("ko-KR")).toBe("Korean");
		expect(replyLanguageName("ko")).toBe("Korean");
		expect(replyLanguageName("ja-JP")).toBe("Japanese");
		expect(replyLanguageName("de-AT")).toBe("German");
		expect(replyLanguageName("en-GB")).toBe("English");
		expect(replyLanguageName("pt_BR")).toBe("Portuguese");
	});

	it("keeps a script that differs from the language's usual one", () => {
		expect(replyLanguageName("zh-CN")).toBe("Chinese");
		const traditional = replyLanguageName("zh-TW");
		expect(traditional).toMatch(/Chinese/);
		expect(traditional).toMatch(/Traditional/);
		expect(replyLanguageName("zh-Hant-HK")).toBe(traditional);
	});

	it("rejects empty, malformed, undetermined and unknown tags", () => {
		expect(replyLanguageName(undefined)).toBeUndefined();
		expect(replyLanguageName("")).toBeUndefined();
		expect(replyLanguageName("not a tag")).toBeUndefined();
		expect(replyLanguageName("und")).toBeUndefined();
		expect(replyLanguageName("qaa")).toBeUndefined();
	});
});

describe("replyLanguageTag", () => {
	it("keeps the language and an unusual script, drops the region", () => {
		expect(replyLanguageTag("ko-KR")).toBe("ko");
		expect(replyLanguageTag("pt_BR")).toBe("pt");
		expect(replyLanguageTag("zh-CN")).toBe("zh");
		expect(replyLanguageTag("zh-TW")).toBe("zh-Hant");
		expect(replyLanguageTag("qaa")).toBeUndefined();
		expect(replyLanguageTag("not a tag")).toBeUndefined();
	});
});

describe("deviceLanguageTag", () => {
	it("takes the first usable preferred language, then the fallback", () => {
		expect(deviceLanguageTag(["fr-FR", "ko-KR"], "en-US")).toBe("fr");
		expect(deviceLanguageTag(["und", "ko-KR"], "en-US")).toBe("ko");
		expect(deviceLanguageTag([], "ja")).toBe("ja");
		expect(deviceLanguageTag([], "")).toBeUndefined();
	});
});

describe("resolveReplyLanguage", () => {
	it("follows the device language on auto, the default", () => {
		expect(resolveReplyLanguage("auto", "Korean")).toBe("Korean");
		expect(resolveReplyLanguage(undefined, "Japanese")).toBe("Japanese");
		expect(resolveReplyLanguage("auto", undefined)).toBeUndefined();
	});

	it("uses an explicit choice over the device language", () => {
		expect(resolveReplyLanguage("Spanish", "Korean")).toBe("Spanish");
		expect(resolveReplyLanguage("Chinese (Traditional)", undefined)).toBe("Chinese (Traditional)");
		expect(resolveReplyLanguage("English", "Korean")).toBe("English");
	});

	it("sends nothing when off", () => {
		expect(resolveReplyLanguage("off", "Korean")).toBeUndefined();
	});

	it("reads unknown stored values as auto", () => {
		expect(parseReplyLanguagePref("Klingon")).toBe("auto");
		expect(parseReplyLanguagePref(3)).toBe("auto");
		expect(resolveReplyLanguage("Klingon", "German")).toBe("German");
		for (const choice of REPLY_LANGUAGE_CHOICES) expect(parseReplyLanguagePref(choice)).toBe(choice);
	});
});
