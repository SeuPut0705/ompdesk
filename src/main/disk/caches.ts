/**
 * The caches disk care bounds, one table (`REGENERABLE_CACHES`): where each lives, the size past which it is cleared,
 * which running process needs it, and how it is cleared. A tool fills each of them again by itself, so a clear costs
 * time (a download, a transpile), never data. The sizes are measured by `TreeSizes`, the removals of the two caches
 * no tool clears for us run in the core (`crates/core/src/disk/cache.rs`), which takes only the tool's own entries.
 *
 * Where a cache is and what reads it were read from each tool's source, not guessed:
 * - Bun's install cache: `BUN_INSTALL_CACHE_DIR`, else `<BUN_INSTALL or ~/.bun>/install/cache`. `bun pm cache rm`
 *   deletes that folder and every `bunx-<uid>-…` folder in the temp folder (`package_manager_command.zig`), which a
 *   running `bunx` loads its package from, so it waits while an install or a `bunx` runs.
 * - Bun's runtime transpiler cache (`RuntimeTranspilerCache.zig` `reallyGetCacheDir`):
 *   `BUN_RUNTIME_TRANSPILER_CACHE_PATH` (empty or `0` turns it off), else `$XDG_CACHE_HOME/bun/@t@`, else on macOS
 *   `~/Library/Caches/bun/@t@`, else `~/.bun/install/cache/@t@` (inside the install cache: counted and cleared with
 *   it). Bun reads a missing entry as a miss, writes each entry to a temp file it renames, and makes the folder again
 *   (`fromFile`, `toFile`, `Entry.save`), so it is cleared while Bun runs: every session's omp is a Bun process, and
 *   a rule that waited for none would never clear it.
 * - npm's cache: `<npm config get cache>/_cacache` (cacache's content, index and temp folders), what
 *   `npm cache clean --force` removes. A running npm reads back what it just wrote there, so it waits while one runs.
 */
import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import type { DiskCareActionKind, DiskPartId } from "../../shared/disk-care";
import { coreHeld } from "../local/git/exec";
import { bunInstallDir } from "../setup/paths";
import { shellSpawnEnv } from "../shell-env";
import { executableName, findOnPath, launcherNames, needsShell, spawnArgs, spawnCommand } from "../spawn";

const GB = 1024 * 1024 * 1024;
/** One removal of a cache's entries in the core. */
const CLEAR_MS = 30 * 60_000;

/** How disk care reaches the tools whose caches it bounds. */
export interface CacheTools {
	/** The environment sessions' tools run with: the app's, plus what the login shell exports. */
	env(): Promise<NodeJS.ProcessEnv>;
	/** The tool's executable on that environment's PATH, or null. */
	find(name: "bun" | "npm"): Promise<string | null>;
	/** Runs it in that environment; its output, or null when it failed. */
	run(bin: string, args: string[]): Promise<string | null>;
	/** Every running process's command line, one per line; null where the platform shows none (Windows). */
	processes(): Promise<string | null>;
}

export type CachePartId = Extract<DiskPartId, "bunCache" | "bunTranspilerCache" | "npmCache">;
export type CacheActionKind = Extract<DiskCareActionKind, "bun-cache" | "bun-transpiler-cache" | "npm-cache">;

export interface RegenerableCache {
	/** Its row in the Disk breakdown. */
	part: CachePartId;
	/** The action a clear is logged and counted as. */
	action: CacheActionKind;
	/** Cleared once it takes more than this. */
	maxBytes: number;
	/** Where it is on this computer; null when there is none, or another row's folder holds it. */
	locate(tools: CacheTools): Promise<string | null>;
	/** Why it stays now (a process that needs it runs, or that cannot be told), or null. Absent: no process needs it. */
	inUse?(processes: string | null): string | null;
	/** Clears it; the reason it stayed after all, or null. */
	clear(dir: string, tools: CacheTools): Promise<string | null>;
}

/** Bun's install cache: `BUN_INSTALL_CACHE_DIR`, else `<BUN_INSTALL or ~/.bun>/install/cache`. */
export function bunCacheDir(env: NodeJS.ProcessEnv = process.env): string {
	return (
		env.BUN_INSTALL_CACHE_DIR || path.join(env.BUN_INSTALL || path.join(os.homedir(), ".bun"), "install", "cache")
	);
}

/** Bun's runtime transpiler cache as Bun resolves it (the module doc names the source); null when it is turned off. */
export function bunTranspilerCacheDir(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string | null {
	const named = env.BUN_RUNTIME_TRANSPILER_CACHE_PATH;
	if (named !== undefined) return named === "" || named === "0" ? null : path.resolve(named);
	if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, "bun", "@t@");
	const home = (platform === "win32" ? env.USERPROFILE : env.HOME) || os.homedir();
	return platform === "darwin"
		? path.join(home, "Library", "Caches", "bun", "@t@")
		: path.join(home, ".bun", "install", "cache", "@t@");
}

