/**
 * Git's variables that point a git command at a repository other than the one its working directory is in.
 * `git bisect run` in a linked worktree exports GIT_DIR (so does a hook: GIT_DIR, GIT_INDEX_FILE), and every test
 * that makes a temp repository with `git init` and `git config` then rewrote the checkout that started the run
 * instead: one such run set the shared `.git/config` to `core.bare = true` with a test identity and committed over
 * the worktree's index. The test runners drop them before any test starts.
 */
export const GIT_ROUTING_ENV = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE",
	"GIT_PREFIX",
] as const;

export function dropGitRoutingEnv(env: NodeJS.ProcessEnv = process.env): void {
	for (const name of GIT_ROUTING_ENV) Reflect.deleteProperty(env, name);
}
