import { describe, expect, it } from "vitest";
import { shellEngine, systemVersion } from "./system-version";

describe("systemVersion", () => {
	it("is the kernel's own version on Windows", () => {
		expect(systemVersion("win32", "10.0.22631")).toBe("10.0.22631");
	});

	it("maps a Darwin kernel back to the macOS version", () => {
		expect(systemVersion("darwin", "24.5.0")).toBe("15.5.0");
		expect(systemVersion("darwin", "23.6.0")).toBe("14.6.0");
		expect(systemVersion("darwin", "20.6.0")).toBe("11.6.0");
		expect(systemVersion("darwin", "25.0.1")).toBe("26.0.1");
	});

	it("keeps a kernel string it cannot map", () => {
		expect(systemVersion("darwin", "19.6.0")).toBe("19.6.0");
		expect(systemVersion("linux", "6.8.0")).toBe("6.8.0");
	});
});

describe("shellEngine", () => {
	it("names the shell and CEF, with ? for what the shell did not report", () => {
		expect(shellEngine({ shell: "0.1.0", cef: "156.0.26" })).toBe("ompdesk-shell 0.1.0, CEF 156.0.26");
		expect(shellEngine({})).toBe("ompdesk-shell ?, CEF ?");
	});
});
