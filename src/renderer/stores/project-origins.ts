import { create } from "zustand";
import type { ProjectOrigin } from "../../shared/project-origin";

/** A folder git could not place is asked again after this long (a worktree being made, a repository being cloned). */
const RETRY_UNKNOWN_MS = 10_000;
/** A lookup that failed (the computer restarting, a link that dropped) is asked again after this. */
export const RETRY_FAILED_MS = 2_000;
/** Main answers at most this many folders a call. */
const BATCH = 200;

interface ProjectOriginsState {
	/** Answered folders: the project a linked worktree comes from (or a main checkout), null when git cannot say. */
	origins: Record<string, ProjectOrigin | null>;
	/** Ask main about the folders that have no answer yet, in one call. */
	request: (cwds: readonly string[]) => void;
	/** Ask again about the linked worktrees among `cwds`: one removed since the last answer now reads null. */
	recheck: (cwds: readonly string[]) => void;
	reset: () => void;
}

/** When each folder was last asked about, and the ones on their way. */
const asked = new Map<string, number>();

export const useProjectOrigins = create<ProjectOriginsState>((set, get) => {
	function load(cwds: readonly string[]): void {
		const api = window.omp?.projectOrigins;
		if (!api || cwds.length === 0) return;
		const now = Date.now();
		for (const cwd of cwds) asked.set(cwd, now);
		for (let from = 0; from < cwds.length; from += BATCH) {
			const batch = cwds.slice(from, from + BATCH);
			api.get(batch)
				.then(answers => {
					const received = answers && typeof answers === "object" ? answers : {};
					set(state => ({
						origins: { ...state.origins, ...Object.fromEntries(batch.map(cwd => [cwd, received[cwd] ?? null])) },
					}));
				})
				.catch(() => {
					// No answer is not "git cannot place it": a null would read a worktree as a removed folder (the sidebar
					// hides those rows) until the folder list changed. Keep what was known and ask again by itself
					// (nightly 39536816829: a phone whose host restarted showed its Autopilot children as bare folders).
					setTimeout(() => load(batch), RETRY_FAILED_MS);
				});
		}
	}
	return {
		origins: {},
		request: cwds => {
			const now = Date.now();
			load(
				[...new Set(cwds)].filter(cwd => {
					if (cwd === "") return false;
					const at = asked.get(cwd);
					if (at === undefined) return true;
					return get().origins[cwd] === null && now - at >= RETRY_UNKNOWN_MS;
				}),
			);
		},
		recheck: cwds => load([...new Set(cwds)].filter(cwd => get().origins[cwd]?.worktree)),
		reset: () => {
			asked.clear();
			set({ origins: {} });
		},
	};
});
