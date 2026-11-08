/**
 * Test-only fake omp: a bun script launched exactly the way the app launches
 * the real CLI (`OmpRuntime.bin` + spawnArgs). POSIX runs the script through
 * its `env bun` shebang. Windows has no shebangs, so the fake is an `omp.cmd`
 * shim calling bun — the cmd.exe path npm's Windows install takes. The shim
 * sits in a directory with a space so the quoting of both the shim path and
 * its argv is exercised, as under `C:\Users\First Last\...`.
 */
import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Write `source` (TypeScript run by bun) as a fake omp under `dir`; returns the bin path. */
export async function writeFakeOmp(dir: string, source: string): Promise<string> {
	const binDir = join(dir, "fake omp");
	await mkdir(binDir, { recursive: true });
	const script = join(binDir, "omp.ts");
	if (process.platform !== "win32") {
		await writeFile(script, `#!/usr/bin/env bun\n${source}`);
		await chmod(script, 0o755);
		return script;
	}
	await writeFile(script, source);
	const shim = join(binDir, "omp.cmd");
	await writeFile(shim, `@bun "${script}" %*\r\n`);
	return shim;
}

/**
 * Fake omp source that answers every RPC command with success, as stock does: a tab reads `ready` only once its omp
 * answered (sidecar.ts `#answered`), so a fake that never answers stays `starting`. Keeps stdin open.
 */
export const ANSWERS_COMMANDS =
	'import("node:readline").then(({ createInterface }) => createInterface({ input: process.stdin }).on("line", line => { const command = JSON.parse(line); process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: {} }) + "\\n"); }));';

/**
 * Windows refuses to delete a directory that is still some process's cwd or
 * holds an open file; a just-killed child may need a moment to release it.
 */
export const RM_TEMP = { recursive: true, force: true, maxRetries: 20, retryDelay: 50 } as const;

/**
 * Whether the omp that ran as `pid` still runs, `exitedAt` (ms since the epoch) being a moment it had already ended by:
 * its own last log line, or the clock right after its stop was reported. A pid that answers `kill(pid, 0)` is not
 * enough on Windows, which hands a freed pid to the next process created, within a second (the suite creates many a
 * second: cmd.exe, conhost.exe, bun.exe of the tests beside it; the sidecar stop test failed on CI with the omp's pid
 * held by another test's conhost.exe or bun.exe, gone 0.2 to 0.4 s later). A process that started before `exitedAt`
 * is the omp; one that started after it is a stranger on a reused pid.
 */
export async function ompRuns(pid: number, exitedAt: number): Promise<boolean> {
	const alive = () => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	if (!alive()) return false;
	if (process.platform !== "win32") return true;
	const { stdout } = await run(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`Get-Process -Id ${pid} -ErrorAction SilentlyContinue | ForEach-Object { ([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds() }`,
		],
		{ windowsHide: true },
	).catch(() => ({ stdout: "" }));
	const startedAt = Number.parseInt(stdout.trim(), 10);
	// No start time: the process ended meanwhile (gone), or its start time cannot be read (still counts as running).
	return Number.isNaN(startedAt) ? alive() : startedAt < exitedAt;
}
