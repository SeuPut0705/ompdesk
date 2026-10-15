/**
 * In-app GitHub sign-in (src/main/github-auth/): the GitHub CLI's login on this
 * machine, a device-code `gh auth login --web` run inside a PTY, and the git
 * commit identity it fills in when the user has none. Main owns the state and
 * pushes every change; the renderer only shows it and asks for actions.
 */

/** What `gh auth status` says about github.com on this machine. */
export interface GithubAuthStatus {
	/** gh was found on the spawn PATH (the user's or the managed tools directory). */
	installed: boolean;
	/** `gh --version`, e.g. `2.62.0`; null when unknown. */
	version: string | null;
	/** The active github.com account is signed in (`gh auth status --active`). */
	authenticated: boolean;
	/** The active account's login. */
	login: string | null;
	/** Other signed-in github.com accounts `gh auth switch` can make active. */
	otherAccounts: string[];
}

/** Why a sign-in ended without an account; the renderer words each one. */
export type GithubLoginFailure = "gh_missing" | "timeout" | "not_signed_in" | "exited" | "spawn_failed";

export type GithubLoginFlow =
	/** gh is starting; no code yet. */
	| { state: "starting" }
	/** The device code is on screen; `opened` once the user asked for the GitHub page (gh then polls for approval). */
	| { state: "code"; code: string; url: string; opened: boolean }
	| { state: "success"; login: string | null }
	| { state: "failed"; reason: GithubLoginFailure; detail?: string };

/** `git config --global user.name / user.email` as they are now (null = unset). */
export interface GitIdentity {
	name: string | null;
	email: string | null;
}

export type GithubAuthAction = "logout" | "switch" | "identity";

export interface GithubAuthState {
	/** null until the first check finishes. */
	status: GithubAuthStatus | null;
	checking: boolean;
	/** The live (or last finished) sign-in; null when none ran or it was cancelled. */
	flow: GithubLoginFlow | null;
	identity: GitIdentity | null;
	/** Keys the last sign-in filled from the GitHub account (only keys that were empty). */
	identityFilled: Array<"name" | "email">;
	/** The running sign-out / account switch / identity fill. */
	busy: GithubAuthAction | null;
	/** The last action's failure (raw gh/git message). */
	error: { action: GithubAuthAction | "check"; message: string } | null;
}

export const EMPTY_GITHUB_AUTH_STATE: GithubAuthState = {
	status: null,
	checking: false,
	flow: null,
	identity: null,
	identityFilled: [],
	busy: null,
	error: null,
};

/** A sign-in is waiting on gh or on the user. */
export function githubLoginLive(flow: GithubLoginFlow | null): boolean {
	return flow?.state === "starting" || flow?.state === "code";
}

/**
 * Whether the signed-in GitHub account starred OMPdesk's repository (About and
 * the starter guide's last step): `starred` null = unknown (gh missing, signed
 * out, or the call failed, then `error` says why).
 */
export interface GithubStarState {
	starred: boolean | null;
	error: "gh_missing" | "not_signed_in" | "failed" | null;
	message?: string;
}
