import { describe, expect, it } from "vitest";
import { parseDoctorChecks, parseUpdateCheck } from "./misc";

describe("parseDoctorChecks", () => {
	it("reads stock omp plugin doctor --json rows and drops rows of another shape", () => {
		const stdout = JSON.stringify([
			{ name: "plugins_directory", status: "warning", message: "Not created yet" },
			{ name: "plugin:foo", status: "ok", message: "v1.2.0 - Foo tools", fixed: false },
			{ name: "orphan:bar", status: "error" },
			{ name: "odd", status: "unknown", message: "?" },
			"noise",
		]);
		expect(parseDoctorChecks(stdout)).toEqual([
			{ name: "plugins_directory", status: "warning", message: "Not created yet" },
			{ name: "plugin:foo", status: "ok", message: "v1.2.0 - Foo tools" },
			{ name: "orphan:bar", status: "error", message: "" },
		]);
	});

	it("returns null for output that is not a JSON array", () => {
		expect(parseDoctorChecks("Plugin doctor\n✓ ok")).toBeNull();
		expect(parseDoctorChecks('{"checks":[]}')).toBeNull();
	});
});

describe("parseUpdateCheck", () => {
	it("reads the installed version when already up to date", () => {
		expect(parseUpdateCheck("Current version: 18.6.1\n✔ Already up to date\n")).toEqual({
			currentVersion: "18.6.1",
			latestVersion: "18.6.1",
		});
	});

	it("reads the newer release on a pending update", () => {
		expect(
			parseUpdateCheck(
				"Current version: 18.6.1\r\nCurrent channel: canary\r\nNew version available: 18.7.0-canary.3\r\n",
			),
		).toEqual({ currentVersion: "18.6.1", latestVersion: "18.7.0-canary.3" });
	});

	it("rejects output it cannot account for", () => {
		expect(parseUpdateCheck("Failed to check for updates: offline")).toBeNull();
		expect(parseUpdateCheck("Current version: 18.6.1\n")).toBeNull();
	});
});
