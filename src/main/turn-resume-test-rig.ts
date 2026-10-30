/**
 * One tab around a real `TurnResume`, in formal/turn-resume's bounds: the person, the tab's omp, the network, the
 * retry clock and moves on their way, each a discrete event a test applies in any order. Every continuation command
 * (`retry`, `restore_interrupted`, an unsaved first prompt, the goal resume) is checked against the model's safety
 * properties as it goes out; `violations()` adds the state properties after an event settled; `drain()` lets the
 * world heal (the model's fairness) and reports a wait, probe or scheduled retry that never ended.
 */
import { EventEmitter } from "node:events";
import type { IpcScheduledRetry, IpcTabRunOutcome } from "../shared/ipc-types";
import type { RpcCommand, RpcResponse } from "../shared/rpc-types";
import type { SidecarLike } from "./sidecar-types";
import {
	type GoalSettlement,
	MovesInFlight,
	type ResumeFact,
	type ResumeMarker,
	type ResumeReason,
	SCHEDULED_RETRY_DELAYS_MS,
	TurnResume,
} from "./turn-resume";

/** How a run ends: the model's kinds (`dns` a failed lookup, `net` a dropped socket, `transient` a server error) and success. */
export type EndKind = "dns" | "net" | "transient" | "fatal" | "ok";

const END_OUTCOMES: Record<EndKind, IpcTabRunOutcome> = {
	dns: { stopReason: "error", errorMessage: "Couldn't reach api.example.com (getaddrinfo ENOTFOUND)" },
	net: { stopReason: "error", errorMessage: "socket hang up" },
	transient: { stopReason: "error", errorMessage: "503 Service unavailable" },
	fatal: { stopReason: "error", errorMessage: "401 unauthorized" },
	ok: { stopReason: "stop" },
};

export type WorldEvent =
	| { type: "prompt" }
	| { type: "end"; kind: EndKind }
	| { type: "settle" }
	| { type: "stop" }
	| { type: "moveSend"; moves: boolean }
	| { type: "moveReply" }
	| { type: "fileMoved" }
	| { type: "cancel" }
	| { type: "stopResumed" }
	| { type: "probe"; reachable: boolean }
	| { type: "linkDown" }
	| { type: "linkUp" }
	| { type: "fire" }
	| { type: "retryAnswer"; starts: boolean }
	| { type: "restoreAnswer"; turn: boolean }
	| { type: "boot" }
	| { type: "sleep" };

export interface WorldStart {
	/** What the last process left in the marker file for this tab's session (none: nothing). */
	marker?: ResumeReason;
	online?: boolean;
	/** The tab's omp at launch: up, or still starting. */
	ready?: boolean;
}

/** The commands that continue a turn; each one is checked as it goes out. */
const CONTINUING = new Set(["retry", "restore_interrupted", "prompt", "set_goal"]);
const TAB = "t1";

export class TurnResumeWorld {
	readonly fact: ResumeFact = {
		tabId: TAB,
		winId: 1,
		cwd: "/work",
		kind: "agent",
		sessionFile: "/s/a.jsonl",
		running: false,
		stopped: false,
		awaitingUi: false,
		awaitingConnection: false,
		touched: 0,
		prompted: 0,
	};
	readonly resume: TurnResume;
	/** Every observable the resume produced, in order: the equivalence of two implementations is equal traces. */
	readonly trace: string[] = [];
	readonly goals: GoalSettlement[] = [];
	online: boolean;
	ready: boolean;
	/** A move command on its way, and whether its answer moves the tab. */
	move: { moves: boolean; end: () => void } | null = null;
	readonly #moves = new MovesInFlight();
	readonly #events = new EventEmitter();
	readonly #sidecar: SidecarLike;
	readonly #probes: Array<(reachable: boolean) => void> = [];
	readonly #retries: Array<(response: RpcResponse) => void> = [];
	readonly #restores: Array<(response: RpcResponse) => void> = [];
	readonly #timers: Array<{ run: () => void; cancelled: boolean; fired: boolean }> = [];
	#markers: ResumeMarker[] = [];
	#scheduled: IpcScheduledRetry | undefined;
	#resuming = false;
	#launched: boolean;
	/** Ghosts of the model: whose continuation a send may be (its failures and the launch's), and which were called off. */
	#owed = new Set<number>();
	#calledOff = new Set<number>();
	#nextId = 1;
	/** The person's run is live (their prompt started it and it has not ended). */
	#personLive = false;
	readonly #violations: string[] = [];

