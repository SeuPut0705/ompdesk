/**
 * What a repository-lock holder that ran past its bound can still do. Two cases, both on the fake clock only (the fs,
 * git and child processes are real):
 *  - an effect it has not started yet (its code resumes after a late answer that is not an fs call): fenced, it throws
 *    before it starts and never lands on what the next holder made;
 *  - an effect the OS already has (an fs call dispatched, a child still exiting): the caller hears of the stop at once,
 *    but the lock is not handed to the next holder until that effect settled, so it cannot finish against the next
 *    holder's files; a call still running `STALLED_DRAIN_MAX_MS` after the stop makes every mutation fail busy (naming it)
 *    until it ended, and then the repository is usable again.
 */
import { promises } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SavedWorktreeStore } from "./disk/saved-worktrees";
import { fs } from "./fenced-fs";
import { primaryRoot, repoRoot } from "./local/git/changes";
import { execBin, REPO_LOCK_HOLD_MS, withRepoLock } from "./local/git/exec";
import * as scm from "./local/git/scm";
import { gitSync } from "./local/git/test-repos";
import { createWorktree } from "./local/git/worktree";
import { ChainBusyError, SerialChain, STALLED_DRAIN_MAX_MS, StepStalledError, trackEffect } from "./serial-chain";
import { removeOrphanWorktree } from "./worktree-orphans";
import { bridge, deps, installOrphansRig, repo, root, SLOW, scene, wtRoot } from "./worktree-orphans-test-rig";

installOrphansRig();

type Held = "realpath" | "mkdir" | "rm" | "rename" | "writeFile" | "copyFile" | "symlink" | "readFile";

interface HeldCall {
	/** The call was made (and is held). */
	reached: Promise<void>;
	/** The real operation finished (after `release`). */
	answered: Promise<void>;
	release: () => void;
}

/** Holds the first `method` call whose first argument is `target` until `release()`, then runs it for real. */
function hold(method: Held, target: string, order?: string[]): HeldCall {
	const real = promises[method].bind(promises) as (...args: unknown[]) => Promise<unknown>;
	const reached = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const answered = Promise.withResolvers<void>();
	let used = false;
	vi.spyOn(promises, method).mockImplementation((async (...args: unknown[]) => {
		if (used || args[0] !== target) return real(...args);
		used = true;
		reached.resolve();
		await released.promise;
		const answer = await real(...args);
		order?.push(`${method} done`);
		answered.resolve();
		return answer;
	}) as never);
	return { reached: reached.promise, answered: answered.promise, release: () => released.resolve() };
}

/** Real fs round trips: enough for anything a resumed holder still started to land. */
async function settle(): Promise<void> {
	for (let round = 0; round < 25; round++) await promises.stat(os.tmpdir());
}

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const caught = (run: Promise<unknown>): Promise<unknown> =>
	run.then(
		() => null,
		error => error,
	);

type Op = [
	name: string,
	act: (dir: string) => Promise<unknown>,
	verify: (dir: string, order: string[]) => Promise<void>,
];

const read = (dir: string, name: string) => promises.readFile(path.join(dir, name), "utf8");
const missing = (dir: string, name: string) => expect(promises.lstat(path.join(dir, name))).rejects.toThrow();

