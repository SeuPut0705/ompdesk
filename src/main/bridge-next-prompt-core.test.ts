/**
 * Rules of the built-in prompt suggestions (resources/gui-bridge/modes/next-prompt-core.ts):
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
} from "../../resources/gui-bridge/modes/next-prompt-contracts";
import {
	awaitsDecision,
	buildAppState,
	buildInlineRequest,
	buildSuggestionRequest,
	COPY_MIN_UNITS,
	COPY_SIMILARITY,
	candidateKey,
	classifyFailure,
	cleanCandidateLine,
	cleanCandidates,
	cleanInlineReply,
	extractFacts,
	fitCandidateLength,
	gateSuggestion,
	hashText,
	INLINE_MAX_CHARS,
	INLINE_MAX_CHARS_CJK,
	INLINE_MIN_INTERVAL_MS,
	type InlineChecks,
	InlineScheduler,
	inlineDraftEligibility,
	inlineDraftWindow,
	isApprovalOnly,
	isAssistantVoice,
	isOutputCapRefusal,
	isTestCommand,
	koreanRegister,
	koreanRegisterOf,
	matchRegister,
	renderTranscript,
	SentMessages,
	SUGGEST_INSTRUCTIONS,
	SUGGEST_TRANSCRIPT_CHARS,
	SuggestionScheduler,
	sentTexts,
	suggestionStateKey,
	type Timers,
	userRegister,
	userVoice,
} from "../../resources/gui-bridge/modes/next-prompt-core";

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

	it("drops preambles, fences, over-long lines and a repeat of the user's latest message", () => {
		expect(cleanCandidates("Here are some options:\ncommit it")).toEqual(["commit it"]);
		expect(cleanCandidates("```\ncommit it")).toEqual(["commit it"]);
		expect(cleanCandidateLine("x".repeat(MAX_CANDIDATE_CHARS + 1))).toBeUndefined();
		expect(cleanCandidateLine("x".repeat(MAX_CANDIDATE_CHARS))).toHaveLength(MAX_CANDIDATE_CHARS);
		const sent = new SentMessages(["Run the tests."]);
		expect(cleanCandidates("run the tests\nship it", { sent })).toEqual(["ship it"]);
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
	it("holds Korean, Chinese and Japanese to 48 characters (40 asked) and other scripts to 60", () => {
		expect(MAX_CANDIDATE_CHARS_CJK).toBe(48);
		expect(MAX_CANDIDATE_CHARS).toBe(60);
		expect(fitCandidateLength("가".repeat(48))).toHaveLength(48);
		expect(fitCandidateLength("가".repeat(49))).toBeUndefined();
		// One Hangul, Han or kana character is enough: a mixed line is measured as CJK.
		expect(fitCandidateLength(`TitleLang ${"가".repeat(38)}`)).toHaveLength(48);
		expect(fitCandidateLength(`TitleLang ${"가".repeat(39)}`)).toBeUndefined();
		expect(fitCandidateLength("確認".repeat(25))).toBeUndefined();
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
			fitCandidateLength(
				"확인해줘。그리고 실패하면 원인 찾아서 고친 다음에 커밋하고 바로 배포까지 전부 다 해줘 부탁해",
			),
		).toBe("확인해줘。");
		expect(
			fitCandidateLength(
				"테스트 돌리고, 실패하면 원인 찾아서 고친 다음에 커밋하고 바로 배포까지 전부 다 해줘 부탁해",
			),
		).toBeUndefined();
		// A dot inside a version is no sentence end.
		expect(
			fitCandidateLength("Bump to v0.32.1 and redeploy the macOS and the Windows builds to the release page"),
		).toBeUndefined();
		// A first sentence that is itself too long drops the line.
		expect(fitCandidateLength(`${"가".repeat(49)}. 해줘`)).toBeUndefined();
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

	it("judges the register on the first lines of the user's last six typed messages", () => {
		const pasted = `## 표\n${"긴 붙여넣기 ".repeat(5)}`;
		const messages = [
			{ role: "user", content: "확인해 주세요" },
			{ role: "user", content: "고마워요" },
			{ role: "assistant", content: [{ type: "text", text: "네, 맡겼어요." }] },
			{ role: "user", content: "Continue working on the goal.", synthetic: true },
			{ role: "user", content: "subagent result", attribution: "agent" },
			{ role: "user", content: "/compact" },
			{ role: "user", content: "1,2,3,6번 먼저 만들어 줘" },
			{ role: "user", content: "배포해줘" },
			{ role: "user", content: "더 순환해" },
			{ role: "user", content: pasted },
			{ role: "user", content: "이거 맞아요?\n그리고 배포해" },
			{ role: "user", content: [{ type: "text", text: "응 그 방향으로 전부 만들어줘" }] },
			{ role: "bashExecution", command: "git status" },
		];
		// The two polite ones are older than the last six; "이거 맞아요?" counts by its first line.
		expect(userRegister(sentTexts(messages))).toBe("casual");
		expect(userRegister(["확인해 주세요", "고마워요", "배포해줘"])).toBe("polite");
		expect(userRegister([])).toBeUndefined();
	});

	it("names the register in the request, carries no excerpt of the user's messages, and states the voice rules", () => {
		expect(buildSuggestionRequest("user: 배포해줘", "")).toBe("<conversation>\nuser: 배포해줘\n</conversation>");
		expect(buildSuggestionRequest("user: 배포해줘", "", "casual")).toBe(
			"<user-style>\nregister: 반말 (casual). Write Korean the way they do (해줘, 해, 할래?, 돼?); never 요, 니다, 세요 or 까요.\n</user-style>\n<conversation>\nuser: 배포해줘\n</conversation>",
		);
		expect(buildSuggestionRequest("user: 배포해 주세요", "", "polite")).toContain(
			"register: 존댓말 (polite). Write Korean politely (해 주세요, 할까요?, 돼요?); never 반말 like 해줘.",
		);
		expect(SUGGEST_INSTRUCTIONS).toContain("Each candidate is a message the user sends to the assistant");
		expect(SUGGEST_INSTRUCTIONS).toContain(
			"never address the user, never offer, promise or announce what you will do",
		);
		expect(SUGGEST_INSTRUCTIONS).toContain("never repeat, reword or re-ask what they already sent");
		expect(SUGGEST_INSTRUCTIONS).toContain(
			"<user-style> names their register (in Korean 반말 or 존댓말): every candidate uses it.",
		);
	});
});

/**
 * Reported after v0.32.1 (the voice rules live): a user who writes "배포해줘", "지워줄래", "더 순환해", "또 존대말 나오네"
 * still got "Windows에서 빈 화면이면 v0.31.0으로 롤백해도 되나요?", "WinBlank 결과 나오면 바로 알려주세요" and
 * "작업 현황판 캡처 다시 확인해줄래요?". The register is now judged in code and the candidates held to it.
 */
