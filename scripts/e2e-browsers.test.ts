import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { browsersNeeded, missingBrowsersNotice } from "./e2e-browsers";

describe("which Playwright browsers a spec launches", () => {
	it("reads the browser types a spec imports from @playwright/test, across lines and beside other names", () => {
		expect(
			browsersNeeded(
				`import {\n\ttype Browser,\n\tchromium,\n\tdevices,\n\texpect,\n\ttest,\n\twebkit,\n} from "@playwright/test";`,
			),
		).toEqual(["chromium", "webkit"]);
		expect(browsersNeeded(`import { chromium, _electron as electron, expect } from "@playwright/test";`)).toEqual([
			"chromium",
		]);
	});

	it("needs none for an Electron-only spec, a type-only import or a name from another module", () => {
		expect(browsersNeeded(`import { _electron as electron, expect, test } from "@playwright/test";`)).toEqual([]);
		expect(browsersNeeded(`import { type Browser, expect } from "@playwright/test";`)).toEqual([]);
		expect(browsersNeeded(`import { webkit } from "./harness";\nconst chromium = 1;`)).toEqual([]);
	});

	it("finds the phone specs that launch WebKit and Chromium", () => {
		expect(browsersNeeded(readFileSync("e2e/mobile-enter.e2e.ts", "utf8"))).toEqual(["chromium", "webkit"]);
		expect(browsersNeeded(readFileSync("e2e/smoke.e2e.ts", "utf8"))).toEqual([]);
	});
});

describe("the missing-browser notice", () => {
	const browsersOf = new Map([
		["e2e/mobile-enter.e2e.ts", browsersNeeded(readFileSync("e2e/mobile-enter.e2e.ts", "utf8"))],
		["e2e/smoke.e2e.ts", []],
	] as const);
	const specs = [...browsersOf.keys()];

	it("names the missing browsers, only the specs that import them, and the install command", () => {
		expect(missingBrowsersNotice(specs, browsersOf, ["webkit"])).toBe(
			"Playwright's webkit is not installed: e2e/mobile-enter.e2e.ts cannot start it unless skipped; run `bunx playwright install webkit`",
		);
		expect(missingBrowsersNotice(specs, browsersOf, ["chromium", "webkit"])).toContain(
			"chromium and webkit are not installed",
		);
	});

	it("says nothing when every browser starts", () => {
		expect(missingBrowsersNotice(specs, browsersOf, [])).toBeNull();
	});
});
