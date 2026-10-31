import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { controlToolCaller, exitApp, readRecords } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, type RemoteInstance } from "./remote-harness";

// The bot (src/main/agent-control/bot.ts) for a session a paired device runs on this computer: its omp lives in
// LocalHostServices, which no window here shows, so its question never reaches the pool by itself. Once it waits,
// the bot's computer opens it in a background tab (a view of the same omp), the question wakes the bot there, the
// bot's answer reaches the card in that omp, and the tab closes again. The rules are unit-tested in bot.test.ts.

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

test("answers the question of a session a paired device runs here, which no window here showed", async () => {
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

	// The bot: the session main made by itself, no setup (agent-control/bot-home.ts).
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

	// Its tool approval wakes the host's bot with one question report, from the tab the host opened for it.
	const questions = async () =>
		(await readRecords(hostProfile.record)).filter(
			frame =>
				frame.type === "agent_control.mail" &&
				(frame.details as Record<string, unknown> | undefined)?.kind === "question",
		);
	await expect.poll(async () => (await questions()).length, { timeout: 60_000 }).toBe(1);
	const [question] = await questions();
	expect(question).toMatchObject({ triggerTurn: true, deliverAs: "aside" });
	const shown = String((question?.details as Record<string, unknown> | undefined)?.from ?? "");
	expect(before.has(shown)).toBe(false);
	expect((await hostTabs()).map(tab => tab.tabId)).toContain(shown);

	// The bot's answer reaches the card in the omp the device's session runs in. Its tab is the one the question woke.
	let bot = "";
	await expect
		.poll(
			async () => {
				bot = (await hostTabs()).find(tab => tab.sessionPath === botPath)?.tabId ?? "";
				return bot;
			},
			{ timeout: 30_000 },
		)
		.not.toBe("");
	const call = await controlToolCaller(hostPage, hostProfile.record, bot);
	const answered = await call("ompdesk_session_answer", { session: shown, request: "approval", choice: "Deny" });
	expect(answered.isError, answered.text).toBe(false);
	await expect
		.poll(async () =>
			(await readRecords(hostProfile.record)).some(
				frame => frame.type === "extension_ui_response" && frame.id === "approval",
			),
		)
		.toBe(true);
	// Answered, the session no longer waits: the tab the host opened for it closes again.
	await expect.poll(async () => (await hostTabs()).some(tab => tab.tabId === shown), { timeout: 30_000 }).toBe(false);
});
