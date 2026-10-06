/**
 * Test-only fake omp: a bun script launched exactly the way the app launches
 * the real CLI (`OmpRuntime.bin` + ompSpawnArgs). POSIX runs the script through
 * its `env bun` shebang. Windows has no shebangs, so the fake is an `omp.cmd`
 * shim calling bun — the cmd.exe path npm's Windows install takes. The shim
 * sits in a directory with a space so the quoting of both the shim path and
 * its argv is exercised, as under `C:\Users\First Last\...`.
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
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
 * Windows refuses to delete a directory that is still some process's cwd or
 * holds an open file; a just-killed child may need a moment to release it.
 */
export const RM_TEMP = { recursive: true, force: true, maxRetries: 20, retryDelay: 50 } as const;
