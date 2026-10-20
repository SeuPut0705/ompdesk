/**
 * Disk care: OMPdesk keeps the disk it fills in check by itself, losing nothing. One run, at launch (2 minutes in,
 * unless a run ended within the last 20 hours) and then daily, or when the person presses Clean up / an agent asks:
 *
 * 1. Build output and dependencies of idle worktrees: an orphaned worktree (no open tab on any device) that no one
 *    changed for `DISK_CARE_ARTIFACT_IDLE_DAYS` and no running process works in loses every ignored entry its project
 *    makes again (`regenerable.ts`). This is most of `~/.omp/wt`.
 * 2. Landed worktrees: the Work tree view's rule (`sweepLandedWorktrees`), branch kept, now with the private archive
 *    of what no tool makes again first (git's removal deletes ignored files).
 * 3. Idle worktrees with unlanded work: untouched for `DISK_CARE_REMOVE_IDLE_DAYS`, no process inside, no half-done
 *    rebase or merge, not locked: saved to a branch and the private archive, then the folder goes
 *    (`saveAndRemoveWorktree`); the Work tree view restores it.
 * 4. The app's HTTP cache past `HTTP_CACHE_MAX_BYTES` (update downloads filled it) is cleared through Electron.
 * 5. Bun's install cache past `BUN_CACHE_MAX_BYTES` is cleared with `bun pm cache rm` (Bun has no age option) while no
 *    install runs.
 *
 * Left to stock or alone, by measurement (AGENTS.md › Disk care): omp logs (stock prunes to one per process and day
 * over five days), sessions (never deleted, stock has no compressed form), the stats database (stock has no
 * retention). Where this platform cannot tell which processes work in a folder (Windows), steps 1 and 3 keep
 * everything. Every action is one `disk-care` line in gui-runtime.jsonl.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	DISK_CARE_ARTIFACT_IDLE_DAYS,
	DISK_CARE_REMOVE_IDLE_DAYS,
	type DiskCareActionKind,
	type DiskCareRunSummary,
	type DiskCareState,
	type DiskCareTrigger,
	type DiskUsage,
} from "../../shared/disk-care";
import { IPC_COMMANDS } from "../../shared/ipc-types";
import type { RpcOrphanWorktree } from "../../shared/rpc-types";
import { withRepoLock } from "../local/git/exec";
import type { IpcRegistry } from "../web/ipc-registry";
import { listOrphanWorktrees, type OrphanDeps, orphanRepositories, sweepLandedWorktrees } from "../worktree-orphans";
import { withRemovalClaim } from "../worktree-removals";
import {
	archiveBeforeRemove,
	dropArtifacts,
	KeepWorktree,
	type SavedWorktreeStore,
	saveAndRemoveWorktree,
} from "./saved-worktrees";
import { bunCacheDir, diskBytes, measureDiskUsage } from "./usage";
import {
	inProgressOperation,
	lastActivity,
	processInside,
	processWorkingFolders,
	readWorktreeFiles,
	type WorktreeFiles,
} from "./worktree-facts";

const DAY_MS = 24 * 60 * 60_000;
export const DISK_CARE_FIRST_DELAY_MS = 2 * 60_000;
export const DISK_CARE_INTERVAL_MS = DAY_MS;
/** A launch within this long of the last run's end does not run again; the daily timer comes due instead. */
const LAUNCH_THROTTLE_MS = 20 * 60 * 60_000;
export const HTTP_CACHE_MAX_BYTES = 256 * 1024 * 1024;
export const BUN_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** A Bun or bunx process that reads or writes the install cache. */
const BUN_INSTALLING = /(?:^|\/)(?:bun(?:\.exe)?\s+(?:install|i|add|update|remove|rm|pm|x|create|link)\b|bunx\b)/m;

export interface DiskCareDeps extends OrphanDeps {
	userData: string;
	saved: SavedWorktreeStore;
	clearHttpCache(): Promise<void>;
	/** Absolute path to bun, or null. */
	bunBin(): string | null;
	log(message: string, details: Record<string, unknown>): void;
	broadcast(state: DiskCareState): void;
	/** Runs by itself (a packaged app outside tests); the button and agent work either way. */
	automatic: boolean;
	/**
	 * Worktree steps run. Only where the open tabs this process sees are the app's (the packaged app outside tests,
	 * or a test that owns its worktrees): a dev or test instance would take the real app's worktrees for orphans.
	 */
	worktrees: boolean;
	now?: () => number;
	/** Test seams. */
	processFolders?: () => Promise<string[] | null>;
	processList?: () => Promise<string | null>;
}

