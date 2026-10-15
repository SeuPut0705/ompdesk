/**
 * Interrupted turns that continue on their own: after the network comes back
 * (a turn that ended in a network-class error while offline or just after a
 * wake) and after a relaunch (quit, crash, update). The continuation is stock's:
 * `retry` (`/retry`) for a failed turn, `restore_interrupted` (the bridge's call
 * of stock `restoreSession`, what `omp --restore` runs) for a turn cut off
 * mid-run, then `retry` when omp had closed that turn itself before it exited.
 *
 * Resume eligibility is written when a run starts or stops, never in a quit
 * hook, because a crash or SIGKILL runs no hooks: the marker file already says
 * what was running. Electron-free (the pool and the clock are injected).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { IpcTabRunOutcome } from "../shared/ipc-types";
import type { RpcResponse } from "../shared/rpc-types";
import type { SidecarLike } from "./sidecar-pool";

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
		markers.push(marker);
	}
	return markers;
}

export type ResumeAction = "restore" | "retry";

/** What a launch does with a marker. */
export function launchAction(marker: ResumeMarker): ResumeAction {
	return marker.reason === "network" ? "retry" : "restore";
}

/** The user's Stop (RPC command types): the turn it ends is never continued (`noteStopped`). */
export const STOP_COMMANDS: Record<string, true> = {
	abort: true,
	abort_and_prompt: true,
	abort_and_restore_queue: true,
};

