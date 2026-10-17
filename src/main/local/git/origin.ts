/**
 * The project a folder belongs to, from git alone (`shared/project-origin.ts` words it): the common git dir names
 * the main checkout, the git dir tells a linked worktree from the main one, the branch says what the worktree is
 * for. Nothing is stored; a lookup is cached per folder for a short while because a sidebar asks for every row on
 * each render pass.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { deriveProjectOrigin, type OriginFacts, type ProjectOrigin } from "../../../shared/project-origin";
import { gitRaw } from "./exec";

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

async function out(cwd: string, args: string[]): Promise<string | null> {
	const result = await gitRaw(cwd, args, { timeoutMs: GIT_MS }).catch(() => null);
	return result?.code === 0 ? result.stdout.toString("utf8").trim() || null : null;
}

async function readFacts(cwd: string): Promise<OriginFacts | null> {
	const dirs = await out(cwd, ["rev-parse", "--git-common-dir", "--git-dir"]);
	const [commonRaw, gitDirRaw] = dirs?.split(/\r?\n/) ?? [];
	if (!commonRaw || !gitDirRaw) return null;
	const commonDir = path.resolve(cwd, commonRaw);
	const gitDir = path.resolve(cwd, gitDirRaw);
	const [branch, toplevel, listing] = await Promise.all([
		out(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]),
		out(cwd, ["rev-parse", "--show-toplevel"]),
		// Only a git dir that is not `<main>/.git` (bare, relocated) needs the worktree list.
		path.basename(commonDir) === ".git" ? Promise.resolve(null) : out(cwd, ["worktree", "list", "--porcelain"]),
	]);
	return {
		commonDir,
		gitDir,
		branch,
		toplevel: toplevel ? path.resolve(toplevel) : null,
		primary: listing ? (/^worktree (.+)$/m.exec(listing)?.[1] ?? null) : null,
	};
}

async function lookup(cwd: string): Promise<ProjectOrigin | null> {
	const facts = await readFacts(cwd);
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
