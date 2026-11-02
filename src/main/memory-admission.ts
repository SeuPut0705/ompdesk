/**
 * New agent work waits while this computer's memory is in danger (the owner's rule of 2 Nov 2026, after the Mac
 * mini incident: AGENTS.md › Code conventions, `.omp/rules/control-tools.md` › Memory admission). Electron-free:
 * main feeds it memory readings and the measured footprint of each session's process tree (`memory-sampler.ts`),
 * and asks it before an agent starts work: a session opened or messaged by another agent, a scheduled wake, a
 * relaunch continuation. The owner's own prompts and turns already running never come here.
 *
 * Memory is in danger when the OS reports pressure (warn or critical), or when the predicted headroom is below
 * the reserve: the memory available now, minus what the sessions started in the last minutes are still expected
 * to grow by (each reserves the expected footprint until it has run `RESERVE_WINDOW_MS`, its measured tree passes
 * the reservation, or its turn ends), minus the next start's own expected footprint. On 2 Nov 2026 one call
 * opened 8 sessions while memory was still fine and they grew to about 30 GB minutes later: pressure alone
 * reports that only after the fact.
 *
 * Waiters start in order, the moment memory allows, with no time limit and no count cap. A child whose opener is
 * blocked waiting on its children is not new work: it is admitted unless pressure is critical, so a parent
 * waiting on its children can never hold them back. Children of a running opener go ahead of unrelated work.
 */
import { parseAgentMessage } from "../shared/agent-control";
import type { IpcMemoryWait } from "../shared/ipc-types";
import type { RpcCommand, RpcResponse } from "../shared/rpc-types";

export type MemoryPressure = "normal" | "warn" | "critical";

export interface MemoryReading {
	totalBytes: number;
	/** What the OS can hand out without paging: macOS `kern.memorystatus_level` % of RAM, Windows' available physical memory. */
	availableBytes: number;
	pressure: MemoryPressure;
}

/** What asks: a session opened (`open`) or messaged (`send`) by an agent, a scheduled run, a relaunch continuation. */
export type AdmissionKind = "open" | "send" | "schedule" | "resume";

export interface AdmissionRequest {
	kind: AdmissionKind;
	/** The tab the work runs in; none for a scheduled run that starts its own process. */
	tabId?: string;
	/** The session that opened it, when an agent did. */
	parentTabId?: string;
	/** Who waits, for the log and `ompdesk_sessions`. */
	label: string;
}

/** A waiting start as every view shows it (`IpcMemoryWait`). */
export type MemoryWait = IpcMemoryWait;

/** The wait a held start's answer data carries (`deliver`), when it waits. */
export function heldWait(data: unknown): IpcMemoryWait | undefined {
	if (typeof data !== "object" || data === null || !("memoryWait" in data)) return undefined;
	const wait = data.memoryWait;
	if (typeof wait !== "object" || wait === null || !("position" in wait) || typeof wait.position !== "number")
		return undefined;
	// `deliver` built it from a MemoryWait; a paired host's answer carries the same shape over the link.
	const held: IpcMemoryWait = wait as IpcMemoryWait;
	return held;
}

/**
 * A paired device's command that starts agent work in an idle tab: a prompt another session's agent wrapped
 * (`wrapAgentMessage`). The person's own prompts are never wrapped, so they never wait.
 */
export function agentPrompt(command: RpcCommand): boolean {
	return (
		command.type === "prompt" && typeof command.message === "string" && parseAgentMessage(command.message) !== null
	);
}

export type AdmissionOutcome = "admitted" | "started-now" | "cancelled";

export interface AdmissionTicket {
	readonly id: number;
	/** Admitted at the call: nothing waits. */
	readonly admittedNow: boolean;
	/** Resolves when it may start (`admitted`, `started-now` by the owner) or when it was called off. */
	readonly outcome: Promise<AdmissionOutcome>;
	cancel(): void;
}

/** One session's process tree, measured. */
export interface SessionFootprint {
	bytes: number;
	label: string;
}

export interface AdmissionStatus {
	reading: MemoryReading | null;
	/** What one more agent session is expected to grow to. */
	expectedBytes: number;
	/** Growth still expected from sessions started in the last minutes. */
	reservedBytes: number;
	reserveBytes: number;
	/** In line order. */
	waiting: Array<{ label: string; tabId?: string; kind: AdmissionKind; since: number }>;
	/** Admitted and still within their reservation. */
	starting: number;
}

