/**
 * The machine-wide lock, split by kind of work (`scripts/lock-slots.ts` has the layout):
 *
 *   build       one at a time; builds into out/ never overlap
 *   playwright  a few runs at once (counting semaphore), each on its own immutable out snapshot
 *   vitest      a few runs at once, the static checks included
 *   other       one at a time
 *
 *   bun scripts/build-lock.ts [--kind <kind>] [--chunk <n>] [--] <command> [args…]   (`bun run locked -- …`)
 *
 * runs one command inside a slot of the command's kind (from its command line, or `--kind`). Waiters
 * are served first come, first served. `bun run gate` and `bun run check:changed` take no slot
 * themselves; each of their phases takes the slot it needs, so they never hold one for long.
 *
 * `--chunk <n>` (playwright and vitest) runs the command as `--shard=1/n` … `--shard=n/n`, one slot
 * hold per shard, so a long job lets waiters in between its chunks. A non-gate hold past 15 minutes
 * logs a warning that says so, and `bun run lock-stats` flags it.
 *
 * Every child gets `OMPDESK_BUILD_LOCK_HELD=<kinds held>`: a nested locked command of a kind already
 * held runs without waiting on its parent and logs nothing (a nested command of another kind, the
 * `bun run build` inside a Playwright command, takes that kind's slot). Interrupting this process
 * stops the command's whole process group (Electron and its helpers included) and releases its slots.
 *
 * Each release appends the holder, command, slot, wait and hold times and exit code to
 * `scripts/lock-log.ts`'s log; `bun run lock-stats` summarizes it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { findOnPath, launcherNames, needsShell, spawnArgs, spawnCommand } from "../src/main/spawn";
import { appendLockLog, commandKind } from "./lock-log";
import {
	acquireSlot,
	defaultLocks,
	inspectSlots,
	type Lease,
	MAX_HOLD_MS,
	SLOT_KINDS,
	type SlotKind,
	WORKERS,
	workersFor,
} from "./lock-slots";
import { pinSnapshot, touchSnapshot } from "./out-snapshot";

const HELD_ENV = "OMPDESK_BUILD_LOCK_HELD";
/** Worker-count variables this process set itself (not the caller): each new hold sets them again. */
const autoWorkers = new Set<string>();
const HEARTBEAT_MS = Number(process.env.OMPDESK_LOCK_HEARTBEAT_MS) || 60_000;
const MAX_HOLD = Number(process.env.OMPDESK_LOCK_MAX_HOLD_MS) || MAX_HOLD_MS;
/** Shorter waits are not worth a line on the terminal. */
const REPORT_WAIT_MS = Number(process.env.OMPDESK_LOCK_REPORT_MS) || 1_000;

const locks = defaultLocks();
const children = new Set<ChildProcess>();
let heartbeat: NodeJS.Timeout | undefined;

interface Hold {
	lease: Lease;
	command: string;
	time: string;
	waitedMs: number;
	acquiredAt: number;
	via?: string;
	warned: boolean;
}
/** The slots this process holds, for the log line written when each is released. */
const holds = new Set<Hold>();

const ownerId = () => process.env.OMPDESK_LOCK_OWNER || `${os.userInfo().username}@${path.basename(process.cwd())}`;

/** Kinds an ancestor holds: `1` (the single lock's marker) means all of them. */
const inherited = new Set((process.env[HELD_ENV] ?? "").split(",").filter(Boolean));
const covered = (kind: SlotKind) =>
	inherited.has("1") || inherited.has(kind) || [...holds].some(h => h.lease.kind === kind);

/** Children see every kind held above them and here. */
function syncEnv(): void {
	const kinds = new Set([...inherited, ...[...holds].map(h => h.lease.kind)]);
	if (kinds.size === 0) delete process.env[HELD_ENV];
	else process.env[HELD_ENV] = [...kinds].join(",");
}

function beat(): void {
	for (const hold of holds) {
		hold.lease.touch();
		if (hold.warned || hold.via === "gate" || performance.now() - hold.acquiredAt <= MAX_HOLD) continue;
		hold.warned = true;
		const { kind, slot } = hold.lease;
		const minutes = Math.round((performance.now() - hold.acquiredAt) / 60_000);
		const chunkable = kind === "playwright" || kind === "vitest";
		console.error(
			`[lock] WARNING: ${kind} slot ${slot} held ${minutes} min by ${ownerId()} (one hold is limited to ${MAX_HOLD / 60_000} min; the gate is exempt). ` +
				(chunkable
					? `Split it so waiters get a turn between chunks: bun run locked -- --chunk <n> -- ${hold.command}`
					: "Split it into several shorter `bun run locked --` calls."),
		);
	}
	const pinned = process.env.OMP_GUI_E2E_OUT;
	if (pinned) touchSnapshot(pinned);
}

