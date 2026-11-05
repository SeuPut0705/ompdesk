/**
 * Main's wiring of memory admission (memory-admission.ts): one reading every `SAMPLE_MS` (the OS's level and each
 * session's process tree, memory-sampler.ts), the waits shown on the tabs that wait (this computer's own, and the
 * ones it runs for paired devices), the learned peaks kept across launches, the owner's notice when pressure turns
 * critical, and the bookkeeping a tab's end calls for (a finished turn reserves nothing; a closed tab leaves the line).
 */
import { readFileSync } from "node:fs";
import type { IpcMemoryWait } from "../shared/ipc-types";
import { writeFileAtomicDeferred } from "./atomic-file";
import { IdleRelease } from "./idle-release";
import {
	MemoryAdmission as Admission,
	gb,
	type MemoryAdmission,
	type MemoryReading,
	type SessionFootprint,
} from "./memory-admission";
import { listProcesses, readMemory, type SamplerDeps, treeBytes } from "./memory-sampler";

/** How often memory is read: a burst of starts is judged within this of each start's growth. */
export const SAMPLE_MS = 5_000;

export interface MemoryTab {
	tabId: string;
	pid?: number;
	label: string;
	busy: boolean;
	/** Nothing in it is live (`idle-release.ts`): it may give its omp back while memory is short. */
	quiet?: boolean;
}

export interface MemoryWatchDeps {
	/** Where the learned peaks are kept. */
	peaksFile: string;
	/** This computer's own tabs and the ones it runs for paired devices, with their omp's pid. */
	tabs(): MemoryTab[];
	/** Show (or clear, `undefined`) a tab's wait wherever it is shown. */
	show(tabId: string, wait: IpcMemoryWait | undefined): void;
	log(message: string, details: Record<string, unknown>): void;
	/** The owner's notice: title and body, already in the UI language. */
	notify(title: string, body: string): void;
	text(
		key:
			| "notify.memoryCritical"
			| "notify.memoryCriticalBody"
			| "notify.memoryUnreadable"
			| "notify.memoryUnreadableBody",
		params: Record<string, string | number>,
	): string;
	sampler: SamplerDeps;
	/** A fixed reading for tests (`OMP_GUI_TEST_MEMORY`, a JSON file read each sample); undefined reads the OS. */
	testReading?: () => MemoryReading | null;
	sampleMs?: number;
	/** Give a quiet tab's omp back (`SidecarPool.releaseIdle`, which checks again first). */
	release?(tabId: string): void;
	/** How long a tab stays quiet before it may be released (`IDLE_RELEASE_QUIET_MS`). */
	releaseQuietMs?: number;
}

function readPeaks(file: string): number[] {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		return Array.isArray(parsed)
			? parsed.filter((value): value is number => typeof value === "number" && value > 0)
			: [];
	} catch {
		return [];
	}
}

/** Start reading memory and return the admission every start of agent work asks. */
export function startMemoryWatch(deps: MemoryWatchDeps): { admission: MemoryAdmission; stop(): void } {
	const shown = new Set<string>();
	let busy = new Set<string>();
	const admission: MemoryAdmission = new Admission({
		now: Date.now,
		changed: waits => {
			for (const tabId of [...shown]) {
				if (waits.has(tabId)) continue;
				shown.delete(tabId);
				deps.show(tabId, undefined);
			}
			for (const [tabId, wait] of waits) {
				shown.add(tabId);
				deps.show(tabId, wait);
			}
		},
		log: deps.log,
		critical: (reading, top) => {
			const names = top.map(entry => `${entry.label} (${gb(entry.bytes)} GB)`).join(", ");
			deps.notify(
				deps.text("notify.memoryCritical", {
					free: gb(reading.availableBytes),
					total: Math.round(reading.totalBytes / 1024 ** 3),
				}),
				deps.text("notify.memoryCriticalBody", { top: names || "-" }),
			);
		},
		unreadable: failures =>
			deps.notify(deps.text("notify.memoryUnreadable", {}), deps.text("notify.memoryUnreadableBody", { failures })),
		running: tabId => busy.has(tabId),
		peaks: readPeaks(deps.peaksFile),
		savePeaks: peaks => writeFileAtomicDeferred(deps.peaksFile, JSON.stringify(peaks)),
	});
	let sampling = false;
	const idle = new IdleRelease(deps.releaseQuietMs);
	const sample = async (): Promise<void> => {
		if (sampling) return;
		sampling = true;
		try {
			const [reading, rows] = await Promise.all([
				deps.testReading ? Promise.resolve(deps.testReading()) : readMemory(deps.sampler),
				listProcesses(deps.sampler),
			]);
			const tabs = deps.tabs();
			// A listing that failed keeps the last measured trees (null), never reads every session as empty.
			let footprints: Map<string, SessionFootprint> | null = null;
			if (rows) {
				footprints = new Map();
				for (const tab of tabs)
					if (tab.pid !== undefined)
						footprints.set(tab.tabId, { bytes: treeBytes(rows, tab.pid), label: tab.label });
			}
			const nowBusy = new Set(tabs.filter(tab => tab.busy).map(tab => tab.tabId));
			const known = new Set(tabs.map(tab => tab.tabId));
			const ended = [...busy].filter(tabId => !nowBusy.has(tabId));
			busy = nowBusy;
			for (const tabId of ended) admission.turnEnded(tabId);
			// A tab that is gone (closed here, its device's tab released) leaves the line; its start never comes.
			for (const waiting of admission.status().waiting)
				if (waiting.tabId !== undefined && !known.has(waiting.tabId)) admission.forgetTab(waiting.tabId);
			admission.sample(reading, footprints);
			const release = deps.release;
			if (rows && release) {
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
	const timer = setInterval(() => void sample(), deps.sampleMs ?? SAMPLE_MS);
	timer.unref();
	return { admission, stop: () => clearInterval(timer) };
}
