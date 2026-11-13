/**
 * The machine-wide lock: a counting semaphore per kind of heavy work, on top of the computer's heavy slots
 * (`scripts/build-lock.ts` is the command line on top of this):
 *
 *   build       1 slot   builds into out/ never overlap
 *   playwright  4 slots  concurrent Playwright runs, each on an immutable out snapshot
 *   vitest      1 slot   a full vitest run and the static checks that run with it (two at once
 *                        failed the real-stock tests that one run passes)
 *   other       1 slot   anything unclassified
 *   heavy       the product's pool (`ompdesk heavy`, native/ompdesk/crates/checks/src/heavy.rs): every hold of any
 *                        kind also takes one of its slots first (`acquireHold`), so a computer runs at most
 *                        `pool_size` heavy holds together, whichever project, session or script asks: one on 16 GB.
 *                        This file never sizes or locks it itself: a hold spawns `ompdesk heavy hold` and gives the
 *                        slot back by closing its stdin; the size comes from `ompdesk heavy status --json`.
 *
 * The kinds stay this repository's own (they are about `out/` and this checkout). Layout under `root`
 * (`/tmp/ompdesk-locks`):
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
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { processAlive } from "../src/main/process-alive";
import { baseTemp } from "./run-temp";

export type SlotKind = "build" | "playwright" | "vitest" | "other";
export const SLOT_KINDS: readonly SlotKind[] = ["build", "playwright", "vitest", "other"];
/** What `inspectSlots` and `inspectHeavy` list: a kind's slots, and the product pool's under `heavy`. */
export type LockSlot = SlotKind | "heavy";

/** Slots per kind. Measured on the 15-core Mac; AGENTS.md › Build lock and gate has the numbers. */
export const DEFAULT_SLOTS: Readonly<Record<SlotKind, number>> = { build: 1, playwright: 4, vitest: 1, other: 1 };

const GiB = 1024 ** 3;

/** This machine's RAM in bytes; `OMPDESK_LOCK_RAM_GB` stands in for it in tests. */
export function machineRam(env: NodeJS.ProcessEnv = process.env): number {
	const gb = Number(env.OMPDESK_LOCK_RAM_GB);
	return gb > 0 ? gb * GiB : os.totalmem();
}

/** RAM in whole GB (a 16 GB Mac reports 17 179 869 184 bytes). */
const ramGb = (totalBytes: number) => Math.round(totalBytes / GiB);

/**
 * Test or browser workers one heavy hold may run: one per 8 GB of RAM (2 on 16 GB). A share of one hold, not the
 * pool's size (that is `heavyPoolSize`, from `ompdesk heavy status`), so a config file loads this without spawning.
 */
export function ramWorkers(totalBytes: number): number {
	return Math.max(1, Math.floor(ramGb(totalBytes) / 8));
}

export const STALE_MS = 15 * 60_000;
/** A non-gate hold longer than this is logged as a warning and flagged by `lock-stats`. */
export const MAX_HOLD_MS = 15 * 60_000;
const TICKET_STALE_MS = 60_000;

/**
 * Workers per Playwright run when several runs share the machine: 8 workers split over the runs holding
 * a slot, at most the run's own 4, at least 1 (4 runs × 2 workers measured fastest per run); both capped
 * by RAM (`ramWorkers`).
 */
export const WORKERS: Readonly<Partial<Record<SlotKind, { env: string; max: number; budget: number }>>> = {
	playwright: { env: "OMP_GUI_WORKERS", max: 4, budget: 8 },
};

/** The worker count for a run of `kind` that holds a slot while `busy` runs (itself included) hold one; undefined for kinds without a worker share. */
export function workersFor(kind: SlotKind, busy: number, totalBytes = machineRam()): number | undefined {
	const share = WORKERS[kind];
	if (!share) return undefined;
	const ram = ramWorkers(totalBytes);
	const budget = Math.min(share.budget, ram);
	return Math.max(1, Math.min(share.max, ram, Math.floor(budget / Math.max(1, busy))));
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
	/** What `ompdesk heavy` runs with: `OMPDESK_HEAVY_DIR` and `OMPDESK_HEAVY_SLOTS` move the pool for a test. */
	env: NodeJS.ProcessEnv;
	/** Reports waiting and stale takeovers; default stderr. */
	say: (message: string) => void;
}

// Windows: the temp folder the machine shares, never a test run's own (scripts/run-temp.ts), or a lock taken inside a
// run would be a private one.
const LOCK_ROOT = process.platform === "win32" ? path.join(baseTemp(), "ompdesk-locks") : "/tmp/ompdesk-locks";
const LEGACY_DIR =
	process.platform === "win32" ? path.join(baseTemp(), "ompdesk-build.lock") : "/tmp/ompdesk-build.lock";

