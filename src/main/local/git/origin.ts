/**
 * The project a folder belongs to, from git alone (`shared/project-origin.ts` words it): the common git dir names
 * the main checkout, the git dir tells a linked worktree from the main one, the branch says what the worktree is
 * for. Nothing is stored; a lookup is cached per folder for a short while because a sidebar asks for every row on
 * each render pass. The core process reads the facts (`native/ompdesk/crates/core/src/git/origin.rs`,
 * `git.originFacts`); the cache stays here, shared by every caller of this process and deduplicating a folder's
 * concurrent lookups, with the clock its callers pass.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { deriveProjectOrigin, type OriginFacts, type ProjectOrigin } from "../../../shared/project-origin";
import { coreGit } from "./exec";

/** Each git's timeout; the lookup runs two of them one after another. */
const GIT_MS = 10_000;
/** A branch can move (a checkout inside the worktree), so a known answer is only reused briefly. */
const KNOWN_TTL_MS = 30_000;
/** A folder git does not know (no repository, a removed worktree) is asked again soon. */
const UNKNOWN_TTL_MS = 5_000;
const MAX_CACHED = 500;

const cache = new Map<string, { at: number; origin: Promise<ProjectOrigin | null>; known: boolean }>();

export function resetProjectOriginCache(): void {
	cache.clear();
}

/**
 * What git says about `cwd`'s checkout (common dir, git dir, branch, top level), uncached; null outside a repository,
 * and whenever git cannot answer.
 */
export function readOriginFacts(cwd: string): Promise<OriginFacts | null> {
	return coreGit<OriginFacts | null>(
		"git.originFacts",
		{ cwd: path.resolve(cwd), timeoutMs: GIT_MS },
		0,
		2 * GIT_MS,
	).catch(() => null);
}

async function lookup(cwd: string): Promise<ProjectOrigin | null> {
	const facts = await readOriginFacts(cwd);
	const origin = facts ? deriveProjectOrigin(facts) : null;
	if (!origin) return null;
	// One spelling of the main checkout whichever worktree asked (macOS /var vs /private/var).
	const root = await fs.realpath(origin.root).catch(() => origin.root);
	return { ...origin, root };
}

/** The project `cwd` belongs to, or null when git cannot say (no repository, a missing folder, no git). */
export async function readProjectOrigin(cwd: string, now: () => number = Date.now): Promise<ProjectOrigin | null> {
	// A folder that is gone (a discarded worktree) answers null at once, whatever the cache still remembers.
	if (
		!(await fs.stat(cwd).then(
			() => true,
			() => false,
		))
	) {
		cache.delete(cwd);
		return null;
	}
	const cached = cache.get(cwd);
	const stamp = now();
	if (cached && stamp - cached.at < (cached.known ? KNOWN_TTL_MS : UNKNOWN_TTL_MS)) return cached.origin;
	const entry = { at: stamp, known: false, origin: lookup(cwd) };
	entry.origin = entry.origin.then(origin => {
		entry.known = origin !== null;
		return origin;
	});
	if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
	cache.set(cwd, entry);
	return entry.origin;
}
