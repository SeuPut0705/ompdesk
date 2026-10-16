/**
 * Rules of the built-in prompt suggestions (resources/gui-bridge/next-prompt-core.ts):
 * candidate cleaning, the `<app-state>` section and the facts behind it, the inline-completion draft rules,
 * the debounce/abort schedulers and the cost they bound, the failure classes.
 */
import { describe, expect, it } from "vitest";
import {
	DEFAULT_NEXT_PROMPT,
	INLINE_DEBOUNCE_MS,
	INLINE_MAX_DRAFT_CHARS,
	inlineEffective,
	MAX_CANDIDATE_CHARS,
	MAX_CANDIDATE_CHARS_CJK,
	MAX_CANDIDATES,
	nextPromptFromPrefs,
	normalizeNextPrompt,
	parseNextPromptEnv,
} from "../../resources/gui-bridge/next-prompt-contracts";
import {
	buildAppState,
	buildInlineRequest,
	buildSuggestionRequest,
	candidateKey,
	classifyFailure,
	cleanCandidateLine,
	cleanCandidates,
	cleanInlineReply,
	extractFacts,
	fitCandidateLength,
	gateSuggestion,
	hashText,
	INLINE_MIN_INTERVAL_MS,
	InlineScheduler,
	inlineDraftEligibility,
	inlineDraftWindow,
	isAssistantVoice,
	isOutputCapRefusal,
	isTestCommand,
	lastUserText,
	renderTranscript,
	SUGGEST_INSTRUCTIONS,
	SUGGEST_TRANSCRIPT_CHARS,
	SuggestionScheduler,
	suggestionStateKey,
	type Timers,
	userStyleExcerpts,
} from "../../resources/gui-bridge/next-prompt-core";

