import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { exitApp, fixtureOmp, launchApp, mailReports } from "./harness";

// Taking a session over from the bot and handing it back never carries a secret (src/main/agent-control/
// bot-takeover.ts on the shared capture, terminal-capture.ts): on stock's real PTY (the fake omp borrowing the
// installed pi-natives, as bot-teach-secrets.e2e.ts), the owner takes the session over, answers a no-echo password
// prompt (`read -s`) and runs a command carrying a bearer token, then presses Hand back on the session's bar. The note
// the session gets lists the commands with the password hidden and the token redacted; the activity log holds neither.

test.skip(process.platform === "win32", "`read -s` and /bin/bash are the POSIX shell's");

const PASSWORD = "hunter2-takeover-e2e";
const TOKEN = "sk-live-takeover0123456789abcdefABCDEF";

test("a hand-back note lists the owner's commands with the password hidden and the token redacted", async () => {
	test.setTimeout(120_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-takeover-secrets-"));
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
		const sessionPath = await page.evaluate(async () => (await window.omp.tabs.list())[0]?.sessionPath ?? null);
		expect(sessionPath).toEqual(expect.any(String));

		// Take over: the tab's pane says the owner has it.
		await page.evaluate(
			path => window.omp.sessions.botDesk.takeover({ action: "take", sessionPath: path }),
			sessionPath as string,
		);
		const bar = page.locator("[data-bot-takeover-bar]");
		await expect(bar).toBeVisible({ timeout: 20_000 });

		const aside = page.locator("aside[data-docked]");
		await page.getByRole("button", { name: "Side panel", exact: true }).click();
		await aside.getByRole("button", { name: "Terminal", exact: true }).click();
		const viewport = aside.locator("[data-terminal-viewport]");
		await viewport.locator(".xterm-helper-textarea").focus();
		await page.keyboard.type("echo ready\n");
		await expect(viewport).toContainText("ready", { timeout: 20_000 });
		// The prompt is built by printf, so "Password:" shows only once the shell prints it, never in the typed command.
		await page.keyboard.type("read -s -p \"$(printf 'Pass%s: ' word)\" pw; echo got-it\n");
		await expect(viewport).toContainText("Password:", { timeout: 20_000 });
		await page.keyboard.type(`${PASSWORD}\n`);
		await expect(viewport).toContainText("Password: got-it", { timeout: 20_000 });
		await page.keyboard.type(`echo curl -H 'Authorization: Bearer ${TOKEN}' https://api.example.invalid\n`);
		await expect(viewport).toContainText("api.example.invalid", { timeout: 20_000 });
		// The session under the owner's hand, wide and narrow: `OMPDESK_BOT_SHOTS=<dir>` keeps the captures.
		for (const [name, width] of [
			["takeover-wide", 1440],
			["takeover-narrow", 820],
		] as const) {
			await app.evaluate(
				({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size, 860),
				width,
			);
			await expect(bar).toBeVisible();
			const body = await page.screenshot({ animations: "disabled" });
			await test.info().attach(name, { body, contentType: "image/png" });
			const dir = process.env.OMPDESK_BOT_SHOTS;
			if (dir) {
				await fs.mkdir(dir, { recursive: true });
				await fs.writeFile(path.join(dir, `${name}.png`), body);
			}
		}

		await bar.getByRole("button", { name: "Hand back", exact: true }).click();
		await expect(bar).toHaveCount(0, { timeout: 20_000 });

		const note = () =>
			mailReports(record, details => typeof details.id === "string" && details.id.startsWith("takeover-"));
		await expect.poll(async () => (await note()).length, { timeout: 60_000 }).toBe(1);
		const content = String((await note())[0]?.content);
		expect(content).toContain("$ echo ready");
		expect(content).toContain("$ read -s -p");
		expect(content).toContain("[hidden: typed at a password prompt]");
		expect(content).toContain("$ echo curl -H 'Authorization:");
		expect(content).not.toContain(PASSWORD);
		expect(content).not.toContain(TOKEN);

		const log = JSON.stringify(await page.evaluate(() => window.omp.sessions.botDesk.activity()));
		expect(log).toContain('"hand_back"');
		expect(log).not.toContain(PASSWORD);
		expect(log).not.toContain(TOKEN);
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
