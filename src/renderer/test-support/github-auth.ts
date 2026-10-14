/**
 * A `window.omp.githubAuth` double: every action resolves with the state the
 * test set for it (default: the current one), and `push` delivers a main push.
 */
import { vi } from "vitest";
import { EMPTY_GITHUB_AUTH_STATE, type GithubAuthState } from "../../shared/github-auth";

export function githubState(partial: Partial<GithubAuthState> = {}): GithubAuthState {
	return {
		...EMPTY_GITHUB_AUTH_STATE,
		status: { installed: true, version: "2.62.0", authenticated: false, login: null, otherAccounts: [] },
		identity: { name: null, email: null },
		...partial,
	};
}

export function fakeGithubAuth(initial: GithubAuthState = githubState()) {
	let current = initial;
	const listeners = new Set<(state: GithubAuthState) => void>();
	const answer = () => vi.fn(async (..._args: unknown[]) => current);
	const api = {
		refresh: answer(),
		startLogin: answer(),
		openLogin: answer(),
		cancelLogin: answer(),
		logout: answer(),
		switchAccount: answer(),
		fillIdentity: answer(),
		onState: vi.fn((callback: (state: GithubAuthState) => void) => {
			listeners.add(callback);
			return () => listeners.delete(callback);
		}),
	};
	return {
		api,
		/** The state the next action answers with. */
		set(state: GithubAuthState) {
			current = state;
		},
		/** A push from main. */
		push(state: GithubAuthState) {
			current = state;
			for (const listener of listeners) listener(state);
		},
	};
}