/** A virtual clock: timers fire only when the test advances it. */
class FakeClock implements Timers {
	now = 1_000_000;
	#next = 1;
	#pending = new Map<number, { at: number; callback: () => void }>();
	setTimeout(callback: () => void, ms: number): unknown {
		const id = this.#next++;
		this.#pending.set(id, { at: this.now + ms, callback });
		return id;
	}
	clearTimeout(handle: unknown): void {
		this.#pending.delete(handle as number);
	}
	/** Move time forward, running every timer that falls due (in order) on the way. */
	advance(ms: number): void {
		const target = this.now + ms;
		for (;;) {
			const due = [...this.#pending.entries()]
				.filter(([, timer]) => timer.at <= target)
				.sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			this.#pending.delete(due[0]);
			this.now = Math.max(this.now, due[1].at);
			due[1].callback();
		}
		this.now = target;
	}
	get waiting(): number {
		return this.#pending.size;
	}
}

const flush = async () => {
	for (let turn = 0; turn < 5; turn++) await Promise.resolve();
};

describe("candidates", () => {
	it("keeps up to three ranked lines, best first, and strips list marks and quotes", () => {
		const reply = ['1. "run the tests"', "2) commit it", "- 'push to main'", "4. one more"].join("\n");
		expect(cleanCandidates(reply)).toEqual(["run the tests", "commit it", "push to main"]);
		expect(cleanCandidates(reply, { max: 2 })).toEqual(["run the tests", "commit it"]);
	});

	it("deduplicates by meaning-free differences: case, spacing, trailing punctuation", () => {
		expect(cleanCandidates("Run the tests.\nrun  the tests\nRun the tests!\nship it")).toEqual([
			"Run the tests.",
			"ship it",
		]);
		expect(candidateKey("  Run   the TESTS?! ")).toBe(candidateKey("run the tests"));
	});

	it("answers NONE as no candidates, whatever the casing, and drops NONE lines among others", () => {
		expect(cleanCandidates("NONE")).toEqual([]);
		expect(cleanCandidates("none.")).toEqual([]);
		expect(cleanCandidates("  \n None \n")).toEqual([]);
		expect(cleanCandidates("")).toEqual([]);
		expect(cleanCandidates("commit it\nNONE")).toEqual(["commit it"]);
	});

	it("drops preambles, fences, over-long lines and a repeat of the user's last message", () => {
		expect(cleanCandidates("Here are some options:\ncommit it")).toEqual(["commit it"]);
		expect(cleanCandidates("```\ncommit it")).toEqual(["commit it"]);
		expect(cleanCandidateLine("x".repeat(MAX_CANDIDATE_CHARS + 1))).toBeUndefined();
		expect(cleanCandidateLine("x".repeat(MAX_CANDIDATE_CHARS))).toHaveLength(MAX_CANDIDATE_CHARS);
		expect(cleanCandidates("run the tests\nship it", { lastUserMessage: "Run the tests." })).toEqual(["ship it"]);
	});

	it("keeps the user's language and collapses whitespace and control characters", () => {
		expect(cleanCandidates("  테스트 돌려줘 \u0007 \n 커밋해줘  ")).toEqual(["테스트 돌려줘", "커밋해줘"]);
		expect(MAX_CANDIDATES).toBe(3);
	});
});

/**
 * The reported session (a screenshot): the placeholder "세션 제목이 한국어로 나오는지 실제 omp로 확인해 주세요. 나온 제목을
 * 알려 주시면 그대로 기록해 둘게요." is the assistant talking, the chips "아니면 대화 언어를 꺼 둔 상태에서도 한국어 메시지에 …"
 * and "한국어 메시지에 한국어 제목이 나와야 한다고 보신다…" were cut by the chip width and addressed the user, all polite
 * while this user writes short casual requests ("배포해줘", "더 순환해", "1,2,3,6번 먼저 만들어 줘").
 */
describe("candidates sound like the user (reported: long, polite, the assistant's voice)", () => {
	it("holds Korean, Chinese and Japanese to 40 characters and other scripts to 60", () => {
		expect(MAX_CANDIDATE_CHARS_CJK).toBe(40);
		expect(MAX_CANDIDATE_CHARS).toBe(60);
		expect(fitCandidateLength("가".repeat(40))).toHaveLength(40);
		expect(fitCandidateLength("가".repeat(41))).toBeUndefined();
		// One Hangul, Han or kana character is enough: a mixed line is measured as CJK.
		expect(fitCandidateLength(`TitleLang ${"가".repeat(30)}`)).toHaveLength(40);
		expect(fitCandidateLength(`TitleLang ${"가".repeat(31)}`)).toBeUndefined();
		expect(fitCandidateLength("確認".repeat(21))).toBeUndefined();
		expect(fitCandidateLength("x".repeat(60))).toHaveLength(60);
		expect(fitCandidateLength("x".repeat(41))).toHaveLength(41);
		expect(fitCandidateLength("x".repeat(61))).toBeUndefined();
	});

	it("keeps the first sentence of an over-long line when it fits, never a cut at a comma or a word", () => {
		// Real reply of the small model on the replayed session: two requests in one line.
		expect(
			fitCandidateLength("TitleLang 작업 진행해줘. 실제 omp로 한국어 첫 메시지 보내서 제목 확인하고 결과 보여줘."),
		).toBe("TitleLang 작업 진행해줘.");
		expect(fitCandidateLength("Run the tests. Then commit everything, push it to main and tag the release.")).toBe(
			"Run the tests.",
		);
		expect(
			fitCandidateLength("확인해줘。그리고 실패하면 원인 찾아서 고친 다음에 커밋하고 바로 배포까지 전부 해줘"),
		).toBe("확인해줘。");
		expect(
			fitCandidateLength("테스트 돌리고, 실패하면 원인 찾아서 고친 다음에 커밋하고 바로 배포까지 전부 해줘"),
		).toBeUndefined();
		// A dot inside a version is no sentence end.
		expect(
			fitCandidateLength("Bump to v0.32.1 and redeploy the macOS and the Windows builds to the release page"),
		).toBeUndefined();
		// A first sentence that is itself too long drops the line.
		expect(fitCandidateLength(`${"가".repeat(41)}. 해줘`)).toBeUndefined();
	});

	it("recognises the assistant offering, promising or addressing the user", () => {
		for (const text of [
			"세션 제목이 한국어로 나오는지 실제 omp로 확인해 주세요. 나온 제목을 알려 주시면 그대로 기록해 둘게요.",
			"한국어 메시지에 한국어 제목이 나와야 한다고 보신다면 그렇게 바꿀게요",
			"아니면 대화 언어를 꺼 둔 상태에서도 한국어 제목이 나오게 해 드릴까요?",
			"원하시면 바로 배포할게요",
			"변경 내용을 정리해 드릴게요",
			"결과를 문서에 남겨 두겠습니다",
			"I'll run the tests now",
			"I’ll deploy it",
			"Let me check the logs",
			"Would you like me to deploy?",
			"Do you want me to commit this?",
			"Shall I open a PR?",
		])
			expect(isAssistantVoice(text), text).toBe(true);
	});

	it("never flags the user's own messages, casual or polite", () => {
		for (const text of [
			"배포해줘",
			"더 순환해",
			"응 그 방향으로 전부 만들어줘",
			"1,2,3,6번 먼저 만들어 줘",
			"세션 제목도 간결하게 가능하면 그렇게 해줄래?",
			"확인해 주시겠어요?",
			"기존 영어 제목 세션들도 한국어로 다시 만들어줘",
			"Let me know when it's done",
			"let me see the diff",
			"I've tested it, works",
			"run the tests and commit",
		])
			expect(isAssistantVoice(text), text).toBe(false);
	});

	it("drops the reported suggestions and keeps the user's kind", () => {
		const reported = [
			"세션 제목이 한국어로 나오는지 실제 omp로 확인해 주세요. 나온 제목을 알려 주시면 그대로 기록해 둘게요.",
			"아니면 대화 언어를 꺼 둔 상태에서도 한국어 메시지에 한국어 제목이 나오게 할지 정해 주세요",
			"한국어 메시지에 한국어 제목이 나와야 한다고 보신다면 그렇게 바꿀게요",
			"기존 영어 제목 세션들도 한국어로 다시 만들어줘",
		].join("\n");
		expect(cleanCandidates(reported)).toEqual(["기존 영어 제목 세션들도 한국어로 다시 만들어줘"]);
		// The voice is judged on the whole line: its polite first sentence was the assistant asking the user, too.
		expect(
			cleanCandidateLine(
				"세션 제목이 한국어로 나오는지 실제 omp로 확인해 주세요. 나온 제목을 알려 주시면 그대로 기록해 둘게요.",
			),
		).toBeUndefined();
	});

	it("builds the voice reference from the user's own recent messages: short excerpts, oldest first", () => {
		const pasted = `## 표\n${"긴 붙여넣기 ".repeat(5)}`;
		const messages = [
			{ role: "user", content: "아주 오래된 메시지" },
			{ role: "user", content: "1,2,3,6번 먼저 만들어 줘", attribution: "user" },
			{ role: "assistant", content: [{ type: "text", text: "네, 맡겼어요." }] },
			{ role: "user", content: "Continue working on the goal.", synthetic: true },
			{ role: "user", content: "subagent result", attribution: "agent" },
			{ role: "user", content: "/compact" },
			{ role: "user", content: [{ type: "text", text: "<system-reminder>x</system-reminder>" }] },
			{ role: "user", content: [{ type: "image", data: "…" }] },
			{ role: "user", content: "배포해줘" },
			{ role: "user", content: "배포해줘" },
			{ role: "user", content: "더 순환해" },
			{ role: "user", content: pasted },
			{ role: "user", content: `세션 제목이 지금 영어로 작성되는데 ${"기본언어 인식해서 ".repeat(8)}` },
			{ role: "user", content: [{ type: "text", text: "응 그 방향으로 전부 만들어줘" }] },
			{ role: "bashExecution", command: "git status" },
		];
		const excerpts = userStyleExcerpts(messages);
		// Six at most: the oldest ("아주 오래된 메시지") falls out; skipped kinds and the repeated "배포해줘" do not count.
		expect(excerpts).toEqual([
			"1,2,3,6번 먼저 만들어 줘",
			"배포해줘",
			"더 순환해",
			"## 표",
			expect.stringMatching(/^세션 제목이 지금 영어로 작성되는데 .*…$/),
			"응 그 방향으로 전부 만들어줘",
		]);
		expect(Math.max(...excerpts.map(line => line.length))).toBeLessThanOrEqual(80);
		expect(userStyleExcerpts([{ role: "assistant", content: "hi" }])).toEqual([]);
	});

	it("puts the voice reference first in the request and the voice rules in the prompt", () => {
		expect(buildSuggestionRequest("user: 배포해줘", "", ["배포해줘", "더 순환해"])).toBe(
			"<user-style>\n- 배포해줘\n- 더 순환해\n</user-style>\n<conversation>\nuser: 배포해줘\n</conversation>",
		);
		expect(SUGGEST_INSTRUCTIONS).toContain("Each candidate is a message the user sends to the assistant");
		expect(SUGGEST_INSTRUCTIONS).toContain(
			"never address the user, never offer, promise or announce what you will do",
		);
		expect(SUGGEST_INSTRUCTIONS).toMatch(/<user-style> holds their own recent messages: copy their register/);
		expect(SUGGEST_INSTRUCTIONS).toContain(
			`never over ${MAX_CANDIDATE_CHARS_CJK} characters in Korean, Chinese or Japanese, or ${MAX_CANDIDATE_CHARS} in other languages`,
		);
	});
});

describe("app state", () => {
	it("is empty when there is nothing to tell", () => {
		expect(buildAppState({})).toBe("");
		expect(buildAppState({ lastTurn: "completed", todos: { done: 3, total: 3 } })).toBe("");
	});

	it("lists each fact on one short line", () => {
		const text = buildAppState({
			lastTurn: "aborted",
			failure: { tool: "bash", command: "bun test src/a.test.ts", exitCode: 1 },
			changedFiles: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"],
			plan: { title: "Ship the login page" },
			todos: { done: 2, total: 5, inProgress: "write form", next: "wire api" },
			answered: { question: "Which database?", answer: "Postgres" },
			running: [
				{ type: "task", label: "WorkBoard", about: "Wide-window work board" },
				{ type: "bash", label: "bun run gate" },
			],
			goal: { objective: "Migrate to Postgres", status: "active" },
			tests: { command: "bun test", failed: true },
			userBash: { command: "ls -la", exitCode: 0 },
			compacted: true,
		});
		expect(text.split("\n")).toEqual([
			"<app-state>",
			"last-turn: stopped by the user",
			"last-failure: bash `bun test src/a.test.ts` exit 1",
			"files-changed: 7 (a.ts, b.ts, c.ts, d.ts, e.ts, +2 more)",
			"plan: open — Ship the login page",
			"todos: 2 of 5 done; in progress: write form; next: wire api",
			"question-answered this turn: Which database? → Postgres",
			"running-now: subagent WorkBoard (Wide-window work board); command `bun run gate`",
			"goal: active — Migrate to Postgres",
			"tests: ran, failed (`bun test`)",
			"user-ran: `ls -la` exit 0",
			"history: compacted",
			"</app-state>",
		]);
	});

	it("clips long values to one line", () => {
		const text = buildAppState({ failure: { tool: "read", message: `${"boom ".repeat(60)}\nsecond line` } });
		const line = text.split("\n")[1] ?? "";
		expect(line.startsWith("last-failure: read — boom")).toBe(true);
		expect(line).not.toContain("second line");
		expect(line.length).toBeLessThan(140);
	});
});

const call = (id: string, name: string, args: Record<string, unknown>) => ({
	role: "assistant",
	stopReason: "toolUse",
	content: [{ type: "toolCall", id, name, arguments: args }],
});
const result = (id: string, toolName: string, extra: Record<string, unknown> = {}) => ({
	role: "toolResult",
	toolCallId: id,
	toolName,
	isError: false,
	content: [{ type: "text", text: "ok" }],
	...extra,
});

describe("facts from the session", () => {
	it("reads the last failed command, its exit, the changed files and a failed test run of the turn", () => {
		const messages = [
			{ role: "user", content: "fix it" },
			call("1", "edit", { path: "src/a.ts" }),
			result("1", "edit", { details: { path: "src/a.ts" } }),
			call("2", "write", { path: "src/new.ts" }),
			result("2", "write", { details: { path: "src/new.ts" } }),
			call("3", "edit", { path: "src/a.ts" }),
			result("3", "edit", {
				details: {
					perFileResults: [
						{ path: "src/a.ts" },
						{ path: "src/b.ts", move: "src/c.ts" },
						{ path: "bad.ts", isError: true },
					],
				},
			}),
			call("4", "bash", { command: "bun test" }),
			result("4", "bash", { isError: true, details: { exitCode: 1 } }),
			{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "tests fail" }] },
		];
		const facts = extractFacts(messages);
		expect(facts.failure).toEqual({ tool: "bash", command: "bun test", exitCode: 1 });
		expect(facts.changedFiles).toEqual(["src/a.ts", "src/new.ts", "src/c.ts"]);
		expect(facts.tests).toEqual({ command: "bun test", failed: true });
		expect(facts.lastTurn).toBe("completed");
	});

