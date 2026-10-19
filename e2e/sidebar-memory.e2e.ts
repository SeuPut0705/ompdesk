/**
 * The left side remembers what the person left open or closed (AGENTS.md › Sidebar memory): the docked sidebar
 * itself, the fold of each project group and the rest (`stores/sidebar-folds.ts`, device-local prefs
 * `sidebarVisible` / `sidebarFolds`, mirrored in localStorage for the first frame).
 *
 * Collapse the sidebar and fold two project groups, quit, relaunch: the boot shell and the React shell's first
 * frame already show the sidebar collapsed (no open sidebar for a frame), and once it is shown again both groups are
 * folded; a second relaunch with the sidebar open sees each group folded the first time it is painted.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp, launchApp } from "./harness";

/** Records, before the page's own scripts, what the first frames of the boot shell and the app show. */
const FIRST_FRAME_PROBE = `(() => {
	const seen = (window.__sm = { boot: null, shell: null, groups: {} });
	const sample = () => {
		const root = document.documentElement;
		if (seen.boot === null && document.querySelector(".boot-shell")) {
			const sidebar = document.querySelector(".boot-sidebar");
			seen.boot = {
				attribute: root.dataset.bootSidebar ?? null,
				sidebarWidth: sidebar ? sidebar.getBoundingClientRect().width : 0,
			};
		}
		const shell = document.querySelector(".omp-shell");
		if (seen.shell === null && shell) {
			seen.shell = {
				sidebar: shell.getAttribute("data-sidebar"),
				mounted: document.querySelector(".omp-shell .omp-session-sidebar") !== null,
			};
		}
		for (const group of document.querySelectorAll("[data-workspace-group]")) {
			const key = group.getAttribute("data-workspace-group");
			if (key !== null && !(key in seen.groups)) {
				seen.groups[key] = group.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded") ?? null;
			}
		}
	};
	new MutationObserver(sample).observe(document, { childList: true, subtree: true, attributes: true });
	document.addEventListener("DOMContentLoaded", sample);
})();`;

interface FirstFrame {
	boot: { attribute: string | null; sidebarWidth: number } | null;
	shell: { sidebar: string | null; mounted: boolean } | null;
	groups: Record<string, string | null>;
}

interface Launched {
	app: ElectronApplication;
	page: Page;
}

let profile: string | null = null;
let current: ElectronApplication | null = null;

test.afterEach(async () => {
	if (current) await exitApp(current);
	current = null;
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	profile = null;
});

/** Open tabs the saved layouts name by session file: what a relaunch restores. */
async function savedSessions(desktop: string): Promise<number> {
	try {
		const prefs: unknown = JSON.parse(await fs.readFile(path.join(desktop, "prefs.json"), "utf8"));
		const layouts = typeof prefs === "object" && prefs !== null && "tabLayouts" in prefs ? prefs.tabLayouts : null;
		if (!Array.isArray(layouts)) return 0;
		let count = 0;
		for (const layout of layouts) {
			const tabs = typeof layout === "object" && layout !== null && "tabs" in layout ? layout.tabs : null;
			if (!Array.isArray(tabs)) continue;
			for (const tab of tabs) if (typeof tab === "object" && tab !== null && "sessionPath" in tab) count++;
		}
		return count;
	} catch {
		return 0;
	}
}
interface Dirs {
	project: string;
	desktop: string;
	agent: string;
	profile: string;
}

/** First start on `project`; a relaunch passes no folder, so the saved tabs come back (what a person's relaunch does). */
async function open(dirs: Dirs, restore: boolean): Promise<ElectronApplication> {
	const env = { OMP_GUI_TEST_SESSION_FILES: "1" };
	if (!restore) return launchApp({ ...dirs, env });
	const launchEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries({
		...process.env,
		PI_CODING_AGENT_DIR: dirs.agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), dirs.profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(dirs.profile),
		...env,
	})) {
		if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") launchEnv[key] = value;
	}
	return electron.launch({
		args: [path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"), `--user-data-dir=${dirs.desktop}`],
		env: launchEnv,
	});
}

async function launch(dirs: Dirs, restore = false): Promise<Launched> {
	const app = await open(dirs, restore);
	current = app;
	await app.context().addInitScript(FIRST_FRAME_PROBE);
	const page = await app.firstWindow();
	// The window can load before the script is registered: then it is a renderer start of the same window.
	if (!(await page.evaluate(() => window.__sm !== undefined))) await page.reload();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	return { app, page };
}

async function quit(): Promise<void> {
	if (current) await exitApp(current);
	current = null;
}

/** What the probe saw of the first frames; read once the app's own shell is up. */
async function firstFrame(page: Page): Promise<FirstFrame> {
	await page.locator(".omp-shell").waitFor();
	return page.evaluate(() => window.__sm as FirstFrame);
}

