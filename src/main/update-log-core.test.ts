import { describe, expect, it } from "vitest";
import {
	lastSwapEntry,
	type PendingInstall,
	parsePendingInstall,
	parseStartFailure,
	previousInstallDetails,
	RELAUNCH_PRESENCE_MS,
	relaunchPresence,
	START_MARK_FILE,
	scrubUpdateText,
	startFailureOf,
	startMarkJson,
	windowPresenceOf,
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

describe("relaunch presence", () => {
	const win = (visible: boolean, minimized = false, focused = false) => ({ visible, minimized, focused });

	it("reads how the windows sat when an install began", () => {
		expect(windowPresenceOf([win(false), win(false)])).toBe("hidden");
		expect(windowPresenceOf([win(true, true), win(false)])).toBe("minimized");
		expect(windowPresenceOf([win(true), win(true, true)])).toBe("behind");
		// In front of the person (a click on Restart & install) or no window at all: the relaunch shows as always.
		expect(windowPresenceOf([win(true, false, true)])).toBeUndefined();
		expect(windowPresenceOf([])).toBeUndefined();
	});

	it("keeps it through the marker and applies it only to the relaunch the install made", () => {
		const hidden = { ...pending, presence: "hidden" as const };
		expect(parsePendingInstall(JSON.stringify(hidden))).toEqual(hidden);
		expect(parsePendingInstall(JSON.stringify({ ...pending, presence: "maximized" }))).toEqual(pending);
		expect(relaunchPresence(hidden, pending.at + 20_000)).toBe("hidden");
		expect(relaunchPresence(hidden, pending.at + RELAUNCH_PRESENCE_MS + 1)).toBeUndefined();
		expect(relaunchPresence(pending, pending.at + 20_000)).toBeUndefined();
		expect(relaunchPresence(undefined, pending.at)).toBeUndefined();
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

	it("reads the new shell launcher's own entry, restore failure with its reason included", () => {
		const entry = (last: string) =>
			`swap Tue Nov 17 10:00:00 KST 2026: start check /a/New.app -> /a/Old.app\n${last}\n`;
		for (const last of ["started", "start failed; the swap restores", "start failed; previous app restored"]) {
			expect(lastSwapEntry(entry(last))?.outcome).toBe(last);
		}
		expect(lastSwapEntry(entry("start failed; restore failed: no .previous"))?.outcome).toBe(
			"start failed; restore failed: no .previous",
		);
		const failed = { at: "t", outcome: "start failed; restore failed: no .previous" };
		expect(startFailureOf(pending, "0.38.0", failed, 5)?.version).toBe("0.39.0");
	});

	it("takes the last outcome line: installed, then how the new app's start ended", () => {
		const header = "swap Mon Oct 19 14:03:22 KST 2026: /s -> /d\ninstalled\nwaiting for the new app to start\n";
		for (const last of ["started", "start failed; previous app restored", "start failed; previous app lost"]) {
			expect(lastSwapEntry(`${header}${last}\n`)?.outcome).toBe(last);
		}
		expect(lastSwapEntry(header)?.outcome).toBe("installed");
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

describe("the start mark", () => {
	it("is compact JSON naming the version, which the swap helper matches as a fixed string", () => {
		expect(START_MARK_FILE).toBe("app-started.json");
		const json = startMarkJson("0.128.0", 4242, 1_760_000_000_000);
		expect(json).toBe('{"version":"0.128.0","pid":4242,"at":1760000000000}');
		expect(json).toContain('"version":"0.128.0"');
	});
});

describe("a start that failed", () => {
	const failed = { at: "Mon Oct 19 14:03:22 KST 2026", outcome: "start failed; previous app restored" };

	it("is remembered for the version the install should have produced, when an older one is running", () => {
		expect(startFailureOf(pending, "0.38.0", failed, 5)).toEqual({ version: "0.39.0", count: 1, at: 5 });
		expect(startFailureOf(pending, "0.37.0", { ...failed, outcome: "start failed; previous app lost" }, 5)).toEqual({
			version: "0.39.0",
			count: 1,
			at: 5,
		});
	});

	it("counts the failed starts of one version, and starts over for another", () => {
		const earlier = { version: "0.39.0", count: 1, at: 1 };
		expect(startFailureOf(pending, "0.38.0", failed, 5, earlier)).toEqual({ version: "0.39.0", count: 2, at: 5 });
		expect(startFailureOf(pending, "0.38.0", failed, 5, { ...earlier, version: "0.38.5" })?.count).toBe(1);
	});

	it("is not, for a good install, another kind of failure, a log that says nothing or an unknown target", () => {
		expect(startFailureOf(pending, "0.39.0", failed, 5)).toBeUndefined();
		expect(
			startFailureOf(pending, "0.38.0", { ...failed, outcome: "install failed; previous app restored" }, 5),
		).toBeUndefined();
		expect(startFailureOf(pending, "0.38.0", { ...failed, outcome: "started" }, 5)).toBeUndefined();
		expect(startFailureOf(pending, "0.38.0", undefined, 5)).toBeUndefined();
		expect(startFailureOf({ ...pending, to: "unknown" }, "0.38.0", failed, 5)).toBeUndefined();
	});

	it("reads back what it wrote, and nothing from anything else", () => {
		expect(parseStartFailure('{"version":"0.39.0","count":2,"at":5}')).toEqual({
			version: "0.39.0",
			count: 2,
			at: 5,
		});
		expect(parseStartFailure('{"version":"0.39.0","at":5}')).toEqual({ version: "0.39.0", count: 1, at: 5 });
		expect(parseStartFailure('{"version":"0.39.0"}')).toBeUndefined();
		expect(parseStartFailure("not json")).toBeUndefined();
		expect(parseStartFailure("null")).toBeUndefined();
	});
});
