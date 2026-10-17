/**
 * The desktop slot's rules (contract: resources/gui-bridge/desktop-slot-contracts.ts): one omp session at a time
 * drives this computer's desktop. A session takes the slot at its first acting run and keeps it until it lets go
 * (turn end, idle, abort, Stop), loses it (lease, tab close, crash), and the sessions that asked meanwhile wait in
 * FIFO order. No Electron, no pool, no bridge: the clock, the timers and everything that talks to a tab are injected
 * (`desktop-slot-host.ts` is the wiring).
 *
 * The order that matters: taking the slot from a live holder (Stop, lease, close) first `revoke`s it (the bridge
 * aborts the in-flight input run and awaits stock's `revokeControl()` on every controller) and only a CONFIRMED
 * answer lets the next waiter be granted. A revoke that rejects or never answers leaves the holder in place as
 * revoke-failed (nobody granted, retried on a timer, `retry()` / `killHolder()` for the user); the slot is freed by
 * a confirmed revoke, by the holder's process being confirmed dead (`crashed`), or by a confirmed kill.
 */
import {
	DESKTOP_SLOT_LEASE_MS,
	type DesktopSlotReason,
	type DesktopSlotState,
} from "../../resources/gui-bridge/desktop-slot-contracts";

/** A revoke with no answer after this long counts as failed (not as done): the slot is held, never handed on. */
export const DESKTOP_SLOT_REVOKE_TIMEOUT_MS = 10_000;
/** A revoke-failed holder is revoked again this often until it is confirmed, its process is gone or it is killed. */
export const DESKTOP_SLOT_REVOKE_RETRY_MS = 5_000;

