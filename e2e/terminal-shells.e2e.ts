import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp, variants } from "./harness";

// Terminal panel: a second shell from the + menu (C103), the default shell
// setting (C104) and the expand toggle (C106), on stock's PTY through the
// fake omp borrowing the installed pi-natives. OMP_GUI_TERMINAL_CAPTURES=<dir>.

test.skip(process.platform === "win32", "the shells this spec picks are macOS paths");

for (const [language, theme] of variants([
	["en", "light"],
	["ko", "dark"],
] as const)) {
	test(`terminal shells, default shell setting and expand (${language}-${theme})`, async () => {
		test.setTimeout(120_000);
		const ko = language === "ko";
		const captures = process.env.OMP_GUI_TERMINAL_CAPTURES;
		const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-terminal-shells-"));
		const desktop = path.join(profile, "desktop");
		const project = path.join(profile, "project");
		const agent = path.join(profile, "agent");
		await Promise.all([fs.mkdir(desktop), fs.mkdir(project), fs.mkdir(agent)]);
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language, themeName: theme, firstRunComplete: true, terminalShell: "/bin/bash" }),
		);
		const bin = await fixtureOmp(profile);
		const natives =
			process.env.OMP_GUI_TEST_NATIVES ||
			path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-natives");
		await fs.symlink(natives, path.join(path.dirname(bin), "node_modules/@oh-my-pi/pi-natives"), "junction");
		const record = path.join(profile, "record.jsonl");
		const env = {
			...process.env,
			OMP_GUI_HEADLESS: "1",
			PI_CODING_AGENT_DIR: agent,
			OMP_GUI_OMP: bin,
			OMP_GUI_TEST_RECORD: record,
		};
		Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
		const app = await electron.launch({
			args: [
				path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"),
				project,
				`--user-data-dir=${desktop}`,
			],
			env,
		});
		const page = await app.firstWindow();
		try {
			await page.waitForFunction(() => window.omp?.rpc != null);
			await expect
				.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
				.toBe("ready");
			const aside = page.locator("aside[data-docked]");
			await page.getByRole("button", { name: ko ? "사이드 패널" : "Side panel", exact: true }).click();
			await aside.getByRole("button", { name: ko ? "터미널" : "Terminal", exact: true }).click();
			const viewport = aside.locator("[data-terminal-viewport]");
			// C104: the default-shell pref starts bash.
			await viewport.click();
			await page.keyboard.type("echo shell=$0\n");
			await expect(viewport).toContainText(/shell=.*bash/, { timeout: 20_000 });

			// C103: + menu opens another shell.
			await aside
				.getByRole("button", { name: ko ? "다른 셸로 새 터미널 열기" : "New terminal with another shell" })
				.click();
			await page.getByRole("menuitem", { name: ko ? "새 터미널: zsh" : "New terminal: zsh" }).click();
			await expect(aside.getByRole("tab")).toHaveCount(2);
			await viewport.click();
			await page.keyboard.type("echo shell=$0\n");
			await expect(viewport).toContainText(/shell=.*zsh/, { timeout: 20_000 });

			// C106: expand widens the docked panel and restores it.
			const before = (await aside.boundingBox())?.width ?? 0;
			await aside.getByRole("button", { name: ko ? "패널 넓히기" : "Expand panel", exact: true }).click();
			await expect.poll(async () => (await aside.boundingBox())?.width ?? 0).toBeGreaterThan(before + 50);
			if (captures) {
				await fs.mkdir(captures, { recursive: true });
				await page.screenshot({ path: path.join(captures, `terminal-expanded-${language}-${theme}.png`) });
			}
			await aside
				.getByRole("button", { name: ko ? "패널 너비 되돌리기" : "Restore panel width", exact: true })
				.click();
			await expect.poll(async () => Math.round((await aside.boundingBox())?.width ?? 0)).toBe(Math.round(before));

			// C164: /cleanse types stock's `omp cleanse` with the request into the tab's terminal.
			const composer = page.locator("textarea").first();
			await composer.fill("/cleanse lint warnings");
			await composer.press("Enter");
			await expect(viewport).toContainText("omp cleanse lint warnings", { timeout: 20_000 });

			// C115: the agent's read-only gui_terminal_read sees the tab's terminals (registered via set_host_tools).
			const frames = async () =>
				(await fs.readFile(record, "utf8").catch(() => ""))
					.split("\n")
					.filter(Boolean)
					.map(line => JSON.parse(line) as { type?: string; tools?: { name: string }[]; result?: unknown });
			// The control tools (ompdesk_*, default on) follow these two.
			expect(
				(await frames())
					.find(frame => frame.type === "set_host_tools")
					?.tools?.map(tool => tool.name)
					.slice(0, 2),
			).toEqual(["gui_terminal_read", "gui_visualize"]);
			await composer.fill("!fixture:host-tool:gui_terminal_read");
			await composer.press("Enter");
			await expect
				.poll(async () => JSON.stringify((await frames()).find(frame => frame.type === "host_tool_result")?.result))
				.toContain("Terminal 1: running");
			const result = JSON.stringify((await frames()).find(frame => frame.type === "host_tool_result")?.result);
			expect(result).toContain("Terminal 2: running");
			expect(result).toContain("shell=");
		} finally {
			await exitApp(app);
			await fs.rm(profile, { recursive: true, force: true });
		}
	});
}
