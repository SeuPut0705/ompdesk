import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { exitApp, fixtureOmp, launchApp, pressShortcutUntilVisible, variants } from "./harness";

for (const theme of variants(["light", "dark"] as const)) {
	test(`all panel views, modes and responsive chrome in ${theme}`, async () => {
		test.setTimeout(120_000);
		const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-panel-views-"));
		const desktop = path.join(profile, "desktop");
		const project = path.join(profile, "project");
		const agent = path.join(profile, "agent");
		await Promise.all([fs.mkdir(desktop), fs.mkdir(project), fs.mkdir(agent)]);
		execFileSync("git", ["init", "--quiet"], { cwd: project });
		const plan = path.join(project, "plan.md");
		await fs.writeFile(
			plan,
			"# Delivery plan\n\n- [x] Inspect stock session APIs\n- [ ] Ship the right-panel views\n- [ ] Review light and dark surfaces\n",
		);
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language: "en", theme, firstRunComplete: true, defaultPanelTab: "files" }),
		);
		const bin = await fixtureOmp(profile);
		const natives =
			process.env.OMP_GUI_TEST_NATIVES ||
			path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-natives");
		await fs.symlink(natives, path.join(path.dirname(bin), "node_modules/@oh-my-pi/pi-natives"), "junction");
		const app = await launchApp({
			project,
			desktop,
			agent,
			profile,
			env: {
				OMP_GUI_OMP: bin,
				OMP_GUI_TEST_PANEL_PLAN: plan,
			},
		});
		try {
			const page = await app.firstWindow();
			await page.waitForFunction(() => window.omp?.rpc != null);
			await expect
				.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status)
				.toBe("ready");
			const aside = page.locator("aside[data-docked]");
			await pressShortcutUntilVisible(page, "ControlOrMeta+j", aside);
			await expect(aside.locator(".omp-panel-topbar button")).toHaveCount(6);
			await expect(aside.getByRole("searchbox", { name: "Search files" })).toBeVisible();
			for (const label of ["Terminal", "Changes", "Preview", "Files"])
				await expect(aside.getByRole("button", { name: label, exact: true })).toBeVisible();
			await aside.screenshot({ animations: "disabled", path: test.info().outputPath(`header-${theme}.png`) });
			const options = aside.getByRole("button", { name: "View options", exact: true });
			await options.focus();
			await page.keyboard.press("Enter");
			const menu = page.getByRole("menu", { name: "View options" });
			await expect(menu.getByRole("menuitemcheckbox")).toHaveCount(6);
			await page.screenshot({ animations: "disabled", path: test.info().outputPath(`menu-${theme}.png`) });
			await page.keyboard.press("ArrowDown");
			await page.keyboard.press("Enter");
			await expect(aside).toContainText("Ship the right-panel views");
			await expect(aside.locator(".line-through")).toContainText("Inspect stock session APIs");
			await expect(aside.getByRole("button", { name: "Approve plan", exact: true })).toBeEnabled();
			await page.mouse.move(0, 0);
			await aside.screenshot({ animations: "disabled", path: test.info().outputPath(`plan-${theme}.png`) });
			await options.click();
			await expect(page.getByRole("menuitemcheckbox", { name: "Plan", exact: true })).toBeChecked();
			await page.getByRole("menuitemcheckbox", { name: "Background tasks", exact: true }).click();
			await expect(aside).toContainText("Completed local job");
			await aside.locator('[data-job-id="done"]').getByText("Result / error", { exact: true }).click();
			await expect(aside).toContainText("Compiled renderer");
			await expect(aside.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
			await expect(aside).toContainText("Build completed successfully.");
			await page.mouse.move(0, 0);
			await aside.screenshot({ animations: "disabled", path: test.info().outputPath(`jobs-${theme}.png`) });
			const capture = async (panel: Locator, name: string) => {
				await page.mouse.move(0, 0);
				await panel.screenshot({ animations: "disabled", path: test.info().outputPath(`${name}-${theme}.png`) });
			};
			const selectView = async (panel: Locator, label: string) => {
				if (["Terminal", "Changes", "Preview", "Files"].includes(label)) {
					await panel.locator(".omp-panel-topbar").getByRole("button", { name: label, exact: true }).click();
				} else {
					await panel.getByRole("button", { name: "View options", exact: true }).click();
					await page.getByRole("menuitemcheckbox", { name: label, exact: true }).click();
				}
				await expect(panel.locator(".omp-panel-topbar")).toContainText(label);
			};
			await aside.getByRole("separator", { name: "Resize side panel" }).focus();
			await page.keyboard.press("Home");
			await expect(aside).toHaveCSS("width", "360px");
			for (const label of [
				"Terminal",
				"Changes",
				"Preview",
				"Files",
				"Background tasks",
				"Plan",
				"Logs",
				"Queue",
				"Tree",
			]) {
				await selectView(aside, label);
				await capture(aside, `${label.toLowerCase().replaceAll(" ", "-")}-min`);
				if (label === "Changes") {
					const source = aside.getByRole("combobox", { name: "Changes", exact: true });
					for (const mode of ["repository", "current", "timeline", "artifacts"]) {
						await source.selectOption(mode);
						await capture(aside, `changes-${mode}`);
						if (mode === "repository") {
							await aside.locator('button[title="plan.md"]').click();
							await expect(aside.locator(".omp-changes-preview")).toContainText("Delivery plan");
							await capture(aside, "changes-repository-preview");
							await aside.getByRole("button", { name: "Back to changed files", exact: true }).click();
						}
					}
				}
				if (label === "Files") {
					const search = aside.getByRole("searchbox", { name: "Search files" });
					await search.fill("no-such-file");
					await capture(aside, "files-search-empty");
					await search.fill("");
					await aside.getByText("plan.md", { exact: true }).click();
					await expect(aside.getByRole("heading", { name: "Delivery plan" })).toBeVisible();
					await capture(aside, "files-viewer");
					await aside.getByRole("button", { name: "Back to files", exact: true }).click();
				}
			}
			await page.evaluate(() => window.omp.rpc.command({ type: "prompt", message: "fixture panel edits" }));
			await selectView(aside, "Changes");
			const source = aside.getByRole("combobox", { name: "Changes", exact: true });
			await source.selectOption("artifacts");
			await expect(aside).toContainText("review.md");
			for (const mode of ["current", "timeline", "artifacts"]) {
				await source.selectOption(mode);
				await expect(aside).toContainText(mode === "artifacts" ? "review.md" : "module-");
				await capture(aside, `changes-${mode}-populated`);
			}
			await selectView(aside, "Tree");
			await expect(aside.getByRole("application")).toBeVisible();
			await capture(aside, "tree-populated");
			await page.evaluate(() =>
				window.omp.rpc.command({
					type: "steer",
					message:
						"Review this long queued message and preserve its complete text while keeping the row actions aligned in a narrow panel.",
				}),
			);
			await selectView(aside, "Queue");
			await expect(aside).toContainText("Review this long queued message");
			await capture(aside, "queue-populated");
			await page.evaluate(() => window.omp.rpc.command({ type: "abort" }));
			await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(780, 900));
			await expect(aside).toHaveCount(0);
			const sheet = page.getByRole("dialog", { name: "Side panel", exact: true });
			await pressShortcutUntilVisible(page, "ControlOrMeta+j", sheet);
			await expect(sheet).toBeVisible();
			for (const label of [
				"Terminal",
				"Changes",
				"Preview",
				"Files",
				"Background tasks",
				"Plan",
				"Logs",
				"Queue",
				"Tree",
			]) {
				await selectView(sheet, label);
				await capture(sheet, `${label.toLowerCase().replaceAll(" ", "-")}-sheet`);
			}
		} finally {
			await exitApp(app);
			await fs.rm(profile, { recursive: true, force: true });
		}
	});
}
