import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import { exitApp, launchApp, readRecords } from "./harness";

// The desktop slot (src/main/desktop-slot.ts): one session at a time drives the computer's desktop, the others
// wait in order. The fake omp stands in for the bridge's slot module: `fixture desktop acting` is an eval run that
// emits `desktop_slot_acquire` and waits for main's `desktop_slot.grant`, `fixture desktop done` lets go
// (`desktop_slot_release`), and `desktop_slot.revoke` answers after a short delay. Two tabs ask at once.

const TEXT = {
	en: {
		busy: (title: string) => `Screen in use: ${title}`,
		busyWaiting: (title: string, count: number) => `Screen in use: ${title} · ${count} waiting`,
		waiting: (position: number) => `Waiting for the screen (#${position})`,
	},
	ko: {
		busy: (title: string) => `화면 사용 중: ${title}`,
		busyWaiting: (title: string, count: number) => `화면 사용 중: ${title} · 대기 ${count}`,
		waiting: (position: number) => `화면 차례를 기다리는 중 (${position}번째)`,
	},
} as const;

let app: ElectronApplication | undefined;
let page: Page;
let profile: string | undefined;
let record: string;
let errors: string[];

async function launch(language: "en" | "ko"): Promise<void> {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-desktop-slot-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	record = path.join(profile, "rpc.jsonl");
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language, firstRunComplete: true }));
	app = await launchApp({ project, desktop, agent, profile, env: { OMP_GUI_TEST_RECORD: record } });
	page = await app.firstWindow();
	errors = [];
	page.on("pageerror", error => errors.push(error.message));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
}

test.afterEach(async () => {
	if (app) await exitApp(app);
	app = undefined;
	if (record) await fs.copyFile(record, test.info().outputPath("rpc.jsonl")).catch(() => {});
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	profile = undefined;
});

function tabs() {
	return page.evaluate(() => window.omp.tabs.list());
}

async function activeTab(): Promise<string> {
	const active = (await tabs()).find(tab => tab.active);
	if (!active) throw new Error("No active tab");
	return active.tabId;
}

/** ⌘T: a second tab takes the front. */
async function openTab(): Promise<string> {
	const before = (await tabs()).map(tab => tab.tabId);
	await page.keyboard.press("ControlOrMeta+t");
	await expect.poll(async () => (await tabs()).length).toBe(before.length + 1);
	const created = (await tabs()).find(tab => !before.includes(tab.tabId));
	if (!created) throw new Error("No new tab");
	await expect.poll(async () => (await tabs()).find(tab => tab.tabId === created.tabId)?.status).toBe("ready");
	await expect.poll(activeTab).toBe(created.tabId);
	return created.tabId;
}

/** Name a tab (the indicator and the queue show the session title) and wait until its sidebar row shows it. */
async function nameTab(tabId: string, title: string): Promise<void> {
	const response = await page.evaluate(
		([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }),
		[tabId, `fixture:title:${title}`] as const,
	);
	expect(response).toMatchObject({ success: true });
	await expect(page.locator(`[data-session-path="tab:${tabId}"]`)).toContainText(title);
}

/** Send a prompt straight to one tab's omp, in front or not (a running turn never takes it as a steer). */
async function promptTab(tabId: string, message: string): Promise<void> {
	const response = await page.evaluate(
		([id, text]) => window.omp.rpc.commandForTab(id, { type: "prompt", message: text }),
		[tabId, message] as const,
	);
	expect(response).toMatchObject({ success: true });
}

const indicatorText = () => page.locator("[data-desktop-slot-text]");

/** The grant/revoke sequence the fake omps saw, in the order they landed in the shared record file. */
async function slotSequence(): Promise<string[]> {
	const wanted = new Set(["desktop_slot.grant", "desktop_slot.revoke", "desktop_slot.revoke_answered"]);
	return (await readRecords(record))
		.filter(entry => wanted.has(String(entry.type)))
		.map(entry =>
			entry.type === "desktop_slot.grant"
				? `grant:${entry.waited === true ? "waited" : "free"}`
				: String(entry.type),
		);
}

for (const language of ["en", "ko"] as const) {
	test(`two sessions ask for the screen at once: one holds, one waits and takes over on release (${language})`, async () => {
		await launch(language);
		const text = TEXT[language];
		const first = await activeTab();
		await nameTab(first, "Alpha desk");

		// A asks first and gets the slot at once.
		await promptTab(first, "fixture desktop acting");
		await expect(indicatorText()).toHaveText(text.busy("Alpha desk"));

		// B asks while A holds: it waits, and its eval card says so.
		const second = await openTab();
		await nameTab(second, "Beta desk");
		const input = page.locator("textarea").first();
		await input.fill("fixture desktop acting");
		await input.press("Enter");
		await expect(indicatorText()).toHaveText(text.busyWaiting("Alpha desk", 1));
		// The run sits in the steps group, which opens on a click.
		await page.locator(".omp-execution-group-header").last().click();
		await expect(page.locator("[data-desktop-slot-waiting]")).toHaveAttribute("data-desktop-slot-waiting", "1");
		await expect(page.locator("[data-desktop-slot-waiting]")).toHaveText(text.waiting(1));
		expect(await slotSequence()).toEqual(["grant:free"]);

		// A lets go: main grants B (the run waited), the indicator turns to B, B's card stops waiting.
		await promptTab(first, "fixture desktop done");
		await expect(indicatorText()).toHaveText(text.busy("Beta desk"));
		await expect(page.locator("[data-desktop-slot-waiting]")).toHaveCount(0);
		await expect.poll(slotSequence).toEqual(["grant:free", "grant:waited"]);

		// B lets go: nobody is left, the indicator goes.
		await promptTab(second, "fixture desktop done");
		await expect(page.locator("[data-desktop-slot-indicator]")).toHaveCount(0);
		expect(errors).toEqual([]);
	});
}

test("Stop on the indicator revokes the holder, then hands the screen to the waiting session", async () => {
	await launch("en");
	const text = TEXT.en;
	const first = await activeTab();
	await nameTab(first, "Alpha desk");
	await promptTab(first, "fixture desktop acting");
	await expect(indicatorText()).toHaveText(text.busy("Alpha desk"));

	const second = await openTab();
	await nameTab(second, "Beta desk");
	const input = page.locator("textarea").first();
	await input.fill("fixture desktop acting");
	await input.press("Enter");
	await expect(indicatorText()).toHaveText(text.busyWaiting("Alpha desk", 1));

	await page.locator("[data-desktop-slot-stop]").click();

	// The holder is revoked and answers after its delay; only then is B granted, and the screen shows B.
	await expect(indicatorText()).toHaveText(text.busy("Beta desk"));
	await expect
		.poll(slotSequence)
		.toEqual(["grant:free", "desktop_slot.revoke", "desktop_slot.revoke_answered", "grant:waited"]);
	await expect(page.locator("[data-desktop-slot-waiting]")).toHaveCount(0);
	// Stop also aborted A's own run.
	const aborts = (await readRecords(record)).filter(entry => entry.type === "abort");
	expect(aborts.length).toBeGreaterThan(0);

	await promptTab(second, "fixture desktop done");
	await expect(page.locator("[data-desktop-slot-indicator]")).toHaveCount(0);
	expect(errors).toEqual([]);
});
