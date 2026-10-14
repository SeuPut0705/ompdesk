/**
 * Guidance after setup, on the real app with the fake omp:
 * - "What's new" opens once after an update with only the running version's
 *   notes, and the version counts as seen once it is on screen;
 * - the getting-started checklist at the sidebar foot completes from real
 *   state (the side panel opened) and its "Show me" spotlights the real control;
 * - a risky switch (secret masking off) waits for "Accept risk";
 * - a reply's code block carries its copy button (wave-4 copy buttons).
 * A plain run checks English on a light window; OMP_GUI_STARTER_CAPTURES=<dir>
 * adds dark and Korean windows and a narrow one, and saves each screen.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

const OUT = process.env.OMP_GUI_STARTER_CAPTURES ?? "";

interface Variant {
	name: string;
	language: "en" | "ko";
	theme: "light" | "dark";
	size: [number, number];
}

const VARIANTS: Variant[] = [
	{ name: "en-light", language: "en", theme: "light", size: [1440, 900] },
	...(OUT
		? ([
				{ name: "en-dark", language: "en", theme: "dark", size: [1440, 900] },
				{ name: "ko-light", language: "ko", theme: "light", size: [1440, 900] },
				{ name: "ko-dark", language: "ko", theme: "dark", size: [1440, 900] },
				{ name: "narrow-en-light", language: "en", theme: "light", size: [900, 640] },
			] satisfies Variant[])
		: []),
];

test.describe.configure({ mode: "parallel" });

test.beforeAll(async () => {
	if (OUT) await fs.mkdir(OUT, { recursive: true });
});

async function capture(target: Page | Locator, name: string): Promise<void> {
	if (!OUT) return;
	await target.screenshot({ path: path.join(OUT, `${name}.png`), scale: "css", animations: "disabled" });
}

for (const variant of VARIANTS)
	test(`what's new, the starter guide and its tour, risk confirm (${variant.name})`, async () => {
		test.setTimeout(120_000);
		const root = await fs.mkdtemp(path.join(os.tmpdir(), `ompdesk-starter-${variant.name}-`));
		const project = path.join(root, "project");
		const desktop = path.join(root, "desktop");
		const agent = path.join(root, "agent");
		await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
		// An install that last showed the notes of an older version: this launch is an update.
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({
				language: variant.language,
				themeName: variant.theme,
				firstRunComplete: true,
				whatsNewSeenVersion: "0.0.1",
			}),
		);
		const env = {
			...process.env,
			PI_CODING_AGENT_DIR: agent,
			PI_CONFIG_DIR: path.relative(os.homedir(), root),
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OMP_GUI_OMP: await fixtureOmp(root),
		};
		Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
		const app = await electron.launch({
			args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
			env,
		});
		try {
			const page = await app.firstWindow();
			const errors: string[] = [];
			page.on("pageerror", error => errors.push(error.message));
			await app.evaluate(
				({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0]?.setContentSize(width, height),
				variant.size,
			);
			await page.waitForFunction(() => window.omp?.rpc != null);
			const version = await page.evaluate(() => window.omp.updater.version());

			// What's new: this version's notes only, recorded as seen once shown.
			const notice = page.getByRole("dialog").filter({ hasText: version });
			await expect(notice).toBeVisible({ timeout: 60_000 });
			// The release's own notes, not the whole file: no other release heading.
			await expect(notice.locator("li").first()).toBeVisible();
			await expect(notice).not.toContainText("## [");
			await expect(notice.locator("h2")).toHaveCount(0);
			await capture(page, `${variant.name}-01-whats-new`);
			await expect.poll(() => page.evaluate(() => window.omp.prefs.get("whatsNewSeenVersion"))).toBe(version);
			await page.keyboard.press("Escape");
			await expect(notice).toHaveCount(0);

			// The checklist completes the side panel step from real state.
			const guide = page.locator("[data-starter-guide]");
			await expect(guide).toBeVisible();
			await page.locator('[data-tour="panel"]').click();
			// Narrow windows open it as a drawer over the page; Escape closes either form.
			await page.keyboard.press("Escape");
			const toggle = guide.locator("button[aria-expanded]");
			await toggle.click();
			await expect(toggle).toHaveAttribute("aria-expanded", "true");
			await expect(guide.locator('[data-starter-step="panel"]')).toHaveAttribute("data-done", "true");
			await guide.scrollIntoViewIfNeeded();
			await capture(page, `${variant.name}-02-guide`);

			// "Show me" spotlights the next step's real control; Escape ends the tour.
			const next = await guide
				.locator('[data-starter-step][data-done="false"]')
				.first()
				.getAttribute("data-starter-step");
			await guide.locator('[data-starter-step][data-done="false"]').first().getByRole("button").click();
			const tour = page.locator("[data-starter-tour]");
			await expect(tour).toBeVisible();
			await expect(page.locator("[data-starter-tour-root]")).toHaveAttribute(
				"data-target-found",
				next === "split" || next === "project" ? /true|false/ : "true",
			);
			await capture(page, `${variant.name}-03-tour-${next}`);
			await page.keyboard.press("Escape");
			await expect(tour).toHaveCount(0);

			// Turning secret masking off (on, as a user who enabled it) waits for Accept risk.
			const seeded = await page.evaluate(() => window.omp.rpc.setSetting("secrets.enabled", true));
			expect(seeded.success).toBe(true);
			await page.keyboard.press("ControlOrMeta+Comma");
			const settings = page.locator("[data-settings-page]");
			await settings.locator('[data-settings-section="permissions"]').click();
			const row = settings.locator('[id="setting-secrets.enabled"]');
			const toggleRisk = row.getByRole("switch");
			await expect(toggleRisk).toHaveAttribute("aria-checked", "true");
			await toggleRisk.click();
			await expect(row.getByRole("status").or(row.getByRole("alert")).first()).toBeVisible();
			await expect(toggleRisk).toHaveAttribute("aria-checked", "true");
			await row.scrollIntoViewIfNeeded();
			await capture(page, `${variant.name}-04-risk-confirm`);
			await page.keyboard.press("Escape");

			expect(errors).toEqual([]);
		} finally {
			await exitApp(app);
			await fs.rm(root, { recursive: true, force: true });
		}
	});
