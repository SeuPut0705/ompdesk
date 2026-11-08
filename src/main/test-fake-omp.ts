/**
 * Test-only fake omp: a bun script launched exactly the way the app launches
 * the real CLI (`OmpRuntime.bin` + spawnArgs). POSIX runs the script through
 * its `env bun` shebang. Windows has no shebangs, so the fake is an `omp.cmd`
 * shim calling bun — the cmd.exe path npm's Windows install takes. The shim
 * sits in a directory with a space so the quoting of both the shim path and
 * its argv is exercised, as under `C:\Users\First Last\...`.
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";

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
 * Fake omp source that opens a loopback listener (`holder`, its port in `holder.port`) before anything else, for
 * `ompHoldsPort`. The kernel closes it when the process ends, never earlier or later.
 */
export const HOLDS_PORT = 'const holder = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });';

/**
 * Whether the fake omp that opened `port` (`HOLDS_PORT`) still runs. A pid cannot say: `process.kill(pid, 0)` also
 * answers for any process Windows later gives the freed pid, and the suite creates many a second (cmd.exe, conhost.exe,
 * bun.exe of the tests beside it; the sidecar stop test failed on CI with the omp's pid held by another process, gone
 * 0.2 to 0.4 s later). The listener belongs to the omp alone, is there from before its stop, and closes with its
 * process, so a connect that succeeds means the omp is still alive at that moment, with no lookup to outlast it.
 */
export function ompHoldsPort(port: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = connect({ host: "127.0.0.1", port });
	socket.once("connect", () => {
		socket.destroy();
		resolve(true);
	});
	socket.once("error", () => resolve(false));
	return promise;
}
