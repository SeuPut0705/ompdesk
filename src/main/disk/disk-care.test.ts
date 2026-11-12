import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreError, CoreProcess } from "../core/process";
import { gitSync } from "../local/git/test-repos";
import { DISK_CARE_FIRST_DELAY_MS, DISK_CARE_INTERVAL_MS } from "./care";
import { DAY_MS, diskCareWorld, exists, SLOW, write } from "./disk-care-fixture";
import { listSavedWorktrees, restoreSavedWorktree } from "./saved-worktrees";
import { TreeSizes } from "./tree-sizes";

const w = diskCareWorld();

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** A core that cannot answer `methods` (it died, rests after failed starts, or ran out of time); others pass. */
function coreRefuses(...methods: string[]): void {
	const real = CoreProcess.prototype.call;
	vi.spyOn(CoreProcess.prototype, "call").mockImplementation(function (this: CoreProcess, method, ...rest) {
		if (methods.includes(method))
			return Promise.reject(new CoreError("core_unavailable", "ompdesk-core could not run"));
		return real.call(this, method, ...rest);
	});
}

describe("disk care", () => {
	it(
		"measures the disk again from the last run's reading, with the same parts a full walk finds",
		async () => {
			await w.busyWorktree("measured");
			await write(
				path.join(w.root, "home", ".bun", "install", "cache", "pkg@1.0.0"),
				"index.js",
				"x".repeat(50_000),
			);
			const first = await w.care().run("user");
			await write(
				path.join(w.root, "home", ".bun", "install", "cache", "pkg@2.0.0"),
				"index.js",
				"y".repeat(80_000),
			);
			const second = await w.care().run("user");
			const usageLines = w.logs.filter(([message]) => message === "usage").map(([, details]) => details.reused);
			expect(usageLines).toEqual([false, true]);
			for (const id of ["worktrees", "bunCache"] as const) {
				const part = second.usage?.parts.find(entry => entry.id === id);
				expect(part?.bytes, id).toBe(await new TreeSizes(null).bytes(part?.path ?? ""));
			}
			const bun = (state: typeof first) => state.usage?.parts.find(entry => entry.id === "bunCache")?.bytes ?? 0;
			expect(bun(second)).toBeGreaterThan(bun(first) + 70_000);
		},
		SLOW,
	);

	it(
		"saves an idle unlanded worktree to a branch and a private archive, removes it, and restores it whole",
		async () => {
			const dir = await w.busyWorktree("idle");
			const tip = gitSync(w.repo, "rev-parse", "omp/agent/idle");
			await w.care().run("user");

			expect(await exists(dir)).toBe(false);
			expect(w.listed()).not.toContain(dir);
			// The worktree's own branch is untouched; the uncommitted work sits on a new saved branch.
			expect(gitSync(w.repo, "rev-parse", "omp/agent/idle")).toBe(tip);
			const [record] = await listSavedWorktrees(w.repo, w.saved);
			expect(record?.savedBranch).toMatch(/^ompdesk\/saved\//);
			const savedFiles = gitSync(w.repo, "show", "--name-only", "--format=", record?.savedBranch ?? "");
			expect(savedFiles.split("\n").sort()).toEqual(["README.md", "notes/todo.md"]);
			// Secrets never entered git, not even the saved branch: neither the ignored `.env` nor the untracked one.
			expect(gitSync(w.repo, "log", "--all", "--format=%H", "--", ".env", "config/.env.local")).toBe("");
			const archive = path.join(w.userData, "disk-care", "saved", record?.id ?? "");
			if (process.platform !== "win32") {
				expect((await fs.stat(archive)).mode & 0o777).toBe(0o700);
				expect((await fs.stat(path.join(archive, "files", ".env"))).mode & 0o777).toBe(0o600);
			}
			expect(w.logs.find(([message]) => message === "worktree-saved")?.[1].restore).toContain("git worktree add");

			const restored = await restoreSavedWorktree(record?.id ?? "", w.saved);
			expect(restored).toMatchObject({ path: dir, branch: "omp/agent/idle" });
			expect(await fs.readFile(path.join(dir, "README.md"), "utf8")).toBe("hello, edited\n");
			expect(await fs.readFile(path.join(dir, "notes/todo.md"), "utf8")).toBe("next: tests\n");
			expect(await fs.readFile(path.join(dir, ".env"), "utf8")).toBe("API_KEY=edited-in-worktree\n");
			expect(await fs.readFile(path.join(dir, "dist/handmade.html"), "utf8")).toBe("<p>my page</p>\n");
			expect(await fs.readFile(path.join(dir, "feature.ts"), "utf8")).toBe("export const done = 1;\n");
			expect(await fs.readFile(path.join(dir, "config/.env.local"), "utf8")).toContain("sk-live-");
			// Uncommitted again, as it was: changed in the working tree, nothing staged.
			expect(gitSync(dir, "diff", "--name-only")).toBe("README.md");
			expect(gitSync(dir, "diff", "--cached", "--name-only")).toBe("");
			expect(await listSavedWorktrees(w.repo, w.saved)).toEqual([]);
		},
		SLOW,
	);

	it(
		"keeps an idle worktree an open tab, a running process, a lock or a half-done merge holds",
		async () => {
			const tab = await w.busyWorktree("tab");
			const proc = await w.busyWorktree("proc");
			const locked = await w.busyWorktree("locked");
			gitSync(w.repo, "worktree", "lock", locked);
			const merging = await w.busyWorktree("merging");
			await fs.writeFile(path.join(merging, "README.md"), "hello\n");
			gitSync(merging, "checkout", "-q", "--", "README.md");
			const gitDir = gitSync(merging, "rev-parse", "--absolute-git-dir");
			await fs.writeFile(path.join(gitDir, "MERGE_HEAD"), `${gitSync(w.repo, "rev-parse", "main")}\n`);
			w.open = [path.join(tab, "src")];
			w.processes = [path.join(proc, "notes")];

			await w.care().run("user");
			for (const dir of [tab, proc, locked, merging]) expect(w.listed(), dir).toContain(dir);
			expect(await fs.readFile(path.join(proc, ".env"), "utf8")).toBe("API_KEY=edited-in-worktree\n");
			// The process and the half-done merge are named in the log.
			const kept = w.logs.filter(([message]) => message === "kept").map(([, details]) => details.reason);
			expect(kept).toContain("a process works in it");
			expect(kept.some(reason => String(reason).includes("MERGE_HEAD"))).toBe(true);
			expect(await listSavedWorktrees(w.repo, w.saved)).toEqual([]);
		},
		SLOW,
	);

	it(
		"keeps everything where running processes cannot be told",
		async () => {
			const dir = await w.busyWorktree("unknown");
			w.processes = null;
			await w.care().run("user");
			expect(w.listed()).toContain(dir);
			expect(await exists(path.join(dir, "node_modules"))).toBe(true);
		},
		SLOW,
	);

	it(
		"archives a landed worktree's edited .env before removing it, so it can come back",
		async () => {
			const dir = await w.worktree("landed");
			await write(dir, "landed.ts", "x\n");
			gitSync(dir, "add", "landed.ts");
			gitSync(dir, "commit", "-q", "-m", "landed");
			gitSync(w.repo, "merge", "--ff-only", "-q", "omp/agent/landed");
			await write(dir, ".env", "TOKEN=only-here\n");
			// Not idle: the landed rule does not wait.
			await w.care(Date.now()).run("user");
			expect(await exists(dir)).toBe(false);
			const [record] = await listSavedWorktrees(w.repo, w.saved);
			expect(record).toMatchObject({ path: dir, savedBranch: null, archivedFiles: 1 });
			await restoreSavedWorktree(record?.id ?? "", w.saved);
			expect(await fs.readFile(path.join(dir, ".env"), "utf8")).toBe("TOKEN=only-here\n");
		},
		SLOW,
	);

	it(
		"leaves a worktree with a half-done merge or rebase whole: its build output stays, landed or not",
		async () => {
			const merging = await w.busyWorktree("merge-artifacts");
			const mergeDir = gitSync(merging, "rev-parse", "--absolute-git-dir");
			await fs.writeFile(path.join(mergeDir, "MERGE_HEAD"), `${gitSync(w.repo, "rev-parse", "main")}\n`);
			const rebasing = await w.worktree("landed-rebase");
			await write(rebasing, "landed.ts", "x\n");
			gitSync(rebasing, "add", "landed.ts");
			gitSync(rebasing, "commit", "-q", "-m", "landed");
			gitSync(w.repo, "merge", "--ff-only", "-q", "omp/agent/landed-rebase");
			await write(rebasing, "node_modules/left-pad/index.js", "module.exports = 1;\n");
			await fs.mkdir(path.join(gitSync(rebasing, "rev-parse", "--absolute-git-dir"), "rebase-merge"));

			await w.care(Date.now() + 5 * DAY_MS).run("user");
			expect(await exists(path.join(merging, "node_modules/left-pad/index.js"))).toBe(true);
			expect(await exists(path.join(merging, "out/main/index.js"))).toBe(true);
			expect(w.listed()).toContain(rebasing);
			expect(await exists(path.join(rebasing, "node_modules/left-pad/index.js"))).toBe(true);
			const kept = w.logs.filter(([message]) => message === "kept").map(([, details]) => String(details.reason));
			expect(kept.filter(reason => reason.includes("MERGE_HEAD")).length).toBeGreaterThan(0);
			expect(kept.filter(reason => reason.includes("rebase-merge")).length).toBeGreaterThan(0);
		},
		SLOW,
	);

	it(
		"keeps every worktree and still records the run when the core cannot list the running processes",
		async () => {
			const dir = await w.busyWorktree("no-process-list");
			coreRefuses("disk.processFolders");
			const state = await w.care(undefined, { processFolders: undefined }).run("user");
			expect(state.lastRun?.trigger).toBe("user");
			expect(w.logs.some(([message]) => message === "run")).toBe(true);
			expect(await exists(path.join(w.userData, "disk-care", "state.json"))).toBe(true);
			expect(w.listed()).toContain(dir);
			expect(await exists(path.join(dir, "node_modules"))).toBe(true);
			const kept = w.logs.filter(([message]) => message === "kept").map(([, details]) => details.reason);
			expect(kept).toContain("process check unavailable");
		},
		SLOW,
	);

	it(
		"measures by full walks and records the run when the core cannot open the kept measurement",
		async () => {
			coreRefuses("disk.sizesOpen");
			const state = await w.care().run("user");
			expect(state.usage?.parts.length).toBeGreaterThan(0);
			expect(w.logs.filter(([message]) => message === "usage").map(([, details]) => details.reused)).toEqual([
				false,
			]);
			expect(w.logs.some(([message]) => message === "run")).toBe(true);
			expect(await exists(path.join(w.userData, "disk-care", "state.json"))).toBe(true);
		},
		SLOW,
	);

	it("comes due again the next day after a run that failed", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const care = w.care(undefined, { automatic: true });
		const run = vi
			.spyOn(care, "run")
			.mockRejectedValueOnce(new CoreError("timeout", "ompdesk-core did not answer in time"))
			.mockResolvedValue(care.state());
		await care.start();
		await vi.advanceTimersByTimeAsync(DISK_CARE_FIRST_DELAY_MS);
		expect(run).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(DISK_CARE_INTERVAL_MS);
		expect(run).toHaveBeenCalledTimes(2);
		care.stop();
	});
});
