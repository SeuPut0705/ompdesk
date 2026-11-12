/**
 * Interrupted turns that continue on their own: after the network comes back
 * (a turn that ended in a network-class error while offline or just after a
 * wake), after a relaunch (quit, crash, update), and once a provider's limit
 * that ended a turn lets it run again. The continuation is stock's:
 * `retry` (`/retry`) for a failed turn, `restore_interrupted` (the bridge's call
 * of stock `restoreSession`, what `omp --restore` runs) for a turn cut off
 * mid-run, then `retry` when omp had closed that turn itself before it exited.
 * The restore also revives the subagents that process ran (stock), tells the
 * agent which background bash jobs it stopped (the bridge), and a goal still
 * active when it ended is resumed (`resumeGoal`), since stock pauses it at startup.
 *
 * Resume eligibility is written when a run starts or stops, never in a quit
 * hook, because a crash or SIGKILL runs no hooks: the marker file already says
 * what was running. Electron-free (the pool and the clock are injected).
 *
 * The rules and their state live in the core (`native/ompdesk/crates/core/src/resume`, hub kind `resume`); this file is
 * its client, with the class and methods main always called. Everything the rules were given is asked from here, so
 * the pool, the network, the clock, the timers and the store stay main's and stay injectable.
 *
 * What stays here, and why: the handles main holds (a tab's sidecar and its RPC client, the timers' cancel functions,
 * the status listeners), the collaborators, the marker file (`InterruptedTurnStore`: `writeFileAtomicDeferred`'s Windows
 * retry is main's), and the helpers that hold a promise or a shared parser (`MovesInFlight`, `trackMove`,
 * `personsPrompt`: `parseAgentMessage` is the page's too). The pure rules other files and tests call are calls into the
 * core.
 *
 * When the core is lost (it ended, or stopped answering within the hub's deadline) the instance is gone with its
 * state: every armed retry and its timer, every held connection wait, a probe, a continuation on its way, and the
 * listeners for a failed continuation's next `ready`. This client clears what it had shown for them (the waiting row,
 * the scheduled retry, the "continuing" row) and tells Autopilot's goal `none` for a launch continuation it was waiting
 * on, then opens a new instance on the next call and re-seeds it from what can be read again: the marker file (so a
 * run's `startedAt` and the file stay), every outcome and stock retry the pool shows now (as already judged, so an old
 * failure arms nothing), and each tab's `exits`. A failed turn that was waiting is not waited for again; the marker
 * file keeps what the last `sync()` wrote for the next launch.
 */
import { readFileSync } from "node:fs";
import { parseAgentMessage } from "../shared/agent-control";
import type { IpcScheduledRetry, IpcTabRunOutcome } from "../shared/ipc-types";
import { LIMIT_LOOK_MS, QUOTA_FALLBACK_MS } from "../shared/quota-reset";
import type { RpcCommand, RpcResponse } from "../shared/rpc-types";
import { writeFileAtomicDeferred } from "./atomic-file";
import { canonicalCwd } from "./canonical-cwd";
import { type HubItem, hub } from "./core/hub";
import { CoreError } from "./core/process";
import { deletedSessions } from "./deleted-sessions";
import { RpcTimeoutError } from "./rpc-client";
import type { SidecarLike } from "./sidecar-types";
import { recordTurnStop } from "./turn-stop-log";

export type ResumeReason =
	/** A turn was running. */
	| "running"
	/** The turn was blocked on an ask or an approval; resuming reopens that card. */
	| "asking"
	/** The turn ended in a network error and was waiting for the connection. */
	| "network"
	/** The turn ended at a provider's limit and was waiting for it to lift. */
	| "limit";

export interface ResumeMarker {
	/** The window (webContents id) that held the tab. Informational: windows are rebuilt from the saved layout. */
	window: number;
	/** The tab's runtime id in the launch that wrote the marker (`peer:<deviceId>:<rtab>` for a hosted tab). */
	tab: string;
	/** The paired device this computer ran the tab for (host-services.ts); absent = this computer's own tab. */
	peer?: string;
	sessionPath: string;
	cwd: string;
	kind: "agent" | "chat";
	startedAt: number;
	reason: ResumeReason;
	/**
	 * The run's prompt while stock had not written the new session's file yet (it does at the first assistant
	 * message): a turn cut off before that left nothing on disk, so the relaunch sends the prompt again.
	 */
	prompt?: string;
	/**
	 * The turn had ended; only background work (subagents, async jobs) kept the run on. The continuation revives and
	 * names that work through stock's restore and never retries the ended turn.
	 */
	background?: true;
}

