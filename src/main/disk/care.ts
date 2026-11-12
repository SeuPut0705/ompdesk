/**
 * Disk care: OMPdesk keeps the disk it fills in check by itself, losing nothing. One run, at launch (2 minutes in,
 * unless a run ended within the last 20 hours) and then daily, or when the person presses Clean up / an agent asks:
 *
 * 1. Build output and dependencies of idle worktrees: an orphaned worktree (no open tab on any device) that no one
 *    changed for `DISK_CARE_ARTIFACT_IDLE_DAYS` and no running process works in loses every ignored entry its project
 *    makes again (the core's rule table, `crates/core/src/disk/regenerable.rs`). This is most of `~/.omp/wt`.
 * 2. Landed worktrees: the Work tree view's rule (`sweepLandedWorktrees`), branch kept, now with the private archive
 *    of what no tool makes again first (git's removal deletes ignored files).
 * 3. Idle worktrees with unlanded work: untouched for `DISK_CARE_REMOVE_IDLE_DAYS`, no process inside, no half-done
 *    rebase or merge, not locked: saved to a branch and the private archive, then the folder goes
 *    (`saveAndRemoveWorktree`); the Work tree view restores it.
 * 4. The app's HTTP cache past `HTTP_CACHE_MAX_BYTES` (update downloads filled it) is cleared through Electron.
 * 5. The tools' caches (`caches.ts`, one table: Bun's install cache, Bun's runtime transpiler cache, npm's cache), each
 *    cleared past its own bound while no process that needs it runs.
 *
 * Left to stock or alone, by measurement (AGENTS.md › Disk care): omp logs (stock prunes to one per process and day
 * over five days), sessions (never deleted, stock has no compressed form), the stats database (stock has no
 * retention). Where this platform cannot tell which processes work in a folder (Windows), steps 1 and 3 keep
 * everything. Every action is one `disk-care` line in gui-runtime.jsonl.
 */
import * as path from "node:path";
import { promises as fs } from "original-fs";
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
import {
	listAllOrphans,
	type OrphanDeps,
	type OrphanListing,
	orphanRepositories,
	orphanWorktreePaths,
	sweepLandedWorktrees,
} from "../worktree-orphans";
import { withRemovalClaim } from "../worktree-removals";
import { type CacheTools, type LocatedCache, locateCaches, REGENERABLE_CACHES, type RegenerableCache } from "./caches";
import {
	archiveBeforeRemove,
	dropArtifacts,
	KeepWorktree,
	type SavedWorktreeStore,
	saveAndRemoveWorktree,
} from "./saved-worktrees";
import { TreeSizes } from "./tree-sizes";
import { diskBytes, measureDiskUsage } from "./usage";
import {
	inProgressOperation,
	lastActivity,
	processInside,
	processWorkingFolders,
	readWorktreeFiles,
	type WorktreeFiles,
	worktreeHead,
} from "./worktree-facts";

const DAY_MS = 24 * 60 * 60_000;
export const DISK_CARE_FIRST_DELAY_MS = 2 * 60_000;
export const DISK_CARE_INTERVAL_MS = DAY_MS;
/** A launch within this long of the last run's end does not run again; the daily timer comes due instead. */
const LAUNCH_THROTTLE_MS = 20 * 60 * 60_000;
export const HTTP_CACHE_MAX_BYTES = 256 * 1024 * 1024;

export interface DiskCareDeps extends OrphanDeps {
	userData: string;
	saved: SavedWorktreeStore;
	clearHttpCache(): Promise<void>;
	/** How the cache step finds, asks and runs the tools whose caches it bounds. */
	cacheTools: CacheTools;
	/** The caches bounded (default `REGENERABLE_CACHES`; a test lowers the bounds). */
	caches?: readonly RegenerableCache[];
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
}

