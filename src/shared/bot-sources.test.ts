import { describe, expect, it } from "vitest";
import { parseBotSources } from "./bot-sources";

describe("parseBotSources", () => {
	it("returns null with no sources line", () => {
		expect(parseBotSources("Hello\nworld")).toBeNull();
		expect(parseBotSources("")).toBeNull();
	});
	it("does not take the word mid-text", () => {
		expect(parseBotSources("Sources: a\nand then more text")).toBeNull();
		expect(parseBotSources("See Sources: here in a sentence")).toBeNull();
	});
	it("returns null for an empty list", () => {
		expect(parseBotSources("Done\nSources:   ")).toBeNull();
	});
	it("classifies mixed items and strips the line", () => {
		const r = parseBotSources(
			"Total 3\n\nSources: `src/a.ts:42` · abc1234 · commit deadbeef01 · 0123456789abcdef · session 99887766 · https://x.dev/p · notes\n",
		);
		expect(r?.body).toBe("Total 3");
		expect(r?.sources.map(s => [s.kind, s.value])).toEqual([
			["file", "src/a.ts:42"],
			["commit", "abc1234"],
			["commit", "deadbeef01"],
			["session", "0123456789abcdef"],
			["session", "99887766"],
			["url", "https://x.dev/p"],
			["text", "notes"],
		]);
	});
	it("keeps label and url of markdown links", () => {
		const r = parseBotSources("x\nSources: [Docs](https://a.b/c); README.md");
		expect(r?.sources[0]).toEqual({ kind: "url", label: "Docs", value: "https://a.b/c" });
		expect(r?.sources[1].kind).toBe("file");
	});
	it("takes the Korean label and bold emphasis", () => {
		expect(parseBotSources("끝\n**출처:** a/b.ts, c/d.ts")?.sources).toHaveLength(2);
		expect(parseBotSources("끝\n_sources:_ a/b.ts")?.sources).toHaveLength(1);
	});
});