/** What the pool knows about one tab, the only input of the marker rules. */
export interface ResumeFact {
	tabId: string;
	winId: number;
	/**
	 * Paired host the tab runs on. Such a tab is skipped: its host holds the marker, the
	 * connection wait and the continuation, and this computer only mirrors the wait.
	 */
	device?: string;
	/** The paired device a tab this computer hosts runs for. */
	peer?: string;
	sessionFile?: string;
	cwd: string;
	kind: "agent" | "chat";
	/** A run is on: a turn in flight, or the background work after one (not a bare compaction). */
	running: boolean;
	/** The run's turn ended; only background work (subagents, async jobs) keeps it on. */
	settling?: boolean;
	/** The user pressed Stop since the run began. */
	stopped: boolean;
	/** An ask or approval is open on this tab. */
	awaitingUi: boolean;
	/** The tab waits for the connection to continue. */
	awaitingConnection: boolean;
	lastRun?: IpcTabRunOutcome;
	/** Stock's auto-retry saga waiting for its next attempt (one object per `auto_retry_start`), with the failure it retries. */
	retry?: { errorMessage: string };
	/**
	 * How often the tab moved to another session or branch since it opened (`movesTab`: main's command path for a window's
	 * tab, the host's for a device's); a scheduled retry armed, or a connection wait held, at another count is called off.
	 */
	touched?: number;
	/**
	 * How often the person sent the tab a prompt of their own (`personsPrompt`: main's command path for a window's tab,
	 * the host's for a device's, a view's through its window tab); a continuation that started at another count is
	 * called off, since a run that began meanwhile is not its own.
	 */
	prompted?: number;
	/** The run's prompt while the new session has no file yet (see {@link ResumeMarker.prompt}). */
	unsavedPrompt?: string;
	/**
	 * How often the tab's omp died and its manager started another (`restarting`): the run died with it, so a marker
	 * the tab had then continues on the next omp as a relaunch's does.
	 */
	exits?: number;
	/** The tab whose agent opened this one (`ompdesk_session_open`), and that opener's session file. */
	openedBy?: string;
	openedBySession?: string;
}

/**
 * Which tabs are worth resuming and why. A tab the user stopped is never one; a turn
 * blocked on a person is kept (as "asking") so it reopens its card, a turn waiting for
 * the connection is kept so a crash during the wait still resumes, and so is one waiting
 * for a provider's limit (`limited`: the tabs holding such a wait). `startedAt` survives a
 * reason change within one run. The rule is the core's.
 */
export function deriveMarkers(
	facts: readonly ResumeFact[],
	previous: readonly ResumeMarker[],
	now: number,
	limited?: ReadonlySet<string>,
): ResumeMarker[] {
	return pure("deriveMarkers", {
		facts: facts.map(fact => wireFact(fact)),
		previous,
		now,
		limited: [...(limited ?? [])],
	});
}

/** `revive`: stock's restore alone, for a turn that had ended (its background work goes on, the turn is never retried). */
export type ResumeAction = "restore" | "retry" | "revive";

/** How a tab's launch continuation ended for its goal (`ResumeDeps.goalSettled`). */
export type GoalSettlement = "resumed" | "none" | "cancelled";

/** How a tab whose omp came up again goes on (`TurnResume.relaunchContinuation`). */
export type RelaunchContinuation = "after_restore" | "now" | "off";

/** What a launch does with a marker: a turn that waited for the connection or a limit had failed, so stock retries it. */
export function launchAction(marker: ResumeMarker): ResumeAction {
	return pure("launchAction", { marker });
}

/**
 * Commands that change which session, or which branch of it, a tab shows (RPC command types): a
 * scheduled retry belongs to the failed turn it was armed for, so after one of these it is called off.
 * `fork_from` ("Branch from here") is none: it writes a new session for another window and leaves this tab on its own.
 */
export const TOUCH_COMMANDS: Record<string, true> = {
	new_session: true,
	switch_session: true,
	fork: true,
	branch: true,
	switch_leaf: true,
};

/** Whether a command's answer moved its tab to another session or branch: a `TOUCH_COMMANDS` one that worked and was not cancelled. */
export function movesTab(type: string, response: RpcResponse): boolean {
	return (
		TOUCH_COMMANDS[type] === true &&
		response.success &&
		(response.data as { cancelled?: boolean } | undefined)?.cancelled !== true
	);
}

/** Whether a command sends the tab a prompt of the person's own (an agent's message is wrapped, and is none): their run is theirs. */
export function personsPrompt(command: { type: string; message?: unknown }): boolean {
	return (
		(command.type === "prompt" || command.type === "steer" || command.type === "follow_up") &&
		typeof command.message === "string" &&
		parseAgentMessage(command.message) === null
	);
}

/**
 * Whether a failed command may still have moved its tab: a `TOUCH_COMMANDS` one that timed out. omp may have run it
 * (the bridge moved though the caller heard nothing: `switch_leaf` with a summary outlives the renderer's 8 s), so its
 * outcome is unknown and counts as a move: a wait or retry of the old session ends rather than runs into the new one.
 */
