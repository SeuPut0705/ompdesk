/**
 * The toolchain audit's findings (lock takeover race, environmental failures, archive reuse, shared-cache leftovers,
 * setup.ts output, Windows unpacking, agents' bun on PATH). No test here touches the network or the real home: the
 * cache is a temp folder and every source is a file:// URL.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ompPathEnv } from "../omp-runtime";

const SKILL =
	process.env.FORMAL_SKILL_DIR ??
	path.join(__dirname, "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "formal-audit-toolchain-"));
afterAll(() => {
	for (const entry of fs.readdirSync(temp)) {
		try {
			fs.chmodSync(path.join(temp, entry), 0o755);
			for (const inner of fs.readdirSync(path.join(temp, entry))) {
				fs.chmodSync(path.join(temp, entry, inner), 0o755);
			}
		} catch {
			// not a folder
		}
	}
	fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// biome-ignore lint/suspicious/noExplicitAny: the library is loaded from a path chosen at run time.
async function lib(name: string): Promise<any> {
	return import(/* @vite-ignore */ path.join(SKILL, "scripts/lib", `${name}.ts`));
}

const sha = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const fileUrl = (file: string): string => `file://${file.startsWith("/") ? "" : "/"}${file.replaceAll("\\", "/")}`;
const quiet = (): void => {};
const posix = process.platform !== "win32";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function deadPid(): number {
	const result = spawnSync("bun", ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
	return Number(result.stdout);
}

function plantLock(cache: string, name: string, owner: Record<string, unknown>, ageMs = 0): string {
	const lock = path.join(cache, `.lock-${name}`);
	fs.mkdirSync(lock, { recursive: true });
	const file = path.join(lock, "owner.json");
	fs.writeFileSync(file, JSON.stringify(owner));
	const then = new Date(Date.now() - ageMs);
	fs.utimesSync(file, then, then);
	return lock;
}

function finished(child: ChildProcess): Promise<number | null> {
	return new Promise(resolve => child.on("close", code => resolve(code)));
}

describe("lock takeover (finding 1)", () => {
	const CHILD = (toolchain: string): string =>
		[
			'import fs from "node:fs";',
			`import { withLock } from ${JSON.stringify(toolchain)};`,
			"const [cache, barrier, marker, log, id] = process.argv.slice(2);",
			"const gate = new Int32Array(new SharedArrayBuffer(4));",
			"while (!fs.existsSync(barrier)) Atomics.wait(gate, 0, 0, 1);",
			"await withLock(cache, 'x', async () => {",
			"  try { fs.mkdirSync(marker); } catch { fs.appendFileSync(log, 'overlap ' + id + '\\n'); }",
			"  fs.appendFileSync(log, 'entered ' + id + '\\n');",
			"  await new Promise(resolve => setTimeout(resolve, 20));",
			"  fs.rmSync(marker, { recursive: true, force: true });",
			"}, { log() {}, pollMs: 5 });",
		].join("\n");

	/**
	 * Rounds of `procs` processes racing to take over a dead holder's lock. Each round has its own deadline, so a hung
	 * waiter fails the round inside `race` (not as a test timeout that skips `finally`), and every child is killed and
	 * awaited before its folder goes.
	 */
	async function race(procs: number, rounds: number, roundMs: number): Promise<void> {
		const script = path.join(temp, `lock-child-${procs}.ts`);
		fs.writeFileSync(script, CHILD(path.join(SKILL, "scripts/lib/toolchain.ts")));
		const dead = deadPid();
		let overlaps = 0;
		let entered = 0;
		for (let round = 0; round < rounds; round++) {
			const dir = fs.mkdtempSync(path.join(temp, "race-"));
			const cache = path.join(dir, "cache");
			fs.mkdirSync(cache);
			plantLock(cache, "x", { pid: dead, host: os.hostname(), started: 1 });
			const barrier = path.join(dir, "go");
			const marker = path.join(dir, "inside");
			const log = path.join(dir, "log.txt");
			fs.writeFileSync(log, "");
			const errors: string[] = [];
			const children: ChildProcess[] = [];
			const done: Promise<number | null>[] = [];
			try {
				for (let id = 0; id < procs; id++) {
					const child = spawn("bun", [script, cache, barrier, marker, log, String(id)], {
						stdio: ["ignore", "ignore", "pipe"],
						cwd: dir,
					});
					child.stderr?.on("data", chunk => errors.push(String(chunk)));
					children.push(child);
					done.push(finished(child));
				}
				fs.writeFileSync(barrier, "");
				let timer: ReturnType<typeof setTimeout> | undefined;
				const deadline = new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error(`round ${round} did not finish in ${roundMs} ms`)), roundMs);
				});
				const codes = await Promise.race([Promise.all(done), deadline]).finally(() => clearTimeout(timer));
				expect(errors.join(""), "stderr of the waiters").toBe("");
				expect(codes).toEqual(Array(procs).fill(0));
				const lines = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
				overlaps += lines.filter(line => line.startsWith("overlap")).length;
				entered += lines.filter(line => line.startsWith("entered")).length;
				expect(fs.existsSync(path.join(cache, ".lock-x"))).toBe(false);
			} finally {
				for (const child of children) child.kill("SIGKILL");
				await Promise.all(done);
				fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		}
		expect(entered).toBe(rounds * procs);
		expect(overlaps).toBe(0);
	}

	it("lets two waiters take over a dead holder's lock one at a time, on every OS", () => race(2, 3, 15_000), 60_000);

	// POSIX only: with 8 processes polling every 5 ms, Windows keeps the just-deleted lock folder delete-pending for so
	// long that the stress run is too slow to be a useful check. The Windows rule is covered by the EPERM cases below.
	it.skipIf(process.platform === "win32")(
		"lets exactly one of several waiters take over a dead holder's lock, in every round",
		() => race(8, 12, 9_000),
		120_000,
	);

	describe("a lock folder that is delete-pending on Windows", () => {
		const withPlatform = async (value: NodeJS.Platform, body: () => Promise<void>): Promise<void> => {
			const real = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
			Object.defineProperty(process, "platform", { ...real, value });
			try {
				await body();
			} finally {
				Object.defineProperty(process, "platform", real);
				vi.restoreAllMocks();
			}
		};
		const refuseMkdir = (lock: string, code: string, times: number): { calls: () => number } => {
			const realMkdir = fs.mkdirSync;
			let refused = 0;
			vi.spyOn(fs, "mkdirSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
				if (String(target) === lock && refused < times) {
					refused++;
					throw Object.assign(new Error(`${code}: operation not permitted, mkdir '${lock}'`), { code });
				}
				return (realMkdir as (...args: unknown[]) => unknown)(target, ...rest);
			}) as typeof fs.mkdirSync);
			return { calls: () => refused };
		};

		it("waits while mkdir is refused as EPERM or EACCES, then takes the lock", async () => {
			const { withLock } = await lib("toolchain");
			for (const code of ["EPERM", "EACCES"]) {
				const cache = fs.mkdtempSync(path.join(temp, "pending-"));
				const lock = path.join(cache, ".lock-x");
				await withPlatform("win32", async () => {
					const refused = refuseMkdir(lock, code, 3);
					const result = await withLock(cache, "x", async () => "worked", { log: quiet, pollMs: 1 });
					expect(result).toBe("worked");
					expect(refused.calls()).toBe(3);
				});
				expect(fs.existsSync(lock)).toBe(false);
			}
		});

		it("is Unavailable when EPERM never ends", async () => {
			const { withLock } = await lib("toolchain");
			const { Unavailable } = await lib("proc");
			const cache = fs.mkdtempSync(path.join(temp, "pending-forever-"));
			const lock = path.join(cache, ".lock-x");
			await withPlatform("win32", async () => {
				const refused = refuseMkdir(lock, "EPERM", Number.POSITIVE_INFINITY);
				await expect(withLock(cache, "x", async () => 1, { log: quiet, pollMs: 0 })).rejects.toBeInstanceOf(
					Unavailable,
				);
				expect(refused.calls()).toBeGreaterThan(200);
			});
		});

		it("does not wait for EPERM off Windows", async () => {
			const { withLock } = await lib("toolchain");
			const { Unavailable } = await lib("proc");
			const cache = fs.mkdtempSync(path.join(temp, "pending-posix-"));
			const lock = path.join(cache, ".lock-x");
			await withPlatform("linux", async () => {
				const refused = refuseMkdir(lock, "EPERM", 1);
				await expect(withLock(cache, "x", async () => 1, { log: quiet, pollMs: 1 })).rejects.toBeInstanceOf(
					Unavailable,
				);
				expect(refused.calls()).toBe(1);
			});
		});
	});

	it.skipIf(!posix)(
		"releases a lock its process holds when SIGTERM stops it",
		async () => {
			const { toolchain } = { toolchain: path.join(SKILL, "scripts/lib/toolchain.ts") };
			const script = path.join(temp, "lock-hold.ts");
			fs.writeFileSync(
				script,
				[
					`import { withLock } from ${JSON.stringify(toolchain)};`,
					"await withLock(process.argv[2], 'x', async () => {",
					"  console.log('held');",
					"  await new Promise(() => {});",
					"}, { log() {} });",
				].join("\n"),
			);
			const cache = fs.mkdtempSync(path.join(temp, "term-"));
			const child = spawn("bun", [script, cache], { stdio: ["ignore", "pipe", "ignore"] });
			const held = Promise.withResolvers<void>();
			child.stdout?.on("data", () => held.resolve());
			const closed = finished(child);
			await held.promise;
			expect(fs.existsSync(path.join(cache, ".lock-x"))).toBe(true);
			child.kill("SIGTERM");
			expect(await closed).toBe(143);
			expect(fs.existsSync(path.join(cache, ".lock-x"))).toBe(false);
		},
		30_000,
	);

	it("does not delete a lock that another process now owns, and the holder fails as Unavailable", async () => {
		const { withLock } = await lib("toolchain");
		const { Unavailable } = await lib("proc");
		const cache = fs.mkdtempSync(path.join(temp, "foreign-"));
		const lock = path.join(cache, ".lock-x");
		await expect(
			withLock(
				cache,
				"x",
				async () => {
					// A takeover replaced this process's lock while it worked.
					fs.rmSync(lock, { recursive: true });
					plantLock(cache, "x", { pid: process.pid, host: os.hostname(), started: 1, token: "someone-else" });
				},
				{ log: quiet },
			),
		).rejects.toBeInstanceOf(Unavailable);
		expect(JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")).token).toBe("someone-else");
	});

	/**
	 * The two interleavings TLC found in formal/toolchain-lock (both made two holders at once, the CI overlap of
	 * release run 40891943183). The test plays every other process through spies, so each step lands exactly where
	 * the trace puts it. `rival` is a waiter that made a fresh lock (mkdir, then its owner file, as acquire does) and
	 * holds it until this waiter's mkdir has been refused by it once; then it finishes and releases.
	 */
	describe("a takeover never removes a lock another waiter just made", () => {
		const realMkdir = fs.mkdirSync as (...args: unknown[]) => unknown;
		const realStat = fs.statSync as (...args: unknown[]) => unknown;
		const realKill = process.kill;
		const enoent = (target: string): Error =>
			Object.assign(new Error(`ENOENT: no such file or directory, stat '${target}'`), { code: "ENOENT" });
		const realExists = fs.existsSync as (...args: unknown[]) => boolean;
		const rival = (
			lock: string,
		): { take: () => void; holding: () => boolean; mkdir: typeof realMkdir; exists: typeof realExists } => {
			let holding = false;
			return {
				take() {
					realMkdir(lock);
					fs.writeFileSync(
						path.join(lock, "owner.json"),
						JSON.stringify({ pid: process.pid, host: os.hostname(), started: 2, token: "rival" }),
					);
					holding = true;
				},
				holding: () => holding,
				/** mkdir as the waiter sees it: refused by the rival's lock once, after which the rival lets go. */
				mkdir(target, ...rest) {
					if (String(target) !== lock || !holding) return realMkdir(target, ...rest);
					try {
						return realMkdir(target, ...rest);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "EEXIST") {
							fs.rmSync(lock, { recursive: true, force: true });
							holding = false;
						}
						throw error;
					}
				},
				/** existsSync as the waiter sees it (acquire looks before it makes): turned away by the rival's lock once, then it lets go. */
				exists(target, ...rest) {
					const there = realExists(target, ...rest);
					if (String(target) === lock && holding && there) {
						fs.rmSync(lock, { recursive: true, force: true });
						holding = false;
					}
					return there;
				},
			};
		};

		it("treats a lock that was gone when judged as not abandoned", async () => {
			const { withLock } = await lib("toolchain");
			const cache = fs.mkdtempSync(path.join(temp, "gone-"));
			const lock = path.join(cache, ".lock-x");
			const guard = `${lock}.takeover`;
			const other = rival(lock);
			let refused = false;
			let rivalMade = false;
			// A holder had the lock at this waiter's mkdir and released it at once: the lock is gone when judged.
			vi.spyOn(fs, "mkdirSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
				if (String(target) === lock && !refused) {
					refused = true;
					throw Object.assign(new Error(`EEXIST: file already exists, mkdir '${lock}'`), { code: "EEXIST" });
				}
				return other.mkdir(target, ...rest);
			}) as typeof fs.mkdirSync);
			vi.spyOn(fs, "existsSync").mockImplementation(other.exists as typeof fs.existsSync);
			// Inside the guard, right after this waiter's stat found no lock, the rival's mkdir lands.
			vi.spyOn(fs, "statSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
				if (String(target) === lock && !realExists(lock) && realExists(guard) && !rivalMade) {
					rivalMade = true;
					other.take();
					throw enoent(lock);
				}
				return realStat(target, ...rest);
			}) as typeof fs.statSync);
			let overlapped = false;
			try {
				await withLock(
					cache,
					"x",
					async () => {
						overlapped = other.holding();
					},
					{ log: quiet, pollMs: 5 },
				);
			} finally {
				vi.restoreAllMocks();
			}
			expect(overlapped, "held the lock while the rival held its fresh one").toBe(false);
		});

		it.skipIf(!posix)("counts a dead pid only while the owner file still names that holder", async () => {
			const { withLock } = await lib("toolchain");
			const cache = fs.mkdtempSync(path.join(temp, "dead-after-release-"));
			const lock = path.join(cache, ".lock-x");
			const guard = `${lock}.takeover`;
			const other = rival(lock);
			const planted = 999_999_001;
			const taker = 999_999_002;
			let takerAlive = true;
			plantLock(cache, "x", { pid: planted, host: os.hostname(), started: 1 });
			vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
				if (pid === planted) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
				if (pid !== taker) return realKill.call(process, pid, signal);
				if (takerAlive) {
					// Between this waiter's read of the owner and its kill(0): the taker finishes and releases, the
					// rival makes a fresh lock, and the taker's process exits.
					fs.rmSync(lock, { recursive: true, force: true });
					other.take();
					takerAlive = false;
				}
				throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
			}) as typeof process.kill);
			// Before this waiter gets the guard, another waiter has taken the planted lock over and let the guard go.
			let tookOver = false;
			vi.spyOn(fs, "mkdirSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
				if (String(target) === guard && !tookOver) {
					tookOver = true;
					fs.rmSync(lock, { recursive: true, force: true });
					realMkdir(lock);
					fs.writeFileSync(
						path.join(lock, "owner.json"),
						JSON.stringify({ pid: taker, host: os.hostname(), started: 3, token: "taker" }),
					);
				}
				return other.mkdir(target, ...rest);
			}) as typeof fs.mkdirSync);
			vi.spyOn(fs, "existsSync").mockImplementation(other.exists as typeof fs.existsSync);
			let overlapped = false;
			try {
				await withLock(
					cache,
					"x",
					async () => {
						overlapped = other.holding();
					},
					{ log: quiet, pollMs: 5 },
				);
			} finally {
				vi.restoreAllMocks();
			}
			expect(tookOver && !takerAlive, "the trace ran").toBe(true);
			expect(overlapped, "held the lock while the rival held its fresh one").toBe(false);
		});

		it.skipIf(!posix)("takes the lock from a holder only while the holder's owner is the one it judged", async () => {
			// An old dead holder H (untouched for 10 min) is judged by W. Between W's stat and its kill(0) another waiter
			// B took the lock over and installed a fresh one. The old mtime must not condemn B's lock.
			const { withLock } = await lib("toolchain");
			const cache = fs.mkdtempSync(path.join(temp, "owner-changed-"));
			const lock = path.join(cache, ".lock-x");
			const planted = 999_999_003;
			plantLock(cache, "x", { pid: planted, host: os.hostname(), started: 1, token: "H" }, 10 * 60_000);
			let swapped = false;
			let holdingB = false;
			const removedOwners: string[] = [];
			vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
				if (pid !== planted) return realKill.call(process, pid, signal);
				// Only the judgment inside the takeover (guard held) is the one that deletes.
				if (!swapped && fs.existsSync(`${lock}.takeover`)) {
					swapped = true;
					fs.rmSync(lock, { recursive: true, force: true });
					realMkdir(lock);
					fs.writeFileSync(
						path.join(lock, "owner.json"),
						JSON.stringify({ pid: process.pid, host: os.hostname(), started: 5, token: "B" }),
					);
					holdingB = true;
				}
				throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
			}) as typeof process.kill);
			const realRm = fs.rmSync as (...args: unknown[]) => unknown;
			vi.spyOn(fs, "rmSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
				if (String(target) === lock && holdingB) {
					try {
						removedOwners.push(JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")).token);
					} catch {
						removedOwners.push("?");
					}
				}
				return realRm(target, ...rest);
			}) as typeof fs.rmSync);
			vi.spyOn(fs, "mkdirSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
				try {
					return realMkdir(target, ...rest);
				} catch (error) {
					// B finishes once this waiter has been turned away by its lock.
					if (String(target) === lock && holdingB && (error as NodeJS.ErrnoException).code === "EEXIST") {
						holdingB = false;
						realRm(lock, { recursive: true, force: true });
					}
					throw error;
				}
			}) as typeof fs.mkdirSync);
			vi.spyOn(fs, "existsSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
				const there = realExists(target, ...rest);
				// B finishes once this waiter has been turned away by its lock (acquire looks before it makes).
				if (String(target) === lock && holdingB && there) {
					holdingB = false;
					realRm(lock, { recursive: true, force: true });
				}
				return there;
			}) as typeof fs.existsSync);
			try {
				await withLock(cache, "x", async () => undefined, { log: quiet, pollMs: 5 });
			} finally {
				vi.restoreAllMocks();
			}
			expect(swapped, "the trace ran").toBe(true);
			expect(removedOwners, "owners of the locks removed while B held its own").not.toContain("B");
		});

		/**
		 * A holder on another computer that slept past staleMs (its pid cannot be asked, so only the old mtime condemns
		 * its lock): W judges the lock stale and holds the guard; the holder wakes and releases, B makes a fresh lock,
		 * and only then does W delete. Real processes play A (told it is on another computer) and B (each runs
		 * withLock itself), so whatever order the code lets them in is the order they take; the test only waits at W's
		 * rmSync(lock) for them to have done what they can.
		 */
		const peerScript = (flags: string): string => {
			const toolchain = path.join(SKILL, "scripts/lib/toolchain.ts");
			const script = path.join(flags, "peer.ts");
			fs.writeFileSync(
				script,
				[
					'import fs from "node:fs";',
					'import os from "node:os";',
					'import path from "node:path";',
					`import { withLock } from ${JSON.stringify(toolchain)};`,
					"const [cache, role, flags] = process.argv.slice(2);",
					"if (role === 'A') os.hostname = () => 'far-computer';",
					"await withLock(cache, 'x', async () => {",
					"  fs.writeFileSync(path.join(flags, role + '-held'), '');",
					"  while (!fs.existsSync(path.join(flags, role + '-go'))) await new Promise(r => setTimeout(r, 5));",
					"}, { log() {}, pollMs: 5, heartbeatMs: 600000 }).catch(() => process.exit(3));",
				].join("\n"),
			);
			return script;
		};
		const syncWait = (ok: () => boolean, ms: number): boolean => {
			const gate = new Int32Array(new SharedArrayBuffer(4));
			const until = Date.now() + ms;
			while (!ok()) {
				if (Date.now() > until) return false;
				Atomics.wait(gate, 0, 0, 5);
			}
			return true;
		};

		it.skipIf(!posix)(
			"does not remove a lock another waiter made after a stale judgment, whatever the holder does meanwhile",
			async () => {
				const { withLock } = await lib("toolchain");
				const cache = fs.mkdtempSync(path.join(temp, "stale-gap-"));
				const flags = fs.mkdtempSync(path.join(temp, "stale-gap-flags-"));
				const lock = path.join(cache, ".lock-x");
				const script = peerScript(flags);
				const peers: ChildProcess[] = [];
				const closed: Promise<number | null>[] = [];
				const start = (role: string): void => {
					const child = spawn("bun", [script, cache, role, flags], { stdio: "ignore" });
					peers.push(child);
					closed.push(finished(child));
				};
				const held = (role: string): string => path.join(flags, `${role}-held`);
				try {
					start("A");
					expect(
						syncWait(() => fs.existsSync(held("A")), 15_000),
						"A holds the lock",
					).toBe(true);
					const old = new Date(Date.now() - 10 * 60_000);
					fs.utimesSync(path.join(lock, "owner.json"), old, old); // A's heartbeat stopped: its computer slept
					let injected = false;
					const realRm = fs.rmSync as (...args: unknown[]) => unknown;
					vi.spyOn(fs, "rmSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
						if (String(target) === lock && !injected) {
							injected = true;
							fs.writeFileSync(path.join(flags, "A-go"), ""); // A wakes and releases
							if (syncWait(() => !fs.existsSync(lock), 1_500)) {
								start("B"); // the lock is free: B takes it
								syncWait(() => fs.existsSync(held("B")), 5_000);
							}
						}
						return realRm(target, ...rest);
					}) as typeof fs.rmSync);
					let overlapped = false;
					try {
						await withLock(
							cache,
							"x",
							async () => {
								overlapped = fs.existsSync(held("B")) && !fs.existsSync(path.join(flags, "B-go"));
							},
							{ log: quiet, pollMs: 5, staleMs: 5 * 60_000 },
						);
					} finally {
						vi.restoreAllMocks();
					}
					expect(injected, "the trace ran").toBe(true);
					expect(overlapped, "W worked while B held its lock").toBe(false);
				} finally {
					fs.writeFileSync(path.join(flags, "A-go"), "");
					fs.writeFileSync(path.join(flags, "B-go"), "");
					const timer = setTimeout(() => {
						for (const child of peers) child.kill("SIGKILL");
					}, 20_000);
					await Promise.all(closed);
					clearTimeout(timer);
				}
			},
			60_000,
		);

		it.skipIf(!posix)(
			"never takes over a live holder on this computer, however long its heartbeat has been silent",
			async () => {
				const { withLock } = await lib("toolchain");
				const { Unavailable } = await lib("proc");
				const cache = fs.mkdtempSync(path.join(temp, "live-local-"));
				const flags = fs.mkdtempSync(path.join(temp, "live-local-flags-"));
				const script = path.join(flags, "peer.ts");
				peerScript(flags);
				const holder = spawn("bun", [script, cache, "L", flags], { stdio: "ignore" });
				const holderClosed = finished(holder);
				try {
					expect(
						syncWait(() => fs.existsSync(path.join(flags, "L-held")), 15_000),
						"the holder holds the lock",
					).toBe(true);
					const old = new Date(Date.now() - 10 * 60_000);
					fs.utimesSync(path.join(cache, ".lock-x", "owner.json"), old, old); // its computer slept for 10 min
					let ran = false;
					await expect(
						withLock(
							cache,
							"x",
							async () => {
								ran = true;
							},
							{ log: quiet, pollMs: 5, staleMs: 60_000, maxWaitMs: 600 },
						),
					).rejects.toBeInstanceOf(Unavailable);
					expect(ran, "ran its work inside a lock whose holder is alive").toBe(false);
					expect(holder.exitCode, "the holder is untouched").toBeNull();
				} finally {
					fs.writeFileSync(path.join(flags, "L-go"), "");
					const timer = setTimeout(() => holder.kill("SIGKILL"), 20_000);
					await holderClosed;
					clearTimeout(timer);
				}
			},
			60_000,
		);

		it("a holder of another computer that slept past staleMs and wakes writes nothing more once its lock is taken", async () => {
			const { withLock } = await lib("toolchain");
			const { Unavailable } = await lib("proc");
			const cache = fs.mkdtempSync(path.join(temp, "resumed-"));
			const ownerFile = path.join(cache, ".lock-x", "owner.json");
			const written = path.join(cache, "written.log");
			const events: string[] = [];
			const note = (who: string): void => fs.appendFileSync(written, `${who}\n`);
			// While A sleeps nothing touches its lock; the waiter's takeover is what wakes it.
			const realUtimes = fs.utimesSync as (...args: unknown[]) => unknown;
			vi.spyOn(fs, "utimesSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
				if (String(target) === ownerFile) return undefined;
				return realUtimes(target, ...rest);
			}) as typeof fs.utimesSync);
			const realHost = os.hostname();
			const hostname = vi.spyOn(os, "hostname").mockReturnValue("far-computer");
			let holderRejection: unknown;
			const holder = withLock(
				cache,
				"x",
				async (signal: AbortSignal) => {
					hostname.mockReturnValue(realHost); // from here on every other call is this computer's
					note("A:start");
					while (!signal.aborted) {
						note("A:write");
						await new Promise(resolve => setTimeout(resolve, 5));
					}
					events.push("A:work-returned");
				},
				{ log: quiet, heartbeatMs: 30, pollMs: 5 },
			).catch((error: unknown) => {
				holderRejection = error;
				events.push("A:rejected");
			});
			try {
				await vi.waitFor(() => expect(fs.existsSync(written)).toBe(true));
				await new Promise(resolve => setTimeout(resolve, 60)); // A's lock is now older than the waiter's staleMs
				await withLock(
					cache,
					"x",
					async () => {
						events.push("W:start");
						await vi.waitFor(() => expect(events).toContain("A:rejected"));
						const before = fs.readFileSync(written, "utf8");
						await new Promise(resolve => setTimeout(resolve, 80));
						expect(fs.readFileSync(written, "utf8"), "A wrote after it was told to stop").toBe(before);
						note("W:done");
					},
					{ log: quiet, pollMs: 5, staleMs: 40 },
				);
			} finally {
				vi.restoreAllMocks();
				await holder;
			}
			expect(holderRejection).toBeInstanceOf(Unavailable);
			// A's rejection came after its work had stopped (the work is awaited, not raced).
			expect(events.indexOf("A:work-returned")).toBeGreaterThanOrEqual(0);
			expect(events.indexOf("A:work-returned")).toBeLessThan(events.indexOf("A:rejected"));
		});

		it("a holder whose lock was taken over is told to stop, and fails as Unavailable once its work has stopped", async () => {
			const { withLock } = await lib("toolchain");
			const { Unavailable } = await lib("proc");
			const cache = fs.mkdtempSync(path.join(temp, "lost-"));
			const lock = path.join(cache, ".lock-x");
			const started = Date.now();
			let stoppedAfter = Number.POSITIVE_INFINITY;
			await expect(
				withLock(
					cache,
					"x",
					async (signal: AbortSignal) => {
						// Another computer's takeover replaced this holder's lock while it worked.
						fs.rmSync(lock, { recursive: true, force: true });
						plantLock(cache, "x", { pid: process.pid, host: os.hostname(), started: 1, token: "someone-else" });
						await new Promise<void>(resolve => {
							signal.addEventListener("abort", () => resolve(), { once: true });
							setTimeout(resolve, 1_500);
						});
						stoppedAfter = Date.now() - started;
					},
					{ log: quiet, heartbeatMs: 10 },
				),
			).rejects.toBeInstanceOf(Unavailable);
			expect(stoppedAfter, "the work was told to stop (it ran its full 1.5 s)").toBeLessThan(1_000);
			fs.rmSync(lock, { recursive: true, force: true });
		});
	});
});

