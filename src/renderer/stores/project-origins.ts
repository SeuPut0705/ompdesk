import { create } from "zustand";
import type { ProjectOrigin } from "../../shared/project-origin";

/** A folder git could not place is asked again after this long (a worktree being made, a repo being cloned). */
const RETRY_UNKNOWN_MS = 10_000;

interface ProjectOriginsState {
	/** Answered folders: the project a linked worktree comes from (or a main checkout), null when git cannot say. */
	origins: Record<string, ProjectOrigin | null>;
	/** Ask main about the folders that have no answer yet, in one call. */
	request: (cwds: readonly string[]) => void;
	reset: () => void;
}

/** When each folder was last asked about, and the ones on their way. */
const asked = new Map<string, number>();

export const useProjectOrigins = create<ProjectOriginsState>(set => ({
	origins: {},
	request: cwds => {
		const api = window.omp?.projectOrigins;
		if (!api) return;
		const now = Date.now();
		const wanted = [...new Set(cwds)].filter(cwd => {
			if (cwd === "") return false;
			const at = asked.get(cwd);
			if (at === undefined) return true;
			const answer = useProjectOrigins.getState().origins[cwd];
			return answer === null && now - at >= RETRY_UNKNOWN_MS;
		});
		if (wanted.length === 0) return;
		for (const cwd of wanted) asked.set(cwd, now);
		// Main answers at most this many folders a call.
		for (let from = 0; from < wanted.length; from += 200) {
			const batch = wanted.slice(from, from + 200);
			api.get(batch)
				.then(answers => {
					const received = answers && typeof answers === "object" ? answers : {};
					set(state => ({
						origins: { ...state.origins, ...Object.fromEntries(batch.map(cwd => [cwd, received[cwd] ?? null])) },
					}));
				})
				.catch(() => {
					// A failed lookup leaves the folder's own name showing; the next request retries after the pause.
					for (const cwd of batch) asked.set(cwd, Date.now());
					set(state => ({ origins: { ...state.origins, ...Object.fromEntries(batch.map(cwd => [cwd, null])) } }));
				});
		}
	},
	reset: () => {
		asked.clear();
		set({ origins: {} });
	},
}));
