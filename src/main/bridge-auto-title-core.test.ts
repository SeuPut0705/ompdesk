import { describe, expect, it } from "vitest";
import {
	AUTO_TITLE_ENV,
	autoTitleFromPrefs,
	DEFAULT_AUTO_TITLE,
	evolveEffective,
	normalizeAutoTitle,
	parseAutoTitleEnv,
	TITLE_TRIGGER,
	titleEffective,
	titleSuppressedByEnv,
} from "../../resources/gui-bridge/modes/auto-title-contracts";
import {
	conciseTitle,
	DEFAULT_GATE_RULES,
	EvolveGate,
	isRewordedTitle,
	planTitlePrompt,
	TITLE_HARD_CHARS,
	TITLE_HARD_CJK_CHARS,
	TITLE_MAX_CHARS,
	TITLE_MAX_CJK_CHARS,
	TITLE_MAX_WORDS,
	type TitleChangeLike,
	titleFits,
	titleIsAuto,
	titleLanguageLine,
	titleShorterLine,
	WEIGHT,
} from "../../resources/gui-bridge/modes/auto-title-core";

describe("auto title contracts", () => {
	it("defaults on, reads a malformed value as on, and lets the sub-switch count only under the main one", () => {
		expect(DEFAULT_AUTO_TITLE).toEqual({ enabled: true, evolve: true, suppressed: false });
		expect(autoTitleFromPrefs(undefined, "yes")).toEqual({ enabled: true, evolve: true, suppressed: false });
		expect(autoTitleFromPrefs(false, true)).toEqual({ enabled: false, evolve: true, suppressed: false });
		expect(evolveEffective({ enabled: false, evolve: true, suppressed: false })).toBe(false);
		expect(evolveEffective({ enabled: true, evolve: false, suppressed: false })).toBe(false);
		expect(evolveEffective({ enabled: true, evolve: true, suppressed: false })).toBe(true);
		expect(normalizeAutoTitle(null)).toEqual(DEFAULT_AUTO_TITLE);
		expect(normalizeAutoTitle({ evolve: false })).toEqual({ enabled: true, evolve: false, suppressed: false });
	});

	it("turns everything off while the user's own environment suppresses stock's titles", () => {
		expect(titleSuppressedByEnv({})).toBe(false);
		expect(titleSuppressedByEnv({ PI_NO_TITLE: "1" })).toBe(true);
		expect(titleSuppressedByEnv({ PI_NO_TITLE: "" })).toBe(false);
		expect(titleSuppressedByEnv({ PI_NO_TITLE: "0" })).toBe(false);
		const suppressed = autoTitleFromPrefs(true, true, true);
		expect(titleEffective(suppressed)).toBe(false);
		expect(evolveEffective(suppressed)).toBe(false);
		expect(titleEffective({ enabled: true, evolve: true, suppressed: false })).toBe(true);
	});

	it("parses the spawn env", () => {
		expect(AUTO_TITLE_ENV).toBe("OMP_GUI_AUTO_TITLE");
		expect(parseAutoTitleEnv(undefined)).toEqual(DEFAULT_AUTO_TITLE);
		expect(parseAutoTitleEnv("not json")).toEqual(DEFAULT_AUTO_TITLE);
		expect(parseAutoTitleEnv('{"enabled":false,"evolve":false,"suppressed":true}')).toEqual({
			enabled: false,
			evolve: false,
			suppressed: true,
		});
	});
});

