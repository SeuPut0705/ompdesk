/**
 * This computer's memory: the OS's own pressure level and available memory,
 * and the footprint of each session's process tree (its omp and everything it started: tsc, vitest, Playwright's
 * browsers, a cargo build).
 *
 * The reads and their rules are the core process's (`native/ompdesk/crates/core/src/memory/`): macOS one `sysctl`
 * for the kernel's pressure level, its free percentage and `hw.memsize`, and one `ps` for the processes; Windows
 * `GlobalMemoryStatusEx` with the share of RAM still available, and a Toolhelp32 snapshot with each process's working
 * set. This file is their client, plus the sum over a tree that idle release takes synchronously per sample.
 */
import { readFileSync } from "node:fs";
import { core } from "./core/process";

export type MemoryPressure = "normal" | "warn" | "critical";

export interface MemoryReading {
	totalBytes: number;
	/** What the OS can hand out without paging: macOS `kern.memorystatus_level` % of RAM, Windows' available physical memory. */
	availableBytes: number;
	pressure: MemoryPressure;
}

export interface ProcessRow {
	pid: number;
	ppid: number;
	/** Resident bytes. */
	bytes: number;
	/** Image name (`conhost.exe`), Windows only: `ps` names none. */
	name?: string;
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

/** How long one reading or one process listing may take; past it the sample counts as failed (never as safe). */
export const SAMPLE_TIMEOUT_MS = 4_000;

/** The core's answer to `method`, or null when it fails or has not answered within `SAMPLE_TIMEOUT_MS`. */
async function sample<T>(method: string): Promise<T | null> {
	try {
		const answer = await core().call<T>(method, { timeoutMs: SAMPLE_TIMEOUT_MS }, { timeoutMs: SAMPLE_TIMEOUT_MS });
		return answer.result;
	} catch {
		return null;
	}
}

/** The OS's reading now; null when it cannot be read in time. */
export function readMemory(): Promise<MemoryReading | null> {
	return sample<MemoryReading | null>("memory.reading");
}

/** Every process with its parent and resident bytes; null when the listing failed or took too long. */
export function listProcesses(): Promise<ProcessRow[] | null> {
	return sample<ProcessRow[]>("memory.processes");
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
