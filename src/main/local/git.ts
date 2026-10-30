/** Git / worktree / PR / source-control commands (rpc-map §5), answered in main over the git and gh CLIs. */

import {
	archiveBeforeRemove,
	listSavedWorktrees,
	restoreSavedWorktree,
	savedWorktreeStore,
} from "../disk/saved-worktrees";
import { gitFingerprints } from "../git-fingerprints";
import { listOrphanWorktrees, removeOrphanWorktree, sessionOpenFolders } from "../worktree-orphans";
import { getGitChanges, getGitDiff, getGitStatus, primaryRoot } from "./git/changes";
import { githubCommand } from "./git/github";
import {
	prCheckout,
	prComment,
	prComments,
	prCreate,
	prDiff,
	prDraft,
	prEdit,
	prGet,
	prList,
	prMerge,
	prRepo,
	prReview,
} from "./git/pr";
import * as scm from "./git/scm";
import { getGitUnlanded } from "./git/unlanded";
import { createWorktree, removeWorktree, worktreeBranchSource } from "./git/worktree";
import { LocalCommandError, type LocalHandler } from "./types";

const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const pathsOrAll = (value: unknown) => (value === "all" ? "all" : Array.isArray(value) ? (value as string[]) : []);

export const handlers: Record<string, LocalHandler> = {
	get_git_status: (_command, ctx) => getGitStatus(ctx.cwd),
	get_git_changes: (_command, ctx) => getGitChanges(ctx.cwd),
	// The work board's "Not in main yet" row: a session branch's commits and uncommitted work (git/unlanded.ts).
	get_git_unlanded: (_command, ctx) => getGitUnlanded(ctx.cwd),
	// One watch per checkout for the whole app answers every window's and tab's check (git-fingerprints.ts).
	get_git_fingerprint: (command, ctx) => gitFingerprints.read(ctx.cwd, str(command.root)),
	get_git_diff: (command, ctx) => getGitDiff(ctx.cwd, str(command.path) ?? ""),
	worktree_create: (command, ctx) =>
		createWorktree(
			ctx.cwd,
			{
				name: str(command.name) ?? "",
				baseCwd: str(command.baseCwd),
				baseRef: command.baseRef === "default" ? "default" : "HEAD",
				branchPrefix: str(command.branchPrefix),
				branch: worktreeBranchSource(command.branch),
			},
			ctx.bridge,
		),
	worktree_remove: (command, ctx) =>
		removeWorktree({ path: str(command.path) ?? "", force: command.force === true }, ctx.bridge, ctx.cwd),
	// Orphaned worktrees (src/main/worktree-orphans.ts): which folders sessions hold is the whole app's, not this tab's.
	get_orphan_worktrees: (_command, ctx) =>
		listOrphanWorktrees(ctx.cwd, { bridge: ctx.bridge, openFolders: sessionOpenFolders }),
	// The person asked for this removal: no process check, but what no tool makes again is archived first.
	remove_orphan_worktree: (command, ctx) =>
		removeOrphanWorktree(
			ctx.cwd,
			str(command.path) ?? "",
			{ bridge: ctx.bridge, openFolders: sessionOpenFolders },
			{ prepare: archiveBeforeRemove(savedWorktreeStore(), null) },
		),
	// Worktrees disk care saved and removed (src/main/disk/saved-worktrees.ts), for this tab's repository.
	get_saved_worktrees: async (_command, ctx) => ({
		worktrees: await listSavedWorktrees(await primaryRoot(ctx.cwd), savedWorktreeStore()),
	}),
	restore_saved_worktree: (command, ctx) =>
		primaryRoot(ctx.cwd).then(async primary => {
			const id = str(command.savedId) ?? "";
			const mine = (await listSavedWorktrees(primary, savedWorktreeStore())).some(record => record.id === id);
			if (!mine) throw new LocalCommandError(`No saved worktree ${id} in this repository.`, "not_saved");
			return restoreSavedWorktree(id, savedWorktreeStore());
		}),
	// worktree-lifecycle.ts reads `worktree.onExit` from the closing tab's live session.
	worktree_lifecycle_settings: (_command, ctx) => ctx.bridge.request("worktree_lifecycle_settings"),
	pr_repo: (_command, ctx) => prRepo(ctx.cwd),
	// Agents › GitHub: issues, Actions, releases, notifications, repositories (request validated in github.ts).
	github: (command, ctx) => githubCommand(ctx.cwd, command.request),
	pr_list: (command, ctx) =>
		prList(ctx.cwd, {
			state: command.state as "open" | "closed" | "merged" | "all" | undefined,
			limit: typeof command.limit === "number" ? command.limit : undefined,
			view: command.view === "review" || command.view === "mine" ? command.view : "all",
		}),
	pr_get: (command, ctx) => prGet(ctx.cwd, { number: Number(command.number) }),
	pr_diff: (command, ctx) => prDiff(ctx.cwd, { number: Number(command.number), path: str(command.path) ?? "" }),
	pr_draft: (command, ctx) => prDraft(ctx.cwd, ctx.omp, { base: str(command.base), head: str(command.head) }),
	pr_create: (command, ctx) =>
		prCreate(ctx.cwd, {
			title: str(command.title) ?? "",
			body: str(command.body) ?? "",
			base: str(command.base),
			head: str(command.head),
			draft: command.draft === true,
		}),
	pr_checkout: (command, ctx) => prCheckout(ctx.cwd, { number: Number(command.number) }, ctx.bridge),
	pr_merge: (command, ctx) =>
		prMerge(ctx.cwd, {
			number: Number(command.number),
			method: command.method === "squash" || command.method === "rebase" ? command.method : "merge",
			deleteBranch: command.deleteBranch === true,
		}),
	pr_review: (command, ctx) =>
		prReview(ctx.cwd, {
			number: Number(command.number),
			event: command.event === "approve" || command.event === "request_changes" ? command.event : "comment",
			body: str(command.body) ?? "",
		}),
	pr_comment: (command, ctx) => prComment(ctx.cwd, { number: Number(command.number), body: str(command.body) ?? "" }),
	pr_comments: (command, ctx) => prComments(ctx.cwd, { number: Number(command.number) }),
	pr_edit: (command, ctx) =>
		prEdit(ctx.cwd, {
			number: Number(command.number),
			title: str(command.title),
			body: str(command.body),
			base: str(command.base),
		}),
	git_stage: (command, ctx) => scm.stage(ctx.cwd, pathsOrAll(command.paths)),
	git_unstage: (command, ctx) => scm.unstage(ctx.cwd, pathsOrAll(command.paths)),
	git_discard: (command, ctx) => scm.discard(ctx.cwd, Array.isArray(command.paths) ? command.paths : []),
	git_commit: (command, ctx) =>
		scm.commit(ctx.cwd, { message: str(command.message) ?? "", amend: command.amend === true }),
	git_commit_message: (_command, ctx) => scm.commitMessage(ctx.cwd, ctx.omp),
	git_last_commit_message: (_command, ctx) => scm.lastCommitMessage(ctx.cwd),
	git_undo_commit: (_command, ctx) => scm.undoCommit(ctx.cwd),
	git_remote: (command, ctx) =>
		scm.remote(ctx.cwd, command.action === "push" || command.action === "pull" ? command.action : "fetch"),
	git_stash: (command, ctx) => scm.stash(ctx.cwd, command.action === "pop" ? "pop" : "push", str(command.message)),
	git_operation: (command, ctx) => scm.operation(ctx.cwd, command.action === "abort" ? "abort" : "continue"),
	git_branches: (_command, ctx) => scm.branches(ctx.cwd),
	git_branch: (command, ctx) =>
		scm.branch(ctx.cwd, {
			action:
				(["switch", "create", "rename", "delete", "merge"] as const).find(a => a === command.action) ?? "switch",
			name: str(command.name) ?? "",
			newName: str(command.newName),
			base: str(command.base),
			force: command.force === true,
		}),
	git_log: (command, ctx) =>
		scm.log(ctx.cwd, {
			limit: typeof command.limit === "number" ? command.limit : undefined,
			skip: typeof command.skip === "number" ? command.skip : undefined,
			query: str(command.query),
		}),
	git_commit_detail: (command, ctx) => scm.commitDetail(ctx.cwd, str(command.sha) ?? ""),
	git_commit_diff: (command, ctx) => scm.commitDiff(ctx.cwd, str(command.sha) ?? "", str(command.path) ?? ""),
	git_history_action: (command, ctx) => {
		const action = (
			[
				"checkout",
				"branch",
				"cherry_pick",
				"revert",
				"reset",
				"tag",
				"delete_tag",
				"move_earlier",
				"move_later",
			] as const
		).find(a => a === command.action);
		if (!action) throw new Error(`Unknown history action: ${String(command.action)}`);
		return scm.historyAction(ctx.cwd, {
			action,
			sha: str(command.sha) ?? "",
			mode: command.mode === "soft" || command.mode === "hard" ? command.mode : "mixed",
			name: str(command.name),
		});
	},
};
