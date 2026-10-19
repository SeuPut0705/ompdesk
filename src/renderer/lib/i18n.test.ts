import { describe, expect, it } from "vitest";
import { translate } from "./i18n";

describe("translate", () => {
	// "autopilot.branch.defaultWarning" names the branch twice; the second one used to stay raw.
	it("fills a placeholder everywhere it appears", () => {
		const text = translate("autopilot.branch.defaultWarning", { branch: "main-x" });
		expect(text).not.toContain("{branch}");
		expect(text.match(/main-x/g)).toHaveLength(2);
	});

	it("inserts a value literally: no replacement patterns, no second pass", () => {
		expect(translate("workspaceDirs.added", { path: "$&{path}" })).toContain("$&{path}");
		expect(translate("workspaceDirs.added", { path: "a$'b" })).toContain("a$'b");
	});

	it("leaves a placeholder without a value alone", () => {
		expect(translate("workspaceDirs.added", {})).toContain("{path}");
	});
});
