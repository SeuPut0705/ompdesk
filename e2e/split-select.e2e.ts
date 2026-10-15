/**
 * Split selection end to end on the fake omp, with three panes:
 *  1. while a split shows several sessions every one of them is selected in the
 *     sidebar (the focused pane adds a quiet cue);
 *  2. a click on a session outside the split leaves it and shows that session
 *     alone, full width — it never takes over a pane;
 *  3. a click on a session that was in the split brings the split back as it
 *     was (sessions, positions, sizes) with the clicked session focused;
 *  4. the remembered split survives a relaunch.
 * Also ⌘-number jumps, the tab overview, ⌃⇥ and the session picker follow the
 * same pick rules. Captures in light/dark × en/ko go to
 * `OMP_GUI_SPLIT_SELECT_CAPTURES` (default: the test output directory).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp, pressShortcutUntilVisible } from "./harness";

const NAMES = ["Alpha", "Beta", "Gamma", "Delta"] as const;
const OVERVIEW = { en: "Tab overview", ko: "탭 개요" } as const;
const SWITCHER = { en: "Open tabs, most recent first", ko: "열린 탭, 최근 순" } as const;

const RUNS = [
	["en", "light"],
	["en", "dark"],
	["ko", "light"],
	["ko", "dark"],
] as const;

interface Launched {
	app: ElectronApplication;
	page: Page;
	errors: string[];
}

async function launch(root: string, language: string, theme: string, restore = false): Promise<Launched> {
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([
		fs.mkdir(project, { recursive: true }),
		fs.mkdir(desktop, { recursive: true }),
		fs.mkdir(agent, { recursive: true }),
	]);
	// A relaunch keeps the profile it ran on.
	await fs
		.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language, themeName: theme, firstRunComplete: true }),
			{ flag: "wx" },
		)
		.catch(() => undefined);
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(root),
		// Stock-shaped session files: the layout only restores saved sessions.
		OMP_GUI_TEST_SESSION_FILES: "1",
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		// A launch with a folder opens just that folder; a bare launch restores the saved session.
		args: [path.resolve("out/main/index.js"), ...(restore ? [] : [project]), `--user-data-dir=${desktop}`],
		env,
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page, errors };
}

const tabList = (page: Page) => page.evaluate(() => window.omp.tabs.list());

async function activeTab(page: Page) {
	const active = (await tabList(page)).find(tab => tab.active);
	if (!active) throw new Error("No active tab");
	return active;
}

/** The row's main button: the click target that opens the session. */
const rowOf = (page: Page, title: string) => page.locator(".omp-sidebar-session-row", { hasText: title });
const pick = (page: Page, title: string) => rowOf(page, title).locator("button[data-roving-item]").click();

/** Give a tab a saved session (one turn) and a title its sidebar row shows. */
async function makeSession(page: Page, tabId: string, title: string): Promise<void> {
	await page.evaluate(([id, message]) => window.omp.rpc.commandForTab(id, { type: "prompt", message }), [
		tabId,
		`Work on ${title}`,
	] as const);
	await expect
		.poll(async () => {
			const tab = (await tabList(page)).find(entry => entry.tabId === tabId);
			return tab?.status === "ready" ? (tab.sessionPath ?? "") : "";
		})
		.toMatch(/\.jsonl$/);
	await page.evaluate(([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }), [
		tabId,
		`fixture:title:${title}`,
	] as const);
	await expect(rowOf(page, title)).toBeVisible();
}

async function openSession(page: Page, title: string): Promise<string> {
	const before = (await tabList(page)).map(tab => tab.tabId);
	await page.keyboard.press("ControlOrMeta+t");
	await expect.poll(async () => (await tabList(page)).length).toBe(before.length + 1);
	const created = (await tabList(page)).find(tab => !before.includes(tab.tabId));
	if (!created) throw new Error("No new tab");
	await expect.poll(async () => (await tabList(page)).find(tab => tab.tabId === created.tabId)?.status).toBe("ready");
	await expect.poll(async () => (await activeTab(page)).tabId).toBe(created.tabId);
	await makeSession(page, created.tabId, title);
	return created.tabId;
}

/** Drag a session's sidebar row onto a spot (fx/fy within `target`'s box) of the workspace and drop it. */
async function dragOnto(page: Page, title: string, target: Locator, fx: number, fy: number, placement: string) {
	const rowBox = await rowOf(page, title).boundingBox();
	const pane = await target.boundingBox();
	if (!rowBox || !pane) throw new Error("expected drag boxes");
	await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
	await page.mouse.down();
	await page.mouse.move(rowBox.x + rowBox.width / 2 + 20, rowBox.y + rowBox.height / 2, { steps: 4 });
	await page.mouse.move(pane.x + pane.width * fx + 2, pane.y + pane.height * fy, { steps: 12 });
	await page.mouse.move(pane.x + pane.width * fx, pane.y + pane.height * fy, { steps: 2 });
	await expect(page.locator("[data-split-ghost]")).toHaveAttribute("data-split-ghost", placement);
	await page.mouse.up();
}