export interface AdmissionDeps {
	now(): number;
	/** The person's view of the waits changed: the tabs waiting now, with their place. */
	changed(waits: ReadonlyMap<string, MemoryWait>): void;
	/** One `gui-runtime.jsonl` line. */
	log(message: string, details: Record<string, unknown>): void;
	/** Pressure turned critical: the sessions holding the most memory, largest first. */
	critical(reading: MemoryReading, top: Array<{ tabId: string; label: string; bytes: number }>): void;
	/** Memory could not be read `failures` times in a row: new agent work waits until it can (told once per streak). */
	unreadable?(failures: number): void;
	/** Whether the tab runs a turn now (its opener counts as running for its children). */
	running(tabId: string): boolean;
	/** Measured peaks of earlier agent sessions, oldest first. */
	peaks?: readonly number[];
	/** The peaks changed (to keep them across launches). */
	savePeaks?(peaks: readonly number[]): void;
}

const GiB = 1024 ** 3;
/**
 * Expected footprint before anything is measured: the incident's 29.9 GB less about 5 GB for macOS and OMPdesk,
 * over its 11 agent sessions with their checks, ≈ 2.3 GB, rounded up.
 */
export const DEFAULT_EXPECTED_BYTES = 2.5 * GiB;
/** Learned expectations stay within these. */
export const MIN_EXPECTED_BYTES = 1 * GiB;
export const MAX_EXPECTED_BYTES = 8 * GiB;
/** Peaks needed before they replace the default; how many are kept. */
const MIN_PEAKS = 3;
const KEPT_PEAKS = 20;
/** How long a started session reserves its expected growth (its checks start within minutes of its first turn). */
export const RESERVE_WINDOW_MS = 10 * 60_000;
/** Headroom kept free after a start: 15 % of RAM (2.4 GB on 16 GB), so a burst stops before the kernel's warn level. */
export const RESERVE_FRACTION = 0.15;
/**
 * How long the last good reading still decides when samples fail (6 samples of `memory-watch.ts` `SAMPLE_MS`). A
 * sampler that fails under pressure (a stuck `sysctl` or `ps`) must never open the guard: past this, memory reads as
 * unknown, and unknown holds new agent work like critical pressure.
 */
export const STALE_READING_MS = 30_000;
/** Failed samples in a row before the owner is told that new agent work waits on an unreadable memory. */
export const UNREADABLE_NOTICE_FAILURES = 3;

interface Waiter {
	id: number;
	request: AdmissionRequest;
	since: number;
	resolve(outcome: AdmissionOutcome): void;
}

interface Reservation {
	tabId?: string;
	expected: number;
	since: number;
	label: string;
}

/** The 90th percentile of `peaks` (nearest rank). */
function p90(peaks: readonly number[]): number {
	const sorted = [...peaks].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1)] ?? 0;
}

export class MemoryAdmission {
	readonly #deps: AdmissionDeps;
	/** The last good reading and when it was taken; samples that fail never replace it. */
	#reading: MemoryReading | null = null;
	#readAt = 0;
	/** Failed samples since the last good one. */
	#failures = 0;
	#footprints: ReadonlyMap<string, SessionFootprint> = new Map();
	#waiters: Waiter[] = [];
	#reservations = new Map<number, Reservation>();
	/** Highest measured tree per tab admitted here (all agent work), until its reservation ends. */
	#peaks = new Map<number, number>();
	#history: number[];
	/** Opener tab → the children its turn is blocked waiting on. */
	#blocked = new Map<string, ReadonlySet<string>>();
	#nextId = 1;
	#criticalTold = false;
	#lastWaits = "";
	/** Waiters whose start is a message `deliver` sends once admitted. */
	readonly #deliverIds = new Set<number>();
	/** Tabs admitted and still sending their message: they keep showing their last wait until it is in. */
	readonly #delivering = new Map<string, MemoryWait>();

	constructor(deps: AdmissionDeps) {
		this.#deps = deps;
		this.#history = [...(deps.peaks ?? [])].slice(-KEPT_PEAKS);
	}

