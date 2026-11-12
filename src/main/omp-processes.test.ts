/**
 * The omps this app runs (omp-processes.ts), through the real core (native/ompdesk/crates/core/src/{omp,sidecar}): a
 * quit leaves none of them behind, a stuck one included, and a launch stops the ones an earlier instance left running
 * before any tab starts, never another program's process. The tabs' omps are real lanes (`SidecarManager`), which keep
 * the file themselves: the cases that named a process to `OmpProcesses.track` (removed with the pid ledger's TypeScript
 * half) run a lane, or, for a leftover another instance spawned, tell the core's ledger what a lane tells it.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { core } from "./core/process";
import { OmpProcesses } from "./omp-processes";
import type { OmpResolution } from "./omp-runtime";
import { SidecarManager } from "./sidecar";
import { ANSWERS_COMMANDS, DIES_WITH_TEST, RM_TEMP, writeFakeOmp } from "./test-fake-omp";

/** How an omp is spawned: on POSIX in a group of its own. */
const OMP_SPAWN_GROUP = { detached: process.platform !== "win32" } as const;

const ompAt = (bin: string) => async (): Promise<OmpResolution> => ({
	ok: true,
	runtime: { bin, version: "18.6.1", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
});

/**
 * What a lane tells the core's ledger at a spawn and at an exit (`omp.track`, `omp.exited`): names `child` in `file`
 * until it exits, for a process this test started the way another instance of the app would have.
 */
function track(file: string, child: ChildProcess): void {
	const pid = child.pid;
	if (pid === undefined) return;
	const told = core()
		.call("omp.track", { file, pid })
		.catch(() => undefined);
	child.once("exit", () => {
		void told.then(() => core().call("omp.exited", { file, pid }));
	});
}

/** A fake omp (a lane's) that writes its pid to `pidFile`, reaches `ready`, answers commands and then runs `body`. */
async function laneOmp(dir: string, pidFile: string, body: string): Promise<string> {
	return writeFakeOmp(
		dir,
		`import * as fs from "node:fs";
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");
${ANSWERS_COMMANDS}
${body}
`,
	);
}

/** A tab on `bin` that keeps `file` and stops quickly (`stopGraceMs`); its omp reached `ready` when this returns. */
async function readyTab(bin: string, cwd: string, file: string): Promise<SidecarManager> {
	const sidecar = new SidecarManager({
		omp: ompAt(bin),
		cwd,
		ledgerFile: file,
		// A crash would respawn within a second: far past what a case waits for.
		tuning: { stopGraceMs: 400, killWaitMs: 2_000, restartDelaysMs: [60_000, 60_000, 60_000] },
	});
	const ready = Promise.withResolvers<void>();
	sidecar.on("status", ({ status }: { status: string }) => {
		if (status === "ready") ready.resolve();
	});
	sidecar.start();
	await ready.promise;
	return sidecar;
}

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
		const file = path.join(dir, "omp-pids.json");
		const processes = new OmpProcesses(file, "/nowhere/gui-bridge");
		const pidOf = async (name: string) => Number(await fs.readFile(path.join(dir, name), "utf8"));
		const ignoring = await readyTab(
			await laneOmp(path.join(dir, "a"), path.join(dir, "a.pid"), 'process.on("SIGTERM", () => {});'),
			dir,
			file,
		);
		const stopped = await readyTab(await laneOmp(path.join(dir, "b"), path.join(dir, "b.pid"), ""), dir, file);
		const pids = [await pidOf("a.pid"), await pidOf("b.pid")];
		started.push(...pids);
		process.kill(pids[1] ?? 0, "SIGSTOP");
		try {
			await processes.stopAll();
			// The grace ran out for both: the first ignored its SIGTERM, the second could not hear it.
			expect(pids.map(pidAlive)).toEqual([false, false]);
			// Every exit took its pid out of the file the next launch reads.
			await vi.waitFor(async () => expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ omps: [] }));
		} finally {
			ignoring.dispose();
			stopped.dispose();
		}
	}, 30_000);

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
		track(file, leftover);
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
		track(file, shim);
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
		const marker = path.join(dir, "stdin-ended");
		const listening = await readyTab(
			await laneOmp(
				path.join(dir, "a"),
				path.join(dir, "a.pid"),
				`process.stdin.on("end", () => { fs.writeFileSync(${JSON.stringify(marker)}, "end"); process.exit(0); });`,
			),
			dir,
			file,
		);
		const deaf = await readyTab(
			await laneOmp(path.join(dir, "b"), path.join(dir, "b.pid"), "setInterval(() => {}, 1000);"),
			dir,
			file,
		);
		const pids = [
			Number(await fs.readFile(path.join(dir, "a.pid"), "utf8")),
			Number(await fs.readFile(path.join(dir, "b.pid"), "utf8")),
		];
		started.push(...pids);
		await vi.waitFor(
			async () => expect((await read(file)).omps.map(entry => entry.pid)).toEqual([listening.pid, deaf.pid]),
			{ timeout: 15_000 },
		);
		try {
			await new OmpProcesses(file, path.join(dir, "gui-bridge")).stopAll();

			// The stop ends the stdin first: the one that listens ended by itself, the other only after the grace.
			expect(await fs.readFile(marker, "utf8")).toBe("end");
			expect(pids.map(pidAlive)).toEqual([false, false]);
			await vi.waitFor(async () => expect(await read(file)).toEqual({ omps: [] }));
		} finally {
			listening.dispose();
			deaf.dispose();
		}
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
		const dir = path.dirname(file);
		const staying = await readyTab(await laneOmp(path.join(dir, "a"), path.join(dir, "a.pid"), ""), dir, file);
		const leaving = await readyTab(await laneOmp(path.join(dir, "b"), path.join(dir, "b.pid"), ""), dir, file);
		const pids = [
			Number(await fs.readFile(path.join(dir, "a.pid"), "utf8")),
			Number(await fs.readFile(path.join(dir, "b.pid"), "utf8")),
		];
		started.push(...pids);
		try {
			await vi.waitFor(
				async () => expect((await readFile(file)).omps.map(entry => entry.pid)).toEqual([staying.pid, leaving.pid]),
				{ timeout: 15_000 },
			);
			// Windows tells a leftover by its creation time, read at the spawn; elsewhere its command line does.
			for (const entry of (await readFile(file)).omps)
				expect(entry.started === undefined).toBe(process.platform !== "win32");

			process.kill(pids[1] ?? 0, "SIGKILL");

			await vi.waitFor(
				async () => expect((await readFile(file)).omps.map(entry => entry.pid)).toEqual([staying.pid]),
				{ timeout: 15_000 },
			);
		} finally {
			staying.dispose();
			leaving.dispose();
		}
	}, 30_000);

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
