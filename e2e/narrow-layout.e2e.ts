import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { exitApp, launchApp, openDestination, pressShortcutUntilVisible, variants } from "./harness";

// At the smallest window OMPdesk allows (800×640, sidebar open) the settings
// nav labels read in full and no settings section or settings tab scrolls
// sideways: long paths and tab rows wrap inside the column. (A real session's
// stats at this width are checked in real-core.e2e.ts, which has a real id.)

/** Width by which a scroll container's content exceeds its box (0 = fits). */
const sideways = (scroller: Locator) => scroller.evaluate(element => element.scrollWidth - element.clientWidth);

// Korean labels are the widest, so Korean is the variant the default run keeps.
for (const language of variants(["en", "ko"] as const, language => language === "ko"))
	test(`settings fit the smallest window (${language})`, async () => {
		test.setTimeout(180_000);
		const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-narrow-layout-"));
		const [desktop, project, agent] = ["desktop", "project", "agent"].map(name => path.join(profile, name));
		await Promise.all([fs.mkdir(desktop), fs.mkdir(project), fs.mkdir(agent)]);
		execFileSync("git", ["init", "--quiet"], { cwd: project });
		await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language, firstRunComplete: true }));
		const app = await launchApp({
			project,
			desktop,
			agent,
			profile,
		});
		try {
			const page = await app.firstWindow();
			await page.waitForFunction(() => window.omp?.rpc != null);
			await expect
				.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
				.toBe("ready");
			await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 640));
			await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(800);

			const settings = page.locator("[data-settings-page]");
			await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
			const nav = settings.locator("[data-settings-section]");
			expect
				.soft(
					await nav.evaluateAll(buttons =>
						buttons.filter(button => button.scrollWidth > button.clientWidth).map(button => button.textContent),
					),
				)
				.toEqual([]);

			const content = settings.locator(".settings-content");
			// Compact rows: a label, its short description or info glyph and its control share one line, even here.
			await settings.locator('[data-settings-section="general"]').click();
			await expect(content.locator("#setting-gui-language")).toBeVisible();
			const rowHeights = await content.evaluate(() =>
				["setting-gui-language", "setting-gui-notifications", "setting-gui-panelSide"].map(
					id => document.getElementById(id)?.getBoundingClientRect().height ?? 0,
				),
			);
			expect.soft(rowHeights.every(height => height > 0 && height <= 48)).toBe(true);
			const overflowing: string[] = [];
			const ids = await nav.evaluateAll(buttons =>
				buttons.map(button => button.getAttribute("data-settings-section") ?? ""),
			);
			for (const id of ids) {
				await settings.locator(`[data-settings-section="${id}"]`).click();
				await expect(content.locator(".animate-spin")).toHaveCount(0, { timeout: 30_000 });
				if ((await sideways(content)) > 0) overflowing.push(id);
				const tabs = content.getByRole("tab");
				for (let index = 0; index < (await tabs.count()); index++) {
					await tabs.nth(index).click();
					await expect(content.locator(".animate-spin")).toHaveCount(0, { timeout: 30_000 });
					if ((await sideways(content)) > 0) overflowing.push(`${id} › ${await tabs.nth(index).textContent()}`);
				}
			}
			expect.soft(overflowing).toEqual([]);
			await page.keyboard.press("Escape");
		} finally {
			await exitApp(app);
			await fs.rm(profile, { recursive: true, force: true });
		}
	});

// The pull request center at the same width: the selected PR's detail keeps a
// readable column beside the list instead of a word per line.
test("pull requests fit the smallest window", async () => {
	test.setTimeout(120_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-narrow-prs-"));
	const [desktop, project, agent, bin] = ["desktop", "project", "agent", "bin"].map(name => path.join(profile, name));
	await Promise.all([fs.mkdir(desktop), fs.mkdir(project), fs.mkdir(agent), fs.mkdir(bin)]);
	execFileSync("git", ["init", "--quiet"], { cwd: project });
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const title = "Keep the selected pull request readable beside the list at the smallest window";
	const pr = { number: 7, title, url: "https://github.com/o/r/pull/7", author: { login: "dev" }, headRefName: "fix" };
	await fs.writeFile(path.join(bin, "list.json"), JSON.stringify([pr]));
	await fs.writeFile(path.join(bin, "view.json"), JSON.stringify({ ...pr, baseRefName: "main", body: "Body" }));
	// A stand-in `gh` ahead of the real one on PATH (main puts the inherited PATH first).
	await fs.writeFile(
		path.join(bin, "gh"),
		`#!/bin/sh\ncase "$1 $2" in\n"repo view") echo '{"nameWithOwner":"o/r","defaultBranchRef":{"name":"main"}}' ;;\n"pr list") cat "${bin}/list.json" ;;\n"pr view") cat "${bin}/view.json" ;;\n*) exit 1 ;;\nesac\n`,
		{ mode: 0o755 },
	);
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: {
			PATH: `${bin}${path.delimiter}${process.env.PATH}`,
		},
	});
	try {
		const page = await app.firstWindow();
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 640));
		await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(800);
		await openDestination(page, "agents");
		const agents = page.locator('section[data-destination="agents"]');
		await agents.getByRole("tab", { name: "Pull requests", exact: true }).click();
		await agents.getByRole("button", { name: title }).click();
		await expect(agents.getByRole("heading", { name: title })).toBeVisible();
		// 18rem of detail holds this title in a few lines; the fixed 20rem list left about 14rem.
		const detailWidth = await agents
			.getByRole("navigation", { name: "Pull requests" })
			.evaluate(list => list.nextElementSibling?.getBoundingClientRect().width ?? 0);
		expect(detailWidth).toBeGreaterThan(288);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true });
	}
});
