import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

// Two OMPdesk instances on the fake omp: B shares itself, A pairs with it
// through Settings › Remote devices, opens a session on B from its sidebar,
// and the prompt runs on B's omp. Each instance has its own profile and
// discovery port; B's host listens on an ephemeral port (OMP_GUI_REMOTE_PORT=0)
// that A reads from B's settings, so parallel runs never collide.

interface Instance {
	app: ElectronApplication;
	page: Page;
	/** The fixture omp's command log (OMP_GUI_TEST_RECORD). */
	record: string;
	project: string;
	errors: string[];
}

async function launch(profile: string, name: string, discoveryPort: number, customProvider: string): Promise<Instance> {
	const root = path.join(profile, name);
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await fs.mkdir(root);
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	// This machine's own models.yml entry: Settings › Models lists the one of the focused tab's machine.
	await fs.writeFile(
		path.join(agent, "models.yml"),
		`providers:\n  ${customProvider}:\n    baseUrl: http://127.0.0.1:9/v1\n    api: openai-completions\n    models:\n      - id: ${customProvider}-model\n`,
	);
	const record = path.join(root, "record.jsonl");
	const bin = await fixtureOmp(root);
	// The Terminal panel runs stock's PtySession from the installed pi-natives (C114 runs B's for A's tab).
	const natives =
		process.env.OMP_GUI_TEST_NATIVES ||
		path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-natives");
	await fs.symlink(natives, path.join(path.dirname(bin), "node_modules/@oh-my-pi/pi-natives"), "dir");
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: bin,
		OMP_GUI_TEST_RECORD: record,
		OMP_GUI_REMOTE_PORT: "0",
		OMP_GUI_TEST_LOGIN: "1",
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
	await page.waitForFunction(() => window.omp?.remote != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page, record, project: await fs.realpath(project), errors };
}

async function openRemoteSettings(page: Page): Promise<void> {
	await page.keyboard.press("ControlOrMeta+Comma");
	await page.locator('[data-settings-page] [data-settings-section="connections"]').click();
	await expect(page.locator("[data-remote-section]")).toBeVisible();
}

async function recorded(file: string): Promise<Array<Record<string, unknown>>> {
	const text = await fs.readFile(file, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Record<string, unknown>);
}