describe("an effect a stopped holder has not started", () => {
	const ops: Array<[string, Op[1], Op[2]]> = [
		[
			"rm",
			dir => fs.rm(path.join(dir, "kept.txt"), { force: true, recursive: true }),
			async dir => expect(await read(dir, "kept.txt")).toBe("next holder\n"),
		],
		[
			"rename",
			dir => fs.rename(path.join(dir, "kept.txt"), path.join(dir, "moved.txt")),
			async dir => {
				expect(await read(dir, "kept.txt")).toBe("next holder\n");
				await missing(dir, "moved.txt");
			},
		],
		[
			"writeFile",
			dir => fs.writeFile(path.join(dir, "kept.txt"), "old holder\n"),
			async dir => expect(await read(dir, "kept.txt")).toBe("next holder\n"),
		],
		[
			"copyFile",
			dir => fs.copyFile(path.join(dir, "kept.txt"), path.join(dir, "copy.txt")),
			dir => missing(dir, "copy.txt"),
		],
		["symlink", dir => fs.symlink(path.join(dir, "kept.txt"), path.join(dir, "link")), dir => missing(dir, "link")],
		["mkdir", dir => fs.mkdir(path.join(dir, "made", "deep"), { recursive: true }), dir => missing(dir, "made")],
	];

	it.each(ops)("%s is refused when the holder resumes after the next one ran", async (name, act, verify) => {
		const dir = path.join(root, `late-${name}`);
		await promises.mkdir(dir);
		const key = `/repo/late-${name}`;
		const gate = Promise.withResolvers<void>();
		const old = caught(
			withRepoLock(key, async () => {
				await gate.promise;
				await act(dir);
			}),
		);
		const next = withRepoLock(key, () => promises.writeFile(path.join(dir, "kept.txt"), "next holder\n"));
		await vi.advanceTimersByTimeAsync(REPO_LOCK_HOLD_MS);
		await next;
		gate.resolve();
		expect(await old).toBeInstanceOf(StepStalledError);
		await settle();
		await verify(dir, []);
	});
});

