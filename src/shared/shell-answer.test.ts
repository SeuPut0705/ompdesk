import { describe, expect, test } from "vitest";
import { invokeAnswerText } from "./shell-answer";

describe("invokeAnswerText", () => {
	test("an answer passes through", () => {
		expect(invokeAnswerText('{"value":1}', "x:y", 200)).toBe('{"value":1}');
	});
	test("an empty body names the channel", () => {
		expect(() => invokeAnswerText("", "sessions:list", 200)).toThrow(
			"shell answered nothing for sessions:list (HTTP 200)",
		);
		expect(() => invokeAnswerText("  \n", "a", 500)).toThrow("shell answered nothing for a (HTTP 500)");
	});
});
