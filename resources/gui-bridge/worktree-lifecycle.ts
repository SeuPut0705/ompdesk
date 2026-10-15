/**
 * Per-session worktrees (`worktree.onStart` / `worktree.onExit`, omp 18.8.6+).
 * Stock runs this lifecycle only in interactive mode
 * (`InteractiveMode.maybeAutoCreateWorktree` / `#planOwnedWorktreeExit`), so in
 * rpc-ui the settings would do nothing. OMPdesk main drives it per tab
 * (src/main/worktree-lifecycle.ts) and reaches stock's own helpers here: the
 * live setting values, stock's start condition, and stock's worktree creation,
 * so the branch name, location, clone backend and clean-HEAD start match the TUI.
 *
 * Dynamic stock imports are deliberate: static imports would fail area loading
 * before the capability guard can explain a missing internal. The minimum is
 * omp 18.8.7; there is no older-version implementation fallback.
 * Literal specifiers, so omp maps them onto its loaded singletons (see health.ts).
 */
import * as path from "node:path";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { guard } from "./health";
import type { BridgeMethods } from "./types";

export const methods: BridgeMethods = {
	...guard("worktreeLifecycle", {
		/** Naming and authorization use the running stock process's worktree.base and Bun hash. */
		"git.worktree_location": async (params, env) => {
			const primaryRoot = (params as { primaryRoot?: unknown } | null)?.primaryRoot;
			if (typeof primaryRoot !== "string" || !path.isAbsolute(primaryRoot) || primaryRoot.includes("\0")) {
				throw new Error("primaryRoot must be an absolute path");
			}
			env.session();
			const { getWorktreesDir, hashPath } = await import("@oh-my-pi/pi-utils");
			return { root: getWorktreesDir(), hash: hashPath(primaryRoot) };
		},
		"git.pr_checkout": async (params, env) => {
			const input = params as { number?: unknown; repo?: unknown } | null;
			if (!Number.isSafeInteger(input?.number) || Number(input?.number) <= 0 || typeof input?.repo !== "string") {
				throw new Error("Invalid PR checkout parameters");
			}
			const session = env.session();
			const toolSession: ToolSession = {
				cwd: session.sessionManager.getCwd(),
				hasUI: false,
				settings: session.settings,
				getSessionFile: () => session.sessionManager.getSessionFile() ?? null,
				// This operation has no child-agent surface, like stock's selector ToolSession.
				getSessionSpawns: () => null,
			};
			const { checkoutPullRequest } = await import("@oh-my-pi/pi-coding-agent/tools/gh-pr-checkout");
			const outcome = await checkoutPullRequest(toolSession, AbortSignal.timeout(600_000), {
				prRef: String(input.number),
				repo: input.repo,
				force: false,
			});
			return { path: outcome.worktreePath, branch: outcome.localBranch };
		},
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
		 * With the user's branch prefix (main validated it against
		 * src/shared/worktree-branch.ts) stock's `wt/` gives way to it and the
		 * timestamp stays. The GUI then starts the tab's omp in it instead of
		 * moving this session.
		 */
		worktree_lifecycle_create: async (params, env) => {
			const session = env.session();
			const prefix = (params as { branchPrefix?: unknown } | null)?.branchPrefix;
			if (prefix !== undefined && (typeof prefix !== "string" || !/^[A-Za-z0-9._/-]{1,40}$/.test(prefix))) {
				throw new Error("branchPrefix must be 1-40 characters of letters, digits, . _ - /");
			}
			const [{ createSessionWorktree, defaultSessionWorktreeBranch }, { getWorktreesDir }] = await Promise.all([
				import("@oh-my-pi/pi-coding-agent/session/session-worktree"),
				import("@oh-my-pi/pi-utils"),
			]);
			const stockBranch = defaultSessionWorktreeBranch();
			const worktree = await createSessionWorktree(
				session.sessionManager.getCwd(),
				session.settings,
				prefix ? `${prefix}${stockBranch.replace(/^wt\//, "")}` : stockBranch,
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
