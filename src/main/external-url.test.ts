import { describe, expect, it } from "vitest";
import { isOpenableExternalUrl } from "./external-url";

describe("isOpenableExternalUrl", () => {
	it("opens web pages and mail drafts", () => {
		expect(isOpenableExternalUrl("https://example.com/a?b=1")).toBe(true);
		expect(isOpenableExternalUrl("http://localhost:3000")).toBe(true);
		expect(isOpenableExternalUrl("mailto:dev@example.com")).toBe(true);
		expect(isOpenableExternalUrl("MAILTO:dev@example.com?subject=Hi%20there")).toBe(true);
	});

	it("refuses every other scheme and malformed mail links", () => {
		for (const url of [
			"file:///etc/passwd",
			"javascript:alert(1)",
			"local://plan.md",
			"vscode://open",
			"mailto:",
			"mailto:a b@example.com",
			"mailto:a@example.com\nbcc:x",
			42,
			undefined,
		]) {
			expect(isOpenableExternalUrl(url)).toBe(false);
		}
	});
});
