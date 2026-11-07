/**
 * A deleted session or project leaves every sidebar at once, with no click (the owner's report, 6 Nov 2026: deleted
 * rows and projects stayed until clicked). Two windows on the fake omp: one deletes through its sidebar (a session's
 * row, a whole project), main deletes one the way an agent's `ompdesk_session_stop {delete}` does, and the window
 * that did nothing loses each row by itself. `OMP_GUI_SIDEBAR_DELETE=<dir>` writes captures.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, devices, expect, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { captureTo, controlToolCaller, cssString, exitApp, fixtureOmp, openedSessions, untilAnswered } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, REMOTE_LOGIN, type RemoteInstance } from "./remote-harness";

const CAPTURES = process.env.OMP_GUI_SIDEBAR_DELETE;

const rowOf = (page: Page, file: string) =>
	page.locator(`.omp-session-sidebar .omp-sidebar-session-row[data-session-path=${cssString(file)}]`);
const groupOf = (page: Page, cwd: string) =>
	page.locator(`.omp-session-sidebar [data-workspace-group=${cssString(cwd)}]`);
/**
 * Opens a project's fold. The folds are one saved set every window reads when it opens (`useSidebarFolds.hydrate`), so
 * a window that opens or hydrates after another one's clicks starts with those projects already open, and a plain
 * click would fold them again. Click only a folded one, and look again until it is open.
 */
async function openProject(page: Page, name: string): Promise<void> {
	const fold = page.locator(".omp-session-sidebar").getByRole("button", { name, exact: true });
	await expect(async () => {
		if ((await fold.getAttribute("aria-expanded")) === "false") await fold.click();
		await expect(fold).toHaveAttribute("aria-expanded", "true", { timeout: 1_000 });
	}).toPass({ timeout: 30_000 });
}

