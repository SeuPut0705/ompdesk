/**
 * A phone's web page viewing a desktop window's session whose agent opened two sessions that still work (the user's
 * phone and iPad reports on v0.42.0: "병렬세션이 안보임", and no working light on the opener). The opened sessions are
 * tabs of the desktop window, not the page's, so the page knows them only from main's review list: the phone's
 * sidebar must still nest both under the opener as running rows, light the idle opener's row, and a tap on a child
 * views the desktop's tab (multi-viewer) instead of starting a second omp on its file. The rules for a window that
 * holds the children, and for a tablet, are component-tested in Sidebar.test.tsx ("Sidebar families").
 * `OMP_GUI_VIEWER_FAMILY=<dir>` writes the phone captures (the first before any assertion).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, devices, expect, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { fixtureTailscale } from "./fixture/fake-tailscale-install";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { captureTo, controlToolCaller, cssString, exitApp, fixtureOmp, openedSessions } from "./harness";

const CAPTURES = process.env.OMP_GUI_VIEWER_FAMILY;

test("a phone viewing a desktop's session lists the sessions its agent opened, running, and lights the opener", async () => {
	test.setTimeout(240_000);
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-viewer-family-")));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", themeName: "dark", firstRunComplete: true, lastProject: project }),
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
	const browser = await chromium.launch();
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
		proxy = await ServeProxy.start(site, "seuput@example.com");

		// An idle desktop session whose agent opened two sessions that still work.
		const deskTabs = () => desk.evaluate(() => window.omp.tabs.list());
		const opener = await desk.evaluate(
			async cwd => (await window.omp.tabs.spawn({ cwd, kind: "agent" }))?.tabId,
			project,
		);
		if (!opener) throw new Error("no opener tab");
		await expect
			.poll(async () => (await deskTabs()).find(tab => tab.tabId === opener)?.status, { timeout: 60_000 })
			.toBe("ready");
		await desk.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "hello" }), opener);
		await expect
			.poll(async () => (await deskTabs()).find(tab => tab.tabId === opener)?.lastRun?.reply, { timeout: 30_000 })
			.toBe("Local fixture reply");
		const call = await controlToolCaller(desk, record, opener);
		const children: string[] = [];
		for (const title of ["Fix the upload", "Tidy the docs"]) {
			const open = await call("ompdesk_session_open", { message: `Title: ${title}\nDetails follow.` });
			expect(open.isError, open.text).toBe(false);
			const [child] = openedSessions(open.text);
			if (!child) throw new Error(open.text);
			children.push(child);
			// The brief comes wrapped as an agent message, which the fake answers at once; then a turn that keeps working.
			await expect
				.poll(async () => (await deskTabs()).find(tab => tab.tabId === child)?.lastRun?.reply, {
					timeout: 30_000,
				})
				.toBe("Local fixture reply");
			await desk.evaluate(
				id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture steer work" }),
				child,
			);
			await expect
				.poll(async () => (await deskTabs()).find(tab => tab.tabId === child)?.status, { timeout: 30_000 })
				.toBe("running");
		}
		const before = await deskTabs();
		const openerSession = before.find(tab => tab.tabId === opener)?.sessionPath ?? "";
		const childSessions = children.map(id => before.find(tab => tab.tabId === id)?.sessionPath ?? "");
		expect(openerSession).not.toBe("");
		expect(childSessions).not.toContain("");

		// The phone views the opener, as a drawer row's tap does; the children stay tabs of the desktop window.
		const context = await browser.newContext({ ...devices["Pixel 8"] });
		const phone = await context.newPage();
		await phone.goto(`${proxy.url}/`);
		await phonePaired(phone);
		const viewed = await phone.evaluate(
			([cwd, sessionPath]) => window.omp.tabs.spawn({ cwd, kind: "agent", sessionPath }),
			[project, openerSession] as const,
		);
		if (!viewed?.tabId) throw new Error(`the phone could not view the opener: ${JSON.stringify(viewed)}`);
		await phone.goto(`${proxy.url}/#/open?tab=${viewed.tabId}`);
		await expect(phone.locator("[data-composer-input]").first()).toBeEditable({ timeout: 60_000 });
		const phoneTabs = () => phone.evaluate(() => window.omp.tabs.list());
		expect((await phoneTabs()).some(tab => children.includes(tab.tabId))).toBe(false);
		// The work strip counting both (52ed702f) says the page settled on the opener with main's list in hand; a drawer
		// opened before that is closed again by the page's own switch to the tab.
		await expect(phone.locator('[data-work-strip] [data-work-chip] [data-count="sessions"]')).toHaveText("2", {
			timeout: 20_000,
		});
		await phone.locator("header button:has(svg.lucide-menu)").click();
		const sidebar = phone.locator("[data-drawer] .omp-session-sidebar");
		const openerRow = sidebar.locator(`.omp-sidebar-session-row[data-session-path=${cssString(openerSession)}]`);
		await expect(openerRow).toBeVisible({ timeout: 30_000 });
		if (CAPTURES) {
			// Taken before the assertions, so a build without the fix leaves its picture too.
			await phone.waitForTimeout(1500);
			await captureTo(CAPTURES, phone, "phone-drawer");
		}
		// The idle opener wears the background light; its family counts both children as running.
		await expect(openerRow.locator(".omp-live-edge")).toHaveAttribute("data-live-edge", "background", {
			timeout: 20_000,
		});
		const chip = openerRow.locator("[data-family-running]");
		await expect(chip).toHaveAttribute("data-family-running", "2");
		await chip.click();
		const family = sidebar.locator(`[data-sidebar-family=${cssString(openerSession)}]`);
		for (const childSession of childSessions)
			await expect(
				family.locator(`[data-sidebar-opened-session][data-session-path=${cssString(childSession)}]`),
			).toHaveAttribute("data-child-status", "running");
		await captureTo(CAPTURES, phone, "phone-drawer-unfolded");

		// A tap views the desktop's tab: the same tab, no second omp on its file.
		await family
			.locator(`[data-sidebar-opened-session][data-session-path=${cssString(childSessions[0])}] button`)
			.first()
			.click();
		await expect
			.poll(async () => (await phoneTabs()).find(tab => tab.active)?.sessionPath, { timeout: 30_000 })
			.toBe(childSessions[0]);
		expect((await phoneTabs()).find(tab => tab.active)?.tabId).toBe(children[0]);
		expect((await deskTabs()).length).toBe(before.length);
	} finally {
		await browser.close().catch(() => undefined);
		await proxy?.close().catch(() => undefined);
		if (app) await exitApp(app).catch(() => undefined);
		await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
	}
});
