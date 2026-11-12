/**
 * Worktrees disk care takes off the disk, losing nothing, and puts back on request.
 *
 * - `dropArtifacts`: the ignored (or untracked) output the project's own tools make again goes; everything else stays.
 * - `saveAndRemoveWorktree`: an idle worktree with work nothing else holds is saved first: tracked changes and
 *   untracked files as one commit on a new `ompdesk/saved/…` branch (never on the worktree's own branch, never on
 *   main; secrets never enter it), and every file git does not keep and no tool makes again (a seeded `.env`
 *   someone edited, a local database, a secret) in a private archive under userData (0700 folders, 0600 files; never
 *   in git, never synced, never uploaded). Only after both are verified and the worktree is unchanged does
 *   `git worktree remove --force` take the folder; the worktree's own branch stays.
 * - `archiveIgnoredData`: the archive alone, before a landed worktree is removed (`git worktree remove` deletes
 *   ignored files without asking).
 * - `restoreSavedWorktree`: `git worktree add` at the old path, the saved changes back in the working tree (not
 *   committed), the repository's own seeding and setup hook, then the archive copied back.
 *
 * Each step's disk work and gits are one request to the core process (`native/ompdesk/crates/core/src/disk/saved.rs`),
 * held to the repository-lock step it is made in (`coreGit`, `coreHeld`). What stays here is main's: the saved records
 * (`SavedWorktreeStore`), the secret check (the central redactor, `worktree-facts.ts`), whether nothing moved while a
 * save ran (the caller's `stillSame`), the seeding between a restore's checkout and its files, and the order.
 */

import { randomBytes } from "node:crypto";
import * as path from "node:path";
import type { SavedWorktree, SavedWorktreeRestore } from "../../shared/disk-care";
import { discardNewWorktree, type WorktreeRef, type WorktreeRemoval } from "../agent-control/branches";
import { writeFileAtomic } from "../atomic-file";
import { CoreError } from "../core/process";
import { fs } from "../fenced-fs";
import { coreGit, coreGitAnswer, coreHeld } from "../local/git/exec";
import { prepareWorktree } from "../local/git/worktree-seed";
import { LocalCommandError } from "../local/types";
import { ompsExitedIn } from "../omp-exits";
import { stepStalled, trackEffect } from "../serial-chain";
import type { BeforeRemove } from "../worktree-orphans";
import { realFolder, withRemovalClaim } from "../worktree-removals";
import { diskBytes } from "./usage";
import {
	inProgressOperation,
	looksSecret,
	processInside,
	processWorkingFolders,
	readWorktreeFiles,
	secretIn,
	type WorktreeFiles,
} from "./worktree-facts";

/**
 * Deadlines of the core requests: the slow gits of a save and a restore (`add -A` of a big tree, `worktree add`,
 * `worktree remove`) and the copy of an archive (up to 512 MB, cloned where the volume can).
 */
const SLOW_MS = 300_000;
const ARCHIVE_COPY_MS = 10 * 60_000;
const ARCHIVE_STEP_MS = 60_000;
/** Build output to drop is measured, then removed. */
const DROP_MS = 30 * 60_000;

/** Why a worktree was left in place; the runtime log carries it. */
export class KeepWorktree extends Error {}

/** The core's refusal to save (`keep_worktree`) as the `KeepWorktree` callers catch. */
async function saveStep<T>(request: Promise<T>): Promise<T> {
	try {
		return await request;
	} catch (error) {
		if (error instanceof CoreError && error.code === "keep_worktree") throw new KeepWorktree(error.message);
		throw error;
	}
}

/** The saved records and their archives: `<dir>/saved.json`, `<dir>/saved/<id>/`. */
export class SavedWorktreeStore {
	readonly #dir: string;
	#writing: Promise<void> = Promise.resolve();

	constructor(dir: string) {
		this.#dir = dir;
	}

