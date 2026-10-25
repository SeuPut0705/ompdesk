/**
 * Captures of a finished work card (the fake omp's "fixture work view" run) on a paired phone's real page (the
 * built app's `web.html` in Chromium on a phone profile, reached through `fixture/phone-serve.ts`), passing and
 * with its type check failing (`OMP_GUI_TEST_WORK_TYPES_FAIL`), collapsed and expanded, ko in light and dark.
 * The language is the host's pref (a phone follows it), the theme is the phone's own (`prefs.set` on its page).
 * Registered only with `OMP_GUI_WORK_CARD_SHOTS=<dir>`; `OMP_GUI_WORK_CARD_OUT=<built out/>` captures another
 * checkout's build; `OMP_GUI_WORK_CARD_LABEL` names the files (`<label>-phone-<pass|fail>-<collapsed|expanded>-ko-<theme>.png`).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, devices, expect, test } from "@playwright/test";
import { fixtureTailscale } from "./fixture/fake-tailscale-install";
import { ServeProxy, serveSites } from "./fixture/phone-serve";
import { exitApp, launchApp } from "./harness";

const shots = process.env.OMP_GUI_WORK_CARD_SHOTS;
const label = process.env.OMP_GUI_WORK_CARD_LABEL ?? "after";
const THEMES = ["light", "dark"] as const;

for (const fail of shots ? [false, true] : []) {
	test(`work card phone captures (${fail ? "types failed" : "passed"})`, async () => {
		test.skip(process.platform === "win32", "the fake Tailscale is a bun shebang script");
		test.setTimeout(300_000);
		if (process.env.OMP_GUI_WORK_CARD_OUT) process.env.OMP_GUI_E2E_OUT = process.env.OMP_GUI_WORK_CARD_OUT;
		await fs.mkdir(shots ?? "", { recursive: true });
		const profile = await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-work-phone-"));
		const project = path.join(profile, "project");
		const desktop = path.join(profile, "desktop");
		const agent = path.join(profile, "agent");
		await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language: "ko", themeName: "light", firstRunComplete: true }),
		);
		const tailscale = await fixtureTailscale(profile, { backendState: "Running" });
		const app = await launchApp({
			project,
			desktop,
			agent,
			profile,
			env: { ...tailscale.env, OMP_GUI_TEST_WORK_RICH: "1", ...(fail ? { OMP_GUI_TEST_WORK_TYPES_FAIL: "1" } : {}) },
		});
		const browser = await chromium.launch();
		let proxy: ServeProxy | null = null;
		try {
			const page = await app.firstWindow();
			await page.waitForFunction(() => window.omp?.rpc != null);
			await page.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
			await expect
				.poll(
					() => page.evaluate(async () => (await window.omp.mobileWeb.getState()).phase).catch(() => "starting"),
					{
						timeout: 60_000,
					},
				)
				.toBe("ready");
			const [site] = serveSites(tailscale);
			if (!site) throw new Error("no serve handler published");
			proxy = await ServeProxy.start(site, "seuput@example.com");
			const context = await browser.newContext({
				...devices["Pixel 7"],
				viewport: { width: 390, height: 844 },
				colorScheme: "light",
			});
			const phone = await context.newPage();
			await phone.goto(`${proxy.url}/`);
			await expect(phone.getByRole("button", { name: /Open menu|메뉴 열기/ })).toBeVisible({ timeout: 60_000 });
			// A web window starts with no tab: the phone opens one in the project.
			await phone.evaluate(cwd => window.omp.tabs.spawn({ cwd, kind: "agent" }), project);
			await phone.reload();
			const input = phone.locator("[data-composer-input]").first();
			await expect(input).toBeVisible({ timeout: 60_000 });
			await input.click();
			await phone.keyboard.type("fixture work view");
			// A phone's Enter is a newline: the Send button sends.
			await phone.getByRole("button", { name: /^(Send|보내기)$/ }).click();
			await expect(phone.locator(".omp-work-sub")).toBeVisible({ timeout: 30_000 });
			const tab = (await phone.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId;
			if (!tab) throw new Error("Missing work tab");
			for (let index = 0; index < 14; index++)
				await phone.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:work-next" }),
					tab,
				);
			await expect(phone.locator(".omp-execution-group[data-state='running']")).toHaveCount(0, {
				timeout: 30_000,
			});
			await expect(phone.locator(".omp-execution-group-header").last()).toHaveAttribute(
				"aria-label",
				/types|타입|command|명령/,
			);
			const card = phone.locator(".omp-execution-group").last();
			for (const theme of THEMES) {
				// The theme is the phone's own record; the page reads it at boot, so a reload shows it.
				await phone.evaluate(async name => {
					await window.omp.prefs.set("themeName", name);
					await window.omp.prefs.set("theme", name);
				}, theme);
				await phone.reload();
				await expect(phone.locator("html")).toHaveAttribute("data-theme", theme);
				await expect(card).toBeVisible({ timeout: 60_000 });
				const header = card.locator(".omp-execution-group-header").first();
				await card.scrollIntoViewIfNeeded();
				// Start collapsed (the finished card is), capture, open, capture, close again.
				if ((await header.getAttribute("aria-expanded")) === "true") await header.click();
				await phone.waitForTimeout(400);
				const base = path.join(shots ?? "", `${label}-phone-${fail ? "fail" : "pass"}`);
				await card.screenshot({ path: `${base}-collapsed-ko-${theme}.png` });
				await header.click();
				// The opened card is taller than the screen; show it whole so no sticky bar covers its head.
				const opened = await card.boundingBox();
				await phone.setViewportSize({ width: 390, height: Math.ceil((opened?.height ?? 0) + 160) });
				await card.scrollIntoViewIfNeeded();
				await phone.waitForTimeout(400);
				await card.screenshot({ path: `${base}-expanded-ko-${theme}.png` });
				await header.click();
				await phone.setViewportSize({ width: 390, height: 844 });
			}
		} finally {
			await browser.close();
			await proxy?.close();
			await exitApp(app);
			await fs.rm(profile, { recursive: true, force: true });
		}
	});
}
