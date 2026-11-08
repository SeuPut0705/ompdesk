import { type ChildProcess, execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { writeFileAtomicDeferred } from "./atomic-file";
import { pidAlive, stopOmp, stopOmpPid } from "./omp-stop";

const run = promisify(execFile);

/** The file in userData that names the omps this app runs. */
export const OMP_PIDS_FILE = "omp-pids.json";
/**
 * How long a quit waits for every omp's stop, all together: the longest one stop takes (ai-memory's 4 s stdin grace,
 * `STOP_GRACE_MS`, the kill's 2 s wait), under the quit watchdog's 30 s.
 */
export const QUIT_OMP_STOP_MS = 12_000;
/** How long the command-line lookup of leftover pids may take. */
const LOOKUP_TIMEOUT_MS = 5_000;

/**
 * One omp the file names: its pid and, on Windows, the creation time the OS reports for that process (ms since the
 * epoch, `started`). Windows hands a freed pid to a new process within a few hundred ms, so only the creation time
 * says the pid is still the process this app spawned. It is read just after the spawn, so `started` is absent until
 * then (and in files an older OMPdesk wrote, which named a spawn moment instead); such an entry is never stopped.
 */
interface OmpEntry {
	pid: number;
	started?: number;
}

/**
 * Every omp this app has running, and the file that names them for the next launch (`<userData>/omp-pids.json`). A
 * quit stops them all and waits (`stopAll`), and a launch first stops the ones an earlier instance left running when
 * it crashed or was forced out (`reapLeftovers`): one omp stuck on a blocked thread kept every new omp on the machine
 * stalled for three minutes after a relaunch (8 Nov 2026). Each spawn and each exit rewrites the file.
 */
export class OmpProcesses {
	readonly #file: string;
	readonly #bridgeDir: string;
	readonly #live = new Map<number, { child: ChildProcess; started?: number }>();
	/** Windows omps whose creation time is not recorded yet, by pid. */
	readonly #unidentified = new Map<number, { child: ChildProcess; started?: number }>();
	#identifying = false;
	/** Leftovers the launch has not stopped yet stay named in the file, so a crash during the reap leaves them listed. */
	#leftovers: OmpEntry[] = [];
	#cancelWrite: (() => void) | null = null;

	constructor(file: string, bridgeDir: string) {
		this.#file = file;
		this.#bridgeDir = bridgeDir;
	}

	track(child: ChildProcess): void {
		const pid = child.pid;
		if (pid === undefined) return;
		const entry: { child: ChildProcess; started?: number } = { child };
		this.#live.set(pid, entry);
		this.#save();
		child.once("exit", () => {
			this.#unidentified.delete(pid);
			if (this.#live.get(pid) !== entry) return;
			this.#live.delete(pid);
			this.#save();
		});
		if (process.platform === "win32") {
			this.#unidentified.set(pid, entry);
			void this.#identify();
		}
	}

	/**
	 * Records the creation time of every tracked Windows omp after its spawn (one PowerShell query for all that wait),
	 * never before it: the spawn does not wait for it. An omp that already exited is skipped, since its pid may name
	 * another program by now.
	 */
	async #identify(): Promise<void> {
		if (this.#identifying) return;
		this.#identifying = true;
		try {
			while (this.#unidentified.size > 0) {
				const batch = [...this.#unidentified];
				this.#unidentified.clear();
				const times = await windowsStartTimes(batch.map(([pid]) => pid)).catch(() => new Map<number, number>());
				let changed = false;
				for (const [pid, entry] of batch) {
					const started = times.get(pid);
					const running = entry.child.exitCode === null && entry.child.signalCode === null;
					if (started === undefined || !running || this.#live.get(pid) !== entry) continue;
					entry.started = started;
					changed = true;
				}
				if (changed) this.#save();
			}
		} finally {
			this.#identifying = false;
		}
	}

	/** Stops every omp still running (joining stops already under way) and resolves once all exited, or after the bound. */
	async stopAll(boundMs = QUIT_OMP_STOP_MS): Promise<void> {
		const stops = Promise.all([...this.#live.values()].map(({ child }) => stopOmp(child)));
		const { promise: bound, resolve } = Promise.withResolvers<void>();
		const timer = setTimeout(resolve, boundMs);
		await Promise.race([stops, bound]);
		clearTimeout(timer);
	}

	/**
	 * Stops the omps the file names that still run and are still the process this app started, never a reused pid of
	 * another program: on POSIX the pid's command line holds this app's gui-bridge path; on Windows (whose command lines
	 * only WMI gives, which wedges: e2e-ci-windows.md › Stopping an omp) the process's creation time equals the one
	 * recorded at its spawn. An entry with no recorded time is left running. Resolves with the pids it stopped.
	 */
	async reapLeftovers(): Promise<number[]> {
		this.#leftovers = this.#read().filter(({ pid }) => !this.#live.has(pid) && pidAlive(pid));
		if (this.#leftovers.length === 0) return [];
		const ours = await this.#stillOurs(this.#leftovers).catch(() => []);
		await Promise.all(ours.map(pid => stopOmpPid(pid)));
		this.#leftovers = [];
		this.#save();
		return ours;
	}

	async #stillOurs(entries: OmpEntry[]): Promise<number[]> {
		const pids = entries.map(({ pid }) => pid).join(",");
		if (process.platform === "win32") {
			const times = await windowsStartTimes(entries.map(({ pid }) => pid));
			return entries
				.filter(({ pid, started }) => started !== undefined && times.get(pid) === started)
				.map(({ pid }) => pid);
		}
		const { stdout } = await run("ps", ["-ww", "-o", "pid=,command=", "-p", pids], {
			timeout: LOOKUP_TIMEOUT_MS,
		}).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
		const commands = byPid(stdout);
		return entries.filter(({ pid }) => commands.get(pid)?.includes(this.#bridgeDir) === true).map(({ pid }) => pid);
	}

	#read(): OmpEntry[] {
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.#file, "utf8"));
			const omps = typeof parsed === "object" && parsed !== null && "omps" in parsed ? parsed.omps : undefined;
			if (!Array.isArray(omps)) return [];
			return omps.flatMap((entry: unknown) =>
				typeof entry === "object" && entry !== null && "pid" in entry && Number.isInteger(entry.pid)
					? [
							{
								pid: Number(entry.pid),
								...("started" in entry && typeof entry.started === "number" ? { started: entry.started } : {}),
							},
						]
					: [],
			);
		} catch {
			return [];
		}
	}

	#save(): void {
		this.#cancelWrite?.();
		const omps = [...this.#leftovers, ...[...this.#live].map(([pid, { started }]) => ({ pid, started }))];
		this.#cancelWrite = writeFileAtomicDeferred(this.#file, `${JSON.stringify({ omps })}\n`, {}, error =>
			console.warn(`[omp-processes] ${this.#file} not saved: ${String(error)}`),
		);
	}
}

/**
 * The creation time (ms since the epoch, as the OS reports it) of each pid that still runs, by pid. `Get-Process`, never
 * WMI/CIM, which wedges (e2e-ci-windows.md › Stopping an omp). The same call yields the same millisecond for one process
 * whenever it is asked, so two readings of a process compare exactly.
 */
async function windowsStartTimes(pids: number[]): Promise<Map<number, number>> {
	const { stdout } = await run(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $(([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds())" }`,
		],
		{ timeout: LOOKUP_TIMEOUT_MS, windowsHide: true },
	).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
	const times = new Map<number, number>();
	for (const [pid, rest] of byPid(stdout)) times.set(pid, Number(rest));
	return times;
}

/** `<pid> <rest>` lines (what `ps` and the PowerShell query print), by pid. */
function byPid(stdout: string): Map<number, string> {
	const lines = new Map<number, string>();
	for (const line of stdout.split(/\r?\n/)) {
		const match = /^\s*(\d+)\s+(.*)$/.exec(line);
		if (match?.[1] && match[2] !== undefined) lines.set(Number(match[1]), match[2].trim());
	}
	return lines;
}
