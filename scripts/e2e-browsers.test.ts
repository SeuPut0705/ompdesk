import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { browsersNeeded } from "./e2e-browsers";

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
