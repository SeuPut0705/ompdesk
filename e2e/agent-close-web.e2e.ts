/**
 * An agent closes a child tab a paired phone page owns (`ompdesk_session_stop {close:true}`, src/main/agent-control
 * `#closeTab`): main releases it itself, because the page's `AGENT_CONTROL_VIEW` is dropped while it has no socket.
 * It does so for any tab whose page did not report unsaved edits in it (`FileEditReporter` → `FILE_EDIT_REPORT`, `web/
 * file-edit-reports.ts`): a page that is offline, or has said nothing since this launch, is released at once with one
 * close note; only a tab the page's latest report names as holding unsaved Files edits stays. The built app runs
 * on the fake omp and the fake Tailscale CLI; the phone is the app's real `web.html` in Chromium behind the fake
 * serve (e2e/fixture/phone-serve.ts), the agent is the fake omp's `fixture:host-tool:` line.
 *
 * Unit counterparts: `service.test.ts` ("a close is told only once the tab is gone", "closing a tab a paired web page
 * owns"), `host.test.ts`, `tab-release.test.ts`, `web/file-edit-reports.test.ts`, `FileEditReporter.test.tsx`.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Browser, type BrowserContext, chromium, devices, expect, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { _electron as electron } from "playwright";
import { type FixtureTailscale, fixtureTailscale } from "./fixture/fake-tailscale-install";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { appLaunchOptions, controlToolCaller, exitApp, openedSessions, readRecords, untilAnswered } from "./harness";

/** A control tool called by an agent (`controlToolCaller`). */
type ControlCall = (name: string, args?: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;

interface Profile {
	root: string;
	project: string;
	desktop: string;
	agent: string;
	record: string;
	tailscale: FixtureTailscale;
}

let profile: Profile;
let app: ElectronApplication | null = null;
let browser: Browser | null = null;
let proxy: ServeProxy | null = null;
let context: BrowserContext | null = null;

test.beforeEach(async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-close-web-")));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(project, "README.md"), "hello\n");
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", themeName: "light", firstRunComplete: true, lastProject: project }),
	);
	profile = {
		root,
		project,
		desktop,
		agent,
		record: path.join(root, "rpc.jsonl"),
		tailscale: await fixtureTailscale(root, { backendState: "Running" }),
	};
});