	constructor(start: WorldStart = {}) {
		this.online = start.online ?? true;
		this.ready = start.ready ?? true;
		this.#launched = start.marker !== undefined;
		const world = this;
		const status = () => (this.ready ? "ready" : "starting");
		// Getters, not values: whenReady reads the status the omp has when the continuation looks.
		this.#sidecar = Object.defineProperties(this.#events, {
			status: { get: status },
			statusPayload: { get: () => ({ status: status() }) },
			rpcClient: { value: { command: (command: RpcCommand) => this.#command(command) } },
		}) as unknown as SidecarLike;
		if (start.marker)
			this.#markers = [
				{
					window: 1,
					tab: "old",
					sessionPath: "/s/a.jsonl",
					cwd: "/work",
					kind: "agent",
					startedAt: 1,
					reason: start.marker,
				},
			];
		this.resume = new TurnResume({
			store: {
				read: () => this.#markers,
				write: markers => {
					this.#markers = [...markers];
					this.trace.push(`markers ${markers.map(marker => marker.reason).join(",")}`);
				},
			},
			pool: {
				resumeFacts: () => [{ ...this.fact }],
				setAwaitingConnection: (_tab, awaiting) => {
					this.fact.awaitingConnection = awaiting;
					this.trace.push(`awaiting ${awaiting}`);
				},
				setResuming: (_tab, resuming) => {
					this.#resuming = resuming;
					this.trace.push(`resuming ${resuming}`);
				},
				setScheduledRetry: (_tab, retry) => {
					this.#scheduled = retry;
					this.trace.push(retry ? `scheduled ${retry.attempt}` : "scheduled off");
				},
				startTab: () => this.#sidecar,
				tabForSession: path => (path === this.fact.sessionFile ? TAB : null),
				movesSettled: tab => this.#moves.settled(tab),
				noteStopped: () => {
					this.fact.stopped = true;
				},
			},
			network: {
				get online() {
					return world.online;
				},
				shouldWait: () => !this.online,
				verify: () => {
					this.trace.push("probe");
					if (!this.online) return Promise.resolve(false);
					const { promise, resolve } = Promise.withResolvers<boolean>();
					this.#probes.push(resolve);
					return promise;
				},
			},
			enabled: () => true,
			frozen: () => false,
			scheduledRetry: {
				delays: SCHEDULED_RETRY_DELAYS_MS,
				schedule: run => {
					const timer = { run, cancelled: false, fired: false };
					this.#timers.push(timer);
					return () => {
						timer.cancelled = true;
					};
				},
			},
			now: () => 0,
			openTab: () => null,
			goalSettled: (_tab, outcome) => {
				this.goals.push(outcome);
				this.trace.push(`goal ${outcome}`);
			},
		});
	}

	/** Launch (the marker file is read once) and let it settle. */
	async launch(): Promise<void> {
		if (this.#launched) this.#owed.add(0);
		this.resume.launch();
		await this.#settled();
	}

	get awaiting(): boolean {
		return this.fact.awaitingConnection;
	}
	get scheduled(): boolean {
		return this.#scheduled !== undefined;
	}
	get resuming(): boolean {
		return this.#resuming;
	}
	/** The continuation commands sent so far, by type. */
	get sent(): string[] {
		return this.trace.filter(line => line.startsWith("send ")).map(line => line.slice(5));
	}

	/** The events that can happen now (the model's enabling conditions). */
	enabled(): WorldEvent[] {
		const events: WorldEvent[] = [];
		const { running, lastRun } = this.fact;
		if (!running && this.ready) events.push({ type: "prompt" });
		if (running && !lastRun)
			for (const kind of Object.keys(END_OUTCOMES) as EndKind[]) events.push({ type: "end", kind });
		if (running && lastRun) events.push({ type: "settle" });
		if (!this.fact.stopped && (running || this.#probes.length > 0)) events.push({ type: "stop" });
		if (this.move) events.push({ type: "moveReply" });
		else events.push({ type: "moveSend", moves: true }, { type: "moveSend", moves: false });
		events.push({ type: "fileMoved" });
		if (this.awaiting || this.scheduled) events.push({ type: "cancel" });
		if (this.#resuming) events.push({ type: "stopResumed" });
		if (this.#probes.length > 0) events.push({ type: "probe", reachable: true }, { type: "probe", reachable: false });
		events.push({ type: this.online ? "linkDown" : "linkUp" });
		if (this.#timers.some(timer => !timer.cancelled && !timer.fired)) events.push({ type: "fire" });
		if (this.#retries.length > 0 && !running)
			events.push({ type: "retryAnswer", starts: true }, { type: "retryAnswer", starts: false });
		if (this.#restores.length > 0)
			events.push({ type: "restoreAnswer", turn: true }, { type: "restoreAnswer", turn: false });
		if (!this.ready) events.push({ type: "boot" });
		else if (!running) events.push({ type: "sleep" });
		return events;
	}

	async apply(event: WorldEvent): Promise<void> {
		this.trace.push(`> ${JSON.stringify(event)}`);
		const fact = this.fact;
		switch (event.type) {
			case "prompt":
				this.#callOff();
				this.#personLive = true;
				fact.prompted = (fact.prompted ?? 0) + 1;
				this.#startRun();
				break;
			case "end": {
				fact.lastRun = { ...END_OUTCOMES[event.kind] };
				this.#personLive = false;
				if (event.kind !== "ok") this.#owed.add(this.#nextId++);
				this.resume.sync();
				break;
			}
			case "settle":
				fact.running = false;
				this.resume.sync();
				break;
			case "stop":
				if (this.#probes.length > 0) this.#callOff();
				fact.stopped = true;
				this.resume.sync();
				break;
			case "moveSend":
				this.move = { moves: event.moves, end: this.#moves.begin(TAB) };
				break;
			case "moveReply": {
				const move = this.move;
				if (!move) break;
				this.move = null;
				if (move.moves) {
					this.#callOff();
					fact.touched = (fact.touched ?? 0) + 1;
					this.resume.sync();
				}
				move.end();
				break;
			}
			case "fileMoved":
				this.#callOff();
				fact.sessionFile = `/s/moved-${this.#nextId++}.jsonl`;
				// SidecarPool #registerSessionFile: only a running tab or a held wait tells the resume rules.
				if (fact.running || fact.awaitingConnection) this.resume.sync();
				break;
			case "cancel":
				this.#callOff();
				this.resume.cancelWait(TAB);
				break;
			case "stopResumed":
				this.#callOff();
				await this.resume.stopResumed(TAB);
				break;
			case "probe": {
				const answer = this.#probes.shift();
				const reachable = this.online && event.reachable;
				// ConnectivityMonitor #check: nothing answered, so the state goes offline.
				if (!event.reachable) this.online = false;
				answer?.(reachable);
				break;
			}
			case "linkDown":
				this.online = false;
				this.resume.connectivityChanged();
				break;
			case "linkUp":
				this.online = true;
				this.resume.connectivityChanged();
				break;
			case "fire": {
				const timer = this.#timers.find(candidate => !candidate.cancelled && !candidate.fired);
				if (!timer) break;
				timer.fired = true;
				timer.run();
				break;
			}
			case "retryAnswer": {
				const answer = this.#retries.shift();
				if (event.starts) this.#startRun();
				answer?.(ok("retry", { retried: event.starts }));
				break;
			}
			case "restoreAnswer": {
				const answer = this.#restores.shift();
				// Stock's restore goes on with the cut-off turn: the run starts before the answer.
				if (event.turn && !this.fact.running) this.#startRun();
				answer?.(ok("restore_interrupted", { turn: event.turn, subagents: [] }));
				break;
			}
			case "boot":
				this.ready = true;
				this.#events.emit("status", { status: "ready" });
				break;
			case "sleep":
				this.ready = false;
				break;
		}
		await this.#settled();
	}

	/** The model's safety properties broken so far (sends, then the state ones of this moment). */
	violations(): string[] {
		const found = [...this.#violations];
		// P4 MarkerNetwork: the marker file says `network` while a wait holds, so a crash during it still retries; a held
		// launch keeps its own marker, which continues it the same way (CORRESPONDENCE A9).
		const held =
			this.#markers.some(marker => marker.reason === "network") || (this.#resuming && this.#markers.length > 0);
		if (this.awaiting && !held) found.push("P4: awaiting the connection, but the marker file does not say network");
		// P5 OneOfWaitOrScheduled.
		if (this.awaiting && this.scheduled) found.push("P5: a connection wait and a scheduled retry at once");
		return found;
	}

	/**
	 * The world heals and runs out (the model's fairness): probes answer, the network and the omp come back, moves and
	 * commands answer, runs end, timers fire. What still holds after that is a wait that never ends (P3, P10).
	 */
	async drain(): Promise<string[]> {
		for (let step = 0; step < 200; step++) {
			const next = this.#healing();
			if (!next) break;
			await this.apply(next);
		}
		const stuck: string[] = [];
		if (this.#healing()) stuck.push("the world never ran out");
		if (this.awaiting) stuck.push("P3: the connection wait never ended");
		if (this.scheduled) stuck.push("P3: the scheduled retry never ended");
		if (this.#resuming) stuck.push("the continuing row never ended");
		if (this.#markers.length > 0) stuck.push(`markers left: ${this.#markers.map(marker => marker.reason)}`);
		// P10 GoalHeard: Autopilot hears how the launch continuation ended (every later `#run` end tells it again).
		if (this.#launched && this.goals.length === 0) stuck.push("P10: the launch continuation never settled its goal");
		return stuck;
	}

	#healing(): WorldEvent | null {
		const { running, lastRun } = this.fact;
		if (this.#probes.length > 0) return { type: "probe", reachable: true };
		if (!this.online) return { type: "linkUp" };
		if (!this.ready) return { type: "boot" };
		if (this.move) return { type: "moveReply" };
		if (this.#restores.length > 0) return { type: "restoreAnswer", turn: false };
		if (running && !lastRun) return { type: "end", kind: "ok" };
		if (running) return { type: "settle" };
		if (this.#retries.length > 0) return { type: "retryAnswer", starts: true };
		if (this.#timers.some(timer => !timer.cancelled && !timer.fired)) return { type: "fire" };
		return null;
	}

	#startRun(): void {
		const fact = this.fact;
		fact.running = true;
		fact.stopped = false;
		delete fact.lastRun;
		delete fact.retry;
		this.resume.sync();
	}

	/** Everything the tab owed a continuation is called off (the person's prompt, Cancel, a move, Stop on a probe). */
	#callOff(): void {
		for (const id of this.#owed) this.#calledOff.add(id);
	}

	async #command(command: RpcCommand): Promise<RpcResponse> {
		if (CONTINUING.has(command.type)) {
			this.trace.push(`send ${command.type}`);
			const live = [...this.#owed].some(id => !this.#calledOff.has(id));
			if (this.#personLive) this.#violations.push(`P1: ${command.type} sent into the person's run`);
			if (!live) this.#violations.push(`P2/P8/P11: ${command.type} sent for a called-off turn`);
			if (this.move) this.#violations.push(`P9: ${command.type} sent while a move is on its way`);
		}
		switch (command.type) {
			case "get_settings":
				return ok("get_settings", { values: { "retry.enabled": true } });
			case "retry": {
				const { promise, resolve } = Promise.withResolvers<RpcResponse>();
				this.#retries.push(resolve);
				// Stock retries the session's failed turn: what the tab owed is spent.
				this.#owed.clear();
				return promise;
			}
			case "restore_interrupted": {
				const { promise, resolve } = Promise.withResolvers<RpcResponse>();
				this.#restores.push(resolve);
				return promise;
			}
			default:
				return ok(command.type, {});
		}
	}

	/** Every promise chain the event started has run (whenReady, movesSettled, the commands' answers). */
	async #settled(): Promise<void> {
		for (let round = 0; round < 3; round++) {
			const { promise, resolve } = Promise.withResolvers<void>();
			setImmediate(resolve);
			await promise;
		}
	}
}

function ok(command: string, data: Record<string, unknown>): RpcResponse {
	return { type: "response", command, success: true, data };
}

/** A small seeded generator (mulberry32): a failing sequence replays from its seed. */
export function seeded(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let mixed = state;
		mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
		mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
	};
}
