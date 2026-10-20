/**
 * The line the next launch writes for the previous run's stall (hang-watchdog.ts). The runtime log keeps only
 * primitive details, so the steps main stalled in have to arrive as text: a stall that says only "update" left the
 * installer's start, the teardown and the quit equally to blame.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hangMarkerPath, reportPreviousHang } from "./hang-watchdog";
import { writeHangMarker } from "./hang-watchdog-core";
import { appendRuntimeLogAtPath } from "./runtime-log-core";

const mocks = vi.hoisted(() => ({ userData: { dir: "" } }));

vi.mock("electron", () => ({
	app: { getPath: () => mocks.userData.dir },
	powerMonitor: { on: () => {}, off: () => {} },
}));
vi.mock("./runtime-log", () => ({
	writeRuntimeLog: (report: unknown) =>
		appendRuntimeLogAtPath(path.join(mocks.userData.dir, "gui-runtime.jsonl"), report, {
			appVersion: "0.44.0",
			platform: "win32",
			pid: 52076,
		}),
}));

beforeAll(() => {
	mocks.userData.dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-hang-report-"));
});

afterAll(() => {
	fs.rmSync(mocks.userData.dir, { recursive: true, force: true });
});

describe("reportPreviousHang", () => {
	it("writes the phase and the steps main stalled in, oldest first, to the log", () => {
		fs.mkdirSync(path.dirname(hangMarkerPath()), { recursive: true });
		writeHangMarker(hangMarkerPath(), {
			detectedAt: Date.parse("2026-10-20T01:38:33.839Z"),
			pid: 29292,
			unresponsiveMs: 5628,
			selfRecovered: true,
			phase: "update",
			steps: ["update:quit-and-install", "quit:teardown:sidecars"],
		});

		reportPreviousHang();

		const lines = fs.readFileSync(path.join(mocks.userData.dir, "gui-runtime.jsonl"), "utf8").trim().split("\n");
		expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({
			source: "main-thread-hang",
			details: { unresponsiveMs: 5628, phase: "update", steps: "update:quit-and-install > quit:teardown:sidecars" },
		});
	});
});
