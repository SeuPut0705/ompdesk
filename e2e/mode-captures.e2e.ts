/**
 * Mode popover captures: the Plan, Goal and Autopilot tabs in light/dark × en/ko, plus the Autopilot tab in a short
 * window (the popover scrolls inside the viewport instead of overflowing it).
 * Runs only with OMPDESK_MODE_SHOTS=<dir> (before/after comparisons of the compact redesign).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { cleanupAp, launchAp, makeApProfile } from "./autopilot-harness";
import { exitApp } from "./harness";

const SHOTS = process.env.OMPDESK_MODE_SHOTS;
test.skip(!SHOTS, "set OMPDESK_MODE_SHOTS=<dir> to capture");

for (const language of ["en", "ko"] as const)
	for (const theme of ["light", "dark"] as const)
		test(`mode popover captures (${language} ${theme})`, async () => {
			test.setTimeout(180_000);
			const dir = SHOTS ?? "";
			await fs.mkdir(dir, { recursive: true });
			const profile = await makeApProfile({ language, theme });
			const { app, page } = await launchAp(profile);
			try {
				const shoot = async (name: string) => {
					await page.mouse.move(1, 1);
					await page.screenshot({
						animations: "disabled",
						path: path.join(dir, `${language}-${theme}-${name}.png`),
						scale: "css",
					});
				};
				const popover = page.locator('[role="dialog"]').filter({ has: page.locator("[data-tab-id='autopilot']") });
				await page.locator("[data-run-settings-trigger]").click();
				await expect(popover).toBeVisible();
				for (const tab of ["plan", "goal", "autopilot"]) {
					await popover.locator(`[data-tab-id="${tab}"]`).click();
					await page.waitForTimeout(400);
					await shoot(tab);
				}
				// A short window: the popover keeps inside the viewport and scrolls.
				await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 620));
				await page.waitForTimeout(400);
				const box = await popover.boundingBox();
				const viewport = await page.evaluate(() => window.innerHeight);
				expect(box).not.toBeNull();
				expect((box?.y ?? -1) + (box?.height ?? 0)).toBeLessThanOrEqual(viewport);
				expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
				await shoot("autopilot-short-window");
			} finally {
				await exitApp(app);
				await cleanupAp(profile);
			}
		});
