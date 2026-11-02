/**
 * A computer viewing a paired host's tab keeps what its person sends while the link to that host is down, however
 * long, and delivers it once the link is back: two computers (A views B's tab through `linkProxy`, which refuses every
 * connection for a whole minute).
 *
 * - Two messages sent to B's tab during the outage leave the field and wait in the composer's "will send when
 *   connected" tray (`[data-composer-outbox]`); a third is cancelled from the tray. Nothing reaches B's omp.
 * - A's own tab still sends at once meanwhile, with no tray: its omp runs on A.
 * - A's window reloads in the middle of the outage and still shows both.
 * - Once the link is back each of the two reaches B's omp exactly once, in the order they were sent.
 *
 * The phone page: phone-offline-send.e2e.ts.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { cssString, exitApp, readRecords } from "./harness";
import {
	connectHost,
	freePort,
	launchRemote,
	linkProxy,
	makeRemoteProfile,
	openHostFolder,
	type RemoteInstance,
} from "./remote-harness";

/** How long B stays out of reach. */
const OUTAGE_MS = 60_000;

/** Which of `texts` the omp recorded as prompts, in the order it read them. */
async function received(record: string, texts: readonly string[]): Promise<string[]> {
	const out: string[] = [];
	for (const frame of await readRecords(record)) {
		if (frame.type !== "prompt" && frame.type !== "steer" && frame.type !== "follow_up") continue;
		const text = texts.find(candidate => typeof frame.message === "string" && frame.message.includes(candidate));
		if (text) out.push(text);
	}
	return out;
}

async function send(page: Page, text: string): Promise<void> {
	const field = page.locator("textarea").first();
	await field.fill(text);
	await field.press("Enter");
	await expect(field).toHaveValue("");
}

/** Wait until main routes `tabId` as the window's active tab. */
async function activeIs(page: Page, tabId: string): Promise<void> {
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId)
		.toBe(tabId);
}

test("a computer keeps what it sends to a paired host's tab during a long outage and delivers each once, in order", async () => {
	test.setTimeout(300_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-remote-outbox-")));
	const hostPort = await freePort();
	const proxy = await linkProxy(hostPort);
	let host: RemoteInstance | null = null;
	let client: RemoteInstance | null = null;
	try {
		const hostProfile = await makeRemoteProfile(parent, "b", { language: "en", theme: "light", port: hostPort });
		const clientProfile = await makeRemoteProfile(parent, "a", {
			language: "en",
			theme: "light",
			port: Number(proxy.address.split(":")[1]),
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const a = client.page;
		// A's own session, written to so it stays when B's tab opens beside it (an untouched start tab gives way).
		await send(a, "local hello");
		let localTabId = "";
		let localPath = "";
		await expect
			.poll(
				async () => {
					const tab = (await a.evaluate(() => window.omp.tabs.list())).find(entry => entry.device === undefined);
					localTabId = tab?.tabId ?? "";
					localPath = tab?.sessionPath ?? "";
					return localPath !== "" && (await received(clientProfile.record, ["local hello"])).length === 1;
				},
				{ timeout: 30_000 },
			)
			.toBe(true);
		const deviceId = await connectHost(host.page, a, "Host B");
		const remoteTabId = await openHostFolder(a, deviceId, hostProfile.project);
		expect((await a.evaluate(() => window.omp.tabs.list())).map(tab => tab.tabId).sort()).toEqual(
			[localTabId, remoteTabId].sort(),
		);
		const localRow = a.locator(`[data-session-path=${cssString(localPath)}]`).first();

		await send(a, "hello before the outage");
		await expect
			.poll(() => received(hostProfile.record, ["hello before the outage"]), { timeout: 30_000 })
			.toEqual(["hello before the outage"]);

		const texts = ["offline message one", "offline message two", "offline message cancelled"] as const;
		const outageStart = Date.now();
		await proxy.drop();
		await expect
			.poll(
				async () => (await a.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === remoteTabId)?.status,
				{
					timeout: 30_000,
				},
			)
			.toBe("error");
		const tray = a.locator("[data-composer-outbox]:visible");
		const rows = tray.locator("[data-outbox-item]");
		for (const text of texts) await send(a, text);
		await expect(rows).toHaveCount(3);
		for (const [index, text] of texts.entries()) await expect(rows.nth(index)).toContainText(text);
		await a.screenshot({ path: "test-results/remote-offline-tray.png", scale: "css", animations: "disabled" });
		await rows.nth(2).locator("[data-outbox-cancel]").click();
		await expect(rows).toHaveCount(2);

		// A's own tab is not behind the link: a message there goes at once, with no tray.
		await localRow.locator("button[data-roving-item]").first().click();
		await activeIs(a, localTabId);
		await send(a, "local while the host is away");
		await expect
			.poll(() => received(clientProfile.record, ["local while the host is away"]), { timeout: 30_000 })
			.toEqual(["local while the host is away"]);
		await expect(tray).toHaveCount(0);
		await a.screenshot({ path: "test-results/remote-offline-local-tab.png", scale: "css", animations: "disabled" });
		// B's section folds while B is offline: A goes back to B's tab the way a person would, Ctrl+Tab (the last one).
		await a.keyboard.press("Control+Tab");
		await activeIs(a, remoteTabId);
		await expect(rows).toHaveCount(2);

		// A's window reloads during the outage: what waits is still there.
		await a.reload();
		await a.waitForFunction(() => window.omp?.remote != null);
		await expect(rows).toHaveCount(2, { timeout: 30_000 });
		await expect(rows.nth(0)).toContainText(texts[0]);
		await expect(rows.nth(1)).toContainText(texts[1]);
		expect(await received(hostProfile.record, texts)).toEqual([]);

		await a.waitForTimeout(Math.max(0, OUTAGE_MS - (Date.now() - outageStart)));
		expect(await received(hostProfile.record, texts)).toEqual([]);
		await proxy.restore();

		await expect.poll(() => received(hostProfile.record, texts), { timeout: 60_000 }).toEqual([texts[0], texts[1]]);
		await expect(tray).toHaveCount(0, { timeout: 10_000 });
		await a.waitForTimeout(3000);
		expect(await received(hostProfile.record, texts)).toEqual([texts[0], texts[1]]);
		expect(client.errors).toEqual([]);
	} finally {
		if (client) await exitApp(client.app).catch(() => undefined);
		if (host) await exitApp(host.app).catch(() => undefined);
		await proxy.close();
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => undefined);
	}
});
