/**
 * The toolchain audit's findings (the install lock, environmental failures, archive reuse, leftovers in the cache,
 * setup.ts output, Windows unpacking, agents' bun on PATH). No test here touches the network or the real home: the
 * cache is a temp folder and every source is a file:// URL. Whatever takes the install lock runs in a Bun child
 * (`inBun`), since the lock needs bun:ffi.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ompPathEnv } from "../omp-runtime";
import { inBun } from "./in-bun";

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

/**
 * The install lock is an OS lock (flock on macOS and Linux, a sharing mode on Windows): held while the process lives,
 * dropped by the kernel when it dies. Every case runs real child processes under Bun (the lock needs bun:ffi, which
 * vitest's Node does not have) and waits on events they cause: a file they write, their stdin, their exit. The only
 * clock is the lock's own `maxWaitMs`.
 */
describe("the install lock", () => {
	const TOOLCHAIN = path.join(SKILL, "scripts/lib/toolchain.ts");
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
			// A critical section that takes real time: a lock that let two in would show them inside together.
			"  Atomics.wait(gate, 0, 0, 20);",
			"  fs.rmSync(marker, { recursive: true, force: true });",
			"}, { log() {}, pollMs: 5 });",
		].join("\n");

	/**
	 * Rounds of `procs` processes released together onto one lock. Each round has its own deadline, so a hung waiter
	 * fails the round inside `race` (not as a test timeout that skips `finally`), and every child is killed and
	 * awaited before its folder goes.
	 */
	async function race(procs: number, rounds: number, roundMs: number): Promise<void> {
		const script = path.join(temp, `lock-child-${procs}.ts`);
		fs.writeFileSync(script, CHILD(TOOLCHAIN));
		let overlaps = 0;
		let entered = 0;
		for (let round = 0; round < rounds; round++) {
			const dir = fs.mkdtempSync(path.join(temp, "race-"));
			const cache = path.join(dir, "cache");
			fs.mkdirSync(cache);
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
			} finally {
				for (const child of children) child.kill("SIGKILL");
				await Promise.all(done);
				fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		}
		expect(entered).toBe(rounds * procs);
		expect(overlaps).toBe(0);
	}

	it("lets two processes in one at a time, on every OS", () => race(2, 3, 120_000), 600_000);

	it("lets several processes in one at a time, in every round", () => race(8, 12, 120_000), 600_000);

	/** A peer takes the lock, holds it until its stdin ends, then leaves. */
	interface Peer {
		child: ChildProcess;
		closed: Promise<number | null>;
		errors: string[];
		/** Tells the peer to leave the lock. */
		release: () => void;
	}
	async function scenario(
		body: (s: {
			lock: string;
			start: (id: string, options?: { pollMs?: number; maxWaitMs?: number; marker?: boolean }) => Peer;
			has: (name: string) => boolean;
			until: (ok: () => boolean, what: string) => Promise<void>;
			log: () => string[];
		}) => Promise<void>,
	): Promise<void> {
		const dir = fs.mkdtempSync(path.join(temp, "lock-scenario-"));
		const cache = path.join(dir, "cache");
		const flags = path.join(dir, "flags");
		fs.mkdirSync(cache);
		fs.mkdirSync(flags);
		const script = path.join(dir, "peer.ts");
		fs.writeFileSync(
			script,
			[
				'import fs from "node:fs";',
				'import path from "node:path";',
				`import { withLock } from ${JSON.stringify(TOOLCHAIN)};`,
				"const [cache, id, flags, marker, log, pollMs, maxWaitMs] = process.argv.slice(2);",
				"const flag = name => path.join(flags, name);",
				"// A waiter with pollMs 7 says so after its third failed try (each one ends in a 7 ms sleep).",
				"const realSet = globalThis.setTimeout;",
				"let tries = 0;",
				"globalThis.setTimeout = (fn, ms, ...rest) => {",
				"  if (ms === 7 && ++tries === 3) fs.writeFileSync(flag(id + '-polled'), '');",
				"  return realSet(fn, ms, ...rest);",
				"};",
				"await withLock(cache, 'x', async () => {",
				"  if (marker !== '-') try { fs.mkdirSync(marker); } catch { fs.appendFileSync(log, 'overlap ' + id + '\\n'); }",
				"  fs.appendFileSync(log, 'entered ' + id + '\\n');",
				"  fs.writeFileSync(flag(id + '-held'), '');",
				"  for await (const _ of process.stdin) break;",
				"  if (marker !== '-') fs.rmSync(marker, { recursive: true, force: true });",
				"  fs.appendFileSync(log, 'left ' + id + '\\n');",
				"}, { log() {}, pollMs: Number(pollMs), maxWaitMs: Number(maxWaitMs) })",
				"  .catch(error => { console.error(error.name + ': ' + error.message); process.exit(3); });",
			].join("\n"),
		);
		const marker = path.join(dir, "inside");
		const log = path.join(dir, "log.txt");
		fs.writeFileSync(log, "");
		const peers: Peer[] = [];
		try {
			await body({
				lock: path.join(cache, ".lock-x"),
				start: (id, options = {}) => {
					const child = spawn(
						"bun",
						[
							script,
							cache,
							id,
							flags,
							options.marker === false ? "-" : marker,
							log,
							String(options.pollMs ?? 7),
							String(options.maxWaitMs ?? 600_000),
						],
						{ stdio: ["pipe", "ignore", "pipe"], cwd: dir },
					);
					const errors: string[] = [];
					child.stderr?.on("data", chunk => errors.push(String(chunk)));
					child.stdin?.on("error", () => {});
					const peer: Peer = {
						child,
						closed: finished(child),
						errors,
						release: () => child.stdin?.end("release\n"),
					};
					peers.push(peer);
					return peer;
				},
				has: name => fs.existsSync(path.join(flags, name)),
				until: (ok, what) =>
					vi.waitFor(
						() => {
							if (!ok()) throw new Error(`waiting for ${what}`);
						},
						{ timeout: 120_000, interval: 5 },
					),
				log: () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean),
			});
		} finally {
			for (const peer of peers) {
				if (posix) peer.child.kill("SIGCONT");
				peer.release();
			}
			const timer = setTimeout(() => {
				for (const peer of peers) peer.child.kill("SIGKILL");
			}, 120_000);
			await Promise.all(peers.map(peer => peer.closed));
			clearTimeout(timer);
			fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	}

	it(
		"frees the lock at once for a waiter when its holder is killed",
		() =>
			scenario(async s => {
				const holder = s.start("H", { marker: false }); // killed inside: its marker would stay
				await s.until(() => s.has("H-held"), "H to hold the lock");
				expect(JSON.parse(fs.readFileSync(s.lock, "utf8")).pid, "the note names the holder").toBe(holder.child.pid);
				const waiter = s.start("W");
				await s.until(() => s.has("W-polled"), "W to have been turned away three times");
				expect(s.has("W-held"), "W got in beside a live holder").toBe(false);
				holder.child.kill("SIGKILL");
				await s.until(() => s.has("W-held"), "W to take the lock of the killed holder");
				waiter.release();
				expect(await waiter.closed).toBe(0);
				expect(waiter.errors.join("")).toBe("");
				expect(s.log()).toEqual(["entered H", "entered W", "left W"]);
			}),
		240_000,
	);

	it.skipIf(!posix)(
		"does not take a stopped holder's lock: the waiter keeps waiting while it is stopped and gets in after it goes on and leaves",
		() =>
			scenario(async s => {
				const holder = s.start("H");
				await s.until(() => s.has("H-held"), "H to hold the lock");
				holder.child.kill("SIGSTOP");
				const waiter = s.start("W");
				await s.until(() => s.has("W-polled"), "W to have been turned away three times by the stopped holder");
				expect(s.has("W-held"), "W took a lock whose holder is only stopped").toBe(false);
				expect(waiter.child.exitCode, "W gave up").toBeNull();
				holder.child.kill("SIGCONT");
				holder.release();
				await s.until(() => s.has("W-held"), "W to take the lock once H left");
				waiter.release();
				expect(await holder.closed).toBe(0);
				expect(await waiter.closed).toBe(0);
				expect(s.log()).toEqual(["entered H", "left H", "entered W", "left W"]);
			}),
		240_000,
	);

	it(
		"is Unavailable for a waiter once maxWaitMs is over, naming the holder, and leaves the holder alone",
		() =>
			scenario(async s => {
				const holder = s.start("H");
				await s.until(() => s.has("H-held"), "H to hold the lock");
				const waiter = s.start("W", { pollMs: 5, maxWaitMs: 50 });
				expect(await waiter.closed).toBe(3);
				expect(waiter.errors.join("")).toContain("Unavailable");
				expect(waiter.errors.join("")).toContain(`pid ${holder.child.pid}`);
				expect(s.has("W-held")).toBe(false);
				expect(holder.child.exitCode).toBeNull();
			}),
		240_000,
	);

	it("keeps calls in one process apart too", () => {
		const cache = fs.mkdtempSync(path.join(temp, "same-process-"));
		const out = inBun(
			temp,
			[
				'const { withLock } = await lib("toolchain");',
				`const cache = ${JSON.stringify(cache)};`,
				"let inside = 0;",
				"let overlaps = 0;",
				"const order = [];",
				"const call = id => withLock(cache, 'x', async () => {",
				"  if (++inside > 1) overlaps++;",
				"  order.push(id + ' in');",
				"  await new Promise(resolve => setImmediate(resolve));",
				"  order.push(id + ' out');",
				"  inside--;",
				"}, { log() {}, pollMs: 3 });",
				"await Promise.all([call('a'), call('b'), call('c')]);",
				"console.log(JSON.stringify({ overlaps, order }));",
			].join("\n"),
		);
		expect(out.stderr).toBe("");
		const { overlaps, order } = JSON.parse(out.stdout);
		expect(overlaps).toBe(0);
		expect(order).toHaveLength(6);
		for (let at = 0; at < order.length; at += 2) {
			expect(order[at + 1], "each call leaves before the next one enters").toBe(order[at].replace(" in", " out"));
		}
	});

	it("decides by the OS lock alone: a note left in the lock file by a holder that is gone is no obstacle", () => {
		const cache = fs.mkdtempSync(path.join(temp, "stale-note-"));
		const lock = path.join(cache, ".lock-x");
		fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), started: 1 })); // a live pid, long ago
		const out = inBun(
			temp,
			[
				'const { withLock } = await lib("toolchain");',
				`console.log(await withLock(${JSON.stringify(cache)}, "x", async () => "worked", { log() {}, maxWaitMs: 0 }));`,
			].join("\n"),
		);
		expect(out.stdout.trim()).toBe("worked");
		expect(JSON.parse(fs.readFileSync(lock, "utf8")).pid, "the note is the new holder's").not.toBe(process.pid);
	});

	it("replaces the folder that the hand-made protocol left as its lock", () => {
		const cache = fs.mkdtempSync(path.join(temp, "old-folder-"));
		plantLock(cache, "x", { pid: deadPid(), host: os.hostname(), started: 1, token: "gone" });
		const out = inBun(
			temp,
			[
				'const { withLock } = await lib("toolchain");',
				`console.log(await withLock(${JSON.stringify(cache)}, "x", async () => "worked", { log() {}, maxWaitMs: 0 }));`,
			].join("\n"),
		);
		expect(out.stdout.trim()).toBe("worked");
		expect(fs.statSync(path.join(cache, ".lock-x")).isFile()).toBe(true);
	});
});