declare global {
	interface Window {
		__sm?: FirstFrame;
	}
}

/** What prefs.json holds for the sidebar: the shown flag and the folded project groups. */
async function savedSidebar(desktop: string): Promise<{ visible: unknown; groups: Record<string, unknown> }> {
	try {
		const prefs: unknown = JSON.parse(await fs.readFile(path.join(desktop, "prefs.json"), "utf8"));
		if (typeof prefs !== "object" || prefs === null) return { visible: undefined, groups: {} };
		const visible = "sidebarVisible" in prefs ? prefs.sidebarVisible : undefined;
		const folds = "sidebarFolds" in prefs ? prefs.sidebarFolds : undefined;
		const groups =
			typeof folds === "object" && folds !== null && "groups" in folds && typeof folds.groups === "object"
				? folds.groups
				: null;
		return { visible, groups: { ...groups } };
	} catch {
		return { visible: undefined, groups: {} };
	}
}

test("a collapsed sidebar and two folded projects come back on the first frame after a relaunch", async () => {
	profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidebar-memory-")));
	const project = path.join(profile, "project");
	const second = path.join(profile, "second");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([project, second, desktop, agent].map(dir => fs.mkdir(dir)));
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", themeName: "light", firstRunComplete: true }),
	);
	const dirs = { project, desktop, agent, profile };

	// First start: two projects in the list, both open; fold both, then hide the sidebar.
	const first = await launch(dirs);
	await expect
		.poll(async () => (await first.page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	// A first message gives a tab its session file, which the saved layout names and a relaunch restores.
	const say = async (text: string) => {
		const input = first.page.locator("[data-composer-input]:visible").first();
		await input.fill(text);
		await input.press("Enter");
		await expect(first.page.getByText(text, { exact: true }).first()).toBeVisible();
	};
	await say("hello one");
	const spawned = await first.page.evaluate(
		async cwd => (await window.omp.tabs.spawn({ cwd, kind: "agent" }))?.tabId,
		second,
	);
	expect(spawned).toBeTruthy();
	await expect
		.poll(
			async () =>
				(await first.page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === spawned)?.status,
		)
		.toBe("ready");
	await first.page.evaluate(id => (id ? window.omp.tabs.setActive(id) : null), spawned);
	await expect
		.poll(async () => (await first.page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId)
		.toBe(spawned);
	await say("hello two");
	await expect.poll(async () => await savedSessions(desktop)).toBeGreaterThanOrEqual(2);
	const group = (page: Page, cwd: string) => page.locator(`[data-workspace-group="${cwd}"]`);
	const toggle = (page: Page, cwd: string) => group(page, cwd).locator("button[aria-expanded]").first();
	for (const cwd of [project, second]) {
		await expect(toggle(first.page, cwd)).toHaveAttribute("aria-expanded", "true");
		await toggle(first.page, cwd).click();
		await expect(toggle(first.page, cwd)).toHaveAttribute("aria-expanded", "false");
	}
	await first.page.getByRole("button", { name: "Hide sidebar" }).click();
	await expect(first.page.locator('.omp-shell[data-sidebar="hidden"]')).toBeVisible();
	await expect
		.poll(async () => {
			const saved = await savedSidebar(desktop);
			return [saved.visible, saved.groups[project], saved.groups[second]];
		})
		.toEqual([false, true, true]);
	await quit();

	// Relaunch: no sidebar on the boot shell's frame, none on the app's first frame; showing it brings the folds.
	const again = await launch(dirs, true);
	const frame = await firstFrame(again.page);
	expect(frame.boot).toEqual({ attribute: "hidden", sidebarWidth: 0 });
	expect(frame.shell).toEqual({ sidebar: "hidden", mounted: false });
	await expect(again.page.locator(".omp-shell .omp-session-sidebar")).toHaveCount(0);
	await again.page.getByRole("button", { name: "Toggle sidebar" }).first().click();
	for (const cwd of [project, second]) await expect(toggle(again.page, cwd)).toHaveAttribute("aria-expanded", "false");
	await expect.poll(async () => (await savedSidebar(desktop)).visible).toBe(true);
	await quit();

	// Third start: the sidebar is open on the first frame and each group is folded the first time it is painted.
	const third = await launch(dirs, true);
	const open = await firstFrame(third.page);
	expect(open.boot?.attribute).toBeNull();
	expect(open.boot?.sidebarWidth ?? 0).toBeGreaterThan(0);
	expect(open.shell).toEqual({ sidebar: "docked", mounted: true });
	await expect(toggle(third.page, project)).toHaveAttribute("aria-expanded", "false");
	for (const [cwd, state] of Object.entries((await firstFrame(third.page)).groups)) {
		expect(state, `${cwd} was painted open before it folded`).toBe("false");
	}
});