	it("counts only the turn after the last user message", () => {
		const messages = [
			{ role: "user", content: "first" },
			call("1", "bash", { command: "bun test" }),
			result("1", "bash", { isError: true, details: { exitCode: 2 } }),
			call("e", "edit", { path: "old.ts" }),
			result("e", "edit", { details: { path: "old.ts" } }),
			{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "failed" }] },
			{ role: "user", content: "second" },
			{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
		];
		const facts = extractFacts(messages);
		expect(facts.failure).toBeUndefined();
		expect(facts.changedFiles).toBeUndefined();
		expect(facts.tests).toBeUndefined();
	});

	it("reads a non-bash failure's message, a passing test run, an answered ask and the stop reason", () => {
		const messages = [
			{ role: "user", content: "go" },
			call("a", "ask", { questions: [{ question: "Which database?" }] }),
			result("a", "ask", { content: [{ type: "text", text: "User selected: Postgres" }] }),
			call("r", "read", { path: "missing.ts" }),
			result("r", "read", { isError: true, content: [{ type: "text", text: "ENOENT: no such file" }] }),
			call("t", "bash", { command: "cd app && vitest run" }),
			result("t", "bash"),
			{ role: "assistant", stopReason: "aborted", content: [] },
		];
		const facts = extractFacts(messages);
		expect(facts.answered).toEqual({ question: "Which database?", answer: "User selected: Postgres" });
		expect(facts.failure).toEqual({ tool: "read", message: "ENOENT: no such file" });
		expect(facts.tests).toEqual({ command: "cd app && vitest run", failed: false });
		expect(facts.lastTurn).toBe("aborted");
	});

	it("reports the user's own bash command that finished after the reply", () => {
		const messages = [
			{ role: "user", content: "go" },
			{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
			{ role: "bashExecution", command: "git status", output: "", exitCode: 128, cancelled: false },
		];
		expect(extractFacts(messages).userBash).toEqual({ command: "git status", exitCode: 128, cancelled: false });
		const later = [...messages, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] }];
		expect(extractFacts(later).userBash).toBeUndefined();
	});

	it("adds plan, todos and goal from the session and ignores a finished todo list", () => {
		const open = extractFacts([{ role: "user", content: "x" }], {
			plan: { enabled: true, title: "The plan" },
			todoPhases: [
				{
					tasks: [
						{ content: "one", status: "completed" },
						{ content: "two", status: "in_progress" },
						{ content: "three", status: "pending" },
					],
				},
			],
			goal: { objective: "Ship it", status: "active" },
			compacted: true,
		});
		expect(open.plan).toEqual({ title: "The plan" });
		expect(open.todos).toEqual({ done: 1, total: 3, inProgress: "two", next: "three" });
		expect(open.goal).toEqual({ objective: "Ship it", status: "active" });
		expect(open.compacted).toBe(true);
		const done = extractFacts([], {
			todoPhases: [{ tasks: [{ content: "one", status: "completed" }] }],
			plan: { enabled: false },
		});
		expect(done.todos).toBeUndefined();
		expect(done.plan).toBeUndefined();
	});

	it("recognises test commands", () => {
		for (const command of [
			"bun test",
			"bun run test:unit",
			"npm test",
			"pnpm run test",
			"bunx vitest run src",
			"npx jest",
			"pytest -x",
			"cargo test",
			"cargo nextest run",
			"go test ./...",
			"make test",
			"cd x && yarn test",
		])
			expect(isTestCommand(command), command).toBe(true);
		for (const command of ["bun install", "ls tests", "git commit -m 'add test'", "cat testing.md", "bun run build"])
			expect(isTestCommand(command), command).toBe(false);
	});
});

