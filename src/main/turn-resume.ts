/**
 * Interrupted turns that continue on their own: after the network comes back
 * (a turn that ended in a network-class error while offline or just after a
 * wake) and after a relaunch (quit, crash, update). The continuation is stock's:
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
 */
import { existsSync, readFileSync } from "node:fs";
import { parseAgentMessage } from "../shared/agent-control";
import type { IpcScheduledRetry, IpcTabRunOutcome } from "../shared/ipc-types";
import type { RpcResponse } from "../shared/rpc-types";
import { writeFileAtomicDeferred } from "./atomic-file";
import { canonicalCwd } from "./canonical-cwd";
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
	| "network";

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
	/** A turn is in flight (not a bare compaction). */
	running: boolean;
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
	/** The tab whose agent opened this one (`ompdesk_session_open`), and that opener's session file. */
	openedBy?: string;
	openedBySession?: string;
}

/**
 * Which tabs are worth resuming and why. A tab the user stopped is never one; a
 * turn blocked on a person is kept (as "asking") so it reopens its card, and a
 * turn waiting for the connection is kept so a crash during the wait still
 * resumes. `startedAt` survives a reason change within one run.
 */
export function deriveMarkers(
	facts: readonly ResumeFact[],
	previous: readonly ResumeMarker[],
	now: number,
): ResumeMarker[] {
	const markers: ResumeMarker[] = [];
	for (const fact of facts) {
		if (!fact.sessionFile) continue;
		let reason: ResumeReason | null = null;
		if (fact.awaitingConnection) reason = "network";
		else if (fact.stopped) reason = null;
		else if (fact.awaitingUi) reason = "asking";
		else if (fact.running) reason = "running";
		if (!reason) continue;
		const before = previous.find(marker => marker.tab === fact.tabId && marker.sessionPath === fact.sessionFile);
		const marker: ResumeMarker = {
			window: fact.winId,
			tab: fact.tabId,
			sessionPath: fact.sessionFile,
			cwd: fact.cwd,
			kind: fact.kind,
			startedAt: before?.startedAt ?? now,
			reason,
		};
		if (fact.peer) marker.peer = fact.peer;
		if (fact.unsavedPrompt) marker.prompt = fact.unsavedPrompt;
		markers.push(marker);
	}
	return markers;
}

export type ResumeAction = "restore" | "retry";

/** How a tab's launch continuation ended for its goal (`ResumeDeps.goalSettled`). */
export type GoalSettlement = "resumed" | "none" | "cancelled";

/** How a tab whose omp came up again goes on (`TurnResume.relaunchContinuation`). */
export type RelaunchContinuation = "after_restore" | "now" | "off";

