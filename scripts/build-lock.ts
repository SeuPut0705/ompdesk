/**
 * The machine-wide build lock: one build, Playwright run or full vitest run at
 * a time, across every checkout and agent on this Mac. Several of them at once
 * overloaded the machine until load-sensitive tests failed.
 *
 * The lock is the directory `/tmp/ompdesk-build.lock` (`mkdir` is atomic) with
 * an `owner` file naming the holder; shell users take it with
 * `until mkdir /tmp/ompdesk-build.lock; do sleep 5; done`. While held here, the
 * owner file is touched every minute, so a waiter only treats an owner file
 * older than 15 minutes as stale.
 *
 *   bun scripts/build-lock.ts <command> [args…]   (`bun run locked -- …`)
 *
 * runs one command inside the lock. Every child gets `OMPDESK_BUILD_LOCK_HELD=1`,
 * so a nested locked command (the gate's own steps) runs without waiting on
 * its parent. Interrupting this process stops the command's whole process
 * group (Electron and its helpers included) and releases the lock.
 */
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const LOCK_DIR =
	process.platform === "win32" ? path.join(os.tmpdir(), "ompdesk-build.lock") : "/tmp/ompdesk-build.lock";
const OWNER = path.join(LOCK_DIR, "owner");
const HELD_ENV = "OMPDESK_BUILD_LOCK_HELD";
const POLL_MS = 5_000;
const HEARTBEAT_MS = 60_000;
const STALE_MS = 15 * 60_000;

const children = new Set<ChildProcess>();
let held = false;
let heartbeat: NodeJS.Timeout | undefined;

function ownerName(): string {
	const who = process.env.OMPDESK_LOCK_OWNER || `${os.userInfo().username}@${path.basename(process.cwd())}`;
	return `${who} ${new Date().toTimeString().slice(0, 8)} pid ${process.pid}`;
}

function releaseLock(): void {
	if (!held) return;
	held = false;
	clearInterval(heartbeat);
	fs.rmSync(OWNER, { force: true });
	try {
		fs.rmdirSync(LOCK_DIR);
	} catch {
		// Someone removed it as stale; nothing left to release.
	}
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
		releaseLock();
		process.exit(130);
	});
}
process.on("exit", () => {
	killChildren();
	releaseLock();
});

/** Take the lock unless an ancestor already holds it; waits as long as it takes. */
export async function acquireLock(): Promise<void> {
	if (process.env[HELD_ENV] === "1") return;
	let reported = "";
	for (;;) {
		try {
			fs.mkdirSync(LOCK_DIR);
			fs.writeFileSync(OWNER, `${ownerName()}\n`);
			held = true;
			process.env[HELD_ENV] = "1";
			heartbeat = setInterval(() => {
				const now = new Date();
				fs.utimesSync(OWNER, now, now);
			}, HEARTBEAT_MS);
			heartbeat.unref();
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const owner = fs.statSync(OWNER, { throwIfNoEntry: false });
		const name = owner ? fs.readFileSync(OWNER, "utf8").trim() : "(no owner file yet)";
		if (owner && Date.now() - owner.mtimeMs > STALE_MS) {
			console.error(`[build-lock] removing a stale lock held by ${name}`);
			fs.rmSync(OWNER, { force: true });
			fs.rmSync(LOCK_DIR, { recursive: true, force: true });
			continue;
		}
		if (name !== reported) {
			console.error(`[build-lock] waiting for ${LOCK_DIR} (held by ${name})`);
			reported = name;
		}
		await Bun.sleep(POLL_MS);
	}
}

export interface RunResult {
	code: number;
	ms: number;
	output: string;
}

/**
 * Run `command` in its own process group. `capture` buffers stdout and stderr
 * together instead of streaming them, for steps that run side by side.
 */
export function run(command: string[], options: { capture?: boolean } = {}): Promise<RunResult> {
	const started = performance.now();
	const [file, ...args] = command;
	if (!file) throw new Error("No command");
	const child = spawn(file, args, {
		// stdin stays closed: a child in its own process group reading the terminal would stop on SIGTTIN.
		stdio: ["ignore", options.capture ? "pipe" : "inherit", options.capture ? "pipe" : "inherit"],
		detached: process.platform !== "win32",
		shell: process.platform === "win32",
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
			code: code ?? (signal ? 128 : 1),
			ms: performance.now() - started,
			output: Buffer.concat(chunks).toString("utf8"),
		});
	});
	return promise;
}

if (import.meta.main) {
	const command = process.argv.slice(2);
	if (command[0] === "--") command.shift();
	if (command.length === 0) {
		console.error("usage: bun scripts/build-lock.ts <command> [args…]");
		process.exit(2);
	}
	await acquireLock();
	const { code } = await run(command);
	process.exit(code);
}
