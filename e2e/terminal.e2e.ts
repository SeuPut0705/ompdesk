import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { exitApp, fixtureOmp, launchApp, pressShortcutUntilVisible, variants } from "./harness";

for (const theme of variants(["light", "dark"] as const)) {
	test(`real interactive terminal in ${theme}`, async () => {
		const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-terminal-"));
		const desktop = path.join(profile, "desktop");
		const project = path.join(profile, "project");
		const agent = path.join(profile, "agent");
		await Promise.all([fs.mkdir(desktop), fs.mkdir(project), fs.mkdir(agent)]);
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language: "en", theme, firstRunComplete: true, defaultPanelTab: "files" }),
		);
		const bin = await fixtureOmp(profile);
		// Fake agent, real installed stock PTY: never replace the shell with a fixture.
		const natives =
			process.env.OMP_GUI_TEST_NATIVES ||
			path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-natives");
		await fs.symlink(natives, path.join(path.dirname(bin), "node_modules/@oh-my-pi/pi-natives"), "dir");
		const app = await launchApp({
			project,
			desktop,
			agent,
			profile,
			env: {
				OMP_GUI_OMP: bin,
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
			await aside.getByRole("button", { name: "Terminal", exact: true }).click();
			await expect(aside.getByRole("tab", { name: "Terminal 1" })).toBeVisible();
			await expect(aside.locator(".omp-panel-topbar button")).toHaveCount(6);
			await expect(aside.getByRole("button", { name: "Copy selection", exact: true })).toBeVisible();
			const input = aside.locator(".xterm-helper-textarea");
			await input.focus();
			await page.keyboard.type("echo ompdesk-term");
			await page.keyboard.press("Enter");
			await expect.poll(() => aside.locator(".xterm-rows").innerText()).toMatch(/ompdesk-term[\s\S]*ompdesk-term/);
			await page.keyboard.type(process.platform === "win32" ? "cd" : "pwd");
			await page.keyboard.press("Enter");
			// A PTY wraps long paths at its column width; macOS also canonicalizes /var to /private/var.
			await expect
				.poll(async () => (await aside.locator(".xterm-rows").innerText()).replaceAll("\n", ""))
				.toContain(await fs.realpath(project));
			await aside.screenshot({ animations: "disabled", path: test.info().outputPath(`terminal-${theme}.png`) });
			await aside.getByRole("button", { name: "New terminal", exact: true }).click();
			await expect(aside.getByRole("tab")).toHaveCount(2);
			await aside.getByRole("button", { name: "Close terminal", exact: true }).last().click();
			await expect(aside.getByRole("tab")).toHaveCount(1);
			await input.focus();
			await page.keyboard.type("exit");
			await page.keyboard.press("Enter");
			await expect(aside.getByRole("button", { name: "Restart shell" })).toBeVisible();
			await aside.getByRole("button", { name: "Restart shell" }).click();
			await expect.poll(() => aside.innerText()).not.toContain("Restart shell");
			await input.focus();
			await page.keyboard.type("echo restarted-term");
			await page.keyboard.press("Enter");
			await expect
				.poll(() => aside.locator(".xterm-rows").innerText())
				.toMatch(/restarted-term[\s\S]*restarted-term/);
			await aside.getByRole("separator", { name: "Resize side panel" }).focus();
			await page.keyboard.press("Home");
			const toolbar = aside.getByRole("tablist").locator("..");
			const toolbarHeight = await toolbar.evaluate(element => element.getBoundingClientRect().height);
			for (let count = 2; count <= 5; count++) {
				await aside.getByRole("button", { name: "New terminal", exact: true }).click();
				await expect(aside.getByRole("tab")).toHaveCount(count);
			}
			await expect
				.poll(() => toolbar.evaluate(element => element.getBoundingClientRect().height))
				.toBe(toolbarHeight);
			// Chromium rounds scroll offsets at fractional tab widths; allow subpixel clipping.
			await expect(aside.getByRole("tab", { name: "Terminal 5", exact: true })).toBeInViewport({ ratio: 0.99 });
			for (const name of ["New terminal", "Copy selection", "Paste", "Clear terminal"]) {
				await expect(aside.getByRole("button", { name, exact: true })).toBeVisible();
			}
			await page.mouse.move(0, 0);
			await aside.screenshot({ animations: "disabled", path: test.info().outputPath(`terminal-many-${theme}.png`) });
		} finally {
			await exitApp(app);
			await fs.rm(profile, { recursive: true, force: true });
		}
	});
}