	get expectedBytes(): number {
		if (this.#history.length < MIN_PEAKS) return DEFAULT_EXPECTED_BYTES;
		return Math.min(MAX_EXPECTED_BYTES, Math.max(MIN_EXPECTED_BYTES, p90(this.#history)));
	}

	/** Ask to start. Admitted at once when memory allows and nobody earlier waits; else it waits in line. */
	request(request: AdmissionRequest): AdmissionTicket {
		const id = this.#nextId++;
		const { promise, resolve } = Promise.withResolvers<AdmissionOutcome>();
		let settled = false;
		const settle = (outcome: AdmissionOutcome) => {
			if (settled) return;
			settled = true;
			resolve(outcome);
		};
		const waiter: Waiter = { id, request, since: this.#deps.now(), resolve: settle };
		this.#waiters.push(waiter);
		this.#pump();
		this.#publish();
		const admittedNow = settled;
		if (!admittedNow) {
			const reading = this.#reading;
			this.#deps.log("memory hold", {
				label: request.label,
				kind: request.kind,
				...(request.tabId ? { tab: request.tabId } : {}),
				position: this.#ordered().indexOf(waiter) + 1,
				...(reading
					? {
							availableGb: gb(reading.availableBytes),
							totalGb: gb(reading.totalBytes),
							pressure: reading.pressure,
						}
					: {}),
				expectedGb: gb(this.expectedBytes),
				reservedGb: gb(this.#reserved()),
			});
		}
		return {
			id,
			admittedNow,
			outcome: promise,
			cancel: () => {
				if (settled) return;
				this.#drop(waiter);
				settle("cancelled");
				this.#publish();
				this.#pump();
			},
		};
	}

	/**
	 * A new reading (null: the OS could not be read, or not in time) and the measured process trees of this computer's
	 * sessions by tab (null: the listing failed). A failed part never replaces the last good one: the last good reading
	 * decides for `STALE_READING_MS`, then memory reads as unknown and holds new agent work.
	 */
	sample(reading: MemoryReading | null, footprints: ReadonlyMap<string, SessionFootprint> | null = new Map()): void {
		if (footprints) this.#footprints = footprints;
		if (reading) this.#readable(reading);
		else this.#unreadable();
		this.#settleReservations();
		if (reading?.pressure === "critical") {
			if (!this.#criticalTold) {
				this.#criticalTold = true;
				const top = [...this.#footprints]
					.map(([tabId, footprint]) => ({ tabId, label: footprint.label, bytes: footprint.bytes }))
					.sort((a, b) => b.bytes - a.bytes)
					.slice(0, 3);
				this.#deps.log("memory critical", {
					availableGb: gb(reading.availableBytes),
					totalGb: gb(reading.totalBytes),
					top: top.map(entry => `${entry.label} ${gb(entry.bytes)} GB`),
					waiting: this.#waiters.length,
				});
				this.#deps.critical(reading, top);
			}
		} else if (reading?.pressure === "normal") this.#criticalTold = false;
		this.#pump();
		this.#publish();
	}

	#readable(reading: MemoryReading): void {
		if (this.#failures > 0) this.#deps.log("memory readable", { failures: this.#failures });
		this.#failures = 0;
		this.#reading = reading;
		this.#readAt = this.#deps.now();
	}

	/** One log line per failing streak, and the owner told once when it reaches `UNREADABLE_NOTICE_FAILURES`. */
	#unreadable(): void {
		this.#failures++;
		if (this.#failures === 1)
			this.#deps.log("memory unreadable", {
				lastGoodAgoMs: this.#reading ? this.#deps.now() - this.#readAt : -1,
				waiting: this.#waiters.length,
			});
		if (this.#failures === UNREADABLE_NOTICE_FAILURES) this.#deps.unreadable?.(this.#failures);
	}

	/** The reading that decides now: the last good one while fresh, else null (unknown, which holds new work). */
	#current(): MemoryReading | null {
		if (!this.#reading || this.#deps.now() - this.#readAt > STALE_READING_MS) return null;
		return this.#reading;
	}

	/** The owner starts a waiting tab now, whatever memory says. */
	startNow(tabId: string): boolean {
		const waiter = this.#waiters.find(entry => entry.request.tabId === tabId);
		if (!waiter) return false;
		this.#admit(waiter, "started-now");
		this.#publish();
		this.#pump();
		return true;
	}

	/**
	 * Send `command` (an agent's message that starts a turn in the idle `request.tabId`) now when memory allows, else
	 * once it does: the answer then says it waits (`memoryHeldResponse`), so the agent is told and does not send again.
	 * A start that fails later is logged; a closed tab's start never comes.
	 */
	deliver(
		request: AdmissionRequest & { tabId: string },
		command: string,
		send: () => Promise<RpcResponse>,
	): Promise<RpcResponse> {
		const ticket = this.request(request);
		if (ticket.admittedNow) return send();
		// Admitted later, the tab keeps showing its wait until its message is in: until then it has not started, and an
		// opener waiting on it must not read it as idle and finished.
		this.#deliverIds.add(ticket.id);
		void ticket.outcome
			.then(async outcome => {
				if (outcome === "cancelled") return;
				const response = await send();
				if (!response.success) throw new Error(response.error);
			})
			.catch(error =>
				this.#deps.log("memory start failed", {
					label: request.label,
					tab: request.tabId,
					error: error instanceof Error ? error.message : String(error),
				}),
			)
			.finally(() => {
				this.#deliverIds.delete(ticket.id);
				if (this.#delivering.delete(request.tabId)) this.#publish();
			});
		const wait = this.waitOf(request.tabId);
		return Promise.resolve({
			type: "response",
			command,
			success: true,
			...(wait ? { data: { memoryWait: wait } } : {}),
		});
	}

	/** The tab closed, stopped or changed session: what waits for it is called off and its reservation ends. */
	forgetTab(tabId: string): void {
		for (const waiter of this.#waiters.filter(entry => entry.request.tabId === tabId)) {
			this.#drop(waiter);
			waiter.resolve("cancelled");
		}
		this.#blocked.delete(tabId);
		for (const [id, reservation] of this.#reservations) if (reservation.tabId === tabId) this.#endReservation(id);
		this.#publish();
		this.#pump();
	}

	/** The tab's turn ended: its growth phase is over, so it reserves nothing more. */
	turnEnded(tabId: string): void {
		for (const [id, reservation] of this.#reservations) if (reservation.tabId === tabId) this.#endReservation(id);
		this.#pump();
		this.#publish();
	}

	/** The opener's turn is blocked waiting on `children` (`ompdesk_session_result` wait), or no longer (`null`). */
	blockedOn(openerTabId: string, children: ReadonlySet<string> | null): void {
		if (children && children.size > 0) this.#blocked.set(openerTabId, children);
		else this.#blocked.delete(openerTabId);
		this.#pump();
		this.#publish();
	}

	/** Where the tab waits, when it does. */
	waitOf(tabId: string): MemoryWait | undefined {
		return this.#waits().get(tabId);
	}

	status(): AdmissionStatus {
		return {
			reading: this.#current(),
			expectedBytes: this.expectedBytes,
			reservedBytes: this.#reserved(),
			reserveBytes: this.#reserveBytes(),
			waiting: this.#ordered().map(waiter => ({
				label: waiter.request.label,
				...(waiter.request.tabId ? { tabId: waiter.request.tabId } : {}),
				kind: waiter.request.kind,
				since: waiter.since,
			})),
			starting: this.#reservations.size,
		};
	}

