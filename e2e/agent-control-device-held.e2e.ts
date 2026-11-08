/**
 * An agent reaches a session another device's tab holds on a paired host (three apps on the fake omp,
 * remote-harness.ts; the second device dials from 127.0.0.2 so the host tells the two apart). Device A opens a
 * session on host B and works in it; an agent on device C lists it as open there, sends it a message that runs in
 * A's omp, and reopens it as a view of A's tab: no second omp on the host, and never nested under C's agent. The
 * rules are unit-tested in src/main/agent-control/host.test.ts ("a saved session a tab elsewhere holds").
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { controlToolCaller, exitApp, readRecords } from "./harness";
import {
	availableHost,
	connectHost,
	launchRemote,
	makeRemoteProfile,
	openHostFolder,
	type RemoteInstance,
} from "./remote-harness";

const SECOND_DEVICE = "127.0.0.2";

test("an agent on one device messages and reopens a session another device's tab holds on the host", async () => {
	test.setTimeout(300_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-device-held-")));
	const apps: RemoteInstance[] = [];
	try {
		const hostProfile = await makeRemoteProfile(parent, "host", {
			language: "en",
			theme: "light",
			devices: [SECOND_DEVICE],
		});
		const aProfile = await makeRemoteProfile(parent, "a", { language: "en", theme: "light", port: hostProfile.port });
		const cProfile = await makeRemoteProfile(parent, "c", {
			language: "en",
			theme: "light",
			port: hostProfile.port,
			source: SECOND_DEVICE,
		});
		const host = await launchRemote(hostProfile);
		apps.push(host);
		const deviceA = await launchRemote(aProfile);
		apps.push(deviceA);
		const deviceC = await launchRemote(cProfile);
		apps.push(deviceC);
		const a = deviceA.page;
		const c = deviceC.page;
		await a.evaluate(() => window.omp.remote.setDeviceName("PC-A"));
		await c.evaluate(() => window.omp.remote.setDeviceName("PC-C"));
		const hostId = await connectHost(host.page, a, "PC-B");
		await c.evaluate(id => window.omp.remote.connect(id), await availableHost(c));
		for (const page of [a, c])
			await expect
				.poll(async () => (await page.evaluate(() => window.omp.remote.getState())).hosts[0]?.state, {
					timeout: 30_000,
				})
				.toBe("online");
		const records = () => readRecords(hostProfile.record);
		const promptBy = async (text: string) =>
			(await records()).find(frame => frame.type === "prompt" && String(frame.message).includes(text))?.recordedBy;
		const launches = async () => (await records()).filter(frame => frame.type === "launch").length;

		// A opens a session on B and works in it: A's own tab on the host holds it.
		const aTab = await openHostFolder(a, hostId, hostProfile.project);
		await send(a, "Work from PC-A");
		await expect.poll(() => promptBy("Work from PC-A"), { timeout: 30_000 }).toBeTruthy();
		const aOmp = await promptBy("Work from PC-A");
		let sessionPath = "";
		await expect
			.poll(
				async () => {
					sessionPath =
						(await a.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === aTab)?.sessionPath ?? "";
					return sessionPath;
				},
				{ timeout: 30_000 },
			)
			.not.toBe("");

		// C's agent works in a session of C's own.
		const agentTab = (await c.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId ?? "";
		expect(agentTab).not.toBe("");
		const call = await controlToolCaller(c, cProfile.record, agentTab);
		const cTabs = async () =>
			(await c.evaluate(() => window.omp.tabs.list())).filter(tab => tab.sessionPath === sessionPath);

		let savedId = "";
		await test.step("C's agent lists the session as open on the host, in PC-A's tab", async () => {
			await expect
				.poll(
					async () => {
						const listed = await call("ompdesk_sessions", { scope: "app" });
						savedId = /\(saved id ([^)]+)\) \[open in a tab [^\]]+ runs for PC-A\]/.exec(listed.text)?.[1] ?? "";
						return savedId;
					},
					{ timeout: 30_000 },
				)
				.not.toBe("");
		});

		await test.step("its message runs in A's omp: no second omp on the host, and the session is not its child", async () => {
			const launchedBefore = await launches();
			const sent = await call("ompdesk_session_send", { session: savedId, message: "Clean up from PC-C's agent" });
			expect(sent.isError, sent.text).toBe(false);
			await expect.poll(() => promptBy("Clean up from PC-C's agent"), { timeout: 30_000 }).toBe(aOmp);
			await expect(a.getByText("Clean up from PC-C's agent").first()).toBeVisible({ timeout: 30_000 });
			expect(await launches()).toBe(launchedBefore);
			expect((await cTabs()).map(tab => tab.shared)).toEqual([true]);
			expect((await call("ompdesk_sessions", { scope: "app", mine: true })).text).toMatch(/^0 sessions/);
		});

		await test.step("closed on C and reopened by C's agent: a view of A's tab again, not its child", async () => {
			const view = (await cTabs())[0]?.tabId ?? "";
			expect(await c.evaluate(id => window.omp.tabs.close(id), view)).toBe(true);
			await expect.poll(async () => (await cTabs()).length, { timeout: 30_000 }).toBe(0);
			const launchedBefore = await launches();
			const reopened = await call("ompdesk_session_open", { reopen: savedId });
			expect(reopened.isError, reopened.text).toBe(false);
			await expect
				.poll(async () => (await cTabs()).map(tab => ({ shared: tab.shared, status: tab.status })), {
					timeout: 30_000,
				})
				.toEqual([{ shared: true, status: "ready" }]);
			expect(await launches()).toBe(launchedBefore);
			expect((await call("ompdesk_sessions", { scope: "app", mine: true })).text).toMatch(/^0 sessions/);
			// A's tab still holds the session and runs on.
			await send(a, "PC-A goes on");
			await expect.poll(() => promptBy("PC-A goes on"), { timeout: 30_000 }).toBe(aOmp);
		});
	} finally {
		for (const instance of apps.toReversed()) await exitApp(instance.app);
		for (const instance of apps) expect(instance.errors).toEqual([]);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

/** Type `text` into the focused tab's composer and send it. */
async function send(page: Page, text: string): Promise<void> {
	const input = page.locator("textarea").first();
	await input.fill(text);
	await input.press("Enter");
}
