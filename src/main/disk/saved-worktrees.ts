/**
 * Worktrees disk care takes off the disk, losing nothing, and puts back on request.
 *
 * - `dropArtifacts`: the ignored (or untracked) output the project's own tools make again (`regenerable.ts`) goes;
 *   everything else stays.
 * - `saveAndRemoveWorktree`: an idle worktree with work nothing else holds is saved first: tracked changes and
 *   untracked files as one commit on a new `ompdesk/saved/…` branch (never on the worktree's own branch, never on
 *   main; secrets never enter it), and every file git does not keep and no tool makes again (a seeded `.env`
 *   someone edited, a local database, a secret) in a private archive under userData (0700 folders, 0600 files; never
 *   in git, never synced, never uploaded). Only after both are verified and the worktree is unchanged does
 *   `git worktree remove --force` take the folder; the worktree's own branch stays.
 * - `archiveIgnoredData`: the archive alone, before a landed worktree is removed (`git worktree remove` deletes
 *   ignored files without asking).
 * - `restoreSavedWorktree`: `git worktree add` at the old path, the saved changes back in the working tree (not
 *   committed), the archive copied back, then the repository's own seeding and setup hook.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SavedWorktree, SavedWorktreeRestore } from "../../shared/disk-care";
import { git, gitRaw } from "../local/git/exec";
import { prepareWorktree } from "../local/git/worktree-seed";
import { LocalCommandError } from "../local/types";
import type { BeforeRemove } from "../worktree-orphans";
import { realFolder } from "../worktree-removals";
import { diskBytes } from "./usage";
import {
	inProgressOperation,
	looksSecret,
	processInside,
	readWorktreeFiles,
	SECRET_SCAN_MAX_BYTES,
	secretIn,
	type WorktreeFiles,
} from "./worktree-facts";

/** A worktree whose untracked files would make a commit this big is kept, not saved. */
export const SAVE_COMMIT_MAX_BYTES = 256 * 1024 * 1024;
/** A worktree whose private archive would be this big is kept, not saved. */
export const ARCHIVE_MAX_BYTES = 512 * 1024 * 1024;
const SAVED_PREFIX = "ompdesk/saved/";
const ZERO_SHA = "0000000000000000000000000000000000000000";

