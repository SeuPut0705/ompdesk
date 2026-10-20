/**
 * One lane everywhere for a host's no-project sessions (two apps on the fake omp, remote-harness.ts). A session in a
 * computer's own `~/.omp/work` (where `ompdesk_session_open {device}` without a folder starts one) sits in that
 * computer's Chat lane; a paired device's section for it puts the row in the same lane, by the host's workspace it
 * asks over the link. Before, the device listed it under Code while the host showed it only under Chat, so each
 * side "lost" the other's session. The rule is unit-tested in Sidebar.test.tsx ("Sidebar device sections").
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { controlToolCaller, cssString, exitApp, openedSessions } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, openHostFolder, type RemoteInstance } from "./remote-harness";

test("a host's work-folder sessions sit in the Chat lane on the host and on the device", async () => {
	test.setTimeout(240_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-host-lanes-")));
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
		const b = host.page;
		const a = client.page;
		await a.evaluate(() => window.omp.remote.setDeviceName("PC-A"));
		const deviceId = await connectHost(b, a, "PC-B");
		await expect
			.poll(async () => (await a.evaluate(() => window.omp.remote.getState())).hosts[0]?.state, { timeout: 30_000 })
			.toBe("online");

		const hostWork = await b.evaluate(() => window.omp.sidecar.defaultWorkspace());
		expect(await a.evaluate(id => window.omp.sidecar.defaultWorkspace(id), deviceId)).toBe(hostWork);

		// The user's flow: the device's agent opens a session on the host with no folder.
		const call = await controlToolCaller(a, clientProfile.record);
		const open = await call("ompdesk_session_open", {
			device: "PC-B",
			message: "Title: Lanes\nHello",
			show: "background",
		});
		expect(open.isError, open.text).toBe(false);
		const [child] = openedSessions(open.text);
		await call("ompdesk_session_result", { session: child, wait: true, timeout_seconds: 60 });
		await expect
			.poll(async () => (await b.evaluate(() => window.omp.sessions.hosted())).length, { timeout: 30_000 })
			.toBe(1);
		const [hosted] = await b.evaluate(() => window.omp.sessions.hosted());
		expect(hosted?.cwd).toBe(hostWork);
		const hostRow = b.locator(`.omp-sidebar-session-row[data-session-path=${cssString(hosted?.sessionPath ?? "")}]`);
		await b.locator('[role="tablist"] [data-tab-id="chat"]').click();
		await expect(b.locator("[data-chat-lane]").locator(hostRow)).toHaveCount(1, { timeout: 30_000 });
		await b.locator('[role="tablist"] [data-tab-id="code"]').click();
		await expect(hostRow).toHaveCount(0);

		// The device opens its own tab in the host's work folder: its section follows the host's lanes.
		await a.locator('[role="tablist"] [data-tab-id="code"]').click();
		const tabId = await openHostFolder(a, deviceId, hostWork);
		const section = a.locator(`[data-sidebar-device="${deviceId}"]`);
		const tab = (await a.evaluate(() => window.omp.tabs.list())).find(entry => entry.tabId === tabId);
		const deviceRow = section.locator(`[data-device-session=${cssString(tab?.sessionPath ?? `tab:${tabId}`)}]`);
		await a.locator('[role="tablist"] [data-tab-id="chat"]').click();
		await expect(deviceRow).toHaveCount(1, { timeout: 30_000 });
		await a.locator('[role="tablist"] [data-tab-id="code"]').click();
		await expect(section.locator(`[data-device-group=${cssString(hostWork)}]`)).toHaveCount(0);
		await expect(deviceRow).toHaveCount(0);
	} finally {
		for (const instance of [client, host]) if (instance) await exitApp(instance.app);
		for (const instance of [client, host]) expect(instance?.errors ?? []).toEqual([]);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