describe("the user's Korean register (reported: 존댓말 suggestions to a 반말 user)", () => {
	it("reads the register a message ends in, past punctuation, emoji and ㅋㅋ", () => {
		for (const text of [
			"배포해줘",
			"더 순환해",
			"지워줄래",
			"또 존대말 나오네",
			"제대로 만들고있는거지?",
			"어때 잘 구현한거같아?",
			"채팅탭에 노메세지 이거 안지워지는 버그 있음",
			"중복된 표현임",
			"없어도될꺼같음",
			"그렇게 해놔",
			"응",
			"좋을듯 ㅋㅋ",
			"이거 맞아?!",
			"했다",
			"롤백하면 어떤 점이 달라져?",
			"v0.31.0 설치 링크 어디야",
		])
			expect(koreanRegisterOf(text), text).toBe("casual");
		for (const text of [
			"배포해 주세요",
			"이거 확인해줄래요?",
			"롤백해도 되나요?",
			"좋네요 😊",
			"테스트를 실행했습니다.",
			"이게 맞습니까?",
			"그렇게 하면 되죠?",
		])
			expect(koreanRegisterOf(text), text).toBe("polite");
		// No Korean ending: a link, English, a bare noun, a noun ending in 요.
		for (const text of ["https://github.com/morluto/rea", "ok", "작업현황 디자인 개선", "확인 필요", "", "ㅋㅋ"])
			expect(koreanRegisterOf(text), text).toBeUndefined();
	});

	it("takes the majority over the recent messages; a tie or no Korean ending names none", () => {
		// The reported user's own last six messages.
		expect(
			koreanRegister([
				"제목을 더 짧게 만들어야해 그냥 텍스트로만 제대로 요약해서",
				"그리고 ompdesk 윈도우에서 열면 지금 아무화면이 안뜸",
				"창 자체는 뜨는데 속이 비어있음 검은색으로",
				"작업현황에 2개 작업중 이런 표시는 지워줄래 어차피 밑에 나오잖아 중복된 표현임",
				"또 존대말 나오네",
				"배포해줘",
			]),
		).toBe("casual");
		expect(koreanRegister(["배포해 주세요", "고마워요", "이거 왜 이런가요?", "이미지"])).toBe("polite");
		expect(koreanRegister(["배포해줘", "배포해 주세요"])).toBeUndefined();
		expect(koreanRegister(["deploy it", "작업현황 디자인 개선"])).toBeUndefined();
		expect(koreanRegister([])).toBeUndefined();
	});

	it("turns a casual user's polite candidates into 반말 by listed endings only", () => {
		const cases: Array<[string, string]> = [
			["Windows에서 빈 화면이면 v0.31.0으로 롤백해도 되나요?", "Windows에서 빈 화면이면 v0.31.0으로 롤백해도 돼?"],
			["WinBlank 결과 나오면 바로 알려주세요", "WinBlank 결과 나오면 바로 알려줘"],
			["작업 현황판 캡처 다시 확인해줄래요?", "작업 현황판 캡처 다시 확인해줄래?"],
			["테스트 다시 돌려 주세요.", "테스트 다시 돌려 줘."],
			["이거 먼저 할까요?", "이거 먼저 할까?"],
			["로그 있나요?", "로그 있나?"],
			["이 방향 좋네요", "이 방향 좋네"],
			["그럼 커밋해요", "그럼 커밋해"],
			["다 끝났죠?", "다 끝났지?"],
			["알겠어요. 배포해 주세요", "알겠어. 배포해 줘"],
		];
		for (const [polite, casual] of cases) expect(matchRegister(polite, "casual"), polite).toBe(casual);
	});

	it("drops a casual user's polite candidate it cannot convert safely", () => {
		for (const text of [
			"테스트 결과를 확인했습니다",
			"이게 원인인가요? 아니면 설정 문제예요?",
			"로그 확인해 보세요",
			"알려주실래요?",
			"확인해 주실 수 있나요?",
			"제가 직접 확인할게요",
			"원인이 뭐예요?",
		])
			expect(matchRegister(text, "casual"), text).toBeUndefined();
	});

	it("leaves 반말, nouns, other languages and an unknown register alone", () => {
		for (const text of ["배포해줘", "다시 시도해봐", "확인 필요", "작업현황 개선", "run the tests", "다시 해줘"])
			expect(matchRegister(text, "casual"), text).toBe(text);
		expect(matchRegister("롤백해도 되나요?", undefined)).toBe("롤백해도 되나요?");
	});

	it("gives a polite user polite endings only where a noun never ends that way, and never pushes 반말", () => {
		const cases: Array<[string, string]> = [
			["로그 보여줘", "로그 보여주세요"],
			["다시 확인해 줘", "다시 확인해 주세요"],
			["이거 배포해도 돼?", "이거 배포해도 돼요?"],
			["캡처 다시 볼래?", "캡처 다시 볼래요?"],
			["먼저 할까?", "먼저 할까요?"],
			["다 끝난 거지?", "다 끝난 거죠?"],
		];
		for (const [casual, polite] of cases) expect(matchRegister(casual, "polite"), casual).toBe(polite);
		// Unchanged: already polite, nouns (미래, 이미지), plain endings without a safe polite form.
		for (const text of ["배포해 주세요", "롤백해도 되나요?", "미래", "깨진 이미지", "더 순환해", "버그 있음"])
			expect(matchRegister(text, "polite"), text).toBe(text);
	});

	it("holds the cleaned candidates to the register: the reported three become 반말", () => {
		const reply = [
			"Windows에서 빈 화면이면 v0.31.0으로 롤백해도 되나요?",
			"WinBlank 결과 나오면 바로 알려주세요",
			"작업 현황판 캡처 다시 확인해줄래요?",
		].join("\n");
		expect(cleanCandidates(reply, { register: "casual" })).toEqual([
			"Windows에서 빈 화면이면 v0.31.0으로 롤백해도 돼?",
			"WinBlank 결과 나오면 바로 알려줘",
			"작업 현황판 캡처 다시 확인해줄래?",
		]);
		// Unconvertible ones are dropped, and a converted duplicate of another counts once.
		expect(cleanCandidates("확인했습니다\n배포해 주세요\n배포해 줘", { register: "casual" })).toEqual(["배포해 줘"]);
		// Without a register nothing changes.
		expect(cleanCandidates(reply)).toHaveLength(3);
	});
});

