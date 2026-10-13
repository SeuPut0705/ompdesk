import { defineConfig } from "@playwright/test";

// Every suite launches Electron with `...process.env`; keep its windows off the
// user's screen (see OMP_GUI_HEADLESS in src/main/index.ts). Set to 0 to watch.
process.env.OMP_GUI_HEADLESS ??= "1";

export default defineConfig({
	testDir: "./e2e",
	testMatch: "**/*.e2e.ts",
	// Every test launches its own Electron on private temp dirs (userData, agent
	// dir, fake omp, bridge socket) and ephemeral ports, so files run side by side.
	// GitHub's 3-core macOS and 2-core Windows runners stay at one. Keyed on
	// GITHUB_ACTIONS, not CI: agent shells on this Mac export CI=true.
	workers: process.env.GITHUB_ACTIONS ? 1 : 4,
	timeout: 60_000,
	expect: { timeout: 10_000 },
	reporter: [["list"], ["html", { open: "never" }]],
	use: { screenshot: "only-on-failure", trace: "retain-on-failure" },
});