describe("transcript and prompts", () => {
	const messages = [
		{ role: "user", content: "hello" },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "hi there" },
				{ type: "thinking", thinking: "secret" },
			],
		},
		{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "noise" }] },
		{ role: "user", content: [{ type: "text", text: "run tests" }] },
	];

	it("renders the tail as plain rows, newest last, without tool output or thinking", () => {
		expect(renderTranscript(messages, 4000)).toBe("user: hello\nassistant: hi there\nuser: run tests");
		expect(lastUserText(messages)).toBe("run tests");
	});

	it("stays within its budget, keeping the newest rows", () => {
		const text = renderTranscript(messages, 30);
		expect(text).toBe("user: run tests");
		// The newest reply gets the most room (1800), every other one 700.
		expect(renderTranscript([{ role: "assistant", content: "x".repeat(5000) }], 4000).length).toBeLessThan(1900);
		expect(
			renderTranscript(
				[
					{ role: "assistant", content: "x".repeat(5000) },
					{ role: "assistant", content: "ok" },
				],
				4000,
			).length,
		).toBeLessThan(800);
	});

	it("builds the requests, omitting an empty app state", () => {
		expect(buildSuggestionRequest("user: hi", "")).toBe("<conversation>\nuser: hi\n</conversation>");
		expect(buildSuggestionRequest("user: hi", "<app-state>\nx\n</app-state>")).toContain(
			"</conversation>\n<app-state>",
		);
		expect(buildInlineRequest("", "fix the")).toBe("<draft>fix the</draft>");
		expect(buildInlineRequest("user: hi", "fix the")).toBe(
			"<conversation>\nuser: hi\n</conversation>\n<draft>fix the</draft>",
		);
	});
});

