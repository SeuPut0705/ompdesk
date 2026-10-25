import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, devices, expect, test } from "@playwright/test";
import { en } from "../src/renderer/locales/en";
import { ServeProxy, serveSites } from "./fixture/phone-serve";
import { exitApp, readRecords } from "./harness";
import { launchRemote, makeRemoteProfile, REMOTE_LOGIN } from "./remote-harness";

// Real phone WebSocket and renderer against an isolated host. ProviderLogin component tests cover submission races.
test("a phone signs in on its host through the provider URL and paste, including cancel and reload", async () => {
	test.setTimeout(180_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-phone-oauth-")));
	const profile = await makeRemoteProfile(parent, "host", {
		language: "en",
		theme: "light",
		env: { OMP_GUI_TEST_LOGIN: "1" },
		prefs: { lastProject: path.join(parent, "host", "project") },
	});
	const host = await launchRemote(profile);
	const browser = await chromium.launch();
	let proxy: ServeProxy | undefined;
	try {
		await host.page.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
		await expect
			.poll(async () => (await host.page.evaluate(() => window.omp.mobileWeb.getState())).phase)
			.toBe("ready");
		const [target] = serveSites(profile.tailscale);
		if (!target) throw new Error("No phone serve target");
		proxy = await ServeProxy.start(target, REMOTE_LOGIN);
		const context = await browser.newContext({ ...devices["Pixel 7"], colorScheme: "light" });
		// Never reach the real provider or share real browser credentials.
		await context.route("https://claude.ai/**", route => route.fulfill({ body: "Isolated authorization page" }));
		const phone = await context.newPage();
		const errors: string[] = [];
		phone.on("pageerror", error => errors.push(error.message));
		await phone.goto(proxy.url);
		await expect(phone.locator("[data-composer-input]").first()).toBeVisible({ timeout: 60_000 });
		await phone.locator("header button:has(svg.lucide-menu)").click();
		await phone.locator('[data-destination="settings"]').click();
		await phone.locator('[data-settings-section="models"]').click();
		await phone.getByRole("button", { name: "Add a provider" }).click();
		await phone.locator('button[data-provider-connect="anthropic"]').click();
		const panel = phone.locator("[data-login-panel]");
		const paste = panel.getByLabel("Authorization code or redirect address");
		await expect(paste).toBeVisible();
		await expect(paste).toHaveAttribute("type", "password");
		const popupPromise = context.waitForEvent("page");
		await panel.getByRole("button", { name: en["providerList.login.openBrowser"] }).click();
		const popup = await popupPromise;
		await expect.poll(() => new URL(popup.url()).hostname).toBe("claude.ai");
		await popup.close();
		await panel.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(panel.locator("[data-login-progress]")).toHaveCount(0);
		await expect
			.poll(async () => (await readRecords(profile.record)).filter(frame => frame.type === "login").length)
			.toBe(1);
		await phone.locator('button[data-provider-connect="anthropic"]').click();
		await expect(paste).toBeVisible();
		await phone.reload();
		await expect(phone.locator("[data-composer-input]").first()).toBeVisible({ timeout: 60_000 });
		await phone.locator("header button:has(svg.lucide-menu)").click();
		await phone.locator('[data-destination="settings"]').click();
		await phone.locator('[data-settings-section="models"]').click();
		await expect(paste).toBeVisible();
		await phone.screenshot({ path: test.info().outputPath("phone-login-paste.png") });
		await paste.fill("abc");
		await panel.getByRole("button", { name: "Connect", exact: true }).click();
		await expect(phone.getByText("Signed in to Anthropic")).toBeVisible();
		await expect(panel.locator("[data-login-progress]")).toHaveCount(0);
		await expect(phone.locator("[data-prompt-card]")).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		await browser.close();
		await proxy?.close();
		await exitApp(host.app);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
