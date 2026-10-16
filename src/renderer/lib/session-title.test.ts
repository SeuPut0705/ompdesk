import { describe, expect, it } from "vitest";
import { NO_TEXT_PROMPT } from "../../../resources/gui-bridge/session-list-contracts";
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