/**
 * The reported case: the assistant had just delegated the work board to a subagent ("WorkBoard에 맡겼어요 … 지금 진행 중:
 * ExtUpdate, WorkBoard") and the one suggestion asked to implement the work board. The model saw no running work, a
 * `question-answered` line that read like an open choice, the reply's middle (the "지금 진행 중" list) clipped away,
 * and a prompt that asked for "up to 3" candidates (it wrote one, so no chips).
 */
describe("work already underway (reported: a suggestion asking for work just delegated)", () => {
	const progress = Array.from(
		{ length: 14 },
		(_, index) => `- **항목 ${index + 1}:** 현황판에 보일 내용과 숨는 조건을 자세히 설명하는 줄이에요.`,
	).join("\n");
	const reply = [
		'"작업 현황판"으로 진행할게요. WorkBoard에 맡겼어요.',
		progress,
		"**지금 진행 중**",
		"- **ExtUpdate:** 플러그인·MCP 자동 업데이트",
		"- **WorkBoard:** 작업 현황판",
		"",
		"**SettingsCompact 마무리 (로컬 커밋 `31ce2b3`)**",
		"- 사이드바 바로가기 행에 사이드바와 같은 아이콘을 붙여 다른 행과 줄을 맞췄어요.",
		"- 모델 역할의 비어 있음 안내는 한 줄로 줄였어요.",
		"- 빠졌던 화면 테스트도 모두 통과했어요.",
	].join("\n");
	const messages = [
		{ role: "user", content: "플러그인 자동 업데이트 해 줘" },
		call("x", "task", { i: "플러그인·MCP 자동 업데이트", tasks: [{ name: "ExtUpdate", task: "…" }] }),
		result("x", "task", { content: [{ type: "text", text: "Spawned agent `ExtUpdate` (job `ExtUpdate`)." }] }),
		{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ExtUpdate에 맡겼어요." }] },
		{ role: "user", content: "채팅창이 넓으면 오른쪽에 뭘 상시 띄우면 어때?" },
		call("q", "ask", { questions: [{ question: "오른쪽 빈 공간에 무엇을 띄울까요?" }] }),
		result("q", "ask", { content: [{ type: "text", text: "User selected: 작업 현황판" }] }),
		call("t", "task", { i: "넓은 창 작업 현황판", tasks: [{ name: "WorkBoard", task: "…" }] }),
		result("t", "task", { content: [{ type: "text", text: "Spawned agent `WorkBoard` (job `WorkBoard`)." }] }),
		{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: reply }] },
	];
	const runningJobs = [
		{ type: "task", label: "ExtUpdate" },
		{ type: "task", label: "WorkBoard" },
		{ type: "bash", label: "gh run watch 42", command: "gh run watch 42" },
	];

	it("names the running subagents and jobs, with what each was handed (from its spawning call, any turn)", () => {
		const facts = extractFacts(messages, { runningJobs });
		expect(facts.running).toEqual([
			{ type: "task", label: "ExtUpdate", about: "플러그인·MCP 자동 업데이트" },
			{ type: "task", label: "WorkBoard", about: "넓은 창 작업 현황판" },
			{ type: "bash", label: "gh run watch 42" },
		]);
		expect(buildAppState(facts)).toContain(
			"running-now: subagent ExtUpdate (플러그인·MCP 자동 업데이트); subagent WorkBoard (넓은 창 작업 현황판); command `gh run watch 42`",
		);
		expect(extractFacts(messages, { runningJobs: [] }).running).toBeUndefined();
	});

	it("shows the answered question as settled in this turn, not as an open choice", () => {
		expect(buildAppState(extractFacts(messages))).toContain(
			"question-answered this turn: 오른쪽 빈 공간에 무엇을 띄울까요? → User selected: 작업 현황판",
		);
	});

	it("keeps the whole latest reply, including its in-progress list, while older replies stay clipped", () => {
		expect(reply.length).toBeGreaterThan(700);
		const transcript = renderTranscript(messages, SUGGEST_TRANSCRIPT_CHARS);
		expect(transcript).toContain(`assistant: ${reply}`);
		const older = renderTranscript(
			[...messages, { role: "user", content: "다음" }, { role: "assistant", content: "네" }],
			SUGGEST_TRANSCRIPT_CHARS,
		);
		expect(older).not.toContain(`assistant: ${reply}`);
		expect(older).toContain("[…]");
	});

	it("asks for three distinct candidates and forbids asking for work already done, started or handed off", () => {
		expect(SUGGEST_INSTRUCTIONS).toContain(`Write exactly ${MAX_CANDIDATES} candidates`);
		expect(SUGGEST_INSTRUCTIONS).toMatch(/already done, already started, already planned or already handed/);
		expect(SUGGEST_INSTRUCTIONS).toContain("nothing the latest reply says it did, will do or is doing");
		expect(SUGGEST_INSTRUCTIONS).toMatch(/running-now .* Never ask for it again/);
		expect(SUGGEST_INSTRUCTIONS).toContain("Follow up on the latest assistant reply");
	});
});

