import { describe, expect, it } from "vitest";
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