/**
 * The guard (`.lock-<name>.takeover`) that every change of the install lock runs under, checked from outside: each of
 * the two plain steps (making the lock, releasing it) must take it, a guard stale for 30 s is reclaimed only as the very
 * guard that was judged, a guard holder that stalled never deletes what another process made meanwhile, and a failed
 * or slow release never fails the work. Each case stops the other processes exactly where the interleaving needs them:
 * real peer processes that run the library, with a pause in their own fs calls, and spies on this process's.
 */
describe("the guard of the install lock", () => {
	const realMkdir = fs.mkdirSync as (...args: unknown[]) => unknown;
	const realStat = fs.statSync as (...args: unknown[]) => unknown;
	const realRead = fs.readFileSync as (...args: unknown[]) => unknown;
	const realWriteFile = fs.writeFileSync as (...args: unknown[]) => unknown;
	const realRemove = fs.rmSync as (...args: unknown[]) => unknown;
	const realRename = fs.renameSync as (...args: unknown[]) => unknown;
	const realNow = Date.now.bind(Date);
	/** The file inside a guard folder that names its holder (`GUARD_TOKEN_FILE` in toolchain.ts). */
	const TOKEN = "token";
	const foreign = (token: string): Record<string, unknown> => ({
		pid: process.pid,
		host: os.hostname(),
		started: 5,
		token,
	});
	/** A guard another process holds right now. */
	const plantGuard = (guard: string, token: string, ageMs = 0): void => {
		realMkdir(guard);
		realWriteFile(path.join(guard, TOKEN), token);
		const then = new Date(Date.now() - ageMs);
		fs.utimesSync(guard, then, then);
	};
	/** Another process takes the lock and the guard from this one: the lock is replaced, the guard is its own. */
	const replaceLockAndGuard = (lock: string, guard: string, token: string): void => {
		realRemove(guard, { recursive: true, force: true });
		plantGuard(guard, "reclaimer");
		realRemove(lock, { recursive: true, force: true });
		realMkdir(lock);
		realWriteFile(path.join(lock, "owner.json"), JSON.stringify(foreign(token)));
	};

	/**
	 * Peers: real processes running `withLock`. `A` is told it is on another computer and pauses its release at its
	 * `rmSync(lock)` (after it checked that the lock is its own) until `W-held` appears; `B` pauses its acquire at the
	 * owner write (after its mkdir) until `B-resume`. Each holds the lock until its `<role>-go` flag.
	 */
	const stallingPeer = (flags: string): string => {
		const script = path.join(flags, "stalling-peer.ts");
		fs.writeFileSync(
			script,
			[
				'import fs from "node:fs";',
				'import os from "node:os";',
				'import path from "node:path";',
				`import { withLock } from ${JSON.stringify(path.join(SKILL, "scripts/lib/toolchain.ts"))};`,
				"const [cache, role, flags] = process.argv.slice(2);",
				"const lock = path.join(cache, '.lock-x');",
				"const flag = name => path.join(flags, name);",
				"const realWrite = fs.writeFileSync;",
				"const pause = (ready, until, ms) => {",
				"  realWrite(flag(ready), '');",
				"  const gate = new Int32Array(new SharedArrayBuffer(4));",
				"  const end = Date.now() + ms;",
				"  while (!fs.existsSync(flag(until)) && Date.now() < end) Atomics.wait(gate, 0, 0, 5);",
				"};",
				"if (role === 'A') os.hostname = () => 'far-computer';",
				"if (role === 'A') {",
				"  const realRm = fs.rmSync;",
				"  fs.rmSync = (target, ...rest) => {",
				"    if (String(target) === lock) pause('A-at-rm', 'W-held', 1500);",
				"    return realRm(target, ...rest);",
				"  };",
				"}",
				"if (role === 'B') {",
				"  fs.writeFileSync = (target, ...rest) => {",
				"    if (String(target) === path.join(lock, 'owner.json')) pause('B-at-write', 'B-resume', 6000);",
				"    return realWrite(target, ...rest);",
				"  };",
				"}",
				"await withLock(cache, 'x', async () => {",
				"  realWrite(flag(role + '-held'), '');",
				"  while (!fs.existsSync(flag(role + '-go'))) await new Promise(r => setTimeout(r, 5));",
				"}, { log() {}, pollMs: 5, heartbeatMs: 600000 }).catch(() => process.exit(3));",
			].join("\n"),
		);
		return script;
	};

	/** Runs `body` with a peer process per `start(role)`, and lets every peer go and exit afterwards. */
	async function withPeers(
		body: (peer: {
			start: (role: string) => Promise<number | null>;
			flag: (name: string) => string;
			has: (name: string) => boolean;
			cache: string;
			lock: string;
		}) => Promise<void>,
	): Promise<void> {
		const cache = fs.mkdtempSync(path.join(temp, "guard-"));
		const flags = fs.mkdtempSync(path.join(temp, "guard-flags-"));
		const script = stallingPeer(flags);
		const children: ChildProcess[] = [];
		const closed: Promise<number | null>[] = [];
		const flag = (name: string): string => path.join(flags, name);
		try {
			await body({
				start: role => {
					const child = spawn("bun", [script, cache, role, flags], { stdio: "ignore" });
					children.push(child);
					const done = finished(child);
					closed.push(done);
					return done;
				},
				flag,
				has: name => fs.existsSync(flag(name)),
				cache,
				lock: path.join(cache, ".lock-x"),
			});
		} finally {
			for (const role of ["A", "B"]) {
				fs.writeFileSync(flag(`${role}-go`), "");
				fs.writeFileSync(flag(`${role}-resume`), "");
			}
			fs.writeFileSync(flag("W-held"), "");
			const timer = setTimeout(() => {
				for (const child of children) child.kill("SIGKILL");
			}, 20_000);
			await Promise.all(closed);
			clearTimeout(timer);
		}
	}

	it.skipIf(!posix)(
		"takes the guard to release: a takeover cannot land between the release's ownership check and its delete",
		async () => {
			// A is on another computer and slept past staleMs; it wakes and releases. Between its check that the lock is
			// its own and its delete, a waiter W judges the lock stale and takes it over. Without the guard on the
			// release, A then deletes the lock W just made.
			const { withLock } = await lib("toolchain");
			await withPeers(async peer => {
				const aClosed = peer.start("A");
				await vi.waitFor(() => expect(peer.has("A-held")).toBe(true), { timeout: 15_000, interval: 5 });
				const old = new Date(Date.now() - 10 * 60_000);
				fs.utimesSync(path.join(peer.lock, "owner.json"), old, old); // A's heartbeat stopped: its computer slept
				fs.writeFileSync(peer.flag("A-go"), ""); // A's work ends; its release stops at the delete
				await vi.waitFor(() => expect(peer.has("A-at-rm")).toBe(true), { timeout: 15_000, interval: 5 });
				let survived = false;
				const outcome = await withLock(
					peer.cache,
					"x",
					async () => {
						fs.writeFileSync(peer.flag("W-held"), ""); // A's delete may go now
						await Promise.race([aClosed, new Promise(resolve => setTimeout(resolve, 10_000))]);
						try {
							survived =
								JSON.parse(fs.readFileSync(path.join(peer.lock, "owner.json"), "utf8")).pid === process.pid;
						} catch {
							survived = false;
						}
					},
					{ log: quiet, pollMs: 5, maxWaitMs: 15_000 },
				).catch((error: unknown) => error);
				expect(survived, "the lock W made was still W's after A released").toBe(true);
				expect(outcome).not.toBeInstanceOf(Error);
			});
		},
		60_000,
	);

	it.skipIf(!posix)(
		"takes the guard to make the lock: a takeover cannot remove a folder whose owner is still being written",
		async () => {
			// B made the lock folder and fell asleep before it wrote its owner (no owner file, an old folder mtime: it
			// looks abandoned). Without the guard on the acquire, W takes the folder over while B sleeps, and B's owner
			// write then lands in W's lock: two holders.
			const { withLock } = await lib("toolchain");
			await withPeers(async peer => {
				peer.start("B");
				await vi.waitFor(() => expect(peer.has("B-at-write")).toBe(true), { timeout: 15_000, interval: 5 });
				const old = new Date(Date.now() - 10 * 60_000);
				fs.utimesSync(peer.lock, old, old);
				let overlapped = false;
				const waiter = withLock(
					peer.cache,
					"x",
					async () => {
						fs.writeFileSync(peer.flag("W-held"), "");
						await new Promise(resolve => setTimeout(resolve, 1_500)); // B wakes and writes its owner meanwhile
						overlapped = peer.has("B-held");
					},
					{ log: quiet, pollMs: 5, maxWaitMs: 3_000 },
				).catch((error: unknown) => error);
				// W either took the folder over by now (no guard) or is waiting for B's guard (guarded).
				await vi
					.waitFor(() => expect(peer.has("W-held")).toBe(true), { timeout: 1_500, interval: 5 })
					.catch(() => undefined);
				fs.writeFileSync(peer.flag("B-resume"), "");
				await waiter;
				expect(overlapped, "W worked while B held the lock").toBe(false);
			});
		},
		60_000,
	);

	describe("a guard nobody released for 30 s", () => {
		it.each([
			["with its holder's token", true],
			["made but never given a token", false],
		])("is removed by the next taker (%s)", async (_label, withToken) => {
			const { withLock } = await lib("toolchain");
			const cache = fs.mkdtempSync(path.join(temp, "stale-guard-"));
			const guard = path.join(cache, ".lock-x.takeover");
			if (withToken) plantGuard(guard, "dead-holder", 10 * 60_000);
			else {
				realMkdir(guard);
				const then = new Date(Date.now() - 10 * 60_000);
				fs.utimesSync(guard, then, then);
			}
			let ran = false;
			await withLock(
				cache,
				"x",
				async () => {
					ran = true;
				},
				{ log: quiet, pollMs: 5 },
			);
			expect(ran).toBe(true);
			expect(fs.readdirSync(cache), "no lock, guard or leftover of the reclaim").toEqual([]);
		});

		it("is reclaimed only as the very guard that was judged: one made in between survives", async () => {
			// W judged a stale guard (stat). Before it removes it, the holder's successor released and a new holder made
			// a fresh guard under the same name. Removing "the guard" by its name would remove that live guard.
			const { withLock } = await lib("toolchain");
			const { Unavailable } = await lib("proc");
			const cache = fs.mkdtempSync(path.join(temp, "reclaim-"));
			const guard = path.join(cache, ".lock-x.takeover");
			plantGuard(guard, "dead-holder", 10 * 60_000);
			let judged = false;
			let swapped = false;
			const swap = (): void => {
				if (!judged || swapped) return;
				swapped = true;
				realRemove(guard, { recursive: true, force: true });
				plantGuard(guard, "live-holder");
			};
			vi.spyOn(fs, "statSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
				const stat = realStat(target, ...rest);
				if (String(target) === guard) judged = true;
				return stat;
			}) as typeof fs.statSync);
			vi.spyOn(fs, "rmSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
				if (String(target) === guard) swap();
				return realRemove(target, ...rest);
			}) as typeof fs.rmSync);
			vi.spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
				if (String(from) === guard) swap();
				return realRename(from, to);
			}) as typeof fs.renameSync);
			let ran = false;
			let outcome: unknown;
			try {
				outcome = await withLock(
					cache,
					"x",
					async () => {
						ran = true;
					},
					{ log: quiet, pollMs: 5, maxWaitMs: 300 },
				).catch((error: unknown) => error);
			} finally {
				vi.restoreAllMocks();
			}
			expect(swapped, "the trace ran").toBe(true);
			expect(ran, "worked inside a guard another process holds").toBe(false);
			expect(outcome).toBeInstanceOf(Unavailable);
			expect(fs.readFileSync(path.join(guard, TOKEN), "utf8"), "the live guard is still there").toBe("live-holder");
		});
	});

	describe("a guard holder that stalled past its guard's 30 s", () => {
		// Its computer slept, or the process was stopped, between taking the guard and its next fs call: another process
		// has reclaimed the guard, replaced the lock with its own and still holds the guard. The stalled one wakes and
		// must not delete that lock.
		it("does not release a lock another holder has made since", async () => {
			const { withLock } = await lib("toolchain");
			const cache = fs.mkdtempSync(path.join(temp, "stalled-release-"));
			const lock = path.join(cache, ".lock-x");
			const guard = `${lock}.takeover`;
			const ownerFile = path.join(lock, "owner.json");
			let workDone = false;
			let stalled = false;
			let reclaimerDone = false;
			vi.spyOn(fs, "readFileSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
				const data = realRead(target, ...rest);
				// The release's ownership check, with the guard held: then the stall.
				if (String(target) === ownerFile && workDone && !stalled && fs.existsSync(guard)) {
					stalled = true;
					replaceLockAndGuard(lock, guard, "B");
				}
				return data;
			}) as typeof fs.readFileSync);
			vi.spyOn(fs, "statSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
				const stat = realStat(target, ...rest);
				// The other holder is done with the guard when the stalled one looks for it again.
				if (String(target) === guard && stalled && !reclaimerDone) {
					reclaimerDone = true;
					realRemove(guard, { recursive: true, force: true });
				}
				return stat;
			}) as typeof fs.statSync);
			let result: unknown;
			try {
				result = await withLock(
					cache,
					"x",
					async () => {
						workDone = true;
						return 42;
					},
					{ log: quiet, pollMs: 5 },
				);
			} finally {
				vi.restoreAllMocks();
			}
			expect(stalled, "the trace ran").toBe(true);
			expect(result).toBe(42);
			expect(JSON.parse(fs.readFileSync(ownerFile, "utf8")).token, "the lock B made").toBe("B");
		});

		it("does not take over a lock another holder has made since", async () => {
			const { withLock } = await lib("toolchain");
			const { Unavailable } = await lib("proc");
			const cache = fs.mkdtempSync(path.join(temp, "stalled-takeover-"));
			const lock = path.join(cache, ".lock-x");
			const guard = `${lock}.takeover`;
			const ownerFile = path.join(lock, "owner.json");
			plantLock(cache, "x", { pid: 4242, host: "far-computer", started: 1, token: "A" }, 10 * 60_000);
			let reads = 0;
			let stalled = false;
			vi.spyOn(fs, "readFileSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
				const data = realRead(target, ...rest);
				// The takeover's judgment reads the owner twice, with the guard held; the stall comes after the second.
				if (String(target) === ownerFile && !stalled && fs.existsSync(guard) && ++reads === 2) {
					stalled = true;
					replaceLockAndGuard(lock, guard, "B");
				}
				return data;
			}) as typeof fs.readFileSync);
			let ran = false;
			let outcome: unknown;
			try {
				outcome = await withLock(
					cache,
					"x",
					async () => {
						ran = true;
					},
					{ log: quiet, pollMs: 5, maxWaitMs: 300 },
				).catch((error: unknown) => error);
			} finally {
				vi.restoreAllMocks();
			}
			expect(stalled, "the trace ran").toBe(true);
			expect(ran, "took over a lock that is not the one it judged").toBe(false);
			expect(outcome).toBeInstanceOf(Unavailable);
			expect(JSON.parse(fs.readFileSync(ownerFile, "utf8")).token, "the lock B made").toBe("B");
		});

		it("gives up a guarded step it started too long ago, and does it again under a fresh guard", async () => {
			// The stall here ends before anybody reclaimed the guard, so nothing shows in the guard folder: the step may
			// only trust a guard it took a moment ago.
			const { withLock } = await lib("toolchain");
			const cache = fs.mkdtempSync(path.join(temp, "slow-takeover-"));
			const lock = path.join(cache, ".lock-x");
			const guard = `${lock}.takeover`;
			const ownerFile = path.join(lock, "owner.json");
			plantLock(cache, "x", { pid: 4242, host: "far-computer", started: 1, token: "A" }, 10 * 60_000);
			let skew = 0;
			let reads = 0;
			let guards = 0;
			vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
			vi.spyOn(fs, "mkdirSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
				if (String(target) === guard) guards++;
				return realMkdir(target, ...rest);
			}) as typeof fs.mkdirSync);
			vi.spyOn(fs, "readFileSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
				const data = realRead(target, ...rest);
				if (String(target) === ownerFile && skew === 0 && fs.existsSync(guard) && ++reads === 2) skew = 15_000;
				return data;
			}) as typeof fs.readFileSync);
			let guardsBeforeWork = 0;
			try {
				await withLock(
					cache,
					"x",
					async () => {
						guardsBeforeWork = guards;
					},
					{ log: quiet, pollMs: 5 },
				);
			} finally {
				vi.restoreAllMocks();
			}
			expect(guardsBeforeWork, "the first guard was given up, a second one taken, then the lock").toBe(2);
		});
	});

	describe("unpacking an archive that every holder of the lock shares", () => {
		// The archive sits at one path (`downloads/<file of its url>`); the next holder reuses a verified one. A holder
		// whose lock was taken over must therefore never delete it.
		const tarball = (): string => {
			const root = fs.mkdtempSync(path.join(temp, "unpack-src-"));
			fs.mkdirSync(path.join(root, "tool"));
			fs.writeFileSync(path.join(root, "tool", "file.txt"), "content");
			const archive = path.join(root, "tool.tar.gz");
			expect(spawnSync("tar", ["-czf", archive, "-C", root, "tool"]).status).toBe(0);
			return archive;
		};

		it.skipIf(!posix)("removes the archive once it is unpacked", async () => {
			const { unpackArchive } = await lib("toolchain");
			const archive = tarball();
			const dest = path.join(fs.mkdtempSync(path.join(temp, "unpack-")), "tool");
			await unpackArchive(archive, "tar.gz", dest, new AbortController().signal);
			expect(fs.readFileSync(path.join(dest, "file.txt"), "utf8")).toBe("content");
			expect(fs.existsSync(archive)).toBe(false);
		});

		it.skipIf(!posix)("keeps the archive when the holder is told to stop while the unpack ends", async () => {
			const { unpackArchive } = await lib("toolchain");
			const archive = tarball();
			const dest = path.join(fs.mkdtempSync(path.join(temp, "unpack-")), "tool");
			const stop = new AbortController();
			const reason = new Error("the lock was taken over");
			vi.spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
				if (String(to) === dest) stop.abort(reason); // the holder learns it lost its lock as the unpack lands
				return realRename(from, to);
			}) as typeof fs.renameSync);
			try {
				await expect(unpackArchive(archive, "tar.gz", dest, stop.signal)).rejects.toBe(reason);
			} finally {
				vi.restoreAllMocks();
			}
			expect(fs.existsSync(archive), "the archive the next holder reuses").toBe(true);
		});
	});

	describe("releasing after the work", () => {
		it("a release that fails does not fail the work: it is logged, and the lock is left to be reclaimed", async () => {
			const { withLock } = await lib("toolchain");
			const cache = fs.mkdtempSync(path.join(temp, "release-fails-"));
			const lock = path.join(cache, ".lock-x");
			const lines: string[] = [];
			vi.spyOn(fs, "rmSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
				if (String(target) === lock) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
				return realRemove(target, ...rest);
			}) as typeof fs.rmSync);
			let result: unknown;
			try {
				result = await withLock(cache, "x", async () => "installed", {
					log: (line: string) => lines.push(line),
				}).catch((error: unknown) => error);
			} finally {
				vi.restoreAllMocks();
			}
			expect(result).toBe("installed");
			expect(lines.join("\n"), "the failed release is logged").toMatch(/releas/i);
		});

		it("a guard that stays busy for the release does not fail the work either, and the wait is bounded", async () => {
			const { withLock } = await lib("toolchain");
			const cache = fs.mkdtempSync(path.join(temp, "release-busy-"));
			const guard = path.join(cache, ".lock-x.takeover");
			const lines: string[] = [];
			const started = Date.now();
			const result = await withLock(
				cache,
				"x",
				async () => {
					plantGuard(guard, "somebody-else"); // taken for good (fresh, so nobody reclaims it)
					return "installed";
				},
				{ log: (line: string) => lines.push(line), guardWaitMs: 150 },
			).catch((error: unknown) => error);
			expect(result).toBe("installed");
			expect(Date.now() - started, "the wait for the guard is bounded").toBeLessThan(5_000);
			expect(lines.join("\n")).toMatch(/releas/i);
		});

		it.skipIf(!posix)(
			"a signal's release gives up on a busy guard within moments instead of blocking the exit",
			async () => {
				const script = path.join(temp, "lock-hold-busy.ts");
				fs.writeFileSync(
					script,
					[
						`import { withLock } from ${JSON.stringify(path.join(SKILL, "scripts/lib/toolchain.ts"))};`,
						"await withLock(process.argv[2], 'x', async () => {",
						"  console.log('held');",
						"  await new Promise(() => {});",
						"}, { log() {} });",
					].join("\n"),
				);
				const cache = fs.mkdtempSync(path.join(temp, "term-busy-"));
				const child = spawn("bun", [script, cache], { stdio: ["ignore", "pipe", "ignore"] });
				const held = Promise.withResolvers<void>();
				child.stdout?.on("data", () => held.resolve());
				const closed = finished(child);
				await held.promise;
				plantGuard(path.join(cache, ".lock-x.takeover"), "somebody-else"); // busy, and not stale for 30 s
				const started = Date.now();
				child.kill("SIGTERM");
				const killer = setTimeout(() => child.kill("SIGKILL"), 8_000);
				const code = await closed;
				clearTimeout(killer);
				expect(code, "ended by SIGTERM, not killed after a long block").toBe(143);
				expect(Date.now() - started).toBeLessThan(5_000);
			},
			30_000,
		);
	});
});

