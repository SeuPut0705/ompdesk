import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { exitApp, launchApp, pressShortcutUntilVisible } from "./harness";

// The bot's identity and desk (Settings › Bot, the bot's pane): avatar, tagline, memory, its activity log with Undo,
// and side chats. `OMPDESK_BOT_IDENTITY_SHOTS=<dir>` also keeps the screenshots there.

let app: ElectronApplication;
let page: Page;
let profile: string;
let errors: string[];
let dirs: { project: string; desktop: string; agent: string };

test.beforeEach(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-botid-"));
	dirs = {
		project: path.join(profile, "project"),
		desktop: path.join(profile, "desktop"),
		agent: path.join(profile, "agent"),
	};
	await Promise.all(Object.values(dirs).map(dir => fs.mkdir(dir)));
	await fs.writeFile(
		path.join(dirs.desktop, "prefs.json"),
		JSON.stringify({ language: "en", firstRunComplete: true, botEnabled: true, theme: "light" }),
	);
	errors = [];
	app = await launchApp({
		...dirs,
		profile,
		env: { OMP_GUI_HEADLESS: "1", OMP_GUI_TEST_SESSION_FILES: "1" },
		args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
	});
	page = await app.firstWindow();
	page.on("pageerror", error => errors.push(error.message));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
});

test.afterEach(async () => {
	if (app) await exitApp(app);
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	expect(errors).toEqual([]);
});

async function capture(name: string): Promise<void> {
	const body = await page.screenshot({ animations: "disabled" });
	await test.info().attach(name, { body, contentType: "image/png" });
	const dir = process.env.OMPDESK_BOT_IDENTITY_SHOTS;
	if (dir) {
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, `${name}.png`), body);
	}
}

async function windowWidth(width: number): Promise<void> {
	await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size, 860), width);
}
async function desk(): Promise<{
	identity?: { avatar?: unknown; tagline?: string };
	memories?: { text: string }[];
	channels?: { title: string }[];
}> {
	try {
		return JSON.parse(await fs.readFile(path.join(dirs.desktop, "bot-desk.json"), "utf8"));
	} catch {
		return {};
	}
}

async function openSettings(): Promise<void> {
	await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", page.locator("[data-settings-page]"));
	await page.locator('[data-settings-page] [data-settings-section="bot"]').click();
	await expect(page.locator("[data-bot-avatar-shape]").first()).toBeVisible();
}

test("the bot's identity shows in Settings, the sidebar and its bar; memory, undo and side chats work on its desk", async () => {
	test.setTimeout(180_000);
	await windowWidth(1280);

	await openSettings();
	await page.locator('[data-bot-avatar-shape="rocket"]').click();
	await page.locator('[data-bot-avatar-color="success"]').click();
	const tagline = page.locator("[data-bot-tagline-field]");
	await tagline.fill("Keeps CI green");
	await tagline.blur();
	await expect
		.poll(async () => {
			const identity = (await desk()).identity;
			return [identity?.avatar, identity?.tagline];
		})
		.toEqual([{ kind: "mark", shape: "rocket", color: "success" }, "Keeps CI green"]);
	await expect(page.locator("[data-sidebar-bot-row] [data-sidebar-bot]").first()).toHaveAttribute(
		"data-bot-avatar",
		"rocket",
	);
	await capture("settings-1280");
	await windowWidth(760);
	await capture("settings-760");
	await windowWidth(1280);

	await page.locator("[data-sidebar-bot-row]").click();
	const pane = page.locator(".omp-session-pane:visible").first();
	await expect(pane.locator("[data-bot-bar] [data-bot-tagline]")).toHaveText("Keeps CI green");

	const input = pane.locator("[data-bot-memory-input]");
	await input.fill("Deploys on Fridays only");
	await input.press("Enter");
	const row = pane.locator("[data-bot-memory]");
	await expect(row).toHaveCount(1);
	await expect(row).toContainText("Deploys on Fridays only");
	await expect(row).toHaveAttribute("data-bot-memory-by", "owner");
	await expect.poll(async () => (await desk()).memories?.map(m => m.text)).toEqual(["Deploys on Fridays only"]);

	const entry = pane.locator("[data-bot-activity]").filter({ hasText: "Remembered: Deploys on Fridays only" });
	await expect(entry).toHaveCount(1);
	await entry.locator("[data-bot-activity-undo]").click();
	await expect(row).toHaveCount(0);
	await expect.poll(async () => (await desk()).memories ?? []).toEqual([]);
	await expect(entry).toContainText("Undone");
	await expect(entry.locator("[data-bot-activity-undo]")).toHaveCount(0);

	const channelInput = pane.locator("[data-bot-channel-input]");
	await channelInput.fill("Release notes");
	await channelInput.press("Enter");
	const channel = pane.locator("[data-bot-channel]");
	await expect(channel).toHaveCount(1);
	await expect(channel).toContainText("Release notes");
	await expect.poll(async () => (await desk()).channels?.map(c => c.title)).toEqual(["Release notes"]);
	await channel.locator("[data-bot-channel-open]").click();
	await expect(page.locator("[data-bot-channel-badge]").first()).toBeVisible();

	await page.locator("[data-sidebar-bot-row]").click();
	await expect(page.locator("[data-bot-tagline]").first()).toBeVisible();
	await capture("pane-1280");
	await windowWidth(760);
	await capture("pane-760");
});

test("the bot's voice call: its bar mounts from the bar's button, mutes and ends", async () => {
	test.setTimeout(120_000);
	await windowWidth(1280);
	await page.locator("[data-sidebar-bot-row]").click();
	const pane = page.locator(".omp-session-pane:visible").first();
	await pane.locator("[data-bot-call-start]").click();
	const bar = pane.locator("[data-bot-call-bar]");
	await expect(bar).toBeVisible();
	const listening = bar.and(page.locator('[data-bot-call-phase="listening"]'));
	const failed = bar.locator("[data-bot-call-error]");
	await expect(listening.or(failed)).toBeVisible({ timeout: 30_000 });
	const granted = (await failed.count()) === 0;
	test.info().annotations.push({ type: "branch", description: granted ? "granted" : "denied" });
	console.log(
		`bot call branch: ${granted ? "granted" : `denied (${await failed.getAttribute("data-bot-call-error")})`}`,
	);
	if (granted) {
		const mute = bar.locator("[data-bot-call-mute]");
		await mute.click();
		await expect(mute).toHaveAttribute("aria-pressed", "true");
		await expect(bar.locator("[data-bot-call-status]")).toHaveText("Muted");
	}
	await expect(bar.locator("[data-bot-call-end]")).toBeVisible();
	await capture("call-1280");
	await bar.locator("[data-bot-call-end]").click();
	await expect(pane.locator("[data-bot-call-bar]")).toHaveCount(0);
});
