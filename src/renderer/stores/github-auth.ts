/**
 * This machine's GitHub CLI sign-in (src/shared/github-auth.ts), mirrored from
 * main: `refresh()` subscribes once and asks for a (possibly cached) check. The
 * renderer only shows the state and asks for actions; main runs gh and git.
 */

import { create } from "zustand";
import { EMPTY_GITHUB_AUTH_STATE, type GithubAuthState } from "../../shared/github-auth";
import { toastError } from "./toast";

interface GithubAuthStore {
	state: GithubAuthState;
	/** Subscribe (once) and re-check, unless main has a recent check cached (`force` re-checks now). */
	refresh: (force?: boolean) => Promise<void>;
	/** Run one main action and adopt the state it returns; an IPC failure toasts `failedTitle`. */
	run: (action: (api: Window["omp"]["githubAuth"]) => Promise<GithubAuthState>, failedTitle: string) => Promise<void>;
	reset: () => void;
}

let unsubscribe: (() => void) | null = null;

export const useGithubAuthStore = create<GithubAuthStore>()(set => ({
	state: EMPTY_GITHUB_AUTH_STATE,
	refresh: async (force = false) => {
		try {
			unsubscribe ??= window.omp.githubAuth.onState(state => set({ state }));
			set({ state: await window.omp.githubAuth.refresh(force) });
		} catch {
			// The pushed state carries a check failure; a failed IPC leaves the last state.
		}
	},
	run: async (action, failedTitle) => {
		try {
			set({ state: await action(window.omp.githubAuth) });
		} catch (error) {
			toastError({ title: failedTitle, error });
		}
	},
	reset: () => {
		unsubscribe?.();
		unsubscribe = null;
		set({ state: EMPTY_GITHUB_AUTH_STATE });
	},
}));