describe("title origin", () => {
	const change = (title: string, source: "auto" | "user", trigger?: string): TitleChangeLike => ({
		type: "title_change",
		title,
		source,
		...(trigger ? { trigger } : {}),
	});

	it("is automatic for a generated title and manual for one the person set", () => {
		expect(titleIsAuto(undefined, undefined, [])).toBe(false);
		expect(titleIsAuto("Fix login", "auto", [change("Fix login", "auto")])).toBe(true);
		expect(titleIsAuto("Fix login", "user", [change("Fix login", "user")])).toBe(false);
	});

	it("follows the last entry that wrote the name: a typed name after an automatic one is manual", () => {
		const entries = [change("Fix login", "auto"), change("My name", "user")];
		expect(titleIsAuto("My name", "user", entries)).toBe(false);
	});

	it("keeps a regenerated title automatic although stock holds it as source user", () => {
		const entries = [change("My name", "user"), change("Fix login", "user", TITLE_TRIGGER)];
		expect(titleIsAuto("Fix login", "user", entries)).toBe(true);
		// The person then types again: manual.
		expect(titleIsAuto("Typed", "user", [...entries, change("Typed", "user")])).toBe(false);
	});

	it("falls back to stock's titleSource for a name no entry wrote", () => {
		expect(titleIsAuto("Header title", "auto", [])).toBe(true);
		expect(titleIsAuto("Header title", "user", [])).toBe(false);
		expect(titleIsAuto("Header title", undefined, [])).toBe(false);
		// An entry for another name (an older title) does not decide the current one.
		expect(titleIsAuto("Current", "user", [change("Older", "auto")])).toBe(false);
	});
});

describe("isRewordedTitle", () => {
	it("treats the same words, case and punctuation as a reword", () => {
		expect(isRewordedTitle("Fix the login bug", "fix the login bug!")).toBe(true);
		expect(isRewordedTitle("Fix the login bug", "Fix login bug")).toBe(true);
		expect(isRewordedTitle("Fix login bug", "Login bug fix")).toBe(true);
	});

	it("treats a different topic as a change", () => {
		expect(isRewordedTitle("Fix the login bug", "Migrate the build to Vite")).toBe(false);
		expect(isRewordedTitle("Fix the login bug", "Write release notes for v2")).toBe(false);
	});

	it("compares scripts that do not split on spaces by character trigrams", () => {
		expect(isRewordedTitle("로그인 버그 수정", "로그인 버그 수정하기")).toBe(true);
		expect(isRewordedTitle("로그인버그수정", "빌드를 Vite로 이전")).toBe(false);
	});
});

describe("EvolveGate", () => {
	const rules = DEFAULT_GATE_RULES;
	const edit = { type: "tool_execution_end", toolName: "edit" };

	it("waits for the minimum turns and for the work to move", () => {
		let now = 0;
		const gate = new EvolveGate(now);
		now += rules.minIntervalMs;
		gate.note(edit);
		expect(gate.turnEnded(now)).toBe(false);
		// One edit is not enough weight, and two turns have passed only now.
		expect(gate.turnEnded(now)).toBe(false);
		gate.note(edit);
		gate.note(edit);
		expect(gate.turnEnded(now)).toBe(true);
	});

	it("weighs files, the todo plan and the goal, and ignores failed tools and reads", () => {
		const gate = new EvolveGate(0);
		const now = rules.minIntervalMs;
		gate.turnEnded(now);
		gate.note({ type: "tool_execution_end", toolName: "edit", isError: true });
		gate.note({ type: "tool_execution_end", toolName: "read" });
		gate.note({ type: "tool_execution_end", toolName: "bash" });
		expect(gate.turnEnded(now)).toBe(false);
		gate.note({ type: "goal_updated" });
		expect(WEIGHT.goal).toBeGreaterThanOrEqual(rules.threshold);
		expect(gate.turnEnded(now)).toBe(true);
		const plan = new EvolveGate(0);
		plan.turnEnded(now);
		plan.note({ type: "tool_execution_end", toolName: "todo" });
		plan.note({ type: "tool_execution_end", toolName: "write" });
		expect(plan.turnEnded(now)).toBe(true);
	});

	it("considers a quiet session after the force window, once per window", () => {
		const gate = new EvolveGate(0);
		const now = rules.minIntervalMs;
		const results = Array.from({ length: rules.forceTurns }, () => gate.turnEnded(now));
		expect(results.slice(0, -1).every(result => !result)).toBe(true);
		expect(results.at(-1)).toBe(true);
		// The window restarted: the next turn is the first of a new one.
		expect(gate.turnEnded(now)).toBe(false);
	});

	it("debounces: nothing inside the minimum interval after the title was set", () => {
		const gate = new EvolveGate(0);
		gate.note({ type: "goal_updated" });
		expect(gate.turnEnded(1_000)).toBe(false);
		expect(gate.turnEnded(2_000)).toBe(false);
		expect(gate.turnEnded(rules.minIntervalMs)).toBe(true);
	});

	it("starts a new window when a title is set", () => {
		const gate = new EvolveGate(0);
		gate.note({ type: "goal_updated" });
		gate.turnEnded(rules.minIntervalMs);
		gate.reset(rules.minIntervalMs);
		gate.note({ type: "goal_updated" });
		expect(gate.turnEnded(rules.minIntervalMs + 1)).toBe(false);
		expect(gate.turnEnded(rules.minIntervalMs * 2 + 2)).toBe(true);
	});
});

