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
 *
 * A schedule with `wakeSession` (a session's own wake-up, `ompdesk_schedule` with `target: "self"`; the bot's routines)
 * starts no omp: its start hands the prompt to `wake`, which delivers it into that session as a mail that starts a turn
 * and follows that turn. The run ends with the turn: succeeded, failed with the turn's error, or stopped.
 *
 * An event schedule (`frequency.kind` `event`, a routine) has no clock: `fire` starts it (src/main/routines watches
 * its trigger; `webhook` answers `POST /hooks/<id>`). Events that come while it runs are kept and start one more run
 * after it with all of them; a routine whose every run is asked for again before it ends is turned off after
 * `ROUTINE_CHAIN_LIMIT` such runs in a row (its own work keeps firing its trigger). A `once` schedule starts at its
 * moment and turns itself off.
 */
import type { ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { codedError } from "../shared/ipc-error-codes";
import {
	nextRunAt,
	ROUTINE_CHAIN_LIMIT,
	SCHEDULE_ONCE_DONE_KEPT,
	SCHEDULE_RUNS_KEPT,
	SCHEDULE_RUNS_PER_SCHEDULE,
	type Schedule,
	type ScheduleCreated,
	type ScheduleDraft,
	type ScheduleFrequency,
	type ScheduleRun,
	type SchedulesRequest,
	type SchedulesState,
	scheduleDraftProblem,
} from "../shared/schedules";
import { writeFileAtomic, writeFileAtomicSync } from "./atomic-file";
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
	 * Delivers a wake-up's prompt (`schedule.prompt`, with what fired it) into its session on this computer
	 * (`Schedule.wakeSession`) and follows the turn it starts: `done` settles when that turn ends (`code` 0, or null and
	 * the turn's error), `stop()` stops that turn. Rejects with a readable reason when it cannot deliver. Absent: a
	 * wake-up's run fails (no tab holds sessions here).
	 */
	wake?: (schedule: Schedule, runId: string) => Promise<RunProcess>;
	/** How often due schedules are checked (default `SCHEDULE_TICK_MS`); only a test launch shortens it. */
	tickMs?: number;
	/** The length of a minute for intervals (default 60 000 ms); only a test launch shortens it. */
	minuteMs?: number;
	/**
	 * Count one run against `device`'s daily model limit here. A schedule a paired device saved (`Schedule.device`)
	 * is charged at every start, timed or not; absent = no device is ever charged (tests, no remote host).
	 */
	reserve?: (device: string) => ScheduleCharge;
	/** A run ended (or was skipped), as recorded; the bot's routines go to its activity log (index.ts). */
	runEnded?: (schedule: Schedule, run: ScheduleRun) => void;
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

/** What a webhook call came to (`ScheduleService.webhook`): started or kept for after the running one, or why not. */
export type WebhookOutcome = "fired" | "unknown" | "denied" | "off";

/** Thrown by `launch`/`wake` when a run should not happen now (the bot is paused): the run is recorded as skipped. */
export class ScheduleSkip extends Error {}

/** Event lines kept for the run after the running one (the newest). */
const PENDING_DETAILS_MAX = 20;
/** One event line, as a run's prompt and record carry it. */
const DETAIL_MAX = 500;

export class ScheduleService {
	readonly #options: ScheduleServiceOptions;
	#paused = false;
	#schedules: Schedule[] = [];
	#runs: ScheduleRun[] = [];
	#next = new Map<string, number>();
	/** Running starts by schedule id. */
	#active = new Map<string, ActiveRun>();
	/** Events that came while a routine ran, by schedule id: one more run starts with them when it ends. */
	#pending = new Map<string, string[]>();
	/** Event runs in a row each asked for while the one before ran, by schedule id (the loop guard). */
	#chain = new Map<string, number>();
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
		this.#tick = setInterval(() => this.#runDue(), this.#options.tickMs ?? SCHEDULE_TICK_MS);
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
	 * An event schedule's trigger fired (src/main/routines; `detail`: one English line saying what happened). Starts a
	 * run now, or keeps the event for one more run after the running one. False when nothing will run on it: no such
	 * routine, it is no event schedule, off, everything is paused, or the app is closing.
	 */
	fire(id: string, detail: string): boolean {
		const schedule = this.#schedules.find(item => item.id === id);
		if (!schedule || schedule.frequency.kind !== "event" || !schedule.enabled || this.#paused || this.#disposed)
			return false;
		const line = detail.replace(/\s+/g, " ").trim().slice(0, DETAIL_MAX) || "The trigger fired";
		if (this.#active.has(id)) {
			this.#pending.set(id, [...(this.#pending.get(id) ?? []), line].slice(-PENDING_DETAILS_MAX));
			return true;
		}
		this.#chain.delete(id);
		this.#startEvent(schedule, [line]);
		this.#changed();
		return true;
	}

	/**
	 * `POST /hooks/<id>` with `Authorization: Bearer <key>` (src/main/web/server.ts): fires the routine whose webhook
	 * key it is. The key is compared in constant time; any other id, source or key is `unknown`/`denied` alike to the
	 * caller's eyes only by status, never by timing of the key.
	 */
	webhook(id: string, bearer: string, detail: string): WebhookOutcome {
		const schedule = this.#schedules.find(item => item.id === id);
		const event = schedule?.frequency.kind === "event" ? schedule.frequency.event : null;
		if (!schedule || event?.source !== "webhook") return "unknown";
		const want = Buffer.from(event.key);
		const got = Buffer.from(bearer);
		if (want.length !== got.length || !timingSafeEqual(want, got)) return "denied";
		return this.fire(id, detail) ? "fired" : "off";
	}

	/**
	 * A routine's trigger cannot watch what it names (GitHub refused, a folder is gone, git or the mailbox failed;
	 * src/main/routines tells each distinct failure once): recorded as a failed run with the reason, so the routine's
	 * history and the bot's activity log show it, and nothing runs. False when the routine is gone, off or paused.
	 */
	triggerFailed(id: string, reason: string): boolean {
		const schedule = this.#schedules.find(item => item.id === id);
		if (!schedule || schedule.frequency.kind !== "event" || !schedule.enabled || this.#paused || this.#disposed)
			return false;
		const at = new Date().toISOString();
		const run: ScheduleRun = {
			id: randomUUID(),
			scheduleId: id,
			trigger: "event",
			startedAt: at,
			endedAt: at,
			status: "failed",
			exitCode: null,
			error: `Its trigger failed: ${reason.replace(/\s+/g, " ").trim().slice(0, DETAIL_MAX)}`,
		};
		this.#record(run);
		this.#options.runEnded?.({ ...schedule }, run);
		this.#changed();
		return true;
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
			case "delete":
				this.#find(request.id);
				this.#delete(request.id);
				break;
			case "setEnabled": {
				const schedule = this.#find(request.id);
				schedule.enabled = request.enabled === true;
				this.#pending.delete(schedule.id);
				this.#chain.delete(schedule.id);
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
				void this.#startRun(
					schedule,
					"manual",
					charge,
					schedule.frequency.kind === "event" ? ["A test run: no event fired"] : undefined,
				);
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
			writeFileAtomicSync(this.#options.file, JSON.stringify(this.#stored(), null, 2));
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
		const existing = id ? this.#find(id) : undefined;
		// A saved edit keeps what the Settings dialog does not show: the session a wake-up goes to.
		const wakeSession = draft.wakeSession ?? existing?.wakeSession;
		const clean: ScheduleDraft = {
			name: String(draft.name ?? "").trim(),
			prompt: String(draft.prompt ?? ""),
			cwd: String(draft.cwd ?? ""),
			frequency: cleanFrequency(draft.frequency, existing?.frequency),
			model: typeof draft.model === "string" && draft.model.trim() ? draft.model.trim() : null,
			autoApprove: draft.autoApprove === true,
			enabled: draft.enabled === true,
			...(wakeSession === undefined ? {} : { wakeSession: String(wakeSession) }),
		};
		const problem = scheduleDraftProblem(clean);
		if (problem) throw new Error(`Invalid schedule: ${problem}`);
		// A one-time start is set for a moment still to come (a changed moment too); a missed one never runs.
		if (
			clean.frequency.kind === "once" &&
			Date.parse(clean.frequency.at) <= Date.now() &&
			!(existing?.frequency.kind === "once" && existing.frequency.at === clean.frequency.at)
		)
			throw new Error("Invalid schedule: once (the moment has passed)");
		if (clean.wakeSession !== undefined) {
			if (!(clean.wakeSession.startsWith("/") || /^[A-Za-z]:[\\/]/.test(clean.wakeSession)))
				throw new Error("Invalid schedule: session");
			if (origin !== undefined) throw new Error("Invalid schedule: only this computer's own sessions are woken");
		}
		if (existing) {
			Object.assign(existing, clean);
			if (origin === undefined) delete existing.device;
			else existing.device = origin;
			this.#reschedule(existing);
			return existing.id;
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
		const next =
			this.#paused || !schedule.enabled
				? null
				: nextRunAt(schedule.frequency, new Date(), this.#lastStart(schedule.id), this.#options.minuteMs);
		if (next === null) this.#next.delete(schedule.id);
		else this.#next.set(schedule.id, next.getTime());
	}

	#rescheduleAll(): void {
		for (const schedule of this.#schedules) this.#reschedule(schedule);
	}

	/** The start after a skipped one, from the moment it was due. */
	#skipTo(schedule: Schedule, now: number, due: number): void {
		const next = nextRunAt(schedule.frequency, new Date(now), new Date(due), this.#options.minuteMs);
		if (next === null) this.#next.delete(schedule.id);
		else this.#next.set(schedule.id, next.getTime());
	}

	#skipped(schedule: Schedule, trigger: ScheduleRun["trigger"], error: string, detail?: string): void {
		const at = new Date().toISOString();
		const run: ScheduleRun = {
			id: randomUUID(),
			scheduleId: schedule.id,
			trigger,
			startedAt: at,
			endedAt: at,
			status: "skipped",
			exitCode: null,
			error,
			...(detail === undefined ? {} : { detail }),
		};
		this.#record(run);
		this.#options.runEnded?.({ ...schedule }, run);
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
				this.#skipped(schedule, "schedule", "The previous run was still going");
				this.#skipTo(schedule, now, due);
				continue;
			}
			const charge = schedule.device === undefined ? undefined : this.#options.reserve?.(schedule.device);
			if (charge && !charge.ok) {
				this.#skipped(schedule, "schedule", charge.reason);
				this.#skipTo(schedule, now, due);
				continue;
			}
			void this.#startRun(schedule, "schedule", charge);
		}
		if (changed) this.#changed();
	}

	/** An event run with what fired it; a paired device's routine is charged like any start of its. */
	#startEvent(schedule: Schedule, details: string[]): void {
		const charge = schedule.device === undefined ? undefined : this.#options.reserve?.(schedule.device);
		if (charge && !charge.ok) {
			this.#skipped(schedule, "event", charge.reason, details.join("\n"));
			return;
		}
		void this.#startRun(schedule, "event", charge, details);
	}

	/**
	 * A routine's run ended with events kept meanwhile: one more run with all of them, unless every run has been asked
	 * for again before it ended `ROUTINE_CHAIN_LIMIT` times in a row (its own work fires its trigger): then it is off.
	 */
	#afterRun(schedule: Schedule): void {
		const details = this.#pending.get(schedule.id);
		this.#pending.delete(schedule.id);
		if (!details || this.#paused || !schedule.enabled || !this.#schedules.includes(schedule)) {
			this.#chain.delete(schedule.id);
			return;
		}
		const chain = (this.#chain.get(schedule.id) ?? 0) + 1;
		if (chain >= ROUTINE_CHAIN_LIMIT) {
			schedule.enabled = false;
			this.#chain.delete(schedule.id);
			this.#reschedule(schedule);
			this.#skipped(
				schedule,
				"event",
				`Turned off: its trigger fired again during each of its last ${ROUTINE_CHAIN_LIMIT} runs, so its own work probably fires it. Check the trigger, then turn it back on.`,
				details.join("\n"),
			);
			this.#changed();
			return;
		}
		this.#chain.set(schedule.id, chain);
		this.#startEvent(schedule, details);
		this.#changed();
	}

	async #startRun(
		schedule: Schedule,
		trigger: ScheduleRun["trigger"],
		charge: Extract<ScheduleCharge, { ok: true }> | undefined,
		/** What fired an event run (or says a test run fired nothing); told to the run under its prompt. */
		details?: readonly string[],
	): Promise<void> {
		const detail = details?.join("\n");
		const run: ScheduleRun = {
			id: randomUUID(),
			scheduleId: schedule.id,
			trigger,
			startedAt: new Date().toISOString(),
			endedAt: null,
			status: "running",
			exitCode: null,
			error: null,
			...(detail === undefined ? {} : { detail }),
		};
		const active: ActiveRun = { runId: run.id, process: null, stopRequested: false };
		this.#active.set(schedule.id, active);
		this.#record(run);
		// A one-time start is spent: the schedule is off from now on (a test run leaves it as it was).
		if (schedule.frequency.kind === "once" && trigger === "schedule") {
			schedule.enabled = false;
			this.#pruneOnce();
		}
		this.#reschedule(schedule);
		this.#changed();
		const files = {
			log: join(this.#options.logDir, `${run.id}.log`),
			prompt: join(this.#options.logDir, `${run.id}.prompt`),
		};
		const prompt =
			detail === undefined
				? schedule.prompt
				: `${schedule.prompt}\n\n${trigger === "manual" ? "Test run" : "What fired this run"}:\n${detail}`;
		let result: { code: number | null; error?: string; skipped?: true };
		let launched: RunProcess | null = null;
		try {
			await mkdir(this.#options.logDir, { recursive: true });
			if (schedule.wakeSession !== undefined) {
				const wake = this.#options.wake;
				if (!wake) throw new Error("Waking a session is not available here");
				launched = await wake({ ...schedule, prompt }, run.id);
				await writeFile(files.log, `Woke ${schedule.wakeSession}\n${prompt}\n`);
			} else {
				await writeFile(files.prompt, prompt);
				if (!existsSync(schedule.cwd)) throw new Error(`Project folder not found: ${schedule.cwd}`);
				launched = await this.#options.launch({ ...schedule, prompt }, files);
			}
			active.process = launched;
			if (active.stopRequested || this.#disposed) launched.stop();
			result = await launched.done;
		} catch (error) {
			result = {
				code: null,
				error: error instanceof Error ? error.message : String(error),
				...(error instanceof ScheduleSkip ? { skipped: true as const } : {}),
			};
		}
		// A run that never started spent nothing of the device's day.
		if (!launched) charge?.refund();
		void rm(files.prompt, { force: true }).catch(() => {});
		if (this.#active.get(schedule.id) === active) this.#active.delete(schedule.id);
		if (this.#disposed) return;
		const stopped = active.stopRequested || result.code === SUPERVISOR_STOPPED_CODE;
		this.#finish(run.id, {
			status: stopped ? "stopped" : result.skipped ? "skipped" : result.code === 0 ? "succeeded" : "failed",
			exitCode: result.code,
			error: stopped ? null : (result.error ?? (result.code === 0 ? null : `omp exited with code ${result.code}`)),
		});
		if (schedule.frequency.kind === "event") this.#afterRun(schedule);
	}

	#finish(runId: string, patch: Pick<ScheduleRun, "status" | "exitCode" | "error">): void {
		const endedAt = new Date().toISOString();
		this.#runs = this.#runs.map(run => (run.id === runId ? { ...run, ...patch, endedAt } : run));
		this.#changed();
		const run = this.#runs.find(entry => entry.id === runId);
		const schedule = run && this.#schedules.find(entry => entry.id === run.scheduleId);
		if (run && schedule) this.#options.runEnded?.({ ...schedule }, { ...run });
	}

	#stopSchedule(scheduleId: string): void {
		const active = this.#active.get(scheduleId);
		if (!active) return;
		active.stopRequested = true;
		active.process?.stop();
	}

	/** Newest first; each schedule keeps its `SCHEDULE_RUNS_PER_SCHEDULE` newest, all together `SCHEDULE_RUNS_KEPT`. */
	#record(run: ScheduleRun): void {
		this.#runs = [run, ...this.#runs];
		const kept: ScheduleRun[] = [];
		const dropped: ScheduleRun[] = [];
		const perSchedule = new Map<string, number>();
		for (const entry of this.#runs) {
			const count = perSchedule.get(entry.scheduleId) ?? 0;
			if (entry.status === "running" || (kept.length < SCHEDULE_RUNS_KEPT && count < SCHEDULE_RUNS_PER_SCHEDULE)) {
				kept.push(entry);
				perSchedule.set(entry.scheduleId, count + 1);
			} else dropped.push(entry);
		}
		if (dropped.length === 0) return;
		this.#runs = kept;
		this.#removeLogs(dropped);
	}

	/** A schedule and its finished runs go; a running one is stopped and its record ends as it ends. */
	#delete(id: string): void {
		this.#stopSchedule(id);
		this.#schedules = this.#schedules.filter(schedule => schedule.id !== id);
		const dropped = this.#runs.filter(run => run.scheduleId === id && run.status !== "running");
		this.#runs = this.#runs.filter(run => !dropped.includes(run));
		this.#removeLogs(dropped);
		this.#next.delete(id);
		this.#pending.delete(id);
		this.#chain.delete(id);
	}

	/** Spent one-time schedules past `SCHEDULE_ONCE_DONE_KEPT`, the oldest first, are deleted with their runs. */
	#pruneOnce(): void {
		const spent = this.#schedules.filter(
			schedule => schedule.frequency.kind === "once" && !schedule.enabled && !this.#active.has(schedule.id),
		);
		for (const schedule of spent.slice(0, Math.max(0, spent.length - SCHEDULE_ONCE_DONE_KEPT)))
			this.#delete(schedule.id);
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
			// dispose() writes the final state synchronously; an older snapshot must not land after it. `commitIf` is
			// asked right before every rename, which runs in the same tick, so a quit that comes while this write is
			// in flight (or waits out a reader of the file) cannot slip between the check and the rename.
			.then(() =>
				this.#disposed ? undefined : writeFileAtomic(file, snapshot, { commitIf: () => !this.#disposed }),
			)
			.catch(error => console.error("[schedules] couldn't save:", error));
		this.#options.onState(this.state());
	}
}

