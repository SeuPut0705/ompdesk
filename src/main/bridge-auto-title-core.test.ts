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
} from "../../resources/gui-bridge/auto-title-contracts";
import {
	conciseTitle,
	DEFAULT_GATE_RULES,
	EvolveGate,
	isRewordedTitle,
	planTitlePrompt,
	TITLE_MAX_CJK_CHARS,
	TITLE_MAX_WORDS,
	type TitleChangeLike,
	titleIsAuto,
	titleLanguageLine,
	WEIGHT,
} from "../../resources/gui-bridge/auto-title-core";

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
	it("asks for the person's language first, the reply language as the fallback, and a short title", () => {
		const line = titleLanguageLine("Korean");
		expect(line).toContain("the language the user writes in");
		expect(line).toContain("write it in Korean");
		expect(line).toContain(`2-${TITLE_MAX_WORDS} words`);
		expect(line).toContain(`at most ${TITLE_MAX_CJK_CHARS} characters in Korean`);
		expect(line).toContain("overrides the 3-6 words above");
		expect(line).toContain("identifiers, file names and proper nouns");
	});

	it("appends the line to stock's prompt, leaves stock alone without a language, and keeps a person's own prompt", () => {
		const ours = `STOCK\n\n${titleLanguageLine("Korean")}`;
		expect(planTitlePrompt(undefined, undefined, "STOCK\n", "Korean")).toEqual({ keep: false, prompt: ours });
		expect(planTitlePrompt(undefined, undefined, "STOCK", undefined)).toEqual({ keep: false, prompt: undefined });
		// Ours, then the language changed or went off.
		expect(planTitlePrompt(ours, ours, "STOCK", "Japanese")).toEqual({
			keep: false,
			prompt: `STOCK\n\n${titleLanguageLine("Japanese")}`,
		});
		expect(planTitlePrompt(ours, ours, "STOCK", undefined)).toEqual({ keep: false, prompt: undefined });
		// A TITLE_SYSTEM.md stock resolved (at spawn, or after a move) is the person's whole title prompt.
		expect(planTitlePrompt("MINE", undefined, "STOCK", "Korean")).toEqual({ keep: true });
		expect(planTitlePrompt("MINE", ours, "STOCK", "Korean")).toEqual({ keep: true });
	});

	it("cuts a long title to whole words, never an ellipsis", () => {
		expect(conciseTitle("Fix login bug")).toBe("Fix login bug");
		expect(conciseTitle("Add support for dark mode toggle")).toBe("Add support for dark mode");
		expect(conciseTitle("Speed up the build step, and tests")).toBe("Speed up the build step");
		expect(conciseTitle("Speed up the build - and cache")).toBe("Speed up the build");
		expect(conciseTitle("로그인 버그 수정")).toBe("로그인 버그 수정");
		// Korean: at most five words, then at most 20 characters.
		expect(conciseTitle("세션 제목을 사용자 언어로 짧게 생성하도록 수정")).toBe("세션 제목을 사용자 언어로 짧게");
		expect(conciseTitle("데스크톱앱 자동세션제목 언어설정 반영하기")).toBe("데스크톱앱 자동세션제목 언어설정");
		expect(conciseTitle("auth.ts 로그인 리다이렉트 수정")).toBe("auth.ts 로그인 리다이렉트 수정");
		// One word longer than the limit stays whole: never part of a word.
		const unspaced = "修复会话标题语言设置问题并且保持简短不要太长";
		expect(unspaced.length).toBeGreaterThan(TITLE_MAX_CJK_CHARS);
		expect(conciseTitle(unspaced)).toBe(unspaced);
		for (const title of ["Add support for dark mode toggle", "세션 제목을 사용자 언어로 짧게 생성하도록 수정"])
			expect(conciseTitle(title)).not.toMatch(/…|\.\.\./);
	});
});
