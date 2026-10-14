import { describe, expect, it } from "vitest";
import { notificationSummary } from "./notification-summary";

describe("notificationSummary", () => {
	it("reads Markdown as prose: headings, emphasis, code spans, links and lists", () => {
		expect(
			notificationSummary(
				"## Summary\n\n- **Fixed** the `parser` in [lexer.ts](src/lexer.ts)\n- Added _two_ tests\n\nAll green.",
			),
		).toBe("Summary. Fixed the parser in lexer.ts Added two tests. All green.");
	});

	it("drops code blocks, images, tables, rules and HTML", () => {
		expect(
			notificationSummary(
				"Done.\n\n```ts\nconst x = 1;\n```\n\n![shot](a.png)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\n<details>Ran it</details>",
			),
		).toBe("Done. Ran it");
	});

	it("keeps snake_case and arithmetic asterisks intact", () => {
		expect(notificationSummary("Renamed max_tokens; 2 * 3 = 6")).toBe("Renamed max_tokens; 2 * 3 = 6");
	});

	it("cuts a long reply at a word with an ellipsis", () => {
		const summary = notificationSummary(`${"word ".repeat(80)}end`, 40);
		expect(summary.length).toBeLessThanOrEqual(40);
		expect(summary.endsWith("word…")).toBe(true);
	});

	it("returns an empty string for a reply that is only code", () => {
		expect(notificationSummary("```\nls\n```")).toBe("");
	});
});
