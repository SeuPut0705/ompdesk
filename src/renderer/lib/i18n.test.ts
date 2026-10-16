import { describe, expect, it } from "vitest";
import { translate } from "./i18n";

describe("translate", () => {
	// "modelRestore.offer" names the model twice; the second one used to stay a raw {model}.
	it("fills a placeholder everywhere it appears", () => {
		const text = translate("modelRestore.offer", { model: "claude-x" });
		expect(text).not.toContain("{model}");
		expect(text.match(/claude-x/g)).toHaveLength(2);
	});

	it("inserts a value literally: no replacement patterns, no second pass", () => {
		expect(translate("workspaceDirs.added", { path: "$&{path}" })).toContain("$&{path}");
		expect(translate("workspaceDirs.added", { path: "a$'b" })).toContain("a$'b");
	});

	it("leaves a placeholder without a value alone", () => {
		expect(translate("workspaceDirs.added", {})).toContain("{path}");
	});
});
