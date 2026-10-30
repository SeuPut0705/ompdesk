/**
 * What a repository-lock holder that ran past its bound still does when a held filesystem answer arrives late: the
 * next holder has taken the lock and changed the same paths, and the old one's destructive effect (rm, rename, write,
 * link, copy, mkdir, the saved-worktree record) must not land on them. Each case holds one fs call of the old holder
 * with a deferred promise, runs the bound out on the fake clock, lets the next holder act, then releases the answer.
 * No wall-clock waits: only the lock's own timer is faked, everything else is the real fs and git.
 */
import { promises } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SavedWorktreeStore } from "./disk/saved-worktrees";
import { fs } from "./fenced-fs";
import { primaryRoot } from "./local/git/changes";
import { REPO_LOCK_HOLD_MS, withRepoLock } from "./local/git/exec";
import { gitSync } from "./local/git/test-repos";
import { createWorktree } from "./local/git/worktree";
import { StepStalledError } from "./serial-chain";
import { removeOrphanWorktree } from "./worktree-orphans";
import { bridge, deps, installOrphansRig, repo, root, SLOW, scene, wtRoot } from "./worktree-orphans-test-rig";

installOrphansRig();

type Held = "realpath" | "mkdir";

interface HeldCall {
	reached: Promise<void>;
	answered: Promise<void>;
	release: () => void;
}

/** Holds the first call of `method` whose first argument is `target` until `release()`; the answer is the real one. */
function hold(method: Held, target: string): HeldCall {
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
		answered.resolve();
		return answer;
	}) as never);
	return { reached: reached.promise, answered: answered.promise, release: () => released.resolve() };
}

/** The old holder's continuation after the answer: real fs round trips, enough for any effect it started to land. */
async function settle(): Promise<void> {
	for (let round = 0; round < 25; round++) await promises.stat(os.tmpdir());
}

/** Bound run out while `held` is pending, `next` runs as the next holder, then the held answer arrives. */
async function outlive(key: string, held: HeldCall, next: () => Promise<unknown>): Promise<void> {
	await held.reached;
	await vi.advanceTimersByTimeAsync(REPO_LOCK_HOLD_MS);
	await withRepoLock(key, next);
	held.release();
	await held.answered;
	await settle();
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("the fenced fs of a stopped repository-lock holder", () => {
	const effects: Array<[string, (dir: string) => Promise<unknown>, (dir: string) => Promise<void>]> = [
		[
			"rm",
			dir => fs.rm(path.join(dir, "kept.txt"), { force: true, recursive: true }),
			async dir => expect(await promises.readFile(path.join(dir, "kept.txt"), "utf8")).toBe("next holder\n"),
		],
		[
			"rename",
			dir => fs.rename(path.join(dir, "kept.txt"), path.join(dir, "moved.txt")),
			async dir => {
				expect(await promises.readFile(path.join(dir, "kept.txt"), "utf8")).toBe("next holder\n");
				await expect(promises.stat(path.join(dir, "moved.txt"))).rejects.toThrow();
			},
		],
		[
			"writeFile",
			dir => fs.writeFile(path.join(dir, "kept.txt"), "old holder\n"),
			async dir => expect(await promises.readFile(path.join(dir, "kept.txt"), "utf8")).toBe("next holder\n"),
		],
		[
			"copyFile",
			dir => fs.copyFile(path.join(dir, "kept.txt"), path.join(dir, "copy.txt")),
			async dir => await expect(promises.stat(path.join(dir, "copy.txt"))).rejects.toThrow(),
		],
		[
			"symlink",
			dir => fs.symlink(path.join(dir, "kept.txt"), path.join(dir, "link")),
			async dir => await expect(promises.lstat(path.join(dir, "link"))).rejects.toThrow(),
		],
		[
			"mkdir",
			dir => fs.mkdir(path.join(dir, "made", "deep"), { recursive: true }),
			async dir => await expect(promises.stat(path.join(dir, "made"))).rejects.toThrow(),
		],
	];

	it.each(effects)("%s of a holder whose realpath resolved late never lands", async (name, act, verify) => {
		const dir = path.join(root, `effect-${name}`);
		await promises.mkdir(dir);
		const key = `/repo/fence-${name}`;
		const held = hold("realpath", dir);
		const old = withRepoLock(key, async () => {
			await fs.realpath(dir);
			await act(dir);
		}).then(
			() => null,
			error => error,
		);
		await outlive(key, held, () => promises.writeFile(path.join(dir, "kept.txt"), "next holder\n"));
		expect(await old).toBeInstanceOf(StepStalledError);
		await verify(dir);
	});
});

describe("every caller of withRepoLock that touches the disk", () => {
	it("saved-worktree record: a late update never writes saved.json under the next holder", async () => {
		const dir = path.join(root, "saved");
		const store = new SavedWorktreeStore(dir);
		const key = "/repo/fence-saved";
		const held = hold("realpath", root);
		const old = withRepoLock(key, async () => {
			await fs.realpath(root);
			await store.update(records => records);
		}).then(
			() => null,
			error => error,
		);
		await outlive(key, held, async () => {});
		expect(await old).toBeInstanceOf(StepStalledError);
		await expect(promises.stat(path.join(dir, "saved.json"))).rejects.toThrow();
		await expect(promises.stat(dir)).rejects.toThrow();
	});

	it(
		"worktree create: a late mkdir never goes on to add the branch and the worktree",
		async () => {
			const held = hold("mkdir", wtRoot);
			const old = createWorktree(repo, { name: "late" }, bridge).then(
				() => null,
				error => error,
			);
			await outlive(await primaryRoot(repo), held, async () => {});
			expect(await old).toBeInstanceOf(Error);
			expect(gitSync(repo, "branch", "--list", "omp/gui/*")).toBe("");
			expect(await promises.readdir(wtRoot)).toEqual([]);
		},
		SLOW,
	);

	it(
		"orphan removal (and so disk care's save-and-remove and the session worktree removals, which remove through the same git call): a late listing never removes the worktree",
		async () => {
			const dirs = await scene();
			const held = hold("realpath", wtRoot);
			const old = removeOrphanWorktree(repo, dirs.landed as string, deps).then(
				() => null,
				error => error,
			);
			await outlive(await primaryRoot(repo), held, async () => {});
			expect(await old).toBeInstanceOf(StepStalledError);
			await promises.stat(dirs.landed as string);
			expect(gitSync(repo, "branch", "--list", "omp/gui/landed")).toContain("omp/gui/landed");
		},
		SLOW,
	);
});
