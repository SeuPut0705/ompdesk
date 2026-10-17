/**
 * Static shots: Settings › Models & accounts (accounts with their usage windows), the right panel's Files view with
 * a file open, and Settings › Devices & connections (remote devices and Mobile web). Light and dark each.
 */
import { expect, type Page, test } from "@playwright/test";
import { exitApp, pressShortcutUntilVisible } from "../../../e2e/harness";
import { cleanup, fixture, flow, launch, makeProfile, still, type Theme, tabs } from "../lib";
import { startTurn } from "../sessions";

async function openSettings(page: Page, section: string): Promise<void> {
	const settings = page.locator("[data-settings-page]");
	await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
	await settings.locator(`[data-settings-section="${section}"]`).click();
	await expect(settings.locator(".settings-content .animate-spin")).toHaveCount(0, { timeout: 30_000 });
	await page.waitForTimeout(600);
	await page.mouse.move(1, 1);
}

for (const theme of ["light", "dark"] as const satisfies readonly Theme[])
	test(`static shots (${theme})`, async () => {
		const suffix = theme === "light" ? "" : "-dark";
		const profile = await makeProfile({ name: `statics-${theme}`, theme });
		const { app, page } = await launch(profile, 1440, 900);
		try {
			const tabId = (await tabs(page)).find(tab => tab.active)?.tabId ?? "";
			await startTurn(page, tabId, "Where is the theme set?");
			await fixture(page, "fixture:title:Theme settings", tabId);
			await flow(page, { op: "reply", text: "The theme lives in `src/settings.ts`; `src/app.ts` reads it." }, tabId);
			await expect(page.getByText("The theme lives in")).toBeVisible();
			await fixture(page, "fixture:usage-accounts:3");
			await openSettings(page, "models");
			await still(page, `models${suffix}`);
			await openSettings(page, "connections");
			await still(page, `devices${suffix}`);

			// Files: the panel's Files view with a source file open beside the chat.
			await page.getByRole("button", { name: "Back to session" }).click();
			await page.locator('[data-tour="panel"]').click();
			await page.locator('[aria-label="Primary views"]').getByRole("button", { name: "Files" }).click();
			const panel = page.locator("aside").last();
			await panel.getByText("src", { exact: true }).first().click();
			await panel.getByText("settings.ts").first().click();
			await page.mouse.move(700, 450);
			await page.waitForTimeout(1_200);
			await still(page, `files${suffix}`);
		} finally {
			await exitApp(app);
			await cleanup(profile);
		}
	});