test.afterEach(async () => {
	await context?.close().catch(() => undefined);
	await browser?.close().catch(() => undefined);
	await proxy?.close().catch(() => undefined);
	if (app) await exitApp(app);
	app = null;
	browser = null;
	proxy = null;
	context = null;
	if (profile) {
		await fs.copyFile(profile.record, test.info().outputPath("rpc.jsonl")).catch(() => undefined);
		await fs.rm(profile.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

/** Launch on the profile's userData with no argv cwd, so a relaunch restores what the last run saved. */
async function launch(): Promise<Page> {
	const options = await appLaunchOptions({
		project: profile.project,
		desktop: profile.desktop,
		agent: profile.agent,
		profile: profile.root,
		env: {
			...profile.tailscale.env,
			OMP_GUI_HEADLESS: "1",
			OMP_GUI_TEST_RECORD: profile.record,
			OMP_GUI_TEST_SESSION_FILES: "1",
		},
	});
	app = await electron.launch(options);
	const page = await app.firstWindow();
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
	return page;
}

async function mobileWebReady(page: Page): Promise<void> {
	await expect
		.poll(() => page.evaluate(async () => (await window.omp.mobileWeb.getState()).phase).catch(() => "starting"), {
			timeout: 60_000,
		})
		.toBe("ready");
}

/** The phone's page, paired. With `tab`, it opens a session tab in the project first. */
async function openPhone(desktop: Page, options: { spawn: boolean }): Promise<Page> {
	await desktop.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
	await mobileWebReady(desktop);
	const [site] = serveSites(profile.tailscale);
	if (!site) throw new Error("no serve handler published");
	proxy = await ServeProxy.start(site, "seuput@example.com");
	browser = await chromium.launch();
	context = await browser.newContext({ ...devices["Pixel 7"], colorScheme: "light" });
	const phone = await context.newPage();
	await phone.goto(`${proxy.url}/`);
	await phonePaired(phone);
	if (options.spawn) {
		// A web window starts with no tab: the phone opens one in the project.
		await phone.evaluate(cwd => window.omp.tabs.spawn({ cwd, kind: "agent" }), profile.project);
		await phone.reload();
		await expect(phone.locator("[data-composer-input]").first()).toBeVisible({ timeout: 60_000 });
	}
	return phone;
}

function phoneTabs(phone: Page) {
	return phone.evaluate(() => window.omp.tabs.list());
}

/**
 * The close notes the caller's omp got (`agent_control.mail`, id `close:…`), the closed session's own aside, once per
 * id: the outbox sends a report again until the receiver's journal holds it, and the receiver drops a repeated id.
 */
async function closeNotes(): Promise<string[]> {
	const notes = new Map<string, string>();
	for (const frame of await readRecords(profile.record)) {
		const details = (frame.details ?? {}) as { id?: unknown };
		if (
			frame.type === "agent_control.mail" &&
			typeof details.id === "string" &&
			details.id.startsWith("close:") &&
			/^(Closed|Deleted) /.test(String(frame.content))
		)
			notes.set(details.id, String(frame.content));
	}
	return [...notes.values()];
}

/** Open a child from `call` (the phone session's agent) and wait for its brief's reply. */
async function openChild(phone: Page, call: ControlCall, title: string): Promise<string> {
	const opened = await call("ompdesk_session_open", { message: `Title: ${title}\nSay hello`, show: "background" });
	expect(opened.isError, opened.text).toBe(false);
	const [child] = openedSessions(opened.text);
	expect(child).toBeTruthy();
	await untilAnswered(phone, child as string);
	return child as string;
}

test("an agent's close of a child the phone page owns releases it when clean, keeps it with unsaved Files edits", async () => {
	test.setTimeout(240_000);
	const desktop = await launch();
	const phone = await openPhone(desktop, { spawn: true });
	const main = (await phoneTabs(phone)).find(tab => tab.active)?.tabId ?? "";
	expect(main).not.toBe("");
	const call = await controlToolCaller(phone, profile.record, main);

	// 1. A clean page: the tab is released in main and gone from the page, the caller is told "Closed" once.
	const clean = await openChild(phone, call, "Child clean");
	expect((await phoneTabs(phone)).map(tab => tab.tabId)).toContain(clean);
	const closed = await call("ompdesk_session_stop", { session: clean, close: true });
	expect(closed.isError, closed.text).toBe(false);
	expect(closed.text).toMatch(/^Closed .*\(its session stays saved\)\./);
	await expect.poll(async () => (await phoneTabs(phone)).map(tab => tab.tabId)).not.toContain(clean);
	expect((await call("ompdesk_sessions", { scope: "app" })).text).not.toContain(`[${clean}]`);
	await expect.poll(async () => (await closeNotes()).length, { timeout: 15_000 }).toBe(1);
	// Nothing sends a second note later.
	await phone.waitForTimeout(1500);
	expect(await closeNotes()).toHaveLength(1);

	// 2. The child's Files editor on the page holds an unsaved edit: the close is refused, naming it, and sends no note.
	const dirty = await openChild(phone, call, "Child dirty");
	const focused = await call("ompdesk_tab_focus", { session: dirty });
	expect(focused.isError, focused.text).toBe(false);
	await expect.poll(async () => (await phoneTabs(phone)).find(tab => tab.active)?.tabId).toBe(dirty);
	const sheet = phone.locator("[data-sheet-panel]").or(phone.locator(":has(> .omp-panel-topbar)")).first();
	if (!(await sheet.isVisible().catch(() => false))) await phone.locator('[data-tour="panel"]').tap();
	await expect(sheet).toBeVisible();
	await phone.locator("[data-panel-tabbar]").getByRole("button", { name: "Files", exact: true }).tap();
	await sheet.getByRole("treeitem", { name: /README\.md/ }).tap();
	await sheet.getByRole("button", { name: "Edit", exact: true }).tap();
	const editor = sheet.locator("[data-file-editor] [contenteditable], [data-file-editor] textarea").first();
	await expect(editor).toBeVisible();
	await editor.click();
	await phone.keyboard.press("ControlOrMeta+End");
	await phone.keyboard.type("unsaved edit\n");
	await expect(sheet.locator("[data-editor-status]")).toHaveText("Unsaved");
	// The person's view goes back to the caller (the panel stays on the child while its edits are unsaved): a tab in
	// view is refused for that reason before the page's word is read.
	expect((await call("ompdesk_tab_focus", { session: main })).isError).toBe(false);
	await expect.poll(async () => (await phoneTabs(phone)).find(tab => tab.active)?.tabId).toBe(main);
	await expect(sheet.locator("[data-editor-status]")).toHaveText("Unsaved");
	const notesBefore = (await closeNotes()).length;
	// The page's report reaches main a moment after the edit: the close is refused whatever the timing after it.
	const refused = await (async () => {
		let last = await call("ompdesk_session_stop", { session: dirty, close: true });
		for (let tries = 0; tries < 10 && !last.isError; tries++) {
			await phone.waitForTimeout(300);
			last = await call("ompdesk_session_stop", { session: dirty, close: true });
		}
		return last;
	})();
	expect(refused.isError, refused.text).toBe(true);
	expect(refused.text).toContain("unsaved edits");
	expect(refused.text).toContain("Files editor");
	expect((await phoneTabs(phone)).map(tab => tab.tabId)).toContain(dirty);
	expect((await call("ompdesk_sessions", { scope: "app" })).text).toContain(dirty);
	await phone.waitForTimeout(1000);
	expect((await closeNotes()).length).toBe(notesBefore);
});

test("a close asked while the phone page is away releases the child at once, with one note, and nothing waits for the page", async () => {
	test.setTimeout(300_000);
	let desktop = await launch();
	const phone = await openPhone(desktop, { spawn: true });
	const main = (await phoneTabs(phone)).find(tab => tab.active)?.tabId ?? "";
	const phoneCall = await controlToolCaller(phone, profile.record, main);
	await openChild(phone, phoneCall, "Child waits");
	expect(await phoneTabs(phone)).toHaveLength(2);

	// A plain socket drop, no restart: the page's last word (clean) is forgotten with its connection, and a session on
	// the computer's own window closes the child anyway.
	await openChild(phone, phoneCall, "Child dropped");
	expect(await phoneTabs(phone)).toHaveLength(3);
	const deskTab = (await desktop.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId ?? "";
	const dropCall = await controlToolCaller(desktop, profile.record, deskTab);
	await (context as BrowserContext).setOffline(true);
	(proxy as ServeProxy).dropSockets();
	await expect
		.poll(async () => (await dropCall("ompdesk_sessions", { scope: "app" })).text)
		.toContain("Child dropped");
	const dropNotes = (await closeNotes()).length;
	// The drop reaches main a moment after the proxy cut the socket; the close is at once whichever it saw.
	const dropped = await dropCall("ompdesk_session_stop", { session: "Child dropped", close: true });
	expect(dropped.isError, dropped.text).toBe(false);
	expect(dropped.text).toMatch(/^Closed /);
	expect(dropped.text).not.toContain("It will close when the phone page connects");
	expect((await dropCall("ompdesk_sessions", { scope: "app" })).text).not.toContain("Child dropped");
	await expect.poll(async () => (await closeNotes()).length, { timeout: 30_000 }).toBe(dropNotes + 1);
	await (context as BrowserContext).setOffline(false);
	await expect.poll(async () => (await phoneTabs(phone)).length, { timeout: 30_000 }).toBe(2);

	// The page goes away and the computer restarts: its tabs come back deferred in its window, and the page has
	// said nothing since this launch.
	await phone.close();
	await exitApp(app as ElectronApplication);
	app = null;
	desktop = await launch();
	await mobileWebReady(desktop);
	const [site] = serveSites(profile.tailscale);
	if (!site) throw new Error("no serve handler after the relaunch");
	(proxy as ServeProxy).retarget(site);

	// A session on the computer's own window closes the page's child: released at once, one note, no waiting.
	const desktopMain = (await desktop.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId ?? "";
	const deskCall = await controlToolCaller(desktop, profile.record, desktopMain);
	const listed = await deskCall("ompdesk_sessions", { scope: "app" });
	// Its tab id is new after the restart (the old one still names it); it is told apart by its title.
	expect(listed.text).toContain('"Child waits"');
	const notesBefore = (await closeNotes()).length;
	const asked = await deskCall("ompdesk_session_stop", { session: "Child waits", close: true });
	expect(asked.isError, asked.text).toBe(false);
	expect(asked.text).toMatch(/^Closed /);
	expect(asked.text).not.toContain("It will close when the phone page connects");
	expect((await deskCall("ompdesk_sessions", { scope: "app" })).text).not.toContain('"Child waits"');
	await expect.poll(async () => (await closeNotes()).length, { timeout: 30_000 }).toBe(notesBefore + 1);
	await desktop.waitForTimeout(1500);
	expect((await closeNotes()).length).toBe(notesBefore + 1);

	// The page comes back: it lists only its caller's tab, the child is gone for good.
	const back = await (context as BrowserContext).newPage();
	await back.goto(`${(proxy as ServeProxy).url}/`);
	await phonePaired(back);
	await expect.poll(async () => (await phoneTabs(back)).length).toBe(1);
	expect((await closeNotes()).length).toBe(notesBefore + 1);
});
