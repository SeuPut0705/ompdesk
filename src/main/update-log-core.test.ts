import { describe, expect, it } from "vitest";
import {
	lastSwapEntry,
	type PendingInstall,
	parsePendingInstall,
	previousInstallDetails,
	scrubUpdateText,
} from "./update-log-core";

const pending: PendingInstall = {
	from: "0.38.0",
	to: "0.39.0",
	mode: "relaunch",
	trigger: "auto",
	at: Date.UTC(2026, 9, 19, 5, 0, 0),
};

describe("scrubUpdateText", () => {
	it("drops the token and every URL, signed ones included", () => {
		const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
		const text = `request to https://user:pw@objects.example.com/a/b?X-Amz-Signature=abc123&token=${token} failed with ${token}`;
		const out = scrubUpdateText(text, [token]);
		expect(out).toBe("request to <url> failed with <token>");
		expect(out).not.toContain("example.com");
		expect(out).not.toContain("Signature");
	});

	it("redacts what the diagnostics redactor knows and cuts a long reason", () => {
		expect(scrubUpdateText("Bearer abcdefghijklmnop rejected")).not.toContain("abcdefghijklmnop");
		expect(scrubUpdateText("x".repeat(1000))).toHaveLength(301);
	});

	it("keeps an ordinary reason and its version numbers", () => {
		expect(scrubUpdateText("Download failed (416) for 0.39.0")).toBe("Download failed (416) for 0.39.0");
	});
});

describe("parsePendingInstall", () => {
	it("round-trips a marker and rejects anything else", () => {
		expect(parsePendingInstall(JSON.stringify(pending))).toEqual(pending);
		expect(parsePendingInstall("not json")).toBeUndefined();
		expect(parsePendingInstall(JSON.stringify({ ...pending, mode: "squirrel" }))).toBeUndefined();
		expect(parsePendingInstall(JSON.stringify({ ...pending, at: "yesterday" }))).toBeUndefined();
		expect(parsePendingInstall("null")).toBeUndefined();
	});
});

describe("lastSwapEntry", () => {
	const entry = (date: string, outcome: string) =>
		`swap ${date}: /u/updates/0.39.0/OMPdesk.app -> /Applications/OMPdesk.app\n${outcome}\n`;

	it("reads only the last entry's outcome", () => {
		const log =
			entry("Sun Oct 18 10:00:00 KST 2026", "install failed; previous app restored") +
			entry("Mon Oct 19 14:03:22 KST 2026", "installed");
		expect(lastSwapEntry(log)).toEqual({ at: "Mon Oct 19 14:03:22 KST 2026", outcome: "installed" });
	});

	it("reports a failed swap's closing line, past tool noise", () => {
		const log = `swap Mon Oct 19 14:03:22 KST 2026: /s -> /d\nditto: some noise\ninstall failed; previous app restored\n`;
		expect(lastSwapEntry(log)?.outcome).toBe("install failed; previous app restored");
	});

	it("says unknown when the entry never closed, and nothing for an empty log", () => {
		expect(lastSwapEntry("swap Mon Oct 19 14:03:22 KST 2026: /s -> /d\n")).toEqual({
			at: "Mon Oct 19 14:03:22 KST 2026",
			outcome: "unknown",
		});
		expect(lastSwapEntry("")).toBeUndefined();
	});
});

describe("previousInstallDetails", () => {
	it("is installed when the new version runs", () => {
		const swap = { at: "Mon Oct 19 14:03:22 KST 2026", outcome: "installed" };
		expect(previousInstallDetails(pending, "0.39.0", swap)).toEqual({
			event: "result",
			outcome: "installed",
			previous: "0.38.0",
			expected: "0.39.0",
			current: "0.39.0",
			mode: "relaunch",
			trigger: "auto",
			launchedAt: "2026-10-19T05:00:00.000Z",
			swapAt: "Mon Oct 19 14:03:22 KST 2026",
			swapOutcome: "installed",
		});
	});

	it("is rolled back when the old version still runs, with the swap log's reason", () => {
		const details = previousInstallDetails(pending, "0.38.0", {
			at: "Mon Oct 19 14:03:22 KST 2026",
			outcome: "install failed; previous app restored",
		});
		expect(details).toMatchObject({ outcome: "rolled back", swapOutcome: "install failed; previous app restored" });
	});

	it("is changed for a third version, and carries no swap fields without a swap log (Windows)", () => {
		const details = previousInstallDetails({ ...pending, mode: "nsis" }, "0.40.0");
		expect(details).toMatchObject({ outcome: "changed", mode: "nsis" });
		expect(details).not.toHaveProperty("swapOutcome");
	});
});
