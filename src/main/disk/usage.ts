/**
 * How much of the disk a folder or file takes: allocated blocks where the platform reports them (as `du -sk` counts:
 * a sparse file counts what it holds, a copy-on-write clone counts in full, a hard-linked file once per target), else
 * the sum of file sizes. Measured by `TreeSizes` (`tree-sizes.ts`).
 */
import * as os from "node:os";
import * as path from "node:path";
import type { DiskPartId, DiskUsage } from "../../shared/disk-care";
import { agentDir } from "../agent-paths";
import type { LocatedCache } from "./caches";
import { TreeSizes } from "./tree-sizes";

/** Bytes `target` takes now (0 when it is missing), read in full. */
export function diskBytes(target: string): Promise<number> {
	return new TreeSizes(null).bytes(target);
}

export interface DiskUsageOptions {
	userData: string;
	worktreeRoot: string;
	/** The tools' caches this computer has (`locateCaches`), each its own part. */
	caches: readonly LocatedCache[];
	/** Where the sessions' scratch folders are (`session-scratch.ts`); absent: none kept. */
	scratchRoot?: string;
}

/** Where OMPdesk's disk goes; each part is measured on its own (the worktree root is no part of the others). */
function diskParts(options: DiskUsageOptions): [DiskPartId, string[]][] {
	const omp = path.join(os.homedir(), ".omp");
	const parts: [DiskPartId, string[]][] = [
		["worktrees", [options.worktreeRoot]],
		["sessions", [path.join(agentDir(), "sessions")]],
		["ompLogs", [path.join(omp, "logs")]],
		["stats", [path.join(omp, "stats.db"), path.join(omp, "stats.db-wal"), path.join(omp, "stats.db-shm")]],
		["appData", [options.userData]],
	];
	if (options.scratchRoot) parts.push(["scratch", [options.scratchRoot]]);
	for (const { cache, dir } of options.caches) parts.push([cache.part, [dir]]);
	return parts;
}

/**
 * The parts whose files are written once (extracted packages, transpiled files, npm's content by hash; git and
 * installs add files, they rarely rewrite one in place): reused from the last run where their directories did not change. The others are appended to in place
 * (session journals, logs, the stats database, the app's own files), so they are read in full: they are small (21 Oct
 * 2026: this Mac's 8,208 entries in 64 ms, the Windows PC's 656 in 18 ms).
 */
const REUSED_PARTS: Partial<Record<DiskPartId, true>> = {
	worktrees: true,
	bunCache: true,
	bunTranspilerCache: true,
	npmCache: true,
};

/** Every part's bytes; `sizes` reuses an earlier run's reading of what did not change (`TreeSizes`). */
export async function measureDiskUsage(
	options: DiskUsageOptions,
	sizes: TreeSizes = new TreeSizes(null),
): Promise<DiskUsage> {
	const parts = await Promise.all(
		diskParts(options).map(async ([id, paths]) => {
			const reuse = REUSED_PARTS[id] === true;
			let bytes = 0;
			for (const target of paths) bytes += await sizes.bytes(target, { reuse });
			return { id, bytes, path: paths[0] ?? "" };
		}),
	);
	return { measuredAt: Date.now(), total: parts.reduce((sum, part) => sum + part.bytes, 0), parts };
}
