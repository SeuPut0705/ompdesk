import { describe, expect, it } from "vitest";
import { markdownPlainText } from "./markdown-plain";

// The bridge's `textPreview` (session-display.ts) arrives with every line break collapsed to one space.
describe("markdownPlainText", () => {
	it("keeps the words of headings, emphasis, lists, quotes, links and code", () => {
		expect(markdownPlainText("## Root cause ### Step 1: trace the retry path")).toBe(
			"Root cause Step 1: trace the retry path",
		);
		expect(markdownPlainText("Shipped **v0.27.0**. Both _installers_ are ~~not~~ `signed`.")).toBe(
			"Shipped v0.27.0. Both installers are not signed.",
		);
		expect(markdownPlainText("> quoted text")).toBe("quoted text");
		expect(markdownPlainText("- [x] done item [docs](https://x.test) ![chart](a.png)")).toBe("done item docs chart");
		expect(markdownPlainText("Plans: | Plan | Order | |---|:--:| | A | sign first |")).toBe(
			"Plans: · Plan · Order · A · sign first",
		);
		expect(markdownPlainText("```ts const a = 1; ```")).toBe("const a = 1;");
	});

	it("leaves text that only looks like markup", () => {
		expect(markdownPlainText("snake_case_name and 2*3*4, ls | grep x, C# and #42")).toBe(
			"snake_case_name and 2*3*4, ls | grep x, C# and #42",
		);
	});
});