describe("environmental failures are UNAVAILABLE, not a stack (finding 2)", () => {
	it.skipIf(!posix || isRoot)("a lock in an unwritable cache is Unavailable", () => {
		const cache = fs.mkdtempSync(path.join(temp, "ro-lock-"));
		fs.chmodSync(cache, 0o555);
		const out = inBun(
			temp,
			[
				'const { withLock } = await lib("toolchain");',
				`console.log(await withLock(${JSON.stringify(cache)}, "x", async () => 1, { log() {} }).then(() => "ran", (error) => error.name));`,
			].join("\n"),
		);
		expect(out.stdout.trim()).toBe("Unavailable");
	});

	it.skipIf(!posix || isRoot)("a lock file that cannot be opened is Unavailable and names the file", () => {
		const cache = fs.mkdtempSync(path.join(temp, "closed-lock-"));
		const lock = path.join(cache, ".lock-x");
		fs.writeFileSync(lock, "");
		fs.chmodSync(lock, 0o000);
		const out = inBun(
			temp,
			[
				'const { withLock } = await lib("toolchain");',
				`const caught = await withLock(${JSON.stringify(cache)}, "x", async () => 1, { log() {} }).then(() => null, (error) => error);`,
				"console.log(JSON.stringify({ name: caught?.name, message: caught?.message }));",
			].join("\n"),
		);
		const failure = JSON.parse(out.stdout);
		expect(failure.name).toBe("Unavailable");
		expect(failure.message).toContain(lock);
	});

	it.skipIf(!!process.versions.bun)(
		"without bun:ffi (a runtime that is not Bun) the lock is Unavailable, not a pass",
		async () => {
			const { withLock } = await lib("toolchain");
			const { Unavailable } = await lib("proc");
			const cache = fs.mkdtempSync(path.join(temp, "no-ffi-"));
			const failure = await withLock(cache, "x", async () => 1, { log: quiet }).catch((caught: unknown) => caught);
			expect(failure).toBeInstanceOf(Unavailable);
			expect((failure as Error).message).toContain("bun:ffi");
		},
	);

	it("work that fails with a full or read-only disk is Unavailable and says which tool", () => {
		const cache = fs.mkdtempSync(path.join(temp, "enospc-"));
		const out = inBun(
			temp,
			[
				'const { withLock } = await lib("toolchain");',
				`const cache = ${JSON.stringify(cache)};`,
				"const failures = [];",
				'for (const code of ["ENOSPC", "EACCES", "EROFS", "EPERM", "EBUSY"]) {',
				'  const error = Object.assign(new Error(code + ": boom"), { code });',
				'  const caught = await withLock(cache, "jre", async () => { throw error; }, { log() {} }).catch((e) => e);',
				"  failures.push({ name: caught.name, message: caught.message });",
				"}",
				"// A bug is still a bug.",
				'const bug = await withLock(cache, "jre", async () => { throw new TypeError("not an environment problem"); }, { log() {} }).catch((e) => e);',
				"console.log(JSON.stringify({ failures, bug: bug.name }));",
			].join("\n"),
		);
		const { failures, bug } = JSON.parse(out.stdout);
		const codes = ["ENOSPC", "EACCES", "EROFS", "EPERM", "EBUSY"];
		failures.forEach((failure: { name: string; message: string }, index: number) => {
			expect(failure.name).toBe("Unavailable");
			expect(failure.message).toContain("jre");
			expect(failure.message).toContain(codes[index]);
		});
		expect(bug).toBe("TypeError");
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

	/** The failure `prepareTla` ends in under `env` (it takes the install lock, which needs Bun), as {name, message}. */
	const prepareFailure = (env: NodeJS.ProcessEnv): { name?: string; message?: string } =>
		JSON.parse(
			inBun(
				temp,
				[
					'const { prepareTla } = await lib("tla-env");',
					"const caught = await prepareTla({ log() {} }).then(() => null, (error) => error);",
					"console.log(JSON.stringify({ name: caught?.name, message: caught?.message }));",
				].join("\n"),
				env,
			).stdout,
		);

	it.skipIf(!posix)(
		"a portable JRE archive that does not unpack is Unavailable (exit 3 territory), not a stack",
		async () => {
			const bad = path.join(temp, "not-a-tarball.tar.gz");
			fs.writeFileSync(bad, "this is not a gzip stream");
			const { env } = await jrePins(bad);
			const failure = prepareFailure(env);
			expect(failure.name).toBe("Unavailable");
			expect(failure.message).toContain("unpacking");
		},
		30_000,
	);

	it.skipIf(!posix || isRoot)(
		"a cache folder that cannot be written while unpacking is Unavailable",
		async () => {
			const { env, cache } = await jrePins(jreArchive("jre.tar.gz"));
			fs.mkdirSync(path.join(cache, "jre"));
			fs.chmodSync(path.join(cache, "jre"), 0o555);
			expect(prepareFailure(env).name).toBe("Unavailable");
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

describe("leftovers in the cache (finding 4)", () => {
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