/** A stored session in the fake omp's journal format (title slot, header, one exchange) under `agent`; no tab holds it. */
async function seedSession(agent: string, id: string, cwd: string, title: string): Promise<string> {
	const file = path.join(agent, "sessions", "seeded", `${id}.jsonl`);
	await fs.mkdir(path.dirname(file), { recursive: true });
	const at = new Date().toISOString();
	const lines = [
		{ type: "title", v: 1, title, updatedAt: at },
		{ type: "session", version: 3, id, timestamp: at, cwd },
		{ type: "message", id: `${id}-1`, parentId: null, timestamp: at, message: { role: "user", content: title } },
		{
			type: "message",
			id: `${id}-2`,
			parentId: `${id}-1`,
			timestamp: at,
			message: { role: "assistant", content: [{ type: "text", text: `${title} answer` }] },
		},
	];
	await fs.writeFile(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
	return file;
}

test("a deleted session or project leaves every window's sidebar with no click", async () => {
	test.setTimeout(240_000);
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidebar-delete-")));
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	const [alpha, beta, gamma] = ["alpha", "beta", "gamma"].map(name => path.join(root, name));
	await Promise.all([desktop, agent, alpha, beta, gamma].map(dir => fs.mkdir(dir)));
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", themeName: "light", firstRunComplete: true, lastProject: alpha }),
	);
	const seed = (id: string, cwd: string, title: string) => seedSession(agent, id, cwd, title);
	const byWindow = await seed("01b22000-0000-7000-8000-0000000000a1", alpha, "Alpha deleted by the other window");
	const byAgent = await seed("01b22000-0000-7000-8000-0000000000a2", alpha, "Alpha deleted by an agent");
	const kept = await seed("01b22000-0000-7000-8000-0000000000a3", alpha, "Alpha kept");
	const betaOne = await seed("01b22000-0000-7000-8000-0000000000b1", beta, "Beta one");
	const betaTwo = await seed("01b22000-0000-7000-8000-0000000000b2", beta, "Beta two");
	const gammaOne = await seed("01b22000-0000-7000-8000-0000000000c1", gamma, "Gamma one");
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	Object.assign(env, {
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(root),
		OMP_GUI_TEST_SESSION_FILES: "1",
	});
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	let app: ElectronApplication | null = null;
	try {
		app = await electron.launch({
			args: [path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"), `--user-data-dir=${desktop}`],
			env,
		});
		const first = await app.firstWindow();
		await first.waitForFunction(() => window.omp?.rpc != null);
		await expect
			.poll(async () => (await first.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		expect(await first.evaluate(() => window.omp.sessions.openInNewWindow({}))).toBe(true);
		await expect.poll(() => app?.windows().length, { timeout: 30_000 }).toBe(2);
		const second = app.windows().find(page => page !== first);
		if (!second) throw new Error("The second window has no page");
		await second.waitForFunction(() => window.omp?.rpc != null);
		for (const page of [first, second]) {
			await page.setViewportSize({ width: 1180, height: 820 });
			// Seeded projects start folded unless another window opened them first.
			for (const name of ["alpha", "beta", "gamma"]) await openProject(page, name);
			for (const file of [byWindow, byAgent, kept, betaOne, betaTwo, gammaOne])
				await expect(rowOf(page, file)).toBeVisible({ timeout: 30_000 });
		}
		await captureTo(CAPTURES, first, "1-before-first");
		await captureTo(CAPTURES, second, "1-before-second");

		// The second window deletes a session through its row's menu: the first window's row goes by itself.
		await rowOf(second, byWindow).click({ button: "right" });
		await second.getByRole("menuitem", { name: "Delete", exact: true }).click();
		await second.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
		await expect(rowOf(second, byWindow)).toHaveCount(0);
		await expect(rowOf(first, byWindow)).toHaveCount(0, { timeout: 5_000 });
		await captureTo(CAPTURES, first, "2-other-window-deleted-first");

		// Main deletes one as an agent's `ompdesk_session_stop {delete: true}` does: no window's list was told.
		await first.evaluate(file => window.omp.sessions.delete(file), byAgent);
		for (const page of [first, second]) await expect(rowOf(page, byAgent)).toHaveCount(0, { timeout: 5_000 });
		await expect(rowOf(first, kept)).toBeVisible();
		await captureTo(CAPTURES, first, "3-agent-deleted-first");

		// The first window deletes a whole project: its group goes in both windows.
		await groupOf(first, beta).click({ button: "right" });
		await first.getByRole("menuitem", { name: "Delete", exact: true }).click();
		await first.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
		// Its sessions leave both windows; the project stays listed, as the dialog says.
		for (const page of [first, second])
			for (const file of [betaOne, betaTwo]) await expect(rowOf(page, file)).toHaveCount(0, { timeout: 5_000 });
		await captureTo(CAPTURES, first, "4-project-deleted-first");
		await captureTo(CAPTURES, second, "4-project-deleted-second");

		// "Remove from sidebar" in the second window: the first window's group goes too.
		await groupOf(second, gamma).click({ button: "right" });
		await second.getByRole("menuitem", { name: "Remove from sidebar", exact: true }).click();
		for (const page of [second, first]) await expect(groupOf(page, gamma)).toHaveCount(0, { timeout: 5_000 });
		await captureTo(CAPTURES, first, "5-project-removed-first");
		await captureTo(CAPTURES, second, "5-project-removed-second");
	} finally {
		if (app) await exitApp(app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("a session an agent opened and then deleted leaves the host, a paired computer and the phone with no click", async () => {
	test.setTimeout(300_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidebar-delete-remote-")));
	let host: RemoteInstance | undefined;
	let client: RemoteInstance | undefined;
	let proxy: ServeProxy | null = null;
	const browser = await chromium.launch();
	try {
		const hostProfile = await makeRemoteProfile(parent, "host", { language: "en", theme: "light" });
		const clientProfile = await makeRemoteProfile(parent, "client", {
			language: "en",
			theme: "light",
			port: hostProfile.port,
		});
		// Two stored sessions no tab holds: one in the host's project the paired computer deletes, and one in a second
		// project the host removes from its sidebar.
		const extra = path.join(hostProfile.root, "extra");
		await fs.mkdir(extra);
		const agent = path.join(hostProfile.root, "agent");
		const byDevice = {
			file: await seedSession(
				agent,
				"01b22000-0000-7000-8000-0000000000d1",
				hostProfile.project,
				"Stored on the host",
			),
		};
		await seedSession(agent, "01b22000-0000-7000-8000-0000000000e1", extra, "Extra project session");
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const b = host.page;
		const a = client.page;
		await a.evaluate(() => window.omp.remote.setDeviceName("PC-A"));
		const deviceId = await connectHost(b, a, "PC-B");
		await expect
			.poll(async () => (await a.evaluate(() => window.omp.remote.getState())).hosts[0]?.state, { timeout: 30_000 })
			.toBe("online");

		const hostTabs = () => b.evaluate(() => window.omp.tabs.list());
		const opener = (await hostTabs()).find(tab => tab.active)?.tabId ?? "";
		await expect
			.poll(async () => (await hostTabs()).find(tab => tab.tabId === opener)?.status, { timeout: 60_000 })
			.toBe("ready");
		await b.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "hello" }), opener);
		await untilAnswered(b, opener);
		const call = await controlToolCaller(b, hostProfile.record, opener);
		// The child the opener deletes keeps working, so it is a row of the opener's family everywhere.
		const open = await call("ompdesk_session_open", {
			message: "Title: Child deleted by its opener\nDetails follow.",
		});
		expect(open.isError, open.text).toBe(false);
		const [childTab] = openedSessions(open.text);
		if (!childTab) throw new Error(open.text);
		await untilAnswered(b, childTab);
		await b.evaluate(
			id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture steer work" }),
			childTab,
		);
		await expect
			.poll(async () => (await hostTabs()).find(tab => tab.tabId === childTab)?.status, { timeout: 30_000 })
			.toBe("running");
		const byOpener = {
			tab: childTab,
			file: (await hostTabs()).find(tab => tab.tabId === childTab)?.sessionPath ?? "",
		};
		expect(byOpener.file).not.toBe("");

		// The phone, paired to the host.
		await b.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
		await expect
			.poll(() => b.evaluate(async () => (await window.omp.mobileWeb.getState()).phase), { timeout: 60_000 })
			.toBe("ready");
		await expect.poll(() => serveSites(hostProfile.tailscale).length, { timeout: 30_000 }).toBeGreaterThan(0);
		const site = serveSites(hostProfile.tailscale).at(-1);
		if (!site) throw new Error("serve publishes no handler");
		proxy = await ServeProxy.start(site, REMOTE_LOGIN);
		const context = await browser.newContext({ ...devices["Pixel 8"] });
		const phone = await context.newPage();
		await phone.goto(`${proxy.url}/`, { timeout: 60_000 });
		await phonePaired(phone);
		await phone.locator("header button:has(svg.lucide-menu)").click();

		const anywhere = (page: Page, file: string) => page.locator(`[data-session-path=${cssString(file)}]`);
		const viewsOf = (file: string) => [
			{ name: "host", page: b, found: anywhere(b, file) },
			{
				name: "device",
				page: a,
				found: a
					.locator(`[data-sidebar-device="${deviceId}"]`)
					.locator(`[data-device-session=${cssString(file)}], [data-session-path=${cssString(file)}]`),
			},
			{ name: "phone", page: phone, found: anywhere(phone, file) },
		];
		/** Every view drops the session by itself; one that still lists it is captured. */
		const goneEverywhere = async (file: string, step: string) => {
			for (const view of viewsOf(file)) {
				try {
					await expect(view.found, `${view.name} still lists it (${step})`).toHaveCount(0, { timeout: 5_000 });
				} catch (error) {
					await captureTo(CAPTURES, view.page, `${step}-${view.name}-still-listed`);
					throw error;
				}
			}
		};
		const openFolds = async () => {
			for (const page of [b, a, phone]) {
				const toggles = page.locator(
					'[data-sidebar-subagents-toggle][aria-expanded=false], .omp-session-sidebar [data-workspace-group] [data-roving-item^="group"][aria-expanded=false]',
				);
				for (const toggle of await toggles.all()) await toggle.click({ timeout: 1_000 }).catch(() => undefined);
			}
		};
		for (const view of [...viewsOf(byOpener.file), ...viewsOf(byDevice.file)]) {
			try {
				await expect
					.poll(
						async () => {
							if ((await view.found.count()) === 0) await openFolds();
							return view.found.count();
						},
						{ message: `${view.name} lists the session before it is deleted`, timeout: 30_000 },
					)
					.toBeGreaterThan(0);
			} catch (error) {
				await captureTo(CAPTURES, view.page, `remote-0-${view.name}-not-listed`);
				throw error;
			}
		}
		await captureTo(CAPTURES, b, "remote-1-before-host");
		await captureTo(CAPTURES, a, "remote-1-before-device");
		await captureTo(CAPTURES, phone, "remote-1-before-phone");

		// The opener deletes its child (`ompdesk_session_stop {delete: true}`): it leaves every view by itself.
		const deleted = await call("ompdesk_session_stop", { session: byOpener.tab, delete: true });
		expect(deleted.isError, deleted.text).toBe(false);
		await goneEverywhere(byOpener.file, "remote-2");
		await captureTo(CAPTURES, b, "remote-2-opener-deleted-host");
		await captureTo(CAPTURES, a, "remote-2-opener-deleted-device");
		await captureTo(CAPTURES, phone, "remote-2-opener-deleted-phone");

		// The paired computer deletes the other through the host's list: the host and the phone drop it too.
		await a.evaluate(([file, device]) => window.omp.sessions.delete(file, device), [
			byDevice.file,
			deviceId,
		] as const);
		await goneEverywhere(byDevice.file, "remote-3");
		await captureTo(CAPTURES, b, "remote-3-device-deleted-host");
		await captureTo(CAPTURES, a, "remote-3-device-deleted-device");
		await captureTo(CAPTURES, phone, "remote-3-device-deleted-phone");

		// The host removes the second project from its sidebar: its group leaves the paired computer and the phone too.
		const projectViews = [
			{ name: "host", page: b, found: b.locator(`.omp-session-sidebar [data-workspace-group=${cssString(extra)}]`) },
			{
				name: "device",
				page: a,
				found: a.locator(`[data-sidebar-device="${deviceId}"] [data-device-group=${cssString(extra)}]`),
			},
			{
				name: "phone",
				page: phone,
				found: phone.locator(`.omp-session-sidebar [data-workspace-group=${cssString(extra)}]`),
			},
		];
		for (const view of projectViews)
			await expect(view.found, `${view.name} lists the project before it is removed`).toHaveCount(1, {
				timeout: 30_000,
			});
		await b.evaluate(cwd => window.omp.sidebarProjects.command({ action: "remove", path: cwd }), extra);
		for (const view of projectViews) {
			try {
				await expect(view.found, `${view.name} still lists the removed project`).toHaveCount(0, { timeout: 5_000 });
			} catch (error) {
				await captureTo(CAPTURES, view.page, `remote-4-${view.name}-project-still-listed`);
				throw error;
			}
		}
		await captureTo(CAPTURES, b, "remote-4-project-removed-host");
		await captureTo(CAPTURES, a, "remote-4-project-removed-device");
		await captureTo(CAPTURES, phone, "remote-4-project-removed-phone");
		await context.close();
	} finally {
		await proxy?.close();
		await browser.close();
		for (const instance of [client, host]) if (instance) await exitApp(instance.app);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
