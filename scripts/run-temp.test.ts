import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processAlive } from "../src/main/process-alive";
import { RUN_TEMP_ENV, runOwner, runTempParent, sweepStaleRunTemps } from "./run-temp";

const MODULE = pathToFileURL(path.join(import.meta.dirname, "run-temp.ts")).href;

describe("a test run's temp folder", () => {
	let parent: string;
	beforeEach(() => {
		parent = fs.mkdtempSync(path.join(os.tmpdir(), "run-temp-parent-"));
	});
	afterEach(() => fs.rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

	/** A runner of its own: a bun process whose temp folder is `parent`, claiming its run folder and running `body`. */
	const runner = (body: string, inherited: NodeJS.ProcessEnv = {}) => {
		const env = { ...process.env, TEMP: parent, TMP: parent, TMPDIR: parent, ...inherited };
		if (!inherited[RUN_TEMP_ENV]) delete env[RUN_TEMP_ENV];
		const code = `import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path";
import { spawn } from "node:child_process";
import { claimRunTemp } from ${JSON.stringify(MODULE)};
const dir = claimRunTemp();
${body}`;
		const result = spawnSync("bun", ["-e", code], { env, encoding: "utf8", windowsHide: true });
		const report = result.stdout.split("\n").find(line => line.startsWith("{"));
		if (!report) throw new Error(`the runner reported nothing: ${result.stdout}${result.stderr}`);
		return { stderr: result.stderr, ...(JSON.parse(report) as { dir: string; held?: number }) };
	};

	it("every worker of this run writes its temp files into the run's folder", () => {
		const dir = process.env[RUN_TEMP_ENV];
		expect(dir).toBeTruthy();
		expect(path.resolve(os.tmpdir())).toBe(path.resolve(dir as string));
		expect(processAlive(runOwner(dir as string) as number)).toBe(true);
	});

	it("a runner that exits leaves nothing: its folder goes with what tests left in it and a process still naming it", async () => {
		// The held process ends by itself within a minute, should this test fail before the runner's exit ends it.
		const { dir, held, stderr } = runner(`
fs.mkdirSync(path.join(os.tmpdir(), "profile-never-removed", "deep"), { recursive: true });
const held = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", path.join(dir, "held")], { detached: true, stdio: "ignore" });
held.unref();
console.log(JSON.stringify({ dir, held: held.pid }));`);

		expect(path.dirname(dir)).toBe(parent);
		expect(stderr).toContain("the run left 1 entries in it: 1 profile-never-removed");
		expect(fs.readdirSync(parent)).toEqual([]);
		await vi.waitFor(() => expect(processAlive(held as number)).toBe(false), { timeout: 10_000 });
	});

	it("a killed runner's folder is gone once the next runner starts", () => {
		const killed = runner(`
fs.writeFileSync(path.join(os.tmpdir(), "left.txt"), "x");
console.log(JSON.stringify({ dir }));
process.kill(process.pid, "SIGKILL");`);
		expect(fs.readdirSync(parent)).toEqual([path.basename(killed.dir)]);

		const next = runner(`console.log(JSON.stringify({ dir, held: fs.readdirSync(path.dirname(dir)).length }));`);

		expect(next.held).toBe(1);
		expect(fs.readdirSync(parent)).toEqual([]);
	});

	it("a runner started inside a run inherits the run's folder and leaves it there when it exits", () => {
		const outer = fs.mkdtempSync(path.join(parent, "ompdesk-run-1-"));

		const inner = runner(`console.log(JSON.stringify({ dir }));`, { [RUN_TEMP_ENV]: outer });

		expect(inner.dir).toBe(outer);
		expect(fs.existsSync(outer)).toBe(true);
	});

	it("the sweep clears only run folders whose runner is gone, and leaves one it cannot clear for the next run", () => {
		const entry = (name: string) => {
			fs.mkdirSync(path.join(parent, name));
			return path.join(parent, name);
		};
		const dead = entry("ompdesk-run-111-aaaaaa");
		const held = entry("ompdesk-run-333-cccccc");
		entry("ompdesk-run-222-bbbbbb");
		entry("ompdesk-run-zzz");
		entry("omp-gui-smoke-111-abc");

		const asked: string[] = [];
		const cleared = sweepStaleRunTemps(parent, {
			alive: pid => pid === 222,
			clear: dir => {
				asked.push(dir);
				if (dir === held) throw new Error("EBUSY");
			},
		});

		expect(cleared).toEqual([dead]);
		expect(asked.sort()).toEqual([dead, held]);
	});

	it("on macOS run folders leave unix sockets their room: /private/tmp, not the 48-byte per-user temp folder", () => {
		const perUser = "/var/folders/3m/p59k4qdj0f17st0gn2cmj3640000gn/T";
		expect(runTempParent(perUser, "darwin")).toBe("/private/tmp");
		expect(runTempParent(`/private${perUser}`, "darwin")).toBe("/private/tmp");
		// The control socket's short fallback (src/main/control-socket/endpoint.ts) under a run folder: 103 bytes at most.
		const socket = ["/private/tmp", "ompdesk-run-99999-AbCdEf", "ompdesk-501-0123456789ab", "control.sock"].join("/");
		expect(socket.length).toBeLessThanOrEqual(103);
		expect(runTempParent("/custom/tmp", "darwin")).toBe("/custom/tmp");
		expect(runTempParent("/tmp", "linux")).toBe("/tmp");
		expect(runTempParent("C:\\Users\\a\\AppData\\Local\\Temp", "win32")).toBe("C:\\Users\\a\\AppData\\Local\\Temp");
	});
});
