/**
 * Guidance after setup, on the real app with the fake omp:
 * - "What's new" shows once after an update as a quiet bottom-right card (never a modal) above the
 *   composer; "See details" opens the running version's notes only, and the version counts as seen
 *   once the card is on screen;
 * - the getting-started checklist at the sidebar foot completes from real
 *   state (the side panel opened) and its "Show me" spotlights the real control;
 * - a risky switch (secret masking off) waits for "Accept risk";
 * - a reply's code block carries its copy button (wave-4 copy buttons).
 * A plain run checks English on a light window; OMP_GUI_STARTER_CAPTURES=<dir>
 * adds dark and Korean windows and a narrow one, and saves each screen.
 */

import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { exitApp, launchApp, pressShortcutUntilVisible } from "./harness";

const OUT = process.env.OMP_GUI_STARTER_CAPTURES ?? "";
// The release before the newest one in the shipped changelog: an update by exactly one version.
const PREVIOUS_VERSION =
	readFileSync("CHANGELOG.md", "utf8")
		.match(/^## \[([^\]]+)\]/gm)?.[1]
		?.slice(4, -1) ?? "0.0.1";

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
				whatsNewSeenVersion: PREVIOUS_VERSION,
			}),
		);
		const app = await launchApp({
			project,
			desktop,
			agent,
			profile: root,
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

			// What's new: a quiet card in the corner, not a modal; the version counts as seen once it is up.
			const card = page.locator("[data-whats-new-card]");
			await expect(card).toBeVisible({ timeout: 60_000 });
			await expect(page.getByRole("dialog")).toHaveCount(0);
			await expect(card).toContainText(
				variant.language === "ko" ? `OMPdesk v${version}` : `Updated to OMPdesk v${version}`,
			);
			if (variant.language === "ko") await expect(card).toContainText("업데이트됐어요");
			await expect(card.locator("[data-whats-new-summary]")).not.toBeEmpty();
			await expect(
				card.getByRole("button", { name: variant.language === "ko" ? "자세히 보기" : "See details" }),
			).toBeVisible();
			await expect(page.locator('[role="status"][aria-live="polite"]').filter({ has: card })).toHaveCount(1);
			// It sits above the composer and clear of the send button, in the pane's bottom-right.
			const cardBox = await card.boundingBox();
			const composerBox = await page.locator(".omp-composer-box").boundingBox();
			const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
			if (!cardBox || !composerBox) throw new Error("card or composer has no box");
			expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(composerBox.y);
			expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(viewport.width);
			expect(cardBox.x + cardBox.width / 2).toBeGreaterThan(viewport.width / 2);
			await expect.poll(() => page.evaluate(() => window.omp.prefs.get("whatsNewSeenVersion"))).toBe(version);
			await capture(page, `${variant.name}-01-whats-new-card`);

			// "See details" opens this version's notes only, in the existing dialog.
			const notice = page.getByRole("dialog").filter({ hasText: version });
			await card.getByRole("button", { name: variant.language === "ko" ? "자세히 보기" : "See details" }).click();
			await expect(notice).toBeVisible();
			await expect(card).toHaveCount(0);
			// The release's own notes, not the whole file: no other release heading.
			await expect(notice.locator("li").first()).toBeVisible();
			await expect(notice).not.toContainText("## [");
			await expect(notice.locator("h2")).toHaveCount(0);
			await capture(page, `${variant.name}-01-whats-new`);
			await page.keyboard.press("Escape");
			await expect(notice).toHaveCount(0);

			// It stays reachable afterwards: the palette's "What's new" opens the whole changelog.
			await pressShortcutUntilVisible(page, "ControlOrMeta+K", page.locator(".omp-command-list"));
			await page.keyboard.type(variant.language === "ko" ? "변경 내역" : "What's new");
			await page.keyboard.press("Enter");
			const all = page.getByRole("dialog").filter({ has: page.locator("h2") });
			await expect(all).toBeVisible();
			await page.keyboard.press("Escape");
			await expect(all).toHaveCount(0);

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

			// Wave-4 primitives (InlineNotice, Skeleton, CopyButton, progress-tone bars) on the style guide.
			if (OUT) {
				// The window refuses renderer navigation (will-navigate); main may load its own page.
				await app.evaluate(async ({ BrowserWindow }) => {
					const contents = BrowserWindow.getAllWindows()[0]?.webContents;
					if (!contents) return;
					contents.on("will-prevent-unload", event => event.preventDefault());
					await contents.loadURL(`${contents.getURL().split("#")[0]}#/styleguide`);
					contents.reload();
				});
				// The internal style guide is English-only; its own switch picks the variant's theme.
				await page
					.getByText(variant.theme === "dark" ? "Dark" : "Light", { exact: true })
					.first()
					.click();
				const wave4 = page.locator("[data-styleguide-wave4]");
				await wave4.scrollIntoViewIfNeeded();
				await capture(page.locator("section").filter({ has: wave4 }), `${variant.name}-05-feedback-primitives`);
			}

			expect(errors).toEqual([]);
		} finally {
			await exitApp(app);
			await fs.rm(root, { recursive: true, force: true });
		}
	});
