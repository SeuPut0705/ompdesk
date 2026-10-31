/**
 * A failed attempt stock's own auto-retry saga is still working on shows no failure card, however the session is
 * looked at (25 Oct 2026, the user's report: a socket closed mid-reply at 11:30:42, stock's retry resent at once and
 * its first byte came 55 s later; a paired desktop showed the red "turnError.unknown" card with Retry and Change model
 * the whole time, under a "waiting for the model" cue). The saga is open from `auto_retry_start` until stock's
 * `auto_retry_end` (a recovered saga closes only once the retried answer settled, turn-recovery.ts
 * `onAssistantSettledSuccessfully`). Main forwards a tab's events only while a window shows it, and a view that
 * joins mid-run hears none of the saga's start: such a view knew no saga, so the failed attempt read as the turn's end.
 * The fake omp's `fixture socket drop recovered` plays that saga with a slow retried answer
 * (`OMP_GUI_TEST_SOCKET_ANSWER_MS`).
 *
 * Paths: the tab shown in a window; the tab in the background, shown during the wait; a paired device's view of the
 * host window's tab, shown, in the background, and opened during the wait. Unit-level: TurnErrorNotice.test.tsx (the
 * card's rule), tabs.test.tsx (the status's saga), sidecar-run-state.test.ts (the saga across a reading).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { cssString, exitApp } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, type RemoteInstance } from "./remote-harness";

const PROMPT = "fixture socket drop recovered";
const ANSWER = "Answered after the dropped connection";
/** Stock's backoff before the retried request, and how long that request waits for its first byte. */
const SAGA_ENV = { OMP_GUI_TEST_SOCKET_RETRY_MS: "800", OMP_GUI_TEST_SOCKET_ANSWER_MS: "14000" };

interface Sample {
	/** The failure card (`.omp-message-error`). */
	card: number;
	/** The status row's "Retrying (n/m)…": the renderer holds the saga (`retryInfo`). */
	retryRow: boolean;
	/** The work card's "waiting for the model" head: `awaitingModelSince` without a saga. */
	awaitingModel: boolean;
	/** The transcript's last row: the latest message the card reads. */
	last: string | null;
	/** Main's status for the tab. */
	status: string | undefined;
}

async function sample(page: Page, tabId: string): Promise<Sample> {
	const shown = await page.evaluate(() => {
		const rows = [...document.querySelectorAll("[data-transcript-kind]")];
		const last = rows.at(-1);
		const turn = document.querySelector(".omp-status-turn")?.textContent ?? "";
		return {
			card: document.querySelectorAll(".omp-message-error").length,
			retryRow: /Retrying \(\d\/\d\)/.test(turn),
			awaitingModel: document.querySelector("[data-awaiting-card]") !== null,
			last: last
				? `${last.getAttribute("data-transcript-kind")}: ${(last.textContent ?? "").replace(/\s+/g, " ").slice(0, 90)}`
				: null,
		};
	});
	const tab = (await page.evaluate(() => window.omp.tabs.list())).find(entry => entry.tabId === tabId);
	return { ...shown, status: tab?.status };
}

/** Samples the shown tab four times over two seconds of the retried request's wait; logged for the report. */
async function duringWait(page: Page, tabId: string, label: string): Promise<Sample[]> {
	// The shown transcript holds the failed attempt before anything is judged.
	await expect(page.locator("[data-transcript-kind]").last()).toBeVisible({ timeout: 15_000 });
	const samples: Sample[] = [];
	for (let index = 0; index < 4; index++) {
		await page.waitForTimeout(500);
		samples.push(await sample(page, tabId));
	}
	console.log(`[${label}] during the wait: ${JSON.stringify(samples)}`);
	return samples;
}

/** After the saga recovered: no card, the failed attempt is the quiet "tried again" note, the answer is there. */
async function recovered(page: Page, label: string): Promise<void> {
	await expect(page.getByText(ANSWER)).toBeVisible({ timeout: 45_000 });
	await expect(page.locator("[data-turn-retried]")).toHaveCount(1);
	expect(await page.locator(".omp-message-error").count(), `${label}: card after the saga recovered`).toBe(0);
}

async function tabs(page: Page) {
	return page.evaluate(() => window.omp.tabs.list());
}

async function activeTab(page: Page): Promise<string> {
	const active = (await tabs(page)).find(tab => tab.active);
	if (!active) throw new Error("No active tab");
	return active.tabId;
}

/** Show `tabId` the way a person does: its sidebar row (a paired host's session sits in the host's section). */
async function showTab(page: Page, tabId: string): Promise<void> {
	if ((await activeTab(page)) === tabId) return;
	const tab = (await tabs(page)).find(entry => entry.tabId === tabId);
	const key = cssString(tab?.sessionPath ?? `tab:${tabId}`);
	await page
		.locator(
			`[data-session-path=${key}] button[data-roving-item], [data-device-session=${key}] button[data-roving-item]`,
		)
		.first()
		.click();
	await expect.poll(() => activeTab(page)).toBe(tabId);
}

/** Another local tab in front (⌘T: a new one, or the window's fresh one); the shown tab goes to the background. */
async function newTabInFront(page: Page): Promise<void> {
	const shown = await activeTab(page);
	await page.keyboard.press("ControlOrMeta+t");
	await expect.poll(() => activeTab(page)).not.toBe(shown);
}

async function sendTo(page: Page, tabId: string, message: string): Promise<void> {
	const response = await page.evaluate(
		([id, text]) => window.omp.rpc.commandForTab(id, { type: "prompt", message: text }),
		[tabId, message] as const,
	);
	expect(response.success).toBe(true);
}

async function typeAndSend(page: Page, message: string): Promise<void> {
	const input = page.locator(".omp-composer-input").first();
	await input.fill(message);
	await input.press("Enter");
}

