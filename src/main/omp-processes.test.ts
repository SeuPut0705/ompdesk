/**
 * The omps this app runs (omp-processes.ts), through the real core (native/ompdesk/crates/core/src/omp): a quit leaves
 * none of them behind, a stuck one included, and a launch stops the ones an earlier instance left running before any
 * tab starts, never another program's process.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OmpProcesses } from "./omp-processes";
import { OMP_SPAWN_GROUP, STOP_GRACE_MS } from "./omp-stop";
import { DIES_WITH_TEST, RM_TEMP } from "./test-fake-omp";

/** Whether `pid` names a live process (one owned by another user answers `EPERM`). */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

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
	await fs.writeFile(
		script,
		`${DIES_WITH_TEST}\nprocess.on("SIGTERM", () => {});\nconsole.log("up");\nsetInterval(() => {}, 1000);\n`,
	);
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
		const child = spawn(process.execPath, ["-e", `${DIES_WITH_TEST} setInterval(() => {}, 1000)`], {
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

		// Programs that took a pid the file names a few hundred ms from when the omp started (earlier and later): their
		// creation time differs, so they are another program's and leave the file. An entry whose creation time was never
		// recorded cannot be identified: it is not stopped, and stays in the file for the next launch.
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
		await vi.waitFor(async () => expect(await read(file)).toEqual({ omps: [{ pid: unrecorded.pid }] }));
	}, 60_000);

	it("a launch stops the omp behind a shim that died with the app", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-processes-shim-win-"));
		dirs.push(dir);
		const file = path.join(dir, "omp-pids.json");
		const bridge = path.join(dir, "gui-bridge");
		// omp as it is installed: a shim (`omp.cmd`) that runs the real one, whose command line names the bridge.
		const script = path.join(dir, "omp.mjs");
		const pidFile = path.join(dir, "omp.pid");
		await fs.writeFile(
			script,
			`${DIES_WITH_TEST}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[3], String(process.pid));\nsetInterval(() => {}, 1000);\n`,
		);
		const shimFile = path.join(dir, "omp.cmd");
		await fs.writeFile(
			shimFile,
			`@"${process.execPath}" "${script}" "${path.join(bridge, "index.ts")}" "${pidFile}"\r\n`,
		);
		const shim = spawn("cmd.exe", ["/d", "/c", shimFile], { stdio: "ignore", windowsHide: true });
		if (shim.pid !== undefined) started.push(shim.pid);
		const omp = await vi.waitFor(async () => Number(await fs.readFile(pidFile, "utf8")), { timeout: 15_000 });
		started.push(omp);

		// The earlier instance recorded the shim, the only process it knows.
		new OmpProcesses(file, bridge).track(shim);
		const recorded = await vi.waitFor(async () => {
			const entry = (await read(file)).omps.find(entry => entry.pid === shim.pid);
			expect(entry?.started).toBeGreaterThan(0);
			return entry;
		});
		// The app dies. Windows ends the shim with it and the real omp runs on; the dead app tells nobody of the exit,
		// so the file still names the shim.
		shim.kill();
		await once(shim, "exit");
		await vi.waitFor(async () => expect(await read(file)).toEqual({ omps: [] }));
		expect(pidAlive(omp)).toBe(true);
		await fs.writeFile(file, JSON.stringify({ omps: [recorded] }));

		// The real omp ignores the end of its stdin, so it is ended only after the stop's grace (`STOP_GRACE_MS`, which
		// runs in the core: no fake clock reaches it).
		const reaped = await new OmpProcesses(file, bridge).reapLeftovers();

		expect(reaped).toEqual([omp]);
		await vi.waitFor(() => expect(pidAlive(omp)).toBe(false), { timeout: 10_000 });
		expect(await read(file)).toEqual({ omps: [] });
	}, 60_000);

	it("a quit's stop leaves no omp running: one that ends with its stdin and one that does not", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-processes-quit-win-"));
		dirs.push(dir);
		const file = path.join(dir, "omp-pids.json");
		const omp = async (body: string) => {
			const child = spawn(process.execPath, ["-e", `${DIES_WITH_TEST} ${body} console.log("up");`], {
				stdio: ["pipe", "pipe", "ignore"],
				windowsHide: true,
			});
			if (child.pid !== undefined) started.push(child.pid);
			await once(child.stdout, "data");
			return child;
		};
		const listening = await omp(`process.stdin.resume(); process.stdin.on("end", () => process.exit(0));`);
		const deaf = await omp("setInterval(() => {}, 1000);");
		const processes = new OmpProcesses(file, path.join(dir, "gui-bridge"));
		processes.track(listening);
		processes.track(deaf);
		await vi.waitFor(async () =>
			expect((await read(file)).omps.map(entry => entry.pid)).toEqual([listening.pid, deaf.pid]),
		);
		const exits = [listening, deaf].map(child => once(child, "exit"));

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const done = processes.stopAll();
		await exits[0];
		vi.advanceTimersByTime(STOP_GRACE_MS);
		vi.useRealTimers();
		await done;
		await exits[1];

		expect(listening.exitCode).toBe(0);
		expect([listening, deaf].map(child => pidAlive(child.pid ?? 0))).toEqual([false, false]);
		await vi.waitFor(async () => expect(await read(file)).toEqual({ omps: [] }));
	}, 60_000);
});

describe("OmpProcesses and the file", () => {
	const readFile = async (file: string) =>
		JSON.parse(await fs.readFile(file, "utf8")) as { omps: { pid: number; started?: number }[] };
	const tempFile = async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-processes-file-"));
		dirs.push(dir);
		return path.join(dir, "omp-pids.json");
	};
	const idleOmp = () => {
		const child = spawn(process.execPath, ["-e", `${DIES_WITH_TEST} setInterval(() => {}, 1000)`], {
			stdio: "ignore",
			windowsHide: true,
		});
		if (child.pid !== undefined) started.push(child.pid);
		return child;
	};

	it("each spawn and each exit rewrites the file the next launch reads", async () => {
		const file = await tempFile();
		const processes = new OmpProcesses(file, "/nowhere/gui-bridge");
		const [staying, leaving] = [idleOmp(), idleOmp()];

		processes.track(staying);
		processes.track(leaving);

		await vi.waitFor(async () =>
			expect((await readFile(file)).omps.map(entry => entry.pid)).toEqual([staying.pid, leaving.pid]),
		);
		// Windows tells a leftover by its creation time, read at the spawn; elsewhere its command line does.
		for (const entry of (await readFile(file)).omps)
			expect(entry.started === undefined).toBe(process.platform !== "win32");

		leaving.kill("SIGKILL");

		await vi.waitFor(async () => expect((await readFile(file)).omps.map(entry => entry.pid)).toEqual([staying.pid]));
	}, 20_000);

	it("a reap the core does not answer stops nothing, leaves the file for the next launch and is logged", async () => {
		const file = await tempFile();
		const pid = idleOmp().pid ?? 0;
		const before = JSON.stringify({ omps: [{ pid, started: 7_000 }] });
		await fs.writeFile(file, before);
		const log = vi.fn();

		// No command line can be told from another by an empty gui-bridge path: the core refuses the request.
		const reaped = await new OmpProcesses(file, "", { log }).reapLeftovers();

		expect(reaped).toEqual([]);
		expect(pidAlive(pid)).toBe(true);
		expect(await fs.readFile(file, "utf8")).toBe(before);
		expect(log).toHaveBeenCalledTimes(1);
		expect(log.mock.calls[0]?.[1]).toMatchObject({ level: "warn", phase: "reap", cause: "error" });
	});
});