/** What a launch does with a marker. */
export function launchAction(marker: ResumeMarker): ResumeAction {
	return marker.reason === "network" ? "retry" : "restore";
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

/**
 * A provider/transport failure rather than the model's or the account's. A
 * subset of stock's retryable-error pattern (legacy-pi-ai-shim.ts) naming the
 * transport: server errors, rate limits and quotas are not "no connection".
 */
const NETWORK_ERROR =
	/network.?error|connection.?(error|refused|lost|reset|closed)|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENETUNREACH|ENETDOWN|EHOSTUNREACH|ETIMEDOUT|socket hang up|socket connection was closed|reset before headers|websocket.?(closed|error)|stream ended before|ended without|unable to connect|timed? out|terminated|offline|internet/i;

export function isNetworkError(message: string | undefined): boolean {
	return message !== undefined && NETWORK_ERROR.test(message);
}

/** A failed name lookup: the one network failure a reachability probe can tell from a provider's own trouble. */
const DNS_ERROR = /getaddrinfo|ENOTFOUND|EAI_AGAIN/i;
/** The host it names: stock's "Couldn't reach <host> (getaddrinfo ENOTFOUND)" or Node's "getaddrinfo ENOTFOUND <host>". */
const DNS_HOST = /couldn't reach ([a-z0-9.-]+)|(?:ENOTFOUND|EAI_AGAIN) ([a-z0-9.-]+)/i;

/** The host a DNS failure could not resolve; `""` when it names none; `null` when the failure is not a lookup's. */
export function dnsFailureHost(message: string | undefined): string | null {
	if (message === undefined || !DNS_ERROR.test(message)) return null;
	const named = DNS_HOST.exec(message);
	const host = named?.[1] ?? named?.[2] ?? "";
	return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(host) ? host.toLowerCase() : "";
}

/**
 * Stock's `RETRYABLE_PROVIDER_ERROR_PATTERN` (`extensibility/legacy-pi-ai-shim.ts`, ported from pi-ai
 * `utils/retry.ts`; not exported, and a stock function would need a live session) with its rate-limit
 * wordings removed (those are {@link NOT_TRANSIENT}) and the bare status codes word-bounded, so
 * "500000 tokens" never reads as an HTTP 500.
 */
const RETRYABLE_ERROR =
	/overloaded|\b(?:500|502|503|504|520|524|529)\b|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|upstream.?connect|reset before headers|socket hang up|socket connection was closed|timed? out|timeout|terminated|websocket.?closed|websocket.?error|ended without|stream ended before message_stop|stream ended before a terminal response event|http2 request did not get a response|retry delay|you can retry your request|try your request again|please retry your request/i;

/**
 * Failures that waiting never fixes or that other paths own: sign-in and permission, quota and rate
 * limits (stock's `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN` plus the renderer's quota-resume, which books
 * the reset), a request the provider rejected, a context that does not fit, certificates. The
 * wordings follow the renderer's `describeTurnError` (lib/messages.ts).
 */
const NOT_TRANSIENT =
	/\b(?:401|403|429|400)\b|invalid[ _-]?(?:x-)?api[ _-]?key|unauthori[sz]ed|\bforbidden\b|authenticat|not logged in|log ?in required|no api key|token (?:has )?expired|rate[ _.-]?limit|too many requests|quota|usage limit|GoUsageLimitError|FreeUsageLimitError|available balance|out of budget|billing|insufficient|ResourceExhausted|bad request|invalid[ _-]?request|prompt is too long|context[ _-](?:length|window)|maximum context|too many tokens|context_length_exceeded|input is too long|exceeds? the (?:model'?s? )?(?:context|maximum)|certificate|self[- ]signed|unable to verify the first|unable_to_(?:verify|get)_issuer|\bssl\b|\btls\b|err_tls|cert_has_expired|depth_zero_self_signed|err_cert/i;

/** A failure that stock's own retries gave up on but that a later attempt may well clear: server errors, overload, timeouts, dropped connections. */
export function isTransientError(message: string | undefined): boolean {
	if (!message || NOT_TRANSIENT.test(message)) return false;
	return RETRYABLE_ERROR.test(message) || isNetworkError(message);
}

/** Waits before each scheduled retry (the attempt count is its length): 30 s, 2 min, 10 min. */
export const SCHEDULED_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 600_000];

/** `OMP_GUI_RETRY_DELAYS_MS` (comma-separated milliseconds, e2e runs) as the waits; anything unusable keeps the default. */
export function retryDelays(raw: string | undefined): readonly number[] {
	const parsed = (raw ?? "").split(",").map(part => Number(part.trim()));
	return parsed.length > 0 && parsed.every(ms => Number.isFinite(ms) && ms > 0) ? parsed : SCHEDULED_RETRY_DELAYS_MS;
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
	const { window, tab, device, peer, sessionPath, cwd, kind, startedAt, reason, prompt } = record;
	if (
		typeof window !== "number" ||
		typeof tab !== "string" ||
		typeof sessionPath !== "string" ||
		typeof cwd !== "string" ||
		(kind !== "agent" && kind !== "chat") ||
		typeof startedAt !== "number" ||
		(reason !== "running" && reason !== "asking" && reason !== "network") ||
		// Written by a client before its host owned the resume: the host has its own marker.
		device !== undefined
	)
		return null;
	const marker: ResumeMarker = { window, tab, sessionPath, cwd, kind, startedAt, reason };
	if (typeof peer === "string" && peer) marker.peer = peer;
	if (typeof prompt === "string" && prompt) marker.prompt = prompt;
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
	/** The backoff retry after transient errors; stock `retry.enabled` (Settings › Agent behavior) turns it on and off. */
	scheduledRetry: {
		/** Waits before each attempt; its length is the attempt count. */
		delays: readonly number[];
		/** Run `run` after `ms`; the returned function cancels it. */
		schedule(run: () => void, ms: number): () => void;
	};
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
	 * resuming one (`none`: nothing said the goal was cut off, or its resume failed), or the user called it off.
	 */
	goalSettled?: (tabId: string, outcome: GoalSettlement) => void;
	/**
	 * One line of the runtime log (`gui-runtime.jsonl`, source `turn-resume`): each relaunch decision, so a
	 * turn that did not continue can be explained afterwards from the user's own files.
	 */
	log?: (message: "launch" | "marker" | "continue", details: ResumeLogDetails) => void;
}

export type ResumeLogDetails = Record<string, string | number | boolean>;

/**
 * Sessions this tab's agent opened that run now (they are children of it like its subagents, and continue on their
 * own marker): the resume's log says how many stand beside the tab it continues.
 */
export function openedRunning(facts: readonly ResumeFact[], tabId: string): number {
	const file = facts.find(fact => fact.tabId === tabId)?.sessionFile;
	return facts.filter(
		fact => fact.running && (fact.openedBy === tabId || (file !== undefined && fact.openedBySession === file)),
	).length;
}

/** What stock's `restore_interrupted` found, in a word: the cut-off turn, what it revived, or nothing. */
function restoreSummary(data: Record<string, unknown> | undefined): string {
	if (!data) return "failed";
	if (data.turn === true) return "turn";
	const parts = (["subagents", "jobs"] as const).flatMap(key => {
		const value = data[key];
		return Array.isArray(value) && value.length > 0 ? [`${key}:${value.length}`] : [];
	});
	// A turn stock could not retry (a note came after its aborted reply), continued by the bridge's follow-up.
	if (data.turnCut === true) parts.unshift("turn-behind-notes");
	return parts.length > 0 ? parts.join(",") : "nothing";
}

/**
 * How long a resume waits for its tab's omp to come up. A cold spawn takes seconds; a worktree's
 * `onStart` hook can hold the start gate longer. Past this the marker is dropped: the tab is not
 * coming up, and a listener waiting on it forever would leak.
 */
export const RESUME_READY_TIMEOUT_MS = 5 * 60_000;

/**
 * How long a continuation's `restore_interrupted` and `retry` may take. Stock's restore reads every subagent
 * transcript of the session before it answers (577 files, 1.1 GB took over 8 s on a cold relaunch, past the RPC
 * client's default 8 s, so the reply was cut and logged `failed` while stock went on reviving).
 */
export const RESUME_COMMAND_TIMEOUT_MS = 2 * 60_000;

/**
 * Resolves once `sidecar` can take commands; false when it fails, has already failed, or is not
 * ready within {@link RESUME_READY_TIMEOUT_MS}.
 */
function whenReady(sidecar: SidecarLike): Promise<boolean> {
	if (sidecar.status === "ready") return Promise.resolve(true);
	// No further status comes on its own (`startTab` starts only an asleep tab), except for a session another omp
	// still holds: the tab opens it by itself once that omp lets go (`sessionHeld`), so the continuation waits on.
	const ended = (payload: { status: string; sessionHeld?: true }) =>
		(payload.status === "error" && payload.sessionHeld !== true) || payload.status === "exited";
	if (ended(sidecar.statusPayload ?? { status: sidecar.status })) return Promise.resolve(false);
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const finish = (ready: boolean) => {
		clearTimeout(timer);
		sidecar.off("status", listener);
		resolve(ready);
	};
	const listener = (payload: { status: string; sessionHeld?: true }) => {
		if (payload.status === "ready") finish(true);
		else if (ended(payload)) finish(false);
	};
	const timer = setTimeout(() => finish(false), RESUME_READY_TIMEOUT_MS);
	sidecar.on("status", listener);
	return promise;
}

/** One tab's scheduled retry and what it was armed for: any of these changing calls it off. */
interface ArmedRetry extends IpcScheduledRetry {
	outcome: IpcTabRunOutcome;
	sessionFile: string;
	touched: number;
	cancelTimer: () => void;
}

/** The session and branch a connection wait holds for (`#movedSince`). */
interface HeldFor {
	sessionFile?: string | undefined;
	touched: number;
}

/** A tab's held continuation: what runs once online, and what it was held for. */
interface HeldWait {
	action: ResumeAction;
	since: HeldFor;
}

export class TurnResume {
	readonly #deps: ResumeDeps;
	/** Tabs holding a continuation until the connection is back, and what to run then. */
	readonly #waiting = new Map<string, HeldWait>();
	/** Tabs whose DNS failure is being probed (`#verifyNetwork`): shown as waiting until the probe decides. */
	readonly #probing = new Map<string, { outcome: IpcTabRunOutcome; sessionFile?: string; touched: number }>();
	/** Launch markers whose turn has not started yet: kept in the file so a second crash still resumes them. */
	#pending = new Map<string, ResumeMarker>();
	/** Run outcomes already judged (a Cancel must not re-arm the wait). */
	readonly #judged = new WeakSet<IpcTabRunOutcome>();
	/** Stock auto-retries already taken over (one per `auto_retry_start`). */
	readonly #takenOver = new WeakSet<{ errorMessage: string }>();
	/**
	 * Per tab, bumped whenever its continuation is called off: Stop, Cancel, or a new run in its place.
	 * A continuation captures it when it starts and sends nothing once it moved, so the call-off also
	 * reaches a resume still waiting for its omp to come up.
	 */
	readonly #cancels = new Map<string, number>();
	/** Held tabs whose taken-over run (stock's retry saga) has not ended yet: its end comes next, not a new run. */
	readonly #takenOverRuns = new Set<string>();
	/** A scheduled retry per tab (state lives here, in main, so a renderer reload keeps it). */
	readonly #scheduled = new Map<string, ArmedRetry>();
	/** Per tab, the scheduled retries sent for the current failure chain; 3 and the red card stands. */
	readonly #attempts = new Map<string, number>();
	/** Tabs whose next run is our own scheduled retry: its start is not the user's new run. */
	readonly #ownRetries = new Set<string>();
	/** Tabs showing the "continuing" row: a launch continues them and their turn has not started yet. */
	readonly #resumingShown = new Set<string>();
	#launched = false;
	#previous: ResumeMarker[] = [];

	constructor(deps: ResumeDeps) {
		this.#deps = deps;
	}

	/**
	 * Every run-state change in the pool: wait on a network error, then rewrite the marker file.
	 * A paired host's tab (`device`) is not this computer's: the host writes its marker, judges
	 * the wait by its own connection and continues it, and this tab only shows that wait.
	 */
	sync(): void {
		if (!this.#launched || this.#deps.frozen()) return;
		const facts = this.#deps.pool.resumeFacts().filter(fact => !fact.device);
		for (const fact of facts) this.#judge(fact);
		const current = this.#deps.pool.resumeFacts().filter(fact => !fact.device);
		const present = new Set<string>();
		for (const fact of current) {
			present.add(fact.tabId);
			if (fact.running) this.#pending.delete(fact.tabId);
		}
		// A closed tab has nothing left to continue: its launch marker (held offline, or still waiting for
		// its omp) leaves the file now, not when the network returns, and its bookkeeping goes with it.
		for (const tabId of [...this.#scheduled.keys()]) if (!present.has(tabId)) this.#dropScheduled(tabId);
		for (const tabs of [
			this.#pending,
			this.#waiting,
			this.#cancels,
			this.#takenOverRuns,
			this.#attempts,
			this.#ownRetries,
		])
			for (const tabId of tabs.keys()) if (!present.has(tabId)) tabs.delete(tabId);
		const live = deriveMarkers(current, this.#previous, this.#deps.now()).filter(
			marker => !this.#pending.has(marker.tab),
		);
		const kept = this.#deps.enabled() ? [...this.#pending.values(), ...live] : [];
		this.#previous = kept;
		this.#deps.store.write(kept);
		this.#showResuming();
	}

	/** The "continuing" row follows the launch markers still waiting for their turn (a reopened card is not one). */
	#showResuming(): void {
		const resuming = new Set(
			[...this.#pending.values()].filter(marker => marker.reason !== "asking").map(marker => marker.tab),
		);
		for (const tabId of resuming) {
			if (this.#resumingShown.has(tabId)) continue;
			this.#resumingShown.add(tabId);
			this.#deps.pool.setResuming(tabId, true);
		}
		for (const tabId of this.#resumingShown) {
			if (resuming.has(tabId)) continue;
			this.#resumingShown.delete(tabId);
			this.#deps.pool.setResuming(tabId, false);
		}
	}

	#judge(fact: ResumeFact): void {
		if (fact.lastRun) this.#takenOverRuns.delete(fact.tabId);
		this.#watchScheduledRetry(fact);
		// A run that is neither the held one (stock's retry saga, or the failed run with its outcome) nor
		// still ending started during the wait: the user sent a new prompt. It replaces the held
		// continuation, so the waiting row goes and nothing retries into the live run once online.
		if (
			fact.running &&
			!fact.retry &&
			!fact.lastRun &&
			!this.#takenOverRuns.has(fact.tabId) &&
			(this.#waiting.has(fact.tabId) || this.#probing.has(fact.tabId))
		) {
			this.#dropWait(fact.tabId);
		}
		// Stop while the probe runs: the row goes now, not when the probe answers.
		if (fact.stopped && this.#probing.has(fact.tabId)) this.#dropWait(fact.tabId);
		// Another session or branch on a held tab: the wait belonged to the turn it left (a failed one, or the one a
		// relaunch continues), so it ends as a probe or a scheduled retry does on the same change, and nothing
		// continues into what the tab shows now.
		const held = this.#waiting.get(fact.tabId);
		if (held && this.#movedSince(fact, held.since)) this.#dropWait(fact.tabId);
		this.#takeOverRetry(fact);
		// The outcome is the run's final one (main sets it at the last end event), even while
		// background work keeps the session unsettled: judging it now puts the wait on screen
		// before the renderer sees the failure.
		const outcome = fact.lastRun;
		if (!outcome || this.#judged.has(outcome)) return;
		this.#judged.add(outcome);
		this.#ownRetries.delete(fact.tabId);
		// It ended while the wait already held it (stock's retry, taken over): nothing more to decide.
		if (fact.awaitingConnection) return;
		if (outcome.stopReason !== "error") {
			this.#attempts.delete(fact.tabId);
			return;
		}
		if (isNetworkError(outcome.errorMessage)) {
			// Offline (or just after a wake) the connection wait owns a network failure; no second schedule.
			if (this.#deps.network.shouldWait()) {
				this.#hold(fact.tabId, "retry", { sessionFile: fact.sessionFile, touched: fact.touched ?? 0 });
				return;
			}
			const host = dnsFailureHost(outcome.errorMessage);
			if (host !== null) {
				this.#verifyNetwork(fact, outcome, host);
				return;
			}
		}
		this.#planRetry(fact, outcome);
	}

	/**
	 * A failed name lookup while the link says it is up (a dead DNS or route `net.isOnline()` never sees): when neither
	 * the failed host nor the default way out answers, the turn waits for the connection like an offline one and
	 * continues once the probe answers; otherwise the failure is the provider's and the scheduled retry decides. The
	 * tab shows the wait while the probe runs, so a failure the wait takes over never flashes red or notifies.
	 */
	#verifyNetwork(fact: ResumeFact, outcome: IpcTabRunOutcome, host: string): void {
		const tabId = fact.tabId;
		const probe = {
			outcome,
			...(fact.sessionFile === undefined ? {} : { sessionFile: fact.sessionFile }),
			touched: fact.touched ?? 0,
		};
		this.#probing.set(tabId, probe);
		this.#deps.pool.setAwaitingConnection(tabId, true);
		void this.#deps.network.verify(host || undefined).then(reachable => {
			// Cancel, a new run or another failure since: whoever ended this probe also cleared its row.
			if (this.#probing.get(tabId) !== probe) return;
			this.#probing.delete(tabId);
			const current = this.#factFor(tabId);
			// Stop, a closed tab, or another session or branch on the tab since the failure: nothing to continue.
			const holds =
				current !== undefined &&
				!this.#deps.frozen() &&
				current.lastRun === outcome &&
				!current.stopped &&
				current.sessionFile === probe.sessionFile &&
				(current.touched ?? 0) === probe.touched;
			if (holds && !reachable) {
				this.#hold(tabId, "retry", probe);
				// The marker says `network` now, so a crash during the wait still retries.
				this.sync();
				return;
			}
			this.#deps.pool.setAwaitingConnection(tabId, false);
			const after = holds ? this.#factFor(tabId) : undefined;
			if (after) this.#planRetry(after, outcome);
			this.sync();
		});
	}

	/** Whether a scheduled retry may exist for this failure now: every condition but stock `retry.enabled`, which `#stockRetryOn` reads at arm and at fire. */
	#mayRetry(fact: ResumeFact, outcome: IpcTabRunOutcome): boolean {
		return (
			!this.#deps.frozen() &&
			// A hosted tab is a paired device's invisible spend; a host's tab is its host's.
			!fact.peer &&
			!fact.device &&
			fact.sessionFile !== undefined &&
			!fact.stopped &&
			!fact.awaitingConnection &&
			fact.lastRun === outcome
		);
	}

	#factFor(tabId: string): ResumeFact | undefined {
		return this.#deps.pool.resumeFacts().find(fact => fact.tabId === tabId && !fact.device);
	}

	/** Stock's own `retry.enabled` (the user's switch for retrying): unreadable or off means we do not retry either. */
	async #stockRetryOn(tabId: string): Promise<boolean> {
		try {
			const response = await this.#deps.pool
				.startTab(tabId)
				?.rpcClient?.command({ type: "get_settings", paths: ["retry.enabled"] });
			const values = response?.success
				? (response.data as { values?: Record<string, unknown> } | undefined)?.values
				: undefined;
			return values?.["retry.enabled"] === true;
		} catch {
			return false;
		}
	}

	/** The tab's failed turn ended: arm the next backoff attempt when the failure is transient and nothing says no. */
	#planRetry(fact: ResumeFact, outcome: IpcTabRunOutcome): void {
		const tabId = fact.tabId;
		if (!isTransientError(outcome.errorMessage)) {
			this.#attempts.delete(tabId);
			return;
		}
		const used = this.#attempts.get(tabId) ?? 0;
		if (used >= this.#deps.scheduledRetry.delays.length || !this.#mayRetry(fact, outcome)) return;
		const generation = this.#cancels.get(tabId) ?? 0;
		void this.#stockRetryOn(tabId).then(on => {
			const current = this.#factFor(tabId);
			if (!on || !current || (this.#cancels.get(tabId) ?? 0) !== generation) return;
			if (this.#scheduled.has(tabId) || !this.#mayRetry(current, outcome)) return;
			this.#arm(current, outcome, used);
		});
	}

	#arm(fact: ResumeFact, outcome: IpcTabRunOutcome, used: number): void {
		const delay = this.#deps.scheduledRetry.delays[used];
		if (delay === undefined || fact.sessionFile === undefined) return;
		const max = this.#deps.scheduledRetry.delays.length;
		const at = this.#deps.now() + delay;
		const armed: ArmedRetry = {
			at,
			attempt: used + 1,
			max,
			outcome,
			sessionFile: fact.sessionFile,
			touched: fact.touched ?? 0,
			cancelTimer: () => undefined,
		};
		armed.cancelTimer = this.#deps.scheduledRetry.schedule(() => void this.#fire(fact.tabId, armed), delay);
		this.#scheduled.set(fact.tabId, armed);
		this.#deps.pool.setScheduledRetry(fact.tabId, { at, attempt: armed.attempt, max });
	}

	/** Every call-off of an armed retry: a new run of the user's, Stop, a session change, the setting off, a closed tab. */
	#watchScheduledRetry(fact: ResumeFact): void {
		const tabId = fact.tabId;
		// A new run that is neither the failed run still ending (its outcome is set; background work can
		// keep it running), stock's retry saga, nor our own retry is the user's: it ends the chain.
		if (fact.running && !fact.lastRun && !fact.retry && !this.#ownRetries.has(tabId)) {
			this.#dropScheduled(tabId);
			this.#attempts.delete(tabId);
		}
		const armed = this.#scheduled.get(tabId);
		if (armed && !this.#holds(fact, armed)) this.#dropScheduled(tabId);
	}

	#holds(fact: ResumeFact, armed: ArmedRetry): boolean {
		return (
			this.#mayRetry(fact, armed.outcome) &&
			fact.sessionFile === armed.sessionFile &&
			(fact.touched ?? 0) === armed.touched
		);
	}

	/** The armed retry's timer: re-check everything, then send stock `retry` (or hand it to the connection wait when offline). */
	async #fire(tabId: string, armed: ArmedRetry): Promise<void> {
		const stillHolds = (): boolean => {
			const fact = this.#factFor(tabId);
			return this.#scheduled.get(tabId) === armed && fact !== undefined && !fact.running && this.#holds(fact, armed);
		};
		if (this.#scheduled.get(tabId) !== armed) return;
		await this.#deps.pool.movesSettled(tabId);
		if (!stillHolds() || !(await this.#stockRetryOn(tabId)) || !stillHolds()) {
			if (this.#scheduled.get(tabId) === armed) this.#dropScheduled(tabId);
			return;
		}
		this.#releaseScheduled(tabId);
		this.#attempts.set(tabId, armed.attempt);
		this.#ownRetries.add(tabId);
		if (!this.#deps.network.online) {
			this.#hold(tabId, "retry", { sessionFile: armed.sessionFile, touched: armed.touched });
			// The marker says `network` now, so a crash during the wait still retries.
			this.sync();
			return;
		}
		// Stock has nothing to retry (or the call failed): the chain is over. A move while its omp comes up calls it off.
		if (!(await this.#run(tabId, "retry", { sessionFile: armed.sessionFile, touched: armed.touched }))) {
			this.#ownRetries.delete(tabId);
			this.#attempts.delete(tabId);
		}
	}

	#releaseScheduled(tabId: string): void {
		const armed = this.#scheduled.get(tabId);
		if (!armed) return;
		armed.cancelTimer();
		this.#scheduled.delete(tabId);
		this.#deps.pool.setScheduledRetry(tabId, undefined);
	}

	/** Call the tab's armed retry off: its timer, its row, and any attempt already on its way. */
	#dropScheduled(tabId: string): void {
		if (!this.#scheduled.has(tabId)) return;
		this.#cancels.set(tabId, (this.#cancels.get(tabId) ?? 0) + 1);
		this.#releaseScheduled(tabId);
		this.#attempts.delete(tabId);
	}

	/**
	 * Stock retries a transport failure up to `retry.maxRetries` times with its own backoff
	 * (minutes on a real omp: each refused attempt takes tens of seconds), toasting every
	 * attempt. While this computer is offline none of them can succeed, so the wait takes over
	 * at the first one: stock's pending retry is cancelled (`abort_retry`, the turn then ends
	 * failed) and stock `retry` runs once the connection is back. Right after a wake the
	 * network may already be up, so stock's own retry is left to run.
	 */
	#takeOverRetry(fact: ResumeFact): void {
		const retry = fact.retry;
		if (!retry || this.#takenOver.has(retry) || this.#deps.network.online) return;
		if (!isNetworkError(retry.errorMessage)) return;
		this.#takenOver.add(retry);
		this.#takenOverRuns.add(fact.tabId);
		if (!fact.awaitingConnection)
			this.#hold(fact.tabId, "retry", { sessionFile: fact.sessionFile, touched: fact.touched ?? 0 });
		void this.#deps.pool
			.startTab(fact.tabId)
			?.rpcClient?.command({ type: "abort_retry" })
			.catch(() => undefined);
	}

	#hold(tabId: string, action: ResumeAction, since: HeldFor): void {
		this.#waiting.set(tabId, { action, since });
		this.#deps.pool.setAwaitingConnection(tabId, true);
		if (this.#deps.network.online) void this.flush();
	}

	/**
	 * The tab went to another session or branch since its wait was taken: `touched` moved (the user's `TOUCH_COMMANDS`),
	 * or the session file it was held on is no longer the tab's. A file written after the hold (a first turn stock had
	 * not saved yet) is the same conversation, not a change.
	 */
	#movedSince(fact: ResumeFact, since: HeldFor): boolean {
		if ((fact.touched ?? 0) !== since.touched) return true;
		return since.sessionFile !== undefined && fact.sessionFile !== since.sessionFile;
	}

	/** The network is back (or already was): run every held continuation. */
	async flush(): Promise<void> {
		if (!this.#deps.network.online) return;
		const held = [...this.#waiting];
		this.#waiting.clear();
		await Promise.all(
			held.map(async ([tabId, { action, since }]) => {
				this.#takenOverRuns.delete(tabId);
				this.#deps.pool.setAwaitingConnection(tabId, false);
				await this.#run(tabId, action, since);
			}),
		);
	}

	async #run(tabId: string, action: ResumeAction, since?: HeldFor): Promise<boolean> {
		const generation = this.#cancels.get(tabId) ?? 0;
		const cancelled = () => (this.#cancels.get(tabId) ?? 0) !== generation;
		// A continuation held for one session and branch (a connection wait's, a fired scheduled retry's, a relaunch's)
		// looks again when it starts and before every command it sends: a change no sync() saw (a paired device's switch on
		// an idle tab) or one made while the omp started, or while a command took its minutes, ends it as #judge would.
		const moved = (): boolean => {
			const fact = since && this.#factFor(tabId);
			return since !== undefined && fact !== undefined && this.#movedSince(fact, since);
		};
		// The person's prompt since this continuation started starts a run that is not its own (`#judge` cannot tell it
		// from the continuation's once the wait is gone): it sends nothing more and ends `cancelled`, so stock `retry` never
		// lands in that run. Unlike a move this ends only this continuation: the person's run keeps its own wait, scheduled
		// retry and marker, which `#dropWait` would take.
		const prompted = this.#factFor(tabId)?.prompted ?? 0;
		let personTookOver = false;
		const calledOff = (): boolean => cancelled() || personTookOver;
		// Also waits for a move whose command is on its way: its `touched` counts only once it answered. A move's call-off
		// bumps the generation, so the end of this run reports `cancelled` (to Autopilot too); no second report here.
		const stale = async (): Promise<boolean> => {
			await this.#deps.pool.movesSettled(tabId);
			if (moved()) this.#dropWait(tabId, false);
			if ((this.#factFor(tabId)?.prompted ?? 0) !== prompted) personTookOver = true;
			return calledOff();
		};
		const sidecar = (await stale()) ? null : this.#deps.pool.startTab(tabId);
		const ready = sidecar ? await whenReady(sidecar) : false;
		if (ready) await stale();
		if (!sidecar || !ready || calledOff()) {
			this.#deps.log?.("continue", { tab: tabId, action, ready, cancelled: calledOff() });
			this.#pending.delete(tabId);
			this.#deps.goalSettled?.(tabId, calledOff() ? "cancelled" : "none");
			this.sync();
			return false;
		}
		// Why a command did not answer: kept for the `continue` log line, never swallowed.
		const failures: ResumeLogDetails = {};
		const send = async (type: "restore_interrupted" | "retry"): Promise<Record<string, unknown> | undefined> => {
			if (await stale()) return undefined;
			const key = type === "retry" ? "retry" : "restore";
			let response: RpcResponse | undefined;
			try {
				response = await sidecar.rpcClient?.command({ type }, RESUME_COMMAND_TIMEOUT_MS);
			} catch (error) {
				failures[`${key}Error`] = error instanceof Error ? error.message : String(error);
				return undefined;
			}
			if (!response) failures[`${key}Error`] = "the tab has no omp connection";
			else if (!response.success) {
				failures[`${key}Error`] = response.error;
				if (response.code) failures[`${key}Code`] = response.code;
			}
			const data: unknown = response?.success ? response.data : undefined;
			return typeof data === "object" && data !== null ? { ...data } : undefined;
		};
		// Something goes on: the cut-off turn, a revived subagent (the bridge tells an idle session about it in
		// one follow-up turn), the agent told about the background jobs the restart stopped, a cut-off turn stock's
		// retry cannot see (the bridge continues it with that follow-up), or stock's retry.
		const continues = (data: Record<string, unknown> | undefined): boolean =>
			data?.turn === true ||
			data?.retried === true ||
			data?.followUp === true ||
			(Array.isArray(data?.subagents) && data.subagents.length > 0) ||
			(Array.isArray(data?.jobs) && data.jobs.length > 0);
		// omp outlives a killed OMPdesk long enough to close the turn itself: its RPC client is gone (stdin EOF),
		// so a pending ask or approval fails ("RPC client disconnected…") and the run ends aborted, journaled.
		// Stock `restoreSession` then finds nothing unfinished; stock `retry` (`/retry`) replays that failed tool
		// batch (the card reopens) or the aborted reply, and does nothing for a turn that really ended.
		const restored = action === "restore" ? await send("restore_interrupted") : undefined;
		const retried = !continues(restored) && continues(await send("retry"));
		let started = continues(restored) || retried;
		// A new session's first turn cut off before stock wrote its file left nothing to restore (its tab starts a
		// fresh session in the same folder): the prompt runs again. It leaves the marker before it is sent, so no
		// later continuation of this tab sends it a second time.
		const pending = this.#pending.get(tabId);
		const unsavedPrompt = pending?.prompt;
		let promptSent = false;
		if (pending && unsavedPrompt && !started && !(await stale())) {
			delete pending.prompt;
			const response = await sidecar.rpcClient
				?.command({ type: "prompt", message: unsavedPrompt })
				.catch(() => undefined);
			promptSent = response?.success === true;
			started = promptSent;
		}
		// Stock pauses an active goal when its session loads; one the restart cut off goes on, after the
		// restored turn (the goal's continuation waits for the session to be idle).
		let goalResumed = false;
		if (restored?.goalPausedByExit === true && !(await stale())) {
			try {
				await (this.#deps.resumeGoal ?? (id => this.#resumeGoal(id)))(tabId);
				started = true;
				goalResumed = true;
			} catch (error) {
				console.warn(`[resume] goal resume failed for ${tabId}: ${String(error)}`);
			}
		}
		const opened = openedRunning(this.#deps.pool.resumeFacts(), tabId);
		this.#deps.log?.("continue", {
			tab: tabId,
			action,
			restored: action === "restore" ? restoreSummary(restored) : "skipped",
			retried,
			prompt: promptSent,
			goal: goalResumed,
			started,
			...(restored?.followUp === true ? { followUp: true } : {}),
			// The bridge closed a turn stock's journal showed ended before its model call (restart-core `requestCutAtExit`).
			...(restored?.cutBeforeRequest === true ? { cutBeforeRequest: true } : {}),
			// What the restore judged when nothing went on: the journal's last message and exit record.
			...(!started && typeof restored?.journal === "string" ? { journal: restored.journal } : {}),
			...(opened > 0 ? { opened } : {}),
			...failures,
			...(calledOff() ? { cancelled: true } : {}),
		});
		this.#deps.goalSettled?.(tabId, goalResumed ? "resumed" : calledOff() ? "cancelled" : "none");
		// Nothing left to continue (or the call failed): the marker has nothing more to say.
		if (!started) this.#pending.delete(tabId);
		this.sync();
		return started;
	}

	/**
	 * How a tab whose omp came up with work running in its journal goes on: after this launch's continuation of its
	 * cut-off turn (a launch marker waits for it, `goalSettled` follows), at once, or not at all (Settings › General ›
	 * Continue interrupted work after relaunch is off).
	 */
	relaunchContinuation(tabId: string): RelaunchContinuation {
		if (this.#pending.has(tabId)) return "after_restore";
		return this.#deps.enabled() ? "now" : "off";
	}

	/** Stock's own resume of the paused goal, through the tab's `set_goal` (it renews an OMPdesk time limit first). */
	async #resumeGoal(tabId: string): Promise<void> {
		const response = await this.#deps.pool
			.startTab(tabId)
			?.rpcClient?.command({ type: "set_goal", action: "resume" });
		if (!response?.success) throw new Error(response?.error ?? "the tab is gone");
	}

	/** The user's Cancel on the waiting row: the failure shows as it would have, nothing resumes. */
	cancelWait(tabId: string): void {
		this.#dropWait(tabId);
		this.sync();
	}

	/**
	 * Call a tab's wait off: its probe, its held continuation, its scheduled retry. A held launch continuation (a marker
	 * in `#pending` with its wait) ends for Autopilot's goal too (`cancelled`): the run waited on this very continuation
	 * (`relaunchContinuation` "after_restore") and nothing else would tell it. `reportGoal` false for a call-off inside the
	 * continuation's own `#run`, which reports when it ends.
	 */
	#dropWait(tabId: string, reportGoal = true): void {
		const heldLaunch = this.#waiting.has(tabId) && this.#pending.has(tabId);
		this.#cancels.set(tabId, (this.#cancels.get(tabId) ?? 0) + 1);
		this.#waiting.delete(tabId);
		this.#probing.delete(tabId);
		this.#takenOverRuns.delete(tabId);
		this.#pending.delete(tabId);
		this.#ownRetries.delete(tabId);
		this.#releaseScheduled(tabId);
		this.#deps.pool.setAwaitingConnection(tabId, false);
		if (heldLaunch && reportGoal) this.#deps.goalSettled?.(tabId, "cancelled");
	}

	/** The resuming row's Stop: abort what this launch resumed on the tab, drop what still waits. */
	async stopResumed(tabId: string): Promise<void> {
		this.#deps.pool.noteStopped(tabId);
		this.cancelWait(tabId);
		recordTurnStop({ command: "abort", tab: tabId, by: "turn-resume", surface: "resuming-row" });
		await this.#deps.pool
			.startTab(tabId)
			?.rpcClient?.command({ type: "abort" })
			.catch(() => undefined);
	}

	/** The connectivity state changed. */
	connectivityChanged(): void {
		void this.flush();
	}

	/**
	 * Once per launch, after the saved windows exist: continue what the last
	 * process left running. Markers keep their file until their turns start.
	 */
	launch(): void {
		const read = this.#deps.store.read();
		// A session the user deleted is not continued, not even into a fresh tab in its folder; its marker goes. A
		// never-written session (a first turn cut off before its file) has no tombstone and still continues below.
		const markers = read.filter(marker => !deletedSessions().has(marker.sessionPath));
		if (markers.length !== read.length) this.#deps.store.write(markers);
		this.#launched = true;
		this.#deps.log?.("launch", { markers: markers.length, enabled: this.#deps.enabled() });
		if (!this.#deps.enabled()) {
			this.#deps.store.write([]);
			return;
		}
		const resumable: Array<{ tabId: string; action: ResumeAction }> = [];
		for (const marker of markers) {
			const action = launchAction(marker);
			const found = this.#deps.pool.tabForSession(marker.sessionPath, marker.peer);
			const unwritten = found ? null : this.#unwrittenSessionTab(marker);
			const tabId = found ?? unwritten ?? this.#deps.openTab(marker);
			this.#deps.log?.("marker", {
				session: marker.sessionPath,
				reason: marker.reason,
				tab: tabId ?? "none",
				via: found ? "layout" : unwritten ? "unwritten" : tabId ? "opened" : "none",
				...(marker.peer ? { peer: marker.peer } : {}),
			});
			if (!tabId) continue;
			resumable.push({ tabId, action });
			this.#pending.set(tabId, { ...marker, tab: tabId });
		}
		this.#previous = [...this.#pending.values()];
		this.#deps.store.write(this.#previous);
		this.#showResuming();
		const rank = (tabId: string) => this.#deps.pool.resumeRank?.(tabId) ?? 0;
		resumable.sort((a, b) => rank(a.tabId) - rank(b.tabId));
		for (const { tabId, action } of resumable) {
			// The continuation holds for the session the tab shows now (the marker's file; none yet for a first turn stock
			// never wrote) and its `touched`, so a session or branch change before the connection is back, or while the
			// omp comes up and the restore runs, ends it as it ends a failed turn's wait.
			const fact = this.#factFor(tabId);
			const since: HeldFor = {
				sessionFile: fact ? fact.sessionFile : this.#pending.get(tabId)?.sessionPath,
				touched: fact?.touched ?? 0,
			};
			if (this.#deps.network.shouldWait()) this.#hold(tabId, action, since);
			else void this.#run(tabId, action, since);
		}
	}

	/**
	 * The tab the saved layout restored for a session stock never wrote (a first turn cut off before its first
	 * assistant message): the layout drops a missing path (tab-layout.ts), so that tab came back as a fresh
	 * session in the same folder. It is an unclaimed local tab there with no session file yet and nothing
	 * running; null when there is none, and `openTab` opens one (which starts fresh too, see sidecar.ts).
	 */
	#unwrittenSessionTab(marker: ResumeMarker): string | null {
		if (marker.peer || existsSync(marker.sessionPath)) return null;
		const cwd = canonicalCwd(marker.cwd);
		const restored = this.#deps.pool
			.resumeFacts()
			.find(
				fact =>
					!fact.device &&
					!fact.peer &&
					fact.sessionFile === undefined &&
					!fact.running &&
					fact.kind === marker.kind &&
					canonicalCwd(fact.cwd) === cwd &&
					!this.#pending.has(fact.tabId),
			);
		return restored?.tabId ?? null;
	}
}
