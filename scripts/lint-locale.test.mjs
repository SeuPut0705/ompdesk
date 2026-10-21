import { describe, expect, it } from "vitest";
import { findLocaleViolations } from "./lint-locale.mjs";

describe("lint-locale", () => {
	it("flags a number or date formatted in the OS locale", () => {
		const source = `
const a = count.toLocaleString();
const b = new Date(at).toLocaleDateString();
const c = date.toLocaleTimeString(undefined, { hour: "2-digit" });
`;
		expect(findLocaleViolations(source).map(hit => hit.line)).toEqual([2, 3, 4]);
	});

	it("accepts the UI locale and a locale-ok escape", () => {
		const source = `
const a = count.toLocaleString(uiLocale());
const b = date.toLocaleDateString(uiLocale(), { month: "short" });
const c = value.toLocaleString("en-US"); // a fixed spelling on purpose
const d = count.toLocaleString(); // locale-ok: logged, never shown
`;
		expect(findLocaleViolations(source)).toEqual([]);
	});
});
