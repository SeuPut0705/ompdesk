/**
 * Scheduled runs (Settings › Schedules): a prompt run as stock `omp -p` in a
 * project folder on a timer, by main, only while OMPdesk is open. Times missed
 * while the app was closed are skipped, never caught up. Stock omp has no
 * scheduler, so this one is GUI-owned; each run is one ordinary print-mode
 * session that stock saves like any other. A schedule with `wakeSession` is a session's own wake-up instead: its
 * start delivers the prompt into that existing session (a mail that starts a turn) and spawns no omp.
 */

export const SCHEDULES_COMMAND = "schedules:command";
export const SCHEDULES_LOG = "schedules:log";
export const SCHEDULES_STATE = "schedules:state";

/** Shortest and longest interval a schedule may repeat at, in minutes. */
export const SCHEDULE_MIN_INTERVAL = 5;
export const SCHEDULE_MAX_INTERVAL = 7 * 24 * 60;
/** Runs kept in the log, all schedules together; older ones and their log files go. */
export const SCHEDULE_RUNS_KEPT = 200;
/** Runs kept per schedule (a routine's run history); a schedule's older ones go first. */
export const SCHEDULE_RUNS_PER_SCHEDULE = 20;
/** Finished one-time schedules kept (off, with their runs); older ones are deleted. */
export const SCHEDULE_ONCE_DONE_KEPT = 20;
/**
 * Loop guard: event runs in a row, each asked for while the one before it was still going, after which the routine
 * is turned off instead of starting again (its own run keeps firing its trigger).
 */
export const ROUTINE_CHAIN_LIMIT = 10;
/** How often a GitHub trigger asks GitHub for news, in minutes (the shortest interval any schedule repeats at). */
export const GITHUB_POLL_MINUTES = SCHEDULE_MIN_INTERVAL;

export type ScheduleFrequency =
	| { kind: "interval"; minutes: number }
	/** Local wall-clock `HH:MM`; `days` are weekdays (0 = Sunday), empty = every day. */
	| { kind: "daily"; time: string; days: number[] }
	/** One start at `at` (ISO); then the schedule turns itself off (a follow-up set for a moment). */
	| { kind: "once"; at: string }
	/** No clock: started by its event (src/main/routines). */
	| { kind: "event"; event: ScheduleEvent };

export const GITHUB_EVENT_KINDS = ["pull_request", "issue", "ci_failure", "release", "push"] as const;
export type GithubEventKind = (typeof GITHUB_EVENT_KINDS)[number];
export const SESSION_EVENT_KINDS = ["done", "failed", "waiting"] as const;
/** A session of this computer finished a turn, failed one, or waits for the person's answer. */
export type SessionEventKind = (typeof SESSION_EVENT_KINDS)[number];

export type ScheduleEvent =
	/** `POST /hooks/<schedule id>` on this computer's web server with `Authorization: Bearer <key>`. */
	| { source: "webhook"; key: string }
	/** News on a GitHub repository (`owner/name`), asked with the person's `gh` every `GITHUB_POLL_MINUTES`. */
	| { source: "github"; repo: string; events: GithubEventKind[] }
	/** A file under `path` (absolute; a folder is watched with everything in it) was created, changed or removed. */
	| { source: "files"; path: string }
	/** New commits on a local branch of the repository at `repo` (absolute). */
	| { source: "git"; repo: string; branch: string }
	/** A session on this computer (`folder`: only those whose folder contains it). Never the bot's own sessions. */
	| { source: "session"; events: SessionEventKind[]; folder?: string }
	/**
	 * New mail in a mailbox the owner added in Settings › Schedules › Email accounts (`account`: its id or label), asked
	 * over IMAP every `EMAIL_POLL_MINUTES`. Each filter is optional text the mail must contain (case aside): `from` in
	 * its sender, `subject` in its subject, `to` in a recipient address (a plus-address such as `owner+bot@…`).
	 */
	| { source: "email"; account: string; from?: string; subject?: string; to?: string };

