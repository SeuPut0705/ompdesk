/**
 * What `ompdesk_compare`, `ompdesk_merge` and the review queue know about a session's git worktree: a branch a
 * child session worked on beside the parent's checkout (`omp/agent/<slug>`, made by `worktree_create`).
 *
 * Local only (the git here runs on this computer), through the GUI's own git runner. Nothing here pushes, and a
 * merge that conflicts is aborted so the parent's checkout is never left half merged.
 */
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { git, gitRaw } from "../local/git/exec";
import type { BeforeRemove } from "../worktree-orphans";

/** The worktree binding of a tab (`IpcTabWorktree`): the checkout, its branch and the repo it forked from. */
export interface WorktreeRef {
	path: string;
	branch: string;
	baseCwd: string;
}

export interface FileChange {
	path: string;
	added: number;
	removed: number;
}

export interface BranchFacts {
	branch: string;
	/** The parent checkout's current branch; null while its HEAD is detached. */
	baseBranch: string | null;
	commitsAhead: number;
	/** Tracked files that differ from where the branch left the parent, committed or not. */
	files: FileChange[];
	filesTruncated: boolean;
	/** Tracked files with uncommitted edits in the worktree (a merge would leave them behind). */
	uncommitted: number;
	untracked: number;
	/** Tracked files with uncommitted edits in the parent checkout. */
	baseUncommitted: number;
	/**
	 * The branch's commits are already in the parent's branch or in the upstream it tracks (merged here, pushed or
	 * merged there): it has landed, and only uncommitted or untracked work could be left to review.
	 */
	merged: boolean;
}

/** What merging a branch into the parent checkout's HEAD would do, without doing it. */
export type MergePrediction =
	| { kind: "clean" }
	| { kind: "conflict"; files: string[] }
	| { kind: "unknown"; reason: string };

export interface BranchEvidence {
	/** The child's unified diff against where it lands (the same base `branchFacts` measures from), cut to `diffChars` fairly across files; "" when `diffChars` is 0 or nothing differs. */
	diff: string;
	/** Characters of `diff` the cut left out (0 when whole); a lower bound when git's own output cap cut it first. */
	diffOmitted: number;
	/** Merging the branch into the parent checkout's HEAD now, predicted by `git merge-tree --write-tree` with a quarantined object store. */
	merge: MergePrediction;
}

export type MergeOutcome =
	| { merged: true; sha: string; summary: string }
	/** `predicted`: found by `merge-tree` before any merge ran, so the parent's checkout was never touched. */
	| { merged: false; reason: "conflict"; files: string[]; predicted: boolean };

/** A precondition that stops a merge; the message says what to do. */
export class BranchError extends Error {}

const MAX_FILES = 200;
const TIMEOUT_MS = 120_000;

async function text(cwd: string, args: string[]): Promise<string> {
	return (await git(cwd, args, { timeoutMs: TIMEOUT_MS })).trim();
}

