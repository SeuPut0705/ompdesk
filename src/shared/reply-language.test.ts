import { describe, expect, it } from "vitest";
import { deviceReplyLanguage, replyLanguageName } from "./reply-language";

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

describe("deviceReplyLanguage", () => {
	it("takes the first usable preferred language, then the fallback", () => {
		expect(deviceReplyLanguage(["fr-FR", "ko-KR"], "en-US")).toBe("French");
		expect(deviceReplyLanguage(["und", "ko-KR"], "en-US")).toBe("Korean");
		expect(deviceReplyLanguage([], "ja")).toBe("Japanese");
		expect(deviceReplyLanguage([], "")).toBeUndefined();
	});
});
