/**
 * Git's variables that point a git command at a repository other than the one its working directory is in. They leak
 * into every child git when OMPdesk or a test runs under `git bisect run` (a linked worktree exports GIT_DIR), a hook
 * (GIT_DIR, GIT_INDEX_FILE) or a shell inside a git operation: one test run under bisect set a shared checkout's
 * `.git/config` to `core.bare = true` with a test identity. Ambient values are dropped; a caller that means one
 * (disk care's scratch GIT_INDEX_FILE) passes it explicitly after.
 */
export const GIT_REPO_SELECTOR_ENV = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE",
	"GIT_PREFIX",
] as const;

/** `env` without the repository selectors (a copy; `env` is untouched). */
export function withoutGitSelectors(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const clean = { ...env };
	for (const name of GIT_REPO_SELECTOR_ENV) delete clean[name];
	return clean;
}

/** Drop the selectors from `env` in place (a test runner's own process). */
export function dropGitSelectors(env: NodeJS.ProcessEnv = process.env): void {
	for (const name of GIT_REPO_SELECTOR_ENV) Reflect.deleteProperty(env, name);
}
