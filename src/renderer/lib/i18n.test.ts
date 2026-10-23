import { describe, expect, it } from "vitest";
import { translate } from "./i18n";

describe("translate", () => {
	// "events.goalTimeLimit" names the minutes twice; the second one used to stay raw.
	it("fills a placeholder everywhere it appears", () => {
		const text = translate("events.goalTimeLimit", { minutes: 42 });
		expect(text).not.toContain("{minutes}");
		expect(text.match(/42/g)).toHaveLength(2);
	});

	it("inserts a value literally: no replacement patterns, no second pass", () => {
		expect(translate("workspaceDirs.added", { path: "$&{path}" })).toContain("$&{path}");
		expect(translate("workspaceDirs.added", { path: "a$'b" })).toContain("a$'b");
	});

	it("leaves a placeholder without a value alone", () => {
		expect(translate("workspaceDirs.added", {})).toContain("{path}");
	});

	it("says one of a thing in the singular and any other count in the plural, formatted counts included", () => {
		expect(translate("workspaces.sessionCount", { count: 1 })).toBe("1 session");
		expect(translate("workspaces.sessionCount", { count: 2 })).toBe("2 sessions");
		expect(translate("workspaces.sessionCount", { count: 0 })).toBe("0 sessions");
		expect(translate("sessionPicker.messageCount", { count: "1,204" })).toBe("1,204 messages");
		expect(translate("fileCard.count.rows", { count: "1+" })).toBe("1+ rows");
		expect(translate("fileCard.count.rows", { count: "1" })).toBe("1 row");
		expect(
			translate("filesPanel.contentSearch.count", { matches: 1, files: 1, matchPlural: "", filePlural: "" }),
		).toBe("1 match in 1 file");
		expect(translate("sidebar.subagents.usage", { tokens: "1.2k", tools: 1 })).toBe("1.2k tokens · 1 tool call");
		expect(translate("stats.syncDetail", { messages: 1, files: 3 })).toBe("1 message from 3 files");
		// A caller that says the plural keeps its word.
		expect(translate("sessionTree.messageCount", { count: 1, plural: "s" })).toBe("1 messages");
	});
});