/** What the artifacts step read of a worktree before any claim. */
interface PreRead {
	files: WorktreeFiles;
	/** Days idle, when read and nothing was dropped since. */
	idleDays?: number;
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
			// The next run is due whatever became of this one.
			const next = () => this.#schedule(DISK_CARE_INTERVAL_MS, "daily");
			this.run(trigger).then(next, next);
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
			const preRead = await this.#artifacts(repos, folders, tally);
			// One reading of every orphan's state for both steps after the artifacts went (dropping them can leave a
			// worktree clean): it only picks candidates, each removal reads its worktree again under its locks.
			const listed = await listAllOrphans(this.#deps, { root, repos });
			const removed = await this.#landed(listed, folders, tally);
			const left = listed.repos.flatMap(entry => entry.worktrees).filter(orphan => !removed.has(orphan.path));
			await this.#saveIdle(left, preRead, folders, tally);
		});
		// One reading of the measured folders per run, kept for the next: what did not change is not read again.
		const sizes = new TreeSizes(path.join(this.#deps.userData, "disk-care", "sizes.json"), this.#now);
		await sizes.load();
		await step("http-cache", () => this.#httpCache(sizes, tally));
		let caches: LocatedCache[] = [];
		await step("caches", async () => {
			caches = await locateCaches(this.#deps.caches ?? REGENERABLE_CACHES, this.#deps.cacheTools);
			await this.#caches(caches, sizes, tally);
		});
		await step("usage", async () => {
			const started = performance.now();
			this.#usage = await measureDiskUsage(
				{
					userData: this.#deps.userData,
					worktreeRoot: worktreeRoot ?? path.join(this.#deps.userData, "no-worktrees"),
					caches,
				},
				sizes,
			);
			await sizes.save();
			this.#deps.log("usage", {
				ms: Math.round(performance.now() - started),
				reused: sizes.reused,
				lstat: sizes.work.lstat,
				readdir: sizes.work.readdir,
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

	/** A worktree or a cache that would have gone stays: counted in the run's summary, its reason in the log. */
	#kept(tally: RunTally, target: string, reason: string): void {
		tally.kept++;
		this.#deps.log("kept", { path: target, reason });
	}

	/** Days since anyone changed anything in the worktree. */
	async #idleDays(worktree: string, files: WorktreeFiles): Promise<number> {
		return (this.#now() - (await lastActivity(worktree, files))) / DAY_MS;
	}

	/**
	 * Drops idle orphans' regenerable output. Returns what it read of each worktree before any claim, for the save step's
	 * pre-filter: the files, and the idle days when nothing was dropped (a drop writes the worktree's folder).
	 */
	async #artifacts(
		repos: readonly string[],
		folders: string[] | null,
		tally: RunTally,
	): Promise<Map<string, PreRead>> {
		const preRead = new Map<string, PreRead>();
		const paths: string[] = [];
		for (const repo of repos) paths.push(...((await orphanWorktreePaths(repo, this.#deps).catch(() => null)) ?? []));
		for (const worktree of paths) {
			// A worktree git cannot read (a broken checkout) is left alone, as the orphan listing leaves it out.
			const files = await readWorktreeFiles(worktree).catch(() => null);
			if (!files) continue;
			const read: PreRead = { files };
			preRead.set(worktree, read);
			try {
				if (![...files.ignored, ...files.untracked].some(entry => entry.regenerable)) continue;
				read.idleDays = await this.#idleDays(worktree, files);
				if (read.idleDays < DISK_CARE_ARTIFACT_IDLE_DAYS) continue;
				if (processInside(worktree, folders)) {
					this.#kept(tally, worktree, folders === null ? "process check unavailable" : "a process works in it");
					continue;
				}
				const dropped = await withRemovalClaim(worktree, this.#deps.openFolders, async () => {
					// Read again under the claim: what a tab or tool changed since is judged afresh.
					const operation = await inProgressOperation(worktree);
					if (operation) throw new KeepWorktree(`a git operation is half done (${operation})`);
					const fresh = await readWorktreeFiles(worktree);
					if ((await this.#idleDays(worktree, fresh)) < DISK_CARE_ARTIFACT_IDLE_DAYS) return [];
					return dropArtifacts(worktree, fresh);
				});
				if (dropped.length === 0) continue;
				read.idleDays = undefined;
				const bytes = dropped.reduce((sum, entry) => sum + entry.bytes, 0);
				tally.add("artifacts", bytes);
				this.#deps.log("artifacts", {
					path: worktree,
					bytes,
					entries: dropped.map(entry => `${entry.path} (${entry.reason})`).join(", "),
				});
			} catch (error) {
				read.idleDays = undefined;
				if (error instanceof KeepWorktree) {
					this.#kept(tally, worktree, error.message);
					continue;
				}
				tally.failed++;
				this.#deps.log("failed", { step: "artifacts", path: worktree, error: errorText(error) });
			}
		}
		return preRead;
	}

	/** The landed sweep over `listed`; returns the paths it removed. */
	async #landed(listed: OrphanListing, folders: string[] | null, tally: RunTally): Promise<Set<string>> {
		const bytesByPath = new Map<string, number>();
		// The landed sweep keeps its shipped rule where processes cannot be told (Windows); git never forces it.
		const prepare = archiveBeforeRemove(this.#deps.saved, folders, bytesByPath);
		const report = await sweepLandedWorktrees(this.#deps, { prepare, listed });
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
		return new Set(report.removed.map(worktree => worktree.path));
	}

	async #saveIdle(
		orphans: readonly RpcOrphanWorktree[],
		preRead: ReadonlyMap<string, PreRead>,
		folders: string[] | null,
		tally: RunTally,
	): Promise<void> {
		for (const orphan of orphans) {
			if (orphan.state !== "unlanded" && orphan.state !== "dirty") continue;
			try {
				// A pre-filter only: the claimed read below judges again.
				const read = preRead.get(orphan.path);
				const idleDays =
					read?.idleDays ??
					(await this.#idleDays(orphan.path, read?.files ?? (await readWorktreeFiles(orphan.path))));
				if (idleDays < DISK_CARE_REMOVE_IDLE_DAYS) continue;
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
						const stamp = await lastActivity(orphan.path, fresh);
						if ((this.#now() - stamp) / DAY_MS < DISK_CARE_REMOVE_IDLE_DAYS)
							throw new KeepWorktree("it changed since it was judged idle");
						const head = await worktreeHead(orphan.path);
						// Right before the folder goes: the same status, HEAD and operation state, no process inside, and
						// no file (tracked, untracked or an archived ignored one), index, reflog or session written since
						// the save read it. The status alone misses a second edit of an already modified file.
						// The slow process read first, the file stamps last, closest to the removal.
						const stillSame = async (): Promise<boolean> => {
							if (processInside(orphan.path, await (this.#deps.processFolders ?? processWorkingFolders)()))
								return false;
							if ((await inProgressOperation(orphan.path)) !== null) return false;
							if ((await worktreeHead(orphan.path)) !== head) return false;
							const now = await readWorktreeFiles(orphan.path);
							return now.fingerprint === fresh.fingerprint && (await lastActivity(orphan.path, now)) <= stamp;
						};
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

	async #httpCache(sizes: TreeSizes, tally: RunTally): Promise<void> {
		// Chromium rewrites its cache index in place: read in full (it is inside userData, which is too).
		const bytes = await sizes.bytes(path.join(this.#deps.userData, "Cache"), { reuse: false });
		if (bytes <= HTTP_CACHE_MAX_BYTES) return;
		await this.#deps.clearHttpCache();
		tally.add("http-cache", bytes);
		this.#deps.log("http-cache", { bytes });
	}

	/** Each cache past its bound is cleared, unless a process that needs it runs; one that fails stops no other. */
	async #caches(caches: readonly LocatedCache[], sizes: TreeSizes, tally: RunTally): Promise<void> {
		// Listed once, and only when a cache past its bound asks.
		let listed: Promise<string | null> | undefined;
		for (const { cache, dir } of caches) {
			try {
				const bytes = await sizes.bytes(dir);
				if (bytes <= cache.maxBytes) continue;
				if (cache.inUse) listed ??= this.#deps.cacheTools.processes();
				const reason =
					(cache.inUse && listed ? cache.inUse(await listed) : null) ??
					(await cache.clear(dir, this.#deps.cacheTools));
				if (reason !== null) {
					this.#kept(tally, dir, reason);
					continue;
				}
				// What a running process held open stayed: the bytes that went, not the bytes there were.
				const freed = Math.max(0, bytes - (await diskBytes(dir)));
				tally.add(cache.action, freed);
				this.#deps.log(cache.action, { path: dir, bytes: freed });
			} catch (error) {
				tally.failed++;
				this.#deps.log("failed", { step: cache.action, path: dir, error: errorText(error) });
			}
		}
	}
}

/** IPC for the renderer: the state and a run now. No handler takes a path. */
export function registerDiskCareIpc(ipc: IpcRegistry, care: Pick<DiskCare, "state" | "run">): void {
	ipc.handle(IPC_COMMANDS.DISK_CARE_GET_STATE, () => care.state());
	ipc.handle(IPC_COMMANDS.DISK_CARE_RUN, () => care.run("user"));
}
