import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { controlToolCaller, cssString, exitApp, mailReports, readRecords } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, type RemoteInstance } from "./remote-harness";

// The host's bot (src/main/agent-control/bot.ts) seen from a paired device: the device's section for the host draws
// it as its one fixed row, and a session the device runs on the host is the device's own, never handed to that bot (it
// answers only the sessions it opened): the device answers its card, and the host opens no tab for it and mails the
// bot nothing. The rules are unit-tested in bot.test.ts. The second test is the host's bot pane on the device
// (`host.botDesk.*`, host-services.test.ts): the count on the host's row, the pane, the answer reaching the host's bot.

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

test("a device opens the host's bot, sees its decision count, answers it, and edits its duties", async () => {
	test.setTimeout(300_000);
	const hostProfile = await makeRemoteProfile(parent, "host", {
		language: "en",
		theme: "light",
		prefs: { botEnabled: true },
	});
	const clientProfile = await makeRemoteProfile(parent, "client", {
		language: "en",
		theme: "light",
		port: hostProfile.port,
	});
	host = await launchRemote(hostProfile);
	client = await launchRemote(clientProfile);
	const deviceId = await connectHost(host.page, client.page, "PC-B");
	const hostPage = host.page;
	const clientPage = client.page;
	await expect
		.poll(async () => (await clientPage.evaluate(() => window.omp.remote.getState())).hosts[0]?.state, {
			timeout: 30_000,
		})
		.toBe("online");

	// The host's bot posts a decision from its own tab (only the bot's own tab may use its desk tool).
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
	await hostPage.locator("[data-sidebar-bot-row]").click();
	let botTab = "";
	await expect
		.poll(
			async () => {
				const tab = (await hostPage.evaluate(() => window.omp.tabs.list())).find(
					entry => entry.sessionPath === botPath,
				);
				botTab = tab?.tabId ?? "";
				return tab?.status;
			},
			{ timeout: 60_000 },
		)
		.toBe("ready");
	const callBot = await controlToolCaller(hostPage, hostProfile.record, botTab);
	const posted = await callBot("ompdesk_bot", {
		action: "decide",
		question: "Ship the release today?",
		options: ["Ship it", "Wait"],
	});
	expect(posted.isError, posted.text).toBe(false);
	const id = /Decision (\S+) is posted/.exec(posted.text)?.[1] ?? "";
	expect(id).not.toBe("");

	// The device's section for the host counts it on the host's bot row, as the host's own row does; this computer's
	// own bot is off, so it is the only count on the page.
	const section = clientPage.locator(`[data-sidebar-device=${cssString(deviceId)}]`);
	const count = section.locator("[data-sidebar-bot-decisions]");
	await expect(count).toHaveAttribute("data-sidebar-bot-decisions", "1", { timeout: 30_000 });
	await expect(clientPage.locator("[data-sidebar-bot-decisions]")).toHaveCount(1);

	// Opening the row opens the host's bot: the host's desk around the conversation, under the host's name.
	await section.locator("[data-sidebar-bot-row]").click();
	await expect(clientPage.locator("[data-bot-bar]")).toBeVisible({ timeout: 60_000 });
	await expect(clientPage.locator("[data-bot-device]")).toContainText("PC-B");
	const card = clientPage.locator("[data-bot-decision]");
	await expect(card).toHaveCount(1);
	await expect(card).toContainText("Ship the release today?");

	// The device answers in place: the card and the count go, and the host's bot gets the answer as a turn, once.
	await card.locator('[data-bot-option="Ship it"]').click();
	await expect(card).toHaveCount(0);
	await expect(count).toHaveCount(0);
	const answers = () => mailReports(hostProfile.record, details => details.id === `bot-decision-${id}`);
	await expect.poll(async () => (await answers()).length, { timeout: 30_000 }).toBe(1);
	const [answer] = await answers();
	expect(answer).toMatchObject({ triggerTurn: true, deliverAs: "aside" });
	expect(String(answer?.content)).toContain("Answer: Ship it");
	// The host's own pane agrees, and nothing is told twice.
	await expect(hostPage.locator("[data-bot-decision]")).toHaveCount(0);
	expect(await answers()).toHaveLength(1);

	// A duty added on the device is the host bot's: the host's board lists it.
	await clientPage.locator("[data-bot-duty-input]").fill("Check the nightly build");
	await clientPage.locator("[data-bot-duty-input]").press("Enter");
	await expect(clientPage.locator("[data-bot-duty]")).toContainText(["Check the nightly build"]);
	await expect(hostPage.locator("[data-bot-duty]")).toContainText(["Check the nightly build"]);
});
