/**
 * `get_git_unlanded`: what a session's own branch has not landed in the default branch yet: its commits and its
 * uncommitted and untracked work, measured from the merge-base with the remote's default branch (`origin/HEAD`, else
 * `origin/main`/`origin/master`, else a local `main`/`master`). Null on the default branch itself, where sessions share
 * one working tree and nothing in it is one session's, on a detached HEAD and outside a repository. The core process
 * reads it (`native/ompdesk/crates/core/src/git/unlanded.rs`, `git.unlanded`); this is its typed client.
 */
import type { RpcGitUnlanded } from "../../../shared/rpc-types";
import { coreGit } from "./exec";

/** Ten gits one after another at most: root, branch, origin/HEAD, five candidates, merge-base, then three at once. */
export function getGitUnlanded(cwd: string): Promise<RpcGitUnlanded | null> {
	return coreGit("git.unlanded", { cwd }, 10);
}