test("pairs two devices, runs a prompt on the host, and shows the link drop", async () => {
	test.setTimeout(180_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-remote-"));
	const discoveryBase = 48_000 + Math.floor(Math.random() * 1_000) * 2;
	let host: Instance | null = null;
	let client: Instance | null = null;
	try {
		host = await launch(profile, "b", discoveryBase, "host-b-provider");
		client = await launch(profile, "a", discoveryBase + 1, "host-a-provider");
		const b = host.page;
		const a = client.page;

		// ── B: let other devices use this computer, read its port and code ──
		await b.evaluate(() => window.omp.remote.setDeviceName("Host B"));
		await openRemoteSettings(b);
		await b.getByRole("switch", { name: "Let other devices use this computer" }).click();
		const codeRow = b.locator("[data-remote-section] [data-remote-code]");
		await expect(codeRow).toContainText(/[0-9A-Z]{4}-[0-9A-Z]{4}/);
		const addresses = b.locator("[data-remote-addresses]");
		await expect(addresses).toContainText(/:\d+/);
		const port = /:(\d+)/.exec((await addresses.locator("li").first().textContent()) ?? "")?.[1];
		expect(port).toBeTruthy();
		const address = `127.0.0.1:${port}`;
		await b.screenshot({ path: "test-results/remote-host-settings.png", scale: "css", animations: "disabled" });

		// ── A: Settings › Remote devices › Connect to a device ──
		await openRemoteSettings(a);
		await a.locator("[data-remote-connect]").click();
		const dialog = a.getByRole("dialog", { name: "Connect to a device" });
		await dialog.locator("input[data-remote-address]").fill(address);

		// A wrong code is refused with the localized reason, and nothing is paired.
		await dialog.locator("input[data-remote-code]").fill("ZZZZ-ZZZZ");
		await dialog.locator("[data-remote-connect-submit]").click();
		await expect(dialog.locator("[data-remote-connect-error]")).toContainText(
			"That pairing code isn't right. Check the code on the other device.",
		);
		expect((await a.evaluate(() => window.omp.remote.getState())).hosts).toEqual([]);

		const code = /[0-9A-Z]{4}-[0-9A-Z]{4}/.exec((await codeRow.textContent()) ?? "")?.[0];
		expect(code).toBeTruthy();
		await dialog.locator("input[data-remote-code]").fill(code ?? "");
		await dialog.locator("[data-remote-connect-submit]").click();
		await expect(dialog).toHaveCount(0);
		const hostRow = a.locator("[data-remote-hosts] [data-remote-host]");
		await expect(hostRow).toContainText("Online");
		const deviceId = await hostRow.getAttribute("data-remote-host");
		if (!deviceId) throw new Error("expected the paired host's id");
		// B lists A as a paired, connected device.
		await expect(b.locator("[data-remote-peers] [data-remote-peer]")).toContainText("Online");
		await a.keyboard.press("Escape");
		await expect(a.locator("[data-settings-page]")).toHaveCount(0);

		// ── A: open a session on B from the sidebar device section ──
		const section = a.locator(`[data-sidebar-device="${deviceId}"]`);
		await expect(section).toHaveAttribute("data-device-state", "online");
		await section.locator(`[data-sidebar-device-add="${deviceId}"]`).click();
		const picker = a.getByRole("dialog", { name: /Choose a folder on/ });
		const pickerPath = picker.locator("[data-remote-picker-path]");
		await expect(pickerPath).not.toHaveText("");
		// Up to the root, then down B's real path to its project folder.
		while ((await pickerPath.textContent()) !== path.parse(host.project).root) {
			const before = await pickerPath.textContent();
			await picker.locator("[data-remote-picker-up]").click();
			await expect(pickerPath).not.toHaveText(before ?? "");
		}
		let current = path.parse(host.project).root;
		for (const part of path.relative(current, host.project).split(path.sep)) {
			current = path.join(current, part);
			// By name: the host lists a bounded number of folders per level, and a crowded
			// temp folder holds more than that.
			await picker.locator("[data-remote-picker-filter]").fill(part);
			await picker.locator(`[data-remote-dir="${current}"]`).click();
			await expect(pickerPath).toHaveText(current);
		}
		await picker.locator("[data-remote-picker-open]").click();
		await expect(picker).toHaveCount(0);

		await expect
			.poll(
				async () => (await a.evaluate(() => window.omp.tabs.list())).find(tab => tab.device === deviceId)?.status,
				{
					timeout: 60_000,
				},
			)
			.toBe("ready");
		const remoteTab = (await a.evaluate(() => window.omp.tabs.list())).find(tab => tab.device === deviceId);
		expect(remoteTab).toMatchObject({ cwd: host.project, active: true });
		await expect(a.locator(`[data-device-chip="${deviceId}"]`).first()).toBeVisible();

		await a.locator("textarea").first().fill("remote hello");
		await a.getByRole("button", { name: "Send", exact: true }).click();
		await expect(a.locator("[data-transcript-kind]").filter({ hasText: "Local fixture reply" })).toHaveCount(1);
		await a.screenshot({ path: "test-results/remote-client-session.png", scale: "css", animations: "disabled" });

		// The prompt reached B's omp, never A's.
		const isPrompt = (frame: Record<string, unknown>) => frame.type === "prompt" && frame.message === "remote hello";
		await expect.poll(async () => (await recorded(host?.record ?? "")).some(isPrompt)).toBe(true);
		expect((await recorded(client.record)).some(isPrompt)).toBe(false);

		// ── Settings follow the focused tab: B's machine settings, A's app settings ──
		const tabs = await a.evaluate(() => window.omp.tabs.list());
		const localTab = tabs.find(tab => tab.device === undefined);
		if (!localTab || !remoteTab) throw new Error("expected a local and a remote tab");
		// The local tab's sidebar row is under This device; the remote tab's is under B's section.
		const rows = {
			[localTab.tabId]: a.locator(`[data-session-path="tab:${localTab.tabId}"]`),
			[remoteTab.tabId]: section.locator("[data-device-session]").first(),
		};
		const focusTab = async (tabId: string) => {
			await rows[tabId].locator("button[data-roving-item]").click();
			await expect
				.poll(async () => (await a.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId)
				.toBe(tabId);
		};
		const settings = a.locator("[data-settings-page]");
		const openModels = async () => {
			await a.keyboard.press("ControlOrMeta+Comma");
			await settings.locator('[data-settings-section="models"]').click();
		};
		await openModels();
		await expect(a.locator(`[data-settings-device-banner="${deviceId}"]`)).toContainText(
			"These are Host B's settings.",
		);
		await expect(settings.getByText("host-b-provider", { exact: true })).toBeVisible();
		await expect(settings.getByText("host-a-provider", { exact: true })).toHaveCount(0);
		await expect(settings.getByRole("button", { name: "Edit config" })).toHaveCount(0);
		await expect(settings.locator('[data-settings-nav="appearance"] [data-this-device-tag]')).toBeVisible();
		await expect(settings.locator('[data-settings-nav="models"] [data-this-device-tag]')).toHaveCount(0);

		// Signing in from the remote tab runs omp's login on B. The browser link
		// is the provider's own URL (B's localhost/launch is unreachable from A),
		// and the redirect A's browser ends on is pasted back to B's omp.
		await client.app.evaluate(({ shell }) => {
			const opened: string[] = [];
			Object.assign(globalThis, { openedUrls: opened });
			shell.openExternal = async (url: string) => {
				opened.push(url);
			};
		});
		// Providers to connect sit behind "Add a provider" once one (the fixture) is connected.
		await settings.getByRole("button", { name: "Add a provider" }).click();
		const anthropic = settings.locator("li").filter({ has: a.getByText("Anthropic", { exact: true }) });
		await anthropic.getByRole("button", { name: "Connect", exact: true }).click();
		await expect(anthropic.locator("[data-remote-login-hint]")).toContainText("the sign-in finishes on Host B");
		await anthropic.getByRole("button", { name: "Sign in with browser" }).click();
		await expect
			.poll(() => client?.app.evaluate(() => Reflect.get(globalThis, "openedUrls")))
			.toEqual([expect.stringMatching(/^https:\/\/claude\.ai\/oauth\/authorize\?/)]);
		const redirect = "http://localhost:54545/callback?code=abc&state=xyz";
		// B's callback is out of A's browser's reach, so the code paste starts open.
		await anthropic.getByLabel("Authorization code or redirect address").fill(redirect);
		await anthropic.getByRole("button", { name: "Connect", exact: true }).click();
		await expect(a.getByText("Signed in to Anthropic")).toBeVisible();
		await expect(anthropic.locator("[data-remote-login-hint]")).toHaveCount(0);
		const hostFrames = await recorded(host.record);
		expect(hostFrames).toContainEqual(expect.objectContaining({ type: "login", providerId: "anthropic" }));
		expect(hostFrames).toContainEqual(expect.objectContaining({ type: "extension_ui_response", value: redirect }));
		const clientFrames = await recorded(client.record);
		expect(clientFrames).not.toContainEqual(expect.objectContaining({ type: "login" }));
		expect(clientFrames).not.toContainEqual(expect.objectContaining({ value: redirect }));

		// A local tab: A's own models.yml, no device banner, "Edit config" back.
		await a.keyboard.press("Escape");
		await expect(settings).toHaveCount(0);
		await focusTab(localTab.tabId);
		await openModels();
		await expect(settings.getByText("host-a-provider", { exact: true })).toBeVisible();
		await expect(settings.getByText("host-b-provider", { exact: true })).toHaveCount(0);
		await expect(a.locator("[data-settings-device-banner]")).toHaveCount(0);
		await expect(a.locator("[data-this-device-tag]")).toHaveCount(0);
		await expect(settings.getByRole("button", { name: "Edit config" })).toBeVisible();
		await a.keyboard.press("Escape");
		await expect(settings).toHaveCount(0);
		await focusTab(remoteTab.tabId);

		// C114: the remote tab's terminal is B's shell, started in B's project folder.
		if (process.platform !== "win32") {
			await a.getByRole("button", { name: "Side panel", exact: true }).click();
			const aside = a.locator("aside[data-docked]");
			await aside.getByRole("button", { name: "Terminal", exact: true }).click();
			const viewport = aside.locator("[data-terminal-viewport]");
			await viewport.click();
			await a.keyboard.type("echo where=$PWD\n");
			await expect(viewport).toContainText(`where=${host.project}`, { timeout: 20_000 });
			await a.screenshot({ path: "test-results/remote-terminal.png", scale: "css", animations: "disabled" });
		}

		// ── B goes away: A's tab says it is reconnecting and refuses commands ──
		await exitApp(host.app);
		host = null;
		await expect(a.locator(`[data-remote-reconnecting="${deviceId}"]`)).toBeVisible();
		await expect(a.locator(`[data-remote-reconnecting="${deviceId}"]`)).toContainText("Reconnecting to");
		await a.screenshot({ path: "test-results/remote-client-offline.png", scale: "css", animations: "disabled" });
		await expect
			.poll(
				async () => (await a.evaluate(() => window.omp.tabs.list())).find(tab => tab.device === deviceId)?.status,
			)
			.toBe("error");
		// Settings for the offline host's tab say so instead of showing stale values.
		await openModels();
		await expect(a.locator("[data-host-offline]")).toContainText("Host B is offline");
		await expect(settings.getByText("host-b-provider", { exact: true })).toHaveCount(0);
		expect(client.errors).toEqual([]);
	} finally {
		if (host) await exitApp(host.app);
		if (client) await exitApp(client.app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
