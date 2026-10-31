import { describe, expect, it } from "vitest";
import { BOT_DERIVED_SOURCES_MAX, botSourcesFromActivity, parseBotSources } from "./bot-sources";

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

describe("botSourcesFromActivity", () => {
	const at = (seconds: number) => new Date(Date.UTC(2026, 10, 1, 9, 0, seconds)).toISOString();
	const turn = { from: Date.UTC(2026, 10, 1, 9, 0, 10), to: Date.UTC(2026, 10, 1, 9, 0, 50) };
	it("names what the turn read, fetched, opened and the commits its git commands named, once each", () => {
		const entries = [
			{ at: at(5), kind: "read", text: "read /old.ts", target: { type: "file", value: "/old.ts" } },
			{
				at: at(12),
				kind: "read",
				text: "read src/main/index.ts",
				target: { type: "file", value: "src/main/index.ts" },
			},
			{ at: at(14), kind: "read", text: "fetch", target: { type: "url", value: "https://example.com/docs/a" } },
			{ at: at(15), kind: "read", text: "search", target: { type: "query", value: "omp release" } },
			{ at: at(16), kind: "run", text: "bash git show 3f6bd016 --stat" },
			{ at: at(17), kind: "run", text: "bash ls 12345678" },
			{
				at: at(18),
				kind: "sessions",
				text: "ompdesk_session_read abc",
				target: { type: "session", value: "15bbe3708dc2c6fa" },
			},
			{ at: at(20), kind: "read", text: "read again", target: { type: "file", value: "src/main/index.ts" } },
			{ at: at(30), kind: "read", text: "side", channel: "c1", target: { type: "file", value: "/side.ts" } },
			{ at: at(55), kind: "read", text: "later", target: { type: "file", value: "/later.ts" } },
		];
		expect(botSourcesFromActivity(entries, turn)).toEqual([
			{ kind: "file", label: "index.ts", value: "src/main/index.ts" },
			{ kind: "url", label: "example.com/docs/a", value: "https://example.com/docs/a" },
			{ kind: "commit", label: "3f6bd01", value: "3f6bd016" },
			{ kind: "session", label: "15bbe3708dc2c6fa", value: "15bbe3708dc2c6fa" },
		]);
		expect(botSourcesFromActivity(entries, { ...turn, channel: "c1" })).toEqual([
			{ kind: "file", label: "side.ts", value: "/side.ts" },
		]);
	});
	it("keeps the newest few", () => {
		const many = Array.from({ length: 12 }, (_, index) => ({
			at: at(20 + index),
			kind: "read",
			text: "read",
			target: { type: "file", value: `/f${index}.ts` },
		}));
		const sources = botSourcesFromActivity(many, turn);
		expect(sources).toHaveLength(BOT_DERIVED_SOURCES_MAX);
		expect(sources.at(-1)?.value).toBe("/f11.ts");
	});
});
