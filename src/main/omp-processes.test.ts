/**
 * The omps this app runs (omp-processes.ts): a quit leaves none of them behind, a stuck one included, and a launch stops
 * the ones an earlier instance left running before any tab starts, never another program's process.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OmpProcesses, windowsStartTimes } from "./omp-processes";
import { OMP_SPAWN_GROUP, pidAlive, STOP_GRACE_MS } from "./omp-stop";
import { RM_TEMP } from "./test-fake-omp";

const dirs: string[] = [];
const started: number[] = [];

afterEach(async () => {
	vi.useRealTimers();
	for (const pid of started.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
	for (const dir of dirs.splice(0)) await fs.rm(dir, RM_TEMP);
});

/** A process that ignores SIGTERM, started like an omp (its own process group); `argv` shows in its command line. */
async function stubborn(argv: string[], options: { detached: boolean } = OMP_SPAWN_GROUP): Promise<ChildProcess> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-processes-"));
	dirs.push(dir);
	const script = path.join(dir, "omp.ts");
	await fs.writeFile(script, 'process.on("SIGTERM", () => {});\nconsole.log("up");\nsetInterval(() => {}, 1000);\n');
	const child = spawn("bun", [script, ...argv], { stdio: ["pipe", "pipe", "ignore"], ...options });
	if (child.pid !== undefined) started.push(child.pid);
	const up = Promise.withResolvers<void>();
	child.stdout?.once("data", () => up.resolve());
	await up.promise;
	return child;
}

describe.skipIf(process.platform === "win32")("OmpProcesses", () => {
	it("a quit's stop leaves no omp running: one that ignores SIGTERM and one that is stopped", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-processes-file-"));
		dirs.push(dir);
		const processes = new OmpProcesses(path.join(dir, "omp-pids.json"), "/nowhere/gui-bridge");
		const ignoring = await stubborn([]);
		const stopped = await stubborn([]);
		processes.track(ignoring);
		processes.track(stopped);
		process.kill(stopped.pid ?? 0, "SIGSTOP");
		const exits = [ignoring, stopped].map(child => {
			const exit = Promise.withResolvers<void>();
			child.once("exit", () => exit.resolve());
			return exit.promise;
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const done = processes.stopAll();
		vi.advanceTimersByTime(STOP_GRACE_MS);
		vi.useRealTimers();
		await done;
		await Promise.all(exits);
		expect([ignoring.signalCode, stopped.signalCode]).toEqual(["SIGKILL", "SIGKILL"]);
		// Every exit took its pid out of the file the next launch reads.
		await vi.waitFor(async () =>
			expect(JSON.parse(await fs.readFile(path.join(dir, "omp-pids.json"), "utf8"))).toEqual({ omps: [] }),
		);
	});

	it("a launch stops the omps an earlier instance left running, and leaves another program's pid alone", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-processes-reap-"));
		dirs.push(dir);
		const bridgeDir = path.join(dir, "gui-bridge");
		// Detached and not tracked by anyone: what a crashed app leaves behind, stuck (stopped) as on 8 Nov 2026.
		const leftover = await stubborn(["-e", path.join(bridgeDir, "index.ts")], { detached: true });
		const other = await stubborn(["--not-an-omp"], { detached: true });
		const leftoverPid = leftover.pid ?? 0;
		const otherPid = other.pid ?? 0;
		leftover.unref();
		other.unref();
		process.kill(leftoverPid, "SIGSTOP");
		const file = path.join(dir, "omp-pids.json");
		await fs.writeFile(file, JSON.stringify({ omps: [leftoverPid, otherPid, 999_999_999].map(pid => ({ pid })) }));

		const reaped = await new OmpProcesses(file, bridgeDir).reapLeftovers();

		expect(reaped).toEqual([leftoverPid]);
		await vi.waitFor(() => expect(pidAlive(leftoverPid)).toBe(false));
		expect(pidAlive(otherPid)).toBe(true);
		await vi.waitFor(async () => expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ omps: [] }));
	}, 20_000);
});

