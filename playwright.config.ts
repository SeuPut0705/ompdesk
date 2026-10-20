import { defineConfig } from "@playwright/test";
import { pinSnapshot } from "./scripts/out-snapshot";
import { dropGitSelectors } from "./src/shared/git-env";

// Every suite launches Electron with `...process.env`; keep its windows off the
// user's screen (see OMP_GUI_HEADLESS in src/main/index.ts). Set to 0 to watch.
process.env.OMP_GUI_HEADLESS ??= "1";
// A run started under `git bisect run` or a hook must not send the specs' temp-repo git commands to this checkout.
dropGitSelectors();
// Every spec launches the app from OMP_GUI_E2E_OUT (default out/). Pin it once, here, to an immutable
// copy of the current build (`scripts/out-snapshot.ts`), so a build another agent starts mid-run never
// changes the app under this one. Workers load this file again and inherit the pinned value.
if (!process.env.GITHUB_ACTIONS) {
	const pinned = pinSnapshot(import.meta.dirname);
	if (pinned) process.env.OMP_GUI_E2E_OUT = pinned;
}

export default defineConfig({
	testDir: "./e2e",
	testMatch: "**/*.e2e.ts",
	// Every test launches its own Electron on private temp dirs (userData, agent
	// dir, fake omp, bridge socket) and ephemeral ports, so files run side by side.
	// GitHub's 3-core macOS and 2-core Windows runners stay at one. Keyed on
	// GITHUB_ACTIONS, not CI: agent shells on this Mac export CI=true.
	// OMP_GUI_WORKERS: fewer per run when several runs share the machine (AGENTS.md › Build lock and gate).
	workers: process.env.GITHUB_ACTIONS ? 1 : Number(process.env.OMP_GUI_WORKERS) || 4,
	timeout: 60_000,
	expect: { timeout: 10_000 },
	reporter: [["list"], ["html", { open: "never" }]],
	use: { screenshot: "only-on-failure", trace: "retain-on-failure" },
	globalSetup: "./e2e/global-setup.ts",
});
