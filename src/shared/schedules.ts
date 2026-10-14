/**
 * Scheduled runs (Settings › Schedules): a prompt run as stock `omp -p` in a
 * project folder on a timer, by main, only while OMPdesk is open. Times missed
 * while the app was closed are skipped, never caught up. Stock omp has no
 * scheduler, so this one is GUI-owned; each run is one ordinary print-mode
 * session that stock saves like any other.
 */

export const SCHEDULES_COMMAND = "schedules:command";
export const SCHEDULES_LOG = "schedules:log";
export const SCHEDULES_STATE = "schedules:state";

/** Shortest and longest interval a schedule may repeat at, in minutes. */
export const SCHEDULE_MIN_INTERVAL = 5;
export const SCHEDULE_MAX_INTERVAL = 7 * 24 * 60;
/** Runs kept in the log, all schedules together; older ones and their log files go. */
export const SCHEDULE_RUNS_KEPT = 200;

export type ScheduleFrequency =
	| { kind: "interval"; minutes: number }
	/** Local wall-clock `HH:MM`; `days` are weekdays (0 = Sunday), empty = every day. */
	| { kind: "daily"; time: string; days: number[] };

export interface ScheduleDraft {
	name: string;
	prompt: string;
	/** Absolute project folder the run starts in. */
	cwd: string;
	frequency: ScheduleFrequency;
	/** `--model` selector; null = omp's default model. */
	model: string | null;
	/** `--yolo`: run every tool without asking (print mode cannot ask). */
	autoApprove: boolean;
	enabled: boolean;
}

export interface Schedule extends ScheduleDraft {
	id: string;
	createdAt: string;
}

/** `stopped`: ended by the user or by the app closing; `skipped`: the previous run was still going. */
export type ScheduleRunStatus = "running" | "succeeded" | "failed" | "stopped" | "skipped";

export interface ScheduleRun {
	id: string;
	scheduleId: string;
	trigger: "schedule" | "manual";
	startedAt: string;
	endedAt: string | null;
	status: ScheduleRunStatus;
	exitCode: number | null;
	/** Why a run failed to start or was skipped (English; the log has the details). */
	error: string | null;
}

export interface SchedulesState {
	/** Every schedule held, without editing each one. */
	paused: boolean;
	schedules: Schedule[];
	/** Newest first. */
	runs: ScheduleRun[];
	/** Next start per schedule id (ISO); null when it will not run (disabled or paused). */
	nextRuns: Record<string, string | null>;
}

export type SchedulesRequest =
	| { action: "get" }
	| { action: "save"; id?: string; draft: ScheduleDraft }
	| { action: "delete"; id: string }
	| { action: "setEnabled"; id: string; enabled: boolean }
	| { action: "setPaused"; paused: boolean }
	| { action: "runNow"; id: string }
	| { action: "stop"; runId: string };

export interface SchedulesApi {
	command(request: SchedulesRequest): Promise<SchedulesState>;
	/** A run's captured output (stdout and stderr of `omp -p`), tail-capped. */
	readLog(runId: string): Promise<string>;
	onState(callback: (state: SchedulesState) => void): () => void;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Why a draft cannot be saved, as a locale key suffix; null when it can. */
export function scheduleDraftProblem(
	draft: ScheduleDraft,
): "name" | "prompt" | "cwd" | "interval" | "time" | "days" | null {
	if (!draft.name.trim()) return "name";
	if (!draft.prompt.trim()) return "prompt";
	if (!draft.cwd || !(draft.cwd.startsWith("/") || /^[A-Za-z]:[\\/]/.test(draft.cwd))) return "cwd";
	const frequency = draft.frequency;
	if (frequency.kind === "interval") {
		const { minutes } = frequency;
		if (!Number.isInteger(minutes) || minutes < SCHEDULE_MIN_INTERVAL || minutes > SCHEDULE_MAX_INTERVAL) {
			return "interval";
		}
		return null;
	}
	if (!TIME.test(frequency.time)) return "time";
	if (!frequency.days.every(day => Number.isInteger(day) && day >= 0 && day <= 6)) return "days";
	return null;
}

/**
 * The first start strictly after `now`. An interval repeats from the previous
 * start (else from `now`); a start that fell while the app was closed is
 * skipped, so the next one is a full interval away. A daily schedule starts at
 * its local time on an allowed weekday.
 */
export function nextRunAt(frequency: ScheduleFrequency, now: Date, lastStart: Date | null): Date {
	if (frequency.kind === "interval") {
		const step = frequency.minutes * 60_000;
		const due = lastStart ? lastStart.getTime() + step : now.getTime() + step;
		return new Date(due > now.getTime() ? due : now.getTime() + step);
	}
	const match = TIME.exec(frequency.time);
	const hours = match ? Number(match[1]) : 9;
	const minutes = match ? Number(match[2]) : 0;
	for (let offset = 0; offset <= 7; offset++) {
		const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hours, minutes, 0, 0);
		if (candidate.getTime() <= now.getTime()) continue;
		if (frequency.days.length === 0 || frequency.days.includes(candidate.getDay())) return candidate;
	}
	// Unreachable with a valid weekday list; a day out runs again tomorrow at the time.
	return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hours, minutes, 0, 0);
}