	archiveDir(id: string): string {
		return path.join(this.#dir, "saved", id);
	}

	async list(): Promise<SavedWorktree[]> {
		const text = await fs.readFile(path.join(this.#dir, "saved.json"), "utf8").catch(() => "[]");
		try {
			const parsed: unknown = JSON.parse(text);
			return Array.isArray(parsed) ? (parsed as SavedWorktree[]) : [];
		} catch {
			return [];
		}
	}

	/** Records are changed one at a time, written atomically, 0600. */
	update(change: (records: SavedWorktree[]) => SavedWorktree[]): Promise<void> {
		const next = this.#writing.then(async () => {
			await fs.mkdir(this.#dir, { recursive: true, mode: 0o700 });
			const records = change(await this.list());
			const file = path.join(this.#dir, "saved.json");
			// A holder of the repository lock stopped for running long never replaces the file under the next one.
			// Tracked whole: a rename it already issued must finish before the next holder of the lock runs.
			await trackEffect(
				"saved.json write",
				writeFileAtomic(file, `${JSON.stringify(records, null, 2)}\n`, {
					mode: 0o600,
					dirMode: 0o700,
					commitIf: () => !stepStalled(),
				}),
			);
		});
		this.#writing = next.catch(() => {});
		return next;
	}
}

let store: SavedWorktreeStore | null = null;

/** Set once at startup (index.ts); the local handlers and disk care read it. */
export function setSavedWorktreeStore(next: SavedWorktreeStore): void {
	store = next;
}

export function savedWorktreeStore(): SavedWorktreeStore {
	if (!store) throw new LocalCommandError("OMPdesk is still starting; try again in a moment.", "not_ready");
	return store;
}

/** What the archive must hold: ignored entries no tool makes again, plus untracked or changed files that hold secrets. */
async function archiveEntries(
	worktree: string,
	files: WorktreeFiles,
): Promise<{ archive: string[]; secrets: string[]; overwrite: string[] }> {
	const secrets: string[] = [];
	const overwrite: string[] = [];
	for (const candidate of [...files.untrackedFiles, ...files.changed]) {
		const exists = await fs.lstat(path.join(worktree, candidate)).catch(() => null);
		if (!exists?.isFile() || !(await looksSecret(worktree, candidate))) continue;
		secrets.push(candidate);
		if (files.changed.includes(candidate)) overwrite.push(candidate);
	}
	const archive = [...files.ignored.filter(entry => !entry.regenerable).map(entry => entry.path), ...secrets];
	return { archive, secrets, overwrite };
}

function newId(): string {
	return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export interface SaveTarget {
	path: string;
	primary: string;
	branch: string | null;
	/** Commits nothing else holds (the worktree is unlanded). */
	unlanded: boolean;
}

/** What a save's checks found: HEAD, whether anything is staged, the staged files with content in the index. */
interface SaveChecked {
	head: string;
	staged: boolean;
	stagedFiles: string[];
}

interface SaveWork {
	staged: string | null;
	savedBranch: string | null;
	savedSha: string | null;
	archivedFiles: number;
	archivedBytes: number;
}

/**
 * Save the worktree (branch, archive) and remove its folder. `files` is the read the caller judged; `stillSame`
 * re-reads right before the removal and answers whether nothing moved. Throws `KeepWorktree` when it keeps it.
 */
export async function saveAndRemoveWorktree(
	target: SaveTarget,
	files: WorktreeFiles,
	saved: SavedWorktreeStore,
	stillSame: () => Promise<boolean>,
): Promise<SavedWorktree> {
	const { archive, secrets, overwrite } = await archiveEntries(target.path, files);
	const regenerableUntracked = files.untracked.filter(entry => entry.regenerable).map(entry => entry.path);
	const exclude = [...secrets, ...regenerableUntracked];
	// HEAD, the size of the untracked files, whether a restore could rewrite bytes, then what is staged.
	const checked = await saveStep(
		coreGit<SaveChecked>(
			"disk.saveCheck",
			{ worktree: target.path, untrackedFiles: files.untrackedFiles, exclude },
			7,
		),
	);
	// Each staged file read whole, one at a time, until the first that names or holds a secret: a staged blob cannot
	// be left out of the index's tree, so such a file keeps the worktree.
	for (const file of checked.stagedFiles) {
		const blob = await coreGitAnswer<{ complete: boolean }>(
			"disk.stagedBlob",
			{ worktree: target.path, path: file },
			1,
		);
		const bytes = blob.bin ? Buffer.from(blob.bin.buffer, blob.bin.byteOffset, blob.bin.byteLength) : Buffer.alloc(0);
		if (secretIn(file, bytes, blob.result.complete))
			throw new KeepWorktree(`a staged file may hold a secret (${file})`);
	}
	const head = checked.head;
	const id = newId();
	const archiveDir = saved.archiveDir(id);
	// HEAD → what was staged → the working tree: the index and the working tree each come back as they were. The core
	// takes the branch and the archive back when the archive fails.
	const work = await saveStep(
		coreGit<SaveWork>(
			"disk.saveWork",
			{
				worktree: target.path,
				primary: target.primary,
				branch: target.branch,
				unlanded: target.unlanded,
				head,
				staged: checked.staged,
				exclude,
				archive,
				overwrite,
				archiveDir,
				name: path.basename(target.path),
				day: new Date().toISOString().slice(0, 10),
			},
			6,
			5 * SLOW_MS + ARCHIVE_COPY_MS,
		),
	);
	const rollback = () =>
		coreGit(
			"disk.saveRollback",
			{ primary: target.primary, branch: work.savedBranch, sha: work.savedSha, archiveDir },
			1,
		);
	try {
		if (!(await stillSame())) throw new KeepWorktree("it changed while it was being saved");
	} catch (error) {
		await rollback();
		throw error;
	}
	const record: SavedWorktree = {
		id,
		path: target.path,
		repo: target.primary,
		branch: target.branch,
		head,
		savedBranch: work.savedBranch,
		...(work.staged ? { staged: work.staged } : {}),
		removedAt: Date.now(),
		archivedFiles: work.archivedFiles,
		archivedBytes: work.archivedBytes,
	};
	// The record is written before anything is removed, and once removal starts nothing is rolled back: a removal that
	// stops half way has already taken files, and the saved branch and archive are then their only copies.
	try {
		await saved.update(records => [record, ...records]);
	} catch (error) {
		await rollback();
		throw error;
	}
	const refused = await coreGit<string | null>(
		"disk.forceRemove",
		{ primary: target.primary, path: target.path },
		0,
		SLOW_MS,
	);
	if (refused !== null) {
		throw new Error(
			`git worktree remove failed for ${target.path} (${refused}); its work stays saved on ${work.savedBranch ?? record.branch ?? record.head} and in archive ${id}`,
		);
	}
	return record;
}

/** The archive alone, recorded as saved when it holds anything (a landed worktree about to be removed). */
async function archiveIgnoredData(
	target: { path: string; primary: string; branch: string | null },
	files: WorktreeFiles,
	saved: SavedWorktreeStore,
): Promise<SavedWorktree | null> {
	const { archive } = await archiveEntries(target.path, files);
	if (archive.length === 0) return null;
	const id = newId();
	const archived = await saveStep(
		coreGit<{ files: number; bytes: number; head: string } | null>(
			"disk.archive",
			{ worktree: target.path, entries: archive, archiveDir: saved.archiveDir(id) },
			1,
			ARCHIVE_COPY_MS,
		),
	);
	if (!archived) return null;
	return {
		id,
		path: target.path,
		repo: target.primary,
		branch: target.branch,
		head: archived.head,
		savedBranch: null,
		removedAt: Date.now(),
		archivedFiles: archived.files,
		archivedBytes: archived.bytes,
	};
}

/**
 * After a landed worktree's removal: records the archive when the folder went, and also when git stopped half way
 * and any archived file is gone or changed from the folder (the archive is then its only copy). Only a worktree that
 * still holds every archived file as it was loses the archive.
 */
async function settleArchive(saved: SavedWorktreeStore, record: SavedWorktree, removed: boolean): Promise<void> {
	if (!removed) {
		const intact = await coreHeld<boolean>(
			"disk.settleArchive",
			{ worktree: record.path, archiveDir: saved.archiveDir(record.id) },
			ARCHIVE_STEP_MS,
		);
		if (intact) return;
	}
	await saved.update(records => [record, ...records]);
}

/**
 * The `prepare` of every landed-worktree removal (`removeOrphanWorktree`): keeps one a known process works in, then
 * archives what no tool makes again and records it once the folder went. `measured` hears each worktree's size.
 */
export function archiveBeforeRemove(
	saved: SavedWorktreeStore,
	folders: readonly string[] | null,
	measured?: Map<string, number>,
): BeforeRemove {
	return async worktree => {
		if (folders !== null && processInside(worktree.path, folders)) throw new KeepWorktree("a process works in it");
		const operation = await inProgressOperation(worktree.path);
		if (operation) throw new KeepWorktree(`a git operation is half done (${operation})`);
		const files = await readWorktreeFiles(worktree.path);
		measured?.set(worktree.path, await diskBytes(worktree.path));
		const record = await archiveIgnoredData(
			{ path: worktree.path, primary: worktree.repo, branch: worktree.branch },
			files,
			saved,
		);
		return async removed => {
			if (record) await settleArchive(saved, record, removed);
		};
	};
}

/** How long a discard waits for the closed tab's omp (and, where readable, any process) to leave the worktree. */
const DISCARD_EXIT_WAIT_MS = 5_000;
const DISCARD_EXIT_POLL_MS = 250;

export interface DiscardDeps {
	/** Every folder a session of this computer has open (windows' tabs and those run for paired devices). */
	openFolders: () => readonly string[];
	/** The working folders of running processes; null where the platform cannot tell (Windows). */
	processes?: () => Promise<string[] | null>;
	/** Whether every omp this computer stopped in the folder has exited (`ompsExitedIn`). */
	ompsExited?: (folder: string, timeoutMs: number) => Promise<boolean>;
	store?: () => SavedWorktreeStore;
	pause?: (ms: number) => Promise<void>;
}

/**
 * A failed open's unused worktree and branch (`discardNewWorktree`), removed under the removal claim every removal
 * takes (`withRemovalClaim`: no session of this computer may have it open, and none starts there meanwhile), once the
 * closed tab's omp has exited (`omp-exits.ts`, the signal that holds on every platform) and, where process folders
 * can be read, no other process works in it; either still there after a few seconds keeps it. What no tool makes
 * again is archived first.
 */
export function discardOpenedWorktree(worktree: WorktreeRef, deps: DiscardDeps): Promise<WorktreeRemoval> {
	const processes = deps.processes ?? processWorkingFolders;
	const pause =
		deps.pause ??
		((ms: number) => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, ms);
			return promise;
		});
	return withRemovalClaim(worktree.path, deps.openFolders, async () => {
		if (!(await (deps.ompsExited ?? ompsExitedIn)(worktree.path, DISCARD_EXIT_WAIT_MS))) return null;
		let folders = await processes();
		for (
			let waited = 0;
			folders !== null && processInside(worktree.path, folders) && waited < DISCARD_EXIT_WAIT_MS;
		) {
			await pause(DISCARD_EXIT_POLL_MS);
			waited += DISCARD_EXIT_POLL_MS;
			folders = await processes();
		}
		if (folders !== null && processInside(worktree.path, folders)) return null;
		return discardNewWorktree(worktree, archiveBeforeRemove((deps.store ?? savedWorktreeStore)(), folders));
	});
}

/** What the tab spawn asks of this computer's saved worktrees (`SpawnTabDeps.savedWorktrees`). */
export const savedWorktreesForSpawn = {
	async find(folder: string): Promise<SavedWorktree | null> {
		const wanted = realFolder(folder);
		return (await savedWorktreeStore().list()).find(record => realFolder(record.path) === wanted) ?? null;
	},
	restore: (id: string) => restoreSavedWorktree(id, savedWorktreeStore()),
};

/** The saved worktrees of `cwd`'s repository, newest removal first. */
export async function listSavedWorktrees(primary: string, saved: SavedWorktreeStore): Promise<SavedWorktree[]> {
	const repo = realFolder(primary);
	return (await saved.list())
		.filter(record => realFolder(record.repo) === repo)
		.sort((a, b) => b.removedAt - a.removedAt);
}

/**
 * Put a saved worktree back at its old path: on its branch when the branch still points where it did and no other
 * worktree has it checked out, else detached at the saved HEAD; the saved changes as uncommitted work; then the
 * repository's seeding and setup hook; then the archive over whatever those made (the archived bytes win; a file
 * something else made there is set aside as `<name>.ompdesk-before-restore`, never deleted). The record and archive
 * go only when every archived file came back; otherwise both stay.
 */
export async function restoreSavedWorktree(id: string, saved: SavedWorktreeStore): Promise<SavedWorktreeRestore> {
	const record = (await saved.list()).find(entry => entry.id === id);
	if (!record) throw new LocalCommandError(`No saved worktree ${id}.`, "not_saved");
	let onBranch: boolean;
	try {
		onBranch = await coreGit<boolean>(
			"disk.restoreCheckout",
			{
				path: record.path,
				repo: record.repo,
				branch: record.branch,
				head: record.head,
				savedBranch: record.savedBranch,
				staged: record.staged ?? null,
			},
			6,
			SLOW_MS,
		);
	} catch (error) {
		if (error instanceof CoreError && error.code === "path_exists")
			throw new LocalCommandError(error.message, "path_exists");
		throw error;
	}
	const dir = saved.archiveDir(record.id);
	await prepareWorktree(record.repo, record.path);
	const archive =
		record.archivedFiles > 0
			? await coreHeld<{ restored: number; skipped: number }>(
					"disk.restoreFiles",
					{ worktree: record.path, archiveDir: dir },
					ARCHIVE_COPY_MS,
				)
			: { restored: 0, skipped: 0 };
	if (archive.skipped === 0) {
		await saved.update(records => records.filter(entry => entry.id !== record.id));
		await coreHeld("disk.forgetArchive", { archiveDir: dir }, ARCHIVE_STEP_MS);
	}
	return { path: record.path, branch: onBranch ? record.branch : null, archive };
}

/** Removes the regenerable entries of `files`; each with what it took (allocated bytes, measured before). */
export function dropArtifacts(
	worktree: string,
	files: WorktreeFiles,
): Promise<{ path: string; bytes: number; reason: string }[]> {
	const entries = [...files.ignored, ...files.untracked].flatMap(entry =>
		entry.regenerable ? [{ path: entry.path, reason: entry.regenerable.reason }] : [],
	);
	return entries.length === 0 ? Promise.resolve([]) : coreHeld("disk.dropArtifacts", { worktree, entries }, DROP_MS);
}
