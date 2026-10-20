/**
 * How much of the disk a folder or file takes: allocated blocks where the platform reports them (`du -sk`, so a
 * sparse file counts what it holds and a copy-on-write clone counts in full), else the sum of file sizes.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { DiskPartId, DiskUsage } from "../../shared/disk-care";
import { agentDir } from "../agent-paths";

async function walkBytes(target: string): Promise<number> {
	const stat = await fs.lstat(target).catch(() => null);
	if (!stat) return 0;
	if (!stat.isDirectory()) return stat.size;
	let total = 0;
	for (const name of await fs.readdir(target).catch(() => [] as string[]))
		total += await walkBytes(path.join(target, name));
	return total;
}

/** Bytes `target` takes (0 when it is missing). */
export async function diskBytes(target: string): Promise<number> {
	if (!(await fs.lstat(target).catch(() => null))) return 0;
	if (process.platform === "win32") return walkBytes(target);
	const { promise, resolve } = Promise.withResolvers<number>();
	// `du` exits non-zero when it could not read part of the tree; what it printed still counts.
	execFile("du", ["-sk", target], { timeout: 10 * 60_000 }, (_error, stdout) => {
		const kib = Number(String(stdout).split(/\s/)[0]);
		resolve(Number.isFinite(kib) ? kib * 1024 : 0);
	});
	return promise;
}

/** Bun's install cache: `BUN_INSTALL_CACHE_DIR`, else `<BUN_INSTALL or ~/.bun>/install/cache`. */
export function bunCacheDir(env: NodeJS.ProcessEnv = process.env): string {
	return (
		env.BUN_INSTALL_CACHE_DIR || path.join(env.BUN_INSTALL || path.join(os.homedir(), ".bun"), "install", "cache")
	);
}

/** Where OMPdesk's disk goes; each part is measured on its own (the worktree root is no part of the others). */
export function diskParts(options: { userData: string; worktreeRoot: string }): Record<DiskPartId, string[]> {
	const omp = path.join(os.homedir(), ".omp");
	return {
		worktrees: [options.worktreeRoot],
		sessions: [path.join(agentDir(), "sessions")],
		ompLogs: [path.join(omp, "logs")],
		stats: [path.join(omp, "stats.db"), path.join(omp, "stats.db-wal"), path.join(omp, "stats.db-shm")],
		appData: [options.userData],
		bunCache: [bunCacheDir()],
	};
}

export async function measureDiskUsage(options: { userData: string; worktreeRoot: string }): Promise<DiskUsage> {
	const parts = await Promise.all(
		Object.entries(diskParts(options)).map(async ([id, paths]) => {
			let bytes = 0;
			for (const target of paths) bytes += await diskBytes(target);
			return { id: id as DiskPartId, bytes, path: paths[0] ?? "" };
		}),
	);
	return { measuredAt: Date.now(), total: parts.reduce((sum, part) => sum + part.bytes, 0), parts };
}
