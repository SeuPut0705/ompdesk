/**
 * Main's wiring of idle release (idle-release.ts): one reading every `SAMPLE_MS` (the OS's level and each session's
 * process tree, read by the core process through memory-sampler.ts), and the release of a quiet tab's omp while
 * memory is short.
 */
import { IdleRelease } from "./idle-release";
import { listProcesses, type MemoryReading, readMemory, treeBytes } from "./memory-sampler";

/** How often memory is read. */
export const SAMPLE_MS = 5_000;

export interface MemoryTab {
	tabId: string;
	pid?: number;
	label: string;
	/** Nothing in it is live (`idle-release.ts`): it may give its omp back while memory is short. */
	quiet?: boolean;
}

export interface MemoryWatchDeps {
	/** This computer's own tabs and the ones it runs for paired devices, with their omp's pid. */
	tabs(): MemoryTab[];
	log(message: string, details: Record<string, unknown>): void;
	/** A fixed reading for tests (`OMP_GUI_TEST_MEMORY`, a JSON file read each sample); undefined reads the OS. */
	testReading?: () => MemoryReading | null;
	sampleMs?: number;
	/** Give a quiet tab's omp back (`SidecarPool.releaseIdle`, which checks again first). */
	release?(tabId: string): void;
	/** How long a tab stays quiet before it may be released (`IDLE_RELEASE_QUIET_MS`). */
	releaseQuietMs?: number;
}

/** Bytes as GB with one decimal, for log lines. */
function gb(bytes: number): number {
	return Math.round((bytes / 1024 ** 3) * 10) / 10;
}

/** Start reading memory; a quiet tab is released while it is short. */
export function startMemoryWatch(deps: MemoryWatchDeps): void {
	let sampling = false;
	const idle = new IdleRelease(deps.releaseQuietMs);
	const sample = async (): Promise<void> => {
		if (sampling) return;
		sampling = true;
		try {
			const [reading, rows] = await Promise.all([
				deps.testReading ? Promise.resolve(deps.testReading()) : readMemory(),
				listProcesses(),
			]);
			const release = deps.release;
			if (rows && release) {
				const tabs = deps.tabs();
				const tabId = idle.pick(
					Date.now(),
					reading,
					tabs.map(tab => ({ tabId: tab.tabId, pid: tab.pid, quiet: tab.quiet === true })),
					rows,
				);
				const tab = tabs.find(entry => entry.tabId === tabId);
				if (tab) {
					deps.log("memory release", {
						tab: tab.tabId,
						label: tab.label,
						...(tab.pid !== undefined ? { gb: gb(treeBytes(rows, tab.pid)) } : {}),
						...(reading ? { availableGb: gb(reading.availableBytes), pressure: reading.pressure } : {}),
					});
					release(tab.tabId);
				}
			}
		} finally {
			sampling = false;
		}
	};
	void sample();
	setInterval(() => void sample(), deps.sampleMs ?? SAMPLE_MS).unref();
}
