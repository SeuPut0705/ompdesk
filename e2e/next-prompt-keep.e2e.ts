/**
 * A suggestion never vanishes on its own (the user's report, 24 Oct 2026: "원격이든 현재기기든 추천 프롬프트
 * 날라가지 않도록"). Main forwards a session's frames only while a window shows its tab, a page that reloads starts
 * with an empty memory, and a relaunch starts a new omp: a suggestion made while the tab was in the background, or
 * shown before a reload or a relaunch, was gone until the next turn. The tab's bridge keeps the session's last
 * suggestion (and journals it), `get_next_prompt` answers it as `last`, and every hydration puts it back. The fake
 * omp (e2e/fixture/rpc-ui.ts) mirrors the bridge; the bridge itself is unit-tested (bridge-next-prompt.test.ts).
 * A paired host's tab across a lost link: e2e/remote-resume.e2e.ts.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, _electron as electron, expect, type Page, test } from "@playwright/test";
import { appLaunchOptions, exitApp } from "./harness";

const CANDIDATES = ["Run the tests", "Commit these changes", "Explain what you changed"] as const;

interface Launched {
	app: ElectronApplication;
	page: Page;
	profile: string;
	errors: string[];
}

async function launch(options: { profile?: string; latencyMs: number; sessionFiles?: boolean }): Promise<Launched> {
	const profile =
		options.profile ?? (await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-next-prompt-keep-"))));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	if (!options.profile) {
		await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language: "en", themeName: "light", firstRunComplete: true }),
		);
	}
	const launchOptions = await appLaunchOptions({
		project,
		desktop,
		agent,
		profile,
		env: {
			OMP_GUI_TEST_NEXT_PROMPT: JSON.stringify({ latencyMs: options.latencyMs }),
			...(options.sessionFiles ? { OMP_GUI_TEST_SESSION_FILES: "1" } : {}),
		},
	});
	// A relaunch names no folder, so the app restores the saved layout (the session's tab) as it does for a person.
	const app = await electron.launch(
		options.profile ? { ...launchOptions, args: launchOptions.args.filter(arg => arg !== project) } : launchOptions,
	);
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page, profile, errors };
}

function composer(page: Page) {
	return page.locator(".omp-composer-input").first();
}

function tabs(page: Page) {
	return page.evaluate(() => window.omp.tabs.list());
}

async function activeTab(page: Page): Promise<string> {
	const active = (await tabs(page)).find(tab => tab.active);
	if (!active) throw new Error("No active tab");
	return active.tabId;
}

/** Suggestion requests the tab's omp made so far (`get_next_prompt`'s count). */
async function suggestions(page: Page, tabId: string): Promise<number> {
	const response = await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "get_next_prompt" }), tabId);
	return (response.data as { requests?: { suggest?: number } } | undefined)?.requests?.suggest ?? 0;
}

test("a suggestion made while its tab was in the background is there on return, and after a reload", async () => {
	test.setTimeout(150_000);
	// The suggestion lands 4 s after the turn: the tab is in the background by then.
	const launched = await launch({ latencyMs: 4_000 });
	try {
		const { page } = launched;
		const first = await activeTab(page);
		await composer(page).fill("hello there");
		await composer(page).press("Enter");
		await expect(page.getByText("Local fixture reply")).toHaveCount(1, { timeout: 30_000 });
		const before = (await tabs(page)).map(tab => tab.tabId);
		await page.keyboard.press("ControlOrMeta+t");
		await expect.poll(async () => (await tabs(page)).length).toBe(before.length + 1);
		const second = (await tabs(page)).find(tab => !before.includes(tab.tabId))?.tabId;
		if (!second) throw new Error("No new tab");
		await expect.poll(() => activeTab(page)).toBe(second);
		// The first tab's omp made its suggestion while the second tab was in front.
		await expect.poll(() => suggestions(page, first), { timeout: 20_000 }).toBe(1);
		await page.waitForTimeout(500);

		// Back to the first tab the way a person goes: its sidebar row.
		await page.locator(`[data-session-path="tab:${first}"]`).locator("button[data-roving-item]").click();
		await expect.poll(() => activeTab(page)).toBe(first);
		await expect(composer(page)).toHaveAttribute("placeholder", CANDIDATES[0], { timeout: 10_000 });

		// A reload starts the page's memory empty: the tab's omp still has the suggestion.
		await page.reload();
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect(page.getByText("Local fixture reply")).toHaveCount(1, { timeout: 30_000 });
		await expect(composer(page)).toHaveAttribute("placeholder", CANDIDATES[0], { timeout: 10_000 });
		// Nothing was asked of the model again.
		expect(await suggestions(page, first)).toBe(1);
		expect(launched.errors).toEqual([]);
	} finally {
		await exitApp(launched.app);
		await fs.rm(launched.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("a relaunch shows the suggestion the session had, without asking the model again", async () => {
	test.setTimeout(150_000);
	const launched = await launch({ latencyMs: 1, sessionFiles: true });
	let relaunched: Launched | undefined;
	try {
		await composer(launched.page).fill("hello there");
		await composer(launched.page).press("Enter");
		await expect(launched.page.getByText("Local fixture reply")).toHaveCount(1, { timeout: 30_000 });
		await expect(composer(launched.page)).toHaveAttribute("placeholder", CANDIDATES[0], { timeout: 10_000 });
		await exitApp(launched.app);

		relaunched = await launch({ profile: launched.profile, latencyMs: 1, sessionFiles: true });
		const page = relaunched.page;
		await expect(page.getByText("Local fixture reply")).toHaveCount(1, { timeout: 30_000 });
		await expect(composer(page)).toHaveAttribute("placeholder", CANDIDATES[0], { timeout: 10_000 });
		// The relaunched omp read it from the session's journal: no request.
		expect(await suggestions(page, await activeTab(page))).toBe(0);
		expect(relaunched.errors).toEqual([]);
	} finally {
		await exitApp((relaunched ?? launched).app);
		await fs.rm(launched.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
