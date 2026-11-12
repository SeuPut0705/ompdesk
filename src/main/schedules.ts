/**
 * Scheduled runs: stock `omp -p` started in a project folder when a schedule comes due, only while OMPdesk is open
 * (contract in src/shared/schedules.ts). This is the typed client of the core's schedules
 * (`native/ompdesk/crates/core/src/schedules`), which keeps the clock, the journal (`<userData>/schedules.json`), the
 * run logs (`<userData>/schedule-runs/<runId>.log`), the routines' events with their loop guard, the webhook key and
 * its check, and starts each omp under the supervisor.
 *
 * What stays here is what only main has:
 * - a copy of the state, written from the core's `schedules.state` events alone, for the readers that cannot wait
 *   (`state()`: the routine triggers read it as each change arrives);
 * - what the core asks for: whether a paired device has a model request left (`reserve`, main's `PeerQuota`), a
 *   session's own wake-up (`wake`, the control tools), and a run's omp with its environment and extensions, which
 *   `ompRunLauncher` resolves and hands to the core's launcher;
 * - the cleaning of a draft the page or an agent sent (`cleanDraft`), before the core checks and saves it.
 *
 * Requests go to the core one after the other, in the order they were made here, because the core takes requests
 * side by side: two saves, or an event and the end of the run it came during, keep their order.
 *
 * A core that ended took its timers and every omp it ran with it (the journal reads them stopped); the service opens
 * again on the next core, from the journal.
 */
import { AGENT_SCHEDULE_PREFIX } from "../shared/agent-control";
import { codedError } from "../shared/ipc-error-codes";
import {
	ROUTINE_CHAIN_LIMIT,
	SCHEDULE_ONCE_DONE_KEPT,
	SCHEDULE_RUNS_KEPT,
	SCHEDULE_RUNS_PER_SCHEDULE,
	type Schedule,
	type ScheduleCreated,
	type ScheduleDraft,
	type ScheduleFrequency,
	type SchedulesRequest,
	type SchedulesState,
} from "../shared/schedules";
import { CoreError, core } from "./core/process";
import { nativeBinPath } from "./native-bin";
import { OMP_TELEMETRY_OFF, type OmpResolution, ompPathEnv } from "./omp-runtime";
import { needsShell, spawnArgs, spawnCommand } from "./spawn";

/** How often due schedules are checked; a wall-clock check survives system sleep, a long timer would not. */
export const SCHEDULE_TICK_MS = 30_000;
/** The request kept open on the service: it fails when the core dies, which is how this side learns it. */
const HOLD_MS = 2 ** 31 - 1;
/**
 * How long a quit waits for the core to say the journal is written: what was asked before it and the journal's
 * rename, which Windows can hold back for 5 s; under the quit watchdog's 30 s.
 */
export const QUIT_SCHEDULES_CLOSE_MS = 8_000;
/** How long after a core could not take the schedules back they are offered again. */
const REOPEN_MS = 30_000;

/** One started run: `stop()` ends it, `done` settles once it ended (an omp: exited, its log flushed). */
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
	/**
	 * The clock, where a test owns it: the core then keeps no timer and reads no clock, this side checks every
	 * `tickMs` and says the time with each request. Absent: the core's own timer and the system's clock.
	 */
	now?: () => number;
}

/** What a webhook call came to (`ScheduleService.webhook`): started or kept for after the running one, or why not. */
export type WebhookOutcome = "fired" | "unknown" | "denied" | "off";

/** `schedules.start`: the core asks main to start a run. */
interface StartAsk {
	run: string;
	/** The schedule with the prompt as the run is told it (what fired it under it). */
	schedule: Schedule;
	files: { log: string; prompt: string };
	wake: boolean;
	/** The request the start was charged with (`schedules.reserve`'s `ask`). */
	charge: number | null;
}

/** Names a service and a launched omp to the core; one counter for this process. */
let sequence = 0;

