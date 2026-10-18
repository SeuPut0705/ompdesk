import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { captureTo, exitApp, launchApp, recordsOfType } from "./harness";

// Two windows view one tab (the multi-viewer model the paired web devices use, here on two Electron windows through
// the test hook OMP_GUI_TEST_VIEWER_WINDOWS=1): the first answer to a card wins and the other window's card closes
// with a notice, a prompt sent from the other window is delivered once and is never taken for this window's own echo,
// each window keeps its own draft, and a finished run raises one desktop notification, not one per window.
// OMP_GUI_MOBILE_CAPTURES=<dir> also writes the captures.

const captures = process.env.OMP_GUI_MOBILE_CAPTURES;

let app: ElectronApplication;
let profile: string;
let record: string;
let a: Page;
let b: Page;
const errors: string[] = [];

interface Shown {
	title: string;
	body?: string;
}

const composer = (page: Page): Locator => page.locator(".omp-composer-input").first();
const userBubbles = (page: Page): Locator => page.locator(".omp-user-bubble");
const viewersChip = (page: Page): Locator => page.locator("[data-viewers-chip]");

async function send(page: Page, text: string): Promise<void> {
	await composer(page).fill(text);
	await composer(page).press("Enter");
}

async function idle(page: Page): Promise<void> {
	await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0, { timeout: 30_000 });
}

function shown(): Promise<Shown[]> {
	return app.evaluate(() => (globalThis as typeof globalThis & { __shown?: Shown[] }).__shown ?? []);
}

test.beforeAll(async () => {
	test.setTimeout(180_000);
	profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-viewers-")));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	record = path.join(profile, "rpc.jsonl");
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", firstRunComplete: true, lastProject: project }),
	);
	app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: {
			OMP_GUI_TEST_RECORD: record,
			// The shared session needs a file to be found by.
			OMP_GUI_TEST_SESSION_FILES: "1",
			OMP_GUI_TEST_VIEWER_WINDOWS: "1",
		},
	});
	a = await app.firstWindow();
	a.on("pageerror", error => errors.push(error.message));
	await a.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await a.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 760));
	// Count the desktop notifications main would show instead of showing them: everything above the dedupe in the
	// SYSTEM_NOTIFY handler stays real.
	await app.evaluate(({ Notification }) => {
		const sink: Shown[] = [];
		Reflect.set(globalThis, "__shown", sink);
		Notification.prototype.show = function show(this: { title: string; body: string }) {
			sink.push({ title: this.title, body: this.body });
		};
	});
});