/** Why a worktree was left in place; the runtime log carries it. */
export class KeepWorktree extends Error {}

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
			const temp = `${file}.${process.pid}.tmp`;
			await fs.writeFile(temp, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
			await fs.rename(temp, file);
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

interface ArchivedFile {
	path: string;
	mode: number;
	size: number;
	link?: true;
	/** A tracked file whose change was kept out of the saved commit (a secret): a restore writes it over HEAD's copy. */
	overwrite?: true;
}

async function walkFiles(root: string, relative: string, out: ArchivedFile[]): Promise<void> {
	const absolute = path.join(root, ...relative.split("/"));
	const stat = await fs.lstat(absolute);
	if (stat.isDirectory()) {
		for (const name of (await fs.readdir(absolute)).sort()) await walkFiles(root, `${relative}/${name}`, out);
		return;
	}
	out.push({
		path: relative,
		mode: stat.mode & 0o777,
		size: stat.size,
		...(stat.isSymbolicLink() ? { link: true as const } : {}),
	});
}

/**
 * Copies `entries` (relative to `worktree`, a directory ending in `/`) into the archive `id`: copy-on-write where the
 * volume allows, links as links, then 0600/0700 with the original modes kept in `manifest.json`. Verified by walking
 * both sides; a mismatch removes the half archive and throws.
 */
export async function writeArchive(
	worktree: string,
	entries: readonly string[],
	saved: SavedWorktreeStore,
	id: string,
	overwrite: readonly string[] = [],
): Promise<{ files: number; bytes: number }> {
	const source: ArchivedFile[] = [];
	for (const entry of entries) await walkFiles(worktree, entry.replace(/\/+$/, ""), source);
	for (const file of source) if (overwrite.includes(file.path)) file.overwrite = true;
	const bytes = source.reduce((sum, file) => sum + file.size, 0);
	if (bytes > ARCHIVE_MAX_BYTES)
		throw new KeepWorktree(`files no tool makes again take ${bytes} bytes, more than the archive takes`);
	if (source.length === 0) return { files: 0, bytes: 0 };
	const dir = saved.archiveDir(id);
	const files = path.join(dir, "files");
	try {
		await fs.mkdir(files, { recursive: true, mode: 0o700 });
		for (const file of source) {
			const target = path.join(files, ...file.path.split("/"));
			await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
			const from = path.join(worktree, ...file.path.split("/"));
			if (file.link) await fs.symlink(await fs.readlink(from), target);
			else {
				await fs.copyFile(from, target, fs.constants.COPYFILE_FICLONE);
				await fs.chmod(target, 0o600);
			}
		}
		const copied: ArchivedFile[] = [];
		for (const file of source) await walkFiles(files, file.path, copied);
		const same =
			copied.length === source.length &&
			copied.every((file, index) => file.path === source[index]?.path && file.size === source[index]?.size);
		if (!same) throw new Error(`the archive of ${worktree} does not match its files`);
		await fs.writeFile(path.join(dir, "manifest.json"), `${JSON.stringify({ worktree, files: source }, null, 2)}\n`, {
			mode: 0o600,
		});
	} catch (error) {
		await fs.rm(dir, { recursive: true, force: true });
		throw error;
	}
	return { files: source.length, bytes };
}

/** What the archive must hold: ignored entries no tool makes again, plus untracked or changed files that hold secrets. */
export async function archiveEntries(
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

async function freeBranchName(primary: string, folder: string): Promise<string> {
	const day = new Date().toISOString().slice(0, 10);
	for (let suffix = 1; ; suffix++) {
		const name = `${SAVED_PREFIX}${folder}-${day}${suffix > 1 ? `-${suffix}` : ""}`;
		const exists = await gitRaw(primary, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
		if (exists.code !== 0) return name;
	}
}

/** Disk care's own identity on its commits; no hook runs and nothing is signed (`commit-tree --no-gpg-sign`). */
const SAVE_ENV = {
	GIT_AUTHOR_NAME: "OMPdesk disk care",
	GIT_AUTHOR_EMAIL: "disk-care@ompdesk.invalid",
	GIT_COMMITTER_NAME: "OMPdesk disk care",
	GIT_COMMITTER_EMAIL: "disk-care@ompdesk.invalid",
};

/**
 * The worktree's index (what is staged) as one commit on top of HEAD, or null when nothing is staged. Written from a
 * copy of the index, so the worktree's own index file is never touched. A staged file that names or holds a secret
 * keeps the worktree (a staged blob cannot be left out of the index's tree).
 */
async function stagedCommit(worktree: string, head: string): Promise<string | null> {
	const staged = await gitRaw(worktree, ["diff", "--cached", "--name-only", "--no-renames", "-z"]);
	if (staged.code !== 0) throw new Error(`git diff --cached failed in ${worktree}: ${staged.stderr.trim()}`);
	if (staged.stdout.toString("utf8").split("\0").filter(Boolean).length === 0) return null;
	// Every staged file that has content in the index (a staged deletion has none to hold a secret).
	const withContent = await gitRaw(worktree, [
		"diff",
		"--cached",
		"--name-only",
		"--no-renames",
		"--diff-filter=d",
		"-z",
	]);
	for (const file of withContent.stdout.toString("utf8").split("\0").filter(Boolean)) {
		const blob = await gitRaw(worktree, ["cat-file", "blob", `:${file}`], { maxBytes: SECRET_SCAN_MAX_BYTES });
		if (secretIn(file, blob.stdout, blob.code === 0 && !blob.truncated))
			throw new KeepWorktree(`a staged file may hold a secret (${file})`);
	}
	const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-staged-"));
	try {
		const index = path.resolve(worktree, (await git(worktree, ["rev-parse", "--git-path", "index"])).trim());
		await fs.copyFile(index, path.join(scratch, "index"));
		const env = { ...SAVE_ENV, GIT_INDEX_FILE: path.join(scratch, "index") };
		const tree = (await gitRaw(worktree, ["write-tree"], { env })).stdout.toString("utf8").trim();
		if (!tree) throw new Error(`git write-tree of the index failed in ${worktree}`);
		const message = `Saved by OMPdesk disk care: what was staged in ${path.basename(worktree)}`;
		const commit = await gitRaw(worktree, ["commit-tree", "--no-gpg-sign", "-p", head, "-m", message, tree], { env });
		if (commit.code !== 0) throw new Error(`git commit-tree failed in ${worktree}: ${commit.stderr.trim()}`);
		return commit.stdout.toString("utf8").trim();
	} finally {
		await fs.rm(scratch, { recursive: true, force: true });
	}
}

/**
 * One commit on top of `head` (HEAD, or the staged commit) holding the worktree's tracked changes and untracked files,
 * built in a scratch index (the worktree's own index is never touched); `exclude` (secrets, regenerable untracked
 * folders) stays out. Null when it would hold nothing more than `head`.
 */
async function saveCommit(worktree: string, head: string, exclude: readonly string[]): Promise<string | null> {
	const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-save-"));
	const env = { ...SAVE_ENV, GIT_INDEX_FILE: path.join(scratch, "index") };
	try {
		const step = async (args: string[]): Promise<string> => {
			const result = await gitRaw(worktree, args, { env, timeoutMs: 300_000 });
			if (result.code !== 0) throw new Error(`git ${args[0]} failed in ${worktree}: ${result.stderr.trim()}`);
			return result.stdout.toString("utf8").trim();
		};
		await step(["read-tree", head]);
		const pathspec = [".", ...exclude.map(entry => `:(exclude,literal)${entry.replace(/\/+$/, "")}`)];
		await step(["add", "-A", "--", ...pathspec]);
		const tree = await step(["write-tree"]);
		if (tree === (await step(["rev-parse", `${head}^{tree}`]))) return null;
		return await step([
			"commit-tree",
			"--no-gpg-sign",
			"-p",
			head,
			"-m",
			`Saved by OMPdesk disk care: uncommitted work of ${path.basename(worktree)}`,
			tree,
		]);
	} finally {
		await fs.rm(scratch, { recursive: true, force: true });
	}
}

/** Attribute words that make a checkout write other bytes than the blob holds. */
const CONVERTING_ATTRIBUTE = /(^|\s)-?(text|eol|crlf|filter|working-tree-encoding|ident)(=|\s|$)/m;

/**
 * Losing nothing means the restore writes the very bytes the folder holds now, for every tracked file, changed or not.
 * Git rewrites bytes on add and checkout when line-ending or filter settings apply (core.autocrlf true/input, Git for
 * Windows' default; core.eol; a filter driver; .gitattributes text/eol/filter/working-tree-encoding/ident), so an LF
 * file in such a repo comes back CRLF. Without any of them, add stores and checkout writes bytes as they are. So a repo
 * with any such setting keeps its worktree: the reason, or null when bytes round-trip.
 */
async function rewritesBytes(worktree: string): Promise<string | null> {
	const config = async (key: string): Promise<string> =>
		(await gitRaw(worktree, ["config", "--get", key])).stdout.toString("utf8").trim().toLowerCase();
	const autocrlf = await config("core.autocrlf");
	if (autocrlf === "true" || autocrlf === "input")
		return `core.autocrlf is ${autocrlf}: a restore could change line endings`;
	if (await config("core.eol")) return "core.eol is set: a restore could change line endings";
	const filters = await gitRaw(worktree, ["config", "--get-regexp", "^filter\\."]);
	if (filters.stdout.length > 0) return "a git filter driver is configured: a restore could rewrite files";
	const attributeFiles = (await gitRaw(worktree, ["ls-files", "-z", "--", ":(glob)**/.gitattributes"])).stdout
		.toString("utf8")
		.split("\0")
		.filter(Boolean)
		.map(file => path.join(worktree, file));
	attributeFiles.push(
		path.resolve(worktree, (await git(worktree, ["rev-parse", "--git-path", "info/attributes"])).trim()),
	);
	const global = await config("core.attributesfile");
	attributeFiles.push(
		global
			? global.replace(/^~(?=\/|\\)/, os.homedir())
			: path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "git", "attributes"),
	);
	for (const file of attributeFiles) {
		const text = await fs.readFile(file, "utf8").catch(() => "");
		const rules = text.split("\n").filter(line => !line.trimStart().startsWith("#"));
		if (rules.some(line => CONVERTING_ATTRIBUTE.test(line)))
			return `${path.basename(file)} sets line-ending or filter attributes: a restore could rewrite files`;
	}
	return null;
}

export interface SaveTarget {
	path: string;
	primary: string;
	branch: string | null;
	/** Commits nothing else holds (the worktree is unlanded). */
	unlanded: boolean;
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
	const head = (await git(target.path, ["rev-parse", "HEAD"])).trim();
	const { archive, secrets, overwrite } = await archiveEntries(target.path, files);
	const regenerableUntracked = files.untracked.filter(entry => entry.regenerable).map(entry => entry.path);
	const exclude = [...secrets, ...regenerableUntracked];
	let commitBytes = 0;
	for (const file of files.untrackedFiles) {
		if (exclude.some(entry => file === entry || file.startsWith(entry.endsWith("/") ? entry : `${entry}/`))) continue;
		commitBytes += (await fs.lstat(path.join(target.path, file)).catch(() => null))?.size ?? 0;
	}
	if (commitBytes > SAVE_COMMIT_MAX_BYTES)
		throw new KeepWorktree(`its untracked files take ${commitBytes} bytes, more than a saved commit takes`);

	const rewrites = await rewritesBytes(target.path);
	if (rewrites) throw new KeepWorktree(rewrites);

	// HEAD → what was staged → the working tree: the index and the working tree each come back as they were.
	const staged = await stagedCommit(target.path, head);
	const wip = await saveCommit(target.path, staged ?? head, exclude);
	const savedSha = wip ?? staged ?? (target.branch === null && target.unlanded ? head : null);
	const savedBranch = savedSha ? await freeBranchName(target.primary, path.basename(target.path)) : null;
	if (savedBranch && savedSha)
		await git(target.primary, ["update-ref", `refs/heads/${savedBranch}`, savedSha, ZERO_SHA]);
	const id = newId();
	const rollback = async (): Promise<void> => {
		if (savedBranch && savedSha)
			await gitRaw(target.primary, ["update-ref", "-d", `refs/heads/${savedBranch}`, savedSha]);
		await fs.rm(saved.archiveDir(id), { recursive: true, force: true });
	};
	let archived: { files: number; bytes: number };
	try {
		archived = await writeArchive(target.path, archive, saved, id, overwrite);
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
		savedBranch,
		...(staged ? { staged } : {}),
		removedAt: Date.now(),
		archivedFiles: archived.files,
		archivedBytes: archived.bytes,
	};
	// The record is written before anything is removed, and once removal starts nothing is rolled back: a removal that
	// stops half way has already taken files, and the saved branch and archive are then their only copies.
	try {
		await saved.update(records => [record, ...records]);
	} catch (error) {
		await rollback();
		throw error;
	}
	const removed = await gitRaw(target.primary, ["worktree", "remove", "--force", target.path], { timeoutMs: 300_000 });
	if (removed.code !== 0) {
		throw new Error(
			`git worktree remove failed for ${target.path} (${removed.stderr.trim()}); its work stays saved on ${savedBranch ?? record.branch ?? record.head} and in archive ${id}`,
		);
	}
	return record;
}

/** The archive alone, recorded as saved when it holds anything (a landed worktree about to be removed). */
export async function archiveIgnoredData(
	target: { path: string; primary: string; branch: string | null },
	files: WorktreeFiles,
	saved: SavedWorktreeStore,
): Promise<SavedWorktree | null> {
	const { archive } = await archiveEntries(target.path, files);
	if (archive.length === 0) return null;
	const id = newId();
	const archived = await writeArchive(target.path, archive, saved, id);
	if (archived.files === 0) return null;
	const record: SavedWorktree = {
		id,
		path: target.path,
		repo: target.primary,
		branch: target.branch,
		head: (await git(target.path, ["rev-parse", "HEAD"])).trim(),
		savedBranch: null,
		removedAt: Date.now(),
		archivedFiles: archived.files,
		archivedBytes: archived.bytes,
	};
	return record;
}

/**
 * After a landed worktree's removal: records the archive when the folder went, and also when git stopped half way
 * and any archived file is gone or changed from the folder (the archive is then its only copy). Only a worktree that
 * still holds every archived file as it was loses the archive.
 */
export async function settleArchive(saved: SavedWorktreeStore, record: SavedWorktree, removed: boolean): Promise<void> {
	if (!removed) {
		const dir = saved.archiveDir(record.id);
		const manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8")) as {
			files: ArchivedFile[];
		};
		let intact = true;
		for (const file of manifest.files) {
			const stat = await fs.lstat(path.join(record.path, ...file.path.split("/"))).catch(() => null);
			if (!stat || stat.size !== file.size) intact = false;
		}
		if (intact) {
			await fs.rm(dir, { recursive: true, force: true });
			return;
		}
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

/** The saved worktrees of `cwd`'s repository, newest removal first. */
export async function listSavedWorktrees(primary: string, saved: SavedWorktreeStore): Promise<SavedWorktree[]> {
	const repo = realFolder(primary);
	return (await saved.list())
		.filter(record => realFolder(record.repo) === repo)
		.sort((a, b) => b.removedAt - a.removedAt);
}

async function sameBytes(a: string, b: string): Promise<boolean> {
	const [left, right] = await Promise.all([fs.readFile(a).catch(() => null), fs.readFile(b).catch(() => null)]);
	return left !== null && right !== null && left.equals(right);
}

/** `<target>.ompdesk-before-restore`, numbered when that is taken too. */
async function asideName(target: string): Promise<string> {
	for (let suffix = 1; ; suffix++) {
		const candidate = `${target}.ompdesk-before-restore${suffix > 1 ? `-${suffix}` : ""}`;
		if (!(await fs.lstat(candidate).catch(() => null))) return candidate;
	}
}

/**
 * Puts the archive back. The archived bytes are what the person had, so they win: a file something else made at that
 * path since (a post-checkout hook's default `.env`, the repository's seeding) is moved aside to
 * `<name>.ompdesk-before-restore`, never deleted; an identical one counts as restored; a tracked secret's change goes
 * over HEAD's copy (which git holds). A folder where a file was is left alone and the file counts as skipped.
 */
async function copyBack(dir: string, worktree: string): Promise<{ restored: number; skipped: number }> {
	const manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8")) as { files: ArchivedFile[] };
	let restored = 0;
	let skipped = 0;
	for (const file of manifest.files) {
		const target = path.join(worktree, ...file.path.split("/"));
		const from = path.join(dir, "files", ...file.path.split("/"));
		const existing = await fs.lstat(target).catch(() => null);
		if (existing) {
			if (existing.isDirectory()) {
				skipped++;
				continue;
			}
			if (!file.link && existing.isFile() && (await sameBytes(from, target))) {
				restored++;
				continue;
			}
			if (file.overwrite) await fs.rm(target, { force: true });
			else await fs.rename(target, await asideName(target));
		}
		await fs.mkdir(path.dirname(target), { recursive: true });
		if (file.link) await fs.symlink(await fs.readlink(from), target);
		else {
			await fs.copyFile(from, target, fs.constants.COPYFILE_FICLONE);
			await fs.chmod(target, file.mode);
		}
		restored++;
	}
	return { restored, skipped };
}

/**
 * Put a saved worktree back at its old path: on its branch when the branch still points where it did and no other
 * worktree has it checked out, else detached at the saved HEAD; the saved changes as uncommitted work; then the
 * repository's seeding and setup hook; then the archive over whatever those made (`copyBack`). The record and archive
 * go only when every archived file came back; otherwise both stay.
 */
export async function restoreSavedWorktree(id: string, saved: SavedWorktreeStore): Promise<SavedWorktreeRestore> {
	const record = (await saved.list()).find(entry => entry.id === id);
	if (!record) throw new LocalCommandError(`No saved worktree ${id}.`, "not_saved");
	if (await fs.lstat(record.path).catch(() => null))
		throw new LocalCommandError(`${record.path} already exists; nothing was restored.`, "path_exists");
	const tip = record.branch
		? (await gitRaw(record.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${record.branch}`])).stdout
				.toString("utf8")
				.trim()
		: "";
	const checkedOut = record.branch
		? (await git(record.repo, ["worktree", "list", "--porcelain"])).includes(`branch refs/heads/${record.branch}\n`)
		: false;
	const onBranch = record.branch !== null && tip === record.head && !checkedOut;
	await fs.mkdir(path.dirname(record.path), { recursive: true });
	const added = await gitRaw(
		record.repo,
		onBranch
			? ["worktree", "add", record.path, record.branch as string]
			: ["worktree", "add", "--detach", record.path, record.head],
		{ timeoutMs: 300_000 },
	);
	if (added.code !== 0) throw new Error(`git worktree add failed: ${added.stderr.trim()}`);
	if (record.savedBranch) {
		const savedSha = (await git(record.repo, ["rev-parse", `refs/heads/${record.savedBranch}`])).trim();
		if (savedSha !== record.head) {
			// Two-tree read-tree moves the working tree from HEAD to the saved commit (deletions too); the reset puts
			// the index back on HEAD, so the saved work is uncommitted again; then what was staged goes back into the
			// index alone (read-tree without -u leaves the working tree as it is).
			await git(record.path, ["read-tree", "-m", "-u", "HEAD", savedSha]);
			await git(record.path, ["reset", "-q"]);
			if (record.staged) await git(record.path, ["read-tree", record.staged]);
		}
	}
	const dir = saved.archiveDir(record.id);
	await prepareWorktree(record.repo, record.path);
	const archive = record.archivedFiles > 0 ? await copyBack(dir, record.path) : { restored: 0, skipped: 0 };
	if (archive.skipped === 0) {
		await saved.update(records => records.filter(entry => entry.id !== record.id));
		await fs.rm(dir, { recursive: true, force: true });
	}
	return { path: record.path, branch: onBranch ? record.branch : null, archive };
}

/** Removes the regenerable entries of `files`; each with what it took (allocated bytes, measured before). */
export async function dropArtifacts(
	worktree: string,
	files: WorktreeFiles,
): Promise<{ path: string; bytes: number; reason: string }[]> {
	const dropped: { path: string; bytes: number; reason: string }[] = [];
	for (const entry of [...files.ignored, ...files.untracked]) {
		if (!entry.regenerable) continue;
		const target = path.join(worktree, ...entry.path.replace(/\/+$/, "").split("/"));
		const bytes = await diskBytes(target);
		await fs.rm(target, { recursive: true, force: true, maxRetries: 3 });
		dropped.push({ path: entry.path, bytes, reason: entry.regenerable.reason });
	}
	return dropped;
}