describe("environmental failures are UNAVAILABLE, not a stack (finding 2)", () => {
	it.skipIf(!posix || isRoot)("a lock in an unwritable cache is Unavailable", async () => {
		const { withLock } = await lib("toolchain");
		const { Unavailable } = await lib("proc");
		const cache = fs.mkdtempSync(path.join(temp, "ro-lock-"));
		fs.chmodSync(cache, 0o555);
		await expect(withLock(cache, "x", async () => 1, { log: quiet })).rejects.toBeInstanceOf(Unavailable);
	});

	it("work that fails with a full or read-only disk is Unavailable and says which tool", async () => {
		const { withLock } = await lib("toolchain");
		const { Unavailable } = await lib("proc");
		const cache = fs.mkdtempSync(path.join(temp, "enospc-"));
		for (const code of ["ENOSPC", "EACCES", "EROFS", "EPERM", "EBUSY"]) {
			const error = Object.assign(new Error(`${code}: boom`), { code });
			const failure = await withLock(
				cache,
				"jre",
				async () => {
					throw error;
				},
				{ log: quiet },
			).catch((caught: unknown) => caught);
			expect(failure).toBeInstanceOf(Unavailable);
			expect((failure as Error).message).toContain("jre");
			expect((failure as Error).message).toContain(code);
		}
		// A bug is still a bug.
		await expect(
			withLock(
				cache,
				"jre",
				async () => {
					throw new TypeError("not an environment problem");
				},
				{ log: quiet },
			),
		).rejects.toBeInstanceOf(TypeError);
	});

	/** A pin file whose portable JRE is `archive` (tar.gz) and whose jars are already in the cache. */
	async function jrePins(archive: string): Promise<{ env: NodeJS.ProcessEnv; cache: string }> {
		const { DEFAULT_TOOLCHAIN_FILE } = await lib("toolchain");
		const cache = fs.mkdtempSync(path.join(temp, "jre-"));
		const sources = path.join(cache, "src");
		fs.mkdirSync(sources);
		fs.writeFileSync(path.join(sources, "tla2tools.jar"), "tla jar");
		fs.writeFileSync(path.join(sources, "community.jar"), "community jar");
		const pins = JSON.parse(fs.readFileSync(DEFAULT_TOOLCHAIN_FILE, "utf8"));
		pins.tla.tla2tools.url = fileUrl(path.join(sources, "tla2tools.jar"));
		pins.tla.tla2tools.sha256 = sha("tla jar");
		pins.tla.communityModules.url = fileUrl(path.join(sources, "community.jar"));
		pins.tla.communityModules.sha256 = sha("community jar");
		pins.tla.jre.platforms[`${process.platform}-${process.arch}`] = {
			version: "17.0.1+1",
			url: fileUrl(archive),
			sha256: sha(fs.readFileSync(archive)),
			format: "tar.gz",
		};
		const pinFile = path.join(cache, "toolchain.json");
		fs.writeFileSync(pinFile, JSON.stringify(pins));
		return {
			cache,
			env: {
				...process.env,
				OMPDESK_FORMAL_CACHE: cache,
				OMPDESK_FORMAL_TOOLCHAIN: pinFile,
				OMPDESK_FORMAL_NO_SYSTEM_JAVA: "1",
			},
		};
	}

	function jreArchive(name: string): string {
		const root = fs.mkdtempSync(path.join(temp, "jre-src-"));
		fs.mkdirSync(path.join(root, "jdk", "bin"), { recursive: true });
		fs.writeFileSync(path.join(root, "jdk", "bin", "java"), "#!/bin/sh\necho 'openjdk version \"17.0.1\"' >&2\n", {
			mode: 0o755,
		});
		const archive = path.join(root, name);
		const packed = spawnSync("tar", ["-czf", archive, "-C", root, "jdk"]);
		expect(packed.status).toBe(0);
		return archive;
	}

	it.skipIf(!posix)(
		"a portable JRE archive that does not unpack is Unavailable (exit 3 territory), not a stack",
		async () => {
			const { prepareTla } = await lib("tla-env");
			const { Unavailable } = await lib("proc");
			const bad = path.join(temp, "not-a-tarball.tar.gz");
			fs.writeFileSync(bad, "this is not a gzip stream");
			const { env } = await jrePins(bad);
			const failure = await prepareTla({ env, log: quiet }).catch((caught: unknown) => caught);
			expect(failure).toBeInstanceOf(Unavailable);
			expect((failure as Error).message).toContain("unpacking");
		},
		30_000,
	);

	it.skipIf(!posix || isRoot)(
		"a cache folder that cannot be written while unpacking is Unavailable",
		async () => {
			const { prepareTla } = await lib("tla-env");
			const { Unavailable } = await lib("proc");
			const { env, cache } = await jrePins(jreArchive("jre.tar.gz"));
			fs.mkdirSync(path.join(cache, "jre"));
			fs.chmodSync(path.join(cache, "jre"), 0o555);
			const failure = await prepareTla({ env, log: quiet }).catch((caught: unknown) => caught);
			expect(failure).toBeInstanceOf(Unavailable);
		},
		30_000,
	);
});