export function movesTabUnknown(type: string, error: unknown): boolean {
	return TOUCH_COMMANDS[type] === true && error instanceof RpcTimeoutError;
}

/**
 * Moves whose command is on its way, per tab. Their answer is what `touched` counts, so a continuation that looks at
 * `touched` between a move's send and its answer would see the old session as current: it waits for them (`settled`).
 */
export class MovesInFlight {
	readonly #pending = new Map<string, Set<Promise<void>>>();

	/** A move's command goes out; call the result once it has answered (after `touched` counted it). */
	begin(tabId: string): () => void {
		const { promise, resolve } = Promise.withResolvers<void>();
		const pending = this.#pending.get(tabId) ?? new Set<Promise<void>>();
		this.#pending.set(tabId, pending);
		pending.add(promise);
		return () => {
			pending.delete(promise);
			if (pending.size === 0 && this.#pending.get(tabId) === pending) this.#pending.delete(tabId);
			resolve();
		};
	}

	/** Resolves once no move of the tab is on its way (also those that began while it waited). */
	async settled(tabId: string): Promise<void> {
		for (let pending = this.#pending.get(tabId); pending; pending = this.#pending.get(tabId))
			await Promise.all(pending);
	}
}

/** Where a tab's moves are counted (`touched`) and tracked while in flight. */
export interface MoveTracker {
	begin(): () => void;
	/** The command moved the tab, or may have. */
	moved(): void;
}

/**
 * Runs a command that may move its tab. A `TOUCH_COMMANDS` one is marked in flight until it answered and `touched`
 * counted it (`movesTab` for an answer that moved the tab, `movesTabUnknown` for a timeout), so nothing continues
 * between its send and its answer into a tab that is about to show another session.
 */
export async function trackMove(
	type: string,
	tracker: MoveTracker | undefined,
	run: () => Promise<RpcResponse>,
): Promise<RpcResponse> {
	if (!tracker || TOUCH_COMMANDS[type] !== true) return run();
	const end = tracker.begin();
	try {
		const response = await run();
		if (movesTab(type, response)) tracker.moved();
		return response;
	} catch (error) {
		if (movesTabUnknown(type, error)) tracker.moved();
		throw error;
	} finally {
		end();
	}
}

/** A provider/transport failure rather than the model's or the account's; the classifier is the core's. */
export function isNetworkError(message: string | undefined): boolean {
	return pure("isNetworkError", { message });
}

/** The host a failed connection could not reach; `""` when it names none; `null` when the failure is not a failed connection. */
export function connectFailureHost(message: string | undefined): string | null {
	return pure("connectFailureHost", { message });
}

/**
 * A failure that stock's own retries gave up on but that a later attempt may well clear: server errors, overload,
 * timeouts, dropped connections. Never a limit (the limit wait owns those) nor an account out of money.
 */
export function isTransientError(message: string | undefined): boolean {
	return pure("isTransientError", { message });
}

/** The wait before each scheduled retry, in order: 30 s, 2 min, 10 min; the last one repeats for as long as the failure stays transient. */
export const SCHEDULED_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 600_000];

/** `OMP_GUI_RETRY_DELAYS_MS` (comma-separated milliseconds, e2e runs) as the waits; anything unusable keeps the default. */
export function retryDelays(raw: string | undefined): readonly number[] {
	const parsed = (raw ?? "").split(",").map(part => Number(part.trim()));
	return parsed.length > 0 && parsed.every(ms => Number.isFinite(ms) && ms > 0) ? parsed : SCHEDULED_RETRY_DELAYS_MS;
}

/** `OMP_GUI_LIMIT_LOOK_MS` (milliseconds, e2e runs) as the pace of a limit wait's looks; anything unusable keeps the default. */
export function limitLook(raw: string | undefined): { limitLookMs?: number } {
	const ms = Number(raw);
	return raw !== undefined && Number.isFinite(ms) && ms > 0 ? { limitLookMs: ms } : {};
}

/**
 * The marker file: one JSON array, replaced atomically so a kill mid-write leaves the old one whole
 * (`writeFileAtomicDeferred`: a write Windows refuses is tried again, because a running turn has no later transition
 * to write it again). `onFailure` hears of one that never went through.
 */
export class InterruptedTurnStore {
	readonly #file: string;
	readonly #onFailure: ((error: unknown) => void) | undefined;
	#written: string | null = null;
	#cancel: (() => void) | undefined;

	constructor(file: string, onFailure?: (error: unknown) => void) {
		this.#file = file;
		this.#onFailure = onFailure;
	}

	read(): ResumeMarker[] {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.#file, "utf8"));
		} catch {
			return [];
		}
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((value: unknown): ResumeMarker[] => {
			const marker = sanitizeMarker(value);
			return marker ? [marker] : [];
		});
	}

