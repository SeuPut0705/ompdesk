import { type ChildProcess, execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
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
/** How long the creation-time or command-line lookup of pids may take. */
const LOOKUP_TIMEOUT_MS = 5_000;
/**
 * Waits before each new try at an omp's creation time when the lookup failed or did not name a pid that still runs (a
 * cold `powershell.exe` on a loaded machine can miss `LOOKUP_TIMEOUT_MS`): the entry is tried again after each, and
 * left without a creation time once all are used.
 */
const IDENTIFY_RETRY_DELAYS_MS: readonly number[] = [500, 1_000, 2_000, 4_000, 8_000];

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

/** What an `OmpProcesses` takes from outside; tests fake the creation-time lookup, the platform and the waits. */
export interface OmpProcessesOptions {
	/** The creation time of each pid that still runs, by pid; rejects when it could not ask (default: `Get-Process`). */
	startTimes?: (pids: number[]) => Promise<Map<number, number>>;
	/** Runs `ps` for the POSIX command-line lookup of the launch's reap (default: `execFile`). */
	runCommand?: CommandRunner;
	/** Stops a leftover pid; resolves whether it is gone (default: `stopOmpPid`). */
	stopPid?: (pid: number) => Promise<boolean>;
	platform?: NodeJS.Platform;
	retryDelaysMs?: readonly number[];
	/** One line per failed lookup: its phase, cause (`timeout`, `error`, `gave-up`), duration and pids. */
	log?: (message: string, details: Record<string, string | number | boolean>) => void;
}

/**
 * Every omp this app has running, and the file that names them for the next launch (`<userData>/omp-pids.json`). A
 * quit stops them all and waits (`stopAll`), and a launch first stops the ones an earlier instance left running when
 * it crashed or was forced out (`reapLeftovers`): one omp stuck on a blocked thread kept every new omp on the machine
 * stalled for three minutes after a relaunch (8 Nov 2026). Each spawn and each exit rewrites the file.
 */
export class OmpProcesses {
	readonly #startTimes: (pids: number[]) => Promise<Map<number, number>>;
	readonly #platform: NodeJS.Platform;
	readonly #runCommand: CommandRunner;
	readonly #stopPid: (pid: number) => Promise<boolean>;
	readonly #retryDelaysMs: readonly number[];
	readonly #log: (message: string, details: Record<string, string | number | boolean>) => void;
	#identifyDone: Promise<void> = Promise.resolve();
	readonly #file: string;
	readonly #bridgeDir: string;
	readonly #live = new Map<number, { child: ChildProcess; started?: number }>();
	/** Windows omps whose creation time is not recorded yet, by pid. */
	readonly #unidentified = new Map<number, { child: ChildProcess; started?: number }>();
	#identifying = false;
	/** Leftovers the launch has not stopped yet stay named in the file, so a crash during the reap leaves them listed. */
	#leftovers: OmpEntry[] = [];
	#cancelWrite: (() => void) | null = null;

	constructor(file: string, bridgeDir: string, options: OmpProcessesOptions = {}) {
		this.#file = file;
		this.#bridgeDir = bridgeDir;
		this.#startTimes = options.startTimes ?? windowsStartTimes;
		this.#platform = options.platform ?? process.platform;
		this.#runCommand = options.runCommand ?? run;
		this.#stopPid = options.stopPid ?? stopOmpPid;
		this.#retryDelaysMs = options.retryDelaysMs ?? IDENTIFY_RETRY_DELAYS_MS;
		this.#log = options.log ?? ((message, details) => console.warn(`[omp-processes] ${message}`, details));
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
		if (this.#platform === "win32") {
			this.#unidentified.set(pid, entry);
			this.#identify();
		}
	}

	/**
	 * Records the creation time of every tracked Windows omp after its spawn (one PowerShell query for all that wait),
	 * never before it: the spawn does not wait for it. A lookup that failed, or that did not name an omp which still
	 * runs, never drops the omp: it is asked again after a growing wait, a bounded number of times. An omp that already
	 * exited is skipped, since its pid may name another program by now.
	 */
	#identify(): void {
		if (this.#identifying) return;
		this.#identifying = true;
		this.#identifyDone = this.#identifyLoop();
	}

	/** Resolves once the creation time of every omp tracked so far is recorded or given up on (tests await it). */
	identified(): Promise<void> {
		return this.#identifyDone;
	}

	async #identifyLoop(): Promise<void> {
		const attempts = new Map<number, number>();
		try {
			while (this.#unidentified.size > 0) {
				const batch = [...this.#unidentified];
				this.#unidentified.clear();
				const times = await this.#lookup(
					"identify",
					batch.map(([pid]) => pid),
					Math.max(...batch.map(([pid]) => attempts.get(pid) ?? 0)) + 1,
				);
				let changed = false;
				let wait: number | undefined;
				for (const [pid, entry] of batch) {
					const running = entry.child.exitCode === null && entry.child.signalCode === null;
					if (!running || this.#live.get(pid) !== entry) continue;
					const started = times?.get(pid);
					if (started !== undefined) {
						entry.started = started;
						changed = true;
						continue;
					}
					const attempt = (attempts.get(pid) ?? 0) + 1;
					attempts.set(pid, attempt);
					const delayMs = this.#retryDelaysMs[attempt - 1];
					if (delayMs === undefined) {
						this.#log("creation time not read; the omp stays without one", {
							level: "warn",
							phase: "identify",
							cause: "gave-up",
							pids: String(pid),
							attempt,
						});
						continue;
					}
					this.#unidentified.set(pid, entry);
					wait = Math.max(wait ?? 0, delayMs);
				}
				if (changed) this.#save();
				if (wait !== undefined) await delay(wait);
			}
		} finally {
			this.#identifying = false;
		}
	}

	/**
	 * The creation time of each pid that still runs, or null when the lookup failed (logged with its cause and how long
	 * it took, never as "no such process": a failed lookup says nothing about the pids).
	 */
	async #lookup(phase: "identify" | "reap", pids: number[], attempt: number): Promise<Map<number, number> | null> {
		const began = Date.now();
		try {
			return await this.#startTimes(pids);
		} catch (error) {
			this.#log("creation-time lookup failed", {
				level: "warn",
				phase,
				cause: isTimeout(error) ? "timeout" : "error",
				durationMs: Date.now() - began,
				pids: pids.join(","),
				attempt,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
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
	 * recorded at its spawn. An entry leaves the file only when it was stopped (the pid is gone afterwards), its pid
	 * is gone, or the lookup read the pid and it is not ours (another creation time, another command line). A pid that
	 * still runs but the lookup did not resolve (the lookup failed, named no such pid, gave no usable time, or the
	 * entry has no recorded time) or that survives its stop is neither forgotten nor reported: it stays in the file
	 * for the next launch. Resolves with the pids it confirmed stopped.
	 */
	async reapLeftovers(): Promise<number[]> {
		this.#leftovers = this.#read().filter(({ pid }) => !this.#live.has(pid) && pidAlive(pid));
		if (this.#leftovers.length === 0) return [];
		const verdict = await this.#classify(this.#leftovers);
		if (verdict === null) return [];
		const gone = await Promise.all(verdict.ours.map(pid => this.#stopPid(pid)));
		const stopped = verdict.ours.filter((_, index) => gone[index]);
		const settled = new Set([...stopped, ...verdict.notOurs]);
		this.#leftovers = this.#leftovers.filter(({ pid }) => !settled.has(pid));
		this.#save();
		return stopped;
	}

	/**
	 * Which of `entries` the lookup positively says are this app's omps and which are not; an entry in neither is
	 * unresolved. Null when the lookup failed (logged with its cause and how long it took).
	 */
	async #classify(entries: OmpEntry[]): Promise<{ ours: number[]; notOurs: number[] } | null> {
		const pids = entries.map(({ pid }) => pid);
		const ours: number[] = [];
		const notOurs: number[] = [];
		if (this.#platform === "win32") {
			const times = await this.#lookup("reap", pids, 1);
			if (times === null) return null;
			for (const { pid, started } of entries) {
				const time = times.get(pid);
				if (started === undefined || !isCreationTime(time)) continue;
				(time === started ? ours : notOurs).push(pid);
			}
			return { ours, notOurs };
		}
		const commands = await this.#commandLines(pids);
		if (commands === null) return null;
		for (const pid of pids) {
			const command = commands.get(pid);
			if (command === undefined) continue;
			(command.includes(this.#bridgeDir) ? ours : notOurs).push(pid);
		}
		return { ours, notOurs };
	}

	/**
	 * The command line of each pid `ps` lists, or null when `ps` failed: a timeout, a launch that failed, or an exit
	 * with no output (a nonzero exit that still lists some pids, as `ps` does when another one is gone, is an answer).
	 */
	async #commandLines(pids: number[]): Promise<Map<number, string> | null> {
		const began = Date.now();
		try {
			const { stdout } = await this.#runCommand("ps", ["-ww", "-o", "pid=,command=", "-p", pids.join(",")], {
				timeout: LOOKUP_TIMEOUT_MS,
			});
			return byPid(stdout);
		} catch (error) {
			const partial = isTimeout(error) || !hasExitCode(error) ? "" : (error.stdout ?? "");
			if (partial.trim() !== "") return byPid(partial);
			this.#log("command-line lookup failed", {
				level: "warn",
				phase: "reap",
				cause: isTimeout(error) ? "timeout" : "error",
				durationMs: Date.now() - began,
				pids: pids.join(","),
				attempt: 1,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
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

/** Runs a command and resolves with its stdout; rejects on a nonzero exit, a timeout or a launch that failed. */
type CommandRunner = (
	file: string,
	args: string[],
	options: { timeout: number; windowsHide?: boolean },
) => Promise<{ stdout: string }>;

/**
 * The creation time (ms since the epoch, as the OS reports it) of each pid that still runs, by pid. `Get-Process`, never
 * WMI/CIM, which wedges (e2e-ci-windows.md › Stopping an omp). The same call yields the same millisecond for one process
 * whenever it is asked, so two readings of a process compare exactly. A pid that is gone is the expected answer, not an
 * error (`-ErrorAction SilentlyContinue`, then `exit 0`, since PowerShell exits 1 when the last command set `$?` false):
 * every rejection of the command (a timeout, a launch that failed, any nonzero exit) rejects here too, so it never
 * reads as "no such process".
 */
export async function windowsStartTimes(pids: number[], runCommand: CommandRunner = run): Promise<Map<number, number>> {
	const { stdout } = await runCommand(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $(([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds())" }; exit 0`,
		],
		{ timeout: LOOKUP_TIMEOUT_MS, windowsHide: true },
	);
	const times = new Map<number, number>();
	for (const [pid, rest] of byPid(stdout)) {
		const time = Number(rest);
		if (isCreationTime(time)) times.set(pid, time);
	}
	return times;
}

/** A creation time the lookup can compare: a positive finite number; an empty or garbled line reads as none. */
function isCreationTime(time: number | undefined): time is number {
	return time !== undefined && Number.isFinite(time) && time > 0;
}

/** An `execFile` rejection of a command that ran and exited nonzero (`code` is the number, not `ENOENT`). */
function hasExitCode(error: unknown): error is { code: number; stdout?: string } {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "number";
}

/** A lookup `execFile` ended at its bound (it marks the error `killed`). */
function isTimeout(error: unknown): boolean {
	return typeof error === "object" && error !== null && "killed" in error && error.killed === true;
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
