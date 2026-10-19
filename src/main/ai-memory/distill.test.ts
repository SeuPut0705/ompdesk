import { describe, expect, it } from "vitest";
import { wrapAgentMessage } from "../../shared/agent-control";
import type { AiMemoryObservation } from "../../shared/ai-memory";
import {
	buildDigest,
	DISTILL_MAX_PAGES,
	distillMessage,
	parseProposals,
	personPrompts,
	proposalMarkdown,
	proposalPath,
} from "./distill";

const observation = (kind: string, body: string, at = "2026-10-19T01:00:00Z"): AiMemoryObservation => ({
	id: body.slice(0, 6),
	kind,
	title: body.slice(0, 20),
	body,
	createdAt: at,
});

describe("personPrompts", () => {
	it("keeps what a person typed, numbered in order, and drops agent-written messages and other events", () => {
		const prompts = personPrompts([
			observation("session-start", "claude"),
			observation("user-prompt", "병렬 세션은 부모 아래에 둬"),
			observation("user-prompt", wrapAgentMessage("Title: 일\n\nbody", "부모")),
			observation("user-prompt", "Complete assignment thoroughly:\n\nTitle: x"),
			observation("post-tool-use", "tool_family: file"),
			observation("user-prompt", "  "),
			observation("user-prompt", "자동승인해"),
		]);
		expect(prompts.map(prompt => [prompt.n, prompt.text])).toEqual([
			[1, "병렬 세션은 부모 아래에 둬"],
			[2, "자동승인해"],
		]);
		expect(prompts[0]?.at).toBe(Date.parse("2026-10-19T01:00:00Z"));
	});
});

describe("buildDigest / distillMessage", () => {
	it("numbers the prompts, keeps the newest window and clips a long one", () => {
		const prompts = Array.from({ length: 50 }, (_, index) => ({
			n: index + 1,
			text: `메시지 ${index + 1}`,
			at: null,
		}));
		const digest = buildDigest(prompts, ["작업 하나", wrapAgentMessage("Title: 래핑됨\n\nx", "부모")]);
		expect(digest.shown[0]).toBe(11);
		expect(digest.shown.at(-1)).toBe(50);
		expect(digest.text).toContain("[50] 메시지 50");
		expect(digest.text).not.toContain("[10] ");
		expect(digest.text).toContain("- 작업 하나");
		const long = buildDigest([{ n: 1, text: "가".repeat(2000), at: null }], []);
		expect(long.text.length).toBeLessThan(900);
		expect(long.text).toContain("…");
	});

	it("lists the titles the project already has, capped, and says (none) when it has none", () => {
		const digest = buildDigest([{ n: 1, text: "x", at: null }], []);
		expect(distillMessage(digest, []).user).toContain("(none)");
		const many = distillMessage(
			digest,
			Array.from({ length: 80 }, (_, index) => `제목 ${index}`),
		).user;
		expect(many).toContain("- 제목 39");
		expect(many).not.toContain("- 제목 40");
		expect(distillMessage(digest, []).system).toContain('{"pages":[]}');
	});
});

const good = {
	kind: "rule",
	title: "동시 세션 수 제한을 두지 않는다",
	body: "동시 세션 개수에 어떤 제한도 두지 않는다.\n소유자가 여러 번 제거하라고 요구했다.",
	confidence: 0.85,
	evidence: [27, 28],
};

describe("parseProposals", () => {
	const shown = [26, 27, 28];

	it("accepts a page that passes every check, from a fenced or chatty answer too", () => {
		const answer = `Here you go:\n\`\`\`json\n${JSON.stringify({ pages: [good] })}\n\`\`\``;
		const parsed = parseProposals(answer, shown, []);
		expect(parsed.refused).toEqual([]);
		expect(parsed.proposals).toEqual([{ ...good }]);
	});

	it("drops evidence the digest did not show, and refuses a page left with none", () => {
		expect(
			parseProposals(JSON.stringify({ pages: [{ ...good, evidence: [27, 99] }] }), shown, []).proposals[0]?.evidence,
		).toEqual([27]);
		const refused = parseProposals(JSON.stringify({ pages: [{ ...good, evidence: [99] }] }), shown, []);
		expect(refused.proposals).toEqual([]);
		expect(refused.refused).toEqual([`${good.title}: cites no prompt it was shown`]);
	});

	it("refuses an unknown kind, a thin body, a low confidence, an overlong title and a title the project has", () => {
		const answer = JSON.stringify({
			pages: [
				{ ...good, kind: "note" },
				{ ...good, body: "짧다" },
				{ ...good, confidence: 0.5 },
				{ ...good, title: "가".repeat(81) },
				{ ...good, title: "  동시 세션   수 제한을 두지 않는다 " },
			],
		});
		const parsed = parseProposals(answer, shown, ["동시 세션 수 제한을 두지 않는다"]);
		expect(parsed.proposals).toEqual([]);
		expect(parsed.refused).toHaveLength(DISTILL_MAX_PAGES);
	});

	it("takes at most the allowed pages, never the same title twice", () => {
		const pages = Array.from({ length: 6 }, (_, index) => ({ ...good, title: `제목 ${index}` }));
		expect(parseProposals(JSON.stringify({ pages }), shown, []).proposals).toHaveLength(DISTILL_MAX_PAGES);
		const twice = parseProposals(JSON.stringify({ pages: [good, good] }), shown, []);
		expect(twice.proposals).toHaveLength(1);
		expect(twice.refused).toEqual([`${good.title}: title already used`]);
	});

	it("an answer that is no {pages} object is refused whole; an empty list is a valid answer", () => {
		expect(parseProposals("I could not find anything.", shown, []).refused).toEqual([
			"answer is not a {pages:[…]} object",
		]);
		expect(parseProposals('{"pages":"none"}', shown, []).refused).toEqual(["answer is not a {pages:[…]} object"]);
		expect(parseProposals('{"pages":[]}', shown, [])).toEqual({ proposals: [], refused: [] });
	});
});

describe("proposalPath / proposalMarkdown", () => {
	it("files each kind where ai-memory's layout keeps it, under a readable slug of any script", () => {
		expect(proposalPath({ kind: "decision", title: "Use SQLite for the cache!" })).toBe(
			"decisions/use-sqlite-for-the-cache.md",
		);
		expect(proposalPath({ kind: "rule", title: "동시 세션 수 제한을 두지 않는다" })).toBe(
			"_rules/동시-세션-수-제한을-두지-않는다.md",
		);
		expect(proposalPath({ kind: "gotcha", title: "???" })).toBe("gotchas/page.md");
		expect(proposalPath({ kind: "procedure", title: "a".repeat(100) }).length).toBeLessThan(70);
	});

	it("titles the page by its H1 and says where it came from", () => {
		const markdown = proposalMarkdown(
			{ kind: "rule", title: "T", body: "본문", confidence: 0.9, evidence: [3, 5] },
			"sid-1",
		);
		expect(markdown.startsWith("# T\n\n본문\n")).toBe(true);
		expect(markdown).toContain("#3, #5");
		expect(markdown).toContain("`sid-1`");
	});
});