	write(markers: readonly ResumeMarker[]): void {
		const text = JSON.stringify(markers);
		if (text === this.#written) return;
		this.#written = text;
		this.#cancel?.();
		this.#cancel = writeFileAtomicDeferred(this.#file, text, {}, error => {
			// The next change writes again; a marker that cannot be saved must not break the run.
			this.#written = null;
			this.#onFailure?.(error);
		});
	}
}

function sanitizeMarker(value: unknown): ResumeMarker | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	const { window, tab, device, peer, sessionPath, cwd, kind, startedAt, reason, prompt, background } = record;
	if (
		typeof window !== "number" ||
		typeof tab !== "string" ||
		typeof sessionPath !== "string" ||
		typeof cwd !== "string" ||
		(kind !== "agent" && kind !== "chat") ||
		typeof startedAt !== "number" ||
		(reason !== "running" && reason !== "asking" && reason !== "network" && reason !== "limit") ||
		// Written by a client before its host owned the resume: the host has its own marker.
		device !== undefined
	)
		return null;
	const marker: ResumeMarker = { window, tab, sessionPath, cwd, kind, startedAt, reason };
	if (typeof peer === "string" && peer) marker.peer = peer;
	if (typeof prompt === "string" && prompt) marker.prompt = prompt;
	if (background === true) marker.background = true;
	return marker;
}

/** The pool as the coordinator uses it. */
export interface ResumePool {
	resumeFacts(): ResumeFact[];
	setAwaitingConnection(tabId: string, awaiting: boolean): void;
	/** Show or clear the tab's calm "continuing where it left off" row: a relaunch continues it and its turn has not started yet. */
	setResuming(tabId: string, resuming: boolean): void;
	/** Show (or with `undefined` clear) the tab's scheduled retry. */
	setScheduledRetry(tabId: string, retry: IpcScheduledRetry | undefined): void;
	/** Spawn a deferred tab's process; the sidecar, or null when the tab is gone. */
	startTab(tabId: string): SidecarLike | null;
	/** The tab attached to `sessionPath`: this computer's own, or with `peer` the one it hosts for that device. */
	tabForSession(sessionPath: string, peer?: string): string | null;
	/** Resolves once no move of the tab is on its way (`MovesInFlight`): its `touched` is final for a continuation to judge. */
	movesSettled(tabId: string): Promise<void>;
	noteStopped(tabId: string): void;
	/** Resume order: lower first (the focused tab, then its split's panes, then the rest); default every tab alike. */
	resumeRank?(tabId: string): number;
}

export interface ResumeDeps {
	store: Pick<InterruptedTurnStore, "read" | "write">;
	pool: ResumePool;
	/**
	 * Connectivity: `online` is the network, `shouldWait` adds the post-wake window, `verify` probes the way out and the
	 * host a failed lookup named (and goes offline when neither answers).
	 */
	network: { readonly online: boolean; shouldWait(): boolean; verify(host?: string): Promise<boolean> };
	/** Settings › General › Continue interrupted work after relaunch. */
	enabled(): boolean;
	/** A quit is underway: the pool is being torn down and must not rewrite the markers. */
	frozen(): boolean;
	/**
	 * The retries main schedules: the backoff after transient errors and the wait for a provider's limit; stock
	 * `retry.enabled` (Settings › Agent behavior) turns both on and off.
	 */
	scheduledRetry: {
		/** Waits before each attempt, in order; once they run out the last one repeats, with no limit. */
		delays: readonly number[];
		/** How often, at most, a limit wait looks whether the limit lifted early; default {@link LIMIT_LOOK_MS}. */
		limitLookMs?: number;
		/** Run `run` after `ms`; the returned function cancels it. */
		schedule(run: () => void, ms: number): () => void;
	};
	/**
	 * Someone else waits out this tab's limits, so no limit wait is armed for it: a live Autopilot run's session, whose
	 * coordinator holds its own quota wait (`waiting_quota`).
	 */
	limitHeldElsewhere?: (tabId: string) => boolean;
	now(): number;
	/**
	 * Open a tab for a marked session that has none (the layout was not saved in time), or for a
	 * `peer` marker the tab this computer ran for that device, waiting for it to reconnect; its tab id.
	 */
	openTab(marker: ResumeMarker): string | null;
	/**
	 * Resume a goal stock paused at startup although it was active when the last process ended (the restore's
	 * `goalPausedByExit`). Called once, after the restore's commands; default: the tab's `set_goal` resume.
	 */
	resumeGoal?: (tabId: string) => Promise<void>;
	/**
	 * The launch continuation of a tab is over (Autopilot waits on this): it resumed the tab's goal, ended without
	 * resuming one (`none`: nothing said the goal was cut off, its resume failed, or it failed
	 * `LAUNCH_CONTINUATION_ATTEMPTS` times and is left for the next launch), or the user called it off. A failed try that
	 * will run again reports nothing.
	 */
	goalSettled?: (tabId: string, outcome: GoalSettlement) => void;
	/**
	 * One line of the runtime log (`gui-runtime.jsonl`, source `turn-resume`): each relaunch decision and each limit
	 * wait's start and try, so a turn that did not continue can be explained afterwards from the user's own files.
	 */
	log?: (message: "launch" | "marker" | "continue" | "limit", details: ResumeLogDetails) => void;
}