	#reserveBytes(): number {
		return (this.#reading?.totalBytes ?? 0) * RESERVE_FRACTION;
	}

	/** Expected growth still to come from the sessions started lately. */
	#reserved(): number {
		let sum = 0;
		for (const reservation of this.#reservations.values()) {
			const measured = reservation.tabId ? (this.#footprints.get(reservation.tabId)?.bytes ?? 0) : 0;
			sum += Math.max(0, reservation.expected - measured);
		}
		return sum;
	}

	/** 0: a child its blocked opener waits on; 1: a child of a running opener; 2: anything else. */
	#rank(waiter: Waiter): number {
		const { tabId, parentTabId } = waiter.request;
		if ((tabId && this.#owedBy(tabId)) || (parentTabId && this.#blocked.has(parentTabId))) return 0;
		if (parentTabId && this.#deps.running(parentTabId)) return 1;
		return 2;
	}

	#owedBy(tabId: string): boolean {
		for (const children of this.#blocked.values()) if (children.has(tabId)) return true;
		return false;
	}

	#ordered(): Waiter[] {
		return [...this.#waiters].sort((a, b) => this.#rank(a) - this.#rank(b) || a.id - b.id);
	}

	/** Admit from the head of the line while memory allows; the line never skips (no starvation). */
	#pump(): void {
		for (const waiter of this.#ordered()) {
			if (!this.#allows(waiter)) return;
			this.#admit(waiter, "admitted");
		}
	}

	#allows(waiter: Waiter): boolean {
		const reading = this.#current();
		// Unknown (no good reading yet, or the last one is stale because samples keep failing) is never safe: it holds
		// every new start, as critical pressure does; the owner's Start now still starts one.
		if (!reading) return false;
		if (this.#rank(waiter) === 0) return reading.pressure !== "critical";
		if (reading.pressure !== "normal") return false;
		return reading.availableBytes - this.#reserved() - this.expectedBytes >= this.#reserveBytes();
	}

	#admit(waiter: Waiter, outcome: AdmissionOutcome): void {
		const tabId = waiter.request.tabId;
		if (tabId && this.#deliverIds.has(waiter.id)) {
			const shown = this.#waits().get(tabId);
			if (shown) this.#delivering.set(tabId, shown);
		}
		this.#drop(waiter);
		const waited = this.#deps.now() - waiter.since;
		this.#reservations.set(waiter.id, {
			...(waiter.request.tabId ? { tabId: waiter.request.tabId } : {}),
			expected: this.expectedBytes,
			since: this.#deps.now(),
			label: waiter.request.label,
		});
		if (waited > 0 || outcome === "started-now")
			this.#deps.log(outcome === "started-now" ? "memory start now" : "memory release", {
				label: waiter.request.label,
				kind: waiter.request.kind,
				...(waiter.request.tabId ? { tab: waiter.request.tabId } : {}),
				waitedMs: waited,
				...(this.#reading
					? { availableGb: gb(this.#reading.availableBytes), pressure: this.#reading.pressure }
					: {}),
			});
		waiter.resolve(outcome);
	}

	#drop(waiter: Waiter): void {
		this.#waiters = this.#waiters.filter(entry => entry !== waiter);
	}

	#settleReservations(): void {
		const now = this.#deps.now();
		for (const [id, reservation] of this.#reservations) {
			const measured = reservation.tabId ? this.#footprints.get(reservation.tabId) : undefined;
			if (measured) this.#peaks.set(id, Math.max(this.#peaks.get(id) ?? 0, measured.bytes));
			if (now - reservation.since >= RESERVE_WINDOW_MS || (measured && measured.bytes >= reservation.expected))
				this.#endReservation(id);
		}
	}

	#endReservation(id: number): void {
		const reservation = this.#reservations.get(id);
		if (!reservation) return;
		this.#reservations.delete(id);
		const peak = this.#peaks.get(id);
		this.#peaks.delete(id);
		if (peak === undefined) return;
		this.#history = [...this.#history, peak].slice(-KEPT_PEAKS);
		this.#deps.savePeaks?.(this.#history);
	}

	#waits(): Map<string, MemoryWait> {
		const waits = new Map<string, MemoryWait>();
		const last = this.#reading;
		const current = this.#current();
		this.#ordered().forEach((waiter, index) => {
			if (!waiter.request.tabId) return;
			waits.set(waiter.request.tabId, {
				position: index + 1,
				availableBytes: last?.availableBytes ?? 0,
				totalBytes: last?.totalBytes ?? 0,
				pressure: current?.pressure ?? "unknown",
				since: waiter.since,
			});
		});
		// Admitted starts still sending their message keep their last wait until it is in (`deliver`).
		for (const [tabId, wait] of this.#delivering) if (!waits.has(tabId)) waits.set(tabId, wait);
		return waits;
	}

	#publish(): void {
		const waits = this.#waits();
		const key = JSON.stringify([...waits]);
		if (key === this.#lastWaits) return;
		this.#lastWaits = key;
		this.#deps.changed(waits);
	}
}