/**
 * Each tab's name: the title of its sidebar row, found through the session file. A
 * relaunched tab has no live title yet, but its row (the session index) does.
 */
async function namesByTab(page: Page): Promise<Map<string, string>> {
	const rows = await page.locator(".omp-sidebar-session-row").evaluateAll(elements =>
		elements.map(element => ({
			path: element.getAttribute("data-session-path") ?? "",
			text: element.textContent ?? "",
		})),
	);
	const named = (await tabList(page)).flatMap(tab => {
		const name = NAMES.find(candidate =>
			rows.some(row => row.path === tab.sessionPath && row.text.includes(candidate)),
		);
		return name ? [[tab.tabId, name] as const] : [];
	});
	return new Map(named);
}

async function activeName(page: Page): Promise<string | undefined> {
	return (await namesByTab(page)).get((await activeTab(page)).tabId);
}

/** Where every pane sits, by session name (tab ids change across a relaunch). */
async function layout(page: Page) {
	const names = await namesByTab(page);
	const panes = await page.locator(".omp-session-pane").evaluateAll(elements =>
		elements.map(element => {
			const box = element.getBoundingClientRect();
			return {
				tabId: (element as HTMLElement).dataset.tabId ?? "",
				x: Math.round(box.x),
				y: Math.round(box.y),
				width: Math.round(box.width),
				height: Math.round(box.height),
			};
		}),
	);
	return panes
		.map(({ tabId, ...box }) => ({ title: names.get(tabId) ?? tabId, ...box }))
		.sort((a, b) => a.title.localeCompare(b.title));
}

/** Rows selected in the sidebar, by title. */
async function selectedRows(page: Page, titles: readonly string[]) {
	const selected: string[] = [];
	for (const title of titles) {
		if ((await rowOf(page, title).getAttribute("data-active")) === "true") selected.push(title);
	}
	return selected;
}

