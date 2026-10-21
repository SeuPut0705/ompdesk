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
});
