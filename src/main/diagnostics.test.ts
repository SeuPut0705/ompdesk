import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IPC_COMMANDS } from "../shared/ipc-types";
import type { SetupItemState, SetupState } from "../shared/setup";
import {
	buildDiagnosticsReport,
	DIAGNOSTICS_LOG_LINES,
	type DiagnosticsInput,
	type DiagnosticsSystem,
	readDiagnosticsLog,
	registerDiagnosticsIpc,
} from "./diagnostics";
import type { IpcRegistry } from "./web/ipc-registry";

const SYSTEM: DiagnosticsSystem = {
	appVersion: "0.35.1",
	packaged: true,
	electron: "36.4.0",
	chrome: "136.0.7103.113",
	node: "22.16.0",
	platform: "darwin",
	arch: "arm64",
	osRelease: "25.0.0",
	osVersion: "26.0.1",
	language: "ko",
};

function item(patch: Partial<SetupItemState> & Pick<SetupItemState, "id">): SetupItemState {
	return {
		required: false,
		phase: "present",
		presence: null,
		method: null,
		command: null,
		location: null,
		prompt: null,
		progress: null,
		output: "",
		failure: null,
		manualCommands: [],
		manualUrl: "",
		...patch,
	};
}

const SETUP: SetupState = {
	platform: "darwin",
	automatic: true,
	ompReady: true,
	requiredRunning: false,
	items: [
		item({
			id: "bun",
			required: true,
			presence: { kind: "present", version: "1.2.19", path: "/Users/seuput/.bun/bin/bun" },
		}),
		item({
			id: "omp",
			required: true,
			presence: { kind: "present", version: "18.11.1", path: "/Users/seuput/.bun/bin/omp" },
		}),
		item({ id: "gh", phase: "failed", presence: { kind: "missing" }, failure: { reason: "network", exitCode: 6 } }),
	],
};

const INPUT: DiagnosticsInput = {
	generatedAt: new Date("2026-10-18T05:00:00.000Z"),
	system: SYSTEM,
	setup: SETUP,
	logLines: [],
};

const tempDirs: string[] = [];
afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("buildDiagnosticsReport", () => {
	it("lists the versions, the machine setup and an empty log", () => {
		const report = buildDiagnosticsReport(INPUT);
		expect(report).toContain("OMPdesk: 0.35.1");
		expect(report).toContain("omp: 18.11.1");
		expect(report).toContain("Electron: 36.4.0, Chrome 136.0.7103.113, Node 22.16.0");
		expect(report).toContain("OS: darwin 26.0.1 (kernel 25.0.0), arm64");
		expect(report).toContain("- bun (required): present; present 1.2.19 (~/.bun/bin/bun)");
		expect(report).toContain("- gh: failed; missing; failed: network exit 6");
		expect(report).toContain("(empty)");
	});

	it("says so when setup has not started and omp is not detected", () => {
		const report = buildDiagnosticsReport({ ...INPUT, setup: null });
		expect(report).toContain("omp: not detected");
		expect(report).toContain("Machine setup: not started");
	});

	it("redacts the whole report, the setup paths and every log line", () => {
		const secret = `ghp_${"a1B2".repeat(9)}`;
		const report = buildDiagnosticsReport({
			...INPUT,
			logLines: [
				JSON.stringify({
					cwd: "/Users/seuput/proj",
					message: `login ${secret} for seuput@example.com at 100.100.1.2`,
				}),
			],
		});
		expect(report).not.toContain("seuput");
		expect(report).not.toContain(secret);
		expect(report).not.toContain("100.100.1.2");
		expect(report).toContain("<email>");
		expect(report).toContain("<tailnet-ip>");
	});

	it("cuts a very long log line", () => {
		const report = buildDiagnosticsReport({ ...INPUT, logLines: [`x ${"word ".repeat(2_000)}`] });
		expect(report).toContain("…");
		expect(report.length).toBeLessThan(4_000);
	});
});

describe("readDiagnosticsLog", () => {
	it("tops the current log up from its archive, oldest first", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-diag-"));
		tempDirs.push(dir);
		const file = path.join(dir, "gui-runtime.jsonl");
		await fs.writeFile(`${file}.1`, "old1\nold2\n");
		await fs.writeFile(file, "new1\nnew2\n");
		expect(await readDiagnosticsLog(file)).toEqual(["old1", "old2", "new1", "new2"]);
	});

	it("keeps only the newest lines of a long log", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-diag-"));
		tempDirs.push(dir);
		const file = path.join(dir, "gui-runtime.jsonl");
		const lines = Array.from({ length: DIAGNOSTICS_LOG_LINES + 20 }, (_, index) => `line-${index}`);
		await fs.writeFile(file, `${lines.join("\n")}\n`);
		const read = await readDiagnosticsLog(file);
		expect(read).toHaveLength(DIAGNOSTICS_LOG_LINES);
		expect(read.at(-1)).toBe(`line-${DIAGNOSTICS_LOG_LINES + 19}`);
		expect(read[0]).toBe("line-20");
	});

	it("folds a run of the same line (time aside) into its newest, so repeats never push real events out", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-diag-"));
		tempDirs.push(dir);
		const file = path.join(dir, "gui-runtime.jsonl");
		const check = (minute: number) =>
			JSON.stringify({
				timestamp: `2026-10-21T10:${String(minute).padStart(2, "0")}:00.000Z`,
				source: "app-update",
				message: "check",
				details: { event: "no-update" },
			});
		const event = JSON.stringify({ timestamp: "2026-10-21T09:00:00.000Z", source: "turn-resume", message: "launch" });
		const repeats = Array.from({ length: DIAGNOSTICS_LOG_LINES * 2 }, (_, index) => check(index % 60));
		await fs.writeFile(file, `${[event, ...repeats, "plain"].join("\n")}\n`);
		const read = await readDiagnosticsLog(file);
		expect(read).toEqual([
			event,
			check(199 % 60),
			`… the line above ${DIAGNOSTICS_LOG_LINES * 2} times in a row, the first at 2026-10-21T10:00:00.000Z`,
			"plain",
		]);
	});

	it("is empty when there is no log", async () => {
		expect(await readDiagnosticsLog(path.join(os.tmpdir(), "omp-gui-absent", "gui-runtime.jsonl"))).toEqual([]);
	});
});

describe("registerDiagnosticsIpc", () => {
	it("serves the report on its one channel", async () => {
		const handlers = new Map<string, (...args: never[]) => unknown>();
		const ipc: Pick<IpcRegistry, "handle"> = {
			handle: (channel, handler) => void handlers.set(channel, handler),
		};
		registerDiagnosticsIpc(ipc, {
			system: () => SYSTEM,
			setupState: () => SETUP,
			runtimeLogPath: () => path.join(os.tmpdir(), "omp-gui-absent", "gui-runtime.jsonl"),
			now: () => INPUT.generatedAt,
		});
		expect([...handlers.keys()]).toEqual([IPC_COMMANDS.DIAGNOSTICS_BUILD]);
		expect(await handlers.get(IPC_COMMANDS.DIAGNOSTICS_BUILD)?.()).toBe(buildDiagnosticsReport(INPUT));
	});
});
