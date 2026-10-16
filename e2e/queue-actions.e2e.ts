import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { exitApp, launchApp } from "./harness";

test("queued messages: remove one, send a follow-up now, and Stop restores the rest into the draft", async () => {
	test.setTimeout(120_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-queue-actions-"));
	const desktop = path.join(profile, "desktop"),
		agent = path.join(profile, "agent"),
		project = path.join(profile, "project");
	await Promise.all([fs.mkdir(desktop), fs.mkdir(agent), fs.mkdir(project)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en" }));
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile,
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	try {
		const input = page.locator("textarea").first();
		await expect(input).toBeVisible({ timeout: 60_000 });
		await input.fill("fixture stream");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		const stop = page.getByRole("button", { name: "Stop", exact: true });
		await expect(stop).toBeVisible();

		await page.evaluate(async () => {
			await window.omp.rpc.steer("steer one");
			await window.omp.rpc.followUp("later a");
			await window.omp.rpc.followUp("later b");
		});
		const tray = page.getByRole("region", { name: "Queued", exact: true });
		const row = (text: string) => tray.locator("li", { hasText: text });
		await expect(tray.locator("li")).toHaveCount(3);
		// Stock promotes only follow-ups.
		await expect(row("steer one").getByRole("button", { name: "Send now as a steer" })).toHaveCount(0);

		await row("later b").getByRole("button", { name: "Remove" }).click();
		await expect(tray.locator("li")).toHaveCount(2);
		await expect(row("later b")).toHaveCount(0);

		await row("later a").getByRole("button", { name: "Send now as a steer" }).click();
		// Now the second steer: it offers "send later" instead.
		await expect(row("later a").getByRole("button", { name: "Send after this turn" })).toHaveCount(1);
		await expect(row("later a").getByRole("button", { name: "Send now as a steer" })).toHaveCount(0);
		await expect(tray.locator("li")).toHaveText([/steer one/, /later a/]);

		await input.fill("my unsent draft");
		await stop.click();
		await expect(stop).toHaveCount(0);
		await expect(tray).toHaveCount(0);
		await expect(input).toHaveValue("steer one\n\nlater a\n\nmy unsent draft");
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