describe("an effect the OS already has when the holder is stopped", () => {
	const inFlight: Array<[string, Op[1], Op[2]]> = [
		[
			"rm",
			dir => fs.rm(path.join(dir, "kept.txt"), { force: true }),
			async dir => expect(await read(dir, "kept.txt")).toBe("next holder\n"),
		],
		[
			"rename",
			dir => fs.rename(path.join(dir, "kept.txt"), path.join(dir, "moved.txt")),
			async dir => {
				expect(await read(dir, "kept.txt")).toBe("next holder\n");
				expect(await read(dir, "moved.txt")).toBe("old\n");
			},
		],
		[
			"writeFile",
			dir => fs.writeFile(path.join(dir, "kept.txt"), "old holder\n"),
			async dir => expect(await read(dir, "kept.txt")).toBe("next holder\n"),
		],
		[
			"copyFile",
			dir => fs.copyFile(path.join(dir, "kept.txt"), path.join(dir, "copy.txt")),
			async dir => expect(await read(dir, "copy.txt")).toBe("old\n"),
		],
		[
			"symlink",
			dir => fs.symlink("kept.txt", path.join(dir, "link")),
			async dir => expect(await read(dir, "link")).toBe("next holder\n"),
		],
	];

	it.each(inFlight)(
		"%s finishes before the next holder starts, and the next holder's file survives",
		async (name, act, verify) => {
			const dir = path.join(root, `flight-${name}`);
			await promises.mkdir(dir);
			await promises.writeFile(path.join(dir, "kept.txt"), "old\n");
			const order: string[] = [];
			// `symlink`'s first argument is the link's target, the others' is the file.
			const held = hold(name as Held, name === "symlink" ? "kept.txt" : path.join(dir, "kept.txt"), order);
			const key = `/repo/flight-${name}`;
			const old = caught(withRepoLock(key, () => act(dir)));
			const next = withRepoLock(key, async () => {
				order.push("next start");
				await promises.rm(path.join(dir, "kept.txt"), { force: true });
				await promises.writeFile(path.join(dir, "kept.txt"), "next holder\n");
			});
			await held.reached;
			await vi.advanceTimersByTimeAsync(REPO_LOCK_HOLD_MS);
			// The caller is told at once; the lock is not free while the call is still out.
			expect(await old).toBeInstanceOf(StepStalledError);
			await settle();
			expect(order).toEqual([]);
			held.release();
			await next;
			await settle();
			expect(order).toEqual([`${name} done`, "next start"]);
			await verify(dir, order);
		},
	);

	it("a call still running a minute after the stop makes every mutation fail busy, naming it, until it ended", async () => {
		const dir = path.join(root, "busy");
		await promises.mkdir(dir);
		await promises.writeFile(path.join(dir, "kept.txt"), "old\n");
		const order: string[] = [];
		const held = hold("rm", path.join(dir, "kept.txt"), order);
		const key = "/repo/busy";
		const old = caught(withRepoLock(key, () => fs.rm(path.join(dir, "kept.txt"), { force: true })));
		const queued = caught(
			withRepoLock(key, async () => {
				order.push("queued start");
				await promises.writeFile(path.join(dir, "kept.txt"), "queued\n");
			}),
		);
		await held.reached;
		await vi.advanceTimersByTimeAsync(REPO_LOCK_HOLD_MS);
		expect(await old).toBeInstanceOf(StepStalledError);
		// Within the bound the next mutation waits for the call; past it, it is refused and creates nothing.
		await vi.advanceTimersByTimeAsync(STALLED_DRAIN_MAX_MS);
		expect(await queued).toMatchObject({
			name: "LocalCommandError",
			code: "repo_busy",
			message: expect.stringContaining("fs.rm"),
		});
		// And a mutation that comes later fails at once, without waiting.
		const later = withRepoLock(key, async () => {
			order.push("later start");
		});
		await expect(later).rejects.toMatchObject({ code: "repo_busy" });
		await settle();
		expect(order).toEqual([]);
		expect(await promises.readFile(path.join(dir, "kept.txt"), "utf8")).toBe("old\n");
		// The moment the call ended the repository is usable again: no restart.
		held.release();
		await held.answered;
		await settle();
		await withRepoLock(key, async () => {
			order.push("after start");
			await promises.writeFile(path.join(dir, "kept.txt"), "after\n");
		});
		expect(order).toEqual(["rm done", "after start"]);
		expect(await promises.readFile(path.join(dir, "kept.txt"), "utf8")).toBe("after\n");
	});

	it("a chain refuses steps naming what still runs, and logs it once, until it ended", async () => {
		const logged: Array<[string, string, string[]]> = [];
		const chain = new SerialChain({
			name: "test",
			maxStepMs: 1_000,
			logBusy: (c, step, pending) => logged.push([c, step, pending]),
			log: () => {},
		});
		const end = Promise.withResolvers<void>();
		const hung = caught(chain.run(() => trackEffect("fs.rm /x", end.promise), "holder"));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(await hung).toBeInstanceOf(StepStalledError);
		await vi.advanceTimersByTimeAsync(STALLED_DRAIN_MAX_MS);
		expect(logged).toEqual([["test", "holder", ["fs.rm /x"]]]);
		const refused = await caught(chain.run(async () => "ran", "next"));
		expect(refused).toBeInstanceOf(ChainBusyError);
		expect((refused as ChainBusyError).pending).toEqual(["fs.rm /x"]);
		end.resolve();
		await settle();
		expect(await chain.run(async () => "ran", "next")).toBe("ran");
	});

	it.skipIf(process.platform === "win32")(
		"a git child that ignores SIGTERM: the next holder starts only after it exited",
		async () => {
			const pidFile = path.join(root, "pid");
			const script = `process.on("SIGTERM", () => {}); require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1e9)`;
			const key = "/repo/sigterm";
			let started = false;
			const old = caught(
				withRepoLock(key, () =>
					execBin(process.execPath, ["-e", script, pidFile], { cwd: root, timeoutMs: 24 * 60 * 60_000 }),
				),
			);
			const next = withRepoLock(key, async () => {
				started = true;
			});
			let pid = 0;
			await vi.waitFor(
				async () => {
					pid = Number(await promises.readFile(pidFile, "utf8"));
					expect(pid).toBeGreaterThan(0);
				},
				{ timeout: 20_000, interval: 20 },
			);
			await vi.advanceTimersByTimeAsync(REPO_LOCK_HOLD_MS);
			expect(await old).toBeInstanceOf(StepStalledError);
			// SIGTERM was sent and ignored: it is still alive, and the lock is still held.
			await settle();
			expect(alive(pid)).toBe(true);
			expect(started).toBe(false);
			// The kill after the grace period ends it; only then the next holder starts.
			await vi.advanceTimersByTimeAsync(2_000);
			await next;
			expect(started).toBe(true);
			expect(alive(pid)).toBe(false);
		},
	);
});

