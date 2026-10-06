/** Git / worktree / PR commands (rpc-map §5), answered in main over the git and gh CLIs. */
import { getGitChanges, getGitDiff, getGitStatus } from "./git/changes";
import { prCheckout, prCreate, prDiff, prDraft, prGet, prList, prRepo } from "./git/pr";
import { createWorktree, removeWorktree } from "./git/worktree";
import type { LocalHandler } from "./types";

const str = (value: unknown) => (typeof value === "string" ? value : undefined);

export const handlers: Record<string, LocalHandler> = {
	get_git_status: (_command, ctx) => getGitStatus(ctx.cwd),
	get_git_changes: (_command, ctx) => getGitChanges(ctx.cwd),
	get_git_diff: (command, ctx) => getGitDiff(ctx.cwd, str(command.path) ?? ""),
	worktree_create: (command, ctx) =>
		createWorktree(ctx.cwd, {
			name: str(command.name) ?? "",
			baseCwd: str(command.baseCwd),
			baseRef: command.baseRef === "default" ? "default" : "HEAD",
		}),
	worktree_remove: command => removeWorktree({ path: str(command.path) ?? "", force: command.force === true }),
	pr_repo: (_command, ctx) => prRepo(ctx.cwd),
	pr_list: (command, ctx) =>
		prList(ctx.cwd, {
			state: command.state as "open" | "closed" | "merged" | "all" | undefined,
			limit: typeof command.limit === "number" ? command.limit : undefined,
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
	pr_checkout: (command, ctx) => prCheckout(ctx.cwd, { number: Number(command.number) }),
};
