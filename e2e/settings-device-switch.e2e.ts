/**
 * Settings' device pills across real windows: two OMPdesk apps that use each other as computers (A and B, the fake omp
 * and a fake Tailscale each), and B's phone page. A shows its pills, a click on B's pill shows B's settings at once
 * (the page stays open, a tab on B takes the focus, the banner names B), a click on "This device" comes back, and a
 * computer that went away refuses with its reason. B's own window and its phone page draw the strip too. Captures go
 * to `test-results/settings-device-switch-*.png`. The component tests (`SettingsDeviceSwitch.test.tsx`) hold the
 * pills, the highlight, the refusals and the keys; this spec is the flow over the wire.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, devices, expect, type Page, test } from "@playwright/test";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { exitApp } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, REMOTE_LOGIN, type RemoteInstance } from "./remote-harness";

const shot = (page: Page, name: string) =>
	page.screenshot({ path: `test-results/settings-device-switch-${name}.png`, scale: "css", animations: "disabled" });

const activeTab = async (page: Page) => (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active);

test("device pills show another computer's settings, come back, and refuse a computer that went away", async () => {
	test.setTimeout(300_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-settings-switch-")));
	let host: RemoteInstance | undefined;
	let client: RemoteInstance | undefined;
	let proxy: ServeProxy | undefined;
	const browser = await chromium.launch();
	try {
		const hostProfile = await makeRemoteProfile(parent, "host", { language: "en", theme: "light" });
		const clientProfile = await makeRemoteProfile(parent, "client", {
			language: "en",
			theme: "light",
			port: hostProfile.port,
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const b = host.page;
		const a = client.page;
		await a.evaluate(() => window.omp.remote.setDeviceName("PC-A"));
		const deviceId = await connectHost(b, a, "PC-B");
		await connectHost(a, b, "PC-A");
		for (const page of [a, b])
			await expect
				.poll(async () => (await page.evaluate(() => window.omp.remote.getState())).hosts[0]?.state, {
					timeout: 30_000,
				})
				.toBe("online");

		// A: the strip lists this device and B, this device shown.
		await a.keyboard.press("ControlOrMeta+Comma");
		const strip = a.locator("[data-settings-device-switch]");
		await expect(strip.locator("[data-settings-device]")).toHaveCount(2);
		const here = strip.locator('[data-settings-device="local"]');
		const there = strip.locator(`[data-settings-device="${deviceId}"]`);
		await expect(here).toHaveAttribute("aria-selected", "true");
		await expect(there).toContainText("PC-B");
		await expect(there).toHaveAttribute("data-link-state", "online");
		await expect(a.locator("[data-settings-device-banner]")).toHaveCount(0);
		await shot(a, "a-this-device");

		// A click on B's pill shows B's settings: the page stays open, a tab on B has the focus, the banner names B.
		await there.click();
		const banner = a.locator(`[data-settings-device-banner="${deviceId}"]`);
		await expect(banner).toContainText("These are PC-B's settings.", { timeout: 30_000 });
		await expect(there).toHaveAttribute("aria-selected", "true");
		await expect(a.locator("[data-settings-page]")).toBeVisible();
		const onB = await activeTab(a);
		expect(onB?.device).toBe(deviceId);
		const note = a.locator("[data-settings-host-note]");
		await expect(note).toContainText("Tabs on PC-B follow that device's own setting.");
		await expect(a.locator('[data-settings-nav="appearance"] [data-this-device-tag]')).toBeVisible();
		await shot(a, "a-paired-device");

		// Back to this device, then to B again (the empty chat tab it opened was closed on leaving: a new one opens).
		await here.click();
		await expect(a.locator("[data-settings-device-banner]")).toHaveCount(0);
		await expect(here).toHaveAttribute("aria-selected", "true");
		expect((await activeTab(a))?.device).toBeUndefined();
		await there.click();
		await expect(there).toHaveAttribute("aria-selected", "true");
		expect((await activeTab(a))?.device).toBe(deviceId);
		await here.click();
		await expect(here).toHaveAttribute("aria-selected", "true");

		// B's own window lists A the same way.
		await b.keyboard.press("ControlOrMeta+Comma");
		await expect(b.locator('[data-settings-device-switch] [data-settings-device="local"]')).toHaveAttribute(
			"aria-selected",
			"true",
		);
		await expect(b.locator("[data-settings-device-switch]")).toContainText("PC-A");
		await shot(b, "b-this-device");
		await b.keyboard.press("Escape");

		// B's phone page: the same strip at 390 px.
		await b.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
		await expect
			.poll(() => b.evaluate(async () => (await window.omp.mobileWeb.getState()).phase), { timeout: 60_000 })
			.toBe("ready");
		await expect.poll(() => serveSites(hostProfile.tailscale).length, { timeout: 30_000 }).toBeGreaterThan(0);
		const site = serveSites(hostProfile.tailscale).at(-1);
		if (!site) throw new Error("B's Mobile web published no serve handler");
		proxy = await ServeProxy.start(site, REMOTE_LOGIN);
		const phone = await (
			await browser.newContext({
				...devices["Pixel 7"],
				viewport: { width: 390, height: 844 },
				deviceScaleFactor: 3,
				colorScheme: "light",
			})
		).newPage();
		await phone.goto(`${proxy.url}/`, { timeout: 60_000 });
		await phonePaired(phone);
		await phone.locator("button:visible:has(svg.lucide-menu)").first().click();
		await phone.locator("[data-drawer]").waitFor({ state: "visible", timeout: 10_000 });
		await phone.locator('[data-destination="settings"]').first().click();
		const phoneStrip = phone.locator("[data-settings-device-switch]");
		await expect(phoneStrip.locator("[data-settings-device]")).toHaveCount(2);
		await expect(phoneStrip.locator('[data-settings-device="local"]')).toHaveAttribute("aria-selected", "true");
		await expect(phoneStrip).toContainText("PC-A");
		const sideways = await phone.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
		);
		expect(sideways, "the phone page does not scroll sideways").toBeLessThanOrEqual(0);
		await shot(phone, "phone");

		// B goes away: its pill on A is dimmed and refuses with the reason; nothing is opened and the shown device stays.
		await proxy.close().catch(() => undefined);
		proxy = undefined;
		await exitApp(host.app);
		await expect(there).not.toHaveAttribute("data-link-state", "online", { timeout: 60_000 });
		const tabsBefore = (await a.evaluate(() => window.omp.tabs.list())).length;
		await there.click();
		await expect(a.locator("[data-toast-stack]")).toContainText(/PC-B is (offline|still connecting)/);
		await expect(here).toHaveAttribute("aria-selected", "true");
		expect((await a.evaluate(() => window.omp.tabs.list())).length).toBe(tabsBefore);
		await shot(a, "a-offline");
	} finally {
		await browser.close().catch(() => undefined);
		await proxy?.close().catch(() => undefined);
		for (const instance of [client, host]) if (instance) await exitApp(instance.app);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
	}
});
