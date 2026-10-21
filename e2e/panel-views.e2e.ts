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
			await expect(aside.locator(".omp-panel-topbar button")).toHaveCount(5);
			const openSheet = async (id: string, title: string) => {
				const search = page.getByRole("dialog").getByRole("searchbox");
				await pressShortcutUntilVisible(page, "ControlOrMeta+k", search);
				await search.fill(title);
				await page.getByRole("dialog").locator("button[data-palette-index]", { hasText: title }).first().click();
				await expect(page.getByRole("dialog", { name: title })).toBeVisible();
				await expect(page.locator(`[data-view-sheet="${id}"]`)).toBeVisible();
			};
			const closeSheet = async (title: string) => {
				await page.getByRole("dialog", { name: title }).getByRole("button", { name: "Close", exact: true }).click();
				await expect(page.getByRole("dialog", { name: title })).toHaveCount(0);
			};
			await expect(aside.getByRole("searchbox", { name: "Search files" })).toBeVisible();
			for (const label of ["Terminal", "Changes", "Preview", "Files"])
				await expect(aside.getByRole("button", { name: label, exact: true })).toBeVisible();
			await aside.screenshot({ animations: "disabled", path: test.info().outputPath(`header-${theme}.png`) });
			await expect(aside.getByRole("button", { name: "View options", exact: true })).toHaveCount(0);
			await expect(aside.getByRole("button", { name: "More", exact: true })).toHaveCount(0);
			await openSheet("plan", "Plan document");
			const planSheet = page.getByRole("dialog", { name: "Plan document" });
			await expect(planSheet).toContainText("Ship the right-panel views");
			await expect(planSheet.locator(".line-through")).toContainText("Inspect stock session APIs");
			await expect(planSheet.getByRole("button", { name: "Approve plan", exact: true })).toBeEnabled();
			await page.mouse.move(0, 0);
			await planSheet.screenshot({ animations: "disabled", path: test.info().outputPath(`plan-${theme}.png`) });
			await planSheet.getByRole("button", { name: "Close", exact: true }).click();
			await expect(planSheet).toHaveCount(0);
			await openSheet("jobs", "Background tasks");
			const jobsSheet = page.getByRole("dialog", { name: "Background tasks" });
			await expect(jobsSheet).toContainText("Completed local job");
			await jobsSheet.locator('[data-job-id="done"]').getByText("Result / error", { exact: true }).click();
			await expect(jobsSheet).toContainText("Compiled renderer");
			await expect(jobsSheet.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
			await expect(jobsSheet).toContainText("Build completed successfully.");
			await page.mouse.move(0, 0);
			await jobsSheet.screenshot({ animations: "disabled", path: test.info().outputPath(`jobs-${theme}.png`) });
			await jobsSheet.getByRole("button", { name: "Close", exact: true }).click();
			await expect(jobsSheet).toHaveCount(0);
			const capture = async (panel: Locator, name: string) => {
				await page.mouse.move(0, 0);
				await panel.screenshot({ animations: "disabled", path: test.info().outputPath(`${name}-${theme}.png`) });
			};
			const selectView = async (panel: Locator, label: string) => {
				await panel.locator(".omp-panel-topbar").getByRole("button", { name: label, exact: true }).click();
				await expect(panel.locator(".omp-panel-topbar")).toContainText(label);
			};
			await aside.getByRole("separator", { name: "Resize side panel" }).focus();
			await page.keyboard.press("Home");
			await expect(aside).toHaveCSS("width", "360px");
			for (const label of ["Terminal", "Changes", "Preview", "Files"]) {
				await selectView(aside, label);
				await capture(aside, `${label.toLowerCase()}-min`);
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
			for (const [id, title] of [
				["jobs", "Background tasks"],
				["plan", "Plan document"],
				["logs", "Logs"],
			] as const) {
				await openSheet(id, title);
				await capture(page.getByRole("dialog", { name: title }), `${id}-sheet-min`);
				await closeSheet(title);
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
			await openSheet("tree", "Session tree");
			await expect(page.locator('[data-view-sheet="tree"]').getByRole("application")).toBeVisible();
			await capture(page.getByRole("dialog", { name: "Session tree" }), "tree-populated");
			await page.evaluate(() =>
				window.omp.rpc.command({
					type: "steer",
					message:
						"Review this long queued message and preserve its complete text while keeping the row actions aligned in a narrow panel.",
				}),
			);
			await closeSheet("Session tree");
			await page.locator("[data-queue-pill]").click();
			const lanes = page.locator("[data-lane-clear]");
			await expect(page.getByText("Review this long queued message")).toBeVisible();
			await page.screenshot({ animations: "disabled", path: test.info().outputPath(`queue-popover-${theme}.png`) });
			await page.locator('[data-lane-clear="steering"]').click();
			await expect(lanes).toHaveCount(0);
			await page.evaluate(() => window.omp.rpc.command({ type: "abort" }));
			await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(780, 900));
			try {
				await expect(aside).toHaveCount(0);
			} catch (error) {
				// Nightly 39521754163: the panel stayed docked 10 s after the resize, once. Whether the window resized,
				// what the page measured and whether it was drawing at all (an occluded window runs no frames, so no media
				// query change is delivered).
				const native = await app.evaluate(({ BrowserWindow }) => {
					const win = BrowserWindow.getAllWindows()[0];
					return { bounds: win?.getBounds(), visible: win?.isVisible(), focused: win?.isFocused() };
				});
				const measured = await page.evaluate(() => ({
					inner: [innerWidth, innerHeight],
					visibility: document.visibilityState,
					shell: document.documentElement.dataset.shell ?? null,
				}));
				await test.info().attach("resize-state.json", { body: JSON.stringify({ native, measured }, null, 2) });
				throw error;
			}
			const sheet = page.getByRole("dialog", { name: "Side panel", exact: true });
			await pressShortcutUntilVisible(page, "ControlOrMeta+j", sheet);
			await expect(sheet).toBeVisible();
			for (const label of ["Terminal", "Changes", "Preview", "Files"]) {
				await selectView(sheet, label);
				await capture(sheet, `${label.toLowerCase()}-sheet`);
			}
			await expect(sheet.getByRole("button", { name: "View options", exact: true })).toHaveCount(0);
		} finally {
			await exitApp(app);
			await fs.rm(profile, { recursive: true, force: true });
		}
	});
}
