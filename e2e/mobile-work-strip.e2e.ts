/**
 * The phone's work strip (WorkBoardChip: the status line under the header that stands in for the work board where it
 * cannot dock) on the built app's real web page behind the fake `tailscale serve`: a running turn's todos and
 * subagents in a tab of the phone's own and in a session a desktop window of this computer holds, which the phone
 * views (multi-viewer); and an idle desktop session whose agent opened a session that still works, which the phone
 * views (the child is a tab of the desktop window, not the phone's). A host's session is covered in
 * mobile-remote-session.e2e.ts; the rows are component-tested in WorkBoardChip.test.tsx. WebKit as an iPhone 15,
 * Chromium as a Pixel 8.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type BrowserType, chromium, devices, expect, type Page, test, webkit } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { fixtureTailscale } from "./fixture/fake-tailscale-install";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { controlToolCaller, exitApp, fixtureOmp, openedSessions, variants } from "./harness";

const ENGINES = variants([
	{ name: "webkit", type: webkit as BrowserType, device: devices["iPhone 15"] },
	{ name: "chromium", type: chromium as BrowserType, device: devices["Pixel 8"] },
]);

async function fixture(page: Page, tabId: string, line: string): Promise<void> {
	const response = await page.evaluate(
		([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }),
		[tabId, line] as const,
	);
	expect(response.success, JSON.stringify(response)).toBe(true);
}

for (const engine of ENGINES)
	test(`the phone's work strip shows a running turn's todos and subagents, in its own tab and in a session the desktop holds (${engine.name})`, async () => {
		test.setTimeout(240_000);
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-work-strip-")));
		const project = path.join(root, "project");
		const desktop = path.join(root, "desktop");
		const agent = path.join(root, "agent");
		await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language: "en", themeName: "light", firstRunComplete: true, lastProject: project }),
		);
		const tailscale = await fixtureTailscale(root, { backendState: "Running" });
		const record = path.join(root, "omp-received.jsonl");
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
		Object.assign(env, {
			PI_CODING_AGENT_DIR: agent,
			PI_CONFIG_DIR: path.relative(os.homedir(), root),
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OMP_GUI_OMP: await fixtureOmp(root),
			OMP_GUI_TEST_SESSION_FILES: "1",
			OMP_GUI_TEST_RECORD: record,
			...tailscale.env,
		});
		Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
		let app: ElectronApplication | null = null;
		let proxy: ServeProxy | null = null;
		const browser = await engine.type.launch();
		try {
			app = await electron.launch({
				args: [path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"), `--user-data-dir=${desktop}`],
				env,
			});
			const desk = await app.firstWindow();
			await desk.waitForFunction(() => window.omp?.rpc != null);
			await desk.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
			await expect
				.poll(() => desk.evaluate(async () => (await window.omp.mobileWeb.getState()).phase), { timeout: 60_000 })
				.toBe("ready");
			await expect.poll(() => serveSites(tailscale).length, { timeout: 30_000 }).toBeGreaterThan(0);
			const site = serveSites(tailscale).at(-1);
			if (!site) throw new Error("serve publishes no handler");
			proxy = await ServeProxy.start(site, "seuput@example.com", undefined, {
				plainCookie: engine.name === "webkit",
			});

			const context = await browser.newContext({ ...engine.device });
			const phone = await context.newPage();
			await phone.goto(`${proxy.url}/`);
			await phonePaired(phone);
			await phone.evaluate(cwd => window.omp.tabs.spawn({ cwd, kind: "agent" }), project);
			await phone.reload();
			await expect(phone.locator("[data-composer-input]").first()).toBeEditable({ timeout: 60_000 });
			const strip = phone.locator("[data-work-strip] [data-work-chip]");

			// (a) The phone's own tab: a running turn sent from its composer, then its todos and subagents.
			await phone.locator("[data-composer-input]").first().fill("fixture steer work");
			await phone.locator(".omp-composer-box").getByRole("button", { name: "Send", exact: true }).tap();
			await expect(strip).toBeVisible({ timeout: 20_000 });
			// The composer takes a message while omp still starts (tab-ready-gate); the fixture commands need it up.
			let own = "";
			await expect
				.poll(
					async () => {
						const tabs = await phone.evaluate(() => window.omp.tabs.list());
						own = tabs.find(tab => tab.active && tab.status === "running")?.tabId ?? "";
						return own;
					},
					{ timeout: 60_000 },
				)
				.not.toBe("");
			await fixture(phone, own, "fixture:todo");
			await fixture(phone, own, "fixture:subagents");
			await expect(strip).toContainText("0/6");
			await expect(strip.locator('[data-count="agents"]')).toBeVisible();
			await phone.evaluate(
				id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:steer-finish" }),
				own,
			);

			// (b) A session a desktop window of this computer holds, which the phone views.
			const deskTab = await desk.evaluate(
				async cwd => (await window.omp.tabs.spawn({ cwd, kind: "agent" }))?.tabId,
				project,
			);
			if (!deskTab) throw new Error("no desktop tab");
			await desk.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "hello" }), deskTab);
			let deskSession: string | undefined;
			await expect
				.poll(
					async () => {
						const tabs = await desk.evaluate(() => window.omp.tabs.list());
						deskSession = tabs.find(tab => tab.tabId === deskTab)?.sessionPath ?? undefined;
						return deskSession;
					},
					{ timeout: 30_000 },
				)
				.toBeTruthy();
			// The phone opens it as a drawer row's tap does: a web window's spawn of a session a desktop window holds
			// views that tab.
			const viewed = await phone.evaluate(
				([cwd, sessionPath]) => window.omp.tabs.spawn({ cwd, kind: "agent", sessionPath }),
				[project, deskSession ?? ""] as const,
			);
			if (!viewed?.tabId) throw new Error(`the phone could not view it: ${JSON.stringify(viewed)}`);
			// As a tapped notification about it opens it (web-boot's `#/open?tab=`).
			await phone.goto(`${proxy.url}/#/open?tab=${viewed.tabId}`);
			await expect(phone.locator("[data-composer-input]").first()).toBeEditable({ timeout: 60_000 });
			await expect
				.poll(async () => (await phone.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.sessionPath)
				.toBe(deskSession);
			await desk.evaluate(
				id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture steer work" }),
				deskTab,
			);
			await expect(strip).toBeVisible({ timeout: 20_000 });
			await fixture(desk, deskTab, "fixture:todo");
			await fixture(desk, deskTab, "fixture:subagents");
			await expect(strip).toContainText("0/6");
			await expect(strip.locator('[data-count="agents"]')).toBeVisible();

			// (c) An idle desktop session whose agent opened a session that still works: the strip counts it.
			const opener = await desk.evaluate(
				async cwd => (await window.omp.tabs.spawn({ cwd, kind: "agent" }))?.tabId,
				project,
			);
			if (!opener) throw new Error("no opener tab");
			await expect
				.poll(
					async () =>
						(await desk.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === opener)?.status,
					{
						timeout: 60_000,
					},
				)
				.toBe("ready");
			await desk.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "hello" }), opener);
			await expect
				.poll(
					async () =>
						(await desk.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === opener)?.lastRun?.reply,
					{ timeout: 30_000 },
				)
				.toBe("Local fixture reply");
			const call = await controlToolCaller(desk, record, opener);
			const open = await call("ompdesk_session_open", { message: "Fix the upload" });
			expect(open.isError, open.text).toBe(false);
			const [child] = openedSessions(open.text);
			if (!child) throw new Error(open.text);
			// The brief comes wrapped as an agent message, which the fake answers at once: a second message runs.
			await expect
				.poll(
					async () =>
						(await desk.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === child)?.lastRun?.reply,
					{
						timeout: 30_000,
					},
				)
				.toBe("Local fixture reply");
			await desk.evaluate(
				id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture steer work" }),
				child,
			);
			const openerSession = (await desk.evaluate(() => window.omp.tabs.list())).find(
				tab => tab.tabId === opener,
			)?.sessionPath;
			const viewedOpener = await phone.evaluate(
				([cwd, sessionPath]) => window.omp.tabs.spawn({ cwd, kind: "agent", sessionPath }),
				[project, openerSession ?? ""] as const,
			);
			if (!viewedOpener?.tabId) throw new Error("the phone could not view the opener");
			await phone.goto(`${proxy.url}/#/open?tab=${viewedOpener.tabId}`);
			await expect(phone.locator("[data-composer-input]").first()).toBeEditable({ timeout: 60_000 });
			const phoneTabs = async () =>
				(await phone.evaluate(() => window.omp.tabs.list())).map(tab => ({
					id: tab.tabId,
					active: tab.active,
					path: tab.sessionPath,
					title: tab.title,
				}));
			await expect
				.poll(async () => (await phoneTabs()).find(tab => tab.active)?.path, {
					message: JSON.stringify({ openerSession, viewed: viewedOpener.tabId, tabs: await phoneTabs() }),
				})
				.toBe(openerSession);
			await expect(strip)
				.toBeVisible({ timeout: 20_000 })
				.catch(async error => {
					const active = (await phoneTabs()).find(tab => tab.active)?.id ?? "";
					const review = await phone.evaluate(
						id => window.omp.rpc.commandForTab(id, { type: "agent_control_review" }),
						active,
					);
					const deskTabs = (await desk.evaluate(() => window.omp.tabs.list())).map(t => [
						t.tabId,
						t.status,
						t.openedBy,
					]);
					throw new Error(`${JSON.stringify({ active, opener, open: open.text, review, deskTabs })} ${error}`);
				});
			await expect(strip.locator('[data-count="sessions"]')).toHaveText("1");
		} finally {
			await browser.close().catch(() => undefined);
			await proxy?.close().catch(() => undefined);
			if (app) await exitApp(app).catch(() => undefined);
			await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
		}
	});
