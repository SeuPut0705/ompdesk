/**
 * A session one paired device's tab runs on a host is open to every other device too (three apps on the fake omp,
 * remote-harness.ts; the second device dials from 127.0.0.2 so the host tells the two apart). Device A opens a session
 * on host B and works in it; device C clicks that session's row in B's section, three times quickly: C gets one tab
 * that views A's tab (no second omp, no toast), a prompt from C runs in that one omp and shows on A, and A's close
 * ends C's view quietly. The rules are unit-tested in src/main/remote/host-services.test.ts.
 * `OMP_GUI_DEVICE_VIEW_SHOTS=<dir>` saves C's window at each step.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { captureTo, cssString, exitApp, readRecords } from "./harness";
import {
	availableHost,
	connectHost,
	launchRemote,
	makeRemoteProfile,
	openHostFolder,
	type RemoteInstance,
} from "./remote-harness";

const SHOTS = process.env.OMP_GUI_DEVICE_VIEW_SHOTS;
const SECOND_DEVICE = "127.0.0.2";

test("a device opens a session another device's tab runs on the host, and both work in one omp", async () => {
	test.setTimeout(300_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-device-view-")));
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
		const b = host.page;
		const a = deviceA.page;
		const c = deviceC.page;
		await a.evaluate(() => window.omp.remote.setDeviceName("PC-A"));
		await c.evaluate(() => window.omp.remote.setDeviceName("PC-C"));
		const hostId = await connectHost(b, a, "PC-B");
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

		const row = c.locator(`[data-device-session=${cssString(sessionPath)}]`);
		const cTabs = async () =>
			(await c.evaluate(() => window.omp.tabs.list())).filter(tab => tab.sessionPath === sessionPath);
		let cTab = "";
		await test.step("C clicks the row three times quickly: one tab views A's, no second omp, no toast", async () => {
			await expect(row).toHaveCount(1, { timeout: 30_000 });
			const launchedBefore = await launches();
			const open = row.locator("button").first();
			for (let click = 0; click < 3; click++) await open.click();
			const refusal = c.getByText(/no longer available|already open on/);
			// Settled: C's tab is up, or the host refused it (an older build) and C says so.
			await expect
				.poll(async () => (await cTabs()).some(tab => tab.status === "ready") || (await refusal.count()) > 0, {
					timeout: 30_000,
				})
				.toBe(true);
			await captureTo(SHOTS, c, "c-after-three-clicks");
			await expect(refusal).toHaveCount(0);
			const tabs = await cTabs();
			expect(tabs.map(tab => ({ shared: tab.shared, status: tab.status }))).toEqual([
				{ shared: true, status: "ready" },
			]);
			cTab = tabs[0]?.tabId ?? "";
			await expect(c.getByText("Work from PC-A").first()).toBeVisible({ timeout: 30_000 });
			expect(await launches()).toBe(launchedBefore);
			await captureTo(SHOTS, c, "c-views-a-session");
		});

		await test.step("a prompt from C runs in A's omp and shows on A; A's reply shows on C", async () => {
			await send(c, "Hello from PC-C");
			await expect.poll(() => promptBy("Hello from PC-C"), { timeout: 30_000 }).toBe(aOmp);
			await expect(a.getByText("Hello from PC-C").first()).toBeVisible({ timeout: 30_000 });
			await send(a, "PC-A answers back");
			await expect.poll(() => promptBy("PC-A answers back"), { timeout: 30_000 }).toBe(aOmp);
			await expect(c.getByText("PC-A answers back").first()).toBeVisible({ timeout: 30_000 });
			await captureTo(SHOTS, c, "c-and-a-share-one-omp");
			await captureTo(SHOTS, a, "a-sees-c-prompt");
		});

		await test.step("C closes its tab: A's tab and omp run on", async () => {
			// The person on C closes it, its tab in front.
			await expect
				.poll(async () => (await c.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId)
				.toBe(cTab);
			await c.keyboard.press("ControlOrMeta+w");
			await expect.poll(async () => (await cTabs()).length).toBe(0);
			const launchedBefore = await launches();
			await send(a, "PC-A goes on alone");
			await expect.poll(() => promptBy("PC-A goes on alone"), { timeout: 30_000 }).toBe(aOmp);
			expect(await launches()).toBe(launchedBefore);
		});

		await test.step("A closes its tab while C views it: C's view ends with no error tab", async () => {
			await row.locator("button").first().click();
			await expect
				.poll(async () => (await cTabs()).map(tab => ({ shared: tab.shared, status: tab.status })), {
					timeout: 30_000,
				})
				.toEqual([{ shared: true, status: "ready" }]);
			expect(await a.evaluate(id => window.omp.tabs.close(id), aTab)).toBe(true);
			await expect.poll(async () => (await cTabs()).length, { timeout: 30_000 }).toBe(0);
			const tabs = await c.evaluate(() => window.omp.tabs.list());
			expect(tabs.filter(tab => tab.status === "error" || tab.status === "exited")).toEqual([]);
			await captureTo(SHOTS, c, "c-view-ended");
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
