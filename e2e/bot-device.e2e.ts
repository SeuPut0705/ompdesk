import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { cssString, exitApp, mailReports, readRecords } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, type RemoteInstance } from "./remote-harness";

// The host's bot (src/main/agent-control/bot.ts) seen from a paired device: the device's section for the host draws
// it as its one fixed row, and a session the device runs on the host is the device's own, never handed to that bot (it
// answers only the sessions it opened): the device answers its card, and the host opens no tab for it and mails the
// bot nothing. The rules are unit-tested in bot.test.ts.

let parent: string;
let host: RemoteInstance | undefined;
let client: RemoteInstance | undefined;

test.beforeEach(async () => {
	parent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-bot-device-"));
});

test.afterEach(async () => {
	for (const instance of [client, host]) if (instance) await exitApp(instance.app);
	for (const instance of [client, host]) expect(instance?.errors ?? []).toEqual([]);
	await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("a device shows the host's bot row, and a session it runs on the host stays its own", async () => {
	test.setTimeout(240_000);
	const hostProfile = await makeRemoteProfile(parent, "host", { language: "en", theme: "light" });
	const clientProfile = await makeRemoteProfile(parent, "client", {
		language: "en",
		theme: "light",
		port: hostProfile.port,
	});
	host = await launchRemote(hostProfile);
	client = await launchRemote(clientProfile);
	const deviceId = await connectHost(host.page, client.page, "PC-B");
	const linked = async () => (await client?.page.evaluate(() => window.omp.remote.getState()))?.hosts[0]?.state;
	await expect.poll(linked, { timeout: 30_000 }).toBe("online");
	const hostPage = host.page;
	const hostTabs = () => hostPage.evaluate(() => window.omp.tabs.list());

	// The owner turns the bot on (Settings › Bot): main makes its session (agent-control/bot-home.ts).
	await hostPage.evaluate(() => window.omp.prefs.set("botEnabled", true));
	let botPath = "";
	await expect
		.poll(
			async () => {
				const value = await hostPage.evaluate(() => window.omp.prefs.get("bot"));
				botPath = typeof value === "string" ? value : "";
				return botPath;
			},
			{ timeout: 30_000 },
		)
		.not.toBe("");

	// The device's section for the host draws the host's bot as its one fixed row, first, as the host does.
	const section = client.page.locator(`[data-sidebar-device=${cssString(deviceId)}]`);
	await expect(section.locator("[data-sidebar-bot-row]")).toHaveCount(1, { timeout: 30_000 });
	await expect(section.locator(".omp-sidebar-session-row").first()).toHaveAttribute("data-sidebar-bot-row", "true");
	await expect(section.locator(`[data-device-session=${cssString(botPath)}]`)).toHaveCount(1);

	// The device opens a session that runs on the host; no window of the host shows it.
	const spawned = await client.page.evaluate(([cwd, device]) => window.omp.tabs.spawn({ cwd, device }), [
		hostProfile.project,
		deviceId,
	] as const);
	const onHost = spawned?.tabId ?? "";
	expect(onHost).not.toBe("");
	await expect
		.poll(
			async () =>
				(await client?.page.evaluate(() => window.omp.tabs.list()))?.find(tab => tab.tabId === onHost)?.status,
			{
				timeout: 60_000,
			},
		)
		.toBe("ready");
	const before = new Set((await hostTabs()).map(tab => tab.tabId));
	await client.page.evaluate(
		id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture approval" }),
		onHost,
	);

	// Its tool approval is the device's: the device answers it itself, once the card is open there.
	await expect
		.poll(
			() =>
				client?.page.evaluate(async tabId => {
					try {
						await window.omp.ui.respondExtensionUi(
							{ type: "extension_ui_response", id: "approval", value: "Deny" },
							tabId,
						);
						return "accepted";
					} catch (error) {
						return error instanceof Error ? error.message : String(error);
					}
				}, onHost),
			{ timeout: 60_000 },
		)
		.toBe("accepted");
	await expect
		.poll(async () =>
			(await readRecords(hostProfile.record)).some(
				frame => frame.type === "extension_ui_response" && frame.id === "approval",
			),
		)
		.toBe(true);
	// The host's bot heard nothing of it, and no tab here was opened for it.
	expect(await mailReports(hostProfile.record, details => details.kind === "question")).toEqual([]);
	expect((await hostTabs()).filter(tab => !before.has(tab.tabId))).toEqual([]);
});
