import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { configureNativeBin, nativeBinPath } from "../src/main/native-bin";
import { removeWhenFree } from "../src/main/test-folders";
import { ensureNative } from "./build-native";
import {
	acquireHeavy,
	acquireHold,
	acquireSlot,
	DEFAULT_SLOTS,
	HEAVY_HELD_ENV,
	heavyPoolSize,
	heavyStatus,
	inspectHeavy,
	inspectSlots,
	type Lease,
	type Locks,
	ramWorkers,
	type SlotKind,
	workersFor,
} from "./lock-slots";

let polls = 0;
const countPoll = async () => {
	polls++;
	await new Promise(resolve => setImmediate(resolve));
};
/** Wait until every waiter has polled a few more times: what a waiter that stays blocked looks like. */
const settle = () => {
	const start = polls;
	return vi.waitFor(() => expect(polls).toBeGreaterThanOrEqual(start + 4));
};

let dir: string;
let said: string[];
const leases: Lease[] = [];
const GiB = 1024 ** 3;

/** The test's own heavy pool (`OMPDESK_HEAVY_DIR`): never the computer's, whatever else is running on it. */
function locksFor(slots: Partial<Record<SlotKind, number>> = {}, heavySlots = 1): Locks {
	return {
		root: path.join(dir, "locks"),
		legacyDir: path.join(dir, "legacy.lock"),
		slots: { ...DEFAULT_SLOTS, ...slots },
		pollMs: 5,
		sleep: countPoll,
		staleMs: 15 * 60_000,
		ticketStaleMs: 60_000,
		pid: process.pid,
		env: {
			...process.env,
			OMPDESK_HEAVY_DIR: path.join(dir, "heavy"),
			OMPDESK_HEAVY_SLOTS: String(heavySlots),
			[HEAVY_HELD_ENV]: "",
		},
		say: message => said.push(message),
	};
}

const who = (name: string) => ({ owner: name, command: `cmd ${name}` });

/** Take a slot and remember it for cleanup. */
async function take(locks: Locks, kind: SlotKind, name: string): Promise<Lease> {
	const lease = await acquireSlot(locks, kind, who(name));
	leases.push(lease);
	return lease;
}

/** Start taking a slot; `granted` flips when it is held. */
function waiter(locks: Locks, kind: SlotKind, name: string, order: string[] = []) {
	const state = { granted: false, lease: undefined as Lease | undefined };
	const done = acquireSlot(locks, kind, who(name)).then(lease => {
		state.granted = true;
		state.lease = lease;
		leases.push(lease);
		order.push(name);
		return lease;
	});
	return { state, done };
}

const age = (file: string, ms: number) => {
	const then = new Date(Date.now() - ms);
	fs.utimesSync(file, then, then);
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-slots-"));
	said = [];
});
// A released `ompdesk heavy hold` removes its slot's owner file as it exits; on Windows that pending delete refuses the
// folder's removal (EPERM) until the hold is gone.
afterEach(async () => {
	for (const lease of leases.splice(0)) lease.release();
	await removeWhenFree(dir);
});

describe("slots", () => {
	it("gives out N slots of a kind, then makes the next waiter wait until one is released", async () => {
		const locks = locksFor({ playwright: 2 });
		const a = await take(locks, "playwright", "a");
		const b = await take(locks, "playwright", "b");
		expect([a.slot, b.slot].sort()).toEqual([0, 1]);
		const c = waiter(locks, "playwright", "c");
		await settle();
		expect(c.state.granted).toBe(false);
		b.release();
		const lease = await c.done;
		expect(lease.slot).toBe(b.slot);
		expect(lease.waitedMs).toBeGreaterThan(0);
	});

	it("keeps builds exclusive and kinds independent of each other", async () => {
		const locks = locksFor();
		const build = await take(locks, "build", "builder");
		const second = waiter(locks, "build", "second-builder");
		const test = await take(locks, "playwright", "tester");
		expect(test.kind).toBe("playwright");
		await settle();
		expect(second.state.granted).toBe(false);
		build.release();
		await second.done;
		expect(second.state.granted).toBe(true);
	});

	it("writes the owner file the single lock wrote, first line included", async () => {
		const locks = locksFor();
		const lease = await take(locks, "vitest", "agent@checkout");
		const owner = fs.readFileSync(path.join(lease.dir, "owner"), "utf8");
		expect(owner.split("\n")[0]).toMatch(/^agent@checkout \d\d:\d\d:\d\d pid \d+$/);
		expect(owner).toMatch(/^command cmd agent@checkout$/m);
		const [view] = inspectSlots(locks).filter(slot => slot.kind === "vitest" && slot.slot === lease.slot);
		expect(view?.holder).toMatch(/^agent@checkout /);
		lease.release();
		expect(fs.existsSync(lease.dir)).toBe(false);
		expect(inspectSlots(locks).every(slot => slot.holder === undefined)).toBe(true);
	});
});

