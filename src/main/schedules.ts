/**
 * Scheduled runs: main starts stock `omp -p` in a project folder when a
 * schedule comes due, only while OMPdesk is open (contract and timing rules in
 * src/shared/schedules.ts). Schedules and the run log live in
 * `<userData>/schedules.json`; each run's output goes to
 * `<userData>/schedule-runs/<runId>.log`.
 *
 * Every run goes through the setup supervisor (`spawnSupervised`): omp reads a
 * piped stdin as its prompt and never watches it for EOF, so the supervisor
 * hands it the prompt file as stdin and kills omp's whole process tree when its
 * own stdin closes — a Stop, an app quit, or a crash that skips every quit
 * handler. A start that falls due while the previous run of the same schedule
 * still goes is recorded as skipped instead of piling up.
 */
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { codedError } from "../shared/ipc-error-codes";
import {
	nextRunAt,
	SCHEDULE_RUNS_KEPT,
	type Schedule,
	type ScheduleCreated,
	type ScheduleDraft,
	type ScheduleRun,
	type SchedulesRequest,
	type SchedulesState,
	scheduleDraftProblem,
} from "../shared/schedules";
import { OMP_TELEMETRY_OFF, type OmpResolution, ompPathEnv } from "./omp-runtime";
import { SUPERVISOR_STOPPED_CODE, spawnSupervised } from "./setup/supervisor";
import { needsShell, spawnArgs, spawnCommand } from "./spawn";

/** How often due schedules are checked; a wall-clock check survives system sleep, a long timer would not. */
export const SCHEDULE_TICK_MS = 30_000;
/** A run's log is read back at most this much from its end. */
const LOG_TAIL_BYTES = 256 * 1024;

/** One started `omp -p`: `stop()` ends it, `done` settles once it exited and its log is flushed. */
export interface RunProcess {
	stop(): void;
	done: Promise<{ code: number | null; error?: string }>;
}

export type RunLauncher = (schedule: Schedule, files: { log: string; prompt: string }) => Promise<RunProcess>;

/** A paired device's daily model requests on this computer (`PeerQuota`): one counted, or why not. */
export type ScheduleCharge = { ok: true; refund(): void } | { ok: false; reason: string };

export interface ScheduleServiceOptions {
	/** `schedules.json`. */
	file: string;
	/** Directory of run logs (and each running prompt). */
	logDir: string;
	launch: RunLauncher;
	onState: (state: SchedulesState) => void;
	/**
	 * Count one run against `device`'s daily model limit here. A schedule a paired device saved (`Schedule.device`)
	 * is charged at every start, timed or not; absent = no device is ever charged (tests, no remote host).
	 */
	reserve?: (device: string) => ScheduleCharge;
}

interface StoredSchedules {
	version: 1;
	paused: boolean;
	schedules: Schedule[];
	runs: ScheduleRun[];
}

interface ActiveRun {
	runId: string;
	process: RunProcess | null;
	stopRequested: boolean;
}

export class ScheduleService {
	readonly #options: ScheduleServiceOptions;
	#paused = false;
	#schedules: Schedule[] = [];
	#runs: ScheduleRun[] = [];
	#next = new Map<string, number>();
	/** Running starts by schedule id. */
	#active = new Map<string, ActiveRun>();
	#tick: NodeJS.Timeout | null = null;
	#writes: Promise<void> = Promise.resolve();
	#disposed = false;

	constructor(options: ScheduleServiceOptions) {
		this.#options = options;
	}

