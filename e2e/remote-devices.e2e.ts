import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { HostStore } from "../src/main/remote/hosts-store";
import { loadIdentity } from "../src/main/remote/identity";
import { PeerStore } from "../src/main/remote/peers-store";
import { exitApp, fixtureOmp, launchApp, readRecords, walkRemotePicker } from "./harness";
import {
	availableHost,
	freePort,
	launchRemote,
	makeRemoteProfile,
	REMOTE_LOGIN,
	type RemoteInstance,
	remoteTailscale,
} from "./remote-harness";

// Two OMPdesk instances on the fake omp and a fake Tailscale each: B shares itself, A finds it among the
// computers of its tailnet in Settings › Devices & connections and connects with no code, opens a session on B
// from its sidebar, and the prompt runs on B's omp. 127.0.0.1 stands in for the tailnet
// (OMP_GUI_TEST_REMOTE_LOOPBACK); both apps share one free port (B listens on it, A probes it).

interface Instance {
	app: ElectronApplication;
	page: Page;
	/** The fixture omp's command log (OMP_GUI_TEST_RECORD). */
	record: string;
	project: string;
	errors: string[];
}

async function launch(profile: string, name: string, port: number, customProvider: string): Promise<Instance> {
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
	await fs.symlink(natives, path.join(path.dirname(bin), "node_modules/@oh-my-pi/pi-natives"), "junction");
	const tailscale = await remoteTailscale(root, name);
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile: root,
		env: {
			OMP_GUI_OMP: bin,
			OMP_GUI_TEST_RECORD: record,
			OMP_GUI_REMOTE_PORT: String(port),
			OMP_GUI_TEST_REMOTE_LOOPBACK: "1",
			OMP_GUI_TEST_LOGIN: "1",
			...tailscale.env,
		},
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

test("@smoke connects two computers over the tailnet with no code, runs a prompt on the host, and shows the link drop", async () => {
	test.setTimeout(180_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-remote-"));
	const port = await freePort();
	let host: Instance | null = null;
	let client: Instance | null = null;
	try {
		host = await launch(profile, "b", port, "host-b-provider");
		client = await launch(profile, "a", port, "host-a-provider");
		const b = host.page;
		const a = client.page;

		// ── B: let other devices use this computer; it listens on its tailnet address only ──
		await b.evaluate(() => window.omp.remote.setDeviceName("Host B"));
		await openRemoteSettings(b);
		await b.getByRole("switch", { name: "Let other devices use this computer" }).click();
		await expect(b.locator("[data-remote-addresses]")).toContainText(`127.0.0.1:${port}`);
		await expect(b.locator("[data-remote-section] [data-remote-code]")).toHaveCount(0);
		await b.screenshot({ path: "test-results/remote-host-settings.png", scale: "css", animations: "disabled" });

		// ── A: Settings › Devices & connections lists B among the tailnet's computers; Connect ──
		await openRemoteSettings(a);
		const row = a.locator("[data-remote-tailnet-row]").first();
		await expect(row).toHaveAttribute("data-remote-tailnet-state", "available", { timeout: 30_000 });
		await expect(row).toContainText("Host B");
		await row.locator("[data-remote-tailnet-connect]").click();
		const hostRow = a.locator("[data-remote-hosts] [data-remote-host]");
		await expect(hostRow).toContainText("Online");
		await expect(row).toContainText("Connected");
		const deviceId = await hostRow.getAttribute("data-remote-host");
		if (!deviceId) throw new Error("expected the connected host's id");
		// B lists A as a connected device, with A's Tailscale account.
		await expect(b.locator("[data-remote-peers] [data-remote-peer]")).toContainText("Online");
		await a.keyboard.press("Escape");
		await expect(a.locator("[data-settings-page]")).toHaveCount(0);

		// ── A: its own tab holds work (an empty new session left for another is closed, `unstarted`) ──
		const startTab = (await a.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId ?? "";
		await a.evaluate(
			id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:title:Local work" }),
			startTab,
		);

		// ── A: open a session on B from the sidebar device section ──
		const section = a.locator(`[data-sidebar-device="${deviceId}"]`);
		await expect(section).toHaveAttribute("data-device-state", "online");
		await section.locator(`[data-sidebar-device-toggle="${deviceId}"]`).hover();
		await section.locator(`[data-sidebar-device-add="${deviceId}"]`).click();
		const picker = a.getByRole("dialog", { name: /Choose a folder on/ });
		// Up to the root, then down B's real path to its project folder.
		await walkRemotePicker(picker, host.project);
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
		await expect.poll(async () => (await readRecords(host?.record ?? "")).some(isPrompt)).toBe(true);
		expect((await readRecords(client.record)).some(isPrompt)).toBe(false);

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
		const anthropic = settings.locator("[data-login-panel]");
		await settings.locator('button[data-provider-connect="anthropic"]').click();
		await expect(anthropic.locator("[data-remote-login-hint]")).toContainText("the sign-in finishes on Host B");
		await anthropic.getByRole("button", { name: "Sign in with browser" }).click();
		await expect
			.poll(() => client?.app.evaluate(() => Reflect.get(globalThis, "openedUrls")))
			.toEqual([expect.stringMatching(/^https:\/\/claude\.ai\/oauth\/authorize\?/)]);
		const redirect = "http://localhost:54545/callback?code=abc&state=xyz";
		// B's callback is out of A's browser's reach, so the code paste starts open.
		await anthropic.getByLabel("Authorization code or redirect address").fill(redirect);
		await anthropic.getByRole("button", { name: "Connect", exact: true }).click();
		await expect(a.getByText("Signed in to Claude")).toBeVisible();
		await expect(anthropic.locator("[data-remote-login-hint]")).toHaveCount(0);
		const hostFrames = await readRecords(host.record);
		expect(hostFrames).toContainEqual(expect.objectContaining({ type: "login", providerId: "anthropic" }));
		expect(hostFrames).toContainEqual(expect.objectContaining({ type: "extension_ui_response", value: redirect }));
		const clientFrames = await readRecords(client.record);
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
			// Keys typed before xterm has mounted its input reach nothing: wait for it, then type.
			await viewport.locator(".xterm-helper-textarea").focus();
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

test("refuses a login the host does not allow and a blocked node, finds a host on its next port, and keeps code-paired computers found on the tailnet", async () => {
	test.setTimeout(240_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-tailnet-")));
	let host: RemoteInstance | null = null;
	let client: RemoteInstance | null = null;
	// B's first port is taken by another program: B takes the next one, and A still finds it.
	const base = await freePort();
	const busy = net.createServer(socket => socket.destroy());
	await new Promise<void>(resolve => busy.listen(base, "127.0.0.1", resolve));
	try {
		const hostProfile = await makeRemoteProfile(parent, "b", {
			language: "en",
			theme: "light",
			port: base,
			prefs: { mobileWeb: { allowedUsers: ["someone-else@example.com"] } },
		});
		const clientProfile = await makeRemoteProfile(parent, "a", { language: "en", theme: "light", port: base });
		// Both identities exist before launch, so each side can hold a record an older release paired by code.
		const hostIdentity = loadIdentity(hostProfile.desktop);
		const clientIdentity = loadIdentity(clientProfile.desktop);
		new PeerStore(hostProfile.desktop).put({
			deviceId: clientIdentity.deviceId,
			name: "Laptop A",
			staticPub: clientIdentity.publicKey,
			nodeId: null,
			login: null,
			pairedAt: 1,
		});
		const legacy = { staticPub: hostIdentity.publicKey, nodeId: null, pairedAt: 1 };
		const hosts = new HostStore(clientProfile.desktop);
		hosts.put({ ...legacy, deviceId: hostIdentity.deviceId, name: "Host B", addresses: [`127.0.0.1:${base}`] });
		hosts.put({ ...legacy, deviceId: "gone", name: "Old desk", addresses: ["192.0.2.1:47821"] });

		host = await launchRemote(hostProfile);
		const b = host.page;
		await b.evaluate(() => window.omp.remote.setDeviceName("Host B"));
		await b.evaluate(() => window.omp.remote.setHostEnabled(true));
		// The next free one of its list (a parallel test may hold a successor too).
		await expect
			.poll(async () => (await b.evaluate(() => window.omp.remote.getState())).host.port ?? 0)
			.toBeGreaterThan(base);

		client = await launchRemote(clientProfile);
		const a = client.page;
		// The code-paired host is matched to its tailnet node and kept; the other is forgotten, named once.
		await expect
			.poll(async () => (await a.evaluate(() => window.omp.remote.getState())).forgotten)
			.toEqual(["Old desk"]);
		expect(new HostStore(clientProfile.desktop).get(hostIdentity.deviceId)?.nodeId).toBe("n-peer-a");
		// …but B does not allow A's Tailscale account: A sees why, and connecting is refused.
		await expect
			.poll(async () => (await a.evaluate(() => window.omp.remote.watchTailnet(true)))[0]?.refusal, {
				timeout: 30_000,
			})
			.toBe("not_allowed");
		expect((await a.evaluate(() => window.omp.remote.getState())).hosts[0]?.state).not.toBe("online");

		// B allows A's account: the kept record connects by itself, and B binds it to A's node.
		await b.evaluate(
			login => window.omp.mobileWeb.command({ action: "set-allowed-users", users: [login] }),
			REMOTE_LOGIN,
		);
		await expect
			.poll(async () => (await a.evaluate(() => window.omp.remote.getState())).hosts[0]?.state, { timeout: 60_000 })
			.toBe("online");
		const peer = (await b.evaluate(() => window.omp.remote.getState())).host.peers[0];
		expect(peer).toMatchObject({ deviceId: clientIdentity.deviceId, login: REMOTE_LOGIN, online: true });

		// B blocks A: the link drops and A is refused as blocked until B unblocks it.
		await b.evaluate(id => window.omp.remote.blockPeer(id), clientIdentity.deviceId);
		await expect
			.poll(async () => (await a.evaluate(() => window.omp.remote.watchTailnet(true)))[0]?.refusal, {
				timeout: 30_000,
			})
			.toBe("blocked");
		expect((await a.evaluate(() => window.omp.remote.getState())).hosts[0]?.state).not.toBe("online");
		await b.evaluate(() => window.omp.mobileWeb.devices.unblock("node:n-peer-b"));
		const nodeId = await availableHost(a);
		await a.evaluate(id => window.omp.remote.removeHost(id), hostIdentity.deviceId);
		await a.evaluate(id => window.omp.remote.connect(id), nodeId);
		await expect
			.poll(async () => (await a.evaluate(() => window.omp.remote.getState())).hosts[0]?.state)
			.toBe("online");
	} finally {
		busy.close();
		if (host) await exitApp(host.app);
		if (client) await exitApp(client.app);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