describe("fairness", () => {
	it("serves waiters in arrival order", async () => {
		const locks = locksFor({ build: 1 });
		const holder = await take(locks, "build", "holder");
		const order: string[] = [];
		const first = waiter(locks, "build", "first", order);
		const second = waiter(locks, "build", "second", order);
		const third = waiter(locks, "build", "third", order);
		await settle();
		expect(order).toEqual([]);
		holder.release();
		(await first.done).release();
		(await second.done).release();
		await third.done;
		expect(order).toEqual(["first", "second", "third"]);
	});

	it("never lets a later waiter take a freed slot ahead of an earlier one", async () => {
		const locks = locksFor({ vitest: 2 });
		const a = await take(locks, "vitest", "a");
		await take(locks, "vitest", "b");
		const early = waiter(locks, "vitest", "early");
		const late = waiter(locks, "vitest", "late");
		a.release();
		await early.done;
		await settle();
		expect(late.state.granted).toBe(false);
		early.state.lease?.release();
		await late.done;
	});

	it("drops the ticket of a waiter whose process is gone", async () => {
		const locks = locksFor({ build: 1 });
		const queue = path.join(locks.root, "build.queue");
		fs.mkdirSync(queue, { recursive: true });
		fs.writeFileSync(path.join(queue, `${String(Date.now() - 1000).padStart(14, "0")}-2147483646-0`), "");
		const lease = await take(locks, "build", "alive");
		expect(lease.waitedMs).toBeLessThan(1000);
	});

	it("drops a ticket nobody touched for the ticket timeout", async () => {
		const locks = { ...locksFor({ build: 1 }), ticketStaleMs: 1_000 };
		const queue = path.join(locks.root, "build.queue");
		fs.mkdirSync(queue, { recursive: true });
		const stuck = path.join(queue, `${String(Date.now() - 1000).padStart(14, "0")}-${process.pid}-99`);
		fs.writeFileSync(stuck, "");
		age(stuck, 5_000);
		const lease = await take(locks, "build", "alive");
		expect(lease.waitedMs).toBeLessThan(1000);
		expect(fs.existsSync(stuck)).toBe(false);
	});
});

