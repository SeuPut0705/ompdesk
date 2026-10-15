/**
 * Desktop behaviour (627bf30) and tab navigation (a09f8e2) on the fake omp:
 * - Settings › General: the notification chime plays from Play, the volume
 *   row follows the slider, a web link in a reply opens in Preview, the side
 *   panel docks left, and "keep awake while working" holds a sleep blocker
 *   while a turn runs (the switch going off releases it at once);
 * - a background tab's finished turn notifies with the reply's opening prose
 *   (no Markdown) and the chime, and a click on the banner brings that tab
 *   forward;
 * - ⌃⇥ lists the tabs most recent first and switches on releasing ⌃, ⌘[ / ⌘]
 *   go back and forward, ⇧⌘A searches, reorders (⌘1 follows) and closes tabs;
 * - ⌥⌘ arrows and ⌥⌘] move the focus between split panes.
 * Close-to-tray is Windows-only and headless runs have no tray; Copy Image is
 * covered by editable-context-menu.test.ts.
 * Captures: en-light and ko-dark (test output directory).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp, pressShortcutUntilVisible } from "./harness";

type Language = "en" | "ko";
type Theme = "light" | "dark";

const TEXT = {
	en: {
		play: "Play",
		previewUrl: "Preview URL",
		switcher: "Open tabs, most recent first",
		overview: "Tab overview",
		order: "Order",
		moveDown: "Move down",
		close: (title: string) => `Close ${title}`,
	},
	ko: {
		play: "들어 보기",
		previewUrl: "미리보기 URL",
		switcher: "열린 탭, 최근 순",
		overview: "탭 개요",
		order: "순서",
		moveDown: "아래로 이동",
		close: (title: string) => `${title} 닫기`,
	},
} as const;

const RUNS = [
	["en", "light"],
	["ko", "dark"],
] as const satisfies ReadonlyArray<readonly [Language, Theme]>;

const MAC = process.platform === "darwin";
const BACK = MAC ? "Meta+BracketLeft" : "Alt+ArrowLeft";
const FORWARD = MAC ? "Meta+BracketRight" : "Alt+ArrowRight";

interface Launched {
	app: ElectronApplication;
	page: Page;
	desktop: string;
	errors: string[];
}

let profile: string | null = null;
let launched: Launched | null = null;

test.afterEach(async () => {
	if (launched) await exitApp(launched.app);
	launched = null;
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	profile = null;
});

async function launch(language: Language, theme: Theme, prefs: Record<string, unknown> = {}): Promise<Launched> {
	profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-desktop-tabs-")));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language, themeName: theme, firstRunComplete: true, ...prefs }),
	);
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(profile),
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env,
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	launched = { app, page, desktop, errors };
	return launched;
}

async function capture(page: Page, name: string): Promise<void> {
	await page.screenshot({ path: test.info().outputPath(`${name}.png`), animations: "disabled", scale: "css" });
}

function tabs(page: Page) {
	return page.evaluate(() => window.omp.tabs.list());
}

async function activeTab(page: Page): Promise<string> {
	const active = (await tabs(page)).find(tab => tab.active);
	if (!active) throw new Error("No active tab");
	return active.tabId;
}

async function fixtureCommand(page: Page, tabId: string, line: string): Promise<void> {
	const response = await page.evaluate(
		([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }),
		[tabId, line] as const,
	);
	expect(response).toMatchObject({ success: true });
}

/** Name a tab (session_info_update) and wait until its sidebar row shows it. */
async function nameTab(page: Page, tabId: string, title: string): Promise<void> {
	await fixtureCommand(page, tabId, `fixture:title:${title}`);
	await expect(page.locator(`[data-session-path="tab:${tabId}"]`)).toContainText(title);
}

/** ⌘T: a new tab in front, named once its omp is up. */
async function openTab(page: Page, title: string): Promise<string> {
	const before = (await tabs(page)).map(tab => tab.tabId);
	await page.keyboard.press("ControlOrMeta+t");
	await expect.poll(async () => (await tabs(page)).length).toBe(before.length + 1);
	const created = (await tabs(page)).find(tab => !before.includes(tab.tabId));
	if (!created) throw new Error("No new tab");
	await expect.poll(async () => (await tabs(page)).find(tab => tab.tabId === created.tabId)?.status).toBe("ready");
	await expect.poll(() => activeTab(page)).toBe(created.tabId);
	await nameTab(page, created.tabId, title);
	return created.tabId;
}

