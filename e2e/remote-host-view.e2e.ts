/**
 * A session a paired device opened on this computer is this computer's too (two apps on the fake omp,
 * remote-harness.ts). The device's agent opens it with `ompdesk_session_open {device}`; the host's own window
 * lists it once, in its project group, with the device tab's live state; opening it there views the device's
 * tab (one omp: the host starts no second one), so a prompt from either side reaches the same omp and shows on
 * both; when the device closes its tab, the host's view ends quietly, with no error tab. The rules are
 * unit-tested in src/main/remote/host-services.test.ts, src/main/sidecar-pool.test.ts and Sidebar.test.tsx.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { capture, controlToolCaller, cssString, exitApp, openedSessions, readRecords } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, type RemoteInstance } from "./remote-harness";

test("the host's own window lists, views and works in a session its paired device opened there", async () => {
	test.setTimeout(240_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-host-view-")));
	let host: RemoteInstance | undefined;
	let client: RemoteInstance | undefined;
	try {
		const hostProfile = await makeRemoteProfile(parent, "host", {
			language: "en",
			theme: "light",
		});
		const clientProfile = await makeRemoteProfile(parent, "client", {
			language: "en",
			theme: "light",
			port: hostProfile.port,
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const b = host.page;
		const a = client.page;
		// The host names the device's sessions after it.
		await a.evaluate(() => window.omp.remote.setDeviceName("PC-A"));
		await connectHost(b, a, "PC-B");
		await expect
			.poll(async () => (await a.evaluate(() => window.omp.remote.getState())).hosts[0]?.state, { timeout: 30_000 })
			.toBe("online");
		const prompts = async () =>
			(await readRecords(hostProfile.record))
				.filter(frame => frame.type === "prompt")
				.map(frame => ({ by: frame.recordedBy, message: String(frame.message) }));
		const launches = async () =>
			(await readRecords(hostProfile.record)).filter(frame => frame.type === "launch").length;

		// The device's agent opens a session on the host, in the host's project, and waits for its first answer.
		const call = await controlToolCaller(a, clientProfile.record);
		const open = await call("ompdesk_session_open", {
			device: "PC-B",
			folder: hostProfile.project,
			message: "Title: Fix login\nRun this on the other computer",
			show: "background",
		});
		expect(open.isError, open.text).toBe(false);
		const [child] = openedSessions(open.text);
		const done = await call("ompdesk_session_result", { session: child, wait: true, timeout_seconds: 60 });
		expect(done.text).toContain("Local fixture reply");
		const deviceOmp = (await prompts()).find(prompt => prompt.message.includes("Run this on the other computer"))?.by;
		expect(deviceOmp).toBeTruthy();

		await test.step("the host lists it once, in its project group, with the device tab's state", async () => {
			await expect
				.poll(async () => (await b.evaluate(() => window.omp.sessions.hosted())).length, { timeout: 30_000 })
				.toBe(1);
			const [hosted] = await b.evaluate(() => window.omp.sessions.hosted());
			expect(hosted).toMatchObject({ cwd: hostProfile.project, kind: "agent", status: "ready", device: "PC-A" });
		});
		const sessionPath = (await b.evaluate(() => window.omp.sessions.hosted()))[0]?.sessionPath ?? "";
		expect(sessionPath).not.toBe("");
		const hostRow = b.locator(`.omp-sidebar-session-row[data-session-path=${cssString(sessionPath)}]`);
		await expect(b.locator(`[data-session-group=${cssString(hostProfile.project)}]`).locator(hostRow)).toHaveCount(
			1,
			{
				timeout: 30_000,
			},
		);
		await expect(hostRow).toHaveCount(1);
		await capture(b, "host-lists-device-session");

		let viewTab = "";
		await test.step("opening it on the host views the device's tab: no second omp", async () => {
			const launchedBefore = await launches();
			await hostRow.locator("button").first().click();
			await expect
				.poll(
					async () => {
						const tab = (await b.evaluate(() => window.omp.tabs.list())).find(
							entry => entry.sessionPath === sessionPath,
						);
						viewTab = tab?.tabId ?? "";
						return tab && { shared: tab.shared, status: tab.status, active: tab.active };
					},
					{ timeout: 30_000 },
				)
				.toEqual({ shared: true, status: "ready", active: true });
			await expect(b.getByText("Local fixture reply").first()).toBeVisible({ timeout: 30_000 });
			expect(await launches()).toBe(launchedBefore);
			await capture(b, "host-views-device-session");
		});

		await test.step("a prompt from the host reaches the device's omp and shows on the device", async () => {
			const input = b.locator("textarea").first();
			await input.fill("Hello from the host");
			await input.press("Enter");
			await expect
				.poll(async () => (await prompts()).find(prompt => prompt.message.includes("Hello from the host"))?.by, {
					timeout: 30_000,
				})
				.toBe(deviceOmp);
			// The device's agent opened it, so it is a child of the opener there (not a row of PC-B's list): the
			// agent shows it.
			await expect(a.locator(`[data-device-session=${cssString(sessionPath)}]`)).toHaveCount(0);
			expect((await call("ompdesk_tab_focus", { session: child })).isError).toBe(false);
			await expect(a.getByText("Hello from the host").first()).toBeVisible({ timeout: 30_000 });
		});

		await test.step("a prompt from the device shows in the host's view", async () => {
			const input = a.locator("textarea").first();
			await input.fill("Hello from the device");
			await input.press("Enter");
			await expect
				.poll(async () => (await prompts()).find(prompt => prompt.message.includes("Hello from the device"))?.by, {
					timeout: 30_000,
				})
				.toBe(deviceOmp);
			await expect(b.getByText("Hello from the device").first()).toBeVisible({ timeout: 30_000 });
			await capture(b, "host-sees-device-prompt");
		});

		await test.step("the device closes its tab: the host's view ends with no error tab", async () => {
			const launchedBefore = await launches();
			// The person on the device closes it (its agent may not: the person typed into it), its tab in front.
			await expect
				.poll(async () => (await a.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId)
				.toBe(child);
			await a.keyboard.press("ControlOrMeta+w");
			await expect
				.poll(async () =>
					(await a.evaluate(() => window.omp.tabs.list())).some(tab => tab.sessionPath === sessionPath),
				)
				.toBe(false);
			await expect
				.poll(async () => (await b.evaluate(() => window.omp.tabs.list())).some(tab => tab.tabId === viewTab), {
					timeout: 30_000,
				})
				.toBe(false);
			const tabs = await b.evaluate(() => window.omp.tabs.list());
			expect(tabs.length).toBeGreaterThan(0);
			expect(tabs.filter(tab => tab.status === "error" || tab.status === "exited")).toEqual([]);
			expect(tabs.some(tab => tab.sessionPath === sessionPath)).toBe(false);
			expect(await b.evaluate(() => window.omp.sessions.hosted())).toEqual([]);
			expect(await launches()).toBe(launchedBefore);
			await capture(b, "host-view-ended");
		});

		// The other direction: the host's own window has a session open and the device opens the same file.
		let hostTab = "";
		let hostSession = "";
		await test.step("the host works in a session of its own", async () => {
			const input = b.locator("textarea").first();
			await input.fill("The host's own work");
			await input.press("Enter");
			await expect
				.poll(
					async () => {
						const tab = (await b.evaluate(() => window.omp.tabs.list())).find(entry => entry.active);
						hostTab = tab?.tabId ?? "";
						hostSession = tab?.sessionPath ?? "";
						return hostSession;
					},
					{ timeout: 30_000 },
				)
				.not.toBe("");
		});
		const hostOmp = async () => (await prompts()).find(prompt => prompt.message.includes("The host's own work"))?.by;
		await expect.poll(hostOmp, { timeout: 30_000 }).toBeTruthy();

		let deviceTab = "";
		await test.step("the device opens it: it views the host window's omp, no second omp", async () => {
			const launchedBefore = await launches();
			const deviceRow = a.locator(`[data-device-session=${cssString(hostSession)}]`);
			await expect(deviceRow).toHaveCount(1, { timeout: 30_000 });
			await deviceRow.locator("button").first().click();
			await expect
				.poll(
					async () => {
						const tab = (await a.evaluate(() => window.omp.tabs.list())).find(
							entry => entry.sessionPath === hostSession,
						);
						deviceTab = tab?.tabId ?? "";
						return tab && { shared: tab.shared, status: tab.status };
					},
					{ timeout: 30_000 },
				)
				.toEqual({ shared: true, status: "ready" });
			expect(await launches()).toBe(launchedBefore);
			await expect(a.getByText("The host's own work").first()).toBeVisible({ timeout: 30_000 });
		});

		await test.step("a prompt from either side reaches the host window's omp and shows on both", async () => {
			const deviceInput = a.locator("textarea").first();
			await deviceInput.fill("The device joins in");
			await deviceInput.press("Enter");
			const by = async (text: string) => (await prompts()).find(prompt => prompt.message.includes(text))?.by;
			await expect.poll(() => by("The device joins in"), { timeout: 30_000 }).toBe(await hostOmp());
			await expect(b.getByText("The device joins in").first()).toBeVisible({ timeout: 30_000 });
			const hostInput = b.locator("textarea").first();
			await hostInput.fill("The host answers back");
			await hostInput.press("Enter");
			await expect.poll(() => by("The host answers back"), { timeout: 30_000 }).toBe(await hostOmp());
			await expect(a.getByText("The host answers back").first()).toBeVisible({ timeout: 30_000 });
			await capture(a, "device-views-host-session");
		});

		await test.step("the host closes its tab: the device's view ends with no error tab", async () => {
			expect(await b.evaluate(id => window.omp.tabs.close(id), hostTab)).toBe(true);
			await expect
				.poll(async () => (await a.evaluate(() => window.omp.tabs.list())).some(tab => tab.tabId === deviceTab), {
					timeout: 30_000,
				})
				.toBe(false);
			const tabs = await a.evaluate(() => window.omp.tabs.list());
			expect(tabs.filter(tab => tab.status === "error" || tab.status === "exited")).toEqual([]);
			await capture(a, "device-view-ended");
		});
	} finally {
		for (const instance of [client, host]) if (instance) await exitApp(instance.app);
		for (const instance of [client, host]) expect(instance?.errors ?? []).toEqual([]);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
