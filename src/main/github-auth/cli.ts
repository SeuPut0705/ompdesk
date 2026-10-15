/**
 * The GitHub CLI and git facts the in-app sign-in needs: `gh auth status`
 * (active account, the other signed-in ones), `gh api user` (commit identity)
 * and `git config --global user.*`. Every call goes through `GhRunner`, so
 * tests drive a fake gh and a temp HOME / GIT_CONFIG_GLOBAL.
 *
 * gh quirks kept here (also in mixdog's github-cli.ts, which this re-derives):
 * - plain `gh auth status` exits 1 when ANY stored github.com account has a
 *   stale token, so signed-in is read with `--active`; gh < 2.40 has no
 *   `--active` ("unknown flag") and falls back to the plain call;
 * - gh ≥ 2.40 prints "Logged in to github.com account <login>", older builds
 *   "Logged in to github.com as <login>"; either may land on stdout or stderr.
 */
import type { GithubAuthStatus, GitIdentity } from "../../shared/github-auth";

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Runs one gh/git call to completion; never rejects on a non-zero exit. */
export type GhRunner = (bin: string, args: string[]) => Promise<RunResult>;

const HOST = ["--hostname", "github.com"];

/** The active-account login in `gh auth status` output. */
export function loginFromAuthOutput(output: string): string | null {
	return /Logged in to \S+ account\s+(\S+)/.exec(output)?.[1] ?? /Logged in to \S+ as (\S+)/.exec(output)?.[1] ?? null;
}

/**
 * Every signed-in github.com account in plain `gh auth status` output (gh ≥ 2.40
 * lists each with "- Active account: true|false"); accounts whose token failed
 * ("X Failed to log in …") are left out, `gh auth switch` could not use them.
 */
export function accountsFromAuthOutput(output: string): Array<{ login: string; active: boolean }> {
	const accounts: Array<{ login: string; active: boolean }> = [];
	let current: { login: string; active: boolean } | null = null;
	for (const line of output.split(/\r?\n/)) {
		const login = /✓ Logged in to \S+ account\s+(\S+)/.exec(line)?.[1];
		if (login) {
			current = { login, active: false };
			accounts.push(current);
			continue;
		}
		if (/Failed to log in/.test(line)) {
			current = null;
			continue;
		}
		if (current && /Active account:\s*true/i.test(line)) current.active = true;
	}
	return accounts;
}

export async function ghVersion(run: GhRunner, gh: string): Promise<string | null> {
	const probe = await run(gh, ["--version"]);
	return probe.code === 0 ? (/gh version (\S+)/.exec(probe.stdout)?.[1] ?? null) : null;
}

/** github.com sign-in status through `gh` at `gh`. */
export async function ghAuthStatus(
	run: GhRunner,
	gh: string,
): Promise<Omit<GithubAuthStatus, "installed" | "version">> {
	let auth = await run(gh, ["auth", "status", ...HOST, "--active"]);
	if (auth.code !== 0 && /unknown flag:? --active/i.test(`${auth.stdout}\n${auth.stderr}`)) {
		auth = await run(gh, ["auth", "status", ...HOST]);
	}
	if (auth.code !== 0) return { authenticated: false, login: null, otherAccounts: [] };
	const login = loginFromAuthOutput(`${auth.stdout}\n${auth.stderr}`);
	const all = await run(gh, ["auth", "status", ...HOST]);
	const otherAccounts = accountsFromAuthOutput(`${all.stdout}\n${all.stderr}`)
		.filter(account => account.login !== login)
		.map(account => account.login);
	return { authenticated: true, login, otherAccounts: [...new Set(otherAccounts)] };
}

/**
 * The signed-in account as a commit identity: its display name (or login) and
 * its public email, or GitHub's noreply address when it has none (the address
 * GitHub itself suggests for commits).
 */
export async function ghAccountIdentity(run: GhRunner, gh: string): Promise<{ name: string; email: string }> {
	const result = await run(gh, ["api", "user"]);
	if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "gh api user failed");
	const data: unknown = JSON.parse(result.stdout);
	if (typeof data !== "object" || data === null) throw new Error("gh api user returned no account");
	const user = data as { login?: unknown; id?: unknown; name?: unknown; email?: unknown };
	if (typeof user.login !== "string" || !user.login) throw new Error("gh api user returned no login");
	const id = typeof user.id === "number" && Number.isSafeInteger(user.id) ? `${user.id}+` : "";
	return {
		name: typeof user.name === "string" && user.name.trim() ? user.name.trim() : user.login,
		email:
			typeof user.email === "string" && user.email.trim()
				? user.email.trim()
				: `${id}${user.login}@users.noreply.github.com`,
	};
}

export async function gitIdentity(run: GhRunner, git: string): Promise<GitIdentity> {
	const [name, email] = await Promise.all(
		["user.name", "user.email"].map(async key => {
			// Exit 1 = unset.
			const result = await run(git, ["config", "--global", "--get", key]);
			return result.code === 0 ? result.stdout.trim() || null : null;
		}),
	);
	return { name: name ?? null, email: email ?? null };
}

/** Set `user.name` / `user.email` from `account`, each only while it is empty; returns the keys it set. */
export async function fillGitIdentity(
	run: GhRunner,
	git: string,
	account: { name: string; email: string },
): Promise<Array<"name" | "email">> {
	const current = await gitIdentity(run, git);
	const filled: Array<"name" | "email"> = [];
	for (const field of ["name", "email"] as const) {
		if (current[field]) continue;
		const result = await run(git, ["config", "--global", `user.${field}`, account[field]]);
		if (result.code !== 0) throw new Error(result.stderr.trim() || `git config user.${field} failed`);
		filled.push(field);
	}
	return filled;
}

/** Sign the active account out (gh ≥ 2.40 needs `--user` when several are signed in). */
export async function ghLogout(run: GhRunner, gh: string, login: string | null): Promise<void> {
	const base = ["auth", "logout", ...HOST];
	let result = await run(gh, base);
	if (result.code !== 0 && login) result = await run(gh, [...base, "--user", login]);
	if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "gh auth logout failed");
}

export async function ghSwitch(run: GhRunner, gh: string, login: string): Promise<void> {
	const result = await run(gh, ["auth", "switch", ...HOST, "--user", login]);
	if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "gh auth switch failed");
}

/**
 * Whether the signed-in account starred `repo` (`owner/name`): GitHub answers
 * `GET /user/starred/{repo}` with 204 when it did and 404 when it did not, and
 * gh exits non-zero on the 404.
 */
export async function ghRepoStarred(run: GhRunner, gh: string, repo: string): Promise<boolean> {
	const result = await run(gh, ["api", `user/starred/${repo}`, "--silent"]);
	if (result.code === 0) return true;
	if (/HTTP 404|Not Found/i.test(`${result.stdout}\n${result.stderr}`)) return false;
	throw new Error(result.stderr.trim() || result.stdout.trim() || "gh api user/starred failed");
}

/** Star `repo` for the signed-in account (`PUT /user/starred/{repo}`; GitHub answers 204). */
export async function ghStarRepo(run: GhRunner, gh: string, repo: string): Promise<void> {
	const result = await run(gh, ["api", "--method", "PUT", `user/starred/${repo}`, "--silent"]);
	if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "gh api star failed");
}