export type ResumeLogDetails = Record<string, string | number | boolean>;

/**
 * How long a continuation's `restore_interrupted` and `retry` may take. Stock's restore reads every subagent
 * transcript of the session before it answers (577 files, 1.1 GB took over 8 s on a cold relaunch, past the RPC
 * client's default 8 s, so the reply was cut and logged `failed` while stock went on reviving).
 */
export const RESUME_COMMAND_TIMEOUT_MS = 2 * 60_000;

/**
 * How many times one launch marker's continuation may fail (every command it sent unanswered, or its omp failed to
 * start) and be tried again in this launch, each try once its tab next reads `ready`. Past it the marker stays in the file for
 * the next launch and nothing more is sent in this one.
 */
export const LAUNCH_CONTINUATION_ATTEMPTS = 3;

// ---- the client of the core's `resume` instance ------------------------------------------------------------------------

/** One id per outcome or stock-retry object: the rules compared them by identity (judged once, the failure a hold is for). */
let epoch = 0;
if (process.env.H2_DEBUG) {
	const realSetImmediate = setImmediate;
	const bump = () => {
		epoch++;
		realSetImmediate(bump);
	};
	bump();
}
const objectIds = new WeakMap<object, number>();
let objectSequence = 0;

function idOf(value: object): number {
	let id = objectIds.get(value);
	if (id === undefined) {
		id = ++objectSequence;
		objectIds.set(value, id);
	}
	return id;
}

/**
 * A fact as the core reads it: the run's outcome and stock's retry crossed as their ids (and the words the rules read),
 * nothing else of them (a reply's 4 000 characters stay here).
 */
function wireFact(fact: ResumeFact, limitHeld?: boolean): Record<string, unknown> {
	const { lastRun, retry, ...rest } = fact;
	return {
		...rest,
		...(lastRun
			? { lastRun: { id: idOf(lastRun), stopReason: lastRun.stopReason, errorMessage: lastRun.errorMessage } }
			: {}),
		...(retry ? { retry: { id: idOf(retry), errorMessage: retry.errorMessage } } : {}),
		...(limitHeld ? { limitHeld: true } : {}),
	};
}

/** A sidecar crosses as an id; the core never holds the object (a WeakRef: a closed tab's sidecar is not kept alive). */
const sidecarIds = new WeakMap<SidecarLike, number>();
const sidecarRefs = new Map<number, WeakRef<SidecarLike>>();
let sidecarSequence = 0;

function sidecarId(sidecar: SidecarLike): number {
	let id = sidecarIds.get(sidecar);
	if (id === undefined) {
		id = ++sidecarSequence;
		sidecarIds.set(sidecar, id);
		for (const [known, ref] of sidecarRefs) if (ref.deref() === undefined) sidecarRefs.delete(known);
		sidecarRefs.set(id, new WeakRef(sidecar));
	}
	return id;
}

/** The instance the pure rules run on: they read no state, so one serves every caller. */
let helper: number | null = null;

function pure<T>(method: string, params: unknown): T {
	for (let attempt = 0; ; attempt++) {
		try {
			if (helper === null) {
				const id = hub().nextId();
				hub().open(
					id,
					"resume",
					{},
					{
						item: () => undefined,
						ask: q => {
							throw new Error(`the pure rules ask nothing (${q})`);
						},
						lost: () => {
							if (helper === id) helper = null;
						},
					},
				);
				helper = id;
			}
			return hub().call<T>(helper, method, params);
		} catch (error) {
			// A lost core opens again once; a second loss is the caller's.
			if (!(error instanceof CoreError) || attempt > 0) throw error;
			helper = null;
		}
	}
}

/** What a question's `want` list asks main to read (the instant a stretch of the rules begins). */
type Want = readonly string[];

