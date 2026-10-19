import { describe, expect, it } from "vitest";
import { bundleFileName } from "./diagnostic-bundle";

const DAY = new Date(2026, 9, 5, 23, 59);

describe("bundleFileName", () => {
	it("is omp-dump, the session title and the local date, and -anon marks the anonymized variant", () => {
		expect(bundleFileName("Fix login", DAY, false)).toBe("omp-dump-Fix-login-2026-10-05.zip");
		expect(bundleFileName("Fix login", DAY, true)).toBe("omp-dump-Fix-login-2026-10-05-anon.zip");
	});

	it("leaves the title out when there is none, and keeps a Korean one", () => {
		expect(bundleFileName(undefined, DAY, false)).toBe("omp-dump-2026-10-05.zip");
		expect(bundleFileName("  ///  ", DAY, true)).toBe("omp-dump-2026-10-05-anon.zip");
		expect(bundleFileName("로그인 버그 고치기", DAY, false)).toBe("omp-dump-로그인-버그-고치기-2026-10-05.zip");
	});

	it("drops what a file name cannot hold and cuts a long title", () => {
		expect(bundleFileName('a/b\\c:d*e?"f<g>h|i', DAY, false)).toBe("omp-dump-a-b-c-d-e-f-g-h-i-2026-10-05.zip");
		const long = bundleFileName("x".repeat(200), DAY, false);
		expect(long).toBe(`omp-dump-${"x".repeat(40)}-2026-10-05.zip`);
	});
});
