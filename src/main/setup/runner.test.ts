import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

	it("kills the installer's whole tree when its stdin closes", async () => {
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
			const run = runner.run(
				{ file: process.execPath, args: ["-e", installer], shell: false },
				{ ...process.env },
				chunk => {
					if (chunk.includes("started")) resolve();
				},
			);
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
	});
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

	it("Windows: PowerShell starts the command (a .cmd shim through cmd.exe) with NUL and the log as its only handles", () => {
		const env = { SystemRoot: "C:\\Windows", PATH: "C:\\bin" };
		const exe = isolatedLaunch(
			{ file: "C:\\Tools\\ai memory\\ai-memory.exe", args: ["setup", "--yes"], shell: false, isolated: true },
			env,
			"win32",
			"C:\\Temp\\out.log",
		);
		expect(exe.spec).toMatchObject({
			file: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
			shell: false,
			log: { path: "C:\\Temp\\out.log", redirect: false },
		});
		expect(exe.spec.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
		expect(exe.env).toEqual({
			...env,
			OMPDESK_ISOLATED_APP: "C:\\Tools\\ai memory\\ai-memory.exe",
			OMPDESK_ISOLATED_COMMAND_LINE: '"C:\\Tools\\ai memory\\ai-memory.exe" setup --yes',
			OMPDESK_ISOLATED_LOG: "C:\\Temp\\out.log",
		});
		const shim = isolatedLaunch(
			{ file: '"C:\\fake\\ai-memory.cmd"', args: ['"setup"'], shell: true, isolated: true },
			env,
			"win32",
			"C:\\Temp\\out.log",
		);
		expect(shim.env).toMatchObject({
			OMPDESK_ISOLATED_APP: "C:\\Windows\\System32\\cmd.exe",
			OMPDESK_ISOLATED_COMMAND_LINE: 'cmd.exe /d /s /c ""C:\\fake\\ai-memory.cmd" "setup""',
		});
	});

	it("POSIX: the log file stands in for the supervisor's pipes", () => {
		expect(isolatedLaunch(SPEC, { PATH: "/bin" }, "darwin", "/tmp/out.log")).toEqual({
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