function release(hold: Hold, exit: number): void {
	if (!holds.delete(hold)) return;
	const { lease, command, time, waitedMs, acquiredAt, via } = hold;
	if (holds.size === 0) {
		clearInterval(heartbeat);
		heartbeat = undefined;
	}
	try {
		appendLockLog({
			time,
			owner: ownerId(),
			command,
			kind: lease.kind,
			cwd: process.cwd(),
			waitedMs: Math.round(waitedMs),
			slot: lease.slot,
			...(via ? { via } : {}),
			heldMs: Math.round(performance.now() - acquiredAt),
			exit,
		});
	} catch (error) {
		console.error(`[build-lock] could not write the lock log: ${(error as Error).message}`);
	}
	lease.release();
	syncEnv();
}

function releaseAll(exit: number): void {
	for (const hold of [...holds]) release(hold, exit);
}

/** Stop every running child's process tree. */
export function killChildren(): void {
	for (const child of children) {
		if (child.pid === undefined || child.exitCode !== null) continue;
		try {
			if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
			else process.kill(-child.pid, "SIGTERM");
		} catch {
			// Already gone.
		}
	}
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	process.on(signal, () => {
		killChildren();
		releaseAll(130);
		process.exit(130);
	});
}
process.on("exit", code => {
	killChildren();
	releaseAll(code);
});

export interface Held {
	/** Give the slot back now and log the hold; a hold not released here is released when the process exits. */
	release(exit?: number): void;
}

export interface AcquireOptions {
	/** The slot kind; default: what the command line is (`commandKind`). */
	kind?: SlotKind;
	/** The orchestrating command this hold is one phase of (`gate`: exempt from the max hold). */
	via?: string;
}

/** The slot kind of `command`; gate and check:changed have none (their phases take slots). */
export function slotKindOf(command: string): SlotKind | undefined {
	const kind = commandKind(command);
	return kind === "gate" ? undefined : kind;
}

/**
 * Take a slot for `command` unless an ancestor already holds one of that kind; waits as long as it
 * takes, behind earlier waiters.
 */
export async function acquireLock(command: readonly string[], options: AcquireOptions = {}): Promise<Held> {
	const text = command.join(" ");
	const kind = options.kind ?? slotKindOf(text) ?? "other";
	if (covered(kind)) return { release() {} };
	const time = new Date().toISOString();
	const lease = await acquireSlot(locks, kind, { owner: ownerId(), command: text });
	const hold: Hold = {
		lease,
		command: text,
		time,
		waitedMs: lease.waitedMs,
		acquiredAt: performance.now(),
		via: options.via,
		warned: false,
	};
	holds.add(hold);
	syncEnv();
	const share = WORKERS[kind];
	if (share && (!process.env[share.env] || autoWorkers.has(share.env))) {
		// A run that finds others holding slots takes a smaller share of the machine's workers.
		const busy = inspectSlots(locks).filter(view => view.kind === kind && view.holder).length;
		process.env[share.env] = String(workersFor(kind, busy));
		autoWorkers.add(share.env);
	}
	heartbeat ??= setInterval(beat, HEARTBEAT_MS);
	heartbeat.unref();
	if (hold.waitedMs > REPORT_WAIT_MS) {
		console.error(`[lock] waited ${(hold.waitedMs / 1000).toFixed(1)}s for ${lease.behind || "another holder"}`);
	}
	return { release: (exit = 0) => release(hold, exit) };
}

export interface RunResult {
	/** The exit code; a step a signal ended reads 128 + the signal's number, as a shell reports it. */
	code: number;
	ms: number;
	output: string;
	/** The signal that ended the step (killed by the OS, a peer or a timeout), when one did. */
	signal?: NodeJS.Signals;
}

/** How a failed step ended: "exit 2", or "killed by SIGKILL before it finished" (its output may stop mid-run). */
export function describeExit(result: RunResult): string {
	return result.signal ? `killed by ${result.signal} before it finished` : `exit ${result.code}`;
}