describe.runIf(process.platform === "win32")("OmpProcesses on Windows", () => {
	const idle = () => {
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: "ignore",
			windowsHide: true,
		});
		if (child.pid !== undefined) started.push(child.pid);
		child.unref();
		return child;
	};
	const read = async (file: string) =>
		JSON.parse(await fs.readFile(file, "utf8")) as { omps: { pid: number; started?: number }[] };

	it("a launch stops a leftover the file names with its creation time, and only that one", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-processes-reap-win-"));
		dirs.push(dir);
		const file = path.join(dir, "omp-pids.json");
		const bridge = path.join(dir, "gui-bridge");
		const leftover = idle();
		const pid = leftover.pid ?? 0;
		const strangerAhead = idle();
		const strangerBehind = idle();
		const unrecorded = idle();

		// The earlier instance: tracks the omp, which records its creation time in the file after the spawn.
		const earlier = new OmpProcesses(file, bridge);
		earlier.track(leftover);
		let recorded = 0;
		await vi.waitFor(
			async () => {
				recorded = (await read(file)).omps.find(entry => entry.pid === pid)?.started ?? 0;
				expect(recorded).toBeGreaterThan(0);
			},
			{ timeout: 15_000 },
		);

		// Programs that took a pid the file names a few hundred ms from when the omp started (earlier and later), and an
		// entry whose creation time was never recorded: none is this app's omp.
		await fs.writeFile(
			file,
			JSON.stringify({
				omps: [
					{ pid, started: recorded },
					{ pid: strangerAhead.pid, started: recorded + 300 },
					{ pid: strangerBehind.pid, started: recorded - 300 },
					{ pid: unrecorded.pid },
					{ pid: 999_999_999, started: recorded },
				],
			}),
		);

		const reaped = await new OmpProcesses(file, bridge).reapLeftovers();

		expect(reaped).toEqual([pid]);
		await vi.waitFor(() => expect(pidAlive(pid)).toBe(false), { timeout: 10_000 });
		for (const stranger of [strangerAhead, strangerBehind, unrecorded])
			expect(pidAlive(stranger.pid ?? 0)).toBe(true);
		await vi.waitFor(async () => expect(await read(file)).toEqual({ omps: [] }));
	}, 60_000);
});

/** A lookup that fails the way `execFile` does when PowerShell misses its bound (`killed`), or any other way. */
const timedOut = () => Object.assign(new Error("Command failed: powershell.exe (timed out)"), { killed: true });

/** The lookup answers one scripted step per call (an error rejects, a map resolves); a call past the script fails the test. */
function scripted(...steps: (Error | Map<number, number>)[]) {
	return vi.fn(async (_pids: number[]): Promise<Map<number, number>> => {
		const step = steps.shift();
		if (step === undefined) throw new Error("unexpected lookup");
		if (step instanceof Error) throw step;
		return step;
	});
}

/** An omp the test controls: `exit()` is the process ending, as the `exit` event reports it. */
function fakeOmp(pid: number) {
	const child = Object.assign(new EventEmitter(), {
		pid,
		exitCode: null as number | null,
		signalCode: null as NodeJS.Signals | null,
	});
	return {
		child: child as unknown as ChildProcess,
		exit() {
			child.exitCode = 1;
			child.emit("exit", 1, null);
		},
	};
}

