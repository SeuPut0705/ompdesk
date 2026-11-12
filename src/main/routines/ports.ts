/**
 * The real ports of the routine triggers (`RoutineTriggerDeps`): the person's `gh`, `original-fs`'s watcher, the git
 * exec helper and the tab pool. Kept apart from the sources so their tests need none of these.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { promises as fs, type Stats, watch } from "original-fs";
import { coreGit, gh, resolveBin } from "../local/git/exec";
import type { SidecarPool } from "../sidecar-pool";
import { FILES_LISTING_MAX, type FilesListing, IGNORED_DIRS, type ScanPath, type WatchPath } from "./files";
import type { GitPort } from "./git";
import type { GhApi } from "./github";
import type { SessionPorts } from "./sessions";

/** A `gh api` call that answers within this long, or fails (the exec helper's own default is a minute). */
const GH_TIMEOUT_MS = 30_000;

/** `gh api <endpoint>` with the person's own sign-in: the exec helper's environment, PATH and kill timeout. */
export const ghApi: GhApi = async endpoint => {
	const bin = await resolveBin("gh");
	if (!bin) throw new Error("the GitHub CLI (gh) is not installed");
	// An endpoint names its repository, so no repository folder is needed.
	return JSON.parse(await gh(homedir(), bin, ["api", endpoint], { timeoutMs: GH_TIMEOUT_MS })) as unknown;
};

/** `original-fs`, never `fs`: Electron's patched `fs` opens and keeps every `.asar` it meets in a watched folder. */
export const watchPath: WatchPath = (path, onChange, onError) => {
	const watcher = watch(path, { recursive: true }, (_event, filename) => onChange(filename ? String(filename) : null));
	watcher.on("error", onError);
	return watcher;
};

const stamp = (stats: Stats): string => `${Math.trunc(stats.mtimeMs)}:${stats.size}`;

/**
 * The files under `path` in name order (`original-fs`, as the watcher), up to `FILES_LISTING_MAX`; folders it cannot
 * read and files gone meanwhile are passed over. Symbolic links are listed, not followed.
 */
export const scanPath: ScanPath = async path => {
	let top: Stats;
	try {
		top = await fs.lstat(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return null;
		throw error;
	}
	if (!top.isDirectory()) return { entries: { "": stamp(top) }, complete: true };
	const listing: FilesListing = { entries: {}, complete: true };
	let count = 0;
	const walk = async (dir: string, prefix: string): Promise<void> => {
		const items = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
		items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const item of items) {
			if (!listing.complete) return;
			const name = prefix ? `${prefix}/${item.name}` : item.name;
			if (item.isDirectory()) {
				if (!IGNORED_DIRS.includes(item.name)) await walk(join(dir, item.name), name);
				continue;
			}
			if (count >= FILES_LISTING_MAX) {
				listing.complete = false;
				return;
			}
			const stats = await fs.lstat(join(dir, item.name)).catch(() => null);
			if (!stats) continue;
			listing.entries[name] = stamp(stats);
			count++;
		}
	};
	await walk(path, "");
	return listing;
};

export const gitPort: GitPort = {
	head: (repo, branch) => coreGit<string | null>("git.routineHead", { repo, branch }, 1),
	commits: (repo, from, to) =>
		coreGit<{ total: number; lines: string[] }>("git.routineCommits", { repo, from, to }, 2),
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