/** Bytes as GB with one decimal, for log lines and messages. */
export function gb(bytes: number): number {
	return Math.round((bytes / GiB) * 10) / 10;
}

/** "waiting for memory: 3.1 GB free of 16 GB (pressure normal); #2 in line; it starts by itself". */
export function memoryWaitText(wait: MemoryWait): string {
	const memory =
		wait.pressure === "unknown"
			? "this computer's memory cannot be read right now"
			: `${gb(wait.availableBytes)} GB free of ${Math.round(wait.totalBytes / GiB)} GB (pressure ${wait.pressure})`;
	return `waiting for memory: ${memory}; #${wait.position} in line; it starts by itself`;
}

/** One computer's line in `ompdesk_sessions`: memory now, starts still growing, and the line of waiting work. */
export function capacityText(name: string, status: AdmissionStatus): string {
	const { reading } = status;
	const memory = reading
		? `${gb(reading.availableBytes)} GB free of ${Math.round(reading.totalBytes / 1024 ** 3)} GB, pressure ${reading.pressure}`
		: "memory unknown (not read lately), so new agent work waits";
	const waiting = status.waiting.length
		? `${status.waiting.length} waiting for memory (next: ${status.waiting[0]?.label})`
		: "nothing waiting";
	return `${name}: ${memory}; ${status.starting} agent start(s) still growing (${gb(status.reservedBytes)} GB reserved); ${waiting}; a new agent session is expected to need ${gb(status.expectedBytes)} GB`;
}

/** A paired host's `host.memory.status` answer, when it is one (an older host answers otherwise). */
export function parseAdmissionStatus(value: unknown): AdmissionStatus | null {
	if (typeof value !== "object" || value === null) return null;
	if (!("waiting" in value) || !Array.isArray(value.waiting)) return null;
	if (!("expectedBytes" in value) || typeof value.expectedBytes !== "number") return null;
	// The host built it with `status()`; the fields read here were checked above, the rest only print.
	const status: AdmissionStatus = value as AdmissionStatus;
	return status;
}