function expectNoCard(samples: Sample[], label: string): void {
	expect(
		samples.map(entry => entry.card),
		`${label}: failure card while stock's retry saga was open`,
	).toEqual(samples.map(() => 0));
	expect(
		samples.map(entry => entry.retryRow),
		`${label}: the status row names the retry`,
	).toEqual(samples.map(() => true));
}

let parent = "";
test.beforeEach(async () => {
	parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-retry-card-")));
});
test.afterEach(async () => {
	await fs.rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => undefined);
});

test.describe("one app", () => {
	let instance: RemoteInstance | undefined;
	test.beforeEach(async () => {
		const profile = await makeRemoteProfile(parent, "one", { language: "en", theme: "light", env: SAGA_ENV });
		instance = await launchRemote(profile);
	});
	test.afterEach(async () => {
		if (instance) await exitApp(instance.app);
		instance = undefined;
	});

	test("the tab shown in its window: the saga's row, no card, then the answer", async () => {
		test.setTimeout(120_000);
		const { page } = instance as RemoteInstance;
		const tab = await activeTab(page);
		await typeAndSend(page, PROMPT);
		await page.waitForTimeout(1_500);
		expectNoCard(await duringWait(page, tab, "a shown"), "a shown");
		await recovered(page, "a shown");
	});

	test("the tab in the background when the saga starts, shown during the retried request", async () => {
		test.setTimeout(120_000);
		const { page } = instance as RemoteInstance;
		const tab = await activeTab(page);
		// A tab nothing was typed into has no sidebar row: a first turn gives it one.
		await typeAndSend(page, "hello there");
		await expect(page.getByText("Local fixture reply")).toHaveCount(1, { timeout: 30_000 });
		await newTabInFront(page);
		await sendTo(page, tab, PROMPT);
		await page.waitForTimeout(1_500);
		await showTab(page, tab);
		expectNoCard(await duringWait(page, tab, "b background"), "b background");
		await recovered(page, "b background");
	});
});

test.describe("a paired device viewing the host window's tab", () => {
	let host: RemoteInstance | undefined;
	let device: RemoteInstance | undefined;
	let deviceId = "";
	let hostTab = "";
	let sessionPath = "";
	test.beforeEach(async () => {
		test.setTimeout(240_000);
		// A device opening the session takes a while: the retried request waits long enough for it to join mid-saga.
		const hostProfile = await makeRemoteProfile(parent, "host", {
			language: "en",
			theme: "light",
			env: { ...SAGA_ENV, OMP_GUI_TEST_SOCKET_ANSWER_MS: "30000" },
		});
		host = await launchRemote(hostProfile);
		const deviceProfile = await makeRemoteProfile(parent, "device", {
			language: "en",
			theme: "light",
			port: hostProfile.port,
		});
		device = await launchRemote(deviceProfile);
		deviceId = await connectHost(host.page, device.page, "Studio");
		// The host's own window holds the session; a first turn writes its file.
		hostTab = await activeTab(host.page);
		await typeAndSend(host.page, "hello there");
		await expect(host.page.getByText("Local fixture reply")).toHaveCount(1, { timeout: 30_000 });
		await expect
			.poll(async () => (await tabs(host?.page as Page)).find(tab => tab.tabId === hostTab)?.sessionPath ?? "", {
				timeout: 30_000,
			})
			.toMatch(/\.jsonl$/);
		sessionPath = (await tabs(host.page)).find(tab => tab.tabId === hostTab)?.sessionPath ?? "";
	});
	test.afterEach(async () => {
		if (device) await exitApp(device.app);
		if (host) await exitApp(host.app);
		device = undefined;
		host = undefined;
	});

	/** The device opens the host's session: a view of the host window's tab. */
	async function view(page: Page): Promise<string> {
		const spawned = await page.evaluate(([file, id]) => window.omp.tabs.spawn({ sessionPath: file, device: id }), [
			sessionPath,
			deviceId,
		] as const);
		const tabId = spawned?.tabId ?? "";
		expect(tabId, `the device could not view the session: ${JSON.stringify(spawned)}`).not.toBe("");
		// A view of a turn in flight reads `running`.
		await expect
			.poll(async () => (await tabs(page)).find(tab => tab.tabId === tabId)?.status, { timeout: 60_000 })
			.toMatch(/^(ready|running)$/);
		await showTab(page, tabId);
		await expect(page.getByText("Local fixture reply")).toBeVisible({ timeout: 30_000 });
		return tabId;
	}

	test("shown on the device, which sends the prompt", async () => {
		test.setTimeout(240_000);
		const page = (device as RemoteInstance).page;
		const tab = await view(page);
		await typeAndSend(page, PROMPT);
		await page.waitForTimeout(1_500);
		expectNoCard(await duringWait(page, tab, "c shown"), "c shown");
		await recovered(page, "c shown");
	});

	test("in the background on the device when the saga starts, shown during the retried request", async () => {
		test.setTimeout(240_000);
		const page = (device as RemoteInstance).page;
		const tab = await view(page);
		await newTabInFront(page);
		await sendTo(page, tab, PROMPT);
		await page.waitForTimeout(1_500);
		await showTab(page, tab);
		expectNoCard(await duringWait(page, tab, "c background"), "c background");
		await recovered(page, "c background");
	});

	test("opened on the device while the retried request waits", async () => {
		test.setTimeout(240_000);
		const page = (device as RemoteInstance).page;
		await sendTo((host as RemoteInstance).page, hostTab, PROMPT);
		await (host as RemoteInstance).page.waitForTimeout(1_500);
		const tab = await view(page);
		expectNoCard(await duringWait(page, tab, "c joined"), "c joined");
		await recovered(page, "c joined");
	});
});