/** Markers that count as "continuing" in the toast (a reopened card is not a continuing task). */
export function continuingCount(markers: readonly ResumeMarker[]): number {
	return markers.filter(marker => marker.reason !== "asking").length;
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

/** The marker file: one JSON array, replaced atomically so a kill mid-write leaves the old one whole. */
export class InterruptedTurnStore {
	readonly #file: string;
	#written: string | null = null;

	constructor(file: string) {
		this.#file = file;
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
		const temp = `${this.#file}.tmp`;
		try {
			mkdirSync(dirname(this.#file), { recursive: true });
			writeFileSync(temp, text);
			renameSync(temp, this.#file);
		} catch {
			// The next transition writes again; a marker that cannot be saved must not break the run.
			this.#written = null;
		}
	}
}

function sanitizeMarker(value: unknown): ResumeMarker | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	const { window, tab, device, peer, sessionPath, cwd, kind, startedAt, reason } = record;
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
	return marker;
}

/** The pool as the coordinator uses it. */
export interface ResumePool {
	resumeFacts(): ResumeFact[];
	setAwaitingConnection(tabId: string, awaiting: boolean): void;
	/** Spawn a deferred tab's process; the sidecar, or null when the tab is gone. */
	startTab(tabId: string): SidecarLike | null;
	/** The tab attached to `sessionPath`: this computer's own, or with `peer` the one it hosts for that device. */
	tabForSession(sessionPath: string, peer?: string): string | null;
	noteStopped(tabId: string): void;
}

export interface ResumeDeps {
	store: Pick<InterruptedTurnStore, "read" | "write">;
	pool: ResumePool;
	/** Connectivity: `online` is the network, `shouldWait` adds the post-wake window. */
	network: { readonly online: boolean; shouldWait(): boolean };
	/** Settings › General › Continue interrupted work after relaunch. */
	enabled(): boolean;
	/** A quit is underway: the pool is being torn down and must not rewrite the markers. */
	frozen(): boolean;
	now(): number;
	/**
	 * Open a tab for a marked session that has none (the layout was not saved in time), or for a
	 * `peer` marker the tab this computer ran for that device, waiting for it to reconnect; its tab id.
	 */
	openTab(marker: ResumeMarker): string | null;
	/** "Continuing N interrupted tasks": a toast with Stop. */
	notify(count: number): void;
}

/**
 * How long a resume waits for its tab's omp to come up. A cold spawn takes seconds; a worktree's
 * `onStart` hook can hold the start gate longer. Past this the marker is dropped: the tab is not
 * coming up, and a listener waiting on it forever would leak.
 */
export const RESUME_READY_TIMEOUT_MS = 5 * 60_000;

/**
 * Resolves once `sidecar` can take commands; false when it fails, has already failed, or is not
 * ready within {@link RESUME_READY_TIMEOUT_MS}.
 */
function whenReady(sidecar: SidecarLike): Promise<boolean> {
	if (sidecar.status === "ready") return Promise.resolve(true);
	// No further status comes on its own: `startTab` starts only an asleep tab.
	if (sidecar.status === "error" || sidecar.status === "exited") return Promise.resolve(false);
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const finish = (ready: boolean) => {
		clearTimeout(timer);
		sidecar.off("status", listener);
		resolve(ready);
	};
	const listener = (payload: { status: string }) => {
		if (payload.status === "ready") finish(true);
		else if (payload.status === "error" || payload.status === "exited") finish(false);
	};
	const timer = setTimeout(() => finish(false), RESUME_READY_TIMEOUT_MS);
	sidecar.on("status", listener);
	return promise;
}

export class TurnResume {
	readonly #deps: ResumeDeps;
	/** Tabs holding a continuation until the connection is back, and what to run then. */
	readonly #waiting = new Map<string, ResumeAction>();
	/** Launch markers whose turn has not started yet: kept in the file so a second crash still resumes them. */
	#pending = new Map<string, ResumeMarker>();
	/** Run outcomes already judged (a Cancel must not re-arm the wait). */
	readonly #judged = new WeakSet<IpcTabRunOutcome>();
	/** Stock auto-retries already taken over (one per `auto_retry_start`). */
	readonly #takenOver = new WeakSet<{ errorMessage: string }>();
	/** Tabs this launch resumed, for the toast's Stop. */
	readonly #resumed = new Set<string>();
	/**
	 * Per tab, bumped whenever its continuation is called off: Stop, Cancel, or a new run in its place.
	 * A continuation captures it when it starts and sends nothing once it moved, so the call-off also
	 * reaches a resume still waiting for its omp to come up.
	 */
	readonly #cancels = new Map<string, number>();
	/** Held tabs whose taken-over run (stock's retry saga) has not ended yet: its end comes next, not a new run. */
	readonly #takenOverRuns = new Set<string>();
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
		for (const fact of current) {
			if (fact.running) this.#pending.delete(fact.tabId);
		}
		const live = deriveMarkers(current, this.#previous, this.#deps.now()).filter(
			marker => !this.#pending.has(marker.tab),
		);
		const kept = this.#deps.enabled() ? [...this.#pending.values(), ...live] : [];
		this.#previous = kept;
		this.#deps.store.write(kept);
	}

	#judge(fact: ResumeFact): void {
		if (fact.lastRun) this.#takenOverRuns.delete(fact.tabId);
		// A run that is neither the held one (stock's retry saga, or the failed run with its outcome) nor
		// still ending started during the wait: the user sent a new prompt. It replaces the held
		// continuation, so the waiting row goes and nothing retries into the live run once online.
		if (
			this.#waiting.has(fact.tabId) &&
			fact.running &&
			!fact.retry &&
			!fact.lastRun &&
			!this.#takenOverRuns.has(fact.tabId)
		) {
			this.#dropWait(fact.tabId);
		}
		this.#takeOverRetry(fact);
		// The outcome is the run's final one (main sets it at the last end event), even while
		// background work keeps the session unsettled: judging it now puts the wait on screen
		// before the renderer sees the failure.
		const outcome = fact.lastRun;
		if (!outcome || this.#judged.has(outcome)) return;
		this.#judged.add(outcome);
		// It ended while the wait already held it (stock's retry, taken over): nothing more to decide.
		if (fact.awaitingConnection) return;
		if (outcome.stopReason !== "error" || !isNetworkError(outcome.errorMessage)) return;
		if (!this.#deps.network.shouldWait()) return;
		this.#hold(fact.tabId, "retry");
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
		if (!fact.awaitingConnection) this.#hold(fact.tabId, "retry");
		void this.#deps.pool
			.startTab(fact.tabId)
			?.rpcClient?.command({ type: "abort_retry" })
			.catch(() => undefined);
	}

	#hold(tabId: string, action: ResumeAction): void {
		this.#waiting.set(tabId, action);
		this.#deps.pool.setAwaitingConnection(tabId, true);
		if (this.#deps.network.online) void this.flush();
	}

	/** The network is back (or already was): run every held continuation. */
	async flush(): Promise<void> {
		if (!this.#deps.network.online) return;
		const held = [...this.#waiting];
		this.#waiting.clear();
		await Promise.all(
			held.map(async ([tabId, action]) => {
				this.#takenOverRuns.delete(tabId);
				this.#deps.pool.setAwaitingConnection(tabId, false);
				await this.#run(tabId, action);
			}),
		);
	}

	async #run(tabId: string, action: ResumeAction): Promise<boolean> {
		const generation = this.#cancels.get(tabId) ?? 0;
		const cancelled = () => (this.#cancels.get(tabId) ?? 0) !== generation;
		const sidecar = this.#deps.pool.startTab(tabId);
		if (!sidecar || !(await whenReady(sidecar)) || cancelled()) {
			this.#pending.delete(tabId);
			this.sync();
			return false;
		}
		const send = async (type: "restore_interrupted" | "retry"): Promise<boolean> => {
			if (cancelled()) return false;
			let response: RpcResponse | undefined;
			try {
				response = await sidecar.rpcClient?.command({ type });
			} catch {
				response = undefined;
			}
			const data: unknown = response?.success ? response.data : undefined;
			return (
				typeof data === "object" &&
				data !== null &&
				(("turn" in data && data.turn === true) ||
					("retried" in data && data.retried === true) ||
					("subagents" in data && Array.isArray(data.subagents) && data.subagents.length > 0))
			);
		};
		// omp outlives a killed OMPdesk long enough to close the turn itself: its RPC client is gone (stdin EOF),
		// so a pending ask or approval fails ("RPC client disconnected…") and the run ends aborted, journaled.
		// Stock `restoreSession` then finds nothing unfinished; stock `retry` (`/retry`) replays that failed tool
		// batch (the card reopens) or the aborted reply, and does nothing for a turn that really ended.
		const started =
			action === "restore" ? (await send("restore_interrupted")) || (await send("retry")) : await send("retry");
		// Nothing left to continue (or the call failed): the marker has nothing more to say.
		if (!started) this.#pending.delete(tabId);
		this.sync();
		return started;
	}

	/** The user's Cancel on the waiting row: the failure shows as it would have, nothing resumes. */
	cancelWait(tabId: string): void {
		this.#dropWait(tabId);
		this.sync();
	}

	#dropWait(tabId: string): void {
		this.#cancels.set(tabId, (this.#cancels.get(tabId) ?? 0) + 1);
		this.#waiting.delete(tabId);
		this.#takenOverRuns.delete(tabId);
		this.#pending.delete(tabId);
		this.#deps.pool.setAwaitingConnection(tabId, false);
	}

	/** The toast's Stop: abort what this launch resumed, drop what still waits. */
	async stopResumed(): Promise<void> {
		const tabs = [...this.#resumed];
		this.#resumed.clear();
		await Promise.all(
			tabs.map(async tabId => {
				this.#deps.pool.noteStopped(tabId);
				this.cancelWait(tabId);
				await this.#deps.pool
					.startTab(tabId)
					?.rpcClient?.command({ type: "abort" })
					.catch(() => undefined);
			}),
		);
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
		const markers = this.#deps.store.read();
		this.#launched = true;
		if (!this.#deps.enabled()) {
			this.#deps.store.write([]);
			return;
		}
		const resumable: Array<{ tabId: string; marker: ResumeMarker; action: ResumeAction }> = [];
		for (const marker of markers) {
			const action = launchAction(marker);
			const tabId = this.#deps.pool.tabForSession(marker.sessionPath, marker.peer) ?? this.#deps.openTab(marker);
			if (!tabId) continue;
			resumable.push({ tabId, marker, action });
			this.#pending.set(tabId, { ...marker, tab: tabId });
		}
		this.#previous = [...this.#pending.values()];
		this.#deps.store.write(this.#previous);
		const continuing = continuingCount(resumable.map(item => item.marker));
		for (const { tabId, marker, action } of resumable) {
			if (marker.reason !== "asking") this.#resumed.add(tabId);
			if (this.#deps.network.shouldWait()) this.#hold(tabId, action);
			else void this.#run(tabId, action);
		}
		if (continuing > 0) this.#deps.notify(continuing);
	}
}
