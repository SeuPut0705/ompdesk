import { describe, expect, it } from "vitest";
import { parseUpdateCheck } from "./misc";

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
