import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { exitApp, launchApp, pressShortcutUntilVisible } from "./harness";

// A scheduled run is new agent work: while this computer's memory is in danger it waits for it (the owner's rule of
// 2 Nov 2026, src/main/memory-admission.ts). Here 3 GB of 16 are free (OMP_GUI_TEST_MEMORY), less than one expected
// run above the 2.4 GB kept free, so a run Run now starts waits. Stop on that run ends it at once: nothing ever started,
// and the row stays "Running" otherwise, with a button that does nothing.
test("Stop ends a scheduled run that waits for memory", async () => {
	test.setTimeout(120_000);
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-schedule-memory-"));
	const desktop = path.join(root, "desktop");
	const project = path.join(root, "project");
	const agent = path.join(root, "agent");
	const record = path.join(root, "rpc.jsonl");
	const memory = path.join(root, "memory.json");
	await Promise.all([fs.mkdir(desktop), fs.mkdir(project), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", themeName: "light", firstRunComplete: true }),
	);
	await fs.writeFile(memory, JSON.stringify({ totalGb: 16, availableGb: 3, pressure: "normal" }));
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile: root,
		env: { OMP_GUI_TEST_RECORD: record, OMP_GUI_TEST_MEMORY: memory, OMP_GUI_TEST_MEMORY_MS: "200" },
	});
	const page = await app.firstWindow();
	try {
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
		const settings = page.locator("[data-settings-page]");
		await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
		await settings.locator('[data-settings-section="schedules"]').click();
		await settings.locator("[data-schedule-new]").first().click();
		const dialog = page.getByRole("dialog");
		await dialog.locator("input:not([type=number]):not([type=time]), textarea").nth(0).fill("Held run");
		await dialog.locator("textarea").fill("fixture hello");
		await expect(dialog.locator("[data-schedule-cwd]")).not.toBeEmpty();
		await dialog.getByRole("button", { name: "Create" }).click();
		await expect(dialog).toBeHidden();
		const held = settings.locator("[data-schedule]").filter({ hasText: "Held run" });
		await held.locator("[data-schedule-run]").click();
		await held.getByRole("button", { name: "Stop" }).click();
		await expect(settings.locator("[data-schedule-run-row]").filter({ hasText: "Held run" })).toContainText(
			"Stopped",
		);
		// Nothing ran: the fake omp never saw the prompt.
		expect((await fs.readFile(record, "utf8").catch(() => "")).includes('"type":"print"')).toBe(false);
	} finally {
		await exitApp(app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
