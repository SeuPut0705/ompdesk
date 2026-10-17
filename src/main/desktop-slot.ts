/**
 * The desktop slot's rules (contract: resources/gui-bridge/desktop-slot-contracts.ts): one omp session at a time
 * drives this computer's desktop. A session takes the slot at its first acting run and keeps it until it lets go
 * (turn end, idle, abort, Stop), loses it (lease, tab close, crash), and the sessions that asked meanwhile wait in
 * FIFO order. No Electron, no pool, no bridge: the clock, the timers and everything that talks to a tab are injected
 * (`desktop-slot-host.ts` is the wiring).
 *
 * The order that matters: taking the slot from a live holder (Stop, lease, close) first `revoke`s it (the bridge
 * aborts the in-flight input run and awaits stock's `revokeControl()` on every controller) and only after that
 * answer is the next waiter granted. A holder that let go or whose process died needs no revoke.
 */
import {
	DESKTOP_SLOT_LEASE_MS,
	type DesktopSlotReason,
	type DesktopSlotState,
} from "../../resources/gui-bridge/desktop-slot-contracts";

/** A revoke that never answers must not lock the desktop for good: the hand-off goes on after this long. */
export const DESKTOP_SLOT_REVOKE_TIMEOUT_MS = 10_000;

export interface DesktopSlotTimers {
	set(callback: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

export interface DesktopSlotDeps {
	/** Abort the tab's in-flight input run and await `revokeControl()`; a rejection counts as done (the process is going). */
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
	now?: () => number;
	timers?: DesktopSlotTimers;
	leaseMs?: number;
	revokeTimeoutMs?: number;
}

interface Holder {
	tabId: string;
	since: number;
	lease: unknown;
	/** Set while the holder is being revoked: it still shows as the holder, and asks queue behind it. */
	leaving: Promise<void> | null;
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
	#holder: Holder | null = null;
	readonly #queue: Waiter[] = [];

	constructor(deps: DesktopSlotDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
		this.#timers = deps.timers ?? SYSTEM_TIMERS;
		this.#leaseMs = deps.leaseMs ?? DESKTOP_SLOT_LEASE_MS;
		this.#revokeTimeoutMs = deps.revokeTimeoutMs ?? DESKTOP_SLOT_REVOKE_TIMEOUT_MS;
	}

	state(): DesktopSlotState {
		const holder = this.#holder;
		return {
			holder: holder ? { tabId: holder.tabId, title: this.#deps.titleOf(holder.tabId), since: holder.since } : null,
			queue: this.#queue.map(waiter => ({ tabId: waiter.tabId, title: this.#deps.titleOf(waiter.tabId) })),
		};
	}

	/** An acting run of `tabId` wants the slot. */
	acquire(tabId: string, requestId: string): void {
		const holder = this.#holder;
		if (holder && holder.tabId === tabId && !holder.leaving) {
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
		if (holder && holder.tabId === tabId && !holder.leaving) this.#arm(holder);
	}

	/** The tab lets go (the bridge already revoked): the holder frees the slot, a waiter leaves the queue. */
	release(tabId: string): void {
		const holder = this.#holder;
		if (holder && holder.tabId === tabId) {
			if (!holder.leaving) this.#depart(holder, "turn_end", false);
			return;
		}
		this.#dropWaiter(tabId);
	}

	/** The user's Stop on the tab's use of the screen: revoke it, then hand the slot on. */
	async stop(tabId: string): Promise<void> {
		const holder = this.#holder;
		if (holder && holder.tabId === tabId) return this.#depart(holder, "stop", true);
		if (this.#dropWaiter(tabId)) await this.#revoke(tabId, "stop");
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
		if (this.#holder) this.#timers.clear(this.#holder.lease);
		this.#holder = null;
		this.#queue.length = 0;
	}

	#become(tabId: string): void {
		const holder: Holder = { tabId, since: this.#now(), lease: undefined, leaving: null };
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

	/** The holder leaves; with `revoke` the next waiter is granted only after the revoke answered. */
	#depart(holder: Holder, reason: DesktopSlotReason, revoke: boolean): Promise<void> {
		if (this.#holder !== holder) return Promise.resolve();
		if (!revoke) {
			this.#timers.clear(holder.lease);
			this.#holder = null;
			this.#advance();
			return Promise.resolve();
		}
		if (holder.leaving) return holder.leaving;
		this.#timers.clear(holder.lease);
		holder.leaving = this.#revoke(holder.tabId, reason).then(() => {
			// A crash while the revoke was pending already handed the slot on.
			if (this.#holder !== holder) return;
			this.#holder = null;
			this.#advance();
		});
		return holder.leaving;
	}

	async #revoke(tabId: string, reason: DesktopSlotReason): Promise<void> {
		const answered = new Promise<void>(resolve => resolve(this.#deps.revoke(tabId, reason))).catch(() => undefined);
		let timer: unknown;
		const timedOut = new Promise<void>(resolve => {
			timer = this.#timers.set(resolve, this.#revokeTimeoutMs);
		});
		try {
			await Promise.race([answered, timedOut]);
		} finally {
			this.#timers.clear(timer);
		}
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
