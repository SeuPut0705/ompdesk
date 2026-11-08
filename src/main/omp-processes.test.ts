/**
 * The omps this app runs (omp-processes.ts): a quit leaves none of them behind, a stuck one included, and a launch stops
 * the ones an earlier instance left running before any tab starts, never another program's process.
 */
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OmpProcesses } from "./omp-processes";
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
		const at = Date.now();
		await fs.writeFile(
			file,
			JSON.stringify({ omps: [leftoverPid, otherPid, 999_999_999].map(pid => ({ pid, at })) }),
		);

		const reaped = await new OmpProcesses(file, bridgeDir).reapLeftovers();

		expect(reaped).toEqual([leftoverPid]);
		await vi.waitFor(() => expect(pidAlive(leftoverPid)).toBe(false));
		expect(pidAlive(otherPid)).toBe(true);
		await vi.waitFor(async () => expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ omps: [] }));
	}, 20_000);
});

describe.runIf(process.platform === "win32")("OmpProcesses on Windows", () => {
	it("a launch stops a leftover whose start time matches the file, and leaves a pid whose start time does not", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-processes-reap-win-"));
		dirs.push(dir);
		const idle = () => {
			const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
				stdio: "ignore",
				windowsHide: true,
			});
			if (child.pid !== undefined) started.push(child.pid);
			child.unref();
			return { pid: child.pid ?? 0, at: Date.now() };
		};
		const leftover = idle();
		// A reused pid: the file names it, but the process running under it started a minute away from that spawn.
		const reused = idle();
		const file = path.join(dir, "omp-pids.json");
		await fs.writeFile(
			file,
			JSON.stringify({ omps: [leftover, { pid: reused.pid, at: reused.at - 60_000 }, { pid: 999_999_999, at: 0 }] }),
		);

		const reaped = await new OmpProcesses(file, path.join(dir, "gui-bridge")).reapLeftovers();

		expect(reaped).toEqual([leftover.pid]);
		await vi.waitFor(() => expect(pidAlive(leftover.pid)).toBe(false), { timeout: 10_000 });
		expect(pidAlive(reused.pid)).toBe(true);
		await vi.waitFor(async () => expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ omps: [] }));
	}, 30_000);
});