const within = (root: string, child: string): boolean => {
	const relative = path.relative(root, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/** A Bun or bunx process that reads or writes the install cache, or runs from the folders `bun pm cache rm` deletes. */
const BUN_INSTALLING = /(?:^|\/)(?:bun(?:\.exe)?\s+(?:install|i|add|update|remove|rm|pm|x|create|link)\b|bunx\b)/m;
/** npm or npx: its process title (`npm install …`, set by npm itself), or node running its CLI file. */
const NPM_RUNNING = /^(?:npm|npx)(?:\s|$)|[/\\]npm[/\\]bin[/\\]np[mx]-cli\.js(?:\s|$)/m;

/** `running` names the tool when one of its processes is listed; where none can be listed, the cache stays. */
const whileRunning =
	(pattern: RegExp, running: string) =>
	(processes: string | null): string | null =>
		processes === null ? "process check unavailable" : pattern.test(processes) ? running : null;

/** The core removes the tool's own entries of `dir`; what a running process still holds open stays. */
async function clearInCore(kind: "bun-transpiler" | "npm", dir: string): Promise<string | null> {
	const cleared = await coreHeld<{ removed: number; left: number }>("disk.clearCache", { kind, dir }, CLEAR_MS);
	return cleared.removed === 0 && cleared.left > 0 ? "its files are held open" : null;
}

/**
 * Bounds by evidence. Install caches (2 GB each): a clear costs a download of what the next install needs, and the
 * Mac this was measured on (12 Nov 2026) held 4.5 GB of Bun's and 3 GB of npm's. Transpiler cache (1 GB): one omp
 * start writes about 1 MB of it and a developer's PC held 176 MB after months, while that Mac's had grown to 6.9 GB;
 * a clear costs a transpile of the files a tool loads next.
 */
export const REGENERABLE_CACHES: readonly RegenerableCache[] = [
	{
		part: "bunCache",
		action: "bun-cache",
		maxBytes: 2 * GB,
		locate: async tools => bunCacheDir(await tools.env()),
		inUse: whileRunning(BUN_INSTALLING, "an install runs"),
		clear: async (_dir, tools) => {
			const bun = await tools.find("bun");
			if (!bun) return "bun was not found";
			// Bun has no age option: the whole cache goes.
			if ((await tools.run(bun, ["pm", "cache", "rm"])) === null) throw new Error("bun pm cache rm failed");
			return null;
		},
	},
	{
		part: "bunTranspilerCache",
		action: "bun-transpiler-cache",
		maxBytes: GB,
		locate: async tools => {
			const env = await tools.env();
			const dir = bunTranspilerCacheDir(env);
			return dir === null || within(bunCacheDir(env), dir) ? null : dir;
		},
		clear: dir => clearInCore("bun-transpiler", dir),
	},
	{
		part: "npmCache",
		action: "npm-cache",
		maxBytes: 2 * GB,
		locate: async tools => {
			const npm = await tools.find("npm");
			if (!npm) return null;
			const root = (await tools.run(npm, ["config", "get", "cache"]))?.trim().split(/\r?\n/).at(-1)?.trim();
			return root && path.isAbsolute(root) ? path.join(root, "_cacache") : null;
		},
		inUse: whileRunning(NPM_RUNNING, "npm runs"),
		clear: dir => clearInCore("npm", dir),
	},
];

export interface LocatedCache {
	cache: RegenerableCache;
	dir: string;
}

/** Each cache of `table` this computer has, with its folder; one that cannot be located is left out. */
export async function locateCaches(table: readonly RegenerableCache[], tools: CacheTools): Promise<LocatedCache[]> {
	const located: LocatedCache[] = [];
	for (const cache of table) {
		const dir = await cache.locate(tools).catch(() => null);
		if (dir !== null) located.push({ cache, dir });
	}
	return located;
}

/** The tools as this computer has them. */
export function systemCacheTools(platform: NodeJS.Platform = process.platform): CacheTools {
	const env = async (): Promise<NodeJS.ProcessEnv> => ({ ...process.env, ...(await shellSpawnEnv(platform)) });
	const run = (bin: string, args: string[], spawnEnv: NodeJS.ProcessEnv): Promise<string | null> => {
		const { promise, resolve } = Promise.withResolvers<string | null>();
		execFile(
			spawnCommand(bin, platform),
			spawnArgs(bin, args, platform),
			{
				cwd: os.homedir(),
				env: spawnEnv,
				shell: needsShell(bin, platform),
				windowsHide: true,
				timeout: 120_000,
				maxBuffer: 16 * 1024 * 1024,
			},
			(error, stdout) => resolve(error ? null : String(stdout)),
		);
		return promise;
	};
	return {
		env,
		find: async name => {
			const spawnEnv = await env();
			const extra =
				name === "bun"
					? [path.join(bunInstallDir(spawnEnv, os.homedir()), "bin", executableName("bun", platform))]
					: [];
			return findOnPath(launcherNames(name, platform), spawnEnv.PATH ?? "", platform, extra);
		},
		run: async (bin, args) => run(bin, args, await env()),
		processes: async () => (platform === "win32" ? null : run("ps", ["-axo", "command="], process.env)),
	};
}
