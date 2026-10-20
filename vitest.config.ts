import { availableParallelism } from "node:os";
import { configDefaults, defineConfig } from "vitest/config";
import { dropGitSelectors } from "./src/shared/git-env";

// Tests make temp repositories with `git init` and `git config`: under `git bisect run` or a hook those would
// rewrite this checkout (src/shared/git-env.ts).
dropGitSelectors();

const RENDERER = "src/renderer/**/*.{test,spec}.?(c|m)[jt]s?(x)";

export default defineConfig({
	test: {
		// Tests assert English UI text; pin the inferred UI language so a Korean or
		// Chinese host locale (navigator.language follows the OS) cannot flip it.
		setupFiles: ["./vitest.setup.ts"],
		// vitest leaves one core for itself by default: a single worker on GitHub's
		// 2-core runners. Two took test:platform on Windows from 94 s to 63 s;
		// more workers than cores timed out the heavier component tests.
		// Keyed on GITHUB_ACTIONS, not CI: agent shells on this Mac export CI=true.
		// Locally the full suite takes as long on 8 workers as on 14 (21 s on the
		// maintainer's 15-core Mac; 4 took 28 s), so it stops at 8 and leaves the
		// rest of the machine to whatever else runs.
		// OMP_VITEST_WORKERS: fewer per run when several runs share the machine (AGENTS.md › Build lock and gate).
		maxWorkers: process.env.GITHUB_ACTIONS
			? availableParallelism()
			: Number(process.env.OMP_VITEST_WORKERS) || Math.min(8, availableParallelism() - 1),
		projects: [
			{
				extends: true,
				test: {
					name: "renderer",
					include: [RENDERER],
					// Projects on different pools run at the same time, each with
					// maxWorkers, which oversubscribes the cores and times out the
					// heavier tests; separate groups run one after the other.
					sequence: { groupOrder: 0 },
					// Worker threads instead of a child process per test file: each file
					// still gets a fresh module graph (isolate stays on), without a
					// process start per file.
					pool: "threads",
					deps: {
						// Most of a component test's startup is loading these from thousands
						// of small files (lucide-react's per-icon modules, linkedom's ESM
						// tree); pre-bundled once per run they load as a few files. `react`
						// itself stays external, so the bundles and the tests share one
						// React. Pre-bundling the markdown, zustand and chart packages too
						// measured no faster.
						optimizer: {
							ssr: {
								enabled: true,
								include: ["lucide-react", "linkedom", "react-dom", "react-dom/client", "react-dom/server"],
							},
						},
					},
				},
			},
			{
				extends: true,
				test: {
					// Main process, bridge and scripts: real subprocesses, sockets, PATH and
					// env edits, so each file keeps its own process (`forks`).
					name: "node",
					sequence: { groupOrder: 1 },
					// Starting a process costs several times more on Windows, and the git-driven tests
					// (autopilot audit/ship, workspace walk) spawn dozens: 5 s timed them out on windows-latest.
					testTimeout: process.platform === "win32" ? 20_000 : 5_000,
					exclude: [...configDefaults.exclude, RENDERER],
				},
			},
		],
	},
});
