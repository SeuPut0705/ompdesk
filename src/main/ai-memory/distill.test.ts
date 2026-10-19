import { describe, expect, it } from "vitest";
import { wrapAgentMessage } from "../../shared/agent-control";
import type { AiMemoryObservation } from "../../shared/ai-memory";
import { buildDigest, distillMessage, parseProposals, personPrompts, proposalMarkdown, proposalPath } from "./distill";

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

	it("lists the pages memory already holds, the project's and the owner's preferences apart, capped", () => {
		const digest = buildDigest([{ n: 1, text: "x", at: null }], []);
		expect(distillMessage(digest, []).user.match(/\(none\)/g)).toHaveLength(2);
		const many = distillMessage(digest, [
			...Array.from({ length: 80 }, (_, index) => ({
				path: `decisions/d${index}.md`,
				title: `제목 ${index}`,
				global: false,
			})),
			{ path: "preferences/minimal-settings.md", title: "설정을 최소로", global: true },
		]).user;
		expect(many).toContain("- decisions/d29.md · 제목 29");
		expect(many).not.toContain("제목 30");
		const [project, global] = many.split("## The owner's preferences, kept for every project");
		expect(project).not.toContain("설정을 최소로");
		expect(global).toContain("- preferences/minimal-settings.md · 설정을 최소로");
		expect(distillMessage(digest, []).system).toContain('{"pages":[]}');
	});

	it("shows the start of each page so the model can tell an update of it, and asks it to name what it replaces", () => {
		const digest = buildDigest([{ n: 1, text: "x", at: null }], []);
		const message = distillMessage(digest, [
			{ path: "decisions/jev.md", title: "Jev는 최신", excerpt: "판단 모델은 자동으로 최신을 쓴다", global: false },
		]);
		expect(message.user).toContain("- decisions/jev.md · Jev는 최신 · 판단 모델은 자동으로 최신을 쓴다");
		expect(message.system).toContain('"supersedes"');
	});
});

const good = {
	kind: "rule",
	title: "동시 세션 수 제한을 두지 않는다",
	body: "동시 세션 개수에 어떤 제한도 두지 않는다.\n소유자가 여러 번 제거하라고 요구했다.",
	confidence: 0.85,
	evidence: [27, 28],
};

/** The digest a model answered: prompts 26-28 of the owner's. */
const window = buildDigest(
	[
		{ n: 26, text: "세션 목록 정리해줘", at: null },
		{ n: 27, text: "동시 세션 수 제한은 없애. 몇 개든 열 수 있어야 해", at: null },
		{ n: 28, text: "아니 그게 아니라,   설정은 최소로 해줘.\n새 토글 만들지 마", at: null },
	],
	[],
);
const known = (title: string) => ({ path: "_rules/x.md", title, global: false });

describe("parseProposals", () => {
	it("accepts a page that passes every check, from a fenced or chatty answer too", () => {
		const answer = `Here you go:\n\`\`\`json\n${JSON.stringify({ pages: [good] })}\n\`\`\``;
		const parsed = parseProposals(answer, window, []);
		expect(parsed.refused).toEqual([]);
		expect(parsed.proposals).toEqual([{ ...good }]);
	});

	it("drops evidence the digest did not show, and refuses a page left with none", () => {
		expect(
			parseProposals(JSON.stringify({ pages: [{ ...good, evidence: [27, 99] }] }), window, []).proposals[0]
				?.evidence,
		).toEqual([27]);
		const refused = parseProposals(JSON.stringify({ pages: [{ ...good, evidence: [99] }] }), window, []);
		expect(refused.proposals).toEqual([]);
		expect(refused.refused).toEqual([`${good.title}: cites no prompt it was shown`]);
	});

	it("refuses an unknown kind, a thin body, a low confidence, an overlong title and a title memory has", () => {
		const answer = JSON.stringify({
			pages: [
				{ ...good, kind: "note" },
				{ ...good, body: "짧다" },
				{ ...good, confidence: 0.5 },
				{ ...good, title: "가".repeat(81) },
				{ ...good, title: "  동시 세션   수 제한을 두지 않는다 " },
			],
		});
		const parsed = parseProposals(answer, window, [known("동시 세션 수 제한을 두지 않는다")]);
		expect(parsed.proposals).toEqual([]);
		expect(parsed.refused).toHaveLength(5);
	});

	it("takes at most the allowed pages, never the same title twice", () => {
		const pages = Array.from({ length: 6 }, (_, index) => ({ ...good, title: `제목 ${index}` }));
		const parsed = parseProposals(JSON.stringify({ pages }), window, []);
		expect(parsed.proposals.map(page => page.title)).toEqual(["제목 0", "제목 1", "제목 2"]);
		expect(parsed.refused).toEqual(["제목 3", "제목 4", "제목 5"].map(title => `${title}: over the 3-page limit`));
		const twice = parseProposals(JSON.stringify({ pages: [good, good] }), window, []);
		expect(twice.proposals).toHaveLength(1);
		expect(twice.refused).toEqual([`${good.title}: title already used`]);
	});

	it("an answer that is no {pages} object is refused whole; an empty list is a valid answer", () => {
		expect(parseProposals("I could not find anything.", window, []).refused).toEqual([
			"answer is not a {pages:[…]} object",
		]);
		expect(parseProposals('{"pages":"none"}', window, []).refused).toEqual(["answer is not a {pages:[…]} object"]);
		expect(parseProposals('{"pages":[]}', window, [])).toEqual({ proposals: [], refused: [] });
	});

	it("keeps a supersedes that names a page the model was shown in the page's own scope, and drops any other", () => {
		const known = [
			{ path: "_rules/old.md", title: "옛 규칙", global: false },
			{ path: "preferences/old.md", title: "옛 취향", global: true },
		];
		const named = (supersedes: string, kind = "rule") =>
			parseProposals(
				JSON.stringify({ pages: [{ ...good, kind, quote: "몇 개든 열 수 있어야 해", supersedes }] }),
				window,
				known,
			).proposals[0]?.supersedes;
		expect(named("_rules/old.md")).toBe("_rules/old.md");
		expect(named("preferences/old.md", "preference")).toBe("preferences/old.md");
		expect(named("preferences/old.md")).toBeUndefined();
		expect(named("_rules/invented.md")).toBeUndefined();
	});
});

