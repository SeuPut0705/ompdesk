/**
 * Per-session worktrees (`worktree.onStart` / `worktree.onExit`, omp 18.8.6+).
 * Stock runs this lifecycle only in interactive mode
 * (`InteractiveMode.maybeAutoCreateWorktree` / `#planOwnedWorktreeExit`), so in
 * rpc-ui the settings would do nothing. OMPdesk main drives it per tab
 * (src/main/worktree-lifecycle.ts) and reaches stock's own helpers here: the
 * live setting values, stock's start condition, and stock's worktree creation,
 * so the branch name, location, clone backend and clean-HEAD start match the TUI.
 *
 * The omp modules are imported only once `guard` has seen them (feature
 * `worktreeLifecycle`, optional in capabilities.ts): omp 18.8.0 has
 * `session/session-worktree` without these exports and no such settings.
 * Literal specifiers, so omp maps them onto its loaded singletons (see health.ts).
 */
import { guard } from "./health";
import type { BridgeMethods } from "./types";

export const methods: BridgeMethods = {
	...guard("worktreeLifecycle", {
		/**
		 * Both policies as the live session resolves them, plus stock's start
		 * condition for the session's cwd (`canAutoCreateWorktree`: a primary git
		 * checkout with commits).
		 */
		worktree_lifecycle_settings: async (_params, env) => {
			const session = env.session();
			const [{ cfgWorktreeOnStart, cfgWorktreeOnExit }, { canAutoCreateWorktree }] = await Promise.all([
				import("@oh-my-pi/pi-coding-agent/task/settings"),
				import("@oh-my-pi/pi-coding-agent/session/session-worktree"),
			]);
			return {
				onStart: cfgWorktreeOnStart.get(session.settings),
				onExit: cfgWorktreeOnExit.get(session.settings),
				eligible: await canAutoCreateWorktree(session.sessionManager.getCwd()),
			};
		},
		/**
		 * Stock's `maybeAutoCreateWorktree` creation step
		 * (`handleWorktreeCommand(undefined, { keepChanges: false })`): a new
		 * `wt/<timestamp>` branch at clean `HEAD`, under the agent worktree base.
		 * The GUI then starts the tab's omp in it instead of moving this session.
		 */
		worktree_lifecycle_create: async (_params, env) => {
			const session = env.session();
			const [{ createSessionWorktree, defaultSessionWorktreeBranch }, { getWorktreesDir }] = await Promise.all([
				import("@oh-my-pi/pi-coding-agent/session/session-worktree"),
				import("@oh-my-pi/pi-utils"),
			]);
			const worktree = await createSessionWorktree(
				session.sessionManager.getCwd(),
				session.settings,
				defaultSessionWorktreeBranch(),
				{ keepChanges: false },
			);
			if (worktree.cloneError) {
				env.pi.logger.warn("worktree clone fell back to plain checkout", {
					path: worktree.path,
					error: worktree.cloneError,
				});
			}
			return {
				path: worktree.path,
				branch: worktree.branch,
				sourceCwd: worktree.sourceCwd,
				baseCommit: worktree.baseCommit,
				root: getWorktreesDir(),
			};
		},
	}),
};
