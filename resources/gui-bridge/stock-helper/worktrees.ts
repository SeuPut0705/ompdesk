/**
 * Stock's worktree location for a repository without a running session (src/main/local/git/worktree.ts
 * `createWorktree` for an agent on another computer opening a session here): the bridge's
 * `git.worktree_location` (worktree-lifecycle.ts) reads it from the live session's process, this reads the same
 * `worktree.base` setting from the folder's config read-only, applies it as stock's own `effect` does
 * (`setWorktreesDir`), and asks pi-utils for the directory and the repo hash. Nothing is written.
 */
import * as path from "node:path";

interface Handle<T> {
	get(settings: unknown): T;
}

/** Stock modules of the user's omp, by subpath, with the named exports checked. */
async function load<T>(specifier: string, ...names: string[]): Promise<T> {
	const root = process.env.OMP_PACKAGE_ROOT;
	if (!root) throw new Error("OMP_PACKAGE_ROOT is required");
	// Runtime-selected: the modules of the user's resolved omp installation, not this worker's.
	const module = (await import(Bun.resolveSync(specifier, path.join(root, "package.json")))) as Record<
		string,
		unknown
	>;
	for (const name of names)
		if (module[name] === undefined) throw new Error(`Installed omp has no ${specifier} ${name}`);
	return module as T;
}

export const methods: Record<string, (params: unknown) => Promise<unknown>> = {
	"git.worktree_location": async params => {
		const primaryRoot = (params as { primaryRoot?: unknown } | null)?.primaryRoot;
		if (typeof primaryRoot !== "string" || !path.isAbsolute(primaryRoot) || primaryRoot.includes("\0"))
			throw new Error("primaryRoot must be an absolute path");
		const [utils, settingsModule, taskSettings] = await Promise.all([
			load<{
				getWorktreesDir(): string;
				hashPath(absPath: string): string;
				setWorktreesDir(dir: string | undefined): string | undefined;
			}>("@oh-my-pi/pi-utils", "getWorktreesDir", "hashPath", "setWorktreesDir"),
			load<{ Settings: { loadReadOnly(options: { cwd: string }): Promise<unknown> } }>(
				"@oh-my-pi/pi-coding-agent/config/settings",
				"Settings",
			),
			load<{ cfgWorktreeBase: Handle<string | undefined> }>(
				"@oh-my-pi/pi-coding-agent/task/settings",
				"cfgWorktreeBase",
			),
		]);
		const settings = await settingsModule.Settings.loadReadOnly({ cwd: primaryRoot });
		const base = taskSettings.cfgWorktreeBase.get(settings)?.trim();
		utils.setWorktreesDir(base || undefined);
		return { root: utils.getWorktreesDir(), hash: utils.hashPath(primaryRoot) };
	},
};
