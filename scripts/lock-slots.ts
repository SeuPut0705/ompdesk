/**
 * The machine-wide lock as counting semaphores, one per kind of heavy work
 * (`scripts/build-lock.ts` is the command line on top of this):
 *
 *   build       1 slot   builds into out/ never overlap
 *   playwright  4 slots  concurrent Playwright runs, each on an immutable out snapshot
 *   vitest      1 slot   a full vitest run and the static checks that run with it (two at once
 *                        failed the real-stock tests that one run passes)
 *   other       1 slot   anything unclassified
 *
 * Layout under `root` (`/tmp/ompdesk-locks`):
 *
 *   <kind>.<i>/owner     slot i of <kind>; `mkdir` is atomic, so it is the lock. `owner` keeps the
 *                        old single lock's first line (`name HH:MM:SS pid N`), then `since <epoch ms>`
 *                        and `command <text>`. Its mtime is the heartbeat: one older than `staleMs`
 *                        (15 minutes) is stale and the next waiter removes the slot.
 *   <kind>.queue/<ticket>  one file per waiter, named `<epoch ms>-<pid>-<n>`; sorted names are the FIFO
 *                        order. A waiter touches its ticket on every poll; a ticket whose process is
 *                        gone, or that nobody touched for `ticketStaleMs`, is dropped.
 *
 * A waiter takes a slot only when its rank in the queue is below the number of free slots, so slots go
 * to waiters in arrival order and a late short job never overtakes an earlier one.
 *
 * Migration: the old single lock directory (`legacyDir`, `/tmp/ompdesk-build.lock`) counts as holding
 * every slot of every kind. Holders still running the old script, and shell users with
 * `until mkdir /tmp/ompdesk-build.lock`, keep working: new waiters queue behind them.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { processAlive } from "../src/main/process-alive";

export type SlotKind = "build" | "playwright" | "vitest" | "other";
export const SLOT_KINDS: readonly SlotKind[] = ["build", "playwright", "vitest", "other"];

/** Slots per kind. Measured on the 15-core Mac; AGENTS.md › Build lock and gate has the numbers. */
export const DEFAULT_SLOTS: Readonly<Record<SlotKind, number>> = { build: 1, playwright: 4, vitest: 1, other: 1 };

export const STALE_MS = 15 * 60_000;
/** A non-gate hold longer than this is logged as a warning and flagged by `lock-stats`. */
export const MAX_HOLD_MS = 15 * 60_000;
const TICKET_STALE_MS = 60_000;

/**
 * Workers per Playwright run when several runs share the machine: 8 workers split over the runs holding
 * a slot, at most the run's own 4, at least 1 (4 runs × 2 workers measured fastest per run).
 */
export const WORKERS: Readonly<Partial<Record<SlotKind, { env: string; max: number; budget: number }>>> = {
	playwright: { env: "OMP_GUI_WORKERS", max: 4, budget: 8 },
};

/** The worker count for a run of `kind` that holds a slot while `busy` runs (itself included) hold one; undefined for kinds without a worker share. */
export function workersFor(kind: SlotKind, busy: number): number | undefined {
	const share = WORKERS[kind];
	return share && Math.max(1, Math.min(share.max, Math.floor(share.budget / Math.max(1, busy))));
}

export interface Locks {
	root: string;
	/** The pre-semaphore lock directory; undefined skips the migration check. */
	legacyDir?: string;
	slots: Readonly<Record<SlotKind, number>>;
	/** Time between polls of a waiter. */
	pollMs: number;
	/** Waits `ms`; a seam, so tests count polls instead of waiting out the clock. */
	sleep: (ms: number) => Promise<void>;
	staleMs: number;
	ticketStaleMs: number;
	pid: number;
	/** Reports waiting and stale takeovers; default stderr. */
	say: (message: string) => void;
}

const LOCK_ROOT = process.platform === "win32" ? path.join(os.tmpdir(), "ompdesk-locks") : "/tmp/ompdesk-locks";
const LEGACY_DIR =
	process.platform === "win32" ? path.join(os.tmpdir(), "ompdesk-build.lock") : "/tmp/ompdesk-build.lock";

/** `OMPDESK_LOCK_SLOTS=playwright=3,vitest=2` overrides the defaults, for measuring a different N. */
function slotsFromEnv(env: NodeJS.ProcessEnv): Record<SlotKind, number> {
	const slots = { ...DEFAULT_SLOTS };
	for (const part of (env.OMPDESK_LOCK_SLOTS ?? "").split(",")) {
		const [kind, count] = part.split("=");
		const n = Number(count);
		if (SLOT_KINDS.includes(kind as SlotKind) && Number.isInteger(n) && n >= 1) slots[kind as SlotKind] = n;
	}
	return slots;
}

