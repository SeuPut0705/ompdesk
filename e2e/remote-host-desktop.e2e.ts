/**
 * The host computer's OMPdesk from a paired device (B26) and its appearance
 * (B16), on two instances with the fake omp (the remote-devices.e2e.ts setup):
 * A (English, light) pairs with B (Korean, dark) through the remote API, opens
 * a tab on B, and
 * - Settings › Updates on that tab shows "OMPdesk on the host computer" with
 *   B's version;
 * - with "Use the host computer's theme and language" on, A shows B's theme
 *   and language while B's tab is focused and its own again on a local tab,
 *   saving neither.
 * Captures in the test output directory.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { exitApp, fixtureOmp, walkRemotePicker } from "./harness";

interface Instance {
	app: ElectronApplication;
	page: Page;
	project: string;
	desktop: string;
	errors: string[];
}

async function launch(
	profile: string,
	name: string,
	discoveryPort: number,
	prefs: { language: "en" | "ko"; themeName: string },
): Promise<Instance> {
	const root = path.join(profile, name);
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await fs.mkdir(root);
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ ...prefs, firstRunComplete: true }));
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(root),
		OMP_GUI_REMOTE_PORT: "0",
		OMP_GUI_REMOTE_DISCOVERY_PORT: String(discoveryPort),
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env,
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.remote != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page, project: await fs.realpath(project), desktop, errors };
}

async function capture(page: Page, name: string): Promise<void> {
	await page.screenshot({ path: test.info().outputPath(`${name}.png`), animations: "disabled", scale: "css" });
}

test("a paired device shows the host's OMPdesk under Updates and, when asked, the host's theme and language", async () => {
	test.setTimeout(180_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-remote-desktop-"));
	const discoveryBase = 49_000 + Math.floor(Math.random() * 1_000) * 2;
	let host: Instance | null = null;
	let client: Instance | null = null;
	try {
		host = await launch(profile, "b", discoveryBase, { language: "ko", themeName: "dark" });
		client = await launch(profile, "a", discoveryBase + 1, { language: "en", themeName: "light" });
		const b = host.page;
		const a = client.page;

		// ── Pair A with B through the remote API (the pairing UI is remote-devices.e2e.ts's) ──
		await b.evaluate(() => window.omp.remote.setDeviceName("Host B"));
		const shared = await b.evaluate(() => window.omp.remote.setHostEnabled(true));
		await expect.poll(async () => (await b.evaluate(() => window.omp.remote.getState())).host.code).toBeTruthy();
		const { host: hostState } = await b.evaluate(() => window.omp.remote.getState());
		expect(shared.host.enabled).toBe(true);
		const paired = await a.evaluate(payload => window.omp.remote.pair(payload), {
			address: `127.0.0.1:${hostState.port}`,
			code: hostState.code ?? "",
		});
		const deviceId = paired.deviceId;

		// ── A: open a tab on B from the sidebar's device section ──
		const section = a.locator(`[data-sidebar-device="${deviceId}"]`);
		await expect(section).toHaveAttribute("data-device-state", "online");
		await section.locator(`[data-sidebar-device-add="${deviceId}"]`).click();
		const picker = a.getByRole("dialog", { name: /Choose a folder on/ });
		await walkRemotePicker(picker, host.project);
		await picker.locator("[data-remote-picker-open]").click();
		await expect(picker).toHaveCount(0);
		await expect
			.poll(
				async () => (await a.evaluate(() => window.omp.tabs.list())).find(tab => tab.device === deviceId)?.status,
				{ timeout: 60_000 },
			)
			.toBe("ready");
		const tabs = await a.evaluate(() => window.omp.tabs.list());
		const remoteTab = tabs.find(tab => tab.device === deviceId);
		const localTab = tabs.find(tab => tab.device === undefined);
		if (!remoteTab || !localTab) throw new Error("expected a local and a remote tab");
		expect(remoteTab.active).toBe(true);

		// ── B26: Settings › Updates on B's tab shows B's OMPdesk ──
		const settings = a.locator("[data-settings-page]");
		const openSection = async (id: string) => {
			await a.keyboard.press("ControlOrMeta+Comma");
			await settings.locator(`[data-settings-section="${id}"]`).click();
		};
		// The app's own version (package.json), which the host reports; Electron's would be app.getVersion() here.
		const hostVersion = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8")).version;
		await openSection("updates");
		const hostRow = settings.locator("#setting-updates-host");
		await expect(hostRow).toContainText("OMPdesk on the host computer");
		await expect(hostRow.locator("[data-host-desktop-version]")).toContainText(hostVersion);
		await hostRow.scrollIntoViewIfNeeded();
		await capture(a, "host-desktop-row");

		// ── B16: the switch shows B's theme and language while B's tab is focused ──
		const scheme = () => a.evaluate(() => document.documentElement.getAttribute("data-theme"));
		expect(await scheme()).toBe("light");
		await settings.locator('[data-settings-section="connections"]').click();
		const appearance = settings.locator("#setting-remote-host-appearance");
		await appearance.scrollIntoViewIfNeeded();
		await appearance.getByRole("switch").click();
		await expect.poll(scheme).toBe("dark");
		await expect(settings.locator('[data-settings-section="general"]')).toContainText("일반");
		await capture(a, "host-appearance-on");
		await a.keyboard.press("Escape");
		await expect(settings).toHaveCount(0);

		// A local tab brings A's own back; nothing of B's was saved.
		await a.locator(`[data-session-path="tab:${localTab.tabId}"] button[data-roving-item]`).click();
		await expect
			.poll(async () => (await a.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId)
			.toBe(localTab.tabId);
		await expect.poll(scheme).toBe("light");
		await openSection("general");
		await expect(settings.locator('[data-settings-section="general"]')).toContainText("General");
		await capture(a, "host-appearance-local-tab");
		expect(JSON.parse(await fs.readFile(path.join(client.desktop, "prefs.json"), "utf8"))).toMatchObject({
			language: "en",
			themeName: "light",
			useHostAppearance: true,
		});
		expect(client.errors).toEqual([]);
		expect(host.errors).toEqual([]);
	} finally {
		if (host) await exitApp(host.app);
		if (client) await exitApp(client.app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
