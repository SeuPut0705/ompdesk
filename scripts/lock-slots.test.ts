import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	acquireSlot,
	DEFAULT_SLOTS,
	inspectSlots,
	type Lease,
	type Locks,
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

function locksFor(slots: Partial<Record<SlotKind, number>> = {}): Locks {
	return {
		root: path.join(dir, "locks"),
		legacyDir: path.join(dir, "legacy.lock"),
		slots: { ...DEFAULT_SLOTS, ...slots },
		pollMs: 5,
		sleep: countPoll,
		staleMs: 15 * 60_000,
		ticketStaleMs: 60_000,
		pid: process.pid,
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
afterEach(() => {
	for (const lease of leases.splice(0)) lease.release();
	fs.rmSync(dir, { recursive: true, force: true });
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
		expect([1, 2, 3, 4, 8].map(busy => workersFor("playwright", busy))).toEqual([4, 4, 2, 2, 1]);
		expect(workersFor("vitest", 1)).toBeUndefined();
		expect(workersFor("build", 1)).toBeUndefined();
		expect(workersFor("playwright", 0)).toBe(4);
	});
});