/** `OMPDESK_LOCK_ROOT`, `OMPDESK_LOCK_POLL_MS` and `OMPDESK_LOCK_SLOTS` move the lock for tests and measurements. */
export function defaultLocks(env: NodeJS.ProcessEnv = process.env): Locks {
	return {
		root: env.OMPDESK_LOCK_ROOT || LOCK_ROOT,
		legacyDir: env.OMPDESK_LOCK_ROOT ? `${env.OMPDESK_LOCK_ROOT}.legacy` : LEGACY_DIR,
		slots: slotsFromEnv(env),
		pollMs: Number(env.OMPDESK_LOCK_POLL_MS) || 2_000,
		sleep: ms => sleep(ms),
		staleMs: STALE_MS,
		ticketStaleMs: TICKET_STALE_MS,
		pid: process.pid,
		say: message => console.error(message),
	};
}

export interface Who {
	owner: string;
	command: string;
}

export interface Lease {
	kind: SlotKind;
	slot: number;
	/** Milliseconds spent waiting for the slot. */
	waitedMs: number;
	/** Whom the last wait was behind, for the `[lock] waited` line. */
	behind: string;
	dir: string;
	/** Refresh the owner file (the heartbeat). */
	touch(): void;
	release(): void;
}

export interface SlotView {
	kind: SlotKind;
	slot: number;
	/** First line of the owner file; undefined when the slot is free. */
	holder?: string;
	command?: string;
	/** Milliseconds since the holder took the slot. */
	heldMs?: number;
	stale?: boolean;
}

const slotDir = (locks: Locks, kind: SlotKind, slot: number) => path.join(locks.root, `${kind}.${slot}`);
const queueDir = (locks: Locks, kind: SlotKind) => path.join(locks.root, `${kind}.queue`);

/** The age of `dir`'s owner file (or of `dir` itself while the owner file is not written yet). */
function ageMs(dir: string): number | undefined {
	const stat =
		fs.statSync(path.join(dir, "owner"), { throwIfNoEntry: false }) ?? fs.statSync(dir, { throwIfNoEntry: false });
	return stat ? Date.now() - stat.mtimeMs : undefined;
}

function readOwner(dir: string): { holder: string; since?: number; command?: string } {
	let text: string;
	try {
		text = fs.readFileSync(path.join(dir, "owner"), "utf8");
	} catch {
		return { holder: "(no owner file yet)" };
	}
	const lines = text.split("\n");
	const since = Number(/^since (\d+)$/m.exec(text)?.[1]);
	return {
		holder: (lines[0] ?? "").trim() || "(unnamed)",
		since: Number.isFinite(since) && since > 0 ? since : undefined,
		command: /^command (.*)$/m.exec(text)?.[1],
	};
}

/** Remove a slot nobody refreshed; renamed away first so only one waiter removes it. */
function removeStale(locks: Locks, dir: string, what: string, holder: string): void {
	const gone = `${dir}.stale-${locks.pid}-${Date.now()}`;
	try {
		fs.renameSync(dir, gone);
	} catch {
		return; // someone else removed it (or it was released).
	}
	const age = ageMs(gone);
	if (age !== undefined && age <= locks.staleMs) {
		// A fresh holder took the slot between our check and the rename: give it back.
		try {
			fs.renameSync(gone, dir);
			return;
		} catch {
			// The slot is taken again; the moved lock is lost either way.
		}
	}
	locks.say(`[build-lock] removing a stale ${what} held by ${holder}`);
	fs.rmSync(gone, { recursive: true, force: true });
}

/** Live waiters of `kind`, oldest first; dead and untouched tickets are dropped. */
function liveTickets(locks: Locks, kind: SlotKind): string[] {
	const dir = queueDir(locks, kind);
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const live: string[] = [];
	for (const name of names.sort()) {
		const pid = Number(name.split("-")[1]);
		const stat = fs.statSync(path.join(dir, name), { throwIfNoEntry: false });
		if (!stat) continue;
		if (Date.now() - stat.mtimeMs > locks.ticketStaleMs || (Number.isInteger(pid) && !processAlive(pid))) {
			fs.rmSync(path.join(dir, name), { force: true });
			continue;
		}
		live.push(name);
	}
	return live;
}

let ticketSeq = 0;

/** What every slot of every kind holds right now; a stale slot reads as held, flagged `stale`. */
export function inspectSlots(locks: Locks): SlotView[] {
	const views: SlotView[] = [];
	for (const kind of SLOT_KINDS) {
		for (let slot = 0; slot < locks.slots[kind]; slot++) {
			const dir = slotDir(locks, kind, slot);
			const age = ageMs(dir);
			if (age === undefined) {
				views.push({ kind, slot });
				continue;
			}
			const owner = readOwner(dir);
			views.push({
				kind,
				slot,
				holder: owner.holder,
				command: owner.command,
				heldMs: owner.since ? Date.now() - owner.since : undefined,
				stale: age > locks.staleMs,
			});
		}
	}
	return views;
}