/**
 * Reported on v0.32.2: the placeholder "모드 추가할 건 없어? 모델풀은 지워야 할 것 같고" and the chip "윈도우 버전에서 추가
 * 지시가 바로 안 들어가는데 지금 대기열에 걸려 있어" restated two messages the user had sent (and the agent had handled)
 * minutes before, taken from the <user-style> excerpts. The fixture is the session's own recent messages.
 */
describe("restatements of sent messages (reported: suggestions copying the user's own messages back)", () => {
	const sentBefore = [
		"배포해줘",
		"작업현황에 2개 작업중 이런 표시는 지워줄래 어차피 밑에 나오잖아 중복된 표현임",
		"또 존대말 나오네",
		"빌드시간,최적화,릴리즈시간 전부 개선해",
		"WinBlank 수정 커밋하면 v0.32.2 바로 배포해줘",
		"다 끝나면 배포해",
		"응 좋아 끝나면 캡처 보여줘",
		"모드가 이렇게 있잖아 여기서 자동으로 스스로 판단해서 사용하는 모드가 있나?",
		"루프,바이브,모델풀은 자동모드에서 빼야할꺼같고 계획,목표만 자동모드 넣으면될듯?",
		"모드를 추가할것은 없나? 모델풀은 삭제해야할꺼 같고",
		"그리고 윈도우버전에서는 추가지시가 즉시 안들어감 지금 대기열에 걸려있음",
		"작업현황에 나온 사용한도 표시 모습이 보기좋은데 설정에 있는 계정목록에도 적용해줄래",
		"파일 및 폴더 구조 개선 그리고 리팩토링 필요하면 제대로 진행해줘 병렬로",
		"그리고 지금 작업중인데 버튼이 작업중 버튼이 아니네 (보내기 버튼)",
		"채팅 입력창에 뭔가 효과를 줘서 작업중이라는 느낌을 주면 좋을꺼같음",
	];
	const sent = new SentMessages(sentBefore);

	it("catches the reported restatements and the copies the small model wrote on a replay of that moment", () => {
		for (const text of [
			"모드 추가할 건 없어? 모델풀은 지워야 할 것 같고",
			"윈도우 버전에서 추가 지시가 바로 안 들어가는데 지금 대기열에 걸려 있어",
			"윈도우 버전에서 추가 지시가 바로 안 들어가고 대기열에 걸려 있는 문제 먼저 고쳐줘",
			"작업 현황에 나온 사용한도 표시를 설정의 계정 목록에도 적용해 줘",
			"채팅 입력창에 뭔가 효과를 줘서 작업중이라는 느낌을 주면 좋을꺼같음",
		])
			expect(sent.isCopy(text), text).toBe(true);
		expect(
			sent.similarity("모드 추가할 건 없어? 모델풀은 지워야 할 것 같고", sentBefore[9] ?? ""),
		).toBeGreaterThanOrEqual(COPY_SIMILARITY);
	});

	it("keeps new requests, including ones that share everyday words, and short requests that recur", () => {
		for (const text of [
			"입력창 효과는 어떤 후보가 좋을지 캡처로 비교해서 보여줘",
			"리팩토링 계획 1단계부터 바로 진행해줘",
			"ComposerLive 끝나면 캡처로 보여줘",
			"WinBlank 결과 나오면 바로 알려줘",
			"Windows에서 Ctrl+Enter로 추가 지시 되는지 확인해줘",
			// Sent before, short and generic: worth suggesting again later (judged against the latest message only).
			"배포해줘",
			"이 작업 끝나면 바로 배포해줘",
		])
			expect(sent.isCopy(text), text).toBe(false);
		expect(COPY_MIN_UNITS).toBe(14);
	});

	it("never restates the latest message, however short", () => {
		const latest = new SentMessages([...sentBefore, "배포해줘"]);
		expect(latest.isCopy("배포해줘")).toBe(true);
		expect(latest.isCopy("배포해 줘!")).toBe(true);
		expect(new SentMessages([]).isCopy("배포해줘")).toBe(false);
	});

	it("drops the restatements from the cleaned candidates", () => {
		const reply = [
			"모드 추가할 건 없어? 모델풀은 지워야 할 것 같고",
			"윈도우 버전에서 추가 지시가 바로 안 들어가는데 지금 대기열에 걸려 있어",
			"입력창 효과 너무 튀지 않게 해줘",
		].join("\n");
		expect(cleanCandidates(reply, { register: "casual", sent })).toEqual(["입력창 효과 너무 튀지 않게 해줘"]);
	});
});