/** `OMPDESK_LOCK_SLOTS=playwright=3` overrides the defaults, for measuring a different N. The heavy pool is `OMPDESK_HEAVY_SLOTS`. */
function slotsFromEnv(env: NodeJS.ProcessEnv): Record<SlotKind, number> {
	const slots: Record<SlotKind, number> = { ...DEFAULT_SLOTS };
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
		env,
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
	/** Milliseconds spent waiting for the slot (the heavy pool's included). */
	waitedMs: number;
	/** Whom the last wait was behind, for the `[lock] waited` line. */
	behind: string;
	dir: string;
	/** The pid of the `ompdesk heavy hold` that keeps this hold's heavy slot, which nested commands name in `OMPDESK_HEAVY_HELD`. */
	heavyPid?: number;
	/** Refresh the owner file (the heartbeat). */
	touch(): void;
	release(): void;
}

export interface SlotView {
	kind: LockSlot;
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

/** What `readOwner` names a lock folder whose owner file is not there (not yet written, or already removed). */
const NO_OWNER = "(no owner file yet)";

function readOwner(dir: string): { holder: string; since?: number; command?: string } {
	let text: string;
	try {
		text = fs.readFileSync(path.join(dir, "owner"), "utf8");
	} catch {
		return { holder: NO_OWNER };
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

/** What every slot of every kind holds right now; a stale slot reads as held, flagged `stale`. The heavy pool is `inspectHeavy`. */
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
				// A lock being removed loses its owner file before its folder (one step after the other on Windows):
				// the holder named so far stays the one this waited behind.
				if (blocker !== NO_OWNER || !behind) behind = blocker;
				if (reported !== behind) {
					locks.say(
						`[build-lock] waiting for ${locks.legacyDir} (held by ${behind}; the old single lock holds every slot)`,
					);
					reported = behind;
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

/** The environment variable `ompdesk run --heavy` and this lock name a holder's `ompdesk heavy hold` pid in. */
export const HEAVY_HELD_ENV = "OMPDESK_HEAVY_HELD";

/**
 * The staged `ompdesk` that runs the pool (`src/main/native-bin.ts` says where; `bun run build:native` stages it).
 * Present: that one, however old, because the `heavy` commands are a stable wire and `ensureNative` would rebuild
 * (cargo, outside the pool) every time a peer edits `native/`. Absent: `build` runs `ensureNative` once; on GitHub's
 * runners it never does and the pool is skipped (undefined): one job owns a runner, so there is nothing to share,
 * and ci.yml's `static` job (`bun run check:types`, `electron: "false"`) stages no binary
 * (`.github/actions/install`). Loaded on first use: the vitest and Playwright configs import this file for
 * `ramWorkers` and must not load `src/main/native-bin.ts` or `build-native.ts` for it.
 */
async function heavyBinary(env: NodeJS.ProcessEnv, build: boolean): Promise<string | undefined> {
	const { nativeBinPath } = await import("../src/main/native-bin");
	const staged = nativeBinPath("ompdesk");
	if (fs.existsSync(staged)) return staged;
	if (env.GITHUB_ACTIONS || !build) return undefined;
	(await import("./build-native")).ensureNative();
	return staged;
}

export interface HeavyStatus {
	dir: string;
	size: number;
	slots: Array<{
		slot: number;
		owner: { pid: number; command: string; cwd: string; since: number; weight: number } | null;
		held: boolean;
	}>;
	/** Waiters' pids, oldest first. */
	queue: number[];
}

/** `ompdesk heavy status --json`; undefined where no binary is staged (a GitHub runner, or before the first build). */
export async function heavyStatus(env: NodeJS.ProcessEnv = process.env): Promise<HeavyStatus | undefined> {
	const bin = await heavyBinary(env, false);
	if (!bin) return undefined;
	const result = spawnSync(bin, ["heavy", "status", "--json"], { env, encoding: "utf8", windowsHide: true });
	if (result.status !== 0)
		throw new Error(`ompdesk heavy status failed: ${(result.stderr || String(result.error)).trim()}`);
	return JSON.parse(result.stdout) as HeavyStatus;
}

/**
 * How many heavy holds the computer runs at once: the pool's size, `OMPDESK_HEAVY_SLOTS` included, so there is one
 * copy of the rule (`pool_size` in heavy.rs). 1 where there is no pool to ask, the safe answer for `runSteps`.
 */
export async function heavyPoolSize(env: NodeJS.ProcessEnv = process.env): Promise<number> {
	return (await heavyStatus(env))?.size ?? 1;
}

/** The pool's slots as `SlotView`s, for `lock-stats`; none where there is no pool. */
export async function inspectHeavy(locks: Locks): Promise<SlotView[]> {
	const status = await heavyStatus(locks.env);
	if (!status) return [];
	return status.slots.map(({ slot, owner, held }): SlotView => {
		if (owner) return { kind: "heavy", slot, holder: owner.command, heldMs: Date.now() - owner.since };
		return held ? { kind: "heavy", slot, holder: "(held; no owner record)" } : { kind: "heavy", slot };
	});
}

export interface HeavyLease {
	/** The `ompdesk heavy hold` process that keeps the slot. */
	pid: number;
	waitedMs: number;
	/** Who held the pool when the wait began, from the waiter's own wait line. */
	behind: string;
	/** Gives the slot back: closes the hold's stdin. A holder that dies gives it back the same way. */
	release(): void;
}

/** Holds that still wait for their slot: killed when this process ends, so a dead waiter never takes a slot late. */
const waitingHolds = new Set<ChildProcess>();
process.on("exit", () => {
	for (const child of waitingHolds) child.kill();
});

/**
 * One heavy slot of the product pool, FIFO behind every other waiter on the computer: spawns `ompdesk heavy hold`
 * and waits for its `held` line. The child lives in its own process group, so a Ctrl-C in the terminal reaches only
 * the command, never the slot before `release`. Undefined where the pool is skipped (`heavyBinary`).
 */
export async function acquireHeavy(locks: Locks, who: Who): Promise<HeavyLease | undefined> {
	const bin = await heavyBinary(locks.env, true);
	if (!bin) return undefined;
	const started = performance.now();
	const env: NodeJS.ProcessEnv = {
		...locks.env,
		OMPDESK_HEAVY_LABEL: `${who.owner} pid ${locks.pid}: ${who.command.replace(/\s+/g, " ")}`,
	};
	delete env[HEAVY_HELD_ENV];
	const child = spawn(bin, ["heavy", "hold"], {
		env,
		stdio: ["pipe", "pipe", "pipe"],
		detached: process.platform !== "win32",
		windowsHide: true,
	});
	child.stdin.on("error", () => {
		// The hold already ended; closing a closed pipe is the release it wanted.
	});
	let behind = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		for (const line of chunk.split("\n")) {
			if (!line.trim()) continue;
			locks.say(line);
			const holder = /held by (.+)$/.exec(line)?.[1];
			if (holder && holder !== "nobody yet") behind = holder;
		}
	});
	const held = Promise.withResolvers<void>();
	let out = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		out += chunk;
		if (/^held [\d,]+ pid \d+\r?$/m.test(out)) held.resolve();
	});
	child.once("error", held.reject);
	child.once("close", code => held.reject(new Error(`ompdesk heavy hold ended (exit ${code}) before it held a slot`)));
	waitingHolds.add(child);
	try {
		await held.promise;
	} finally {
		waitingHolds.delete(child);
	}
	if (child.pid === undefined) throw new Error("ompdesk heavy hold has no pid");
	// Once held, the hold must not keep this process alive: a script that takes the lock and simply ends (build-cache's
	// build path) would otherwise wait for the hold forever while the hold waits for this process's stdin to close
	// (13 Nov 2026: a measurement held a heavy slot and the build slot for six hours). The slot is given back when this
	// process exits, as before: the exit handler releases it and the OS closes the hold's stdin.
	child.unref();
	for (const stream of [child.stdin, child.stdout, child.stderr])
		(stream as unknown as { unref?: () => void } | null)?.unref?.();
	return {
		pid: child.pid,
		waitedMs: performance.now() - started,
		behind,
		release: () => child.stdin.end(),
	};
}

/**
 * Take a heavy slot, then a slot of `kind`: the one way a command holds the lock. The heavy queue is one FIFO
 * for every kind, checkout, session and plain script on the computer, so a stream of one kind never starves another.
 * `heavyHeld`: an ancestor holds a heavy slot (a locked command nested in another), so this takes only its kind and
 * never waits on its parent.
 */
export async function acquireHold(
	locks: Locks,
	kind: SlotKind,
	who: Who,
	options: { heavyHeld?: boolean } = {},
): Promise<Lease> {
	const heavy = options.heavyHeld ? undefined : await acquireHeavy(locks, who);
	let lease: Lease;
	try {
		lease = await acquireSlot(locks, kind, who);
	} catch (error) {
		heavy?.release();
		throw error;
	}
	if (!heavy) return lease;
	return {
		...lease,
		waitedMs: heavy.waitedMs + lease.waitedMs,
		behind: heavy.behind || lease.behind,
		heavyPid: heavy.pid,
		release() {
			lease.release();
			heavy.release();
		},
	};
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