describe("stale slots", () => {
	it("removes a slot whose owner file nobody refreshed for 15 minutes", async () => {
		const locks = locksFor({ build: 1 });
		const dead = path.join(locks.root, "build.0");
		fs.mkdirSync(dead, { recursive: true });
		fs.writeFileSync(path.join(dead, "owner"), "crashed@checkout 10:00:00 pid 1\n");
		age(path.join(dead, "owner"), 16 * 60_000);
		const lease = await take(locks, "build", "next");
		expect(lease.slot).toBe(0);
		expect(said.join("\n")).toMatch(/removing a stale build slot held by crashed@checkout/);
	});

	it("keeps a slot refreshed within 15 minutes", async () => {
		const locks = locksFor({ build: 1 });
		const live = path.join(locks.root, "build.0");
		fs.mkdirSync(live, { recursive: true });
		fs.writeFileSync(path.join(live, "owner"), "busy@checkout 10:00:00 pid 1\n");
		age(path.join(live, "owner"), 14 * 60_000);
		const next = waiter(locks, "build", "next");
		await settle();
		expect(next.state.granted).toBe(false);
		expect(said.join("\n")).toMatch(/waiting for a build slot \(held by busy@checkout/);
		// The holder's heartbeat is the owner file's mtime; one that is stale is not renewed by waiting.
		fs.rmSync(live, { recursive: true });
		await next.done;
	});

	it("a lease's touch is the heartbeat that keeps its slot from going stale", async () => {
		const locks = locksFor({ build: 1 });
		const lease = await take(locks, "build", "holder");
		age(path.join(lease.dir, "owner"), 16 * 60_000);
		expect(inspectSlots(locks).find(slot => slot.kind === "build")?.stale).toBe(true);
		lease.touch();
		expect(inspectSlots(locks).find(slot => slot.kind === "build")?.stale).toBe(false);
	});
});

describe("migration from the single lock", () => {
	it("treats the old lock directory as holding every slot of every kind until it is released", async () => {
		const locks = locksFor();
		const legacy = locks.legacyDir as string;
		fs.mkdirSync(legacy);
		fs.writeFileSync(path.join(legacy, "owner"), "old@checkout 10:00:00 pid 1\n");
		const build = waiter(locks, "build", "b");
		const playwright = waiter(locks, "playwright", "p");
		const vitest = waiter(locks, "vitest", "v");
		await settle();
		expect([build, playwright, vitest].map(w => w.state.granted)).toEqual([false, false, false]);
		expect(said.join("\n")).toMatch(/held by old@checkout 10:00:00 pid 1; the old single lock holds every slot/);
		fs.rmSync(legacy, { recursive: true });
		const got = await Promise.all([build.done, playwright.done, vitest.done]);
		expect(got.map(lease => lease.behind)).toEqual(Array(3).fill("old@checkout 10:00:00 pid 1"));
	});

	it("removes an old lock whose owner file is stale", async () => {
		const locks = locksFor();
		const legacy = locks.legacyDir as string;
		fs.mkdirSync(legacy);
		fs.writeFileSync(path.join(legacy, "owner"), "gone@checkout 09:00:00 pid 1\n");
		age(path.join(legacy, "owner"), 20 * 60_000);
		await take(locks, "playwright", "p");
		expect(fs.existsSync(legacy)).toBe(false);
		expect(said.join("\n")).toMatch(/removing a stale lock held by gone@checkout/);
	});
});

describe("workers per run", () => {
	it("splits the worker budget over the runs holding slots, within one worker and the run's own default", () => {
		expect([1, 2, 3, 4, 8].map(busy => workersFor("playwright", busy, 64 * GiB))).toEqual([4, 4, 2, 2, 1]);
		expect(workersFor("vitest", 1, 64 * GiB)).toBeUndefined();
		expect(workersFor("build", 1, 64 * GiB)).toBeUndefined();
		expect(workersFor("playwright", 0, 64 * GiB)).toBe(4);
	});

	it("gives a 16 GB machine at most 2 workers per run, whatever else holds slots", () => {
		expect([0, 1, 2].map(busy => workersFor("playwright", busy, 16 * GiB))).toEqual([2, 2, 1]);
		expect(ramWorkers(16 * GiB)).toBe(2);
		expect(ramWorkers(8 * GiB)).toBe(1);
		expect(ramWorkers(64 * GiB)).toBe(8);
	});
});

// 2 Nov 2026: 11 sessions on this 16 GB Mac ran checks side by side (one of each kind fit in the per-kind slots, more
// outside the lock) and WindowServer stalled at 29.9 GB of footprint. A small machine runs one heavy hold at a time; the
// pool that enforces it is the product's (`ompdesk heavy`), so these cases run the real binary on a temp pool.
describe("the computer's heavy slots (the real ompdesk, a temp pool)", () => {
	beforeAll(() => {
		ensureNative();
	}, 900_000);

	const pause = (ms = 600) => new Promise(resolve => setTimeout(resolve, ms));
	/** Until `count` holds wait in the pool's queue: how a test fixes the order its waiters arrive in. */
	const queued = (locks: Locks, count: number) =>
		vi.waitFor(async () => expect((await heavyStatus(locks.env))?.queue.length).toBe(count), { timeout: 20_000 });

	it("runs holds of every kind one at a time, first come first served, whichever checkout asks", async () => {
		const locks = locksFor();
		const order: string[] = [];
		const hold = (kind: SlotKind, name: string) => {
			const state = { granted: false };
			const done = acquireHold(locks, kind, who(name)).then(lease => {
				state.granted = true;
				leases.push(lease);
				order.push(name);
				return lease;
			});
			return { state, done };
		};
		const first = await acquireHold(locks, "playwright", who("a@checkout-one"));
		leases.push(first);
		const waiting: Array<ReturnType<typeof hold>> = [];
		for (const [kind, name] of [
			["build", "b@checkout-two"],
			["vitest", "c@checkout-one"],
			["playwright", "d@checkout-two"],
			["other", "e@checkout-one"],
		] as const) {
			waiting.push(hold(kind, name));
			await queued(locks, waiting.length);
		}
		await pause();
		expect(waiting.map(w => w.state.granted)).toEqual([false, false, false, false]);
		expect(said.join("\n")).toMatch(/waiting for a heavy slot.*held by a@checkout-one pid \d+: cmd a@checkout-one/);
		first.release();
		for (const [i, w] of waiting.entries()) {
			const lease = await w.done;
			if (i < waiting.length - 1) await pause();
			expect(waiting.map(other => other.state.granted)).toEqual(waiting.map((_, j) => j <= i));
			lease.release();
		}
		expect(order).toEqual(["b@checkout-two", "c@checkout-one", "d@checkout-two", "e@checkout-one"]);
	}, 60_000);

	it("lets a command nested under a heavy holder take its own kind at once, and names the holder for ompdesk", async () => {
		const locks = locksFor();
		const parent = await acquireHold(locks, "playwright", who("parent"));
		leases.push(parent);
		const nested = await acquireHold(locks, "build", who("child"), { heavyHeld: true });
		leases.push(nested);
		expect(nested.kind).toBe("build");
		expect(nested.heavyPid).toBeUndefined();
		// A nested `ompdesk run --heavy` that names the parent's hold runs at once although the pool's only slot is taken.
		const inside = spawnSync(nativeBinPath("ompdesk"), ["run", "--heavy", "--", "node", "-e", "0"], {
			env: { ...locks.env, [HEAVY_HELD_ENV]: String(parent.heavyPid) },
			timeout: 20_000,
		});
		expect(inside.status).toBe(0);
	}, 60_000);

	it("gives the slot back when the lease is released, and shows the holder while it is held", async () => {
		const locks = locksFor();
		const lease = await acquireHold(locks, "vitest", who("agent@checkout"));
		const held = await inspectHeavy(locks);
		expect(held).toHaveLength(1);
		expect(held[0]).toMatchObject({ kind: "heavy", slot: 0 });
		expect(held[0]?.holder).toMatch(/^agent@checkout pid \d+: cmd agent@checkout$/);
		expect(lease.heavyPid).toBeGreaterThan(0);
		expect((await heavyStatus(locks.env))?.slots[0]?.owner?.pid).toBe(lease.heavyPid);
		lease.release();
		await vi.waitFor(async () => expect((await inspectHeavy(locks))[0]?.holder).toBeUndefined(), { timeout: 20_000 });
		const again = await acquireHold(locks, "vitest", who("next"));
		leases.push(again);
		expect(again.heavyPid).not.toBe(lease.heavyPid);
	}, 60_000);

	it("gives a dead holder's slot to the next waiter at once, with no stale timeout", async () => {
		const locks = locksFor({ build: 2 });
		const dead = await acquireHeavy(locks, who("crashed@checkout"));
		if (!dead) throw new Error("no pool");
		const next = acquireHeavy(locks, who("next@checkout"));
		await queued(locks, 1);
		process.kill(dead.pid, "SIGKILL");
		const lease = await next;
		expect(lease?.waitedMs).toBeLessThan(10_000);
		lease?.release();
	}, 60_000);

	it("is as large as the pool says: OMPDESK_HEAVY_SLOTS, else the product's rule", async () => {
		expect(await heavyPoolSize(locksFor({}, 3).env)).toBe(3);
		const asked = { ...process.env, OMPDESK_HEAVY_DIR: path.join(dir, "heavy"), OMPDESK_HEAVY_SLOTS: "" };
		const size = await heavyPoolSize(asked);
		expect(size).toBeGreaterThanOrEqual(1);
		expect(size).toBeLessThanOrEqual(7);
	});

	it("skips the pool on a GitHub runner with no staged binary, and sizes it as one", async () => {
		const empty = path.join(dir, "no-resources");
		configureNativeBin({ packaged: false, resourcesPath: empty });
		try {
			const locks = locksFor();
			locks.env.GITHUB_ACTIONS = "true";
			expect(await acquireHeavy(locks, who("runner"))).toBeUndefined();
			const lease = await acquireHold(locks, "vitest", who("runner"));
			leases.push(lease);
			expect(lease.heavyPid).toBeUndefined();
			expect(await heavyPoolSize(locks.env)).toBe(1);
			expect(await inspectHeavy(locks)).toEqual([]);
		} finally {
			configureNativeBin({ packaged: false, resourcesPath: path.join(import.meta.dirname, "..", "resources") });
		}
	});
});