describe("title language and length", () => {
	it("asks for the person's language first, the reply language as the fallback, and a short plain title", () => {
		const line = titleLanguageLine("Korean");
		expect(line).toContain("the language the user writes in");
		expect(line).toContain("write it in Korean");
		expect([TITLE_MAX_WORDS, TITLE_MAX_CJK_CHARS, TITLE_MAX_CHARS]).toEqual([4, 12, 30]);
		expect(line).toContain(`2-${TITLE_MAX_WORDS} words`);
		expect(line).toContain(`at most ${TITLE_MAX_CJK_CHARS} characters in Korean, Chinese or Japanese`);
		expect(line).toContain(`${TITLE_MAX_CHARS} characters otherwise, spaces included`);
		expect(line).toContain("2-4 words, never more");
		expect(line).toContain("plain noun phrase that summarizes the task");
		expect(line).toContain("no punctuation, quotes or emoji");
		expect(line).toContain("overrides the 3-6 words and the imperative phrase above");
		expect(line).toContain("identifiers, file names and proper nouns");
	});

	it("without a reply language sets only the length and form: the title stays in the person's language", () => {
		const line = titleLanguageLine(undefined);
		expect(line).toContain("the language the user writes in");
		expect(line).not.toContain("write it in");
		expect(line).toContain(`2-${TITLE_MAX_WORDS} words`);
		expect(line).toContain("no punctuation, quotes or emoji");
	});

	it("appends the line to stock's prompt with or without a language, and keeps a person's own prompt", () => {
		const ours = `STOCK\n\n${titleLanguageLine("Korean")}`;
		const plain = `STOCK\n\n${titleLanguageLine(undefined)}`;
		expect(planTitlePrompt(undefined, undefined, "STOCK\n", "Korean")).toEqual({ keep: false, prompt: ours });
		expect(planTitlePrompt(undefined, undefined, "STOCK", undefined)).toEqual({ keep: false, prompt: plain });
		// Ours, then the language changed or went off.
		expect(planTitlePrompt(ours, ours, "STOCK", "Japanese")).toEqual({
			keep: false,
			prompt: `STOCK\n\n${titleLanguageLine("Japanese")}`,
		});
		expect(planTitlePrompt(ours, ours, "STOCK", undefined)).toEqual({ keep: false, prompt: plain });
		// A TITLE_SYSTEM.md stock resolved (at spawn, or after a move) is the person's whole title prompt.
		expect(planTitlePrompt("MINE", undefined, "STOCK", "Korean")).toEqual({ keep: true });
		expect(planTitlePrompt("MINE", ours, "STOCK", "Korean")).toEqual({ keep: true });
	});

	it("tells a title within the limits from one that needs the retry", () => {
		expect([TITLE_HARD_CJK_CHARS, TITLE_HARD_CHARS]).toEqual([14, 32]);
		for (const title of ["로그인 오류 수정", "작업 현황판 디자인", "Fix login bug", "Session title shortening rules"])
			expect(titleFits(title), title).toBe(true);
		for (const title of [
			"작업 현황판 화면 디자인",
			"로그인 비밀번호 오류 메시지 버그",
			"Dark mode toggle support added",
			"Session title internationalization rule",
		])
			expect(titleFits(title), title).toBe(false);
	});

	it("shows the first pass two compressions, and the retry all four with the rules", () => {
		const first = titleLanguageLine("Korean");
		expect(first).toContain('"로그인 비밀번호 에러 메시지 버그 수정" → "로그인 오류 수정"');
		expect(first).toContain('"CSV export empty with filters" → "Empty CSV export"');
		expect(first).not.toContain("현황판");
		expect(first).toContain("Keep the subject and the head noun");
		const line = titleShorterLine("작업 현황판 화면 디자인");
		expect(line).toContain('the title "작업 현황판 화면 디자인" is too long');
		expect(line).toContain(`at most ${TITLE_MAX_CJK_CHARS} characters in Korean, Chinese or Japanese`);
		expect(line).toContain(`${TITLE_MAX_CHARS} characters otherwise, spaces included`);
		expect(line).toContain("Keep the subject and the head noun");
		expect(line).toContain("drop modifiers and generic tails (화면, 메시지, 로직, 기능, 관련");
		for (const pair of [
			'"로그인 비밀번호 에러 메시지 버그 수정" → "로그인 오류 수정"',
			'"작업 현황판 화면 디자인 개선" → "현황판 디자인"',
			'"결제 API 재시도 로직" → "결제 재시도"',
			'"CSV export empty with filters" → "Empty CSV export"',
		])
			expect(line).toContain(pair);
	});

	it("keeps a title whole up to the hard cap, then cuts whole words: generic then leading ones in Korean, trailing ones otherwise", () => {
		// Within the hard cap nothing is cut, whatever the word count: the head noun stays.
		expect(conciseTitle("Fix login bug")).toBe("Fix login bug");
		expect(conciseTitle("작업 현황판 화면 디자인")).toBe("작업 현황판 화면 디자인");
		expect(conciseTitle("CSV export empty with filters")).toBe("CSV export empty with filters");
		// Korean past 14 characters: the generic words go first (the real answers of the last audit)…
		expect(conciseTitle("로그인 에러 메시지 버그 수정")).toBe("로그인 에러 버그 수정");
		expect(conciseTitle("작업 현황판 화면 디자인 개선")).toBe("작업 현황판 디자인 개선");
		expect(conciseTitle("로그인 비밀번호 오류 메시지 버그")).toBe("로그인 비밀번호 오류 버그");
		// …then the leading words.
		expect(conciseTitle("로그인 화면 비밀번호 오류 메시지 표시 버그")).toBe("비밀번호 오류 표시 버그");
		expect(conciseTitle("세션 제목을 사용자 언어로 짧게 생성하도록 수정")).toBe("짧게 생성하도록 수정");
		// Latin past 32 characters: the trailing words go, never ending on a function word.
		expect(conciseTitle("Settings page dark mode toggle added")).toBe("Settings page dark mode toggle");
		expect(conciseTitle("Fix the flaky upload test in the integration suite")).toBe("Fix the flaky upload test");
		expect(conciseTitle("Internationalization and localization configuration refactoring")).toBe(
			"Internationalization",
		);
		// One word longer than the cap stays whole: never part of a word.
		const unspaced = "修复会话标题语言设置问题并且保持简短不要太长";
		expect(unspaced.length).toBeGreaterThan(TITLE_HARD_CJK_CHARS);
		expect(conciseTitle(unspaced)).toBe(unspaced);
		for (const title of [
			"Fix the flaky upload test in the integration suite",
			"세션 제목을 사용자 언어로 짧게 생성하도록 수정",
		])
			expect(conciseTitle(title)).not.toMatch(/…|\.\.\./);
	});
});