/** How often an email trigger asks its mailbox for new mail, in minutes. */
export const EMAIL_POLL_MINUTES = 2;

export type ScheduleEventSource = ScheduleEvent["source"];

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
	/**
	 * A session file on this computer to deliver `prompt` into at every start (`ompdesk_schedule` with `target: "self"`),
	 * instead of running it as a fresh `omp -p`. `model` and `autoApprove` mean nothing then. Never set by a paired device.
	 */
	wakeSession?: string;
}

export interface Schedule extends ScheduleDraft {
	id: string;
	createdAt: string;
	/** The paired device that saved it (its agent or Settings there): every run counts against that device's daily model limit on this computer. Absent = this computer's own. */
	device?: string;
}

/** `stopped`: ended by the user or by the app closing; `skipped`: the previous run was still going. */
export type ScheduleRunStatus = "running" | "succeeded" | "failed" | "stopped" | "skipped";

export interface ScheduleRun {
	id: string;
	scheduleId: string;
	/** `manual`: run now (a routine's Test); `event`: its trigger fired. */
	trigger: "schedule" | "manual" | "event";
	startedAt: string;
	endedAt: string | null;
	status: ScheduleRunStatus;
	exitCode: number | null;
	/** Why a run failed to start or was skipped (English; the log has the details). */
	error: string | null;
	/** What fired an event run, one line per event (English), as its prompt was told; absent otherwise. */
	detail?: string;
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

/** A new schedule's id as the save that made it reported it, with the state after it. */
export interface ScheduleCreated {
	id: string;
	state: SchedulesState;
}

/** `device`: a paired host by id (Settings follows the focused tab); absent = this computer. */
export interface SchedulesApi {
	command(request: SchedulesRequest, device?: string): Promise<SchedulesState>;
	/** A run's captured output (stdout and stderr of `omp -p`), tail-capped. */
	readLog(runId: string, device?: string): Promise<string>;
	/** This computer's schedules changed. */
	onState(callback: (state: SchedulesState) => void): () => void;
	/** A paired host's schedules changed (the host pushes them over the link). */
	onHostState(callback: (device: string, state: SchedulesState) => void): () => void;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/])/;