/** The file to start and how: Windows resolves `bunx` to `bunx.exe` (no shell) or a `.cmd` shim (cmd.exe). */
export function resolveLaunch(
	file: string,
	args: string[],
	platform: NodeJS.Platform = process.platform,
	pathEnv = process.env.PATH ?? process.env.Path ?? "",
): { file: string; args: string[]; shell: boolean } {
	if (platform !== "win32" || /[\\/]/.test(file)) return { file, args, shell: needsShell(file, platform) };
	const bin = findOnPath(launcherNames(file, "win32"), pathEnv, "win32") ?? file;
	return { file: spawnCommand(bin, platform), args: spawnArgs(bin, args, platform), shell: needsShell(bin, platform) };
}

/**
 * Run `command` in its own process group. `capture` buffers stdout and stderr
 * together instead of streaming them, for steps that run side by side.
 */
export function run(command: string[], options: { capture?: boolean } = {}): Promise<RunResult> {
	const started = performance.now();
	const [first, ...rest] = command;
	if (!first) throw new Error("No command");
	const win = process.platform === "win32";
	const { file, args, shell } = resolveLaunch(first, rest);
	const child = spawn(file, args, {
		// stdin stays closed: a child in its own process group reading the terminal would stop on SIGTTIN.
		stdio: ["ignore", options.capture ? "pipe" : "inherit", options.capture ? "pipe" : "inherit"],
		detached: !win,
		shell,
	});
	children.add(child);
	const chunks: Buffer[] = [];
	child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
	child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
	const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
	child.once("error", reject);
	child.once("close", (code, signal) => {
		children.delete(child);
		resolve({
			code: code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1),
			ms: performance.now() - started,
			output: Buffer.concat(chunks).toString("utf8"),
			...(code === null && signal ? { signal } : {}),
		});
	});
	return promise;
}

/** Take a slot of `kind`, run `command` in it and release the slot: one phase of the gate or check:changed. */
export async function runLocked(
	kind: SlotKind,
	command: string[],
	options: { via: string; capture?: boolean },
): Promise<RunResult> {
	const held = await acquireLock(command, { kind, via: options.via });
	try {
		const result = await run(command, { capture: options.capture });
		held.release(result.code);
		return result;
	} catch (error) {
		held.release(1);
		throw error;
	}
}

function usage(message: string): never {
	console.error(
		`${message}\nusage: bun scripts/build-lock.ts [--kind ${SLOT_KINDS.join("|")}] [--chunk <n>] [--] <command> [args…]`,
	);
	process.exit(2);
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	let kind: SlotKind | undefined;
	let chunks = 1;
	for (;;) {
		const flag = args[0];
		if (flag === "--") args.shift();
		else if (flag === "--kind" || flag === "--chunk") {
			args.shift();
			const value = args.shift();
			if (flag === "--kind") {
				if (!SLOT_KINDS.includes(value as SlotKind))
					usage(`--kind takes one of ${SLOT_KINDS.join(", ")}; got "${value}"`);
				kind = value as SlotKind;
			} else {
				chunks = Number(value);
				if (!Number.isInteger(chunks) || chunks < 1) usage(`--chunk takes a count of 1 or more; got "${value}"`);
			}
		} else break;
	}
	if (args.length === 0) usage("No command");
	const text = args.join(" ");
	const slotKind = kind ?? slotKindOf(text);
	if (slotKind === undefined) {
		// gate, check:changed: no slot of their own; their phases take one each.
		process.exit((await run(args)).code);
	}
	if (chunks > 1) {
		if (slotKind !== "playwright" && slotKind !== "vitest")
			usage("--chunk splits a playwright or vitest command into shards");
		if (/--shard\b/.test(text)) usage("--chunk adds --shard=i/n itself; drop the command's own --shard");
		if (slotKind === "playwright" && !process.env.OMP_GUI_E2E_OUT) {
			// Every chunk runs the same build, even when another agent builds between them.
			const pinned = pinSnapshot(process.cwd());
			if (pinned) process.env.OMP_GUI_E2E_OUT = pinned;
		}
		let code = 0;
		for (let chunk = 1; chunk <= chunks; chunk++) {
			const command = [...args, `--shard=${chunk}/${chunks}`];
			console.error(`[lock] chunk ${chunk}/${chunks}`);
			const result = await runLocked(slotKind, command, { via: "chunk" });
			if (result.code !== 0 && code === 0) code = result.code;
		}
		process.exit(code);
	}
	const held = await acquireLock(args, { kind: slotKind });
	const { code } = await run(args);
	held.release(code);
	process.exit(code);
}