describe("inline reply", () => {
	it("takes the first line, strips quotes and a repeat of the draft", () => {
		expect(cleanInlineReply(" failing test next\nmore", "fix the")).toBe(" failing test next");
		expect(cleanInlineReply('"and then deploy"', "ship it")).toBe("and then deploy");
		expect(cleanInlineReply("fix the failing test", "fix the")).toBe(" failing test");
		expect(cleanInlineReply("NONE", "fix the")).toBeNull();
		expect(cleanInlineReply("", "fix the")).toBeNull();
		expect(cleanInlineReply("fix the", "fix the")).toBeNull();
	});

	it("caps a runaway reply at a word boundary", () => {
		const text = cleanInlineReply(` ${"word ".repeat(100)}`, "draft draft") ?? "";
		expect(text.length).toBeLessThanOrEqual(160);
		expect(text.endsWith("word")).toBe(true);
	});

	it("sends only the end of a long draft", () => {
		expect(inlineDraftWindow("short")).toBe("short");
		const long = "x".repeat(INLINE_MAX_DRAFT_CHARS + 50);
		expect(inlineDraftWindow(long)).toHaveLength(INLINE_MAX_DRAFT_CHARS);
	});
});

const typing = (draft: string, over: Partial<Parameters<typeof inlineDraftEligibility>[0]> = {}) => ({
	draft,
	caretAtEnd: true,
	composing: false,
	menuOpen: false,
	...over,
});

describe("inline eligibility", () => {
	it("accepts a plain single-line draft of at least eight characters", () => {
		expect(inlineDraftEligibility(typing("please fix"))).toEqual({ ok: true });
		expect(inlineDraftEligibility(typing("테스트를 먼저 돌려줘"))).toEqual({ ok: true });
	});

	it.each([
		["short", typing("fix it")],
		["short", typing("       x       ")],
		["multiline", typing("first line\nsecond")],
		["multiline", typing("first line\n")],
		["slash", typing("/model gpt-5 please")],
		["bash", typing("!git status --short")],
		["python", typing("$print('hello world')")],
		["queue", typing("-> do this then that")],
		["queue", typing("=> do this then that")],
		["caret", typing("please fix the thing", { caretAtEnd: false })],
		["ime", typing("테스트를 먼저 돌려줘", { composing: true })],
		["menu", typing("see @src/ma", { menuOpen: true })],
	])("skips %s", (reason, input) => {
		expect(inlineDraftEligibility(input)).toEqual({ ok: false, reason });
	});
});