export class TurnResume {
	readonly #deps: ResumeDeps;
	#id: number | null = null;
	/** `launch()` ran: a new instance of a lost core starts launched. */
	#launched = false;
	/** The timers the core asked for: their cancel functions. */
	readonly #timers = new Map<number, () => void>();
	/** The status listeners the core asked for, by id. */
	readonly #listeners = new Map<number, { sidecar: SidecarLike; listener: (payload: SidecarStatus) => void }>();
	/** The promises main's callers wait on (`flush`, `stopResumed`), by the token the core answered. */
	readonly #tokens = new Map<number, () => void>();
	/** A token settled before its caller had it (an item that came inside the call): settled when it is waited on. */
	readonly #settled = new Set<number>();
	/** What the core has shown the pool, to clear when it is lost: the waiting, "continuing" and scheduled-retry rows. */
	readonly #shown = { awaiting: new Set<string>(), resuming: new Set<string>(), scheduled: new Set<string>() };
	/** Tabs whose launch continuation Autopilot's goal waits on (`relaunchContinuation` said so): told `none` if the core is lost. */
	readonly #owedGoals = new Set<string>();

	constructor(deps: ResumeDeps) {
		this.#deps = deps;
	}

	/** The instance, opened (or opened again after a loss) with what can be read again. */
	#instance(): number {
		if (this.#id !== null) return this.#id;
		const id = hub().nextId();
		const deps = this.#deps;
		hub().open(
			id,
			"resume",
			{
				delays: [...deps.scheduledRetry.delays],
				limitLookMs: deps.scheduledRetry.limitLookMs ?? LIMIT_LOOK_MS,
				quotaFallbackMs: QUOTA_FALLBACK_MS,
				commandTimeoutMs: RESUME_COMMAND_TIMEOUT_MS,
				launchAttempts: LAUNCH_CONTINUATION_ATTEMPTS,
				hasResumeGoal: deps.resumeGoal !== undefined,
				...(this.#reseed ? { seed: this.#seed() } : {}),
			},
			{
				item: item => this.#item(item),
				ask: (q, item) => this.#ask(q, item),
				lost: error => this.#lost(error),
			},
		);
		this.#id = id;
		return id;
	}

	#reseed = false;

	/** What a new instance of a lost core learns: see the file's header. */
	#seed(): Record<string, unknown> {
		const facts = this.#deps.pool.resumeFacts();
		return {
			launched: this.#launched,
			previous: this.#deps.store.read(),
			judged: facts.flatMap(fact => (fact.lastRun ? [idOf(fact.lastRun)] : [])),
			takenOver: facts.flatMap(fact => (fact.retry ? [idOf(fact.retry)] : [])),
			probedRetries: facts.flatMap(fact => (fact.retry ? [idOf(fact.retry)] : [])),
			exits: Object.fromEntries(facts.map(fact => [fact.tabId, fact.exits ?? 0])),
		};
	}

