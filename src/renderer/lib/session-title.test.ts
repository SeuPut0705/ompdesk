import { describe, expect, it } from "vitest";
import { NO_TEXT_PROMPT } from "../../../resources/gui-bridge/session-list-contracts";
import { wrapAgentMessage } from "../../shared/agent-control";
import { translate } from "./i18n";
import { sessionDisplayTitle, sessionHasContent } from "./session-title";

describe("stock's '(no messages)' placeholder", () => {
	it("is never a title: the fallback shows", () => {
		expect(sessionDisplayTitle({ title: null, firstMessage: "(no messages)" }, "New session")).toBe("New session");
		expect(sessionDisplayTitle({ title: "Named", firstMessage: "(no messages)" }, "New session")).toBe("Named");
	});

	it("is not content by itself, but a counted message is", () => {
		expect(sessionHasContent({ title: null, firstMessage: "(no messages)", messageCount: 0 })).toBe(false);
		expect(sessionHasContent({ title: null, firstMessage: "(no messages)", messageCount: 2 })).toBe(true);
	});
});

describe("the bridge's no-text sentinel", () => {
	it("reads as the localized label, counts as content, and never shows raw", () => {
		const row = { title: null, firstMessage: NO_TEXT_PROMPT, messageCount: 0 };
		expect(sessionDisplayTitle(row, "Untitled")).toBe(translate("session.noTextPrompt"));
		expect(sessionDisplayTitle(row, "Untitled")).not.toContain("no-text");
		expect(sessionHasContent(row)).toBe(true);
		expect(sessionDisplayTitle({ ...row, title: "Named" }, "Untitled")).toBe("Named");
	});
});

describe("a session another session's agent opened (ompdesk_session_open, an Autopilot child)", () => {
	it("reads as its task until it has a title: the Title: line, else the task's first line", () => {
		const titled = wrapAgentMessage("Title: Fix the flaky upload test\nThe test in upload.test.ts times out.", "Run");
		expect(sessionDisplayTitle({ title: null, firstMessage: titled }, "Untitled")).toBe("Fix the flaky upload test");
		const plain = wrapAgentMessage("Autopilot child 1 of cycle 2: one small item.\nDetails follow.", "Run");
		expect(sessionDisplayTitle({ title: "", firstMessage: plain }, "Untitled")).toBe(
			"Autopilot child 1 of cycle 2: one small item.",
		);
		expect(sessionDisplayTitle({ title: "Named by stock", firstMessage: titled }, "Untitled")).toBe("Named by stock");
	});

	it("never shows the Title: label: a long title line, an unwrapped goal, or a stored title that kept it", () => {
		const long = `Title: ${"긴 제목 ".repeat(40)}\nBody.`;
		const wrapped = sessionDisplayTitle({ title: null, firstMessage: wrapAgentMessage(long, "Run") }, "Untitled");
		expect(wrapped.startsWith("긴 제목")).toBe(true);
		expect(wrapped).not.toContain("Title:");

		// A goal's objective is not wrapped: the listing's first message is the bare text.
		expect(
			sessionDisplayTitle({ title: null, firstMessage: "Title: OMPdesk 사이드바 묶음\nDetails." }, "Untitled"),
		).toBe("OMPdesk 사이드바 묶음");
		expect(sessionDisplayTitle({ title: "Title: 안내 문구", firstMessage: "x" }, "Untitled")).toBe("안내 문구");
		// A person's own prompt is left alone.
		expect(sessionDisplayTitle({ title: null, firstMessage: "Fix the Title: bar" }, "Untitled")).toBe(
			"Fix the Title: bar",
		);
	});
});

describe("an Autopilot run's name", () => {
	it("drops the word an earlier build put in front of it: the row's rocket says it is a run", () => {
		expect(sessionDisplayTitle({ title: "오토파일럿 · 길드 하우스 정리", firstMessage: "" }, "New session")).toBe(
			"길드 하우스 정리",
		);
		expect(sessionDisplayTitle({ title: "Autopilot · rng-arena", firstMessage: "" }, "New session")).toBe(
			"rng-arena",
		);
		expect(sessionDisplayTitle({ title: "Autopilot notes", firstMessage: "" }, "New session")).toBe(
			"Autopilot notes",
		);
	});
});