describe("inline scheduler", () => {
	function setup(answer: (draft: string, signal: AbortSignal) => Promise<string | null> = async () => " the rest") {
		const clock = new FakeClock();
		const shown: Array<[string, string | null]> = [];
		const calls: Array<{ draft: string; signal: AbortSignal }> = [];
		const scheduler = new InlineScheduler({
			timers: clock,
			now: () => clock.now,
			run: (draft, signal) => {
				calls.push({ draft, signal });
				return answer(draft, signal);
			},
			onResult: (draft, text) => shown.push([draft, text]),
		});
		return { clock, shown, calls, scheduler };
	}

	it("waits for the quiet time, then asks once and reports the completion for that draft", async () => {
		const { clock, shown, calls, scheduler } = setup();
		scheduler.input(typing("please fix the"));
		clock.advance(INLINE_DEBOUNCE_MS - 1);
		expect(calls).toHaveLength(0);
		clock.advance(1);
		await flush();
		expect(calls.map(call => call.draft)).toEqual(["please fix the"]);
		expect(shown).toEqual([["please fix the", " the rest"]]);
		expect(scheduler.started).toBe(1);
	});

	it("restarts the quiet time on every keystroke, so continuous typing never asks", () => {
		const { clock, calls, scheduler } = setup();
		let draft = "please fix th";
		for (let key = 0; key < 40; key++) {
			scheduler.input(typing(draft));
			clock.advance(200);
			draft += "e";
		}
		expect(calls).toHaveLength(0);
		expect(scheduler.started).toBe(0);
	});

	it("aborts the request in flight on the next keystroke and drops its answer", async () => {
		let release: (text: string) => void = () => {};
		const { clock, shown, calls, scheduler } = setup(
			() =>
				new Promise<string>(resolve => {
					release = resolve;
				}),
		);
		scheduler.input(typing("please fix the"));
		clock.advance(INLINE_DEBOUNCE_MS);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.signal.aborted).toBe(false);
		scheduler.input(typing("please fix the t"));
		expect(calls[0]?.signal.aborted).toBe(true);
		release(" stale");
		await flush();
		expect(shown).toEqual([]);
	});

	it("never asks for an ineligible draft, and cancel() aborts a waiting or running request", async () => {
		const { clock, calls, scheduler } = setup();
		scheduler.input(typing("/model something long"));
		scheduler.input(typing("short"));
		scheduler.input(typing("please fix the thing", { composing: true }));
		clock.advance(5000);
		expect(calls).toHaveLength(0);
		scheduler.input(typing("please fix the thing"));
		scheduler.cancel();
		clock.advance(5000);
		expect(clock.waiting).toBe(0);
		expect(calls).toHaveLength(0);
		scheduler.input(typing("please fix the thing"));
		clock.advance(INLINE_DEBOUNCE_MS);
		scheduler.cancel();
		expect(calls[0]?.signal.aborted).toBe(true);
	});

	it("serves a draft it already answered from its cache without a request, until reset", async () => {
		const { clock, shown, scheduler } = setup();
		scheduler.input(typing("please fix the"));
		clock.advance(INLINE_DEBOUNCE_MS);
		await flush();
		scheduler.input(typing("please fix the t"));
		scheduler.input(typing("please fix the"));
		expect(shown.at(-1)).toEqual(["please fix the", " the rest"]);
		expect(scheduler.started).toBe(1);
		scheduler.reset();
		scheduler.input(typing("please fix the"));
		clock.advance(INLINE_MIN_INTERVAL_MS);
		await flush();
		expect(scheduler.started).toBe(2);
	});

	it("reports a failed request as no completion", async () => {
		const { clock, shown, scheduler } = setup(async () => {
			throw new Error("boom");
		});
		scheduler.input(typing("please fix the"));
		clock.advance(INLINE_DEBOUNCE_MS);
		await flush();
		expect(shown).toEqual([["please fix the", null]]);
	});

	it("holds the request rate under the interval floor: a minute of bursty typing makes at most 30 requests", async () => {
		const { clock, scheduler } = setup(async () => " more");
		// 60 s of typing: a burst of keystrokes 150 ms apart, then a 700 ms pause (longer than the quiet time), over and over.
		// Every 1.6 s cycle ends in a pause that would start a request on the debounce alone (about 37 a minute);
		// the interval floor spaces starts 2 s apart, so about 19 are made, never more than 30.
		let draft = "please fix the first";
		let elapsed = 0;
		while (elapsed < 60_000) {
			for (let key = 0; key < 6; key++) {
				draft += "x";
				scheduler.input(typing(draft));
				clock.advance(150);
				elapsed += 150;
			}
			clock.advance(700);
			elapsed += 700;
			await flush();
		}
		expect(scheduler.started).toBeGreaterThan(10);
		expect(scheduler.started).toBeLessThanOrEqual(60_000 / INLINE_MIN_INTERVAL_MS);
	});

	it("makes no request at all while the user keeps typing within the quiet time", () => {
		const { clock, scheduler } = setup();
		let draft = "please fix the first";
		for (let second = 0; second < 60; second++) {
			for (let key = 0; key < 5; key++) {
				draft += "x";
				scheduler.input(typing(draft));
				clock.advance(200);
			}
		}
		expect(scheduler.started).toBe(0);
	});
});

