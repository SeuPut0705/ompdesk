import { defineConfig } from "@playwright/test";

// Every suite launches Electron with `...process.env`; keep its windows off the
// user's screen (see OMP_GUI_HEADLESS in src/main/index.ts). Set to 0 to watch.
process.env.OMP_GUI_HEADLESS ??= "1";

export default defineConfig({
	testDir: "./e2e",
	testMatch: "**/*.e2e.ts",
	workers: 1,
	timeout: 60_000,
	expect: { timeout: 10_000 },
	reporter: [["list"], ["html", { open: "never" }]],
	use: { screenshot: "only-on-failure", trace: "retain-on-failure" },
});
