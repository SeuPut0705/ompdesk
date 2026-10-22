import { EventEmitter, once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { RM_TEMP } from "../test-fake-omp";
import type { SpawnSpec } from "./plans";
import { SetupRunner, type SupervisedChild } from "./runner";
import { isolatedLaunch, quoteWindowsArg, SUPERVISOR_STOPPED_CODE, spawnSupervised } from "./supervisor";

class FakeChild extends EventEmitter implements SupervisedChild {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly stdin = { end: vi.fn(() => this.exit(SUPERVISOR_STOPPED_CODE)) };
	exit(code: number | null): void {
		this.stdout.end();
		this.stderr.end();
		this.emit("close", code);
	}
}

const SPEC: SpawnSpec = { file: "/bin/installer", args: ["--yes"], shell: false };

function fake() {
	const children: FakeChild[] = [];
	const spawner = vi.fn((_spec: SpawnSpec, _env: NodeJS.ProcessEnv) => {
		const child = new FakeChild();
		children.push(child);
		return child;
	});
	return { runner: new SetupRunner(spawner), spawner, children };
}

async function flush(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}
describe("SetupRunner", () => {
	it("streams output and reports a clean exit as succeeded", async () => {
		const { runner, spawner, children } = fake();
		const output: string[] = [];
		const run = runner.run(SPEC, { PATH: "/bin" }, chunk => output.push(chunk));
		expect(spawner).toHaveBeenCalledWith(SPEC, { PATH: "/bin" });
		expect(runner.running).toBe(true);
		children[0]?.stdout.write("Downloading\n");
		children[0]?.stderr.write("warn\n");
		await flush();
		children[0]?.exit(0);
		await expect(run).resolves.toEqual({ kind: "succeeded" });
		expect(output.join("")).toBe("Downloading\nwarn\n");
		expect(runner.running).toBe(false);
	});

	it("reports a non-zero exit with its code and last output line, without ANSI", async () => {
		const { runner, children } = fake();
		const run = runner.run(SPEC, {}, () => {});
		children[0]?.stderr.write("\u001b[31merror:\u001b[0m could not resolve bun.sh\n\n");
		await flush();
		children[0]?.exit(6);
		await expect(run).resolves.toEqual({
			kind: "failed",
			reason: "exit",
			exitCode: 6,
			detail: "error: could not resolve bun.sh",
		});
	});

	it("reports an installer that could not start as a spawn failure", async () => {
		const { runner, children } = fake();
		const notFound = runner.run(SPEC, {}, () => {});
		children[0]?.stderr.write("spawn /bin/installer ENOENT\n");
		await flush();
		children[0]?.exit(127);
		await expect(notFound).resolves.toMatchObject({
			kind: "failed",
			reason: "spawn",
			detail: "spawn /bin/installer ENOENT",
		});
		const errored = runner.run(SPEC, {}, () => {});
		children[1]?.emit("error", new Error("EACCES"));
		await expect(errored).resolves.toMatchObject({ kind: "failed", reason: "spawn", detail: "EACCES" });
		const throwing = new SetupRunner(() => {
			throw new Error("no execPath");
		});
		await expect(throwing.run(SPEC, {}, () => {})).resolves.toMatchObject({ kind: "failed", reason: "spawn" });
	});

	it("cancels by closing the supervisor's stdin, and calls that cancelled, not failed", async () => {
		const { runner, children } = fake();
		expect(runner.cancel()).toBe(false);
		const run = runner.run(SPEC, {}, () => {});
		expect(runner.cancel()).toBe(true);
		expect(children[0]?.stdin.end).toHaveBeenCalledTimes(1);
		await expect(run).resolves.toEqual({ kind: "cancelled" });
		expect(runner.running).toBe(false);
	});

	it("ends when the supervisor exits even if a detached descendant keeps the pipes open (no close event)", async () => {
		const { runner, children } = fake();
		const output: string[] = [];
		const run = runner.run(SPEC, { PATH: "/bin" }, chunk => output.push(chunk));
		children[0]?.stdout.write("service started\n");
		await flush();
		// The supervisor exited with 0; the service host it left behind still holds stdout, so `close` never comes.
		children[0]?.emit("exit", 0);
		expect(await run).toEqual({ kind: "succeeded" });
		expect(output.join("")).toBe("service started\n");
		expect(runner.running).toBe(false);
	});

	it("reports a non-zero exit the same way when only `exit` arrives", async () => {
		const { runner, children } = fake();
		const run = runner.run(SPEC, { PATH: "/bin" }, () => {});
		children[0]?.stderr.write("boom\n");
		await flush();
		children[0]?.emit("exit", 6);
		expect(await run).toEqual({ kind: "failed", reason: "exit", exitCode: 6, detail: "boom" });
	});

	it("runs one install at a time", async () => {
		const { runner, children } = fake();
		const first = runner.run(SPEC, {}, () => {});
		await expect(runner.run(SPEC, {}, () => {})).rejects.toThrow(/already running/);
		children[0]?.exit(0);
		await first;
	});
});

/** An installer that starts a long-lived grandchild is cancelled: the grandchild must be gone, run under `env`. */
async function cancelKillsGrandchild(env: NodeJS.ProcessEnv): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "ompdesk-supervisor-"));
	try {
		const pidFile = join(dir, "grandchild.pid");
		// The installer starts a long-lived grandchild, reports it, and waits.
		const installer = [
			"const { spawn } = require('node:child_process');",
			"const fs = require('node:fs');",
			`const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });`,
			`fs.writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));`,
			"process.stdout.write('started\\n');",
			"setInterval(() => {}, 1000);",
		].join("\n");
		const runner = new SetupRunner(spawnSupervised);
		const { promise: started, resolve } = Promise.withResolvers<void>();
		const run = runner.run({ file: process.execPath, args: ["-e", installer], shell: false }, env, chunk => {
			if (chunk.includes("started")) resolve();
		});
		await started;
		const grandchild = Number(await readFile(pidFile, "utf8"));
		expect(runner.cancel()).toBe(true);
		await expect(run).resolves.toEqual({ kind: "cancelled" });
		await vi.waitFor(
			() => {
				expect(() => process.kill(grandchild, 0)).toThrow();
			},
			{ timeout: 10_000, interval: 50 },
		);
	} finally {
		await rm(dir, RM_TEMP);
	}
}