/**
 * Take a slot of `kind`: FIFO among waiters, as long as it takes. A legacy single-lock holder blocks
 * every kind until it releases.
 */
export async function acquireSlot(locks: Locks, kind: SlotKind, who: Who): Promise<Lease> {
	fs.mkdirSync(queueDir(locks, kind), { recursive: true });
	const seq = String(ticketSeq++).padStart(6, "0");
	const ticket = path.join(queueDir(locks, kind), `${String(Date.now()).padStart(14, "0")}-${locks.pid}-${seq}`);
	fs.writeFileSync(ticket, "");
	const started = performance.now();
	let reported = "";
	let behind = "";
	try {
		for (;;) {
			const now = new Date();
			fs.utimesSync(ticket, now, now);
			const blocker = legacyHolder(locks);
			if (blocker) {
				behind = blocker;
				if (reported !== blocker) {
					locks.say(
						`[build-lock] waiting for ${locks.legacyDir} (held by ${blocker}; the old single lock holds every slot)`,
					);
					reported = blocker;
				}
			} else {
				const lease = tryTake(locks, kind, who, ticket, started);
				if (lease) {
					lease.behind = behind || reported;
					return lease;
				}
				const held = holders(locks, kind);
				behind = held.at(-1) ?? behind;
				const key = held.join(", ");
				if (key !== reported) {
					const ahead = liveTickets(locks, kind).indexOf(path.basename(ticket));
					locks.say(
						`[build-lock] waiting for a ${kind} slot (held by ${key || "(a slot being released)"}${ahead > 0 ? `; ${ahead} waiting ahead` : ""})`,
					);
					reported = key;
				}
			}
			await locks.sleep(locks.pollMs);
		}
	} finally {
		fs.rmSync(ticket, { force: true });
	}
}

/** The legacy lock's holder, when one holds it (a stale one is removed and reads as free). */
function legacyHolder(locks: Locks): string | undefined {
	const dir = locks.legacyDir;
	if (!dir) return undefined;
	const age = ageMs(dir);
	if (age === undefined) return undefined;
	const { holder } = readOwner(dir);
	if (age > locks.staleMs) {
		locks.say(`[build-lock] removing a stale lock held by ${holder}`);
		fs.rmSync(path.join(dir, "owner"), { force: true });
		fs.rmSync(dir, { recursive: true, force: true });
		return undefined;
	}
	return holder;
}

function holders(locks: Locks, kind: SlotKind): string[] {
	const names: string[] = [];
	for (let slot = 0; slot < locks.slots[kind]; slot++) {
		const dir = slotDir(locks, kind, slot);
		if (ageMs(dir) !== undefined) names.push(readOwner(dir).holder);
	}
	return names;
}

/** One attempt: a slot when this waiter's rank is below the free count and a `mkdir` wins. */
function tryTake(locks: Locks, kind: SlotKind, who: Who, ticket: string, started: number): Lease | undefined {
	const free: number[] = [];
	for (let slot = 0; slot < locks.slots[kind]; slot++) {
		const dir = slotDir(locks, kind, slot);
		const age = ageMs(dir);
		if (age !== undefined && age > locks.staleMs) {
			removeStale(locks, dir, `${kind} slot`, readOwner(dir).holder);
			free.push(slot);
		} else if (age === undefined) free.push(slot);
	}
	const rank = liveTickets(locks, kind).indexOf(path.basename(ticket));
	if (rank < 0 || rank >= free.length) return undefined;
	for (const slot of free) {
		const dir = slotDir(locks, kind, slot);
		try {
			fs.mkdirSync(dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw error;
		}
		const owner = path.join(dir, "owner");
		const time = new Date().toTimeString().slice(0, 8);
		fs.writeFileSync(
			owner,
			`${who.owner} ${time} pid ${locks.pid}\nsince ${Date.now()}\ncommand ${who.command.replace(/\s+/g, " ")}\n`,
		);
		return {
			kind,
			slot,
			waitedMs: performance.now() - started,
			behind: "",
			dir,
			touch() {
				const now = new Date();
				try {
					fs.utimesSync(owner, now, now);
				} catch {
					// The slot was removed as stale; nothing to refresh.
				}
			},
			release() {
				fs.rmSync(owner, { force: true });
				try {
					fs.rmdirSync(dir);
				} catch {
					// Someone removed it as stale; nothing left to release.
				}
			},
		};
	}
	return undefined;
}