describe("download reuses a verified archive (finding 3)", () => {
	it("returns at once when the archive is already there and matches, even offline and without its source", async () => {
		const { download } = await lib("toolchain");
		const dest = path.join(temp, "dl-reuse", "lean.zip");
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, "archive bytes");
		await download(fileUrl(path.join(temp, "gone.zip")), dest, sha("archive bytes"), {
			label: "lean",
			env: { OMPDESK_FORMAL_OFFLINE: "1" },
			log: quiet,
		});
		expect(fs.readFileSync(dest, "utf8")).toBe("archive bytes");
	});

	it("still fetches when the file there is not the pinned one", async () => {
		const { download } = await lib("toolchain");
		const { Unavailable } = await lib("proc");
		const dest = path.join(temp, "dl-reuse", "other.zip");
		fs.writeFileSync(dest, "truncated");
		await expect(
			download(fileUrl(path.join(temp, "gone.zip")), dest, sha("archive bytes"), {
				label: "lean",
				env: { OMPDESK_FORMAL_OFFLINE: "1" },
				log: quiet,
			}),
		).rejects.toBeInstanceOf(Unavailable);
	});
});

describe("leftovers in a shared cache (finding 4)", () => {
	it("names its part and unpack folders after this host, and cleans only those", async () => {
		const { cleanLeftovers, hostTag } = await lib("toolchain");
		const cache = fs.mkdtempSync(path.join(temp, "hosts-"));
		fs.mkdirSync(path.join(cache, "downloads"));
		const dead = deadPid();
		const mine = path.join(cache, "downloads", `a.zip.part-${hostTag()}-${dead}`);
		const theirs = path.join(cache, "downloads", `b.zip.part-otherhost-${dead}`);
		const live = path.join(cache, "downloads", `c.zip.part-${hostTag()}-${process.pid}`);
		for (const file of [mine, theirs, live]) fs.writeFileSync(file, "x");
		expect(cleanLeftovers(cache)).toEqual([mine]);
		expect(fs.existsSync(theirs)).toBe(true);
		expect(fs.existsSync(live)).toBe(true);
	});

	it("leaves a hostless leftover alone while another computer's lock was touched recently", async () => {
		const { withLock } = await lib("toolchain");
		const cache = fs.mkdtempSync(path.join(temp, "foreign-active-"));
		fs.mkdirSync(path.join(cache, "downloads"));
		const legacy = path.join(cache, "downloads", `old.zip.part-${deadPid()}`);
		fs.writeFileSync(legacy, "x");
		const lock = plantLock(cache, "other", { pid: 1, host: "some-other-computer", started: 1, token: "t" });
		await withLock(cache, "mine", async () => undefined, { log: quiet, staleMs: 60_000 });
		expect(fs.existsSync(legacy)).toBe(true);
		const old = new Date(Date.now() - 10 * 60_000);
		fs.utimesSync(path.join(lock, "owner.json"), old, old);
		await withLock(cache, "mine", async () => undefined, { log: quiet, staleMs: 60_000 });
		expect(fs.existsSync(legacy)).toBe(false);
	});
});

