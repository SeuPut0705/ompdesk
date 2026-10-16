import { describe, expect, it } from "vitest";
import { compareVersions, isExactVersion, isNewer } from "./version";

describe("isNewer", () => {
	it("orders dotted numbers numerically, not as text", () => {
		expect(isNewer("1.10.0", "1.9.0")).toBe(true);
		expect(isNewer("1.9.0", "1.10.0")).toBe(false);
		expect(isNewer("1.0.0", "1.0.0")).toBe(false);
		expect(isNewer("v2.0.0", "1.9.9")).toBe(true);
		expect(isNewer("1.2", "1.2.0")).toBe(false);
		expect(isNewer("2024.2", "2024.1.5")).toBe(true);
	});

	it("a release outranks its own prerelease, and prereleases order by their tags", () => {
		expect(isNewer("1.0.0", "1.0.0-beta.2")).toBe(true);
		expect(isNewer("1.0.0-beta.2", "1.0.0")).toBe(false);
		expect(isNewer("1.0.0-beta.10", "1.0.0-beta.2")).toBe(true);
		expect(isNewer("1.0.0-rc.1", "1.0.0-beta.9")).toBe(true);
		expect(isNewer("1.0.0-beta", "1.0.0-beta.1")).toBe(false);
		expect(isNewer("1.0.0-beta.1", "1.0.0-beta")).toBe(true);
		expect(isNewer("1.0.1-beta.1", "1.0.0")).toBe(true);
		// A prerelease user is never moved down to the release before it.
		expect(isNewer("0.9.0", "1.0.0-beta.1")).toBe(false);
		expect(isNewer("1.0.0+build.5", "1.0.0")).toBe(false);
	});

	it("an unknown installed version is older than anything", () => {
		expect(isNewer("0.0.1", null)).toBe(true);
	});

	it("versions that cannot be ordered count as newer when they differ", () => {
		expect(isNewer("1.0rc2", "1.0rc1")).toBe(true);
		expect(isNewer("abc123", "abc123")).toBe(false);
		expect(isNewer("abc124", "abc123")).toBe(true);
		expect(isNewer(" 1.0.0 ", "1.0.0")).toBe(false);
		expect(isNewer("1.0.0", "main")).toBe(true);
	});
});

describe("compareVersions", () => {
	it("compares numerically, not lexically", () => {
		expect(compareVersions("18.10.0", "18.6.0")).toBe(1);
		expect(compareVersions("18.11.0", "18.9.0")).toBe(1);
		expect(compareVersions("19.0.0", "18.99.99")).toBe(1);
		expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
		expect(compareVersions("2.1.296", "2.1.30")).toBe(1);
		expect(compareVersions("17.99.99", "18.0.0")).toBe(-1);
		expect(compareVersions("18.8.7", "18.9.0")).toBe(-1);
		expect(compareVersions("18.6.0", "18.6.0")).toBe(0);
		expect(compareVersions("1.2", "1.2.0")).toBe(0);
	});

	it("sorts nvm's `vX.Y.Z` dirs by version", () => {
		const dirs = ["v9.11.2", "v18.17.0", "v18.9.1", "v10.1.0"];
		expect(dirs.sort((a, b) => compareVersions(a, b) ?? 0)).toEqual(["v9.11.2", "v10.1.0", "v18.9.1", "v18.17.0"]);
	});

	it("orders a prerelease below its release and ignores build metadata", () => {
		expect(compareVersions("18.9.0-canary.3", "18.9.0")).toBe(-1);
		expect(compareVersions("18.6.1-beta", "18.6.0")).toBe(1);
		expect(compareVersions("18.9.0+build.5", "18.9.0")).toBe(0);
	});

	it("is null when either side is not a dotted-number version", () => {
		expect(compareVersions("main", "1.0.0")).toBeNull();
		expect(compareVersions("1.0rc2", "1.0rc1")).toBeNull();
	});
});

describe("isExactVersion", () => {
	it("an exact version is a pin; a range or a dist-tag is not an exact one", () => {
		for (const spec of ["1.2.3", "v1.2.3", "1.2.3-beta.1", "1.2.3+b"]) expect(isExactVersion(spec), spec).toBe(true);
		for (const spec of ["^1.2.3", "~1.2.3", "1.2", "latest", ">=1.0.0", "1.x", "*"])
			expect(isExactVersion(spec), spec).toBe(false);
	});
});