describe("every caller of withRepoLock that touches the disk", () => {
	it(
		"scm discard: a removal already dispatched ends before the next holder starts, and its file survives",
		async () => {
			const file = path.join(root, "repo", "fresh.txt");
			await promises.writeFile(file, "mine\n");
			await scm.stage(repo, ["fresh.txt"]);
			const target = path.join(await promises.realpath(repo), "fresh.txt");
			const order: string[] = [];
			const held = hold("rm", target, order);
			// The key `discard` locks: the checkout root git reports.
			const key = (await repoRoot(repo)) as string;
			const old = caught(scm.discard(repo, ["fresh.txt"]));
			// Queued once the discard holds the lock (it reads the checkout root first).
			await held.reached;
			const next = withRepoLock(key, async () => {
				order.push("next start");
				await promises.writeFile(file, "next holder\n");
			});
			await vi.advanceTimersByTimeAsync(REPO_LOCK_HOLD_MS);
			expect(await old).toBeInstanceOf(Error);
			await settle();
			expect(order).toEqual([]);
			held.release();
			await next;
			await settle();
			expect(order).toEqual(["rm done", "next start"]);
			expect(await promises.readFile(file, "utf8")).toBe("next holder\n");
		},
		SLOW,
	);

	it("saved-worktree record: an update held at its read never writes saved.json under the next holder", async () => {
		const dir = path.join(root, "saved");
		await promises.mkdir(dir);
		const store = new SavedWorktreeStore(dir);
		const key = "/repo/fence-saved";
		const held = hold("readFile", path.join(dir, "saved.json"));
		const old = caught(withRepoLock(key, () => store.update(records => records)));
		const next = withRepoLock(key, async () => {});
		await held.reached;
		await vi.advanceTimersByTimeAsync(REPO_LOCK_HOLD_MS);
		expect(await old).toBeInstanceOf(StepStalledError);
		held.release();
		await next;
		await settle();
		await expect(promises.stat(path.join(dir, "saved.json"))).rejects.toThrow();
	});

	it(
		"worktree create: a late mkdir never goes on to add the branch and the worktree",
		async () => {
			const held = hold("mkdir", wtRoot);
			const key = await primaryRoot(repo);
			const old = caught(createWorktree(repo, { name: "late" }, bridge));
			const next = withRepoLock(key, async () => {});
			await held.reached;
			await vi.advanceTimersByTimeAsync(REPO_LOCK_HOLD_MS);
			held.release();
			await next;
			expect(await old).toBeInstanceOf(Error);
			await settle();
			expect(gitSync(repo, "branch", "--list", "omp/gui/*")).toBe("");
			expect(await promises.readdir(wtRoot)).toEqual([]);
		},
		SLOW,
	);

	it(
		"orphan removal (the save-and-remove and session worktree removals remove through the same git call): a late listing never removes the worktree",
		async () => {
			const dirs = await scene();
			const held = hold("realpath", wtRoot);
			const key = await primaryRoot(repo);
			const old = caught(removeOrphanWorktree(repo, dirs.landed as string, deps));
			const next = withRepoLock(key, async () => {});
			await held.reached;
			await vi.advanceTimersByTimeAsync(REPO_LOCK_HOLD_MS);
			held.release();
			await next;
			expect(await old).toBeInstanceOf(StepStalledError);
			await settle();
			await promises.stat(dirs.landed as string);
			expect(gitSync(repo, "branch", "--list", "omp/gui/landed")).toContain("omp/gui/landed");
		},
		SLOW,
	);
});