	/** One call; a core lost under it opens again and the call is made once more. */
	#call<T>(method: string, params: Record<string, unknown> = {}): T {
		for (let attempt = 0; ; attempt++) {
			try {
				return hub().call<T>(this.#instance(), method, params);
			} catch (error) {
				if (!(error instanceof CoreError) || this.#id !== null || attempt > 0) throw error;
			}
		}
	}

	#lost(_error: CoreError): void {
		this.#id = null;
		this.#reseed = true;
		for (const cancel of this.#timers.values()) cancel();
		this.#timers.clear();
		for (const { sidecar, listener } of this.#listeners.values()) sidecar.off("status", listener);
		this.#listeners.clear();
		for (const settle of this.#tokens.values()) settle();
		this.#tokens.clear();
		const { awaiting, resuming, scheduled } = this.#shown;
		const rows = { awaiting: [...awaiting], resuming: [...resuming], scheduled: [...scheduled] };
		awaiting.clear();
		resuming.clear();
		scheduled.clear();
		for (const tab of rows.awaiting) this.#deps.pool.setAwaitingConnection(tab, false);
		for (const tab of rows.scheduled) this.#deps.pool.setScheduledRetry(tab, undefined);
		for (const tab of rows.resuming) this.#deps.pool.setResuming(tab, false);
		const owed = [...this.#owedGoals];
		this.#owedGoals.clear();
		for (const tab of owed) this.#deps.goalSettled?.(tab, "none");
	}

	/** The facts and settings the rules read at the instant a stretch of them begins. */
	#env(want: Want, tab?: string): Record<string, unknown> {
		const deps = this.#deps;
		const env: Record<string, unknown> = { frozen: deps.frozen() };
		if (want.includes("enabled")) env.enabled = deps.enabled();
		if (want.includes("now")) env.now = deps.now();
		if (want.includes("network")) {
			env.online = deps.network.online;
			env.shouldWait = deps.network.shouldWait();
		} else if (want.includes("online")) env.online = deps.network.online;
		if (want.includes("facts") || (want.includes("fact") && tab !== undefined)) {
			const facts = deps.pool.resumeFacts();
			const wire = (fact: ResumeFact) =>
				wireFact(fact, fact.lastRun !== undefined && deps.limitHeldElsewhere?.(fact.tabId) === true);
			if (want.includes("facts")) env.facts = facts.map(wire);
			const own = facts.find(fact => fact.tabId === tab && !fact.device);
			if (want.includes("fact") && own) env.fact = wire(own);
		}
		return env;
	}

	#sidecar(id: unknown): SidecarLike | undefined {
		return typeof id === "number" ? sidecarRefs.get(id)?.deref() : undefined;
	}

	/** What the core pushed, in order: effects whose value the rules did not use. */
	#item(item: HubItem): void {
		if (process.env.H2_DEBUG) console.error("ITEM", epoch, JSON.stringify(item).slice(0, 100));
		const deps = this.#deps;
		const tab = item.tab as string;
		switch (item.k) {
			case "setAwaiting":
				if (item.awaiting) this.#shown.awaiting.add(tab);
				else this.#shown.awaiting.delete(tab);
				deps.pool.setAwaitingConnection(tab, item.awaiting as boolean);
				break;
			case "setResuming":
				if (item.resuming) this.#shown.resuming.add(tab);
				else this.#shown.resuming.delete(tab);
				deps.pool.setResuming(tab, item.resuming as boolean);
				break;
			case "setScheduled":
				if (item.retry) this.#shown.scheduled.add(tab);
				else this.#shown.scheduled.delete(tab);
				deps.pool.setScheduledRetry(tab, (item.retry ?? undefined) as IpcScheduledRetry | undefined);
				break;
			case "storeWrite":
				deps.store.write(item.markers as ResumeMarker[]);
				break;
			case "goalSettled":
				this.#owedGoals.delete(tab);
				deps.goalSettled?.(tab, item.outcome as GoalSettlement);
				break;
			case "log":
				deps.log?.(item.message as "launch" | "marker" | "continue" | "limit", item.details as ResumeLogDetails);
				break;
			case "warn":
				console.warn(item.message as string);
				break;
			case "turnStop":
				recordTurnStop({ command: "abort", tab, by: "turn-resume", surface: "resuming-row" });
				break;
			case "abortRetry":
				void deps.pool
					.startTab(tab)
					?.rpcClient?.command({ type: "abort_retry" })
					.catch(() => undefined);
				break;
			case "schedule": {
				const timer = item.timer as number;
				if (process.env.H2_DEBUG) console.error("SCHEDULE", epoch, timer, item.ms, Date.now());
				const cancel = deps.scheduledRetry.schedule(() => {
					if (process.env.H2_DEBUG) console.error("FIRE", epoch, timer, Date.now());
					this.#timers.delete(timer);
					if (this.#id !== null) this.#call("timer", { timer });
				}, item.ms as number);
				this.#timers.set(timer, cancel);
				break;
			}
			case "cancelTimer": {
				const timer = item.timer as number;
				this.#timers.get(timer)?.();
				this.#timers.delete(timer);
				break;
			}
			case "listen":
				this.#listen(item.listener as number, this.#sidecar(item.sidecar));
				break;
			case "unlisten": {
				const attached = this.#listeners.get(item.listener as number);
				if (attached) attached.sidecar.off("status", attached.listener);
				this.#listeners.delete(item.listener as number);
				break;
			}
			case "done": {
				const token = item.token as number;
				const settle = this.#tokens.get(token);
				if (settle) {
					this.#tokens.delete(token);
					settle();
				} else this.#settled.add(token);
				break;
			}
		}
	}

	#listen(id: number, sidecar: SidecarLike | undefined): void {
		if (!sidecar) return;
		const listener = (payload: SidecarStatus) => {
			if (this.#id === null) return;
			this.#call("status", { listener: id, status: payload.status, sessionHeld: payload.sessionHeld === true });
		};
		this.#listeners.set(id, { sidecar, listener });
		sidecar.on("status", listener);
	}

	/** The promise of a token the core answered: settled by the item that says its work is done. */
	#promise(token: number | null): Promise<void> {
		if (token === null || this.#settled.delete(token)) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#tokens.set(token, resolve);
		return promise;
	}

	/** What the core asks. Collaborators the rules called synchronously answer at once; promises of main's are returned. */
	#ask(q: string, item: HubItem): unknown {
		if (process.env.H2_DEBUG) console.error("ASK", epoch, q, item.sync, (new Error().stack ?? "").split("\n").filter(l => /#drain|#call|#handle|#answer|queueMicrotask|then/.test(l)).map(l => l.trim().replace(/\(.*\)/, "").slice(0, 40)).join("|"));
		const deps = this.#deps;
		switch (q) {
			case "look": {
				const env = this.#env(item.want as Want, (item.tab ?? undefined) as string | undefined);
				// A promise when the core asked for one (`sync: false`): its answer then wakes the task in the microtasks of this one.
				return item.sync === false ? Promise.resolve(env) : env;
			}
			case "settled":
				return (async () => {
					await deps.pool.movesSettled(item.tab as string);
					return this.#env(item.want as Want, item.tab as string);
				})();
			case "startTab": {
				const sidecar = deps.pool.startTab(item.tab as string);
				if (!sidecar) return Promise.resolve(null);
				const payload = sidecar.statusPayload ?? { status: sidecar.status };
				const ended = (payload.status === "error" && payload.sessionHeld !== true) || payload.status === "exited";
				const listening = typeof item.listener === "number" && sidecar.status !== "ready" && !ended;
				if (listening) this.#listen(item.listener as number, sidecar);
				// A promise: the answer then reaches the core in the microtasks of this one, wherever its question came from.
				return Promise.resolve({
					sidecar: sidecarId(sidecar),
					status: sidecar.status,
					payloadStatus: payload.status,
					sessionHeld: payload.sessionHeld === true,
					rpc: sidecar.rpcClient !== undefined && sidecar.rpcClient !== null,
					listening,
				});
			}
			case "command":
				return (async () => {
					const client =
						typeof item.sidecar === "number"
							? this.#sidecar(item.sidecar)?.rpcClient
							: deps.pool.startTab(item.tab as string)?.rpcClient;
					if (!client) return { none: true };
					try {
						return {
							response: await client.command(item.command as RpcCommand, item.timeoutMs as number | undefined),
						};
					} catch (error) {
						return {
							error: error instanceof Error ? error.message : String(error),
							text: String(error),
							timeout: error instanceof RpcTimeoutError,
						};
					}
				})();
			case "verify":
				return deps.network.verify((item.host ?? undefined) as string | undefined);
			case "resumeGoal":
				return (async () => {
					try {
						await deps.resumeGoal?.(item.tab as string);
						return {};
					} catch (error) {
						return { error: String(error) };
					}
				})();
			case "noteStopped":
				deps.pool.noteStopped(item.tab as string);
				return null;
			case "tabForSession":
				return deps.pool.tabForSession(item.session as string, (item.peer ?? undefined) as string | undefined);
			case "openTab":
				return deps.openTab(item.marker as ResumeMarker);
			case "resumeRank":
				return (item.tabs as string[]).map(tab => deps.pool.resumeRank?.(tab) ?? 0);
			case "launchRead": {
				const markers = deps.store.read();
				return {
					markers,
					deleted: markers.map(marker => deletedSessions().has(marker.sessionPath)),
					enabled: deps.enabled(),
				};
			}
			case "canonical":
				return (item.paths as string[]).map(path => canonicalCwd(path));
			default:
				throw new Error(`turn resume has no question ${q}`);
		}
	}

	/**
	 * Every run-state change in the pool: wait on a network error, then rewrite the marker file.
	 * A paired host's tab (`device`) is not this computer's: the host writes its marker, judges
	 * the wait by its own connection and continues it, and this tab only shows that wait.
	 * A tab whose turn waits for a provider's limit keeps a `limit` marker, so a relaunch takes the turn up again.
	 */
	sync(): void {
		this.#call("sync", {
			env: this.#env(["facts", "network", "enabled", "now"]),
		});
	}

	/** The network is back (or already was): run every held continuation. */
	async flush(): Promise<void> {
		await this.#promise(this.#call<number | null>("flush", { env: this.#env(["facts", "online"]) }));
	}

	/** The connectivity state changed. */
	connectivityChanged(): void {
		void this.flush();
	}

	/**
	 * How a tab whose omp came up with work running in its journal goes on: after this launch's continuation of its
	 * cut-off turn (a launch marker waits for it, `goalSettled` follows), at once, or not at all (Settings › General ›
	 * Continue interrupted work after relaunch is off).
	 */
	relaunchContinuation(tabId: string): RelaunchContinuation {
		const answer = this.#call<RelaunchContinuation>("relaunchContinuation", {
			tab: tabId,
			enabled: this.#deps.enabled(),
		});
		if (answer === "after_restore") this.#owedGoals.add(tabId);
		return answer;
	}

	/** The user's Cancel on the waiting row: the failure shows as it would have, nothing resumes. */
	cancelWait(tabId: string): void {
		this.#call("cancelWait", { tab: tabId });
	}

	/** The resuming row's Stop: abort what this launch resumed on the tab, drop what still waits. */
	async stopResumed(tabId: string): Promise<void> {
		await this.#promise(this.#call<number>("stopResumed", { tab: tabId }));
	}

	/**
	 * Once per launch, after the saved windows exist: continue what the last
	 * process left running. Markers keep their file until their turns start.
	 */
	launch(): void {
		this.#launched = true;
		this.#call("launch");
	}
}

/** What a sidecar's `status` event carries. */
interface SidecarStatus {
	status: string;
	sessionHeld?: true;
}