/**
 * `taskkill /T` lists the tree and then ends it, and a process started in between lives on: in the trace of a
 * scheduled run's Stop the `cmd` shim's `bun` was born 200 ms before taskkill returned, with the shim ended and the
 * `bun` not (taskkill 546 ms after the Stop, exit 0), and held the run's folder. This `taskkill` makes that gap
 * 800 ms: it lists what the installer started (the pid file stands in for its WMI query), waits, then ends that
 * list and the root. The installer starts a `ping` every 50 ms, so ~16 are born in the gap and none may outlive the
 * cancel. A node.exe under taskkill's name, told by `NODE_OPTIONS` to run this before it looks for a script. The
 * `ping`s are detached: one sharing the installer's console dies with it (and so hides the miss).
 */
async function cancelWhileTaskkillIsSlow(): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "ompdesk-supervisor-"));
	const fakeBin = join(dir, "bin");
	const started: number[] = [];
	try {
		await mkdir(fakeBin);
		await copyFile(process.execPath, join(fakeBin, "taskkill.exe"));
		const pidFile = join(dir, "children.pids");
		const slowTaskkill = join(dir, "slow-taskkill.cjs");
		await writeFile(
			slowTaskkill,
			[
				"if (require('node:path').basename(process.execPath).toLowerCase() === 'taskkill.exe') {",
				"  const fs = require('node:fs');",
				`  const listed = fs.readFileSync(${JSON.stringify(pidFile)}, 'utf8').split('\\n').filter(Boolean).map(Number);`,
				"  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);",
				"  for (const pid of [...listed, Number(process.argv[2])]) {",
				"    try { process.kill(pid); } catch {}",
				"  }",
				"  process.exit(0);",
				"}",
			].join("\n"),
		);
		const installer = [
			"const { spawn } = require('node:child_process');",
			"const fs = require('node:fs');",
			"setInterval(() => {",
			"  const child = spawn('ping', ['-n', '100', '127.0.0.1'], { stdio: 'ignore', detached: true });",
			`  fs.appendFileSync(${JSON.stringify(pidFile)}, child.pid + '\\n');`,
			"}, 50);",
		].join("\n");
		const listed = async () =>
			(await readFile(pidFile, "utf8").catch(() => "")).split("\n").filter(Boolean).map(Number);
		const runner = new SetupRunner(spawnSupervised);
		const run = runner.run(
			{ file: process.execPath, args: ["-e", installer], shell: false },
			{
				...process.env,
				PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
				NODE_OPTIONS: `--require=${JSON.stringify(slowTaskkill.replaceAll("\\", "/"))}`,
			},
			() => {},
		);
		await vi.waitFor(async () => expect((await listed()).length).toBeGreaterThan(5), {
			timeout: 30_000,
			interval: 50,
		});
		expect(runner.cancel()).toBe(true);
		await expect(run).resolves.toEqual({ kind: "cancelled" });
		const alive = async () => {
			started.splice(0, started.length, ...(await listed()));
			return started.filter(pid => {
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					return false;
				}
			});
		};
		await vi.waitFor(async () => expect(await alive()).toEqual([]), { timeout: 15_000, interval: 100 });
	} finally {
		for (const pid of started) {
			try {
				process.kill(pid);
			} catch {}
		}
		await rm(dir, RM_TEMP);
	}
}

