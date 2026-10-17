import { defineConfig } from "@playwright/test";

// The README scenes launch the built app like the e2e suites do: keep its windows off the user's screen.
process.env.OMP_GUI_HEADLESS ??= "1";

export default defineConfig({
	testDir: "./scenes",
	testMatch: "**/*.scene.ts",
	// One app at a time: a scene's timing is part of the clip.
	workers: 1,
	fullyParallel: false,
	retries: 0,
	timeout: 240_000,
	expect: { timeout: 15_000 },
	reporter: [["list"]],
	outputDir: "/tmp/ompdesk-readme-media-results",
});
