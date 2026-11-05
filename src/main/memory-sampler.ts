/**
 * This computer's memory: the OS's own pressure level and available memory,
 * and the footprint of each session's process tree (its omp and everything it started: tsc, vitest, Playwright's
 * browsers, a cargo build).
 *
 * macOS: one `sysctl` for `kern.memorystatus_vm_pressure_level` (1 normal, 2 warn, 4 critical: the level
 * `memory_pressure` and the kernel's jetsam act on), `kern.memorystatus_level` (the "memory free percentage"
 * `memory_pressure` prints) and `hw.memsize`; trees from one `ps -axo pid=,ppid=,rss=`. Windows has no pressure
 * level: `process.getSystemMemoryInfo()` (GlobalMemoryStatusEx's available physical memory) and the share of RAM
 * still available decide it, and the trees come from the stock helper (Toolhelp32 parents and each process's
 * working set through bun's FFI, `stock-helper/process-memory.ts`; no WMI).
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

export type MemoryPressure = "normal" | "warn" | "critical";

export interface MemoryReading {
	totalBytes: number;
	/** What the OS can hand out without paging: macOS `kern.memorystatus_level` % of RAM, Windows' available physical memory. */
	availableBytes: number;
	pressure: MemoryPressure;
}

const run = promisify(execFile);

export interface ProcessRow {
	pid: number;
	ppid: number;
	/** Resident bytes. */
	bytes: number;
}

/** macOS `kern.memorystatus_vm_pressure_level` values. */
const MAC_PRESSURE: Record<string, MemoryPressure> = { "1": "normal", "2": "warn", "4": "critical" };

/** `sysctl -n kern.memorystatus_vm_pressure_level kern.memorystatus_level hw.memsize`, one value a line. */
export function parseMacSysctl(text: string): MemoryReading | null {
	const [level, freePercent, memsize] = text.trim().split(/\s+/);
	const totalBytes = Number(memsize);
	const percent = Number(freePercent);
	if (!(totalBytes > 0) || !Number.isFinite(percent)) return null;
	return {
		totalBytes,
		availableBytes: Math.round((totalBytes * Math.min(100, Math.max(0, percent))) / 100),
		pressure: MAC_PRESSURE[level ?? ""] ?? "normal",
	};
}

/**
 * Windows: under 5 % of RAM available is critical and under 10 % a warning. Windows signals its own low-memory
 * resource notification near those shares on a 16 GB machine, and the incident's WindowServer stall began when
 * macOS had paged through its last tenth.
 */
export function windowsReading(totalKb: number, freeKb: number): MemoryReading | null {
	if (!(totalKb > 0)) return null;
	const share = freeKb / totalKb;
	return {
		totalBytes: totalKb * 1024,
		availableBytes: freeKb * 1024,
		pressure: share < 0.05 ? "critical" : share < 0.1 ? "warn" : "normal",
	};
}

/** `ps -axo pid=,ppid=,rss=` (rss in KB). */
export function parsePs(text: string): ProcessRow[] {
	const rows: ProcessRow[] = [];
	for (const line of text.split("\n")) {
		const [pid, ppid, rss] = line.trim().split(/\s+/).map(Number);
		if (pid === undefined || ppid === undefined || rss === undefined) continue;
		if (Number.isInteger(pid) && Number.isInteger(ppid) && Number.isFinite(rss))
			rows.push({ pid, ppid, bytes: rss * 1024 });
	}
	return rows;
}

/** Bytes of `root` and every process below it, from one listing; 0 when `root` is not in it. */
export function treeBytes(rows: readonly ProcessRow[], root: number): number {
	const children = new Map<number, ProcessRow[]>();
	const byPid = new Map<number, ProcessRow>();
	for (const row of rows) {
		byPid.set(row.pid, row);
		const siblings = children.get(row.ppid);
		if (siblings) siblings.push(row);
		else children.set(row.ppid, [row]);
	}
	const top = byPid.get(root);
	if (!top) return 0;
	let sum = 0;
	const seen = new Set<number>();
	const stack = [top];
	for (let row = stack.pop(); row; row = stack.pop()) {
		if (seen.has(row.pid)) continue;
		seen.add(row.pid);
		sum += row.bytes;
		for (const child of children.get(row.pid) ?? []) if (child.pid !== row.pid) stack.push(child);
	}
	return sum;
}

export interface SamplerDeps {
	platform: NodeJS.Platform;
	/** Electron's `process.getSystemMemoryInfo()` (KB). */
	systemMemory(): { total: number; free: number };
	/** Every process with its parent and resident bytes, on Windows (the stock helper's FFI listing). */
	windowsProcesses(): Promise<ProcessRow[]>;
}

/** How long one reading or one process listing may take; past it the sample counts as failed (never as safe). */
export const SAMPLE_TIMEOUT_MS = 4_000;

/** `work`'s answer, or null when it fails or has not answered within `ms`. */
export function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
	const { promise, resolve } = Promise.withResolvers<T | null>();
	const timer = setTimeout(() => resolve(null), ms);
	work.then(resolve, () => resolve(null));
	return promise.finally(() => clearTimeout(timer));
}

/** The OS's reading now; null when it cannot be read in time. */
export function readMemory(deps: SamplerDeps): Promise<MemoryReading | null> {
	const read = async (): Promise<MemoryReading | null> => {
		if (deps.platform === "darwin") {
			const { stdout } = await run(
				"/usr/sbin/sysctl",
				["-n", "kern.memorystatus_vm_pressure_level", "kern.memorystatus_level", "hw.memsize"],
				{ timeout: SAMPLE_TIMEOUT_MS },
			);
			return parseMacSysctl(stdout);
		}
		const { total, free } = deps.systemMemory();
		return windowsReading(total, free);
	};
	return within(read(), SAMPLE_TIMEOUT_MS);
}

/** Every process with its parent and resident bytes; null when the listing failed or took too long. */
export function listProcesses(deps: SamplerDeps): Promise<ProcessRow[] | null> {
	const list = async (): Promise<ProcessRow[]> => {
		if (deps.platform === "win32") return deps.windowsProcesses();
		const { stdout } = await run("/bin/ps", ["-axo", "pid=,ppid=,rss="], {
			timeout: SAMPLE_TIMEOUT_MS,
			maxBuffer: 8 * 1024 * 1024,
		});
		return parsePs(stdout);
	};
	return within(list(), SAMPLE_TIMEOUT_MS);
}

/** Unpackaged test launches: the reading a test writes to `file` (`{"totalGb":16,"availableGb":3,"pressure":"warn"}`). */
export function testMemoryReading(file: string): MemoryReading | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		const totalGb = "totalGb" in parsed ? Number(parsed.totalGb) : Number.NaN;
		const availableGb = "availableGb" in parsed ? Number(parsed.availableGb) : Number.NaN;
		const pressure = "pressure" in parsed ? parsed.pressure : "normal";
		if (!(totalGb > 0) || !(availableGb >= 0)) return null;
		return {
			totalBytes: totalGb * 1024 ** 3,
			availableBytes: availableGb * 1024 ** 3,
			pressure: pressure === "warn" || pressure === "critical" ? pressure : "normal",
		};
	} catch {
		return null;
	}
}