function runText(command: string, args: string[]): Promise<string | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	execFile(command, args, { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
		resolve(error ? null : String(stdout)),
	);
	return promise;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

class RunTally {
	readonly actions = new Map<DiskCareActionKind, { count: number; bytes: number }>();
	kept = 0;
	failed = 0;

	add(kind: DiskCareActionKind, bytes: number): void {
		const total = this.actions.get(kind) ?? { count: 0, bytes: 0 };
		total.count++;
		total.bytes += bytes;
		this.actions.set(kind, total);
	}
}

export class DiskCare {
	readonly #deps: DiskCareDeps;
	readonly #now: () => number;
	#timer: NodeJS.Timeout | undefined;
	#running: Promise<DiskCareState> | null = null;
	#stopped = false;
	#usage: DiskUsage | null = null;
	#lastRun: DiskCareRunSummary | null = null;

	constructor(deps: DiskCareDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
	}

	get #stateFile(): string {
		return path.join(this.#deps.userData, "disk-care", "state.json");
	}

	state(): DiskCareState {
		return {
			running: this.#running !== null,
			usage: this.#usage,
			lastRun: this.#lastRun,
			automatic: this.#deps.automatic,
		};
	}

	/** Reads the last run and measurement an earlier launch kept; then the first run, unless one ran lately. */
	async start(): Promise<void> {
		this.#stopped = false;
		const kept = await fs
			.readFile(this.#stateFile, "utf8")
			.then(text => JSON.parse(text) as { usage?: DiskUsage; lastRun?: DiskCareRunSummary })
			.catch(() => ({}) as { usage?: DiskUsage; lastRun?: DiskCareRunSummary });
		this.#usage = kept.usage ?? null;
		this.#lastRun = kept.lastRun ?? null;
		if (!this.#deps.automatic) return;
		const since = this.#lastRun ? this.#now() - this.#lastRun.endedAt : Number.POSITIVE_INFINITY;
		const recent = since < LAUNCH_THROTTLE_MS;
		this.#schedule(
			recent ? Math.max(DISK_CARE_FIRST_DELAY_MS, DISK_CARE_INTERVAL_MS - since) : DISK_CARE_FIRST_DELAY_MS,
			recent ? "daily" : "launch",
		);
	}

	stop(): void {
		this.#stopped = true;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	/** One run now; joins one already going. Resolves with the state once it ended. */
	run(trigger: DiskCareTrigger): Promise<DiskCareState> {
		if (this.#running) return this.#running;
		const running = this.#run(trigger).finally(() => {
			this.#running = null;
			this.#deps.broadcast(this.state());
		});
		this.#running = running;
		this.#deps.broadcast(this.state());
		return running;
	}

	#schedule(ms: number, trigger: DiskCareTrigger): void {
		clearTimeout(this.#timer);
		if (this.#stopped) return;
		this.#timer = setTimeout(() => {
			void this.run(trigger).then(() => this.#schedule(DISK_CARE_INTERVAL_MS, "daily"));
		}, ms);
		this.#timer.unref?.();
	}

	async #run(trigger: DiskCareTrigger): Promise<DiskCareState> {
		const startedAt = this.#now();
		const tally = new RunTally();
		const step = async (name: string, work: () => Promise<void>): Promise<void> => {
			try {
				await work();
			} catch (error) {
				tally.failed++;
				this.#deps.log("failed", { step: name, error: errorText(error) });
			}
		};
		const folders = await (this.#deps.processFolders ?? processWorkingFolders)();
		let worktreeRoot: string | null = null;
		await step("worktrees", async () => {
			const { root, repos } = await orphanRepositories(this.#deps);
			worktreeRoot = root;
			if (!this.#deps.worktrees) return;
			await this.#artifacts(repos, folders, tally);
			await this.#landed(folders, tally);
			await this.#saveIdle(repos, folders, tally);
		});
		await step("http-cache", () => this.#httpCache(tally));
		await step("bun-cache", () => this.#bunCache(tally));
		await step("usage", async () => {
			this.#usage = await measureDiskUsage({
				userData: this.#deps.userData,
				worktreeRoot: worktreeRoot ?? path.join(this.#deps.userData, "no-worktrees"),
			});
		});
		const actions = [...tally.actions].map(([kind, total]) => ({ kind, ...total }));
		this.#lastRun = {
			trigger,
			startedAt,
			endedAt: this.#now(),
			freedBytes: actions.reduce((sum, action) => sum + action.bytes, 0),
			actions,
			kept: tally.kept,
			failed: tally.failed,
		};
		this.#deps.log("run", {
			...this.#lastRun,
			actions: actions.map(a => `${a.kind}:${a.count}:${a.bytes}`).join(" "),
		});
		await fs.mkdir(path.dirname(this.#stateFile), { recursive: true, mode: 0o700 });
		await fs.writeFile(this.#stateFile, `${JSON.stringify({ usage: this.#usage, lastRun: this.#lastRun })}\n`);
		return { ...this.state(), running: false };
	}

	#kept(tally: RunTally, worktree: string, reason: string): void {
		tally.kept++;
		this.#deps.log("kept", { path: worktree, reason });
	}

	/** Days since anyone changed anything in the worktree. */
	async #idleDays(worktree: string, files: WorktreeFiles): Promise<number> {
		return (this.#now() - (await lastActivity(worktree, files))) / DAY_MS;
	}

	async #orphans(repos: readonly string[]): Promise<RpcOrphanWorktree[]> {
		const all: RpcOrphanWorktree[] = [];
		for (const repo of repos)
			all.push(...((await listOrphanWorktrees(repo, this.#deps).catch(() => null))?.worktrees ?? []));
		return all;
	}

	async #artifacts(repos: readonly string[], folders: string[] | null, tally: RunTally): Promise<void> {
		for (const orphan of await this.#orphans(repos)) {
			try {
				const files = await readWorktreeFiles(orphan.path);
				if (![...files.ignored, ...files.untracked].some(entry => entry.regenerable)) continue;
				if ((await this.#idleDays(orphan.path, files)) < DISK_CARE_ARTIFACT_IDLE_DAYS) continue;
				if (processInside(orphan.path, folders)) {
					this.#kept(tally, orphan.path, folders === null ? "process check unavailable" : "a process works in it");
					continue;
				}
				const dropped = await withRemovalClaim(orphan.path, this.#deps.openFolders, async () => {
					// Read again under the claim: what a tab or tool changed since is judged afresh.
					const fresh = await readWorktreeFiles(orphan.path);
					if ((await this.#idleDays(orphan.path, fresh)) < DISK_CARE_ARTIFACT_IDLE_DAYS) return [];
					return dropArtifacts(orphan.path, fresh);
				});
				if (dropped.length === 0) continue;
				const bytes = dropped.reduce((sum, entry) => sum + entry.bytes, 0);
				tally.add("artifacts", bytes);
				this.#deps.log("artifacts", {
					path: orphan.path,
					bytes,
					entries: dropped.map(entry => `${entry.path} (${entry.reason})`).join(", "),
				});
			} catch (error) {
				tally.failed++;
				this.#deps.log("failed", { step: "artifacts", path: orphan.path, error: errorText(error) });
			}
		}
	}

	async #landed(folders: string[] | null, tally: RunTally): Promise<void> {
		const bytesByPath = new Map<string, number>();
		// The landed sweep keeps its shipped rule where processes cannot be told (Windows); git never forces it.
		const prepare = archiveBeforeRemove(this.#deps.saved, folders, bytesByPath);
		const report = await sweepLandedWorktrees(this.#deps, { prepare });
		for (const worktree of report.removed) {
			const bytes = bytesByPath.get(worktree.path) ?? 0;
			tally.add("worktree-landed", bytes);
			this.#deps.log("worktree-landed", { ...worktree, bytes, branchKept: true });
		}
		for (const worktree of report.kept) if (worktree.reason) this.#kept(tally, worktree.path, worktree.reason);
		for (const failure of report.failed) {
			tally.failed++;
			this.#deps.log("failed", { step: "worktree-landed", ...failure });
		}
	}

	async #saveIdle(repos: readonly string[], folders: string[] | null, tally: RunTally): Promise<void> {
		for (const orphan of await this.#orphans(repos)) {
			if (orphan.state !== "unlanded" && orphan.state !== "dirty") continue;
			try {
				const files = await readWorktreeFiles(orphan.path);
				if ((await this.#idleDays(orphan.path, files)) < DISK_CARE_REMOVE_IDLE_DAYS) continue;
				if (processInside(orphan.path, folders)) {
					this.#kept(tally, orphan.path, folders === null ? "process check unavailable" : "a process works in it");
					continue;
				}
				const operation = await inProgressOperation(orphan.path);
				if (operation) {
					this.#kept(tally, orphan.path, `a git operation is half done (${operation})`);
					continue;
				}
				const bytes = await diskBytes(orphan.path);
				const record = await withRepoLock(orphan.repo, () =>
					withRemovalClaim(orphan.path, this.#deps.openFolders, async () => {
						const fresh = await readWorktreeFiles(orphan.path);
						if ((await this.#idleDays(orphan.path, fresh)) < DISK_CARE_REMOVE_IDLE_DAYS)
							throw new KeepWorktree("it changed since it was judged idle");
						const stillSame = async (): Promise<boolean> =>
							(await readWorktreeFiles(orphan.path)).fingerprint === fresh.fingerprint &&
							(await inProgressOperation(orphan.path)) === null &&
							!processInside(orphan.path, await (this.#deps.processFolders ?? processWorkingFolders)());
						return saveAndRemoveWorktree(
							{
								path: orphan.path,
								primary: orphan.repo,
								branch: orphan.branch,
								unlanded: orphan.commitsAhead > 0 || orphan.state === "unlanded",
							},
							fresh,
							this.#deps.saved,
							stillSame,
						);
					}),
				);
				tally.add("worktree-saved", bytes);
				this.#deps.log("worktree-saved", {
					path: record.path,
					branch: record.branch,
					savedBranch: record.savedBranch,
					head: record.head,
					archivedFiles: record.archivedFiles,
					bytes,
					restore: `git worktree add ${record.path} ${record.savedBranch ?? record.branch ?? record.head}`,
				});
			} catch (error) {
				if (error instanceof KeepWorktree) this.#kept(tally, orphan.path, error.message);
				else {
					tally.failed++;
					this.#deps.log("failed", { step: "worktree-saved", path: orphan.path, error: errorText(error) });
				}
			}
		}
	}

	async #httpCache(tally: RunTally): Promise<void> {
		const bytes = await diskBytes(path.join(this.#deps.userData, "Cache"));
		if (bytes <= HTTP_CACHE_MAX_BYTES) return;
		await this.#deps.clearHttpCache();
		tally.add("http-cache", bytes);
		this.#deps.log("http-cache", { bytes });
	}

	async #bunCache(tally: RunTally): Promise<void> {
		const dir = bunCacheDir();
		const bytes = await diskBytes(dir);
		if (bytes <= BUN_CACHE_MAX_BYTES) return;
		const bun = this.#deps.bunBin();
		if (!bun) return;
		// Windows lists no process arguments, so an install cannot be told apart: the cache stays there.
		const processes =
			process.platform === "win32"
				? null
				: await (this.#deps.processList ?? (() => runText("ps", ["-axo", "command="])))();
		if (processes === null || BUN_INSTALLING.test(processes)) {
			this.#deps.log("kept", {
				path: dir,
				reason: processes === null ? "process check unavailable" : "an install runs",
			});
			return;
		}
		if ((await runText(bun, ["pm", "cache", "rm"])) === null) throw new Error("bun pm cache rm failed");
		tally.add("bun-cache", bytes);
		this.#deps.log("bun-cache", { bytes });
	}
}

/** IPC for the renderer: the state and a run now. No handler takes a path. */
export function registerDiskCareIpc(ipc: IpcRegistry, care: Pick<DiskCare, "state" | "run">): void {
	ipc.handle(IPC_COMMANDS.DISK_CARE_GET_STATE, () => care.state());
	ipc.handle(IPC_COMMANDS.DISK_CARE_RUN, () => care.run("user"));
}