describe("supervisor", () => {
	it("passes output and the exit code through", async () => {
		const runner = new SetupRunner(spawnSupervised);
		const output: string[] = [];
		const spec: SpawnSpec = {
			file: process.execPath,
			args: ["-e", "process.stdout.write('hello\\n'); process.exit(3)"],
			shell: false,
		};
		await expect(runner.run(spec, { ...process.env }, chunk => output.push(chunk))).resolves.toMatchObject({
			kind: "failed",
			exitCode: 3,
			detail: "hello",
		});
		expect(output.join("")).toContain("hello");
	});

	// The supervisor gives PowerShell's tree sweep up to 20 s before it falls back to taskkill (supervisor.ts
	// `sweepTree`), and the first sweep of a run starts a cold PowerShell: on a loaded windows-latest runner that
	// took the whole 20 s of vitest's default (ci run 39764722935, 20039 ms), which the supervisor survives by design.
	it("kills the installer's whole tree when its stdin closes", { timeout: 45_000 }, async () => {
		await cancelKillsGrandchild({ ...process.env });
	});

	it.skipIf(process.platform !== "win32")(
		"kills a child started in the gap between taskkill listing the tree and ending it",
		cancelWhileTaskkillIsSlow,
	);

	// ping.exe under another tool's name: its arguments are bad options for it, so it exits 1 and does nothing.
	const cancelWithBrokenTool = async (tool: "taskkill.exe" | "powershell.exe") => {
		const fakeBin = await mkdtemp(join(tmpdir(), "ompdesk-broken-tool-"));
		try {
			await copyFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "ping.exe"), join(fakeBin, tool));
			await cancelKillsGrandchild({ ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH}` });
		} finally {
			await rm(fakeBin, RM_TEMP);
		}
	};

	it.skipIf(process.platform !== "win32")(
		"kills the whole tree without taskkill, which finds it through WMI and kills nothing while WMI is down",
		() => cancelWithBrokenTool("taskkill.exe"),
	);

	it.skipIf(process.platform !== "win32")(
		"falls back to taskkill when PowerShell cannot walk the tree (a locked-down machine)",
		() => cancelWithBrokenTool("powershell.exe"),
	);
});

describe("isolated commands", () => {
	it("quotes Windows arguments the way the C runtime reads them back", () => {
		expect(quoteWindowsArg("plain")).toBe("plain");
		expect(quoteWindowsArg("")).toBe('""');
		expect(quoteWindowsArg("C:\\Program Files\\x.exe")).toBe('"C:\\Program Files\\x.exe"');
		expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""');
		expect(quoteWindowsArg("dir\\ with\\")).toBe('"dir\\ with\\\\"');
		expect(quoteWindowsArg('a\\"b')).toBe('"a\\\\\\"b"');
	});

	it("Windows: Bun starts the command (a .cmd shim through cmd.exe) with NUL and the log as its only handles", () => {
		const env = { SystemRoot: "C:\\Windows", PATH: "C:\\bin" };
		const options = { platform: "win32", log: "C:\\Temp\\out.log", bun: "C:\\bun\\bun.exe" } as const;
		const exe = isolatedLaunch(
			{ file: "C:\\Tools\\ai memory\\ai-memory.exe", args: ["setup", "--yes"], shell: false, isolated: true },
			env,
			options,
		);
		expect(exe.spec).toMatchObject({
			file: "C:\\bun\\bun.exe",
			shell: false,
			log: { path: "C:\\Temp\\out.log", redirect: false },
		});
		expect(exe.spec.args[0]).toBe("-e");
		expect(exe.spec.args[1]).toContain('require("bun:ffi")');
		expect(exe.env).toEqual({
			...env,
			OMPDESK_ISOLATED: JSON.stringify({
				application: "C:\\Tools\\ai memory\\ai-memory.exe",
				commandLine: '"C:\\Tools\\ai memory\\ai-memory.exe" setup --yes',
				log: "C:\\Temp\\out.log",
			}),
		});
		const shim = isolatedLaunch(
			{ file: '"C:\\fake\\ai-memory.cmd"', args: ['"setup"'], shell: true, isolated: true },
			env,
			options,
		);
		expect(JSON.parse(shim.env.OMPDESK_ISOLATED ?? "{}")).toMatchObject({
			application: "C:\\Windows\\System32\\cmd.exe",
			commandLine: 'cmd.exe /d /s /c ""C:\\fake\\ai-memory.cmd" "setup""',
		});
	});

	it("Windows without Bun cannot start an isolated command, and says so", () => {
		expect(() => isolatedLaunch(SPEC, {}, { platform: "win32", bun: null })).toThrow(/Bun was not found/);
	});

	it("POSIX: the log file stands in for the supervisor's pipes", () => {
		expect(isolatedLaunch(SPEC, { PATH: "/bin" }, { platform: "darwin", log: "/tmp/out.log" })).toEqual({
			spec: { ...SPEC, log: { path: "/tmp/out.log", redirect: true } },
			env: { PATH: "/bin" },
		});
	});

	it("a descendant that outlives the command holds none of the supervisor's pipes: close comes, with the output and argv", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ompdesk-isolated-"));
		const pidFile = join(dir, "descendant.pid");
		try {
			// Like ai-memory's `setup` starting its service host: a detached descendant with every inheritable handle,
			// still running after the command ended (and after this test's own timeout, so a held pipe fails it).
			const installer = [
				"const { spawn } = require('node:child_process');",
				"const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)'], { detached: true, stdio: 'inherit' });",
				`require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid));`,
				"descendant.unref();",
				"process.stdout.write(JSON.stringify(process.argv.slice(1)) + '\\n');",
			].join("\n");
			const argv = ["with space", 'a "quote"', "tail\\"];
			const child = spawnSupervised(
				{ file: process.execPath, args: ["-e", installer, ...argv], shell: false, isolated: true },
				{ ...process.env },
			);
			let output = "";
			child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
				output += chunk;
			});
			child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
				output += chunk;
			});
			expect(await once(child, "close"), output).toEqual([0, null]);
			expect(output).toContain(JSON.stringify(argv));
			const descendant = Number(await readFile(pidFile, "utf8"));
			expect(() => process.kill(descendant, 0)).not.toThrow();
		} finally {
			const descendant = Number(await readFile(pidFile, "utf8").catch(() => "0"));
			if (descendant) {
				try {
					process.kill(descendant);
				} catch {
					// Already gone.
				}
			}
			await rm(dir, RM_TEMP);
		}
	}, 60_000);
});