	/** Load the saved schedules (a run left `running` by a crash ends as stopped) and start the clock. */
	async start(): Promise<void> {
		const stored = await readStored(this.#options.file);
		this.#paused = stored.paused;
		this.#schedules = stored.schedules;
		const now = new Date().toISOString();
		this.#runs = stored.runs.map(run =>
			run.status === "running"
				? { ...run, status: "stopped", endedAt: now, error: "OMPdesk closed during the run" }
				: run,
		);
		if (this.#disposed) return;
		this.#rescheduleAll();
		this.#tick = setInterval(() => this.#runDue(), SCHEDULE_TICK_MS);
		this.#changed();
	}

	state(): SchedulesState {
		const nextRuns: Record<string, string | null> = {};
		for (const schedule of this.#schedules) {
			const next = this.#next.get(schedule.id);
			nextRuns[schedule.id] = next === undefined ? null : new Date(next).toISOString();
		}
		return {
			paused: this.#paused,
			schedules: this.#schedules.map(schedule => ({ ...schedule })),
			runs: this.#runs.map(run => ({ ...run })),
			nextRuns,
		};
	}

	/**
	 * `origin`: the paired device a request comes from (`host.schedules.command`). A save from a device makes the
	 * schedule that device's (its runs count against its daily model limit here); a save here makes it this computer's.
	 * A run now from a device is charged to that device and refused past its limit.
	 */
	async command(request: SchedulesRequest, origin?: string): Promise<SchedulesState> {
		switch (request.action) {
			case "get":
				break;
			case "save":
				this.#save(request.draft, request.id, origin);
				break;
			case "delete": {
				this.#find(request.id);
				this.#stopSchedule(request.id);
				this.#schedules = this.#schedules.filter(schedule => schedule.id !== request.id);
				const dropped = this.#runs.filter(run => run.scheduleId === request.id && run.status !== "running");
				this.#runs = this.#runs.filter(run => !dropped.includes(run));
				this.#removeLogs(dropped);
				this.#next.delete(request.id);
				break;
			}
			case "setEnabled": {
				const schedule = this.#find(request.id);
				schedule.enabled = request.enabled === true;
				this.#reschedule(schedule);
				break;
			}
			case "setPaused":
				this.#paused = request.paused === true;
				this.#rescheduleAll();
				break;
			case "runNow": {
				const schedule = this.#find(request.id);
				if (this.#active.has(schedule.id)) throw new Error("This schedule is already running");
				const charge = origin === undefined ? undefined : this.#options.reserve?.(origin);
				if (charge && !charge.ok) throw codedError("remote_limit_reached", charge.reason);
				void this.#startRun(schedule, "manual", charge);
				break;
			}
			case "stop": {
				const entry = [...this.#active.entries()].find(([, active]) => active.runId === request.runId);
				if (entry) this.#stopSchedule(entry[0]);
				break;
			}
			default:
				throw new Error("Unknown schedules action");
		}
		this.#changed();
		return this.state();
	}

	/**
	 * Save a new schedule and say which one it is: the id comes from this save, never from a diff a concurrent save
	 * could share. `origin`: the paired device it is made for (its runs count against that device), as in `command`.
	 */
	async create(draft: ScheduleDraft, origin?: string): Promise<ScheduleCreated> {
		const id = this.#save(draft, undefined, origin);
		this.#changed();
		return { id, state: this.state() };
	}

	/** The run's captured output, from its end when long. */
	async readLog(runId: string): Promise<string> {
		if (!this.#runs.some(run => run.id === runId)) throw new Error("Run not found");
		const path = join(this.#options.logDir, `${runId}.log`);
		if (!existsSync(path)) return "";
		const handle = await open(path, "r");
		try {
			const { size } = await handle.stat();
			const start = Math.max(0, size - LOG_TAIL_BYTES);
			const buffer = Buffer.alloc(size - start);
			await handle.read(buffer, 0, buffer.length, start);
			return buffer.toString("utf8");
		} finally {
			await handle.close();
		}
	}

	/** App quit: stop every running omp (its supervisor kills the tree) and record it, synchronously. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		clearInterval(this.#tick ?? undefined);
		this.#tick = null;
		const now = new Date().toISOString();
		for (const [scheduleId, active] of this.#active) {
			active.stopRequested = true;
			active.process?.stop();
			this.#runs = this.#runs.map(run =>
				run.id === active.runId && run.status === "running"
					? { ...run, status: "stopped", endedAt: now, error: "OMPdesk closed during the run" }
					: run,
			);
			this.#active.delete(scheduleId);
		}
		try {
			const temp = `${this.#options.file}.quit.tmp`;
			writeFileSync(temp, JSON.stringify(this.#stored(), null, 2));
			renameSync(temp, this.#options.file);
		} catch (error) {
			console.error("[schedules] couldn't save on quit:", error);
		}
	}

	#find(id: string): Schedule {
		const schedule = this.#schedules.find(item => item.id === id);
		if (!schedule) throw new Error("Schedule not found");
		return schedule;
	}

	/** Returns the id of the schedule saved. */
	#save(draft: ScheduleDraft, id: string | undefined, origin: string | undefined): string {
		const clean: ScheduleDraft = {
			name: String(draft.name ?? "").trim(),
			prompt: String(draft.prompt ?? ""),
			cwd: String(draft.cwd ?? ""),
			frequency:
				draft.frequency?.kind === "daily"
					? {
							kind: "daily",
							time: String(draft.frequency.time),
							days: [...new Set(draft.frequency.days)].toSorted(),
						}
					: { kind: "interval", minutes: Number(draft.frequency?.minutes) },
			model: typeof draft.model === "string" && draft.model.trim() ? draft.model.trim() : null,
			autoApprove: draft.autoApprove === true,
			enabled: draft.enabled === true,
		};
		const problem = scheduleDraftProblem(clean);
		if (problem) throw new Error(`Invalid schedule: ${problem}`);
		if (id) {
			const schedule = this.#find(id);
			Object.assign(schedule, clean);
			if (origin === undefined) delete schedule.device;
			else schedule.device = origin;
			this.#reschedule(schedule);
			return schedule.id;
		}
		const schedule: Schedule = {
			...clean,
			id: randomUUID(),
			createdAt: new Date().toISOString(),
			...(origin === undefined ? {} : { device: origin }),
		};
		this.#schedules.push(schedule);
		this.#reschedule(schedule);
		return schedule.id;
	}

	#lastStart(scheduleId: string): Date | null {
		const last = this.#runs.find(run => run.scheduleId === scheduleId && run.status !== "skipped");
		return last ? new Date(last.startedAt) : null;
	}

	#reschedule(schedule: Schedule): void {
		if (this.#paused || !schedule.enabled) {
			this.#next.delete(schedule.id);
			return;
		}
		this.#next.set(schedule.id, nextRunAt(schedule.frequency, new Date(), this.#lastStart(schedule.id)).getTime());
	}

	#rescheduleAll(): void {
		for (const schedule of this.#schedules) this.#reschedule(schedule);
	}

	#runDue(): void {
		if (this.#paused || this.#disposed) return;
		const now = Date.now();
		let changed = false;
		for (const schedule of this.#schedules) {
			const due = this.#next.get(schedule.id);
			if (due === undefined || due > now) continue;
			changed = true;
			if (this.#active.has(schedule.id)) {
				this.#record({
					id: randomUUID(),
					scheduleId: schedule.id,
					trigger: "schedule",
					startedAt: new Date(now).toISOString(),
					endedAt: new Date(now).toISOString(),
					status: "skipped",
					exitCode: null,
					error: "The previous run was still going",
				});
				this.#next.set(schedule.id, nextRunAt(schedule.frequency, new Date(now), new Date(due)).getTime());
				continue;
			}
			const charge = schedule.device === undefined ? undefined : this.#options.reserve?.(schedule.device);
			if (charge && !charge.ok) {
				this.#record({
					id: randomUUID(),
					scheduleId: schedule.id,
					trigger: "schedule",
					startedAt: new Date(now).toISOString(),
					endedAt: new Date(now).toISOString(),
					status: "skipped",
					exitCode: null,
					error: charge.reason,
				});
				this.#next.set(schedule.id, nextRunAt(schedule.frequency, new Date(now), new Date(due)).getTime());
				continue;
			}
			void this.#startRun(schedule, "schedule", charge);
		}
		if (changed) this.#changed();
	}

	async #startRun(
		schedule: Schedule,
		trigger: ScheduleRun["trigger"],
		charge: Extract<ScheduleCharge, { ok: true }> | undefined,
	): Promise<void> {
		const run: ScheduleRun = {
			id: randomUUID(),
			scheduleId: schedule.id,
			trigger,
			startedAt: new Date().toISOString(),
			endedAt: null,
			status: "running",
			exitCode: null,
			error: null,
		};
		const active: ActiveRun = { runId: run.id, process: null, stopRequested: false };
		this.#active.set(schedule.id, active);
		this.#record(run);
		this.#reschedule(schedule);
		this.#changed();
		const files = {
			log: join(this.#options.logDir, `${run.id}.log`),
			prompt: join(this.#options.logDir, `${run.id}.prompt`),
		};
		let result: { code: number | null; error?: string };
		let launched: RunProcess | null = null;
		try {
			await mkdir(this.#options.logDir, { recursive: true });
			await writeFile(files.prompt, schedule.prompt);
			if (!existsSync(schedule.cwd)) throw new Error(`Project folder not found: ${schedule.cwd}`);
			launched = await this.#options.launch({ ...schedule }, files);
			active.process = launched;
			if (active.stopRequested || this.#disposed) launched.stop();
			result = await launched.done;
		} catch (error) {
			result = { code: null, error: error instanceof Error ? error.message : String(error) };
		}
		// A run that never started spent nothing of the device's day.
		if (!launched) charge?.refund();
		void rm(files.prompt, { force: true }).catch(() => {});
		if (this.#active.get(schedule.id) === active) this.#active.delete(schedule.id);
		if (this.#disposed) return;
		const stopped = active.stopRequested || result.code === SUPERVISOR_STOPPED_CODE;
		this.#finish(run.id, {
			status: stopped ? "stopped" : result.code === 0 ? "succeeded" : "failed",
			exitCode: result.code,
			error: stopped ? null : (result.error ?? (result.code === 0 ? null : `omp exited with code ${result.code}`)),
		});
	}

	#finish(runId: string, patch: Pick<ScheduleRun, "status" | "exitCode" | "error">): void {
		const endedAt = new Date().toISOString();
		this.#runs = this.#runs.map(run => (run.id === runId ? { ...run, ...patch, endedAt } : run));
		this.#changed();
	}

	#stopSchedule(scheduleId: string): void {
		const active = this.#active.get(scheduleId);
		if (!active) return;
		active.stopRequested = true;
		active.process?.stop();
	}

	#record(run: ScheduleRun): void {
		this.#runs = [run, ...this.#runs];
		if (this.#runs.length <= SCHEDULE_RUNS_KEPT) return;
		const kept: ScheduleRun[] = [];
		const dropped: ScheduleRun[] = [];
		for (const entry of this.#runs) {
			if (kept.length < SCHEDULE_RUNS_KEPT || entry.status === "running") kept.push(entry);
			else dropped.push(entry);
		}
		this.#runs = kept;
		this.#removeLogs(dropped);
	}

	#removeLogs(runs: readonly ScheduleRun[]): void {
		for (const run of runs) {
			void rm(join(this.#options.logDir, `${run.id}.log`), { force: true }).catch(() => {});
		}
	}

	#stored(): StoredSchedules {
		return { version: 1, paused: this.#paused, schedules: this.#schedules, runs: this.#runs };
	}

	#changed(): void {
		if (this.#disposed) return;
		const snapshot = JSON.stringify(this.#stored(), null, 2);
		const file = this.#options.file;
		this.#writes = this.#writes
			.then(async () => {
				// dispose() writes the final state synchronously; an older snapshot must not land after it. The check
				// runs again once the temp file is written, and the rename is synchronous, so a quit that comes while
				// this write is in flight cannot slip between the check and the rename.
				if (this.#disposed) return;
				const temp = `${file}.tmp`;
				await writeFile(temp, snapshot);
				if (this.#disposed) {
					await rm(temp, { force: true });
					return;
				}
				renameSync(temp, file);
			})
			.catch(error => console.error("[schedules] couldn't save:", error));
		this.#options.onState(this.state());
	}
}

async function readStored(file: string): Promise<StoredSchedules> {
	try {
		const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
		if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
		const value = parsed as Partial<StoredSchedules>;
		return {
			version: 1,
			paused: value.paused === true,
			schedules: Array.isArray(value.schedules)
				? value.schedules.filter(
						(schedule): schedule is Schedule =>
							typeof schedule?.id === "string" && scheduleDraftProblem(schedule) === null,
					)
				: [],
			runs: Array.isArray(value.runs)
				? value.runs.filter((run): run is ScheduleRun => typeof run?.id === "string").slice(0, SCHEDULE_RUNS_KEPT)
				: [],
		};
	} catch {
		return { version: 1, paused: false, schedules: [], runs: [] };
	}
}

/**
 * The production launcher: `omp -p [--model m] [--yolo]` under the supervisor,
 * the prompt as its stdin, stdout and stderr appended to the run's log.
 */
export function ompRunLauncher(options: {
	omp: () => Promise<OmpResolution>;
	env: () => Promise<NodeJS.ProcessEnv>;
	/** Extension flags every run gets (ai-memory's root while memory is on). */
	extensionArgs?: () => Promise<string[]>;
}): RunLauncher {
	return async (schedule, files) => {
		const resolution = await options.omp();
		if (!resolution.ok) throw new Error(resolution.error);
		const { bin } = resolution.runtime;
		const env = await options.env();
		const args = [
			"-p",
			...((await options.extensionArgs?.()) ?? []),
			...(schedule.model ? ["--model", schedule.model] : []),
			...(schedule.autoApprove ? ["--yolo"] : []),
		];
		const log = createWriteStream(files.log, { flags: "a" });
		// A log that cannot be written (disk full, folder removed) must neither crash main nor stop the run:
		// without a listener the stream's 'error' is an uncaught exception. The run goes on unlogged.
		let logFailed = false;
		log.on("error", () => {
			logFailed = true;
		});
		log.write(`$ omp ${args.join(" ")}\n# ${schedule.cwd}\n\n`);
		let child: ChildProcess;
		try {
			child = spawnSupervised(
				{
					file: spawnCommand(bin),
					args: spawnArgs(bin, args),
					shell: needsShell(bin),
					inputFile: files.prompt,
				},
				{
					...env,
					PATH: ompPathEnv(bin, env.PATH ?? ""),
					PI_NOTIFICATIONS: "off",
					PI_NO_PTY: "1",
					...OMP_TELEMETRY_OFF,
				},
				schedule.cwd,
			);
		} catch (error) {
			log.destroy();
			throw error;
		}
		child.stdout?.pipe(log, { end: false });
		child.stderr?.pipe(log, { end: false });
		log.on("error", () => {
			// pipe() detaches a failed destination, which would leave omp blocked on a full stdout pipe.
			child.stdout?.unpipe(log);
			child.stderr?.unpipe(log);
			child.stdout?.resume();
			child.stderr?.resume();
		});
		const { promise, resolve } = Promise.withResolvers<{ code: number | null; error?: string }>();
		child.on("error", error => resolve({ code: null, error: error.message }));
		child.on("close", code => resolve({ code }));
		const done = promise.then(async result => {
			// A destroyed log never calls end()'s callback, so wait for 'close' instead.
			if (!logFailed) log.end();
			await finished(log).catch(() => undefined);
			return result;
		});
		return { stop: () => child.stdin?.end(), done };
	};
}