/** `owner/name` as GitHub spells a repository. */
export const GITHUB_REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
/** A branch name git accepts in `refs/heads/` (the common subset: no spaces, `..`, `~^:?*[\`, or leading `-`). */
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[^\s~^:?*[\\]+(?<![./])$/;

/** Why a draft cannot be saved, as a locale key suffix; null when it can. */
export function scheduleDraftProblem(
	draft: ScheduleDraft,
): "name" | "prompt" | "cwd" | "interval" | "time" | "days" | "once" | "event" | null {
	if (!draft.name.trim()) return "name";
	if (!draft.prompt.trim()) return "prompt";
	if (!draft.cwd || !ABSOLUTE.test(draft.cwd)) return "cwd";
	const frequency = draft.frequency;
	switch (frequency.kind) {
		case "interval": {
			const { minutes } = frequency;
			if (!Number.isInteger(minutes) || minutes < SCHEDULE_MIN_INTERVAL || minutes > SCHEDULE_MAX_INTERVAL)
				return "interval";
			return null;
		}
		case "daily":
			if (!TIME.test(frequency.time)) return "time";
			if (!frequency.days.every(day => Number.isInteger(day) && day >= 0 && day <= 6)) return "days";
			return null;
		case "once":
			return typeof frequency.at === "string" && Number.isFinite(Date.parse(frequency.at)) ? null : "once";
		case "event":
			return scheduleEventProblem(frequency.event) ? "event" : null;
		default:
			return "interval";
	}
}

/** Whether an event trigger is malformed (English, for the agent and the log); null when it is sound. */
export function scheduleEventProblem(event: ScheduleEvent): string | null {
	switch (event?.source) {
		case "webhook":
			return typeof event.key === "string" && event.key.length >= 16 ? null : "a webhook needs its key";
		case "github":
			if (!GITHUB_REPO.test(event.repo ?? "")) return "repo is owner/name";
			return nonEmptySubset(event.events, GITHUB_EVENT_KINDS)
				? null
				: `events are some of ${GITHUB_EVENT_KINDS.join(", ")}`;
		case "files":
			return ABSOLUTE.test(event.path ?? "") ? null : "path must be absolute";
		case "git":
			if (!ABSOLUTE.test(event.repo ?? "")) return "repo must be an absolute folder";
			return BRANCH.test(event.branch ?? "") ? null : "branch is not a branch name";
		case "session":
			if (event.folder !== undefined && (typeof event.folder !== "string" || !event.folder.trim()))
				return "folder must be text";
			return nonEmptySubset(event.events, SESSION_EVENT_KINDS)
				? null
				: `events are some of ${SESSION_EVENT_KINDS.join(", ")}`;
		case "email": {
			if (typeof event.account !== "string" || !event.account.trim() || event.account.length > 200)
				return "account names a mail account (its label or id)";
			const filters = [event.from, event.subject, event.to];
			return filters.every(
				value => value === undefined || (typeof value === "string" && value.trim() && value.length <= 200),
			)
				? null
				: "from, subject and to are short text";
		}
		default:
			return "unknown event source";
	}
}

function nonEmptySubset(values: unknown, allowed: readonly string[]): boolean {
	return Array.isArray(values) && values.length > 0 && values.every(value => allowed.includes(value));
}

/**
 * The first start strictly after `now`; null when the clock never starts it (an event trigger, a one-time schedule
 * whose moment passed). An interval repeats from the previous start (else from `now`); a start that fell while the app
 * was closed is skipped, so the next one is a full interval away. A daily schedule starts at its local time on an
 * allowed weekday. A one-time schedule's own start is spent by turning it off (`ScheduleService`), never read from its
 * runs: a Test before its moment, or a run of an earlier moment it was changed from, leaves the start where it is.
 */
export function nextRunAt(
	frequency: ScheduleFrequency,
	now: Date,
	lastStart: Date | null,
	/** The length of a minute; only a test launch shortens it (`OMP_GUI_TEST_SCHEDULE_MINUTE_MS`). */
	minuteMs = 60_000,
): Date | null {
	if (frequency.kind === "event") return null;
	if (frequency.kind === "once") {
		const at = Date.parse(frequency.at);
		return at > now.getTime() ? new Date(at) : null;
	}
	if (frequency.kind === "interval") {
		const step = frequency.minutes * minuteMs;
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

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** When a schedule starts, in English for agents and logs: "every 30 min", "Mon, Wed at 09:00", "on a webhook call". */
export function describeFrequency(frequency: ScheduleFrequency): string {
	switch (frequency.kind) {
		case "interval":
			return `every ${frequency.minutes} min`;
		case "daily": {
			const days = frequency.days.map(day => WEEKDAYS[day] ?? String(day));
			return `${days.length > 0 ? days.join(", ") : "daily"} at ${frequency.time}`;
		}
		case "once":
			return `once at ${frequency.at}`;
		case "event": {
			const event = frequency.event;
			switch (event.source) {
				case "webhook":
					return "on a webhook call";
				case "github":
					return `on GitHub ${event.events.join("/")} in ${event.repo}`;
				case "files":
					return `when files change under ${event.path}`;
				case "git":
					return `on new commits to ${event.branch} in ${event.repo}`;
				case "session":
					return `when a session ${event.events.map(kind => (kind === "waiting" ? "waits for the owner" : kind === "done" ? "finishes a turn" : "fails a turn")).join(" or ")}${event.folder ? ` in a folder containing ${event.folder}` : ""}`;
				case "email": {
					const filters = [
						event.from ? `from ${event.from}` : null,
						event.to ? `to ${event.to}` : null,
						event.subject ? `with "${event.subject}" in the subject` : null,
					].filter(Boolean);
					return `on new mail in ${event.account}${filters.length > 0 ? ` ${filters.join(", ")}` : ""}`;
				}
			}
		}
	}
}
