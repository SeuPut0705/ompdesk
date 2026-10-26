import { describe, expect, it } from "vitest";
import { parseDefaultBrowser, resolveAgentBrowser } from "./default-browser";

describe("default browser", () => {
	it("reads a missing or invalid pref as auto", () => {
		for (const value of [undefined, null, "", "chrome", 1, {}]) expect(parseDefaultBrowser(value)).toBe("auto");
		for (const value of ["auto", "ego", "builtin"] as const) expect(parseDefaultBrowser(value)).toBe(value);
	});

	it("points at ego-browser only while it is installed, unless the pref is built-in", () => {
		expect(resolveAgentBrowser("auto", true)).toBe("ego");
		expect(resolveAgentBrowser("auto", false)).toBe("builtin");
		expect(resolveAgentBrowser("ego", true)).toBe("ego");
		expect(resolveAgentBrowser("ego", false)).toBe("builtin");
		expect(resolveAgentBrowser("builtin", true)).toBe("builtin");
		expect(resolveAgentBrowser("builtin", false)).toBe("builtin");
	});
});
