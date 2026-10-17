import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { exitApp, launchApp, pressShortcutUntilVisible } from "./harness";

// The release workflow's mac and win jobs run this (`--grep @smoke`) against
// the build packaging just made: launch on the fake omp, gui-bridge over the
// socket (a named pipe on Windows), a new tab, one prompt round-trip, and the
// settings window.
test("@smoke app boots on omp, connects the bridge, opens a tab, answers a prompt, opens settings", async () => {
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-smoke-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile,
	});
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on("pageerror", error => errors.push(error.message));
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		// Settings are served by the gui-bridge, so this answers only over the pipe.
		await expect
			.poll(() => page.evaluate(() => window.omp.rpc.getSettings(["compaction.enabled"])))
			.toMatchObject({ success: true });

		// Sent once: ⌘T opens a tab each time it lands. A second omp starts cold on a 3-core runner, so the
		// tab list may take longer than the default timeout to show it; the count must be exactly two.
		// The checks above are preload, main and bridge only: on a fast boot they pass before the renderer
		// mounts the window's keydown handler (a probe on macos-latest logged the ⌘T keydown 12 ms before App's
		// listener mounted, in 6 of 40 boots), so the press waits for the composer.
		await expect(page.locator("textarea").first()).toBeVisible();
		await page.keyboard.press("ControlOrMeta+t");
		await expect.poll(() => page.evaluate(() => window.omp.tabs.list()), { timeout: 60_000 }).toHaveLength(2);
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.tabs.list())).at(-1)?.status, { timeout: 60_000 })
			.toBe("ready");

		await page.locator("textarea").first().fill("smoke hello");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await expect(page.locator("[data-transcript-kind]").filter({ hasText: "Local fixture reply" })).toHaveCount(1);

		const settings = page.locator("[data-settings-page]");
		await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
		await expect(settings.locator('[data-settings-section="appearance"]')).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(settings).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