const preference = {
	kind: "preference",
	title: "새 설정 항목을 만들지 않는다",
	body: "기능을 더할 때 설정 토글을 새로 만들지 않는다.\n소유자는 설정을 최소로 두길 원한다.",
	quote: "설정은 최소로 해줘. 새 토글 만들지 마",
	gist_en: "Do not add new settings; keep settings minimal.",
	confidence: 0.8,
	evidence: [28],
};

describe("parseProposals: the owner's preferences and corrections", () => {
	it("accepts a preference whose quote is the owner's own words (whitespace aside) and keeps the quote and gist", () => {
		const parsed = parseProposals(JSON.stringify({ pages: [preference] }), window, []);
		expect(parsed.refused).toEqual([]);
		expect(parsed.proposals[0]).toMatchObject({
			kind: "preference",
			quote: "설정은 최소로 해줘. 새 토글 만들지 마",
			gist: "Do not add new settings; keep settings minimal.",
			evidence: [28],
		});
	});

	it("refuses a quote that is not a substring of what the owner typed, on any kind, and a preference without one", () => {
		const parsed = parseProposals(
			JSON.stringify({
				pages: [
					{ ...preference, quote: "설정은 최소로 해 주세요" },
					{ ...preference, kind: "correction", title: "교정", quote: "토글" },
					{ ...good, quote: "제한은 모두 없앨 것" },
					{ ...preference, title: "인용 없음", quote: undefined },
				],
			}),
			window,
			[],
		);
		expect(parsed.proposals).toEqual([]);
		expect(parsed.refused).toEqual([
			`${preference.title}: quote is not the owner's words`,
			"교정: quote is not the owner's words",
			`${good.title}: quote is not the owner's words`,
			"인용 없음: quotes no evidence",
		]);
	});

	it("a quote is evidence: it cites its prompt when the model forgot to", () => {
		const parsed = parseProposals(JSON.stringify({ pages: [{ ...preference, evidence: [] }] }), window, []);
		expect(parsed.proposals[0]?.evidence).toEqual([28]);
	});

	it("a correction weighs more: a lower confidence floor, and it is kept first when the answer holds too many pages", () => {
		const correction = {
			...preference,
			kind: "correction",
			title: "고치라고 하면 접근부터 바꾼다",
			quote: "아니 그게 아니라",
			confidence: 0.7,
		};
		expect(
			parseProposals(JSON.stringify({ pages: [{ ...preference, confidence: 0.7 }] }), window, []).proposals,
		).toEqual([]);
		const pages = [1, 2, 3].map(n => ({ ...good, title: `규칙 ${n}` }));
		const parsed = parseProposals(JSON.stringify({ pages: [...pages, correction] }), window, []);
		expect(parsed.proposals.map(page => page.title)).toEqual([correction.title, "규칙 1", "규칙 2"]);
		expect(parsed.refused).toEqual(["규칙 3: over the 3-page limit"]);
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
		expect(proposalPath({ kind: "preference", title: "설정은 최소로" })).toBe("preferences/설정은-최소로.md");
		expect(proposalPath({ kind: "correction", title: "Fix the approach" })).toBe("preferences/fix-the-approach.md");
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

	it("carries the owner's quote as the page's evidence", () => {
		const markdown = proposalMarkdown(
			{ kind: "preference", title: "T", body: "본문", confidence: 0.9, evidence: [3], quote: "토글 만들지 마" },
			"sid-1",
		);
		expect(markdown).toContain("\n> 토글 만들지 마\n");
	});
});
