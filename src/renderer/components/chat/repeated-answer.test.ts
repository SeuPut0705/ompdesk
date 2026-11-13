import { describe, expect, it } from "vitest";
import { answerOverlap, repeatsAnswer } from "./repeated-answer";

describe("an answer that repeats the one above", () => {
	it("reads a rewrite of the same wait as the same answer, in English and Korean", () => {
		expect(
			repeatsAnswer("Still waiting for the inquiry tab to reply. Nothing to do until then.", [
				"Waiting for the inquiry tab to reply: nothing to do until it answers.",
			]),
		).toBe(true);
		expect(
			repeatsAnswer("문의 탭의 답을 계속 기다리는 중이에요. 그때까지 할 일이 없어요.", [
				"문의 탭의 답을 계속 기다리고 있어요. 그때까지 할 일이 없어요.",
			]),
		).toBe(true);
	});

	it("ignores punctuation, markdown and casing", () => {
		expect(answerOverlap("**Waiting** on CI.", "waiting on ci")).toBe(1);
	});

	it("keeps an answer that says something else, or says nothing", () => {
		expect(repeatsAnswer("I fixed the sidebar label and added a test for it.", ["The build passes."])).toBe(false);
		expect(repeatsAnswer("...", ["The build passes."])).toBe(false);
		expect(repeatsAnswer("The build passes.", [])).toBe(false);
	});

	it("matches a very short answer only when it is the same", () => {
		expect(answerOverlap("네.", "네")).toBe(1);
		expect(answerOverlap("네.", "아니요")).toBe(0);
	});
});