/** The creation-time lookup is faked, so these run on every platform with no PowerShell timing in them. */
describe("OmpProcesses when the creation-time lookup fails", () => {
	const readFile = async (file: string) =>
		JSON.parse(await fs.readFile(file, "utf8")) as { omps: { pid: number; started?: number }[] };
	const tempFile = async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-processes-lookup-"));
		dirs.push(dir);
		return path.join(dir, "omp-pids.json");
	};
	const idleOmp = () => {
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: "ignore",
			windowsHide: true,
		});
		if (child.pid !== undefined) started.push(child.pid);
		child.unref();
		return child;
	};

	it("an omp whose first lookup timed out is identified by the next one, and the miss is logged", async () => {
		const file = await tempFile();
		const startTimes = scripted(timedOut(), new Map([[4242, 5_000]]));
		const log = vi.fn();
		const processes = new OmpProcesses(file, "/nowhere", { platform: "win32", startTimes, log, retryDelaysMs: [0] });

		processes.track(fakeOmp(4242).child);
		await processes.identified();

		expect(startTimes).toHaveBeenCalledTimes(2);
		await vi.waitFor(async () => expect(await readFile(file)).toEqual({ omps: [{ pid: 4242, started: 5_000 }] }));
		expect(log).toHaveBeenCalledTimes(1);
		expect(log.mock.calls[0]?.[1]).toMatchObject({ cause: "timeout", pids: "4242" });
		expect(log.mock.calls[0]?.[1]).toHaveProperty("durationMs");
	});

	it("an omp that exited before the retry is never identified: its pid may be another program's by now", async () => {
		const file = await tempFile();
		const omp = fakeOmp(4242);
		const startTimes = vi.fn(async (_pids: number[]): Promise<Map<number, number>> => {
			omp.exit();
			throw timedOut();
		});
		const processes = new OmpProcesses(file, "/nowhere", {
			platform: "win32",
			startTimes,
			log: vi.fn(),
			retryDelaysMs: [0, 0],
		});

		processes.track(omp.child);
		await processes.identified();

		expect(startTimes).toHaveBeenCalledTimes(1);
		await vi.waitFor(async () => expect(await readFile(file)).toEqual({ omps: [] }));
	});

	it("an omp no lookup can read is tried a bounded number of times, then left without a creation time", async () => {
		const file = await tempFile();
		const startTimes = scripted(timedOut(), new Error("spawn powershell.exe ENOENT"), new Map());
		const log = vi.fn();
		const processes = new OmpProcesses(file, "/nowhere", {
			platform: "win32",
			startTimes,
			log,
			retryDelaysMs: [0, 0],
		});

		processes.track(fakeOmp(4242).child);
		await processes.identified();

		expect(startTimes).toHaveBeenCalledTimes(3);
		await vi.waitFor(async () => expect(await readFile(file)).toEqual({ omps: [{ pid: 4242 }] }));
		expect(log.mock.calls.map(call => call[1]?.cause)).toEqual(["timeout", "error", "gave-up"]);
	});

	it("a launch whose leftover lookup failed stops nothing and keeps the leftover in the file for the next launch", async () => {
		const file = await tempFile();
		const leftover = idleOmp();
		const pid = leftover.pid ?? 0;
		await fs.writeFile(file, JSON.stringify({ omps: [{ pid, started: 7_000 }] }));
		const log = vi.fn();

		const failed = await new OmpProcesses(file, "/nowhere", {
			platform: "win32",
			startTimes: scripted(timedOut()),
			log,
		}).reapLeftovers();

		expect(failed).toEqual([]);
		expect(pidAlive(pid)).toBe(true);
		expect(await readFile(file)).toEqual({ omps: [{ pid, started: 7_000 }] });
		expect(log.mock.calls[0]?.[1]).toMatchObject({ cause: "timeout", pids: String(pid) });

		const reaped = await new OmpProcesses(file, "/nowhere", {
			platform: "win32",
			startTimes: scripted(new Map([[pid, 7_000]])),
		}).reapLeftovers();

		expect(reaped).toEqual([pid]);
		await vi.waitFor(() => expect(pidAlive(pid)).toBe(false));
		await vi.waitFor(async () => expect(await readFile(file)).toEqual({ omps: [] }));
	}, 20_000);
});

describe("windowsStartTimes", () => {
	it("reads each running pid's creation time, and a pid that is gone is simply absent", async () => {
		const runCommand = vi.fn(async (_file: string, _args: string[]) => ({ stdout: "4242 1700000000123\r\n" }));

		const times = await windowsStartTimes([4242, 999_999_999], runCommand);

		expect(times).toEqual(new Map([[4242, 1_700_000_000_123]]));
		expect(runCommand.mock.calls[0]?.[1].at(-1)).toContain("exit 0");
	});

	it.each([
		["a PowerShell error exit with no output", Object.assign(new Error("exit 1"), { code: 1, stdout: "" })],
		["a timeout", Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM", stdout: "" })],
		["a launch that failed", Object.assign(new Error("spawn powershell.exe ENOENT"), { code: "ENOENT" })],
	])("%s rejects instead of reading as no such process", async (_name, error) => {
		await expect(
			windowsStartTimes([4242], async () => {
				throw error;
			}),
		).rejects.toBe(error);
	});
});
