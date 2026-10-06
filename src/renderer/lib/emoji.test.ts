/**
 * Contract tests for the emoji port (lib/emoji.ts vs TUI emoji-autocomplete):
 * trigger boundary rules, suggestion ordering/caps, inline replace on the
 * closing colon and on emoticon terminators, and submit-time expansion.
 */
import { describe, expect, it } from "vitest";
import { expandEmoticons, getEmojiSuggestions, tryEmojiInlineReplace } from "./emoji";

describe("getEmojiSuggestions", () => {
	it("suggests by name prefix, emoticon literals first, capped at 12", async () => {
		const result = await getEmojiSuggestions(":smi");
		expect(result).not.toBeNull();
		expect(result!.items.length).toBeGreaterThan(0);
		expect(result!.items.length).toBeLessThanOrEqual(12);
		expect(result!.items.some(item => item.label.includes(":smile:"))).toBe(true);
	});

	it("requires at least one typed letter", async () => {
		expect(await getEmojiSuggestions("note:")).toBeNull();
		expect(await getEmojiSuggestions(":")).toBeNull();
	});

	it("requires a left boundary before the opening colon", async () => {
		expect(await getEmojiSuggestions("x:smi")).toBeNull();
		expect(await getEmojiSuggestions("http://x:smi")).toBeNull();
		expect((await getEmojiSuggestions("(:smi")) !== null).toBe(true);
		expect((await getEmojiSuggestions("hello :smi")) !== null).toBe(true);
	});

	it("returns the full token as prefix", async () => {
		const result = await getEmojiSuggestions("a :joy");
		expect(result?.prefix).toBe(":joy");
	});
});

describe("tryEmojiInlineReplace", () => {
	it("replaces :name: on the closing colon", async () => {
		const hit = await tryEmojiInlineReplace("let's :smile:");
		expect(hit).not.toBeNull();
		expect(hit!.replaceLen).toBe(":smile:".length);
		expect(hit!.insert).toBe("😄");
	});

	it("does not fire without a closing colon or on unknown names", async () => {
		expect(await tryEmojiInlineReplace(":smile")).toBeNull();
		expect(await tryEmojiInlineReplace(":notarealname:")).toBeNull();
		expect(await tryEmojiInlineReplace("::")).toBeNull();
	});

	it("replaces emoticons only on a terminator and preserves it", async () => {
		const hit = await tryEmojiInlineReplace("nice :) ");
		expect(hit).not.toBeNull();
		expect(hit!.insert).toBe("🙂 ");
		expect(await tryEmojiInlineReplace("nice :)")).toBeNull(); // no terminator yet
	});

	it("prefers the longest emoticon", async () => {
		const hit = await tryEmojiInlineReplace(":-) ");
		expect(hit?.insert).toBe("🙂 ");
		const wink = await tryEmojiInlineReplace(";-) ");
		expect(wink?.insert).toBe("😉 ");
	});

	it("leaves emoticons inside identifiers alone", async () => {
		expect(await tryEmojiInlineReplace("foo:) ")).toBeNull();
	});
});

describe("expandEmoticons", () => {
	it("rewrites emoticons at token boundaries, including end of string", () => {
		expect(expandEmoticons("done :)")).toBe("done 🙂");
		expect(expandEmoticons("a <3 b")).toBe("a ❤️ b");
		expect(expandEmoticons("xD")).toBe("😆");
	});

	it("keeps embedded and mid-token emoticons untouched", () => {
		expect(expandEmoticons("foo:)bar")).toBe("foo:)bar");
		expect(expandEmoticons("http://a:b")).toBe("http://a:b");
	});

	it("handles multiples and preserves the rest of the text", () => {
		expect(expandEmoticons("one :) two ;)")).toBe("one 🙂 two 😉");
	});
});