describe("setup.ts output (findings 5 and 6)", () => {
	const offline = (cache: string): NodeJS.ProcessEnv => ({
		...process.env,
		OMPDESK_FORMAL_CACHE: cache,
		OMPDESK_FORMAL_OFFLINE: "1",
		OMPDESK_FORMAL_NO_SYSTEM_JAVA: "1",
	});

	it("--json prints a JSON object on failure too: status, target and reason", () => {
		const cache = fs.mkdtempSync(path.join(temp, "json-"));
		const run = spawnSync("bun", [path.join(SKILL, "scripts/setup.ts"), "tla", "--json"], {
			encoding: "utf8",
			env: offline(cache),
		});
		expect(run.status).toBe(3);
		const parsed = JSON.parse(run.stdout);
		expect(parsed.status).toBe("UNAVAILABLE");
		expect(parsed.target).toBe("tla");
		expect(typeof parsed.reason).toBe("string");
		const check = spawnSync("bun", [path.join(SKILL, "scripts/setup.ts"), "lean", "--check", "--json"], {
			encoding: "utf8",
			env: offline(cache),
		});
		expect(check.status).toBe(3);
		expect(JSON.parse(check.stdout)).toMatchObject({ status: "UNAVAILABLE", target: "lean" });
	}, 30_000);

	it.skipIf(process.platform !== "darwin")(
		"prints the Lean download and unpack lines on stderr and keeps --json on stdout parseable",
		async () => {
			const { DEFAULT_TOOLCHAIN_FILE } = await lib("toolchain");
			const dir = fs.mkdtempSync(path.join(temp, "lean-pins-"));
			const cache = path.join(dir, "cache");
			const key = `${process.platform}-${process.arch}`;
			// elan: an archive whose elan-init plants `elan` and `lake` scripts in ELAN_HOME/bin.
			const elanSrc = path.join(dir, "elan-src");
			fs.mkdirSync(elanSrc);
			fs.writeFileSync(
				path.join(elanSrc, "elan-init"),
				[
					"#!/bin/sh",
					'mkdir -p "$ELAN_HOME/bin"',
					'printf "#!/bin/sh\\nexit 0\\n" > "$ELAN_HOME/bin/elan"',
					'printf "#!/bin/sh\\necho \\"Lake version 5.0.0 (Lean version 4.35.0)\\"\\n" > "$ELAN_HOME/bin/lake"',
					'chmod +x "$ELAN_HOME/bin/elan" "$ELAN_HOME/bin/lake"',
					"",
				].join("\n"),
				{ mode: 0o755 },
			);
			const elanArchive = path.join(dir, "elan.tar.gz");
			expect(spawnSync("tar", ["-czf", elanArchive, "-C", elanSrc, "elan-init"]).status).toBe(0);
			const leanSrc = path.join(dir, "lean-src", "lean-4.35.0-fake", "bin");
			fs.mkdirSync(leanSrc, { recursive: true });
			fs.writeFileSync(path.join(leanSrc, "lake"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
			const leanArchive = path.join(dir, "lean.zip");
			expect(
				spawnSync("zip", ["-qr", leanArchive, "lean-4.35.0-fake"], { cwd: path.join(dir, "lean-src") }).status,
			).toBe(0);
			const pins = JSON.parse(fs.readFileSync(DEFAULT_TOOLCHAIN_FILE, "utf8"));
			pins.lean.elan.platforms[key] = {
				url: fileUrl(elanArchive),
				sha256: sha(fs.readFileSync(elanArchive)),
				format: "tar.gz",
			};
			pins.lean.archive.platforms[key] = {
				url: fileUrl(leanArchive),
				sha256: sha(fs.readFileSync(leanArchive)),
				format: "zip",
			};
			const pinFile = path.join(dir, "toolchain.json");
			fs.writeFileSync(pinFile, JSON.stringify(pins));
			const run = spawnSync("bun", [path.join(SKILL, "scripts/setup.ts"), "lean", "--json"], {
				encoding: "utf8",
				env: { ...process.env, OMPDESK_FORMAL_CACHE: cache, OMPDESK_FORMAL_TOOLCHAIN: pinFile },
			});
			expect(run.stderr).toContain("downloading Lean");
			expect(run.stderr).toContain("unpacking Lean");
			expect(run.status).toBe(0);
			expect(JSON.parse(run.stdout)).toMatchObject({ status: "READY", target: "lean" });
		},
		60_000,
	);
});

describe("Windows unpacking (finding 7)", () => {
	it("calls bsdtar by absolute path on Windows, plain tar elsewhere", async () => {
		const { tarProgram } = await lib("toolchain");
		expect(tarProgram("win32", { SystemRoot: "C:\\Windows" })).toBe("C:\\Windows\\System32\\tar.exe");
		expect(tarProgram("darwin", { SystemRoot: "C:\\Windows" })).toBe("tar");
	});

	it("silences PowerShell's progress bar in the Expand-Archive fallback", async () => {
		const { expandArchiveCommand } = await lib("toolchain");
		const command: string = expandArchiveCommand("C:\\a b\\it's.zip", "C:\\out");
		expect(command.startsWith("$ProgressPreference='SilentlyContinue';")).toBe(true);
		expect(command).toContain("-LiteralPath 'C:\\a b\\it''s.zip'");
	});

	it("retries the final rename on EPERM, EACCES and EBUSY, and only on those", async () => {
		const { renameRetrying } = await lib("toolchain");
		const failing = (code: string, times: number): { rename: () => void; calls: () => number } => {
			let calls = 0;
			return {
				calls: () => calls,
				rename: () => {
					calls++;
					if (calls <= times) throw Object.assign(new Error(code), { code });
				},
			};
		};
		for (const code of ["EPERM", "EACCES", "EBUSY"]) {
			const fake = failing(code, 2);
			await renameRetrying("a", "b", [0, 0, 0], fake.rename);
			expect(fake.calls()).toBe(3);
		}
		const stuck = failing("EPERM", 99);
		await expect(renameRetrying("a", "b", [0, 0], stuck.rename)).rejects.toThrow("EPERM");
		expect(stuck.calls()).toBe(3);
		const missing = failing("ENOENT", 99);
		await expect(renameRetrying("a", "b", [0, 0], missing.rename)).rejects.toThrow("ENOENT");
		expect(missing.calls()).toBe(1);
	});
});

describe("omp's PATH carries the bun of a custom BUN_INSTALL (finding 8)", () => {
	it("adds <BUN_INSTALL>/bin, not ~/.bun/bin, when BUN_INSTALL is set", async () => {
		const bunRoot = path.join(temp, "custom-bun");
		const previous = process.env.BUN_INSTALL;
		process.env.BUN_INSTALL = bunRoot;
		try {
			const entries = ompPathEnv(path.join(temp, "omp", "omp"), "/usr/bin").split(path.delimiter);
			expect(entries).toContain(path.join(bunRoot, "bin"));
			expect(entries).not.toContain(path.join(os.homedir(), ".bun", "bin"));
		} finally {
			if (previous === undefined) delete process.env.BUN_INSTALL;
			else process.env.BUN_INSTALL = previous;
		}
	});
});