/** Counts the oscillators the chime starts (two per chime) in `window.__chimeNotes`. */
async function countChimeNotes(page: Page): Promise<void> {
	await page.evaluate(() => {
		Reflect.set(window, "__chimeNotes", 0);
		const proto = BaseAudioContext.prototype;
		const original = proto.createOscillator;
		proto.createOscillator = function (this: BaseAudioContext) {
			Reflect.set(window, "__chimeNotes", Number(Reflect.get(window, "__chimeNotes")) + 1);
			return original.call(this);
		};
	});
}

function chimeNotes(page: Page): Promise<number> {
	return page.evaluate(() => Number(Reflect.get(window, "__chimeNotes")));
}

async function openGeneralSettings(page: Page) {
	const settings = page.locator("[data-settings-page]");
	await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
	await settings.locator('[data-settings-section="general"]').click();
	return settings;
}

for (const [language, theme] of RUNS) {
	const text = TEXT[language];

	test(`Settings › General: chime, links in Preview, left side panel, keep awake while working (${language}-${theme})`, async () => {
		test.setTimeout(120_000);
		const { app, page, desktop, errors } = await launch(language, theme);
		await countChimeNotes(page);
		await app.evaluate(({ shell }) => {
			const opened: string[] = [];
			Reflect.set(globalThis, "__openedUrls", opened);
			shell.openExternal = async (url: string) => {
				opened.push(url);
			};
		});
		const awake = () =>
			app.evaluate(({ powerSaveBlocker }) =>
				Array.from({ length: 64 }, (_, id) => powerSaveBlocker.isStarted(id)).some(Boolean),
			);

		const settings = await openGeneralSettings(page);
		const sound = settings.locator("#setting-gui-notificationSound");
		await sound.scrollIntoViewIfNeeded();
		await sound.getByRole("switch").click();
		const volume = settings.locator("#setting-gui-notificationVolume");
		await expect(volume).toBeVisible();
		await sound.getByRole("button", { name: text.play, exact: true }).click();
		await expect.poll(() => chimeNotes(page)).toBe(2);
		await volume.locator('input[type="range"]').fill("40");
		await expect(volume).toContainText("40%");

		await settings.locator("#setting-gui-linkPreview").getByRole("switch").click();
		await settings.locator("#setting-gui-panelSide select").selectOption("left");
		await settings.locator("#setting-gui-keepAwakeWorking").getByRole("switch").click();
		await sound.scrollIntoViewIfNeeded();
		await capture(page, `general-window-${language}-${theme}`);
		await expect
			.poll(async () => JSON.parse(await fs.readFile(path.join(desktop, "prefs.json"), "utf8")))
			.toMatchObject({
				notificationSound: true,
				notificationVolume: 40,
				linkPreview: true,
				panelSide: "left",
				keepAwakeWhileWorking: true,
			});
		await page.keyboard.press("Escape");
		await expect(settings).toHaveCount(0);

		// Keep awake: held while the turn runs, released at once when the switch goes off.
		const input = page.locator("textarea").first();
		expect(await awake()).toBe(false);
		await input.fill("fixture running");
		await input.press("Enter");
		await expect.poll(awake).toBe(true);
		await fixtureCommand(page, await activeTab(page), "fixture:finish");
		await openGeneralSettings(page);
		await settings.locator("#setting-gui-keepAwakeWorking").getByRole("switch").click();
		await expect.poll(awake).toBe(false);
		await page.keyboard.press("Escape");
		await expect(settings).toHaveCount(0);

		// A web link in a reply opens in Preview, docked on the left, not in the browser.
		await input.fill("fixture reply actions");
		await input.press("Enter");
		const link = page.locator("[data-transcript-kind]").getByRole("link", { name: "the docs", exact: true });
		await link.click();
		const aside = page.locator("aside.omp-inspector");
		await expect(aside).toHaveAttribute("data-side", "left");
		await expect(page.getByLabel(text.previewUrl, { exact: true })).toHaveValue(/127\.0\.0\.1:9\/docs/);
		const asideBox = await aside.boundingBox();
		const workspaceBox = await page.locator(".omp-split-workspace").boundingBox();
		if (!asideBox || !workspaceBox) throw new Error("expected the panel and workspace boxes");
		// The panel takes the left edge beside the sidebar; the session workspace starts after it.
		expect(asideBox.x).toBeLessThan(workspaceBox.x);
		expect(await app.evaluate(() => Reflect.get(globalThis, "__openedUrls"))).toEqual([]);
		await capture(page, `preview-left-${language}-${theme}`);
		expect(errors).toEqual([]);
	});

	test(`a background tab's finished turn notifies with its prose and the chime; the banner brings it forward (${language}-${theme})`, async () => {
		const { app, page, errors } = await launch(language, theme, {
			notifications: true,
			notificationSound: true,
			notificationVolume: 60,
		});
		// Notifications fire only while the window is unfocused (see background-tabs.e2e.ts).
		await page.evaluate(() => {
			document.hasFocus = () => false;
		});
		await countChimeNotes(page);
		// Keep the banners in main instead of showing them; their click handlers stay real.
		await app.evaluate(({ Notification }) => {
			const shown: { title: string; body: string }[] = [];
			Reflect.set(globalThis, "__readNotifications", () => shown);
			Notification.prototype.show = function (this: InstanceType<typeof Notification>) {
				shown.push({ title: this.title, body: this.body });
				Reflect.set(globalThis, "__clickLastNotification", () => this.emit("click"));
			};
		});
		const shown = (): Promise<{ title: string; body: string }[]> =>
			app.evaluate(() => {
				const read = Reflect.get(globalThis, "__readNotifications");
				return typeof read === "function" ? read() : [];
			});

		const background = await activeTab(page);
		await nameTab(page, background, "Release checklist run");
		const input = page.locator("textarea").first();
		await input.fill("fixture running");
		await input.press("Enter");
		await openTab(page, "Front task");
		await expect.poll(async () => (await tabs(page)).find(tab => tab.tabId === background)?.status).toBe("running");
		// The background turn ends on a Markdown reply (fixture `MARKDOWN_REPLY`).
		await fixtureCommand(page, background, "fixture:finish:markdown");
		await expect.poll(async () => (await shown()).length).toBe(1);
		const [banner] = await shown();
		expect(banner.title).toBe("Release checklist run");
		expect(banner.body).toMatch(/^Release checklist\. Jump to the notes, open the plan, or write to the team\./);
		expect(banner.body).not.toMatch(/[#[\]*`|]|\]\(/);
		expect(banner.body.length).toBeLessThanOrEqual(160);
		await expect.poll(() => chimeNotes(page)).toBe(2);

		await app.evaluate(() => {
			const click = Reflect.get(globalThis, "__clickLastNotification");
			if (typeof click === "function") click();
		});
		await expect.poll(() => activeTab(page)).toBe(background);
		await expect(page.locator("[data-transcript-kind]").getByText("Release checklist").first()).toBeVisible();
		await capture(page, `notification-click-${language}-${theme}`);
		expect(errors).toEqual([]);
	});

	test(`⌃⇥ switches to recent tabs, ⌘[ ⌘] go back and forward, ⇧⌘A searches, reorders and closes (${language}-${theme})`, async () => {
		test.setTimeout(120_000);
		const { page, errors } = await launch(language, theme);
		const alpha = await activeTab(page);
		await nameTab(page, alpha, "Alpha");
		const beta = await openTab(page, "Beta");
		const gamma = await openTab(page, "Gamma");

		// Held ⌃: most recent first with the previous tab picked; each ⇥ moves on; releasing ⌃ switches.
		const switcher = page.getByRole("listbox", { name: text.switcher });
		await page.keyboard.down("Control");
		await page.keyboard.press("Tab");
		await expect(switcher).toBeVisible();
		await expect(switcher.getByRole("option")).toHaveText([/Gamma/, /Beta/, /Alpha/]);
		await expect(switcher.locator('[aria-selected="true"]')).toHaveAttribute("data-tab-id", beta);
		await page.keyboard.press("Tab");
		await expect(switcher.locator('[aria-selected="true"]')).toHaveAttribute("data-tab-id", alpha);
		await capture(page, `tab-switcher-${language}-${theme}`);
		await page.keyboard.up("Control");
		await expect(switcher).toHaveCount(0);
		await expect.poll(() => activeTab(page)).toBe(alpha);
		// ⌃⇥ again flips back to the tab before (⌃ released once the overlay shows).
		await page.keyboard.down("Control");
		await page.keyboard.press("Tab");
		await expect(switcher.locator('[aria-selected="true"]')).toHaveAttribute("data-tab-id", gamma);
		await page.keyboard.up("Control");
		await expect.poll(() => activeTab(page)).toBe(gamma);

		await page.keyboard.press(BACK);
		await expect.poll(() => activeTab(page)).toBe(alpha);
		await page.keyboard.press(FORWARD);
		await expect.poll(() => activeTab(page)).toBe(gamma);

		// ⇧⌘A: search picks Beta.
		const overview = page.getByRole("dialog", { name: text.overview });
		await pressShortcutUntilVisible(page, "Shift+ControlOrMeta+KeyA", overview);
		const rows = overview.locator('[role="option"]');
		await expect(rows).toHaveCount(3);
		await page.keyboard.type("bet");
		await expect(rows).toHaveCount(1);
		await page.keyboard.press("Enter");
		await expect(overview).toHaveCount(0);
		await expect.poll(() => activeTab(page)).toBe(beta);

		// Order view: Alpha moves down, so Beta takes ⌘1; Gamma closes from the list.
		await pressShortcutUntilVisible(page, "Shift+ControlOrMeta+KeyA", overview);
		await overview.getByRole("tab", { name: text.order, exact: true }).click();
		const row = (tabId: string) => overview.locator(`[role="option"][data-tab-id="${tabId}"]`);
		await row(alpha).getByRole("button", { name: text.moveDown, exact: true }).click();
		await expect(rows).toHaveText([/^1\s*Beta/, /^2\s*Alpha/, /^3\s*Gamma/]);
		await capture(page, `tab-overview-${language}-${theme}`);
		await row(gamma)
			.getByRole("button", { name: text.close("Gamma"), exact: true })
			.click();
		await expect(rows).toHaveCount(2);
		await expect.poll(async () => (await tabs(page)).length).toBe(2);
		await page.keyboard.press("Escape");
		await expect(overview).toHaveCount(0);
		await page.keyboard.press("ControlOrMeta+2");
		await expect.poll(() => activeTab(page)).toBe(alpha);
		await page.keyboard.press("ControlOrMeta+1");
		await expect.poll(() => activeTab(page)).toBe(beta);
		expect(errors).toEqual([]);
	});

	test(`⌥⌘ arrows and ⌥⌘] move the focus between split panes (${language}-${theme})`, async () => {
		const { app, page, errors } = await launch(language, theme);
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
		const left = await activeTab(page);
		await nameTab(page, left, "Left pane");
		const right = await openTab(page, "Right pane");

		// Drag the first tab's row onto the workspace's left half (split-drop.e2e.ts).
		const row = page.locator(`[data-session-path="tab:${left}"]`);
		const rowBox = await row.boundingBox();
		const box = await page.locator(".omp-split-workspace").boundingBox();
		if (!rowBox || !box) throw new Error("expected layout boxes");
		await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
		await page.mouse.down();
		await page.mouse.move(rowBox.x + rowBox.width / 2 + 20, rowBox.y + rowBox.height / 2, { steps: 4 });
		await page.mouse.move(box.x + box.width * 0.08 + 2, box.y + box.height * 0.5, { steps: 8 });
		await page.mouse.move(box.x + box.width * 0.08, box.y + box.height * 0.5, { steps: 2 });
		await expect(page.locator("[data-split-ghost]")).toHaveAttribute("data-split-ghost", "left");
		await page.mouse.up();
		await expect(page.locator(".omp-session-pane")).toHaveCount(2);

		await page.keyboard.press("Alt+ControlOrMeta+ArrowRight");
		await expect.poll(() => activeTab(page)).toBe(right);
		await page.keyboard.press("Alt+ControlOrMeta+ArrowLeft");
		await expect.poll(() => activeTab(page)).toBe(left);
		await capture(page, `pane-focus-${language}-${theme}`);
		await page.keyboard.press("Alt+ControlOrMeta+BracketRight");
		await expect.poll(() => activeTab(page)).toBe(right);
		await page.keyboard.press("Alt+ControlOrMeta+BracketLeft");
		await expect.poll(() => activeTab(page)).toBe(left);

		// Both panes read as selected in the sidebar; the focused one adds the cue.
		const selectedRows = page.locator('.omp-sidebar-session-row[data-active="true"]');
		await expect(selectedRows).toHaveCount(2);
		await expect(page.locator(`[data-session-path="tab:${left}"]`)).toHaveAttribute("data-pane-focus", "true");
		await expect(page.locator(`[data-session-path="tab:${right}"]`)).not.toHaveAttribute("data-pane-focus", "true");
		// A tab opened from outside shows alone (it never lands in a pane); ⌘1 on a pane brings the split back.
		const outside = await openTab(page, "Outside tab");
		await expect(page.locator(".omp-session-pane")).toHaveCount(1);
		await expect(selectedRows).toHaveCount(1);
		await expect(page.locator(`[data-session-path="tab:${outside}"]`)).toHaveAttribute("data-active", "true");
		await page.keyboard.press("ControlOrMeta+1");
		await expect(page.locator(".omp-session-pane")).toHaveCount(2);
		await expect.poll(() => activeTab(page)).toBe(left);
		await expect(selectedRows).toHaveCount(2);
		expect(errors).toEqual([]);
	});
}
