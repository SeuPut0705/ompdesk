import { describe, expect, it } from "vitest";
import {
	DESKTOP_SLOT_LEASE_MS,
	type DesktopSlotReason,
	type DesktopSlotState,
} from "../../resources/gui-bridge/desktop-slot-contracts";
import { DESKTOP_SLOT_REVOKE_RETRY_MS, DESKTOP_SLOT_REVOKE_TIMEOUT_MS, DesktopSlot } from "./desktop-slot";

/** A clock and timers the test advances by hand. */
class ManualTime {
	now = 1_000;
	#next = 1;
	#timers = new Map<number, { at: number; callback: () => void }>();

	timers = {
		set: (callback: () => void, ms: number): unknown => {
			const id = this.#next++;
			this.#timers.set(id, { at: this.now + ms, callback });
			return id;
		},
		clear: (handle: unknown): void => {
			if (typeof handle === "number") this.#timers.delete(handle);
		},
	};

	get pending(): number {
		return this.#timers.size;
	}

	/** Advance the clock, firing every timer that falls due on the way, earliest first. */
	async advance(ms: number): Promise<void> {
		const target = this.now + ms;
		for (;;) {
			const due = [...this.#timers.entries()]
				.filter(([, timer]) => timer.at <= target)
				.sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			this.#timers.delete(due[0]);
			this.now = due[1].at;
			due[1].callback();
			await flush();
		}
		this.now = target;
	}
}

const flush = async (): Promise<void> => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};

interface Revoke {
	tabId: string;
	reason: DesktopSlotReason;
	resolve: () => void;
	reject: (error: Error) => void;
}

function setup(options: { autoRevoke?: boolean } = {}) {
	const time = new ManualTime();
	const log: string[] = [];
	const grants: Array<{ tabId: string; requestId: string; waited: boolean }> = [];
	const revokes: Revoke[] = [];
	const kills: Array<{ tabId: string; resolve: (gone: boolean) => void }> = [];
	const states: DesktopSlotState[] = [];
	const slot = new DesktopSlot({
		now: () => time.now,
		timers: time.timers,
		titleOf: tabId => `title-${tabId}`,
		onChange: state => states.push(state),
		grant: (tabId, requestId, waited) => {
			grants.push({ tabId, requestId, waited });
			log.push(`grant:${tabId}:${requestId}`);
		},
		revoke: (tabId, reason) => {
			log.push(`revoke:${tabId}:${reason}`);
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			revokes.push({ tabId, reason, resolve, reject });
			if (options.autoRevoke) resolve();
			return promise;
		},
		kill: tabId => {
			const { promise, resolve } = Promise.withResolvers<boolean>();
			kills.push({ tabId, resolve });
			return promise;
		},
	});
	return { slot, time, log, grants, revokes, kills, states };
}

const holderOf = (slot: DesktopSlot): string | null => slot.state().holder?.tabId ?? null;
const queueOf = (slot: DesktopSlot): string[] => slot.state().queue.map(session => session.tabId);