/**
 * A draft's timing as stored: unknown fields dropped. A webhook trigger saved without a key gets a new one, or keeps
 * the key the schedule already had (an edit never shows or resends it).
 */
function cleanFrequency(
	frequency: ScheduleFrequency | undefined,
	before: ScheduleFrequency | undefined,
): ScheduleFrequency {
	switch (frequency?.kind) {
		case "daily":
			return { kind: "daily", time: String(frequency.time), days: [...new Set(frequency.days)].toSorted() };
		case "once":
			return { kind: "once", at: String(frequency.at) };
		case "event": {
			const event = frequency.event;
			switch (event?.source) {
				case "webhook": {
					const kept = before?.kind === "event" && before.event.source === "webhook" ? before.event.key : "";
					const key = String(event.key ?? "") || kept || randomBytes(24).toString("base64url");
					return { kind: "event", event: { source: "webhook", key } };
				}
				case "github":
					return {
						kind: "event",
						event: { source: "github", repo: String(event.repo), events: [...new Set(event.events)].toSorted() },
					};
				case "files":
					return { kind: "event", event: { source: "files", path: String(event.path) } };
				case "git":
					return {
						kind: "event",
						event: { source: "git", repo: String(event.repo), branch: String(event.branch) },
					};
				case "session":
					return {
						kind: "event",
						event: {
							source: "session",
							events: [...new Set(event.events)].toSorted(),
							...(typeof event.folder === "string" && event.folder.trim()
								? { folder: event.folder.trim() }
								: {}),
						},
					};
				default:
					return frequency;
			}
		}
		default:
			return { kind: "interval", minutes: Number(frequency?.minutes) };
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
	/** Extension flags every run gets in its folder (ai-memory's root while memory is on). */
	extensionArgs?: (cwd: string) => Promise<string[]>;
	/** What a run with those extensions needs to reach their MCP servers (src/main/mcp-hub.ts `ompEnv`). */
	extensionEnv?: (cwd: string) => Promise<Record<string, string>>;
}): RunLauncher {
	return async (schedule, files) => {
		const resolution = await options.omp();
		if (!resolution.ok) throw new Error(resolution.error);
		const { bin } = resolution.runtime;
		const extensions = (await options.extensionArgs?.(schedule.cwd)) ?? [];
		const env = {
			...(await options.env()),
			...(extensions.length ? await options.extensionEnv?.(schedule.cwd) : {}),
		};
		const args = [
			"-p",
			...extensions,
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
