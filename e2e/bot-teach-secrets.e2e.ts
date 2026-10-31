import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { exitApp, fixtureOmp, launchApp, mailReports } from "./harness";

// Teaching the bot never records a secret (src/main/agent-control/bot-teach.ts): on stock's real PTY (the fake omp
// borrowing the installed pi-natives, as terminal-shells.e2e.ts), the owner records a demonstration in the Terminal
// panel, answers a no-echo password prompt (`read -s`) and runs a command. The record the bot gets keeps the command
// and the prompt's own line, and holds only a marker where the password was typed.

test.skip(process.platform === "win32", "`read -s` and /bin/bash are the POSIX shell's");

test("a demonstration hides what was typed at a no-echo password prompt and keeps the commands", async () => {
	test.setTimeout(120_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-teach-secrets-"));
	const dirs = {
		desktop: path.join(profile, "desktop"),
		project: path.join(profile, "project"),
		agent: path.join(profile, "agent"),
	};
	await Promise.all(Object.values(dirs).map(dir => fs.mkdir(dir)));
	await fs.writeFile(
		path.join(dirs.desktop, "prefs.json"),
		JSON.stringify({ language: "en", firstRunComplete: true, botEnabled: true, terminalShell: "/bin/bash" }),
	);
	const bin = await fixtureOmp(profile);
	const natives =
		process.env.OMP_GUI_TEST_NATIVES ||
		path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-natives");
	await fs.symlink(natives, path.join(path.dirname(bin), "node_modules/@oh-my-pi/pi-natives"), "junction");
	const record = path.join(profile, "record.jsonl");
	const app = await launchApp({
		...dirs,
		profile,
		env: { OMP_GUI_HEADLESS: "1", OMP_GUI_OMP: bin, OMP_GUI_TEST_RECORD: record, OMP_GUI_TEST_SESSION_FILES: "1" },
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	try {
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		await expect.poll(async () => page.evaluate(() => window.omp.prefs.get("bot"))).toEqual(expect.any(String));

		const aside = page.locator("aside[data-docked]");
		await page.getByRole("button", { name: "Side panel", exact: true }).click();
		await aside.getByRole("button", { name: "Terminal", exact: true }).click();
		const viewport = aside.locator("[data-terminal-viewport]");
		await viewport.locator(".xterm-helper-textarea").focus();
		await page.keyboard.type("echo ready\n");
		await expect(viewport).toContainText("ready", { timeout: 20_000 });

		await page.evaluate(() => window.omp.sessions.botDesk.teach({ action: "start" }));
		// The prompt is built by printf, so "Password:" shows only once the shell prints it, never in the typed command.
		await page.keyboard.type("read -s -p \"$(printf 'Pass%s: ' word)\" pw; echo got-it\n");
		await expect(viewport).toContainText("Password:", { timeout: 20_000 });
		await page.keyboard.type("hunter2-e2e\n");
		await expect(viewport).toContainText("Password: got-it", { timeout: 20_000 });
		await page.keyboard.type("echo visible-line\n");
		await expect(viewport).toContainText(/visible-line[\s\S]*visible-line/, { timeout: 20_000 });
		expect(await page.evaluate(() => window.omp.sessions.botDesk.teach({ action: "stop" }))).toEqual({
			delivered: true,
		});

		const teachMail = () =>
			mailReports(record, details => typeof details.id === "string" && details.id.startsWith("bot-teach-"));
		await expect.poll(async () => (await teachMail()).length, { timeout: 60_000 }).toBe(1);
		const content = String((await teachMail())[0]?.content);
		expect(content).toContain("terminal: echo visible-line");
		expect(content).toContain("terminal: read -s -p");
		expect(content).toContain("[hidden: typed at a password prompt]");
		expect(content).not.toContain("hunter2");
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