describe("suggestion gate and scheduler", () => {
	const gate = { enabled: true, idle: true, draftEmpty: true, main: true, hasReply: true, key: "k2", lastKey: "k1" };

	it("generates only for an idle main session with an empty composer, a reply and a moved state", () => {
		expect(gateSuggestion(gate)).toEqual({ ok: true });
		expect(gateSuggestion({ ...gate, enabled: false })).toEqual({ ok: false, reason: "disabled" });
		expect(gateSuggestion({ ...gate, main: false })).toEqual({ ok: false, reason: "subagent" });
		expect(gateSuggestion({ ...gate, idle: false })).toEqual({ ok: false, reason: "busy" });
		expect(gateSuggestion({ ...gate, draftEmpty: false })).toEqual({ ok: false, reason: "typing" });
		expect(gateSuggestion({ ...gate, hasReply: false })).toEqual({ ok: false, reason: "no_reply" });
		expect(gateSuggestion({ ...gate, lastKey: "k2" })).toEqual({ ok: false, reason: "unchanged" });
		expect(gateSuggestion({ ...gate, lastKey: "k2", force: true })).toEqual({ ok: true });
	});

	it("changes its key with the message count, the last message or the app state", () => {
		const base = [{ role: "user", timestamp: 1 }];
		const key = suggestionStateKey(base, "");
		expect(suggestionStateKey(base, "")).toBe(key);
		expect(suggestionStateKey([...base, { role: "assistant", timestamp: 2 }], "")).not.toBe(key);
		expect(suggestionStateKey([{ role: "user", timestamp: 9 }], "")).not.toBe(key);
		expect(suggestionStateKey(base, "<app-state>x</app-state>")).not.toBe(key);
		expect(hashText("a")).toBe(hashText("a"));
		expect(hashText("a")).not.toBe(hashText("b"));
	});

	it("debounces triggers (the last reason wins) and aborts a running generation for a newer one", async () => {
		const clock = new FakeClock();
		const runs: Array<{ trigger: string; signal: AbortSignal }> = [];
		const scheduler = new SuggestionScheduler({
			timers: clock,
			debounceMs: 800,
			run: async (trigger, signal) => {
				runs.push({ trigger, signal });
			},
		});
		scheduler.request("turn");
		clock.advance(400);
		scheduler.request("compaction");
		clock.advance(799);
		expect(runs).toHaveLength(0);
		expect(scheduler.pending).toBe(true);
		clock.advance(1);
		await flush();
		expect(runs.map(run => run.trigger)).toEqual(["compaction"]);
		expect(scheduler.pending).toBe(false);
		let finish: () => void = () => {};
		const slow = new SuggestionScheduler({
			timers: clock,
			run: (trigger, signal) => {
				runs.push({ trigger, signal });
				return new Promise<void>(resolve => {
					finish = resolve;
				});
			},
		});
		slow.request("turn");
		clock.advance(800);
		const first = runs.at(-1);
		expect(first?.signal.aborted).toBe(false);
		expect(slow.pending).toBe(true);
		slow.request("bash");
		expect(first?.signal.aborted).toBe(true);
		finish();
		slow.cancel();
		expect(clock.waiting).toBe(0);
	});
});

describe("failures", () => {
	it("names why a request could not be made", () => {
		expect(classifyFailure(new Error("No API key for provider openai"))).toBe("no_credentials");
		expect(classifyFailure(new Error("401 Unauthorized"))).toBe("no_credentials");
		expect(classifyFailure(new Error("fetch failed: getaddrinfo ENOTFOUND api.openai.com"))).toBe("offline");
		expect(classifyFailure(new Error("503 Service Unavailable"))).toBe("offline");
		expect(classifyFailure(new Error("403 Forbidden: access to model denied"))).toBe("refused");
		expect(classifyFailure(new Error("Model does not support maxTokens"))).toBe("refused");
		expect(classifyFailure(new Error("429 rate limit"))).toBe("refused");
		expect(classifyFailure("something odd")).toBe("error");
	});

	it("tells an output-cap refusal from other refusals", () => {
		expect(isOutputCapRefusal(new Error("Unsupported parameter: max_output_tokens"))).toBe(true);
		expect(isOutputCapRefusal(new Error("max_tokens is not supported"))).toBe(true);
		expect(isOutputCapRefusal(new Error("403 Forbidden"))).toBe(false);
	});
});

describe("settings", () => {
	it("defaults on, reads a malformed value as on, and lets the sub-switch count only under the main one", () => {
		expect(DEFAULT_NEXT_PROMPT).toEqual({ suggestions: true, inline: true });
		expect(nextPromptFromPrefs(undefined, "yes")).toEqual({ suggestions: true, inline: true });
		expect(nextPromptFromPrefs(false, true)).toEqual({ suggestions: false, inline: true });
		expect(inlineEffective({ suggestions: false, inline: true })).toBe(false);
		expect(inlineEffective({ suggestions: true, inline: false })).toBe(false);
		expect(inlineEffective({ suggestions: true, inline: true })).toBe(true);
		expect(normalizeNextPrompt(null)).toEqual({ suggestions: true, inline: true });
		expect(normalizeNextPrompt({ suggestions: false })).toEqual({ suggestions: false, inline: true });
	});

	it("parses the spawn env", () => {
		expect(parseNextPromptEnv(undefined)).toEqual({ suggestions: true, inline: true });
		expect(parseNextPromptEnv("not json")).toEqual({ suggestions: true, inline: true });
		expect(parseNextPromptEnv('{"suggestions":false,"inline":false}')).toEqual({ suggestions: false, inline: false });
	});
});
