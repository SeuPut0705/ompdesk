/**
 * One session, one row, on a paired phone's real page (the built app's `web.html` in Chromium, reached through
 * `fixture/phone-serve.ts`'s stand-in for `tailscale serve`). The phone starts an Autopilot run on the fake omp
 * (`fixture/autopilot.ts`, children on): each cycle opens child sessions in real git worktrees off the run's
 * checkout (`autopilot/<run>-c<N>-<area>`). Their rows sit under the run's row with their task, never as groups of
 * their own named after the worktree folder, and never as a column of identical "New session" rows (what the user
 * saw on v0.36.1). The desktop opens the run's session too (it views the phone's tab), the link drops and the
 * computer restarts: every listed path has one row, and the phone one tab per session.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Browser, chromium, devices, expect, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { crash, makeApProfile } from "./autopilot-harness";
import { fixtureTailscale } from "./fixture/fake-tailscale-install";
import { ServeProxy, serveSites } from "./fixture/phone-serve";
import { exitApp, fixtureOmp } from "./harness";

/** Where the before/after captures go when set (`OMP_GUI_MOBILE_ROWS_CAPTURES=/tmp/mobile-dup`). */
const CAPTURES = process.env.OMP_GUI_MOBILE_ROWS_CAPTURES;

async function launch(
	userData: string,
	env: Record<string, string>,
): Promise<{ app: ElectronApplication; page: Page }> {
	const app = await electron.launch({
		args: [path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"), `--user-data-dir=${userData}`],
		env,
	});
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	return { app, page };
}

async function mobileWebReady(page: Page): Promise<void> {
	await expect
		.poll(() => page.evaluate(async () => (await window.omp.mobileWeb.getState()).phase).catch(() => "starting"), {
			timeout: 60_000,
		})
		.toBe("ready");
}

/** What the phone's drawer lists in the Code lane, every group, family and "n done" fold unfolded. */
interface Rows {
	/** `data-session-path` → how many rows show it. */
	perPath: Record<string, number>;
	groups: string[];
	/**
	 * The run's children: the sessions its agent opened (`ompdesk_session_open`), one line each in the run's family
	 * (`data-sidebar-opened-session`, sidebar-family.ts), or a row `data-session-run-child` marks; with the group they
	 * sit in and whether that group is a worktree's.
	 */
	childRows: Array<{ path: string; text: string; group: string; worktreeGroup: boolean }>;
	text: string;
}

async function openDrawer(phone: Page): Promise<void> {
	await phone.getByRole("button", { name: "Open menu" }).click();
	const sidebar = phone.locator("[data-drawer] .omp-session-sidebar");
	await expect(sidebar).toBeVisible();
	await sidebar.getByText("Code", { exact: true }).first().click();
}

async function closeDrawer(phone: Page): Promise<void> {
	// The system back gesture closes the drawer (mobile-shell.e2e.ts).
	await phone.goBack();
	await expect(phone.locator("[data-drawer]")).toHaveCount(0);
}

async function readRows(phone: Page): Promise<Rows> {
	const sidebar = phone.locator("[data-drawer] .omp-session-sidebar");
	// Projects first, then the families they show, then a family's folded finished sessions.
	for (const folds of [
		'[data-workspace-group] button[aria-expanded="false"]',
		'[data-sidebar-subagents-toggle][aria-expanded="false"]',
		'[data-family-done][aria-expanded="false"]',
	])
		for (const fold of await sidebar.locator(folds).all()) await fold.click().catch(() => undefined);
	return sidebar.evaluate(element => {
		const perPath: Record<string, number> = {};
		const childRows: Rows["childRows"] = [];
		const headers = [...element.querySelectorAll("[data-workspace-group]")];
		for (const row of element.querySelectorAll(
			":is(.omp-sidebar-session-row, [data-sidebar-opened-session])[data-session-path]",
		)) {
			const rowPath = row.getAttribute("data-session-path") ?? "";
			perPath[rowPath] = (perPath[rowPath] ?? 0) + 1;
			if (row.getAttribute("data-session-run-child") !== "true" && !row.hasAttribute("data-sidebar-opened-session"))
				continue;
			const key = row.closest("[data-session-group]")?.getAttribute("data-session-group");
			const header = headers.find(candidate => candidate.getAttribute("data-workspace-group") === key);
			childRows.push({
				path: rowPath,
				text: row.textContent ?? "",
				group: header?.textContent?.trim() ?? "",
				worktreeGroup: header?.hasAttribute("data-worktree-group") === true,
			});
		}
		const groups = [...element.querySelectorAll("[data-workspace-group]")].map(
			group => group.textContent?.trim() ?? "",
		);
		return { perPath, groups, childRows, text: element.textContent ?? "" };
	});
}

async function phoneTabPaths(phone: Page): Promise<string[]> {
	return phone.evaluate(async () =>
		(await window.omp.tabs.list()).flatMap(tab => (tab.sessionPath ? [tab.sessionPath] : [])),
	);
}

async function desktopTabs(page: Page): Promise<Array<{ tabId: string; path: string | undefined }>> {
	return page.evaluate(async () =>
		(await window.omp.tabs.list()).map(tab => ({ tabId: tab.tabId, path: tab.sessionPath ?? undefined })),
	);
}

function duplicates(record: Record<string, number>): string[] {
	return Object.entries(record).flatMap(([key, count]) => (count > 1 ? [key] : []));
}

test("a phone's Autopilot run lists its children under the run with their task, and every session once, across a reconnect and a restart", async () => {
	test.skip(process.platform === "win32", "the fake Tailscale is a bun shebang script");
	test.setTimeout(300_000);
	const ap = await makeApProfile({ script: { cycleMs: 6000, cycle: { children: 2 } } });
	const tailscale = await fixtureTailscale(ap.root, { backendState: "Running" });
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries({ ...process.env, ...ap.env })) if (value !== undefined) env[key] = value;
	Object.assign(env, {
		PI_CODING_AGENT_DIR: ap.agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), ap.root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(ap.root),
		...tailscale.env,
	});
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	let current: ElectronApplication | null = null;
	let browser: Browser | null = null;
	let proxy: ServeProxy | null = null;
	try {
		const first = await launch(ap.desktop, env);
		current = first.app;
		await first.page.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
		await mobileWebReady(first.page);
		const [site] = serveSites(tailscale);
		if (!site) throw new Error("no serve handler published");
		proxy = await ServeProxy.start(site, "seuput@example.com");
		browser = await chromium.launch();
		const phone = await (await browser.newContext({ ...devices["Pixel 7"], colorScheme: "light" })).newPage();
		await phone.goto(`${proxy.url}/`);
		await expect(phone.getByRole("button", { name: "Open menu" })).toBeVisible({ timeout: 60_000 });
		// A web window starts with no tab: the phone opens one in the project, then starts Autopilot from its composer.
		await phone.evaluate(cwd => window.omp.tabs.spawn({ cwd, kind: "agent" }), ap.project);
		await phone.reload();
		await expect(phone.locator("[data-composer-input]").first()).toBeVisible({ timeout: 60_000 });
		// The Run chip in the phone composer's control row opens the Run settings with the modes.
		await phone.locator("[data-run-settings-trigger]").click();
		await phone.getByRole("tab", { name: "Autopilot" }).click();
		await phone.locator("[data-autopilot-start]").click();
		// The run's panel opens by itself as a sheet over everything; close it to reach the drawer.
		await expect(phone.locator("[data-autopilot-panel]")).toBeVisible({ timeout: 60_000 });
		await phone.getByRole("button", { name: "Close side panel" }).first().click();
		await expect(phone.locator("[data-autopilot-panel]")).toHaveCount(0);

		// A cycle's children are open: their rows sit under the run's, in the run's family (the sessions its agent
		// opened), named by their task, in no group of their own.
		await openDrawer(phone);
		await expect
			.poll(async () => (await readRows(phone)).childRows.length, { timeout: 60_000, message: "the children open" })
			.toBeGreaterThan(0);
		const during = await readRows(phone);
		if (CAPTURES) await phone.screenshot({ path: path.join(CAPTURES, "after-children.png") });
		expect(during.text).not.toMatch(/-c\d+-(tests|docs|bugs|design)/);
		expect(during.groups.filter(name => /^\d{4}-\d{2}-\d{2}/.test(name))).toEqual([]);
		for (const child of during.childRows) {
			expect(child.text).toContain("Autopilot child");
			expect(child.text).not.toContain("New session");
			// Under the run's own row, in the run's group (the worktree group labelled Autopilot), not the project's.
			expect(child).toMatchObject({ group: "Autopilot", worktreeGroup: true });
		}
		expect(duplicates(during.perPath)).toEqual([]);
		await closeDrawer(phone);

		// The desktop opens the phone's sessions too: it views the phone's tabs, the phone's list does not change.
		const phonePaths = await phoneTabPaths(phone);
		for (const sessionPath of phonePaths)
			expect(await first.page.evaluate(p => window.omp.tabs.spawn({ sessionPath: p }), sessionPath)).toMatchObject({
				attached: true,
			});
		// And the phone opens a session the desktop holds: it views the desktop's tab, no second omp on that file.
		const spawned = await first.page.evaluate(cwd => window.omp.tabs.spawn({ cwd }), ap.project);
		const desktopTabId = spawned?.tabId;
		if (!desktopTabId) throw new Error("the desktop's tab was refused");
		// A prompt sent before the tab's omp is up is refused: wait for it, then for the file the prompt writes.
		const desktopTab = async () =>
			(await first.page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === desktopTabId);
		await expect.poll(async () => (await desktopTab())?.status, { timeout: 60_000 }).toBe("ready");
		expect(
			await first.page.evaluate(
				tabId => window.omp.rpc.commandForTab(tabId, { type: "prompt", message: "hello from the desktop" }),
				desktopTabId,
			),
		).toMatchObject({ success: true });
		await expect
			.poll(
				async () => {
					const file = (await desktopTab())?.sessionPath;
					return file
						? fs.access(file).then(
								() => file,
								() => null,
							)
						: null;
				},
				{ timeout: 60_000, message: "the desktop's own session file" },
			)
			.toBeTruthy();
		const desktopPath = (await desktopTab())?.sessionPath;
		if (!desktopPath) throw new Error("no desktop session");
		expect(await phone.evaluate(p => window.omp.tabs.spawn({ sessionPath: p }), desktopPath)).toMatchObject({
			tabId: desktopTabId,
			attached: true,
		});
		// The link drops: the page reconnects by itself and, having missed events, catches up in place (web/resync.ts):
		// it never loads again (`domcontentloaded`: `framenavigated` also counts same-document history entries).
		let navigations = 0;
		phone.on("domcontentloaded", () => {
			navigations++;
		});
		proxy.dropSockets();
		await expect(phone.locator("[data-composer-input]").first()).toBeVisible({ timeout: 60_000 });
		await openDrawer(phone);
		expect(duplicates((await readRows(phone)).perPath)).toEqual([]);
		await closeDrawer(phone);
		const reconnectedTabs = await phoneTabPaths(phone);
		expect(new Set(reconnectedTabs).size).toBe(reconnectedTabs.length);

		// The computer restarts (killed, as a crash or a power cut does: the saved layouts are what they were); the open
		// page reconnects on its own and, having missed events, reads the restarted host's tabs again in place. An
		// `app.exit` would close the desktop window first, and the owner closing a tab rightly takes it from its viewers.
		await crash(current);
		current = null;
		const second = await launch(ap.desktop, env);
		current = second.app;
		await mobileWebReady(second.page);
		proxy.retarget(serveSites(tailscale).at(-1) ?? site);
		// The relaunched host answers the page again (its reconnect's resync then reads the new tab ids in place).
		await expect
			.poll(() => phone.evaluate(async () => (await window.omp.tabs.list()).length).catch(() => 0), {
				timeout: 180_000,
			})
			.toBeGreaterThan(0);
		expect(navigations).toBe(0);
		await expect(phone.locator("[data-composer-input]").first()).toBeVisible({ timeout: 60_000 });
		const tabPaths = await phoneTabPaths(phone);
		expect(tabPaths.length).toBeGreaterThan(0);
		expect(new Set(tabPaths).size).toBe(tabPaths.length);
		// The desktop session the phone viewed is back on the phone as a view of the desktop's one tab.
		const desktopAfter = await desktopTabs(second.page);
		const sharedTab = desktopAfter.filter(tab => tab.path === desktopPath);
		expect(sharedTab).toHaveLength(1);
		await expect
			.poll(() =>
				phone.evaluate(async () =>
					(await window.omp.tabs.list()).map(tab => [tab.sessionPath, tab.tabId, tab.shared === true]),
				),
			)
			.toContainEqual([desktopPath, sharedTab[0]?.tabId, true]);
		await openDrawer(phone);
		const after = await readRows(phone);
		expect(duplicates(after.perPath)).toEqual([]);
		expect(after.groups.filter(name => /^\d{4}-\d{2}-\d{2}/.test(name))).toEqual([]);
		for (const child of after.childRows) expect(child).toMatchObject({ group: "Autopilot", worktreeGroup: true });
		if (CAPTURES) await phone.screenshot({ path: path.join(CAPTURES, "after-restart.png") });
		// The desktop took no copy of the phone's own sessions.
		const desktopPaths = desktopAfter.map(tab => tab.path);
		for (const sessionPath of tabPaths.filter(p => p !== desktopPath))
			expect(desktopPaths).not.toContain(sessionPath);
	} finally {
		await browser?.close();
		await proxy?.close();
		if (current) await exitApp(current).catch(() => undefined);
		await fs.rm(ap.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => undefined);
	}
});