/** A draft's timing as stored: unknown fields dropped. A webhook's key stays as sent (empty: the core makes or keeps one). */
function cleanFrequency(frequency: ScheduleFrequency | undefined): ScheduleFrequency {
	switch (frequency?.kind) {
		case "daily":
			return { kind: "daily", time: String(frequency.time), days: [...new Set(frequency.days)].toSorted() };
		case "once":
			return { kind: "once", at: String(frequency.at) };
		case "event": {
			const event = frequency.event;
			switch (event?.source) {
				case "webhook":
					return { kind: "event", event: { source: "webhook", key: String(event.key ?? "") } };
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

/**
 * What a draft the page, an agent or a paired device sent is saved as: every member of its own type, in the order the
 * journal keeps them. The core checks it (`scheduleDraftProblem`'s rule) and adds what the schedule already had.
 */
function cleanDraft(draft: ScheduleDraft): ScheduleDraft {
	return {
		name: String(draft.name ?? "").trim(),
		prompt: String(draft.prompt ?? ""),
		cwd: String(draft.cwd ?? ""),
		frequency: cleanFrequency(draft.frequency),
		model: typeof draft.model === "string" && draft.model.trim() ? draft.model.trim() : null,
		autoApprove: draft.autoApprove === true,
		enabled: draft.enabled === true,
		...(draft.wakeSession == null ? {} : { wakeSession: String(draft.wakeSession) }),
	};
}

/** A refusal of the core as the service threw it: a plain error with its words, the device's limit with its code. */
function refusal(error: unknown): unknown {
	if (!(error instanceof CoreError)) return error;
	if (error.code === "remote_limit_reached") return codedError("remote_limit_reached", error.message);
	return error.code === "schedule_error" || error.code === "schedules_closed" ? new Error(error.message) : error;
}

export class ScheduleService {
	readonly #options: ScheduleServiceOptions;
	readonly #name = `${process.pid}.${++sequence}`;
	/** The core's last word; replaced whole by each `schedules.state`, never changed in place. */
	#state: SchedulesState = { paused: false, schedules: [], runs: [], nextRuns: {} };
	/** The requests' queue: each is sent once the one before it was answered. */
	#lane: Promise<unknown> = Promise.resolve();
	/** The runs main started and still follows, by run id; null while one is being started. */
	readonly #runs = new Map<string, RunProcess | null>();
	/** What gives a counted request back, by the ask it answered, until its run started. */
	readonly #refunds = new Map<number, () => void>();
	#unsubscribe: (() => void)[] = [];
	#tick: NodeJS.Timeout | null = null;
	#retry: NodeJS.Timeout | null = null;
	#started = false;
	#disposed = false;
	/** The quit's close, once asked for. */
	#closing: Promise<void> | null = null;

	constructor(options: ScheduleServiceOptions) {
		this.#options = options;
	}

	/** Open the saved schedules in the core (a run left `running` by a crash ends as stopped) and start the clock. */
	async start(): Promise<void> {
		const host = core();
		const mine =
			<T>(handle: (told: T) => void) =>
			(data: unknown) => {
				// A frame of this app's own core, spelled by `schedules/mod.rs`.
				const told = data as T & { service: string };
				if (told.service === this.#name) handle(told);
			};
		this.#started = true;
		this.#unsubscribe = [
			host.on(
				"schedules.state",
				mine<{ state: SchedulesState }>(({ state }) => {
					if (this.#disposed) return;
					this.#state = state;
					this.#options.onState(state);
				}),
			),
			host.on(
				"schedules.start",
				mine<StartAsk>(ask => void this.#run(ask)),
			),
			host.on(
				"schedules.stop",
				mine<{ run: string }>(({ run }) => this.#runs.get(run)?.stop()),
			),
			host.on(
				"schedules.reserve",
				mine<{ ask: number; device: string }>(({ ask, device }) => this.#reserve(ask, device)),
			),
			host.on(
				"schedules.refund",
				mine<{ charge: number }>(({ charge }) => {
					this.#refunds.get(charge)?.();
					this.#refunds.delete(charge);
				}),
			),
		];
		await this.#opening();
	}

	/** Opens the schedules; whatever is asked meanwhile waits for it. A core that cannot take them is asked again later. */
	#opening(): Promise<void> {
		const opened = this.#open();
		this.#lane = opened.catch(() => undefined);
		opened.catch(() => {
			if (this.#disposed) return;
			this.#retry = setTimeout(() => {
				this.#opening().catch(error => console.error("[schedules] couldn't open in ompdesk-core:", error));
			}, REOPEN_MS);
			this.#retry.unref();
		});
		return opened;
	}

	async #open(): Promise<void> {
		const { file, logDir, tickMs = SCHEDULE_TICK_MS, minuteMs = 60_000, now } = this.#options;
		await this.#call("schedules.open", {
			file,
			logDir,
			tickMs,
			minuteMs,
			manual: now !== undefined,
			charges: this.#options.reserve !== undefined,
			wakes: this.#options.wake !== undefined,
			limits: {
				runsKept: SCHEDULE_RUNS_KEPT,
				runsPerSchedule: SCHEDULE_RUNS_PER_SCHEDULE,
				onceDoneKept: SCHEDULE_ONCE_DONE_KEPT,
				chainLimit: ROUTINE_CHAIN_LIMIT,
				agentPrefix: AGENT_SCHEDULE_PREFIX,
			},
		});
		if (this.#disposed) {
			// The quit came while the journal was read: its close found nothing open yet.
			await this.#call("schedules.close").catch(() => undefined);
			return;
		}
		if (now && !this.#tick) {
			this.#tick = setInterval(() => void this.#send("schedules.tick").catch(() => undefined), tickMs);
		}
		void this.#hold();
	}

	/** Keeps a request open on the service; when the core dies under it, opens the schedules on the next one. */
	async #hold(): Promise<void> {
		const host = core();
		const home = host.pid;
		while (!this.#disposed && host.pid === home) {
			try {
				await host.call("schedules.closed", { service: this.#name }, { timeoutMs: HOLD_MS });
				return;
			} catch (error) {
				if (this.#disposed) return;
				if (error instanceof CoreError && error.code === "timeout") continue;
				break;
			}
		}
		// The core's omps went with it and the journal reads them stopped; a woken session's turn goes on unfollowed.
		this.#runs.clear();
		this.#refunds.clear();
		if (this.#disposed) return;
		this.#opening().catch(error => console.error("[schedules] couldn't open in ompdesk-core:", error));
	}

	/** The schedules as the core last told them. */
	state(): SchedulesState {
		return this.#state;
	}

	/** One request to the core, at once. */
	async #call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		const now = this.#options.now;
		try {
			const sent = { service: this.#name, ...(now ? { now: now() } : {}), ...params };
			return (await core().call<T>(method, sent)).result;
		} catch (error) {
			throw refusal(error);
		}
	}

	/** One request to the core in its turn; it carries the time it was made at, not the time it is sent at. */
	#send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		const now = this.#options.now;
		const stamped = now ? { now: now(), ...params } : params;
		const sent = this.#lane.then(() => this.#call<T>(method, stamped));
		this.#lane = sent.catch(() => undefined);
		return sent;
	}

	/**
	 * An event schedule's trigger fired (src/main/routines; `detail`: one English line saying what happened). Starts a
	 * run now, or keeps the event for one more run after the running one. False when nothing will run on it: no such
	 * routine, it is no event schedule, off, everything is paused, or the app is closing.
	 */
	async fire(id: string, detail: string): Promise<boolean> {
		if (this.#disposed) return false;
		return this.#send<boolean>("schedules.fire", { id, detail });
	}

	/**
	 * `POST /hooks/<id>` with `Authorization: Bearer <key>` (src/main/web/server.ts): fires the routine whose webhook
	 * key it is. The core compares the key in constant time; any other id, source or key is `unknown`/`denied` alike
	 * to the caller's eyes only by status, never by timing of the key.
	 */
	async webhook(id: string, bearer: string, detail: string): Promise<WebhookOutcome> {
		if (this.#disposed) return "off";
		return this.#send<WebhookOutcome>("schedules.webhook", { id, bearer, detail });
	}

	/**
	 * A routine's trigger cannot watch what it names (GitHub refused, a folder is gone, git or the mailbox failed;
	 * src/main/routines tells each distinct failure once): recorded as a failed run with the reason, so the routine's
	 * history shows it, and nothing runs. False when the routine is gone, off or paused.
	 */
	async triggerFailed(id: string, reason: string): Promise<boolean> {
		if (this.#disposed) return false;
		return this.#send<boolean>("schedules.triggerFailed", { id, reason });
	}

	/**
	 * `origin`: the paired device a request comes from (`host.schedules.command`). A save from a device makes the
	 * schedule that device's (its runs count against its daily model limit here); a save here makes it this computer's.
	 * A run now from a device is charged to that device and refused past its limit.
	 */
	async command(request: SchedulesRequest, origin?: string): Promise<SchedulesState> {
		const sent = request.action === "save" ? { ...request, draft: cleanDraft(request.draft) } : request;
		return this.#send<SchedulesState>("schedules.command", { request: sent, origin });
	}

	/**
	 * Save a new schedule and say which one it is: the id comes from this save, never from a diff a concurrent save
	 * could share. `origin`: the paired device it is made for (its runs count against that device), as in `command`.
	 */
	async create(draft: ScheduleDraft, origin?: string): Promise<ScheduleCreated> {
		return this.#send<ScheduleCreated>("schedules.create", { draft: cleanDraft(draft), origin });
	}

	/** The run's captured output, from its end when long. */
	async readLog(runId: string): Promise<string> {
		return this.#send<string>("schedules.log", { run: runId });
	}

	/**
	 * Ages out what agents left (launch and hourly): an agent schedule's finished runs past seven days, and a spent
	 * one-time agent schedule, at once when its run did not fail (or it never ran: an older build kept them), or a day
	 * after a failed run ended. The owner's own schedules keep their history.
	 */
	async prune(now: number): Promise<void> {
		if (this.#disposed) return;
		await this.#send("schedules.prune", { at: now });
	}

	/**
	 * App quit: stop every run main follows (a woken session's turn; an omp's supervisor kills its tree) and have the
	 * core record them and write the journal. Resolves once the core answered that the journal is written, or after
	 * `boundMs`. The quit holds the process and the core's stop until then (`index.ts`): main's exit ends the core at
	 * once on Windows, whatever it still had to write.
	 */
	dispose(boundMs = QUIT_SCHEDULES_CLOSE_MS): Promise<void> {
		if (this.#closing) return this.#closing;
		this.#disposed = true;
		clearInterval(this.#tick ?? undefined);
		clearTimeout(this.#retry ?? undefined);
		for (const off of this.#unsubscribe) off();
		for (const process of this.#runs.values()) process?.stop();
		// A service that never asked the core for anything has nothing there to close.
		if (!this.#started) {
			this.#closing = Promise.resolve();
			return this.#closing;
		}
		// In its turn: what was asked before the quit is taken first, so the journal the close writes holds it.
		const closed = this.#send<void>("schedules.close").catch(() => undefined);
		const { promise: bound, resolve } = Promise.withResolvers<void>();
		const timer = setTimeout(resolve, boundMs);
		this.#closing = Promise.race([closed, bound]).then(() => clearTimeout(timer));
		return this.#closing;
	}

	/** Counts a start against its device, tells the core, and keeps how to give it back until the run started. */
	#reserve(ask: number, device: string): void {
		const charge = this.#options.reserve?.(device) ?? { ok: true, refund: () => undefined };
		if (charge.ok) this.#refunds.set(ask, charge.refund);
		// Not in its turn: a run now that waits for this answer holds the turn.
		this.#call("schedules.reserved", { ask, ...(charge.ok ? {} : { refused: charge.reason }) }).catch(() => {
			// A core that never heard the answer starts nothing on it.
			this.#refunds.get(ask)?.();
			this.#refunds.delete(ask);
		});
	}

	/** Starts the run the core asks for and follows it to its end. */
	async #run({ run, schedule, files, wake, charge }: StartAsk): Promise<void> {
		this.#runs.set(run, null);
		let result: { code: number | null; error?: string };
		try {
			const process = wake ? await this.#options.wake?.(schedule, run) : await this.#options.launch(schedule, files);
			if (!process) throw new Error("Waking a session is not available here");
			this.#runs.set(run, process);
			// Started: the request it was charged with is spent.
			if (charge !== null) this.#refunds.delete(charge);
			if (this.#disposed) process.stop();
			// The core sends a stop that was asked for meanwhile once it hears the run started.
			await this.#send("schedules.started", { run });
			result = await process.done;
		} catch (error) {
			result = { code: null, error: error instanceof Error ? error.message : String(error) };
		}
		this.#runs.delete(run);
		if (this.#disposed) return;
		await this.#send("schedules.ended", { run, ...result }).catch(() => undefined);
	}
}

/**
 * The production launcher: `omp -p [--model m] [--yolo]` under the supervisor, started by the core
 * (`schedules.launch`), the prompt file as its stdin, stdout and stderr appended to the run's log. This side resolves
 * what the run needs at its start: the omp, the environment, the extensions of its folder.
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
		const ompEnv: Record<string, string> = {};
		for (const [name, value] of Object.entries({
			...env,
			PATH: ompPathEnv(bin, env.PATH ?? ""),
			PI_NOTIFICATIONS: "off",
			PI_NO_PTY: "1",
			...OMP_TELEMETRY_OFF,
		}))
			if (value !== undefined) ompEnv[name] = value;
		const run = `${process.pid}.${++sequence}`;
		const host = core();
		const ended = Promise.withResolvers<{ code: number | null; error?: string }>();
		// Heard from the tick the request is sent in: the end of a supervisor that could not start comes before the answer.
		const unsubscribe = [
			host.on("schedules.launchEnded", data => {
				const told = data as { run: string; code: number | null; error?: string };
				if (told.run === run) ended.resolve(told.error === undefined ? { code: told.code } : told);
			}),
			// A core that started after the one the omp was started on holds nothing of it: it ended with its core.
			host.on("ready", () => {
				if (host.pid !== home) ended.resolve({ code: null, error: "ompdesk-core exited during the run" });
			}),
		];
		const done = ended.promise.then(({ code, error }) => {
			for (const off of unsubscribe) off();
			return error === undefined ? { code } : { code, error };
		});
		const started = host.call("schedules.launch", {
			run,
			supervisor: nativeBinPath("ompdesk-core"),
			file: spawnCommand(bin),
			args: spawnArgs(bin, args),
			shell: needsShell(bin),
			env: ompEnv,
			cwd: schedule.cwd,
			log: files.log,
			prompt: files.prompt,
			header: `$ omp ${args.join(" ")}\n# ${schedule.cwd}\n\n`,
		});
		const home = host.pid;
		try {
			await started;
		} catch (error) {
			for (const off of unsubscribe) off();
			throw error;
		}
		return {
			stop: () => {
				host.call("schedules.launchStop", { run }).catch(() => undefined);
			},
			done,
		};
	};
}