/** `git status --porcelain` lines of tracked changes and the untracked count. */
async function dirtiness(cwd: string): Promise<{ tracked: number; untracked: number }> {
	const output = await text(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
	const lines = output.split("\n").filter(Boolean);
	const untracked = lines.filter(line => line.startsWith("?? ")).length;
	return { tracked: lines.length - untracked, untracked };
}

function parseNumstat(output: string): FileChange[] {
	const rows: FileChange[] = [];
	for (const line of output.split("\n")) {
		const [added, removed, ...rest] = line.split("\t");
		const file = rest.join("\t");
		if (!file) continue;
		// A binary file reports "-" for both counts.
		rows.push({ path: file, added: Number(added) || 0, removed: Number(removed) || 0 });
	}
	return rows;
}

/** Whether `commit` is in the history of `ref` (both read in `cwd`'s repository). */
async function contains(cwd: string, ref: string, commit: string): Promise<boolean> {
	return (await gitRaw(cwd, ["merge-base", "--is-ancestor", commit, ref])).code === 0;
}

/** The commit `rev` names in `cwd`'s repository, or null when it names none. */
async function resolve(cwd: string, rev: string): Promise<string | null> {
	const result = await gitRaw(cwd, ["rev-parse", "--verify", "-q", `${rev}^{commit}`]);
	return result.code === 0 ? result.stdout.toString("utf8").trim() || null : null;
}

/** What a child's work lands in: the parent checkout's branch and HEAD, and the upstream that branch tracks. */
interface Base {
	/** The parent checkout's current branch; null while its HEAD is detached. */
	branch: string | null;
	head: string;
	/**
	 * The tip of the parent branch's `@{upstream}`, else of `origin`'s default branch (`refs/remotes/origin/HEAD`) as
	 * last fetched; null without either. Agents push there (`git push origin HEAD:main`) while the parent's own
	 * checkout stays where it was, so only this ref knows their work landed.
	 */
	upstream: string | null;
}

/** Reads the parent's base refs; never fetches or moves anything. */
async function readBase(baseCwd: string): Promise<Base> {
	const branchResult = await gitRaw(baseCwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
	const branch = branchResult.code === 0 ? branchResult.stdout.toString("utf8").trim() || null : null;
	const [head, tracked, remote] = await Promise.all([
		text(baseCwd, ["rev-parse", "HEAD"]),
		// `<branch>@{upstream}` wants the short name: `refs/heads/<branch>@{upstream}` names nothing.
		branch ? resolve(baseCwd, `${branch}@{upstream}`) : null,
		resolve(baseCwd, "refs/remotes/origin/HEAD"),
	]);
	return { branch, head, upstream: tracked ?? remote };
}

/** Verdicts of `landedByContent` per (target, tip) commit pair: both are immutable, and the review sweep asks every 10 s. */
const contentVerdicts = new Map<string, boolean>();
const MAX_CONTENT_VERDICTS = 256;

/**
 * The tree a merge of `tip` into `target` would make is `target`'s own tree: merging adds nothing. Like
 * `predictMerge`, the merged trees go to a scratch object store with the repo's as a read-only alternate, so the
 * landing check (the orphan sweep runs it every 6 h) leaves no objects in the repository.
 */
async function mergesAddNothing(cwd: string, target: string, tip: string): Promise<boolean> {
	const scratch = await mkdtemp(join(tmpdir(), "ompdesk-merge-tree-"));
	try {
		// Exit 0 prints the merged tree first; a conflict exits 1, and git older than 2.38 has no `--write-tree`.
		const merged = await gitRaw(cwd, ["merge-tree", "--write-tree", target, tip], {
			timeoutMs: TIMEOUT_MS,
			env: { GIT_OBJECT_DIRECTORY: scratch, GIT_ALTERNATE_OBJECT_DIRECTORIES: await objectStores(cwd) },
		});
		if (merged.code !== 0) return false;
		const mergedTree = merged.stdout.toString("utf8").split("\n", 1)[0]?.trim();
		if (!mergedTree) return false;
		const targetTree = await gitRaw(cwd, ["rev-parse", "--verify", "-q", `${target}^{tree}`]);
		return targetTree.code === 0 && targetTree.stdout.toString("utf8").trim() === mergedTree;
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

/** Every commit of `tip` has a patch-equivalent in `target` (`git cherry` marks each one `-`): a rebase or cherry-pick landed it. */
async function patchesAllIn(cwd: string, target: string, tip: string): Promise<boolean> {
	const cherry = await gitRaw(cwd, ["cherry", target, tip]);
	if (cherry.code !== 0) return false;
	const lines = cherry.stdout.toString("utf8").split("\n").filter(Boolean);
	return lines.length > 0 && lines.every(line => line.startsWith("-"));
}

/** Bytes of patch text one landing check reads; a bigger diff is not judged landed by it. */
const PATCH_BYTES = 64 * 1024 * 1024;

/** Pipes `input` through `git patch-id --stable`; the ids of its patches, first column of each output line. */
async function patchIds(cwd: string, input: Buffer): Promise<string[] | null> {
	const result = await gitRaw(cwd, ["patch-id", "--stable"], { input, timeoutMs: TIMEOUT_MS, maxBytes: PATCH_BYTES });
	if (result.code !== 0) return null;
	return result.stdout
		.toString("utf8")
		.split("\n")
		.map(line => line.split(" ", 1)[0] ?? "")
		.filter(Boolean);
}

/**
 * A squash merge: the whole change `tip` made since its merge-base with `target` has the patch-id of one commit that
 * `target` gained since. Holds after `target` edited the same lines, where the merge-tree and `git cherry` tests fail.
 * A squash whose content was altered has another patch-id and does not match.
 */
async function squashedInto(cwd: string, target: string, tip: string): Promise<boolean> {
	const mb = await gitRaw(cwd, ["merge-base", target, tip]);
	if (mb.code !== 0) return false;
	const base = mb.stdout.toString("utf8").trim();
	if (!base) return false;
	const [own, log] = await Promise.all([
		gitRaw(cwd, ["diff", base, tip], { timeoutMs: TIMEOUT_MS, maxBytes: PATCH_BYTES }),
		gitRaw(cwd, ["log", "-p", "--no-merges", "--format=commit %H", `${base}..${target}`], {
			timeoutMs: TIMEOUT_MS,
			maxBytes: PATCH_BYTES,
		}),
	]);
	if (own.code !== 0 || log.code !== 0 || own.truncated || log.truncated || own.stdout.length === 0) return false;
	const [mine, theirs] = await Promise.all([patchIds(cwd, own.stdout), patchIds(cwd, log.stdout)]);
	const id = mine?.[0];
	return id !== undefined && (theirs?.includes(id) ?? false);
}

/**
 * Whether `target` already holds what `tip` changed although `tip` is not in its history: a squash merge (merging adds
 * nothing, or its whole patch is one commit of `target`) or a rebase or cherry-pick (every commit has a patch-equivalent there). Both arguments are commit ids.
 */
async function landedByContent(cwd: string, target: string, tip: string): Promise<boolean> {
	const key = `${target} ${tip}`;
	const known = contentVerdicts.get(key);
	if (known !== undefined) return known;
	const verdict =
		(await mergesAddNothing(cwd, target, tip)) ||
		(await patchesAllIn(cwd, target, tip)) ||
		(await squashedInto(cwd, target, tip));
	if (contentVerdicts.size >= MAX_CONTENT_VERDICTS) {
		const oldest = contentVerdicts.keys().next();
		if (!oldest.done) contentVerdicts.delete(oldest.value);
	}
	contentVerdicts.set(key, verdict);
	return verdict;
}

interface Landing {
	landed: boolean;
	/** Landed by content, not by ancestry. */
	squashed?: true;
	diffBase: string;
}

/**
 * Where the child's own work starts: the base that already holds its tip when it landed (so only uncommitted work is
 * left), else the upstream when it holds the parent's HEAD (a stale local branch never lends the child the upstream's
 * newer commits), else the parent's HEAD. A tip that is in no base's history has still landed when a base holds its
 * changes (`landedByContent`: a squash merge, rebase or cherry-pick); the work is then measured from the tip itself.
 */
async function landing(cwd: string, base: Base, tip: string): Promise<Landing> {
	const { head, upstream } = base;
	const [inUpstream, inHead, headInUpstream] = await Promise.all([
		upstream ? contains(cwd, upstream, tip) : false,
		contains(cwd, head, tip),
		upstream ? contains(cwd, upstream, head) : false,
	]);
	if (upstream && inUpstream) return { landed: true, diffBase: upstream };
	if (inHead) return { landed: true, diffBase: head };
	for (const target of upstream ? [upstream, head] : [head]) {
		if (await landedByContent(cwd, target, tip)) return { landed: true, squashed: true, diffBase: tip };
	}
	return { landed: false, diffBase: upstream && headInUpstream ? upstream : head };
}

/** Where a child's work starts, measured the way `branchFacts` and `branchEvidence` both read it. */
async function measure(
	worktree: WorktreeRef,
): Promise<{ base: Base; tip: string; landed: boolean; mergeBase: string }> {
	const [base, tip] = await Promise.all([readBase(worktree.baseCwd), text(worktree.path, ["rev-parse", "HEAD"])]);
	const { landed, diffBase } = await landing(worktree.path, base, tip);
	return { base, tip, landed, mergeBase: await text(worktree.path, ["merge-base", tip, diffBase]) };
}

export async function branchFacts(worktree: WorktreeRef): Promise<BranchFacts> {
	const { base, tip, landed, mergeBase } = await measure(worktree);
	const [ahead, numstat, own, parent] = await Promise.all([
		text(worktree.path, ["rev-list", "--count", `${mergeBase}..${tip}`]),
		text(worktree.path, ["diff", "--numstat", "--no-renames", mergeBase]),
		dirtiness(worktree.path),
		dirtiness(worktree.baseCwd),
	]);
	const files = parseNumstat(numstat);
	return {
		branch: worktree.branch,
		baseBranch: base.branch,
		commitsAhead: Number(ahead) || 0,
		files: files.slice(0, MAX_FILES),
		filesTruncated: files.length > MAX_FILES,
		uncommitted: own.tracked,
		untracked: own.untracked,
		baseUncommitted: parent.tracked,
		merged: landed,
	};
}

const MAX_DIFF_BYTES = 4 * 1024 * 1024;

/** The `diff --git` header's path (`--no-renames` keeps both sides the same); the header itself when it is quoted or odd. */
function sectionPath(section: string): string {
	const header = section.slice(0, section.indexOf("\n") >>> 0 || section.length);
	return /^diff --git a\/(.+) b\/\1$/.exec(header)?.[1] ?? header.replace(/^diff --git /, "");
}

/**
 * Cut a unified diff to about `chars` characters, fairly across files: each file gets an equal share, and what a
 * small file does not use goes to the larger ones (water-filling), so a huge lockfile cannot starve a source file's
 * hunk. A cut file ends at a line boundary with one line saying how many lines went. `omitted` counts the characters
 * of the diff left out; the lines saying so are not part of it.
 */
export function boundDiff(diff: string, chars: number): { text: string; omitted: number } {
	if (chars <= 0) return { text: "", omitted: diff.length };
	if (diff.length <= chars) return { text: diff, omitted: 0 };
	const sections = diff.split(/^(?=diff --git )/m);
	const order = sections.map((section, index) => ({ index, size: section.length })).sort((a, b) => a.size - b.size);
	const shares = new Array<number>(sections.length).fill(0);
	let remaining = chars;
	order.forEach(({ index, size }, rank) => {
		const share = Math.floor(remaining / (order.length - rank));
		shares[index] = Math.min(size, share);
		remaining -= shares[index] ?? 0;
	});
	let out = "";
	let omitted = 0;
	sections.forEach((section, index) => {
		const share = shares[index] ?? 0;
		if (section.length <= share) {
			out += section;
			return;
		}
		const lines = section.match(/[^\n]*\n|[^\n]+$/g) ?? [];
		const marker = (left: number) =>
			`… ${left} more line${left === 1 ? "" : "s"} of ${sectionPath(section)} left out\n`;
		// Reserve the longest the marker can be (every line left out) so the cut file stays within its share.
		let budget = share - marker(lines.length).length;
		let kept = 0;
		while (kept < lines.length && (lines[kept]?.length ?? 0) <= budget) {
			budget -= lines[kept]?.length ?? 0;
			out += lines[kept];
			kept++;
		}
		omitted += lines.slice(kept).reduce((sum, line) => sum + line.length, 0);
		out += marker(lines.length - kept);
	});
	return { text: out, omitted };
}

/**
 * The child's diff and what merging it would do. The diff is `git diff <mergeBase>` in its worktree, the same
 * committed plus uncommitted tracked work `branchFacts` counts; git's own output is capped, and a capped one still
 * counts as cut.
 */
export async function branchEvidence(worktree: WorktreeRef, diffChars: number): Promise<BranchEvidence> {
	const readDiff = async (): Promise<{ diff: string; diffOmitted: number }> => {
		if (diffChars <= 0) return { diff: "", diffOmitted: 0 };
		const { mergeBase } = await measure(worktree);
		const raw = await gitRaw(worktree.path, ["diff", "--no-color", "--no-ext-diff", "--no-renames", mergeBase], {
			timeoutMs: TIMEOUT_MS,
			maxBytes: MAX_DIFF_BYTES,
		});
		if (raw.code !== 0) throw new BranchError(`git diff failed: ${raw.stderr.trim() || `exit ${raw.code}`}`);
		const { text: diff, omitted } = boundDiff(raw.stdout.toString("utf8"), diffChars);
		return { diff, diffOmitted: raw.truncated ? Math.max(omitted, 1) : omitted };
	};
	const [shown, merge] = await Promise.all([readDiff(), predictMerge(worktree)]);
	return { ...shown, merge };
}

/** Folders git may read objects from besides the scratch one: the repo's own store and any it was told to borrow. */
async function objectStores(baseCwd: string): Promise<string> {
	const own =
		process.env.GIT_OBJECT_DIRECTORY ??
		join(await text(baseCwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "objects");
	return [own, process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES].filter(Boolean).join(delimiter);
}

/**
 * Whether merging the branch into the parent checkout's HEAD would conflict, asked of `git merge-tree
 * --write-tree` (idea: Orca). It writes the merged trees it builds as objects, so they go to a scratch directory
 * with the repo's store as a read-only alternate: the repo's own object store, index and refs stay as they were.
 */
export async function predictMerge(worktree: WorktreeRef): Promise<MergePrediction> {
	const scratch = await mkdtemp(join(tmpdir(), "ompdesk-merge-tree-"));
	try {
		const [ours, theirs, stores] = await Promise.all([
			resolve(worktree.baseCwd, "HEAD"),
			resolve(worktree.baseCwd, `refs/heads/${worktree.branch}`),
			objectStores(worktree.baseCwd),
		]);
		if (!ours || !theirs) return { kind: "unknown", reason: `${ours ? worktree.branch : "HEAD"} names no commit` };
		const result = await gitRaw(
			worktree.baseCwd,
			["merge-tree", "--write-tree", "--name-only", "-z", "--no-messages", ours, theirs],
			{
				timeoutMs: TIMEOUT_MS,
				env: { GIT_OBJECT_DIRECTORY: scratch, GIT_ALTERNATE_OBJECT_DIRECTORIES: stores },
			},
		);
		if (result.code === 0) return { kind: "clean" };
		if (result.code === 1) {
			// `<tree oid>\0<name>\0<name>\0…`, a name once per conflicting stage.
			const [, ...names] = result.stdout.toString("utf8").split("\0");
			return { kind: "conflict", files: [...new Set(names.filter(Boolean))] };
		}
		return { kind: "unknown", reason: result.stderr.trim() || `git merge-tree exited ${result.code}` };
	} catch (error) {
		return { kind: "unknown", reason: error instanceof Error ? error.message : String(error) };
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

export interface LandingFacts {
	/** The branch has a commit of its own (its tip is not where it was created); an untouched branch has nothing to land. */
	hasWork: boolean;
	/** Its work is in the parent checkout's HEAD or in the upstream its branch tracks (merged here, pushed or merged there), by ancestry or by content. */
	landed: boolean;
	/** Present when `landed` by content (squash merge, rebase, cherry-pick) rather than by ancestry. */
	squashed?: true;
	/** No uncommitted or untracked file in the worktree: removing it loses nothing. */
	clean: boolean;
}

/** The commit a branch was created at (its oldest reflog entry), or undefined without a reflog. */
async function createdAt(baseCwd: string, branch: string): Promise<string | undefined> {
	const reflog = await gitRaw(baseCwd, ["reflog", "show", "--format=%H", `refs/heads/${branch}`]);
	return reflog.stdout.toString("utf8").split("\n").filter(Boolean).at(-1);
}

/**
 * Whether a child's work has landed: its branch tip is an ancestor of the parent's HEAD (a local merge, a
 * fast-forward, a rebase that kept the tip) or of the upstream the parent's branch tracks, else `origin`'s default
 * branch (pushed to main, or merged there), or one of them holds its changes under other commits (a squash merge, a
 * rebase, a cherry-pick: `squashed`), and whether the worktree is clean. An untouched branch is trivially an
 * ancestor, so `hasWork` compares the tip with the commit the branch was created at (its oldest reflog entry); without
 * a reflog nothing counts as work.
 */
export async function landingFacts(worktree: WorktreeRef): Promise<LandingFacts> {
	const tip = await resolve(worktree.baseCwd, `refs/heads/${worktree.branch}`);
	if (!tip) return { hasWork: false, landed: false, clean: false };
	const [base, created, own] = await Promise.all([
		readBase(worktree.baseCwd),
		createdAt(worktree.baseCwd, worktree.branch),
		dirtiness(worktree.path).catch(() => null),
	]);
	const state = await landing(worktree.baseCwd, base, tip);
	return {
		hasWork: created !== undefined && created !== tip,
		landed: state.landed,
		...(state.squashed ? { squashed: true as const } : {}),
		clean: own !== null && own.tracked === 0 && own.untracked === 0,
	};
}

/** A linked worktree as a listing of worktrees no session holds sees it: its branch is null on a detached HEAD. */
export interface StandingRef {
	path: string;
	branch: string | null;
	baseCwd: string;
}

export interface WorktreeStanding {
	/** As `LandingFacts.hasWork`; false on a detached HEAD, which was never created as a branch. */
	hasWork: boolean;
	/** HEAD's work is in the parent's HEAD or upstream, by ancestry or by content. */
	landed: boolean;
	squashed?: true;
	/** Commits of its own against where its work would start (as `BranchFacts.commitsAhead`); 0 once landed. */
	commitsAhead: number;
	/** Tracked changes plus untracked files in the worktree. */
	dirtyFiles: number;
}

/** `landingFacts` and `branchFacts` for the worktree's HEAD in one read, whether or not it has a branch. */
export async function worktreeStanding(worktree: StandingRef): Promise<WorktreeStanding> {
	const [base, tip] = await Promise.all([readBase(worktree.baseCwd), text(worktree.path, ["rev-parse", "HEAD"])]);
	const [state, created, own] = await Promise.all([
		landing(worktree.baseCwd, base, tip),
		worktree.branch ? createdAt(worktree.baseCwd, worktree.branch) : undefined,
		dirtiness(worktree.path),
	]);
	const ahead = state.landed ? "0" : await text(worktree.baseCwd, ["rev-list", "--count", tip, `^${state.diffBase}`]);
	return {
		hasWork: created !== undefined && created !== tip,
		landed: state.landed,
		...(state.squashed ? { squashed: true as const } : {}),
		commitsAhead: Number(ahead) || 0,
		dirtyFiles: own.tracked + own.untracked,
	};
}

/** What a safe removal did: worktree and branch gone, the worktree gone but `branch -d` kept the branch, or nothing. */
export type WorktreeRemoval = "removed" | "branch-kept" | null;

/**
 * `git worktree remove` without `--force` of `worktreePath`, only when git lists it as a linked worktree of the
 * repository at `baseCwd` (the primary checkout never goes); git itself refuses one with uncommitted or untracked files
 * or locked. Returns the primary checkout's path when the worktree went, else null.
 */
export async function removeLinkedWorktree(baseCwd: string, worktreePath: string): Promise<string | null> {
	const listed = (await text(baseCwd, ["worktree", "list", "--porcelain"]))
		.split("\n")
		.filter(line => line.startsWith("worktree "))
		.map(line => line.slice("worktree ".length));
	const [primary, ...linked] = await Promise.all(listed.map(entry => realpath(entry).catch(() => entry)));
	const wanted = await realpath(worktreePath).catch(() => worktreePath);
	if (!linked.includes(wanted)) return null;
	const main = primary ?? baseCwd;
	const removed = await gitRaw(main, ["worktree", "remove", wanted], { timeoutMs: TIMEOUT_MS });
	return removed.code === 0 ? main : null;
}

/**
 * Remove an agent session's worktree and its branch, losing nothing: only a registered linked worktree with no
 * uncommitted or untracked file whose work has landed in the parent's HEAD or upstream (an untouched branch has; a
 * squash-merged one has by content) goes (`worktree remove` without `--force` refuses a dirty one too), and the branch
 * only with `branch -d`, which refuses an unmerged one: a squash-merged branch keeps it (`branch-kept`). `keepBranch`
 * leaves the branch whatever it holds (`branch-kept`). Null when anything held it back.
 */
export async function removeSafeWorktree(
	worktree: WorktreeRef,
	options: { keepBranch?: boolean } = {},
): Promise<WorktreeRemoval> {
	const facts = await landingFacts(worktree);
	if (!facts.landed || !facts.clean) return null;
	const primary = await removeLinkedWorktree(worktree.baseCwd, worktree.path);
	if (!primary) return null;
	if (options.keepBranch) return "branch-kept";
	const branch = await gitRaw(primary, ["branch", "-d", worktree.branch]);
	return branch.code === 0 ? "removed" : "branch-kept";
}

/**
 * Take back a worktree and branch an open just made and nobody used: a registered linked worktree with no uncommitted
 * or untracked file (`worktree remove` without `--force`), and the branch only while its reflog still holds just the
 * entry that created it, deleted with `update-ref -d` against that very commit, so a branch something moved meanwhile
 * stays. Unlike `removeSafeWorktree` it does not ask whether the tip landed in the parent's HEAD: a branch cut from the
 * default branch is ahead of a parent checkout that was not pulled, and `branch -d` kept it (v0.46.0).
 *
 * `git worktree remove` deletes ignored files without asking (a seeded `.env` someone edited, a setup hook's
 * database), so `prepare` runs first, as before every removal (disk care's `archiveBeforeRemove`): what no tool makes
 * again is archived and listed under Saved worktrees; a `prepare` that throws keeps the worktree.
 */
export async function discardNewWorktree(worktree: WorktreeRef, prepare: BeforeRemove): Promise<WorktreeRemoval> {
	const ref = `refs/heads/${worktree.branch}`;
	const log = await gitRaw(worktree.baseCwd, ["reflog", "show", "--format=%H", ref]);
	if (log.code !== 0) return null;
	const entries = log.stdout.toString("utf8").split("\n").filter(Boolean);
	if (entries.length !== 1) return null;
	const tip = entries[0] as string;
	if ((await text(worktree.path, ["rev-parse", "HEAD"]).catch(() => "")) !== tip) return null;
	const listed = await text(worktree.baseCwd, ["worktree", "list", "--porcelain"]);
	const repo = /^worktree (.+)$/m.exec(listed)?.[1] ?? worktree.baseCwd;
	const path = await realpath(worktree.path).catch(() => worktree.path);
	let settle: (removed: boolean) => Promise<void>;
	try {
		settle = await prepare({
			path,
			branch: worktree.branch,
			repo,
			state: "untouched",
			commitsAhead: 0,
			dirtyFiles: 0,
			modifiedAt: Date.now(),
		});
	} catch {
		return null;
	}
	const primary = await removeLinkedWorktree(worktree.baseCwd, worktree.path);
	await settle(primary !== null);
	if (!primary) return null;
	const deleted = await gitRaw(primary, ["update-ref", "-d", ref, tip]);
	return deleted.code === 0 ? "removed" : "branch-kept";
}

/** Why a merge of this branch cannot go ahead (what it would lose or tangle), or null. */
export function mergeProblem(worktree: WorktreeRef, facts: BranchFacts): string | null {
	if (!facts.baseBranch)
		return `The parent checkout (${worktree.baseCwd}) is on a detached HEAD; check out a branch there first.`;
	if (facts.uncommitted > 0)
		return `${worktree.branch} has ${facts.uncommitted} uncommitted file(s) in ${worktree.path}; ask that session to commit them first (ompdesk_session_send).`;
	if (facts.baseUncommitted > 0)
		return `${worktree.baseCwd} has ${facts.baseUncommitted} uncommitted file(s); commit or stash them first so the merge cannot mix with them.`;
	if (facts.merged || facts.commitsAhead === 0)
		return `${worktree.branch} has nothing to merge into ${facts.baseBranch}.`;
	return null;
}

/**
 * Merge the worktree's branch into the parent checkout's current branch with a merge commit. Refuses what a
 * merge would lose or tangle (`mergeProblem`), and a merge `predictMerge` says would conflict is never started.
 */
export async function mergeBranch(worktree: WorktreeRef, label: string): Promise<MergeOutcome> {
	const facts = await branchFacts(worktree);
	const problem = mergeProblem(worktree, facts);
	if (problem) throw new BranchError(problem);
	const prediction = await predictMerge(worktree);
	if (prediction.kind === "conflict")
		return { merged: false, reason: "conflict", files: prediction.files, predicted: true };
	const message = `Merge ${worktree.branch} into ${facts.baseBranch}${label ? ` (${label})` : ""}`;
	const result = await gitRaw(worktree.baseCwd, ["merge", "--no-ff", "--no-edit", "-m", message, worktree.branch], {
		timeoutMs: TIMEOUT_MS,
	});
	if (result.code !== 0) {
		const conflicted = await gitRaw(worktree.baseCwd, ["diff", "--name-only", "--diff-filter=U"]);
		const files = conflicted.stdout.toString("utf8").split("\n").filter(Boolean);
		await gitRaw(worktree.baseCwd, ["merge", "--abort"]);
		if (files.length > 0) return { merged: false, reason: "conflict", files, predicted: false };
		throw new BranchError(`git merge failed: ${result.stderr.trim() || `exit ${result.code}`}`);
	}
	const sha = await text(worktree.baseCwd, ["rev-parse", "--short", "HEAD"]);
	const summary = await text(worktree.baseCwd, ["diff", "--shortstat", "HEAD~1", "HEAD"]);
	return { merged: true, sha, summary };
}