export interface DesktopSlotTimers {
	set(callback: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

export interface DesktopSlotDeps {
	/** Abort the tab's in-flight input run and await `revokeControl()` on every controller; a rejection is a failure. */
	revoke(tabId: string, reason: DesktopSlotReason): Promise<void>;
	/**
	 * Let one acting run of `tabId` go on. `waited` is true when the run sat in the queue (it then returns the
	 * stale notice instead of running), false when the slot was free or the tab already held it.
	 */
	grant(tabId: string, requestId: string, waited: boolean): void;
	/** The slot's whole state changed. */
	onChange(state: DesktopSlotState): void;
	/** The session title the indicator shows for a tab. */
	titleOf(tabId: string): string;
	/**
	 * The user's "stop that session": abort it and end its omp process if needed. True only when the process is
	 * confirmed gone (exited), the one thing besides a confirmed revoke that frees a revoke-failed slot.
	 */
	kill(tabId: string): Promise<boolean>;
	now?: () => number;
	timers?: DesktopSlotTimers;
	leaseMs?: number;
	revokeTimeoutMs?: number;
	retryMs?: number;
}

interface Holder {
	tabId: string;
	since: number;
	lease: unknown;
	/** Set while a revoke attempt is in flight: it still shows as the holder, and asks queue behind it. */
	leaving: Promise<void> | null;
	/** Why the last revoke attempt was not confirmed; while set nobody is granted (revoke-failed). */
	failed: DesktopSlotReason | null;
	/** The timer of the next revoke attempt while revoke-failed. */
	retry: unknown;
}

interface Waiter {
	tabId: string;
	requestIds: string[];
}

const SYSTEM_TIMERS: DesktopSlotTimers = {
	set: (callback, ms) => {
		const timer = setTimeout(callback, ms);
		timer.unref();
		return timer;
	},
	clear: handle => clearTimeout(handle as NodeJS.Timeout),
};

export class DesktopSlot {
	readonly #deps: DesktopSlotDeps;
	readonly #now: () => number;
	readonly #timers: DesktopSlotTimers;
	readonly #leaseMs: number;
	readonly #revokeTimeoutMs: number;
	readonly #retryMs: number;
	#holder: Holder | null = null;
	readonly #queue: Waiter[] = [];

	constructor(deps: DesktopSlotDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
		this.#timers = deps.timers ?? SYSTEM_TIMERS;
		this.#leaseMs = deps.leaseMs ?? DESKTOP_SLOT_LEASE_MS;
		this.#revokeTimeoutMs = deps.revokeTimeoutMs ?? DESKTOP_SLOT_REVOKE_TIMEOUT_MS;
		this.#retryMs = deps.retryMs ?? DESKTOP_SLOT_REVOKE_RETRY_MS;
	}

	state(): DesktopSlotState {
		const holder = this.#holder;
		return {
			holder: holder
				? {
						tabId: holder.tabId,
						title: this.#deps.titleOf(holder.tabId),
						since: holder.since,
						...(holder.failed ? { revokeFailed: true as const } : {}),
					}
				: null,
			queue: this.#queue.map(waiter => ({ tabId: waiter.tabId, title: this.#deps.titleOf(waiter.tabId) })),
		};
	}

	/** An acting run of `tabId` wants the slot. */
	acquire(tabId: string, requestId: string): void {
		const holder = this.#holder;
		if (holder && holder.tabId === tabId && !holder.leaving && !holder.failed) {
			this.#arm(holder);
			this.#deps.grant(tabId, requestId, false);
			return;
		}
		if (!holder) {
			this.#become(tabId);
			this.#emit();
			this.#deps.grant(tabId, requestId, false);
			return;
		}
		const waiting = this.#queue.find(waiter => waiter.tabId === tabId);
		if (waiting) waiting.requestIds.push(requestId);
		else this.#queue.push({ tabId, requestIds: [requestId] });
		this.#emit();
	}

	/** Progress by the holder (a run started or ended): its lease starts over. */
	touch(tabId: string): void {
		const holder = this.#holder;
		if (holder && holder.tabId === tabId && !holder.leaving && !holder.failed) this.#arm(holder);
	}

	/** The tab lets go (the bridge revoked and confirmed): the holder frees the slot, a waiter leaves the queue. */
	release(tabId: string): void {
		const holder = this.#holder;
		if (holder && holder.tabId === tabId) {
			if (!holder.leaving) this.#depart(holder, "turn_end", false);
			return;
		}
		this.#dropWaiter(tabId);
	}

	/** The user's "try again" on a revoke-failed holder: ask the bridge to revoke now. */
	retry(): void {
		const holder = this.#holder;
		if (holder?.failed && !holder.leaving) void this.#start(holder, holder.failed);
	}

	/**
	 * The user's "stop that session" on the holder: `kill` ends its process (abort plus kill if needed) and answers
	 * whether it is CONFIRMED gone; only then is the slot freed. An unconfirmed kill leaves everything as it was.
	 */
	async killHolder(): Promise<boolean> {
		const holder = this.#holder;
		if (!holder) return true;
		const gone = await Promise.resolve(this.#deps.kill(holder.tabId)).catch(() => false);
		if (gone && this.#holder === holder) this.#free(holder);
		return gone;
	}

	/** The user's Stop on the tab's use of the screen: revoke it, then hand the slot on. */
	async stop(tabId: string): Promise<void> {
		const holder = this.#holder;
		if (holder && holder.tabId === tabId) return this.#depart(holder, "stop", true);
		if (this.#dropWaiter(tabId)) await Promise.resolve(this.#deps.revoke(tabId, "stop")).catch(() => undefined);
	}

	/** The tab closed while its process may still run: revoke best effort, then hand on. A waiter just leaves. */
	async closed(tabId: string): Promise<void> {
		const holder = this.#holder;
		if (holder && holder.tabId === tabId) return this.#depart(holder, "closed", true);
		this.#dropWaiter(tabId);
	}

	/** The tab's process died (or restarted): nothing left to revoke, hand on at once. */
	crashed(tabId: string): void {
		const holder = this.#holder;
		if (holder && holder.tabId === tabId) {
			this.#depart(holder, "crashed", false);
			return;
		}
		this.#dropWaiter(tabId);
	}

	/** Stop every timer (app quit). */
	dispose(): void {
		if (this.#holder) {
			this.#timers.clear(this.#holder.lease);
			this.#timers.clear(this.#holder.retry);
		}
		this.#holder = null;
		this.#queue.length = 0;
	}

	#become(tabId: string): void {
		const holder: Holder = {
			tabId,
			since: this.#now(),
			lease: undefined,
			leaving: null,
			failed: null,
			retry: undefined,
		};
		this.#holder = holder;
		this.#arm(holder);
	}

	/** (Re)start the lease: it runs out `leaseMs` after the holder's last sign of life. */
	#arm(holder: Holder): void {
		this.#timers.clear(holder.lease);
		holder.lease = this.#timers.set(() => {
			void this.#depart(holder, "lease", true);
		}, this.#leaseMs);
	}

	/**
	 * The holder leaves. Without `revoke` (the bridge let go after its own confirmed revoke, or the process is
	 * gone) the slot is free at once. With it, the next waiter is granted only after stock's `revokeControl()` is
	 * CONFIRMED stopped; a rejection or a timeout leaves the holder in place as revoke-failed (see {@link #start}).
	 */
	#depart(holder: Holder, reason: DesktopSlotReason, revoke: boolean): Promise<void> {
		if (this.#holder !== holder) return Promise.resolve();
		if (!revoke) {
			this.#free(holder);
			return Promise.resolve();
		}
		if (holder.leaving) return holder.leaving;
		this.#timers.clear(holder.lease);
		return this.#start(holder, reason);
	}

	/** One revoke attempt on `holder`; on failure it stays the holder, flagged, and the next attempt is scheduled. */
	#start(holder: Holder, reason: DesktopSlotReason): Promise<void> {
		this.#timers.clear(holder.retry);
		holder.retry = undefined;
		const leaving: Promise<void> = this.#revoke(holder, reason)
			.then(confirmed => {
				if (this.#holder !== holder) return;
				if (confirmed) {
					this.#free(holder);
					return;
				}
				holder.failed = reason;
				holder.retry = this.#timers.set(() => {
					holder.retry = undefined;
					if (this.#holder === holder && !holder.leaving) void this.#start(holder, reason);
				}, this.#retryMs);
				this.#emit();
			})
			.finally(() => {
				if (holder.leaving === leaving) holder.leaving = null;
			});
		holder.leaving = leaving;
		return leaving;
	}

	/**
	 * Whether the holder's screen control is confirmed stopped: the revoke answered. A rejection, or no answer within
	 * the timeout, is false; an answer that comes after the timeout still frees the slot (it is a confirmation).
	 */
	async #revoke(holder: Holder, reason: DesktopSlotReason): Promise<boolean> {
		const answered = new Promise<void>(resolve => resolve(this.#deps.revoke(holder.tabId, reason))).then(
			() => true,
			() => false,
		);
		void answered.then(confirmed => {
			if (confirmed && this.#holder === holder) this.#free(holder);
		});
		let timer: unknown;
		const timedOut = new Promise<boolean>(resolve => {
			timer = this.#timers.set(() => resolve(false), this.#revokeTimeoutMs);
		});
		try {
			return await Promise.race([answered, timedOut]);
		} finally {
			this.#timers.clear(timer);
		}
	}

	/** The slot is free: the holder is gone (confirmed) and the first waiter takes over. */
	#free(holder: Holder): void {
		if (this.#holder !== holder) return;
		this.#timers.clear(holder.lease);
		this.#timers.clear(holder.retry);
		this.#holder = null;
		this.#advance();
	}

	/** The slot is free: the first waiter takes it and its runs are granted (as having waited). */
	#advance(): void {
		const next = this.#queue.shift();
		if (!next) {
			this.#emit();
			return;
		}
		this.#become(next.tabId);
		this.#emit();
		for (const requestId of next.requestIds) this.#deps.grant(next.tabId, requestId, true);
	}

	#dropWaiter(tabId: string): boolean {
		const index = this.#queue.findIndex(waiter => waiter.tabId === tabId);
		if (index < 0) return false;
		this.#queue.splice(index, 1);
		this.#emit();
		return true;
	}

	#emit(): void {
		this.#deps.onChange(this.state());
	}
}