test.afterAll(async () => {
	if (app) await exitApp(app);
	if (record) await fs.copyFile(record, test.info().outputPath("rpc.jsonl")).catch(() => {});
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("two windows view one tab: echo, first answer wins, drafts, one notification", async () => {
	test.setTimeout(180_000);

	// Window A owns the session; one finished turn gives it a file the second window can open.
	await send(a, "first turn");
	await expect(userBubbles(a)).toHaveCount(1);
	await idle(a);
	const tab = await a.evaluate(async () => {
		const active = (await window.omp.tabs.list()).find(entry => entry.active);
		if (!active) throw new Error("No active tab");
		const state = await window.omp.rpc.commandForTab(active.tabId, { type: "get_state" });
		return { tabId: active.tabId, cwd: active.cwd, file: (state.data as { sessionFile?: string }).sessionFile };
	});
	if (!tab.file) throw new Error("The fake omp wrote no session file");

	// Window B (its own tab, its own omp) opens the same session: it attaches as a viewer.
	expect(await a.evaluate(() => window.omp.sessions.openInNewWindow({}))).toBe(true);
	await expect.poll(() => app.windows().length, { timeout: 30_000 }).toBe(2);
	const second = app.windows().find(page => page !== a);
	if (!second) throw new Error("The second window has no page");
	b = second;
	b.on("pageerror", error => errors.push(error.message));
	await b.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await b.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[1]?.setContentSize(1100, 760));
	const spawned = await b.evaluate(([cwd, sessionPath]) => window.omp.tabs.spawn({ cwd, sessionPath }), [
		tab.cwd,
		tab.file,
	] as const);
	expect(spawned).toMatchObject({ tabId: tab.tabId, attached: true });

	// Both windows say the tab is open elsewhere too, and B can switch to it.
	await expect(viewersChip(a)).toHaveAttribute("data-viewers-count", "1");
	const row = b.locator(`[data-session-path="${tab.file}"], [data-session-path="tab:${tab.tabId}"]`).first();
	await row.locator("button[data-roving-item]").click();
	await expect(viewersChip(b)).toHaveAttribute("data-viewers-count", "1");
	await expect(userBubbles(b)).toHaveCount(1);
	// Under each composer one quiet line says the tab is shared, in the chip's words.
	await expect(a.locator("[data-composer-shared]")).toHaveText("Shared with 1 other device");
	await expect(b.locator("[data-composer-shared]")).toHaveText("Shared with 1 other device");
	await captureTo(captures, a, "viewers-a-chip");
	await captureTo(captures, b, "viewers-b-chip");

	// Echo: B's prompt is B's own echo there, delivered once, and in A it is another viewer's message — not absorbed.
	await send(b, "bravo says hi");
	await expect(userBubbles(b).filter({ hasText: "bravo says hi" })).toHaveCount(1);
	await expect(userBubbles(a).filter({ hasText: "bravo says hi" })).toHaveCount(1);
	await expect(userBubbles(a).filter({ hasText: "bravo says hi" }).locator("[data-prompt-from]")).toHaveText(
		"from another device",
	);
	await expect(userBubbles(b).filter({ hasText: "bravo says hi" }).locator("[data-prompt-from]")).toHaveCount(0);
	await idle(a);
	await idle(b);
	await send(a, "alpha says hi");
	await expect(userBubbles(a).filter({ hasText: "alpha says hi" })).toHaveCount(1);
	await expect(userBubbles(b).filter({ hasText: "alpha says hi" })).toHaveCount(1);
	await expect(userBubbles(b).filter({ hasText: "alpha says hi" }).locator("[data-prompt-from]")).toHaveText(
		"from another device",
	);
	await expect(userBubbles(a).filter({ hasText: "alpha says hi" }).locator("[data-prompt-from]")).toHaveCount(0);
	await expect(userBubbles(a)).toHaveCount(3);
	await expect(userBubbles(b)).toHaveCount(3);
	await idle(a);
	await idle(b);
	await captureTo(captures, b, "viewers-b-echo");

	// Who typed what, as each window reads the journal: its own prompts carry no label, the other window's name its device.
	const labelsSeenBy = (page: Page) =>
		page.evaluate(async tabId => {
			const response = await window.omp.rpc.commandForTab(tabId, {
				type: "get_transcript_page",
				limit: 50,
				fromEnd: true,
			});
			const messages = (
				response.data as { messages: Array<{ role: string; content: unknown; promptFrom?: string }> }
			).messages;
			return messages
				.filter(message => message.role === "user")
				.map(message => ({
					text: JSON.stringify(message.content).replace(/^.*?"text":"([^"]*)".*$/, "$1"),
					from: message.promptFrom ?? null,
				}));
		}, tab.tabId);
	const seenByA = await labelsSeenBy(a);
	const seenByB = await labelsSeenBy(b);
	expect(seenByA.map(entry => entry.text)).toEqual(["first turn", "bravo says hi", "alpha says hi"]);
	expect(seenByA.map(entry => entry.from)).toEqual([null, expect.stringMatching(/^Window \d+$/), null]);
	expect(seenByB.map(entry => entry.from)).toEqual([
		expect.stringMatching(/^Window \d+$/),
		null,
		expect.stringMatching(/^Window \d+$/),
	]);
	expect(seenByB[0]?.from).toBe(seenByB[2]?.from);
	expect(seenByB[0]?.from).not.toBe(seenByA[1]?.from);

	// First answer wins: both windows show the card, A answers, B's card closes with the notice.
	await send(b, "fixture approval");
	const cardA = a.locator("[data-prompt-card]");
	const cardB = b.locator("[data-prompt-card]");
	await expect(cardA).toBeVisible();
	await expect(cardB).toBeVisible();
	await captureTo(captures, b, "viewers-b-card");
	await cardA.getByRole("button", { name: "Approve", exact: true }).click();
	await expect(cardA).toHaveCount(0);
	await expect(cardB).toHaveCount(0);
	await expect(b.getByText("Answered on another device.")).toBeVisible();
	await expect(a.getByText("Answered on another device.")).toHaveCount(0);
	await captureTo(captures, b, "viewers-b-answered-elsewhere");
	// A second answer, sent late, is refused with its own error code and reaches no omp.
	const late = await b.evaluate(async tabId => {
		try {
			await window.omp.ui.respondExtensionUi(
				{ type: "extension_ui_response", id: "approval", value: "Deny" },
				tabId,
			);
			return "accepted";
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}, tab.tabId);
	expect(late).toContain("already_answered");
	expect((await recordsOfType(record, "extension_ui_response")).filter(entry => entry.id === "approval")).toHaveLength(
		1,
	);
	await idle(a);
	await idle(b);

	// Drafts stay per window while the tab moves on underneath them.
	await composer(a).fill("draft in A");
	await composer(b).fill("draft in B");
	await b.evaluate(() => window.omp.rpc.prompt("from the API"));
	await expect(userBubbles(a).filter({ hasText: "from the API" })).toHaveCount(1);
	await expect(userBubbles(b).filter({ hasText: "from the API" })).toHaveCount(1);
	await idle(a);
	await idle(b);
	await expect(composer(a)).toHaveValue("draft in A");
	await expect(composer(b)).toHaveValue("draft in B");
	await captureTo(captures, a, "viewers-a-drafts");
	await captureTo(captures, b, "viewers-b-drafts");

	// One notification for a run that finished while neither window had the focus.
	for (const page of [a, b]) await page.evaluate(() => (document.hasFocus = () => false));
	await app.evaluate(() => {
		(globalThis as typeof globalThis & { __shown?: Shown[] }).__shown?.splice(0);
	});
	await b.evaluate(() => window.omp.rpc.prompt("notify once"));
	await expect.poll(async () => (await shown()).length, { timeout: 15_000 }).toBe(1);
	await a.waitForTimeout(2500);
	expect(await shown()).toHaveLength(1);

	expect(errors).toEqual([]);
});