describe("DesktopSlot", () => {
	it("grants a free slot at once, as a run that did not wait", () => {
		const { slot, grants, states } = setup();
		slot.acquire("a", "r1");
		expect(grants).toEqual([{ tabId: "a", requestId: "r1", waited: false }]);
		expect(slot.state()).toEqual({ holder: { tabId: "a", title: "title-a", since: 1_000 }, queue: [] });
		expect(states.at(-1)).toEqual(slot.state());
	});

	it("queues the others FIFO and hands over in that order, each as a run that waited", async () => {
		const { slot, grants } = setup({ autoRevoke: true });
		slot.acquire("a", "a1");
		slot.acquire("b", "b1");
		slot.acquire("c", "c1");
		slot.acquire("b", "b2");
		expect(grants).toHaveLength(1);
		expect(queueOf(slot)).toEqual(["b", "c"]);
		expect(slot.state().queue[0]).toEqual({ tabId: "b", title: "title-b" });

		await slot.stop("a");
		expect(holderOf(slot)).toBe("b");
		expect(queueOf(slot)).toEqual(["c"]);
		// Every run b was waiting with is granted, in the order it asked.
		expect(grants.slice(1)).toEqual([
			{ tabId: "b", requestId: "b1", waited: true },
			{ tabId: "b", requestId: "b2", waited: true },
		]);

		await slot.stop("b");
		expect(holderOf(slot)).toBe("c");
		expect(grants.at(-1)).toEqual({ tabId: "c", requestId: "c1", waited: true });
	});

	it("keeps B waiting for A's whole span: A's own runs and progress do not free the slot", async () => {
		const { slot, time, grants } = setup();
		slot.acquire("a", "a1");
		slot.acquire("b", "b1");
		// A observes, acts, verifies: each run asks again or touches, none of which lets B in.
		slot.acquire("a", "a2");
		slot.touch("a");
		await time.advance(DESKTOP_SLOT_LEASE_MS - 1);
		slot.touch("a");
		slot.acquire("a", "a3");
		await time.advance(DESKTOP_SLOT_LEASE_MS - 1);
		expect(holderOf(slot)).toBe("a");
		expect(queueOf(slot)).toEqual(["b"]);
		expect(grants.filter(grant => grant.tabId === "b")).toEqual([]);
		// A re-acquiring while it holds is a plain grant, not a wait.
		expect(grants.filter(grant => grant.tabId === "a").map(grant => grant.waited)).toEqual([false, false, false]);

		// Only a release frees it.
		slot.release("a");
		expect(holderOf(slot)).toBe("b");
		expect(grants.at(-1)).toEqual({ tabId: "b", requestId: "b1", waited: true });
	});

	it("revokes a holder that shows no progress for the lease, then hands over", async () => {
		const { slot, time, log, revokes } = setup();
		slot.acquire("a", "a1");
		slot.acquire("b", "b1");
		await time.advance(DESKTOP_SLOT_LEASE_MS - 1);
		expect(log).toEqual(["grant:a:a1"]);
		await time.advance(1);
		expect(log).toEqual(["grant:a:a1", "revoke:a:lease"]);
		revokes[0]?.resolve();
		await flush();
		expect(log).toEqual(["grant:a:a1", "revoke:a:lease", "grant:b:b1"]);
		expect(holderOf(slot)).toBe("b");
	});

	it("frees the slot when a lapsed holder has nobody waiting", async () => {
		const { slot, time, revokes } = setup();
		slot.acquire("a", "a1");
		await time.advance(DESKTOP_SLOT_LEASE_MS);
		expect(holderOf(slot)).toBe("a");
		revokes[0]?.resolve();
		await flush();
		expect(slot.state()).toEqual({ holder: null, queue: [] });
		expect(time.pending).toBe(0);
	});

	it("starts the lease over on every touch and on a grant", async () => {
		const { slot, time, revokes } = setup();
		slot.acquire("a", "a1");
		await time.advance(DESKTOP_SLOT_LEASE_MS - 10);
		slot.touch("a");
		await time.advance(DESKTOP_SLOT_LEASE_MS - 10);
		expect(revokes).toHaveLength(0);
		// Another tab's touch is nothing to the holder's lease.
		slot.touch("b");
		await time.advance(10);
		expect(revokes.map(revoke => revoke.reason)).toEqual(["lease"]);
	});

	it("gives the next holder its own full lease", async () => {
		const { slot, time, revokes } = setup({ autoRevoke: true });
		slot.acquire("a", "a1");
		slot.acquire("b", "b1");
		await time.advance(DESKTOP_SLOT_LEASE_MS - 5);
		slot.release("a");
		await time.advance(DESKTOP_SLOT_LEASE_MS - 1);
		expect(revokes).toHaveLength(0);
		expect(holderOf(slot)).toBe("b");
		await time.advance(1);
		expect(revokes.map(revoke => `${revoke.tabId}:${revoke.reason}`)).toEqual(["b:lease"]);
	});

	describe("release", () => {
		it("hands over without a revoke when the holder lets go (the bridge already revoked)", () => {
			const { slot, log } = setup();
			slot.acquire("a", "a1");
			slot.acquire("b", "b1");
			slot.release("a");
			expect(log).toEqual(["grant:a:a1", "grant:b:b1"]);
			expect(holderOf(slot)).toBe("b");
		});

		it("frees the slot when nobody waits, and the next acquire runs at once", () => {
			const { slot, grants } = setup();
			slot.acquire("a", "a1");
			slot.release("a");
			expect(slot.state()).toEqual({ holder: null, queue: [] });
			slot.acquire("b", "b1");
			expect(grants.at(-1)).toEqual({ tabId: "b", requestId: "b1", waited: false });
		});

		it("takes a waiter out of the queue when it gives up waiting", () => {
			const { slot, grants } = setup();
			slot.acquire("a", "a1");
			slot.acquire("b", "b1");
			slot.acquire("c", "c1");
			slot.release("b");
			expect(queueOf(slot)).toEqual(["c"]);
			slot.release("a");
			expect(holderOf(slot)).toBe("c");
			expect(grants.map(grant => grant.tabId)).toEqual(["a", "c"]);
		});

		it("ignores a release from a tab that neither holds nor waits", () => {
			const { slot, states } = setup();
			slot.acquire("a", "a1");
			const before = states.length;
			slot.release("zzz");
			expect(states).toHaveLength(before);
			expect(holderOf(slot)).toBe("a");
		});
	});

	describe("close and crash", () => {
		it("revokes a closing holder first, and grants the next only after the revoke answered", async () => {
			const { slot, log, revokes } = setup();
			slot.acquire("a", "a1");
			slot.acquire("b", "b1");
			const closing = slot.closed("a");
			expect(log).toEqual(["grant:a:a1", "revoke:a:closed"]);
			expect(holderOf(slot)).toBe("a");
			revokes[0]?.resolve();
			await closing;
			expect(log).toEqual(["grant:a:a1", "revoke:a:closed", "grant:b:b1"]);
			expect(holderOf(slot)).toBe("b");
		});

		it("never revokes a crashed holder: its process is gone", () => {
			const { slot, log, revokes } = setup();
			slot.acquire("a", "a1");
			slot.acquire("b", "b1");
			slot.crashed("a");
			expect(revokes).toHaveLength(0);
			expect(log).toEqual(["grant:a:a1", "grant:b:b1"]);
			expect(holderOf(slot)).toBe("b");
		});

		it("hands on at once when the holder crashes while its revoke is still pending", async () => {
			const { slot, log, revokes } = setup();
			slot.acquire("a", "a1");
			slot.acquire("b", "b1");
			void slot.stop("a");
			slot.crashed("a");
			expect(holderOf(slot)).toBe("b");
			expect(log.at(-1)).toBe("grant:b:b1");
			// The late answer changes nothing.
			revokes[0]?.resolve();
			await flush();
			expect(holderOf(slot)).toBe("b");
			expect(log.filter(entry => entry.startsWith("grant:b"))).toHaveLength(1);
		});

		it("drops a waiter whose tab closed or crashed, without a revoke", async () => {
			const { slot, revokes } = setup();
			slot.acquire("a", "a1");
			slot.acquire("b", "b1");
			slot.acquire("c", "c1");
			await slot.closed("b");
			expect(queueOf(slot)).toEqual(["c"]);
			slot.crashed("c");
			expect(queueOf(slot)).toEqual([]);
			expect(revokes).toHaveLength(0);
			expect(holderOf(slot)).toBe("a");
		});

		it("does not count a rejecting revoke as done: the slot stays with the holder", async () => {
			const { slot, revokes, grants } = setup();
			slot.acquire("a", "a1");
			slot.acquire("b", "b1");
			const closing = slot.closed("a");
			revokes[0]?.reject(new Error("process gone"));
			await closing;
			expect(grants).toHaveLength(1);
			expect(holderOf(slot)).toBe("a");
			expect(slot.state().holder?.revokeFailed).toBe(true);
		});
	});

	describe("hand-off order", () => {
		it("does not grant the next session while the revoke promise is pending", async () => {
			const { slot, log, grants, revokes } = setup();
			slot.acquire("a", "a1");
			slot.acquire("b", "b1");
			const stopping = slot.stop("a");
			await flush();
			expect(log).toEqual(["grant:a:a1", "revoke:a:stop"]);
			expect(grants).toHaveLength(1);
			// Until the revoke answers, a still holds and b still waits.
			expect(holderOf(slot)).toBe("a");
			expect(queueOf(slot)).toEqual(["b"]);

			revokes[0]?.resolve();
			await stopping;
			expect(log).toEqual(["grant:a:a1", "revoke:a:stop", "grant:b:b1"]);
			expect(holderOf(slot)).toBe("b");
		});

		it("queues new asks behind the leaving holder, the holder's own included", async () => {
			const { slot, revokes, grants } = setup();
			slot.acquire("a", "a1");
			slot.acquire("b", "b1");
			const stopping = slot.stop("a");
			slot.acquire("c", "c1");
			slot.acquire("a", "a2");
			expect(queueOf(slot)).toEqual(["b", "c", "a"]);
			revokes[0]?.resolve();
			await stopping;
			expect(holderOf(slot)).toBe("b");
			expect(grants.filter(grant => grant.requestId === "a2")).toEqual([]);
		});

		it("answers a second stop while the first revoke is pending with the same hand-off", async () => {
			const { slot, revokes } = setup();
			slot.acquire("a", "a1");
			slot.acquire("b", "b1");
			const first = slot.stop("a");
			const second = slot.stop("a");
			expect(revokes).toHaveLength(1);
			revokes[0]?.resolve();
			await Promise.all([first, second]);
			expect(holderOf(slot)).toBe("b");
		});

		it("does not hand over when the revoke never answers: the slot is revoke-failed, nobody is granted", async () => {
			const { slot, time, log } = setup();
			slot.acquire("a", "a1");
			slot.acquire("b", "b1");
			void slot.stop("a");
			await time.advance(DESKTOP_SLOT_REVOKE_TIMEOUT_MS - 1);
			expect(slot.state().holder?.revokeFailed).toBeUndefined();
			await time.advance(1);
			expect(log).toEqual(["grant:a:a1", "revoke:a:stop"]);
			expect(holderOf(slot)).toBe("a");
			expect(slot.state().holder?.revokeFailed).toBe(true);
			expect(queueOf(slot)).toEqual(["b"]);
		});

		it("retries a failed revoke on a timer and hands over only once one is confirmed", async () => {
			const { slot, time, log, revokes } = setup();
			slot.acquire("a", "a1");
			slot.acquire("b", "b1");
			void slot.stop("a");
			revokes[0]?.reject(new Error("Timed out revoking computer control"));
			await flush();
			expect(slot.state().holder?.revokeFailed).toBe(true);
			await time.advance(DESKTOP_SLOT_REVOKE_RETRY_MS);
			expect(revokes).toHaveLength(2);
			expect(holderOf(slot)).toBe("a");
			revokes[1]?.resolve();
			await flush();
			expect(log).toEqual(["grant:a:a1", "revoke:a:stop", "revoke:a:stop", "grant:b:b1"]);
			expect(holderOf(slot)).toBe("b");
			expect(slot.state().holder?.revokeFailed).toBeUndefined();
		});

		it("retry() asks again at once", async () => {
			const { slot, revokes } = setup();
			slot.acquire("a", "a1");
			void slot.stop("a");
			revokes[0]?.reject(new Error("no"));
			await flush();
			slot.retry();
			expect(revokes).toHaveLength(2);
			revokes[1]?.resolve();
			await flush();
			expect(holderOf(slot)).toBeNull();
		});

		it("accepts a revoke that answers after its timeout", async () => {
			const { slot, time, revokes } = setup();
			slot.acquire("a", "a1");
			slot.acquire("b", "b1");
			void slot.stop("a");
			await time.advance(DESKTOP_SLOT_REVOKE_TIMEOUT_MS);
			expect(holderOf(slot)).toBe("a");
			revokes[0]?.resolve();
			await flush();
			expect(holderOf(slot)).toBe("b");
		});

		it("a holder that dies after a failed revoke frees the slot for the next", async () => {
			const { slot, grants, revokes } = setup();
			slot.acquire("a", "a1");
			slot.acquire("b", "b1");
			void slot.stop("a");
			revokes[0]?.reject(new Error("no"));
			await flush();
			expect(grants).toHaveLength(1);
			slot.crashed("a");
			expect(grants.at(-1)).toEqual({ tabId: "b", requestId: "b1", waited: true });
			expect(holderOf(slot)).toBe("b");
		});

		it("does not grant the holder's own new asks while revoke-failed, and ignores its touch", async () => {
			const { slot, grants, revokes } = setup();
			slot.acquire("a", "a1");
			void slot.stop("a");
			revokes[0]?.reject(new Error("no"));
			await flush();
			slot.acquire("a", "a2");
			slot.touch("a");
			expect(grants).toHaveLength(1);
			expect(queueOf(slot)).toEqual(["a"]);
		});
	});

	describe("kill the failed session", () => {
		it("frees the slot only once the process is confirmed gone", async () => {
			const { slot, grants, revokes, kills } = setup();
			slot.acquire("a", "a1");
			slot.acquire("b", "b1");
			void slot.stop("a");
			revokes[0]?.reject(new Error("no"));
			await flush();
			const killing = slot.killHolder();
			expect(kills).toHaveLength(1);
			expect(grants).toHaveLength(1);
			kills[0]?.resolve(false);
			await killing;
			expect(holderOf(slot)).toBe("a");
			const again = slot.killHolder();
			kills[1]?.resolve(true);
			await again;
			expect(holderOf(slot)).toBe("b");
			expect(grants.at(-1)).toEqual({ tabId: "b", requestId: "b1", waited: true });
		});
	});

	describe("stop", () => {
		it("revokes the holder and frees the slot when nobody waits", async () => {
			const { slot, revokes } = setup({ autoRevoke: true });
			slot.acquire("a", "a1");
			await slot.stop("a");
			expect(revokes.map(revoke => revoke.reason)).toEqual(["stop"]);
			expect(slot.state()).toEqual({ holder: null, queue: [] });
		});

		it("takes a waiting session out of the queue and tells its process", async () => {
			const { slot, revokes } = setup({ autoRevoke: true });
			slot.acquire("a", "a1");
			slot.acquire("b", "b1");
			await slot.stop("b");
			expect(queueOf(slot)).toEqual([]);
			expect(holderOf(slot)).toBe("a");
			expect(revokes.map(revoke => `${revoke.tabId}:${revoke.reason}`)).toEqual(["b:stop"]);
		});

		it("does nothing for a tab the slot does not know", async () => {
			const { slot, revokes, states } = setup({ autoRevoke: true });
			slot.acquire("a", "a1");
			const before = states.length;
			await slot.stop("zzz");
			expect(revokes).toHaveLength(0);
			expect(states).toHaveLength(before);
		});
	});

	it("reports every change of holder and queue, in order", async () => {
		const { slot, states } = setup({ autoRevoke: true });
		slot.acquire("a", "a1");
		slot.acquire("b", "b1");
		await slot.stop("a");
		await slot.stop("b");
		expect(states.map(state => `${state.holder?.tabId ?? "-"}|${state.queue.map(s => s.tabId).join(",")}`)).toEqual([
			"a|",
			"a|b",
			"b|",
			"-|",
		]);
	});

	it("stops its timers on dispose", () => {
		const { slot, time } = setup();
		slot.acquire("a", "a1");
		expect(time.pending).toBe(1);
		slot.dispose();
		expect(time.pending).toBe(0);
	});
});
