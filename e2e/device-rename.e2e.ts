/**
 * One name per device, renamable at any time from either side (two apps on the fake omp, remote-harness.ts):
 * device A renames the host it uses through the host row's Rename; the host's own device name changes, both
 * Settings and A's sidebar show it, and it survives A's relaunch. The host renames itself and A sees it live;
 * the host renames A, and A's own name changes. Rules are unit-tested in src/main/remote/devices-rename.test.ts
 * and RemoteSection.test.tsx.
 *
 * `OMP_GUI_DEVICE_RENAME=<dir>` writes Korean captures of A's Devices page (desktop and 390 wide) in the
 * profile's theme (`OMP_GUI_DEVICE_RENAME_THEME`, light by default).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { exitApp } from "./harness";
import { launchRemote, makeRemoteProfile, pair, type RemoteInstance } from "./remote-harness";

const SHOTS = process.env.OMP_GUI_DEVICE_RENAME;
const THEME = process.env.OMP_GUI_DEVICE_RENAME_THEME === "dark" ? "dark" : "light";
const LANGUAGE = SHOTS ? "ko" : "en";

async function openDevices(page: Page): Promise<void> {
	await page.keyboard.press("ControlOrMeta+Comma");
	await page.locator('[data-settings-page] [data-settings-section="connections"]').click();
	await expect(page.locator("[data-remote-section]")).toBeVisible();
}

async function renameRow(page: Page, row: string, name: string): Promise<void> {
	await page.locator(row).hover();
	await page.locator(`${row} [data-device-rename-button]`).click();
	const field = page.locator(`${row} [data-device-rename]`);
	await field.fill(name);
	await field.press("Enter");
}

async function shoot(instance: RemoteInstance, name: string): Promise<void> {
	if (!SHOTS) return;
	await fs.mkdir(SHOTS, { recursive: true });
	await instance.page.screenshot({ path: path.join(SHOTS, `${name}-${THEME}-desktop.png`) });
	await instance.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(390, 844));
	await instance.page.waitForTimeout(300); // a resize settles over a few frames; nothing to await
	await instance.page.screenshot({ path: path.join(SHOTS, `${name}-${THEME}-390.png`) });
	await instance.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
}

test("renames the host from the device, the host itself and the device from the host", async () => {
	test.setTimeout(240_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-device-rename-")));
	const base = 44_000 + Math.floor(Math.random() * 1000) * 2;
	let host: RemoteInstance | undefined;
	let client: RemoteInstance | undefined;
	try {
		const hostProfile = await makeRemoteProfile(parent, "host", {
			language: LANGUAGE,
			theme: THEME,
			discoveryPort: base,
		});
		const clientProfile = await makeRemoteProfile(parent, "client", {
			language: LANGUAGE,
			theme: THEME,
			discoveryPort: base + 1,
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const b = host.page;
		await client.page.evaluate(() => window.omp.remote.setDeviceName("PC-A"));
		const hostId = await pair(b, client.page, "DESKTOP-91ID999");
		const hostRow = `[data-remote-host="${hostId}"]`;
		const online = async (page: Page) =>
			expect
				.poll(async () => (await page.evaluate(() => window.omp.remote.getState())).hosts[0]?.state, {
					timeout: 30_000,
				})
				.toBe("online");
		await online(client.page);

		await test.step("A renames the host: B's own name changes, A's Settings and sidebar show it", async () => {
			const a = client?.page as Page;
			await openDevices(a);
			await renameRow(a, hostRow, "Office desk");
			await expect(a.locator(hostRow)).toContainText("Office desk");
			await expect
				.poll(async () => (await b.evaluate(() => window.omp.remote.getState())).host.name)
				.toBe("Office desk");
			await expect(a.locator(`[data-sidebar-device="${hostId}"]`)).toContainText("Office desk");
			await shoot(client as RemoteInstance, "host-renamed");
		});

		await test.step("the name survives A's relaunch and reconnect", async () => {
			await exitApp((client as RemoteInstance).app);
			client = await launchRemote(clientProfile);
			await online(client.page);
			expect((await client.page.evaluate(() => window.omp.remote.getState())).hosts[0]?.name).toBe("Office desk");
		});

		await test.step("B renames itself: A sees it live", async () => {
			await b.evaluate(() => window.omp.remote.setDeviceName("Studio B"));
			await expect
				.poll(async () => (await client?.page.evaluate(() => window.omp.remote.getState()))?.hosts[0]?.name)
				.toBe("Studio B");
		});

		await test.step("B renames A through its paired list: A's own name changes", async () => {
			await openDevices(b);
			const peerId = (await b.evaluate(() => window.omp.remote.getState())).host.peers[0]?.deviceId ?? "";
			await renameRow(b, `[data-remote-peer="${peerId}"]`, "Kitchen laptop");
			await expect
				.poll(async () => (await client?.page.evaluate(() => window.omp.remote.getState()))?.host.name)
				.toBe("Kitchen laptop");
			await expect(b.locator(`[data-remote-peer="${peerId}"]`)).toContainText("Kitchen laptop");
			await shoot(host as RemoteInstance, "peer-renamed");
		});
	} finally {
		for (const instance of [client, host]) if (instance) await exitApp(instance.app);
		for (const instance of [client, host]) expect(instance?.errors ?? []).toEqual([]);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