for (const [language, theme] of RUNS) {
	test(`${language === "en" && theme === "light" ? "@smoke " : ""}a split's sessions are all selected; outside picks are solo; members restore it, across a relaunch (${language}-${theme})`, async () => {
		test.setTimeout(240_000);
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-split-select-")));
		const captures = process.env.OMP_GUI_SPLIT_SELECT_CAPTURES;
		if (captures) await fs.mkdir(captures, { recursive: true });
		let launched = await launch(root, language, theme);
		const capture = async (stage: string) => {
			const file = `split-select-${stage}-${language}-${theme}.png`;
			await launched.page.screenshot({
				path: captures ? path.join(captures, file) : test.info().outputPath(file),
				animations: "disabled",
				scale: "css",
			});
		};
		const names = ["Alpha", "Beta", "Gamma", "Delta"] as const;
		try {
			let page = launched.page;
			const first = (await activeTab(page)).tabId;
			await makeSession(page, first, "Alpha");
			await openSession(page, "Beta");
			await openSession(page, "Gamma");
			await openSession(page, "Delta");

			// Three panes: Delta over Beta on the left, Alpha on the right; Gamma stays outside.
			await dragOnto(page, "Alpha", page.locator(".omp-split-workspace"), 0.92, 0.5, "right");
			await expect(page.locator(".omp-session-pane")).toHaveCount(2);
			await dragOnto(page, "Beta", page.locator("[data-split]").first(), 0.5, 0.92, "bottom");
			await expect(page.locator(".omp-session-pane")).toHaveCount(3);
			// A resized split: the saved sizes come back too.
			await page.getByRole("separator").first().focus();
			for (let step = 0; step < 3; step++) await page.keyboard.press("ArrowRight");
			const members = ["Alpha", "Beta", "Delta"];
			const before = await layout(page);
			expect(before.map(pane => pane.title)).toEqual(members);

			// 1. Every session of the split is selected; the focused pane adds its cue.
			expect(await selectedRows(page, names)).toEqual(members);
			await expect(rowOf(page, "Gamma")).not.toHaveAttribute("data-active", "true");
			// Beta was dropped last, so its pane has the focus.
			await expect(page.locator('.omp-sidebar-session-row[data-pane-focus="true"]')).toHaveCount(1);
			await expect(rowOf(page, "Beta")).toHaveAttribute("data-pane-focus", "true");
			await capture("1-all-selected");

			// 2. A session outside the split shows alone, full width.
			await pick(page, "Gamma");
			await expect(page.locator(".omp-session-pane")).toHaveCount(1);
			await expect.poll(() => activeName(page)).toBe("Gamma");
			expect(await selectedRows(page, names)).toEqual(["Gamma"]);
			await expect(page.locator('.omp-sidebar-session-row[data-pane-focus="true"]')).toHaveCount(0);
			const alone = await layout(page);
			expect(alone).toHaveLength(1);
			const workspace = await page.locator(".omp-split-workspace").boundingBox();
			if (!workspace) throw new Error("expected workspace box");
			expect(alone[0]?.width).toBeGreaterThanOrEqual(Math.round(workspace.width) - 2);
			await capture("2-outside-solo");

			// 3. A member brings the split back exactly, the clicked session focused.
			await pick(page, "Beta");
			await expect(page.locator(".omp-session-pane")).toHaveCount(3);
			expect(await layout(page)).toEqual(before);
			await expect.poll(() => activeName(page)).toBe("Beta");
			expect(await selectedRows(page, names)).toEqual(members);
			await capture("3-member-restores");

			// ⌘-number follows the same rules: a session outside is solo, a member restores.
			await page.keyboard.press("ControlOrMeta+3");
			await expect(page.locator(".omp-session-pane")).toHaveCount(1);
			await expect.poll(() => activeName(page)).toBe("Gamma");
			await page.keyboard.press("ControlOrMeta+1");
			await expect(page.locator(".omp-session-pane")).toHaveCount(3);
			await expect.poll(() => activeName(page)).toBe("Alpha");
			expect(await layout(page)).toEqual(before);

			// The tab overview picks like a click: Gamma alone, then the split back with Delta focused.
			const overview = page.getByRole("dialog", { name: OVERVIEW[language] });
			await pressShortcutUntilVisible(page, "Shift+ControlOrMeta+KeyA", overview);
			await page.keyboard.type("Gamma");
			await expect(overview.locator('[role="option"]')).toHaveCount(1);
			await page.keyboard.press("Enter");
			await expect(overview).toHaveCount(0);
			await expect(page.locator(".omp-session-pane")).toHaveCount(1);
			await pressShortcutUntilVisible(page, "Shift+ControlOrMeta+KeyA", overview);
			await page.keyboard.type("Delta");
			await expect(overview.locator('[role="option"]')).toHaveCount(1);
			await page.keyboard.press("Enter");
			await expect(overview).toHaveCount(0);
			await expect(page.locator(".omp-session-pane")).toHaveCount(3);
			await expect.poll(() => activeName(page)).toBe("Delta");
			expect(await layout(page)).toEqual(before);

			// ⌃⇥ picks the same way: ⇥ moves the pick to Gamma (alone), then to Beta (the split back); releasing ⌃ commits.
			const switcher = page.getByRole("listbox", { name: SWITCHER[language] });
			for (const [title, panes] of [
				["Gamma", 1],
				["Beta", 3],
			] as const) {
				const target = [...(await namesByTab(page))].find(([, name]) => name === title)?.[0];
				await page.keyboard.down("Control");
				await page.keyboard.press("Tab");
				await expect(switcher).toBeVisible();
				const picked = switcher.locator('[aria-selected="true"]');
				for (let step = 0; step < 4 && (await picked.getAttribute("data-tab-id")) !== target; step++) {
					await page.keyboard.press("Tab");
				}
				await expect(picked).toHaveAttribute("data-tab-id", target ?? "");
				await capture(`switcher-${title.toLowerCase()}`);
				await page.keyboard.up("Control");
				await expect(switcher).toHaveCount(0);
				await expect(page.locator(".omp-session-pane")).toHaveCount(panes);
				await expect.poll(() => activeName(page)).toBe(title);
			}
			expect(await layout(page)).toEqual(before);

			// 4. Leave to Gamma, relaunch: the remembered split is still there.
			await pick(page, "Gamma");
			await expect(page.locator(".omp-session-pane")).toHaveCount(1);
			await exitApp(launched.app);
			launched = await launch(root, language, theme, true);
			page = launched.page;
			await expect(page.locator(".omp-session-pane")).toHaveCount(1);
			await expect.poll(() => activeName(page)).toBe("Gamma");
			expect(await selectedRows(page, names)).toEqual(["Gamma"]);
			await pick(page, "Alpha");
			await expect(page.locator(".omp-session-pane")).toHaveCount(3);
			await expect.poll(() => activeName(page)).toBe("Alpha");
			expect(await layout(page)).toEqual(before);
			expect(await selectedRows(page, names)).toEqual(members);
			await capture("4-relaunch-restored");
			expect(launched.errors).toEqual([]);
		} finally {
			await exitApp(launched.app);
			await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});
}

/** What a pane's composer shows: its placeholder against the room the field has, and whether its toolbar overflows. */
async function composerFit(page: Page) {
	return page.locator(".omp-session-pane").evaluateAll(panes =>
		panes.map(pane => {
			const field = pane.querySelector<HTMLTextAreaElement>(".omp-composer-input");
			if (!field) return { placeholder: 0, room: 0, overflow: -1 };
			const style = getComputedStyle(field);
			const context = document.createElement("canvas").getContext("2d");
			if (context) context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
			const room = field.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
			const surface = field.closest(".omp-composer-shell") ?? field.parentElement;
			return {
				placeholder: Math.ceil(context?.measureText(field.placeholder).width ?? 0),
				room: Math.floor(room),
				overflow: surface ? surface.scrollWidth - surface.clientWidth : -1,
			};
		}),
	);
}

for (const [language, theme] of RUNS) {
	test(`a true 2x2 split: all four sessions selected, composers fit, normal and narrow (${language}-${theme})`, async () => {
		test.setTimeout(240_000);
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-split-2x2-")));
		const captures = process.env.OMP_GUI_SPLIT_SELECT_CAPTURES;
		if (captures) await fs.mkdir(captures, { recursive: true });
		const launched = await launch(root, language, theme);
		const { app, page } = launched;
		const capture = async (stage: string) => {
			const file = `split-2x2-${stage}-${language}-${theme}.png`;
			await page.screenshot({
				path: captures ? path.join(captures, file) : test.info().outputPath(file),
				animations: "disabled",
				scale: "css",
			});
		};
		try {
			const first = (await activeTab(page)).tabId;
			await makeSession(page, first, "Alpha");
			await openSession(page, "Beta");
			await openSession(page, "Gamma");
			await openSession(page, "Delta");
			// Alpha | Beta on top, Gamma under Alpha, Delta under Beta: the four panes form a grid.
			// Delta is focused when the drags begin: Delta | Alpha on top, Beta under Delta, Gamma under Alpha.
			await dragOnto(page, "Alpha", page.locator(".omp-split-workspace"), 0.92, 0.5, "right");
			await expect(page.locator(".omp-session-pane")).toHaveCount(2);
			await dragOnto(page, "Beta", page.locator("[data-split]").first(), 0.5, 0.92, "bottom");
			await expect(page.locator(".omp-session-pane")).toHaveCount(3);
			await dragOnto(page, "Gamma", page.locator("[data-split]").nth(2), 0.5, 0.92, "bottom");
			await expect(page.locator(".omp-session-pane")).toHaveCount(4);
			const boxes = await layout(page);
			expect(new Set(boxes.map(pane => pane.x)).size).toBe(2);
			expect(new Set(boxes.map(pane => pane.y)).size).toBe(2);
			expect(await selectedRows(page, NAMES)).toEqual([...NAMES]);
			await capture("1-wide");
			// Wide: every placeholder fits its field.
			for (const fit of await composerFit(page)) {
				expect(fit.placeholder, JSON.stringify(fit)).toBeLessThanOrEqual(fit.room);
				expect(fit.overflow, JSON.stringify(fit)).toBeLessThanOrEqual(0);
			}
			await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(820, 860));
			await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(820);
			await capture("2-narrow");
			const narrow = await composerFit(page);
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
			for (const fit of narrow) {
				expect(fit.placeholder, JSON.stringify(fit)).toBeLessThanOrEqual(fit.room);
				expect(fit.overflow, JSON.stringify(fit)).toBeLessThanOrEqual(0);
			}
			// A running turn adds the steer chip and Stop beside Send: the field's own hint and the
			// toolbar still fit a 2x2 pane at this width, with a draft that has a queue prefix badge too.
			const pane = page.locator(".omp-session-pane").first();
			const field = pane.locator(".omp-composer-input");
			await field.fill("fixture stream");
			await field.press("Enter");
			const stop = pane.getByRole("button", { name: new RegExp(`^${language === "ko" ? "중단" : "Stop"}`) });
			await expect(stop).toBeVisible({ timeout: 30_000 });
			await field.fill("-> then run the checks");
			await capture("3-narrow-streaming");
			for (const fit of await composerFit(page)) {
				expect(fit.placeholder, JSON.stringify(fit)).toBeLessThanOrEqual(fit.room);
				expect(fit.overflow, JSON.stringify(fit)).toBeLessThanOrEqual(0);
			}
			await field.fill("");
			await expect(field).toHaveAttribute(
				"placeholder",
				language === "ko" ? "추가 지시 입력…" : "Add an instruction…",
			);
			await stop.click();
			await expect(stop).toHaveCount(0);
			expect(launched.errors).toEqual([]);
		} finally {
			await exitApp(app);
			await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});
}
