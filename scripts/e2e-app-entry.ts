/**
 * The built app every e2e launches: `<OMP_GUI_E2E_OUT ?? out>/main/index.js`. Electron with a missing entry
 * does not fail quietly: it opens a native "Error launching app: Unable to find Electron app at …" dialog on
 * the user's screen (OMP_GUI_HEADLESS does not stop it), once per test. So a run without a build stops before
 * any Electron starts (`playwright.config.ts` globalSetup), and `launchApp` asserts the same before it spawns.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export function appEntry(env: NodeJS.ProcessEnv = process.env): string {
	return path.resolve(env.OMP_GUI_E2E_OUT ?? "out", "main/index.js");
}

/** Throws, naming the missing file and how to build, when the app entry does not exist. Returns the entry. */
export function assertAppBuilt(env: NodeJS.ProcessEnv = process.env): string {
	const entry = appEntry(env);
	if (!fs.existsSync(entry)) {
		throw new Error(
			`No build: ${entry} does not exist, so Electron would open an error dialog on screen. ` +
				"Run `bun run build` or `bun run check:changed` first (or point OMP_GUI_E2E_OUT at a built out/).",
		);
	}
	return entry;
}
