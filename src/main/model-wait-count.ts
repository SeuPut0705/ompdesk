/**
 * Which sessions wait on the same provider together. Why (30 Oct 2026, this Mac): turns sat on "waiting for the
 * model" for up to 13 minutes, and long waits of different sessions ended in the same second: the wait is the
 * provider's queue for this account, not any one session. The working cue (`lib/model-wait.ts`) says so when two or
 * more sessions of one computer's account have each waited out their request for `MODEL_WAIT_TOGETHER_MS`.
 *
 * The tracker reads every tab's agent events (the bridge's `model_request` frames carry the provider; a
 * frame without one, from an older bridge, joins no group), mirrors the renderer turn meter's rule for when a wait
 * ends (an answer, the first output, the run's end or start), and tells its listeners the per-tab counts whenever
 * they change. A tab that a paired host runs belongs to that host's group: the host's own count (the host's account)
 * replaces what this computer sees of it (`setHostCounts`); an older host sends none and the tab counts what
 * this computer sees.
 */
import { LATE_FIRST_OUTPUT_MS } from "../../resources/gui-bridge/turn-stages-contracts";
import type { AgentSessionEvent } from "../shared/rpc-types";

/** A request unanswered this long counts as waiting (the same late mark the cue names a wait from). */
export const MODEL_WAIT_TOGETHER_MS = LATE_FIRST_OUTPUT_MS;

export interface ModelWaitRecord {
	key: string;
	/** "" = this computer; else the paired host's deviceId. */
	scope: string;
	provider: string;
	since: number;
}

export type ProviderCounts = Record<string, number>;

/** Per tab key: how many sessions (itself included) wait together, for those with 2 or more. */
export type TogetherCounts = ReadonlyMap<string, number>;

/**
 * The counting rule: among the records waiting at least `MODEL_WAIT_TOGETHER_MS` at `now`, each group of one scope and
 * one provider with two or more members gives every member the group's size. `hostCounts` (by scope, then provider)
 * is the paired host's own count of its waiters: it wins for a remote scope, when it names the provider.
 */
export function countTogether(
	records: Iterable<ModelWaitRecord>,
	now: number,
	hostCounts: ReadonlyMap<string, ProviderCounts> = new Map(),
): Map<string, number> {
	const due = [...records].filter(r => r.provider !== "" && now - r.since >= MODEL_WAIT_TOGETHER_MS);
	const sizes = new Map<string, number>();
	for (const r of due)
		sizes.set(`${r.scope}\u0000${r.provider}`, (sizes.get(`${r.scope}\u0000${r.provider}`) ?? 0) + 1);
	const result = new Map<string, number>();
	for (const r of due) {
		const reported = r.scope === "" ? undefined : hostCounts.get(r.scope)?.[r.provider];
		const size = reported ?? sizes.get(`${r.scope}\u0000${r.provider}`) ?? 1;
		if (size >= 2) result.set(r.key, size);
	}
	return result;
}

export interface ModelWaitSnapshot {
	/** Per tab key of the pool's tabs and the tabs a device runs here. */
	together: ReadonlyMap<string, number>;
	/** This computer's own waiting sessions per provider (the count a device using it as host shows). */
	local: ProviderCounts;
}

interface TrackerDeps {
	now?: () => number;
	setTimer?: (run: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

export class ModelWaitTracker {
	readonly #records = new Map<string, ModelWaitRecord>();
	readonly #hostCounts = new Map<string, ProviderCounts>();
	readonly #listeners = new Set<(snapshot: ModelWaitSnapshot) => void>();
	readonly #now: () => number;
	readonly #setTimer: (run: () => void, ms: number) => unknown;
	readonly #clearTimer: (handle: unknown) => void;
	#timer: unknown;
	#last = "";
	#snapshot: ModelWaitSnapshot = { together: new Map(), local: {} };

	constructor(deps: TrackerDeps = {}) {
		this.#now = deps.now ?? Date.now;
		this.#setTimer =
			deps.setTimer ??
			((run, ms) => {
				const handle = setTimeout(run, ms);
				handle.unref?.();
				return handle;
			});
		this.#clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle as NodeJS.Timeout));
	}

	/** Called with the snapshot whenever it changes. */
	onChange(listener: (snapshot: ModelWaitSnapshot) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	get snapshot(): ModelWaitSnapshot {
		return this.#snapshot;
	}

	/** Feed one tab's events; `scope` is "" for a tab running here, else its paired host's deviceId. */
	observe(key: string, scope: string, events: readonly AgentSessionEvent[]): void {
		let changed = false;
		for (const event of events) {
			switch (event.type) {
				case "model_request": {
					const record = this.#records.get(key);
					if (event.phase === "sent") {
						// A body stock's provider sends again inside the call keeps the first request's time.
						if (!record) {
							this.#records.set(key, { key, scope, provider: event.provider ?? "", since: this.#now() });
							changed = true;
						}
					} else if (record) {
						this.#records.delete(key);
						changed = true;
					}
					break;
				}
				case "agent_start":
				case "message_update":
				case "agent_end":
					if (this.#records.delete(key)) changed = true;
					break;
				default:
					break;
			}
		}
		if (changed) this.#recompute();
	}

	/** A tab went away (released, closed). */
	forget(key: string): void {
		if (this.#records.delete(key)) this.#recompute();
	}

	/** A paired host's own per-provider count of its waiting sessions (`{}` when it has none). */
	setHostCounts(scope: string, counts: ProviderCounts | undefined): void {
		if (counts === undefined) this.#hostCounts.delete(scope);
		else this.#hostCounts.set(scope, counts);
		this.#recompute();
	}

	#recompute(): void {
		if (this.#timer !== undefined) this.#clearTimer(this.#timer);
		this.#timer = undefined;
		const now = this.#now();
		const together = countTogether(this.#records.values(), now, this.#hostCounts);
		const local: ProviderCounts = {};
		let nextDue = Number.POSITIVE_INFINITY;
		for (const r of this.#records.values()) {
			const age = now - r.since;
			if (age < MODEL_WAIT_TOGETHER_MS) nextDue = Math.min(nextDue, MODEL_WAIT_TOGETHER_MS - age);
			else if (r.scope === "" && r.provider !== "") local[r.provider] = (local[r.provider] ?? 0) + 1;
		}
		if (nextDue !== Number.POSITIVE_INFINITY) this.#timer = this.#setTimer(() => this.#recompute(), nextDue);
		const signature = JSON.stringify([[...together].sort(), Object.entries(local).sort()]);
		if (signature === this.#last) return;
		this.#last = signature;
		this.#snapshot = { together, local };
		for (const listener of this.#listeners) listener(this.#snapshot);
	}
}
