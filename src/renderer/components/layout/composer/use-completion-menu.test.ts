/**
 * applyCompletion contract: the shared completion-apply helper used by the
 * composer's model-delegation (`^selector`) menu among others. It must replace
 * ONLY the provider's [rangeStart, rangeEnd) prefix, never consume text after
 * the live caret, place the caret right after the inserted value, and refuse to
 * apply a stale menu once the caret has moved away from rangeEnd.
 */
import { describe, expect, it } from "vitest";
import {
	applyCompletion,
	type CompletionItem,
	type CompletionMenu,
	midPromptSkillMatches,
} from "./use-completion-menu";

function menu(rangeStart: number, rangeEnd: number): CompletionMenu {
	return { source: "model", rangeStart, rangeEnd, items: [], index: 0 };
}

const item: CompletionItem = { value: "^anthropic/claude ", label: "^anthropic/claude" };

describe("applyCompletion", () => {
	it("replaces the ^prefix with the selector and lands the caret after it", () => {
		const result = applyCompletion("review ^cl", 10, menu(7, 10), item);
		expect(result).toEqual({ text: "review ^anthropic/claude ", caret: 7 + item.value.length });
	});

	it("preserves text after the caret instead of consuming it", () => {
		const result = applyCompletion("^cl please", 3, menu(0, 3), { value: "^x ", label: "^x" });
		expect(result).toEqual({ text: "^x  please", caret: 3 });
	});

	it("refuses to apply a stale menu once the caret moved off rangeEnd", () => {
		expect(applyCompletion("review ^cl", 9, menu(7, 10), item)).toBeNull();
	});
});

describe("midPromptSkillMatches", () => {
	// The cases stock's own doc names for `midPromptSkillTokenMatches` (pi-tui autocomplete.ts).
	it("lists every skill for the bare slash and any prefix of skill:", () => {
		for (const token of ["", "s", "skill", "skill:"]) expect(midPromptSkillMatches(token, "skill:tdd")).toBe(true);
	});

	it("matches the bare name or one of its hyphen segments from their start", () => {
		expect(midPromptSkillMatches("hum", "skill:humanizer")).toBe(true);
		expect(midPromptSkillMatches("last", "skill:research-last30days")).toBe(true);
		expect(midPromptSkillMatches("ast", "skill:research-last30days")).toBe(false);
	});

	it("matches an explicit skill: query against the name or description as a subsequence", () => {
		expect(midPromptSkillMatches("skill:rl3", "skill:research-last30days")).toBe(true);
		expect(midPromptSkillMatches("skill:dcs", "skill:docs")).toBe(true);
		// Stock scores the whole token, `skill:` included, against the description too.
		expect(midPromptSkillMatches("skill:pdf", "skill:docs", "skill: read pdf files")).toBe(true);
		expect(midPromptSkillMatches("skill:zz", "skill:docs", "Read PDF files")).toBe(false);
	});

	it("never offers a command for a stray word in prose", () => {
		expect(midPromptSkillMatches("re", "retry")).toBe(false);
		expect(midPromptSkillMatches("re", "skill:tdd")).toBe(false);
	});
});
