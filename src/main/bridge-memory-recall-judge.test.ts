/**
 * Memory recall through the judge (judge-assist-engine.ts `recallRelevance` feeding memory-recall-core.ts
 * `selectRecall`) on the shared fake stock judgment: one judgment with one question per candidate, journaled under
 * its own purpose; every state in which the judge does not decide (not native, switch off, an error, an unreadable
 * answer) gives exactly the code rule's choice.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type JudgeSession,
	recallRelevance,
	setJudgeAssistEnabled,
	setJudgeAssistStockLoader,
} from "../../resources/gui-bridge/modes/judge-assist-engine";
import { MEMORY_RECALL_PURPOSE } from "../../resources/gui-bridge/modes/memory-recall-contracts";
import {
	codeRuleSelect,
	type RecallCandidate,
	recallCandidates,
	selectRecall,
} from "../../resources/gui-bridge/modes/memory-recall-core";
import { type FakeJudge, fakeJudge, recallAnswer } from "./test-fake-judge";

const PROMPT = "jev는 어케하기로 한거야? 지금 자동으로 써지는거야?";

const CANDIDATES = recallCandidates({
	hits: [
		{ path: "notes/jev.md", title: "Jev 조사와 OMPdesk 적용 평가", snippet: "jev 판정 모델 자동 사용 여부 조사" },
		{ path: "sessions/s-css.md", title: "CSS 정리", snippet: "jev 자동 정렬" },
	],
	conclusion_hits: [
		{
			session_id: "s-jev",
			title: "Jev 비교",
			excerpt: "Jev가 확실히 나아요. omp는 이미 Jev를 자동으로 쓰고 있어요. 92.4% vs 74.2%",
			created_at: "2026-10-19T07:30:00Z",
		},
	],
});

it("never offers a session page to the judge", () => {
	expect(ids(CANDIDATES)).toEqual(["notes/jev.md", "s-jev"]);
});

function session(): JudgeSession {
	return {
		settings: {},
		modelRegistry: {},
		sessionId: "sess-recall",
		sessionManager: { fake: "manager" },
		model: { provider: "fake", id: "chat" },
		agent: {},
	};
}

let judge: FakeJudge;

function install(answer: FakeJudge["answer"]["current"]): void {
	judge = fakeJudge(answer);
	setJudgeAssistStockLoader(async () => judge.stock);
}

const bridgeJudge = (prompt: string, list: readonly RecallCandidate[]) => recallRelevance(session(), prompt, list);
const ids = (items: readonly RecallCandidate[]) => items.map(item => item.path ?? item.sessionId);

beforeEach(() => setJudgeAssistEnabled(true));
afterEach(() => {
	setJudgeAssistStockLoader(undefined);
	setJudgeAssistEnabled(true);
});

describe("with a native judge", () => {
	it("asks once, one question per candidate, and keeps what it judged needed", async () => {
		install(async () => recallAnswer(0.2, 0.93));
		const selection = await selectRecall(PROMPT, CANDIDATES, bridgeJudge);
		expect(selection.judged).toBe(true);
		expect(ids(selection.items)).toEqual(["s-jev"]);
		expect(judge.requests).toHaveLength(1);
		const request = judge.requests[0] as { state: { prompt: string; snippets: object }; questions: object };
		expect(Object.keys(request.questions)).toEqual(["s0", "s1"]);
		expect(Object.keys(request.state.snippets)).toEqual(["s0", "s1"]);
		expect(request.state.prompt).toBe(PROMPT);
		expect(judge.deps).toEqual([expect.objectContaining({ purpose: MEMORY_RECALL_PURPOSE })]);
		expect(judge.journaled.managers).toEqual([{ fake: "manager" }]);
	});

	it("chooses nothing when it finds nothing needed, even where the code rule would", async () => {
		install(async () => recallAnswer(0.1, 0.1));
		expect(codeRuleSelect(PROMPT, CANDIDATES).length).toBeGreaterThan(0);
		expect(await selectRecall(PROMPT, CANDIDATES, bridgeJudge)).toEqual({ items: [], judged: true });
	});

	it("keeps a candidate the judge gives 0.5 and drops one just under it (the replay's threshold)", async () => {
		install(async () => recallAnswer(0.5, 0.49));
		const selection = await selectRecall(PROMPT, CANDIDATES, bridgeJudge);
		expect(ids(selection.items)).toEqual(["notes/jev.md"]);
	});
});

describe("when the judge does not decide, the choice is the code rule's", () => {
	const codeRule = { items: codeRuleSelect(PROMPT, CANDIDATES), judged: false };

	it("keeps every candidate sharing the prompt's terms, the conclusion first", () => {
		expect(ids(codeRule.items)).toEqual(["s-jev", "notes/jev.md"]);
	});

	it("not native", async () => {
		install(async () => recallAnswer(1, 1));
		judge.native.current = false;
		expect(await selectRecall(PROMPT, CANDIDATES, bridgeJudge)).toEqual(codeRule);
		expect(judge.requests).toEqual([]);
	});

	it("switch off", async () => {
		install(async () => recallAnswer(1, 1));
		setJudgeAssistEnabled(false);
		expect(await selectRecall(PROMPT, CANDIDATES, bridgeJudge)).toEqual(codeRule);
	});

	it("an error or an unreadable answer", async () => {
		install(async () => {
			throw new Error("provider down");
		});
		expect(await selectRecall(PROMPT, CANDIDATES, bridgeJudge)).toEqual(codeRule);
		install(async () => ({ s0: { type: "noul" } }));
		expect(await selectRecall(PROMPT, CANDIDATES, bridgeJudge)).toEqual(codeRule);
	});

	it("no stock at all", async () => {
		setJudgeAssistStockLoader(undefined);
		expect(await selectRecall(PROMPT, CANDIDATES, bridgeJudge)).toEqual(codeRule);
	});
});
