/**
 * A session's name follows a rename everywhere it shows, live (the user's report, 1 Nov 2026: the title above the
 * chat kept the old name of a session renamed in the sidebar, a paired computer's session among them). Stock's RPC
 * `set_session_name` sends no `session_info_update`, and the fake omp (e2e/fixture/rpc-ui.ts) answers it the same
 * way, so nothing but main's own word tells a window, a tab or a paired computer the new name. The rename here comes
 * through `window.omp.sessions.rename`, the path of the sidebar, another window and an agent's app action, which no
 * window's own store copies the name from.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { exitApp } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, openHostFolder, type RemoteInstance } from "./remote-harness";

const titleBar = (page: Page) => page.locator("[data-titlebar-session-name]");

async function send(page: Page, message: string, replies: number): Promise<void> {
	const input = page.locator(".omp-composer-input").first();
	await input.fill(message);
	await input.press("Enter");
	await expect(page.getByText("Local fixture reply")).toHaveCount(replies, { timeout: 30_000 });
}

async function tabOf(page: Page, tabId: string) {
	return (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === tabId);
}

test("a rename of this computer's open session renames its title bar and its tab", async () => {
	test.setTimeout(120_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-rename-title-")));
	let app: RemoteInstance | undefined;
	try {
		app = await launchRemote(await makeRemoteProfile(parent, "local", { language: "en", theme: "light" }));
		const { page } = app;
		await send(page, "hello there", 1);
		const tabId = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId ?? "";
		let sessionPath = "";
		await expect
			.poll(async () => {
				sessionPath = (await tabOf(page, tabId))?.sessionPath ?? "";
				return sessionPath;
			})
			.not.toBe("");

		await page.evaluate(file => window.omp.sessions.rename(file, "Renamed by hand"), sessionPath);
		await expect(titleBar(page)).toHaveText("Renamed by hand");
		await expect.poll(async () => (await tabOf(page, tabId))?.title).toBe("Renamed by hand");
		await expect(page.locator(".omp-session-sidebar")).toContainText("Renamed by hand");
	} finally {
		if (app) await exitApp(app.app);
		expect(app?.errors ?? []).toEqual([]);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("a paired computer's tab follows a rename made on that computer and one made on this one", async () => {
	test.setTimeout(240_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-rename-title-remote-")));
	let host: RemoteInstance | undefined;
	let client: RemoteInstance | undefined;
	try {
		const hostProfile = await makeRemoteProfile(parent, "host", { language: "en", theme: "light" });
		const clientProfile = await makeRemoteProfile(parent, "client", {
			language: "en",
			theme: "light",
			port: hostProfile.port,
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const a = client.page;
		const b = host.page;
		await a.evaluate(() => window.omp.remote.setDeviceName("PC-A"));
		const deviceId = await connectHost(b, a, "PC-B");
		const remoteTab = await openHostFolder(a, deviceId, hostProfile.project);
		await send(a, "hello host", 1);
		let sessionPath = "";
		await expect
			.poll(async () => {
				sessionPath = (await tabOf(a, remoteTab))?.sessionPath ?? "";
				return sessionPath;
			})
			.not.toBe("");

		// Renamed from this computer (the device section's rename): the host's omp holds the session.
		await a.evaluate(({ file, device }) => window.omp.sessions.rename(file, "Named on the device", device), {
			file: sessionPath,
			device: deviceId,
		});
		await expect(titleBar(a)).toHaveText("Named on the device");
		await expect.poll(async () => (await tabOf(a, remoteTab))?.title).toBe("Named on the device");

		// Renamed on the host itself, its own sidebar's path: the device's tab holds the session there.
		await b.evaluate(file => window.omp.sessions.rename(file, "Named on the host"), sessionPath);
		await expect(titleBar(a)).toHaveText("Named on the host");
		await expect.poll(async () => (await tabOf(a, remoteTab))?.title).toBe("Named on the host");
		await expect(a.locator(`[data-sidebar-device="${deviceId}"]`)).toContainText("Named on the host");
		await expect(b.locator(".omp-session-sidebar")).toContainText("Named on the host");
	} finally {
		for (const instance of [client, host]) if (instance) await exitApp(instance.app);
		for (const instance of [client, host]) expect(instance?.errors ?? []).toEqual([]);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("a paired computer's session shows its typed name and its automatic title together, on both computers", async () => {
	test.setTimeout(240_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-rename-title-auto-")));
	let host: RemoteInstance | undefined;
	let client: RemoteInstance | undefined;
	try {
		// The host's omp names sessions by itself ("Auto N: <prompt>", the fake's automatic titles).
		const hostProfile = await makeRemoteProfile(parent, "host", {
			language: "en",
			theme: "light",
			env: { OMP_GUI_TEST_AUTO_TITLE: "{}", PI_NO_TITLE: "" },
		});
		const clientProfile = await makeRemoteProfile(parent, "client", {
			language: "en",
			theme: "light",
			port: hostProfile.port,
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const a = client.page;
		const b = host.page;
		const deviceId = await connectHost(b, a, "PC-B");
		const remoteTab = await openHostFolder(a, deviceId, hostProfile.project);
		await send(a, "hello host", 1);
		await expect(titleBar(a)).toHaveText("Auto 1: hello host");
		let sessionPath = "";
		await expect
			.poll(async () => {
				sessionPath = (await tabOf(a, remoteTab))?.sessionPath ?? "";
				return sessionPath;
			})
			.not.toBe("");

		await a.evaluate(({ file, device }) => window.omp.sessions.rename(file, "My name", device), {
			file: sessionPath,
			device: deviceId,
		});
		// This computer: the title bar and the host's section of the sidebar.
		await expect(titleBar(a).locator("[data-title-name]")).toHaveText("My name");
		await expect(titleBar(a).locator("[data-title-auto]")).toHaveText("Auto 1: hello host");
		const deviceRow = a.locator(`[data-sidebar-device="${deviceId}"] [data-title-name]`, { hasText: "My name" });
		await expect(deviceRow.locator("xpath=..").locator("[data-title-auto]")).toHaveText("Auto 1: hello host");
		// The host's own sidebar lists the session the device runs there the same way.
		const hostRow = b.locator(".omp-session-sidebar [data-title-name]", { hasText: "My name" });
		await expect(hostRow.locator("xpath=..").locator("[data-title-auto]")).toHaveText("Auto 1: hello host");
		// The work goes on: the automatic title follows it beside the name, live.
		await send(a, "second", 2);
		await send(a, "third", 3);
		await expect(titleBar(a).locator("[data-title-auto]")).toHaveText(/^Auto [2-9]: /);
		await expect(titleBar(a).locator("[data-title-name]")).toHaveText("My name");

		// While it works, the row's name still draws (v0.94.0 drew a working row's name 0 px wide: a running session
		// showed only its spinner), on the host's section here and in the host's own sidebar.
		await a.evaluate(
			tabId => window.omp.rpc.commandForTab(tabId, { type: "prompt", message: "fixture running" }),
			remoteTab,
		);
		for (const name of [
			a.locator(`[data-sidebar-device="${deviceId}"] [data-title-name]`, { hasText: "My name" }),
			b.locator(".omp-session-sidebar [data-title-name]", { hasText: "My name" }),
		]) {
			await expect(name.locator('.omp-live-text[data-working="turn"]')).toHaveCount(1);
			await expect.poll(() => name.evaluate(box => box.getBoundingClientRect().width)).toBeGreaterThan(20);
		}
	} finally {
		for (const instance of [client, host]) if (instance) await exitApp(instance.app);
		for (const instance of [client, host]) expect(instance?.errors ?? []).toEqual([]);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
