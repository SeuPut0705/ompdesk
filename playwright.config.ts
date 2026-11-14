import { totalmem } from "node:os";
import { defineConfig } from "@playwright/test";
import { ramWorkers } from "./scripts/lock-slots";
import { pinSnapshot } from "./scripts/out-snapshot";
import { claimRunTemp } from "./scripts/run-temp";
import { dropGitSelectors } from "./src/shared/git-env";

// Every suite launches the app (the Rust shell, `e2e/fixture/shell-launch.ts`) with `...process.env`; keep its
// windows off the user's screen (see OMP_GUI_HEADLESS in src/main/index.ts). Set to 0 to watch.
process.env.OMP_GUI_HEADLESS ??= "1";
// Every launched app ends with the process that launched it, even one that crashed (src/main/test-launcher-exit.ts):
// the runner names itself here, and each worker, loading this file again, names itself. A spec that launches
// the app itself with `...process.env` passes it on; `appLaunchOptions` (e2e/harness.ts) sets it too.
process.env.OMP_GUI_TEST_LAUNCHER_PID = String(process.pid);
// The run's temp files (every spec's profile, Playwright's own, what apps and fakes write) go in one folder of its
// own, removed with the processes still naming it when this runner exits (scripts/run-temp.ts).
claimRunTemp();
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
	// Every test launches its own app on private temp dirs (userData, agent
	// dir, fake omp, bridge socket) and ephemeral ports, so files run side by side.
	// GitHub's 3-core macOS and 2-core Windows runners stay at one. Keyed on
	// GITHUB_ACTIONS, not CI: agent shells on this Mac export CI=true.
	// OMP_GUI_WORKERS: fewer per run when several runs share the machine; RAM caps the default (2 on 16 GB,
	// .omp/rules/e2e-ci-windows.md › Lock on a small machine › Workers).
	workers: process.env.GITHUB_ACTIONS ? 1 : Number(process.env.OMP_GUI_WORKERS) || Math.min(4, ramWorkers(totalmem())),
	timeout: 60_000,
	expect: { timeout: 10_000 },
	reporter: [["list"], ["html", { open: "never" }]],
	// Every click, fill and press is bounded (Playwright's default is none): one that waits for an element that never
	// becomes actionable fails here naming it, instead of holding the test to its own timeout (nightly 39539556435:
	// mobile-autopilot-rows clicked a button the page no longer showed and waited 5 min).
	use: { screenshot: "only-on-failure", trace: "retain-on-failure", actionTimeout: 30_000 },
	globalSetup: "./e2e/global-setup.ts",
	// A spec's `import { _electron } from "playwright"` is the shell's launcher (`e2e/fixture/playwright-shell.ts`):
	// this tsconfig maps that one module, so the ~100 specs that call `electron.launch` stay as they are.
	tsconfig: "./e2e/fixture/shell.tsconfig.json",
});
