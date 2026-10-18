/**
 * Captures of a finished work card (the fake omp's "fixture work view" run), passing and with its
 * type check failing (`OMP_GUI_TEST_WORK_TYPES_FAIL`), in en/ko × light/dark at a wide and a narrow
 * window. Registered only with `OMP_GUI_WORK_CARD_SHOTS=<dir>`; `OMP_GUI_WORK_CARD_OUT=<built out/>`
 * captures another checkout's build (a before). The head's facts and findings are component-tested
 * (`ExecutionGroup.checks.test.tsx`, `work-checks.test.ts`) and asserted in `event-replay.e2e.ts`.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { exitApp, launchApp } from "./harness";

const shots = process.env.OMP_GUI_WORK_CARD_SHOTS;
const label = process.env.OMP_GUI_WORK_CARD_LABEL ?? "after";
const LOOKS = [
	{ language: "en", theme: "light" },
	{ language: "ko", theme: "light" },
	{ language: "ko", theme: "dark" },
] as const;
const SIZES = [
	{ name: "wide", width: 1440, height: 900 },
	{ name: "narrow", width: 420, height: 860 },
] as const;

for (const fail of shots ? [false, true] : []) {
	test(`work card captures (${fail ? "types failed" : "passed"})`, async () => {
		test.setTimeout(240_000);
		if (process.env.OMP_GUI_WORK_CARD_OUT) process.env.OMP_GUI_E2E_OUT = process.env.OMP_GUI_WORK_CARD_OUT;
		for (const look of LOOKS) {
			const profile = await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-work-card-"));
			const project = path.join(profile, "project");
			const desktop = path.join(profile, "desktop");
			const agent = path.join(profile, "agent");
			await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
			await fs.writeFile(
				path.join(desktop, "prefs.json"),
				JSON.stringify({ language: look.language, themeName: look.theme, firstRunComplete: true }),
			);
			const app = await launchApp({
				project,
				desktop,
				agent,
				profile,
				env: { OMP_GUI_TEST_WORK_RICH: "1", ...(fail ? { OMP_GUI_TEST_WORK_TYPES_FAIL: "1" } : {}) },
			});
			try {
				const page = await app.firstWindow();
				await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
				await expect
					.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, {
						timeout: 60_000,
					})
					.toBe("ready");
				const input = page.locator("textarea").first();
				await input.fill("fixture work view");
				await input.press("Enter");
				await expect(page.locator(".omp-work-sub")).toBeVisible({ timeout: 30_000 });
				const tab = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId;
				if (!tab) throw new Error("Missing work tab");
				for (let index = 0; index < 14; index++)
					await page.evaluate(
						id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:work-next" }),
						tab,
					);
				await expect(page.locator(".omp-execution-group[data-state='running']")).toHaveCount(0, {
					timeout: 30_000,
				});
				await expect(page.locator(".omp-execution-group-summary").last()).toContainText(/types|타입|command|명령/);
				for (const size of SIZES) {
					await app.evaluate(
						({ BrowserWindow }, { width, height }) =>
							BrowserWindow.getAllWindows()[0]?.setContentSize(width, height),
						size,
					);
					await page.waitForTimeout(400);
					await page
						.locator(".omp-execution-group")
						.last()
						.screenshot({
							path: path.join(
								shots ?? "",
								`${label}-${fail ? "fail" : "pass"}-${size.name}-${look.language}-${look.theme}.png`,
							),
						});
				}
				// The finished card opened: the wide window only, the header toggles the steps.
				await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
				await page.waitForTimeout(400);
				const card = page.locator(".omp-execution-group").last();
				await card.locator(".omp-execution-group-header").first().click();
				// Taller than the window: grow it so no sticky bar covers the card's head.
				const opened = await card.boundingBox();
				await app.evaluate(
					({ BrowserWindow }, height) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, height),
					Math.ceil((opened?.height ?? 0) + 260),
				);
				await card.scrollIntoViewIfNeeded();
				await page.waitForTimeout(400);
				await card.screenshot({
					path: path.join(
						shots ?? "",
						`${label}-${fail ? "fail" : "pass"}-wide-expanded-${look.language}-${look.theme}.png`,
					),
				});
				// The chip opens the steps at its own call (the build under test only: a before has no chips).
				if (!process.env.OMP_GUI_WORK_CARD_OUT) {
					await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
					await card.locator(".omp-execution-group-header").first().click();
					await expect(card.locator(".omp-execution-group-body")).toHaveCount(0);
					await card.locator(fail ? '[data-work-chip="error"]' : '[data-work-chip="tests"]').click();
					const target = card.locator(".omp-tool-card").filter({ hasText: fail ? "check:types" : "vitest" });
					await expect(target.locator("button[aria-expanded]").first()).toHaveAttribute("aria-expanded", "true");
					await expect(target).toBeInViewport();
				}
			} finally {
				await exitApp(app);
				await fs.rm(profile, { recursive: true, force: true });
			}
		}
	});
}
