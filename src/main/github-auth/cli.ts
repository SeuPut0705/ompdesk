/**
 * The GitHub CLI and git facts the in-app sign-in needs, read and changed in the core process
 * (`native/ompdesk/crates/core/src/gh/auth.rs`): `gh auth status` (active account, the other signed-in ones), gh's
 * version, git's global identity, the identity filled from the account, sign-out, the switch to another account and
 * the star. Each is one request carrying gh's and git's runners (`ghRunner`, `null` for a tool not found), whose runs
 * the core makes as `ghText` made them (30 s each, every exit code answered); a failure rejects with gh's or git's
 * own words.
 */
import type { GithubAuthStatus, GitIdentity } from "../../shared/github-auth";
import { type CoreRunner, coreHeld, GH_TEXT_TIMEOUT_MS } from "../local/git/exec";

/** gh and git as the sign-in found them, and the folder they run in. */
export interface AuthTools {
	gh: CoreRunner | null;
	git: CoreRunner | null;
	cwd: string;
}

/** A request whose runs take at most `rounds` of `ghText`'s timeout one after another. */
function authRequest<T>(method: string, params: object, rounds: number): Promise<T> {
	return coreHeld<T>(method, params, rounds * GH_TEXT_TIMEOUT_MS);
}

/** gh's version and sign-in (signed out without gh) and git's identity (null without git). */
export function authCheck(tools: AuthTools): Promise<{ identity: GitIdentity | null; status: GithubAuthStatus }> {
	// `--version` beside up to three `gh auth status` runs.
	return authRequest("gh.authCheck", tools, 3);
}

/** Set git's `user.name` / `user.email` from the signed-in account, each only while empty: the keys set, the identity after. */
export function authFillIdentity(
	tools: AuthTools,
): Promise<{ identityFilled: Array<"name" | "email">; identity: GitIdentity }> {
	// `gh api user`, git's identity, two sets, git's identity again.
	return authRequest("gh.authIdentity", tools, 5);
}

/** Sign the active account out (gh ≥ 2.40 needs `--user` when several are signed in). */
export async function authLogout(tools: AuthTools, login: string | null): Promise<void> {
	await authRequest("gh.authLogout", { ...tools, login }, 2);
}

export async function authSwitch(tools: AuthTools, login: string): Promise<void> {
	await authRequest("gh.authSwitch", { ...tools, login }, 1);
}

/** Star `repo` (`owner/name`) for the signed-in account (`star`), or read whether it did. */
export function repoStar(tools: AuthTools, repo: string, star: boolean): Promise<boolean> {
	return authRequest("gh.star", { ...tools, repo, star }, 1);
}