/**
 * Reported with it: the ghost text while typing "suggests odd continuations". On a replay of six real drafts from the
 * session (two runs each) all 12 continuations were wrong: 존댓말 ("…확인이 필요해요"), the assistant's voice ("확인해
 * 볼게요", "정리해 둘게요"), whole new sentences, another topic; with the register fixed, 9 of 12 still glued onto the
 * last word ("버튼이" + "이상하게", "모습이" + "가 맞는지"). The model now restates the draft and continues it, and the
 * continuation is judged as part of the assembled message.
 */
describe("inline continuation is judged as the assembled message (reported: odd ghost text)", () => {
	const sent = new SentMessages([
		"모드를 추가할것은 없나? 모델풀은 삭제해야할꺼 같고",
		"그리고 윈도우버전에서는 추가지시가 즉시 안들어감 지금 대기열에 걸려있음",
		"배포해줘",
	]);
	const casual = { register: "casual" as const, sent };
	/** The model's reply: the draft restated, then its continuation. */
	const ghost = (draft: string, continuation: string, checks: InlineChecks = casual) =>
		cleanInlineReply(draft + continuation, draft, checks);

	it("keeps a continuation that finishes the user's own sentence, even as a fragment", () => {
		// Real replies on the replay, draft restated.
		expect(ghost("그리고 윈도우버전에서는 추가지시가", " 안 먹히는지 봐줄래?")).toBe(" 안 먹히는지 봐줄래?");
		expect(ghost("작업현황에 나온 사용한도 표시 모습이", " 어떤지 봐줘")).toBe(" 어떤지 봐줘");
		expect(ghost("그리고 지금 작업중인데 버튼이", " 안 바뀌어")).toBe(" 안 바뀌어");
	});

	it("shows nothing when the reply does not restate the draft as typed (the user's text is never rewritten)", () => {
		expect(cleanInlineReply("이상하게 안 눌려서 확인 좀 해줘", "그리고 지금 작업중인데 버튼이", casual)).toBeNull();
		expect(
			cleanInlineReply("작업 현황에 나온 사용 한도 표시가 이상해", "작업현황에 나온 사용한도 표시", casual),
		).toBeNull();
		// A draft ending in a space: the model may drop it, and its own leading space is not doubled.
		expect(cleanInlineReply("버튼 색이 안 바뀌어", "버튼 색이 ", casual)).toBe("안 바뀌어");
	});

	it("shows nothing for the replayed failures", () => {
		const failures: Array<[string, string]> = [
			["그리고 지금 작업중인데 버튼이", " 색이 바뀌지 않아서 확인이 필요해요"],
			["그리고 윈도우버전에서는 추가지시가", " 안 되는지 확인해 볼게요."],
			["작업현황에 나온 사용한도 표시 모습이", " 이 시각 정보, 바로 정리해 둘게요."],
			["파일 및 폴더 구조 개선 그리고", " 정리 작업은 나중에 해요."],
			["추천 프롬프트 이미 작업중인데", " ...입력창에 효과를 넣으면 CPU 부담이 생기니 측정부터 해 볼게요."],
			["그리고 지금 작업중인데 버튼이", " 정확히 어떤 버튼인지 모르겠지만, 이 버튼 이슈는 먼저 처리하는 게 좋아요."],
		];
		for (const [draft, continuation] of failures) expect(ghost(draft, continuation), continuation).toBeNull();
	});

	it("shows nothing for a second sentence, a role label, a tag or a fence", () => {
		expect(ghost("버튼 색이", " 이상해. 그리고 배포해줘")).toBeNull();
		expect(ghost("버튼 색이", " assistant: 네")).toBeNull();
		expect(ghost("버튼 색이", "<b>이상해</b>")).toBeNull();
		expect(ghost("버튼 색이", "```")).toBeNull();
		expect(ghost("버튼 색이", " 이상해.")).toBe(" 이상해.");
	});

	it("shows nothing when the assembled message restates a sent one", () => {
		expect(ghost("그리고 윈도우버전에서는", " 추가지시가 즉시 안들어감")).toBeNull();
		// A different question on the same draft is no restatement.
		expect(ghost("그리고 윈도우버전에서는", " 고친 버전 언제 나와?")).toBe(" 고친 버전 언제 나와?");
		expect(ghost("모드를 추가할것은 없나?", " 모델풀은 삭제해야할꺼 같고")).toBeNull();
	});

	it("never holds what the user typed against the ghost", () => {
		// Polite or honorific words the user typed themselves: only what the ghost adds is judged.
		expect(ghost("이거 확인해 주시고", " 배포도 해줘")).toBe(" 배포도 해줘");
		expect(ghost("고마워요", " 그리고 커밋해")).toBe(" 그리고 커밋해");
		// The user retyping a sent message is their call; the ghost only adds its own words.
		expect(ghost("모드를 추가할것은 없나? 모델풀은 삭제해야할꺼", " 같고")).toBe(" 같고");
	});

	it("holds a polite user to 존댓말 without dropping their own casual words", () => {
		const polite = { register: "polite" as const, sent };
		expect(ghost("로그 확인하고 결과", " 알려줘", polite)).toBeNull();
		expect(ghost("로그 확인하고 결과", " 알려 주세요", polite)).toBe(" 알려 주세요");
		expect(ghost("로그 확인하고 결과", " 알려줘", {})).toBe(" 알려줘");
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
	});

	it("lists what the user typed, oldest first, without synthetic, agent, slash or injected messages", () => {
		expect(
			sentTexts([
				...messages,
				{ role: "user", content: "Continue working on the goal.", synthetic: true },
				{ role: "user", content: "subagent result", attribution: "agent" },
				{ role: "user", content: "/compact" },
				{ role: "user", content: "<system-reminder>x</system-reminder>" },
				{ role: "user", content: [{ type: "image", data: "…" }] },
				{ role: "user", content: "  배포해줘\n그리고 캡처  " },
			]),
		).toEqual(["hello", "run tests", "배포해줘\n그리고 캡처"]);
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
		// Inline gets the register line only: an excerpt of a sent message invites a copy.
		expect(buildInlineRequest("user: 배포해줘", "버튼이", "casual")).toBe(
			"<user-style>\nregister: 반말 (casual). Write Korean the way they do (해줘, 해, 할래?, 돼?); never 요, 니다, 세요 or 까요.\n</user-style>\n<conversation>\nuser: 배포해줘\n</conversation>\n<draft>버튼이</draft>",
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

/**
 * Reported: the assistant had steered a session it opened onto the user's correction and said so ("방향을 고쳤어요");
 * the suggestion offered "좋아 그 방향으로 가". Nothing waited for a yes, and the opened session ran in its own tab,
 * so `<app-state>` showed no work underway.
 */
describe("nothing to approve (reported: '좋아 그 방향으로 가' for work already underway)", () => {
	const reported = [
		{ role: "user", content: "진짜 이름을 바꿀수있게 하는게 맞지 않음?" },
		{
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "s1",
					name: "write",
					arguments: { path: "xd://ompdesk_session_send", content: "{}" },
				},
			],
		},
		{ role: "toolResult", toolCallId: "s1", toolName: "write", content: "accepted; delivered as steer" },
		{
			role: "assistant",
			stopReason: "stop",
			content:
				"맞아요. 별명이 아니라 **기기의 실제 이름**을 바꾸도록 방향을 고쳤어요.\n\n**바뀌는 동작**\n1. 그 컴퓨터에서 직접 바꿀 수 있어요.\n2. 다시 연결해도 유지돼요.",
		},
	];
	const approvals = [
		"좋아 그 방향으로 가",
		"그렇게 해",
		"진행해",
		"ㅇㅋ 고",
		"go ahead",
		"sounds good, proceed",
		"좋아!",
	];

	it("tells a reply that reports work from one that asks the user to decide", () => {
		expect(awaitsDecision(reported)).toBe(false);
		const asking = (text: string) => [
			{ role: "user", content: "고쳐줘" },
			{ role: "assistant", content: text },
		];
		for (const text of [
			"두 가지 방법이 있어요.\n\n1. 별명\n2. 실제 이름\n\n어느 쪽으로 할까요?",
			"Fixed the parser.\n\nShould I also update the docs?",
			"A or B — which do you prefer",
			"원하는 방식을 골라 주세요.",
		])
			expect(awaitsDecision(asking(text)), text).toBe(true);
		// A question earlier in the reply, then a report at its end, asks nothing now.
		expect(awaitsDecision(asking("왜 실패했을까요?\n\n원인을 찾아서 고쳤어요."))).toBe(false);
		const openAsk = [
			{ role: "user", content: "바꿔줘" },
			{ role: "assistant", content: [{ type: "toolCall", id: "a1", name: "ask", arguments: { questions: [] } }] },
		];
		expect(awaitsDecision(openAsk)).toBe(true);
		expect(
			awaitsDecision([...openAsk, { role: "toolResult", toolCallId: "a1", toolName: "ask", content: "B" }]),
		).toBe(false);
	});

	it("drops pure approvals when nothing waits for a decision and keeps them when something does", () => {
		for (const line of approvals) expect(isApprovalOnly(line), line).toBe(true);
		for (const line of [
			"진행 상황 알려줘",
			"go check the logs",
			"그 세션 결과 보여줘",
			"끝나면 배포해",
			"그대로 두고 테스트만 돌려",
		])
			expect(isApprovalOnly(line), line).toBe(false);
		const reply = [...approvals, "진행 상황 알려줘"].join("\n");
		expect(cleanCandidates(reply, { decisionPending: false })).toEqual(["진행 상황 알려줘"]);
		expect(cleanCandidates(reply, { decisionPending: true })).toEqual(approvals.slice(0, 3));
		expect(cleanCandidates(reply)).toEqual(approvals.slice(0, 3));
	});

	it("shows the sessions the assistant opened and whether the last reply asks anything", () => {
		const facts = extractFacts(reported, {
			openedSessions: [
				{ title: "원격 기기 이름을 언제든 바꿀 수 있게" },
				{ title: "메모리 통합 빌드", waiting: true },
			],
		});
		const state = buildAppState(facts);
		expect(state).toContain('sessions-working-now: "원격 기기 이름을 언제든 바꿀 수 있게"');
		expect(state).toContain('sessions-waiting-for-an-answer: "메모리 통합 빌드"');
		expect(state).toContain("last-reply: reports work done or underway; it asks the user nothing");
		expect(buildAppState(extractFacts(reported))).not.toContain("sessions-");
		expect(SUGGEST_INSTRUCTIONS).toMatch(/when it reports work done or underway, never approve/);
	});
});

/**
 * Measured on 16 real moments of one user (24 Oct 2026, the user's report "프롬프트 추천하는것 제대로 개선좀"): what the
 * small model wrote that the person would never send, whatever the prompt says, is caught in code.
 */
describe("candidates the person would never send (measured on 16 real moments)", () => {
	it("drops a line naming the request's own field names", () => {
		expect(cleanCandidates("그 last-failure 어디서 난 거야?\n처리함 기능은 언제 들어가?")).toEqual([
			"처리함 기능은 언제 들어가?",
		]);
	});

	it("takes the user's own openers and final punctuation, so a reworded duplicate goes too", () => {
		const style = [
			"두 손가락 확대를 막아야함",
			"릴리즈는 알아서 하기로 한거잖아",
			"원격 세션은 하위세션을 확인할수가 없음",
		];
		expect(
			cleanCandidates(
				"좋아, 지금 바로 v0.71.2로 릴리스해줘.\n지금 바로 v0.71.2로 릴리스해줘\n412px 작업 카드 건도 고쳐줘.",
				{
					style,
				},
			),
		).toEqual(["지금 바로 v0.71.2로 릴리스해줘", "412px 작업 카드 건도 고쳐줘"]);
		// A user who opens with 좋아 and ends with a period keeps both.
		const opener = ["좋아, 그렇게 해줘.", "좋아, 배포해.", "테스트도 돌려."];
		expect(userVoice(opener)).toMatchObject({ periods: true });
		expect(cleanCandidates("좋아, 412px 작업 카드 건도 고쳐줘.", { style: opener })).toEqual([
			"좋아, 412px 작업 카드 건도 고쳐줘.",
		]);
	});

	it("tells the register from the latest messages that show one, past the ones ending in a noun", () => {
		const sent = [
			"배포해줘",
			"다 끝나면 알려줘",
			"이미지는 허용",
			"그리고 전부 릴리즈 진행",
			"모바일에서 원격으로 해봤는데 확대되어버림 모든공간에서",
			"두 손가락 확대",
			"OpenRig",
			"https://example.com",
		];
		expect(userRegister(sent)).toBe("casual");
		expect(userRegister(["확인 부탁드립니다", "이미지는 허용", "https://example.com"])).toBe("polite");
	});

	it("reads an offer in the reply's closing paragraphs as a decision the user may answer", () => {
		const reply = (text: string) => [
			{ role: "user", content: "고쳐줘" },
			{ role: "assistant", content: text },
		];
		for (const text of [
			"이번에는 테스트와 문서만 바뀌었어요.\n\n지금 바로 써야 하면 말씀해 주세요. 그러면 v0.71.2로 릴리스할게요.",
			"고칠 방법은 두 가지예요. 원하시면 이어서 할게요.\n\n- 기다리는 항목 나눠 보여 주기\n- 겹치는 항목 합치기",
			"Done.\n\nLet me know if you want the docs updated too.",
		])
			expect(awaitsDecision(reply(text)), text).toBe(true);
		expect(awaitsDecision(reply("원인을 찾아서 고쳤어요.\n\n배포까지 끝났어요."))).toBe(false);
	});
});

describe("inline reply", () => {
	it("takes the first line and what follows the restated draft, without wrapping quotes", () => {
		expect(cleanInlineReply("fix the failing test next\nmore", "fix the")).toBe(" failing test next");
		expect(cleanInlineReply('"ship it and then deploy"', "ship it")).toBe(" and then deploy");
		expect(cleanInlineReply("fix the failing test in a.ts", "fix the")).toBe(" failing test in a.ts");
		expect(cleanInlineReply("NONE", "fix the")).toBeNull();
		expect(cleanInlineReply("", "fix the")).toBeNull();
		expect(cleanInlineReply("fix the", "fix the")).toBeNull();
		// The continuation alone (the draft not restated) shows nothing.
		expect(cleanInlineReply(" failing test next", "fix the")).toBeNull();
	});

	it("finds the continuation after the window a long draft sent", () => {
		const draft = `${"word ".repeat(100)}fix the`;
		expect(cleanInlineReply(`${inlineDraftWindow(draft)} failing test`, draft)).toBe(" failing test");
	});

	it("shows nothing for a runaway reply rather than cutting it into something the model never wrote", () => {
		expect(cleanInlineReply(`draft draft ${"word ".repeat(100)}`, "draft draft")).toBeNull();
		expect(cleanInlineReply(`draft draft ${"x".repeat(INLINE_MAX_CHARS)}`, "draft draft")).toBeNull();
		expect(cleanInlineReply(`draft draft ${"x".repeat(INLINE_MAX_CHARS - 1)}`, "draft draft")).toHaveLength(
			INLINE_MAX_CHARS,
		);
		expect(cleanInlineReply(`버튼 색이 ${"가".repeat(INLINE_MAX_CHARS_CJK - 1)}`, "버튼 색이")).toHaveLength(
			INLINE_MAX_CHARS_CJK,
		);
		expect(cleanInlineReply(`버튼 색이 ${"가".repeat(INLINE_MAX_CHARS_CJK)}`, "버튼 색이")).toBeNull();
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
