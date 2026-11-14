/**
 * The real ports of the routine triggers (`RoutineTriggerDeps`): the core's reads (GitHub with the person's `gh`, a
 * folder's listing, git), `node:fs`'s watcher and the tab pool. Kept apart from the sources so their tests can
 * hand them stand-ins.
 */

import { watch } from "node:fs";
import { homedir } from "node:os";
import { core } from "../core/process";
import { coreGh, coreGit } from "../local/git/exec";
import type { SidecarPool } from "../sidecar-pool";
import {
	type ChangedSince,
	FILES_LISTING_MAX,
	type FilesListing,
	IGNORED_DIRS,
	type ScanPath,
	type WatchPath,
} from "./files";
import type { GitPort } from "./git";
import type { GithubPort, GithubRead } from "./github";
import type { SessionPorts } from "./sessions";

/** How long one `gh api` may take (the exec helper's own default is a minute); a push read makes two. */
const GH_TIMEOUT_MS = 30_000;

/**
 * A GitHub trigger's read in the core (`routines.github`) with the person's own `gh` and sign-in: the exec helper's
 * environment, PATH and kill timeout. `find` finds gh (`resolveBin`; a test's stand-in).
 */
export function githubPort(find?: () => Promise<string | null>): GithubPort {
	return (repo, kind, from) =>
		coreGh<GithubRead>(
			"routines.github",
			// An endpoint names its repository, so no repository folder is needed.
			{ home: homedir(), repo, kind, timeoutMs: GH_TIMEOUT_MS, ...from },
			2 * GH_TIMEOUT_MS,
			find,
		);
}

export const watchPath: WatchPath = (path, onChange, onError) => {
	const watcher = watch(path, { recursive: true }, (_event, filename) => onChange(filename ? String(filename) : null));
	watcher.on("error", onError);
	return watcher;
};

/**
 * The files under `path` in name order, up to `FILES_LISTING_MAX` (the core's `routines.filesScan`); folders it cannot
 * read and files gone meanwhile are passed over. Symbolic links are listed, not followed.
 */
export const scanPath: ScanPath = async path =>
	(
		await core().call<FilesListing | null>("routines.filesScan", {
			path,
			ignored: IGNORED_DIRS,
			max: FILES_LISTING_MAX,
		})
	).result;

/** What changed while OMPdesk was closed (the core's `routines.filesChanged`). */
export const filesChanged: ChangedSince = async (mark, listing) =>
	(await core().call<string[] | null>("routines.filesChanged", { mark, listing })).result;

export const gitPort: GitPort = {
	head: (repo, branch) => coreGit<string | null>("git.routineHead", { repo, branch }, 1),
	commits: (repo, branch, from, to) => coreGit<string | null>("git.routineCommits", { repo, branch, from, to }, 2),
};

/** The pool's tabs as session routines read them. */
export function sessionPorts(pool: Pick<SidecarPool, "observeTabs" | "resumeFacts" | "tabFacts">): SessionPorts {
	return {
		observeTabs: observer => pool.observeTabs(observer),
		tabs: () =>
			pool.resumeFacts().map(fact => ({
				tabId: fact.tabId,
				cwd: fact.cwd,
				title: pool.tabFacts(fact.tabId)?.title ?? "",
				...(fact.sessionFile === undefined ? {} : { sessionFile: fact.sessionFile }),
				...(fact.device === undefined ? {} : { device: fact.device }),
				...(fact.openedBy === undefined ? {} : { openedBy: fact.openedBy }),
				...(fact.openedBySession === undefined ? {} : { openedBySession: fact.openedBySession }),
			})),
	};
}
