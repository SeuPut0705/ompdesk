/**
 * Reads what the start sheet's branch picker and a start's branch checks need of a repository: the local branches,
 * the ship remote's branches, which worktree has which branch checked out and the default branch. The rules over
 * these facts are pure (`src/shared/autopilot-branch.ts`).
 */
import type { AutopilotBranchEntry, AutopilotBranchInfo } from "../../resources/gui-bridge/modes/autopilot-contracts";
import {
	type BranchFacts,
	branchEntries,
	lastChoiceOf,
	parseWorktreeBranches,
	pickDefaultBranch,
	suggestBranchName,
} from "../shared/autopilot-branch";
import { gitRaw } from "./local/git/exec";

const GIT_MS = 30_000;

async function gitLines(cwd: string, args: string[]): Promise<string[]> {
	const result = await gitRaw(cwd, args, { timeoutMs: GIT_MS }).catch(() => null);
	if (result?.code !== 0) return [];
	return result.stdout
		.toString("utf8")
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
}

/** The repository's branches as git has them now; `remote` is the ship remote whose branches count. */
export async function readBranchFacts(cwd: string, remote: string): Promise<BranchFacts> {
	const [heads, remotes, worktrees, current, remoteHead] = await Promise.all([
		gitLines(cwd, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads"]),
		gitLines(cwd, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)", `refs/remotes/${remote}`]),
		gitRaw(cwd, ["worktree", "list", "--porcelain"], { timeoutMs: GIT_MS }).catch(() => null),
		gitLines(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]),
		gitLines(cwd, ["symbolic-ref", "--short", "-q", `refs/remotes/${remote}/HEAD`]),
	]);
	const prefix = `refs/remotes/${remote}/`;
	const locals = heads.filter(ref => ref.startsWith("refs/heads/")).map(ref => ref.slice("refs/heads/".length));
	const remoteNames = remotes
		.filter(ref => ref.startsWith(prefix))
		.map(ref => ref.slice(prefix.length))
		.filter(name => name !== "HEAD");
	const remoteDefault = remoteHead[0]?.startsWith(`${remote}/`) ? remoteHead[0].slice(remote.length + 1) : null;
	return {
		locals,
		remotes: remoteNames,
		worktrees: worktrees?.code === 0 ? parseWorktreeBranches(worktrees.stdout.toString("utf8")) : {},
		current: current[0] ?? null,
		defaultBranch: pickDefaultBranch(remoteDefault, [...locals, ...remoteNames]),
	};
}

/** The picker's data for the repository `cwd` is in (`toplevel` its top level, the key of the remembered choice). */
export async function readBranchInfo(
	cwd: string,
	input: { toplevel: string; remote: string; date: string; pref: unknown },
): Promise<AutopilotBranchInfo> {
	const facts = await readBranchFacts(cwd, input.remote);
	const branches = branchEntries(facts);
	const last = lastChoiceOf(input.pref, input.toplevel);
	return {
		repo: input.toplevel,
		remote: input.remote,
		defaultBranch: facts.defaultBranch,
		suggested: suggestBranchName(input.date, new Set(branches.map(entry => entry.name))),
		branches,
		...(last ? { last } : {}),
	};
}

/** The entries of `readBranchFacts` (a start re-reads them: the sheet's list may be old). */
export async function readBranchEntries(
	cwd: string,
	remote: string,
): Promise<{
	entries: AutopilotBranchEntry[];
	defaultBranch: string | null;
}> {
	const facts = await readBranchFacts(cwd, remote);
	return { entries: branchEntries(facts), defaultBranch: facts.defaultBranch };
}
