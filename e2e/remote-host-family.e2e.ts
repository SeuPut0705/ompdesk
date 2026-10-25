/**
 * A paired computer's section for a host nests the sessions the host's own agent opened under their opener, as the
 * host's sidebar does (the user's report, 25 Oct 2026: viewed from a paired computer, the children of a host session
 * were loose rows of its project beside the opener). The children are tabs of the host's window, not the device's, so
 * the device knows who opened them only from the host's session list (`SessionInfo.openedBySession`). Two apps on the
 * fake omp (remote-harness.ts); the rules are unit-tested in Sidebar.test.tsx ("the sessions a host's own agents
 * opened").
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { controlToolCaller, cssString, exitApp, openedSessions } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, type RemoteInstance } from "./remote-harness";

test("a device nests the sessions a host's own agent opened under their opener, folded, like the host", async () => {
	test.setTimeout(240_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-host-family-")));
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

		// On the host, its own window's session opens a session that keeps working.
		const hostTabs = () => b.evaluate(() => window.omp.tabs.list());
		const opener = (await hostTabs()).find(tab => tab.active)?.tabId ?? "";
		expect(opener).not.toBe("");
		await expect
			.poll(async () => (await hostTabs()).find(tab => tab.tabId === opener)?.status, { timeout: 60_000 })
			.toBe("ready");
		await b.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "hello" }), opener);
		await expect
			.poll(async () => (await hostTabs()).find(tab => tab.tabId === opener)?.lastRun?.reply, { timeout: 30_000 })
			.toBe("Local fixture reply");
		const call = await controlToolCaller(b, hostProfile.record, opener);
		const open = await call("ompdesk_session_open", { message: "Title: Redesign the header\nDetails follow." });
		expect(open.isError, open.text).toBe(false);
		const [child] = openedSessions(open.text);
		if (!child) throw new Error(open.text);
		// The brief comes wrapped as an agent message, which the fake answers at once; then a turn that keeps working.
		await expect
			.poll(async () => (await hostTabs()).find(tab => tab.tabId === child)?.lastRun !== undefined, {
				timeout: 30_000,
			})
			.toBe(true);
		await b.evaluate(
			id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture steer work" }),
			child,
		);
		await expect
			.poll(async () => (await hostTabs()).find(tab => tab.tabId === child)?.status, { timeout: 30_000 })
			.toBe("running");
		const tabs = await hostTabs();
		const openerSession = tabs.find(tab => tab.tabId === opener)?.sessionPath ?? "";
		const childSession = tabs.find(tab => tab.tabId === child)?.sessionPath ?? "";
		expect(openerSession).not.toBe("");
		expect(childSession).not.toBe("");

		// The device holds no tab of either: its section nests the child under the opener, folded, by the host's word.
		expect((await a.evaluate(() => window.omp.tabs.list())).filter(tab => tab.device === deviceId)).toEqual([]);
		const section = a.locator(`[data-sidebar-device="${deviceId}"]`);
		const openerRow = section.locator(`[data-device-session=${cssString(openerSession)}]`);
		await expect(openerRow).toHaveCount(1, { timeout: 30_000 });
		await expect(openerRow.locator("[data-family-running]")).toHaveText("1", { timeout: 30_000 });
		await expect(section.locator(`[data-device-session=${cssString(childSession)}]`)).toHaveCount(0);
		const family = section.locator(`[data-sidebar-family=${cssString(`device:${deviceId}:${openerSession}`)}]`);
		const childRow = family.locator(`[data-sidebar-opened-session][data-session-path=${cssString(childSession)}]`);
		await expect(childRow).toHaveCount(0);

		// The person unfolds it: the child is one running row of the opener's family, named by the host.
		await openerRow.locator("[data-sidebar-subagents-toggle]").click();
		await expect(childRow).toHaveAttribute("data-child-status", "running");
		await expect(childRow).toContainText("Redesign the header");
	} finally {
		for (const instance of [client, host]) if (instance) await exitApp(instance.app);
		for (const instance of [client, host]) expect(instance?.errors ?? []).toEqual([]);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
