import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { exitApp, fixtureOmp, pressShortcutUntilVisible } from "./harness";
import { capturer, type Finding, resize } from "./shell-capture";

// Opt-in flow audit of the app shell (OMP_GUI_SHELL_FLOWS=<dir>): multi-step
// real use instead of single screens. A sidebar with 120 stored sessions
// (filter, pin, rename, delete, by mouse and by keyboard), a keyboard-only walk
// through the whole window plus every remappable shortcut, the command palette's
// full list, toasts piling up, opening a project, splitting by drag and closing
// panes, a resize from maximized to the minimum, and the first run on the real
// omp up to the first answer from a local OpenAI-compatible endpoint.

const directory = process.env.OMP_GUI_SHELL_FLOWS;
test.describe.configure({ mode: "parallel" });
test.skip(!directory, "set OMP_GUI_SHELL_FLOWS=<dir> to capture the shell flows");

type Language = "en" | "ko";
const VARIANTS = [
	["en", "light"],
	["ko", "dark"],
] as const;

const WORDS = ["auth", "release", "sidebar", "docs", "billing", "search", "upload", "cache", "deploy", "theme"];

/** `count` stored sessions over three projects, newest first, a few with long titles. */
async function seedSessions(agent: string, projects: string[], count: number): Promise<void> {
	const dir = path.join(agent, "sessions", "fixture");
	await fs.mkdir(dir, { recursive: true });
	await Promise.all(
		Array.from({ length: count }, async (_, index) => {
			const cwd = projects[index % 5 === 4 ? 2 : index % 3 === 2 ? 1 : 0] ?? projects[0];
			const word = WORDS[index % WORDS.length];
			const title =
				index % 17 === 5
					? `Investigate why the ${word} workflow sometimes stalls on the Windows packaging step (${index})`
					: `Session ${String(index).padStart(3, "0")} · ${word}`;
			const time = new Date(Date.now() - (index * 37 + 3) * 60_000).toISOString();
			const id = `s-${String(index).padStart(3, "0")}`;
			const lines = [
				{ type: "title", v: 1, title, updatedAt: time },
				{ type: "session", version: 3, id, timestamp: time, cwd },
				{
					type: "message",
					id: "entry-1",
					parentId: null,
					timestamp: time,
					message: { role: "user", content: title, timestamp: Date.parse(time) },
				},
				{
					type: "message",
					id: "entry-2",
					parentId: "entry-1",
					timestamp: time,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Done." }],
						timestamp: Date.parse(time) + 1,
						stopReason: "stop",
					},
				},
			];
			const file = path.join(dir, `${id}.jsonl`);
			await fs.writeFile(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
			const stamp = new Date(time);
			await fs.utimes(file, stamp, stamp);
		}),
	);
}

interface Launched {
	app: ElectronApplication;
	page: Page;
	profile: string;
	project: string;
	projects: string[];
}

async function launch(
	language: Language,
	theme: string,
	options: { sessions?: number; real?: boolean } = {},
): Promise<Launched> {
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-shell-flows-")));
	const projects = ["project", "website", "api-server"].map(name => path.join(profile, name));
	const project = projects[0];
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([...projects, desktop, agent].map(dir => fs.mkdir(dir)));
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({
			language,
			themeName: theme,
			firstRunComplete: !options.real,
			...(options.real ? { launchProfiles: { [project]: { noRules: true, noLsp: true } } } : {}),
		}),
	);
	if (options.sessions) await seedSessions(agent, projects, options.sessions);
	const env: Record<string, string | undefined> = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_TEST_SESSION_FILES: "1",
	};
	if (options.real) Reflect.deleteProperty(env, "OMP_GUI_OMP");
	else env.OMP_GUI_OMP = await fixtureOmp(profile);
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
	});
	const page = await app.firstWindow();
	await resize(app, 1440, 900);
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 90_000 })
		.toBe("ready");
	return { app, page, profile, project, projects };
}

/** Run a flow with captures, findings and page errors written next to them. */
async function flow(
	name: string,
	language: Language,
	theme: string,
	options: { sessions?: number; real?: boolean },
	body: (
		context: Launched & { shoot: (name: string) => Promise<void>; findings: Finding[]; notes: string[] },
	) => Promise<void>,
): Promise<void> {
	const launched = await launch(language, theme, options);
	const findings: Finding[] = [];
	const notes: string[] = [];
	const errors: string[] = [];
	launched.page.on("pageerror", error => errors.push(error.message));
	const prefix = `${name}-${language}-${theme}`;
	try {
		await body({ ...launched, shoot: capturer(launched.page, directory, prefix, findings), findings, notes });
	} finally {
		if (directory)
			await fs.writeFile(
				path.join(directory, `${prefix}-findings.json`),
				JSON.stringify({ findings, notes, errors }, null, 2),
			);
		await exitApp(launched.app);
		await fs.rm(launched.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
}

/** The focused element, where it sits, and whether anything shows that it has focus. */
async function focusReport(page: Page) {
	return page.evaluate(() => {
		const element = document.activeElement;
		if (!element || element === document.body) return { lost: true as const };
		const html = element as HTMLElement;
		const name =
			element.getAttribute("aria-label") ??
			element.getAttribute("placeholder") ??
			(element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 50);
		const role = element.getAttribute("role") ?? element.tagName.toLowerCase();
		const box = element.getBoundingClientRect();
		const inView =
			box.width > 0 &&
			box.height > 0 &&
			box.bottom > 0 &&
			box.right > 0 &&
			box.top < innerHeight &&
			box.left < innerWidth;
		// Snapshot the look of the element, its two ancestors and first descendants
		// focused and blurred: no difference means focus is invisible.
		const watched = [
			element,
			element.parentElement,
			element.parentElement?.parentElement,
			...element.querySelectorAll("*"),
		]
			.filter((node): node is Element => node instanceof Element)
			.slice(0, 12);
		const look = () =>
			watched
				.map(node => {
					const style = getComputedStyle(node);
					return [
						style.outlineStyle,
						style.outlineWidth,
						style.outlineColor,
						style.boxShadow,
						style.backgroundColor,
						style.borderColor,
						style.color,
						style.opacity,
						style.textDecorationLine,
					].join("|");
				})
				.join("\n");
		const focused = look();
		html.blur();
		const blurred = look();
		html.focus();
		return {
			lost: false as const,
			role,
			name,
			x: Math.round(box.left),
			y: Math.round(box.top),
			inView,
			visible: focused !== blurred,
			restored: document.activeElement === element,
		};
	});
}

for (const [language, theme] of VARIANTS) {
	test(`sessions flow ${language}`, async () => {
		test.setTimeout(300_000);
		await flow("sessions", language, theme, { sessions: 120 }, async ({ page, shoot, notes, findings }) => {
			const sidebar = page.getByRole("complementary");
			const rows = page.locator("[data-session-path]");
			await expect.poll(() => rows.count(), { timeout: 30_000 }).toBeGreaterThan(40);
			await page.waitForTimeout(400);
			notes.push(`rows rendered at launch: ${await rows.count()}`);
			await shoot("loaded");
			// Expand every project, then scroll to the end of the list. Each click
			// re-renders the headers, so always take the first collapsed one afresh.
			const collapsed = sidebar.locator('[data-workspace-group] button[aria-expanded="false"]');
			for (let guard = 0; guard < 12 && (await collapsed.count()) > 0; guard++) await collapsed.first().click();
			await page.waitForTimeout(300);
			notes.push(`rows with every project expanded: ${await rows.count()}`);
			const list = sidebar.locator("[data-session-group]").last();
			await list.scrollIntoViewIfNeeded();
			await page.waitForTimeout(200);
			await shoot("scrolled-end");

			// Filter as the user types, then clear with Escape.
			const filter = sidebar.getByRole("searchbox").first();
			await filter.click();
			const typed = Date.now();
			await page.keyboard.type("release", { delay: 30 });
			await page.waitForTimeout(250);
			notes.push(`filter "release": ${await rows.count()} rows, ${Date.now() - typed} ms incl. typing`);
			await shoot("filter-release");
			await page.keyboard.press("Escape");
			await page.waitForTimeout(200);
			notes.push(
				`after Escape in filter: value="${await filter.inputValue()}" focus=${JSON.stringify(await focusReport(page))}`,
			);
			await filter.fill("");

			// Pin a session from far down the list, by mouse.
			const target = rows.filter({ hasText: "Session 040" }).first();
			await target.scrollIntoViewIfNeeded();
			await target.click({ button: "right" });
			await page.getByRole("menuitem", { name: /^(Pin to top|맨 위에 고정)$/ }).click();
			await page.waitForTimeout(300);
			await shoot("pinned");
			notes.push(`pinned row in view after pin: ${await target.isVisible()} y=${(await target.boundingBox())?.y}`);

			// Rename by keyboard: focus the list, arrow to a row, F2, type, Enter.
			const firstRow = rows.first();
			await firstRow.locator("button").first().focus();
			await page.keyboard.press("ArrowDown");
			await page.keyboard.press("ArrowDown");
			const before = await focusReport(page);
			notes.push(`roving focus before rename: ${JSON.stringify(before)}`);
			await page.keyboard.press("F2");
			await page.waitForTimeout(150);
			await shoot("rename-inline");
			await page.keyboard.type("Renamed by keyboard");
			await page.keyboard.press("Enter");
			await page.waitForTimeout(400);
			const afterRename = await focusReport(page);
			notes.push(`focus after rename commit: ${JSON.stringify(afterRename)}`);
			if (afterRename.lost)
				findings.push({ shot: "rename", kind: "focus-lost", detail: "focus fell to body after F2 rename" });
			await shoot("renamed");

			// Delete by keyboard: Delete key on the focused row, confirm with Enter.
			const deleteTarget = await focusReport(page);
			await page.keyboard.press("Delete");
			await page.waitForTimeout(250);
			await shoot("delete-confirm");
			const dialog = page.getByRole("dialog");
			notes.push(`delete dialog open: ${await dialog.isVisible()} focus=${JSON.stringify(await focusReport(page))}`);
			await dialog.getByRole("button", { name: /^(Delete|삭제)$/ }).click();
			await expect(dialog).toHaveCount(0);
			await page.waitForTimeout(500);
			const afterDelete = await focusReport(page);
			notes.push(`deleted ${JSON.stringify(deleteTarget)}; focus after: ${JSON.stringify(afterDelete)}`);
			if (afterDelete.lost)
				findings.push({
					shot: "delete",
					kind: "focus-lost",
					detail: "focus fell to body after deleting the focused row",
				});
			await shoot("deleted");

			// Context menu by keyboard (Shift+F10) on the focused row.
			await rows.nth(3).locator("button").first().focus();
			await page.keyboard.press("Shift+F10");
			await page.waitForTimeout(200);
			await shoot("menu-keyboard");
			notes.push(`menu focus: ${JSON.stringify(await focusReport(page))}`);
			await page.keyboard.press("Escape");
			await page.waitForTimeout(150);
			const afterMenu = await focusReport(page);
			notes.push(`focus after menu Escape: ${JSON.stringify(afterMenu)}`);
			if (afterMenu.lost)
				findings.push({
					shot: "menu",
					kind: "focus-lost",
					detail: "focus fell to body after closing the row menu",
				});

			// Open a stored session far down, then filter to it and open by Enter.
			await filter.fill("Session 077");
			await page.waitForTimeout(250);
			await filter.press("ArrowDown");
			notes.push(`ArrowDown from filter focus: ${JSON.stringify(await focusReport(page))}`);
			await page.keyboard.press("Enter");
			await page.waitForTimeout(800);
			await shoot("opened-from-filter");
			await filter.fill("");
			await page.waitForTimeout(300);
			await shoot("filter-cleared-after-open");
		});
	});

	test(`keyboard flow ${language}`, async () => {
		test.setTimeout(300_000);
		await flow("keyboard", language, theme, { sessions: 8 }, async ({ page, app, shoot, notes, findings }) => {
			const first = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId;
			if (!first) throw new Error("No active tab");
			await page.evaluate(
				id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:title:Keyboard walk" }),
				first,
			);
			await page.waitForTimeout(500);
			// Tab through the whole window from the top.
			await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
			const order: string[] = [];
			const seen = new Set<string>();
			for (let step = 0; step < 90; step++) {
				await page.keyboard.press("Tab");
				const report = await focusReport(page);
				if (report.lost) {
					order.push(`${step}: <body>`);
					continue;
				}
				const key = `${report.role}|${report.name}|${report.x}|${report.y}`;
				order.push(
					`${step}: ${report.role} "${report.name}" @${report.x},${report.y}${report.visible ? "" : " INVISIBLE"}${report.inView ? "" : " OFFSCREEN"}`,
				);
				if (!report.visible) findings.push({ shot: `tab-${step}`, kind: "focus-invisible", detail: key });
				if (!report.inView) findings.push({ shot: `tab-${step}`, kind: "focus-offscreen", detail: key });
				if (step % 6 === 0) await shoot(`tab-${step}`);
				if (seen.has(key)) break;
				seen.add(key);
			}
			notes.push(...order);

			// Every remappable shortcut at its default chord: something must change.
			const signature = () =>
				page.evaluate(() => {
					const dialogs = document.querySelectorAll('[role="dialog"]').length;
					const main = document.querySelector("main")?.innerText.length ?? 0;
					const aside = document.querySelectorAll("aside").length;
					const panes = document.querySelectorAll(".omp-session-pane").length;
					const toasts = document.querySelectorAll('[role="status"], [role="alert"]').length;
					const width = [...document.querySelectorAll("aside, [data-panel], section")]
						.map(node => Math.round(node.getBoundingClientRect().width))
						.join(",");
					return `${dialogs}|${main}|${aside}|${panes}|${toasts}|${width}|${location.hash}|${document.title}|${document.body.innerText.length}`;
				});
			const tabs = () => page.evaluate(() => window.omp.tabs.list());
			const settle = async () => {
				for (let i = 0; i < 3 && (await page.getByRole("dialog").count()) > 0; i++) {
					await page.keyboard.press("Escape");
					await page.waitForTimeout(150);
				}
			};
			const goHome = async () => {
				await settle();
				// Back to the session view from a page destination.
				const back = page.getByRole("button", { name: /^(Back to session|Back|세션으로 돌아가기|뒤로)$/ }).first();
				if (await back.isVisible().catch(() => false)) await back.click();
				await page.waitForTimeout(150);
			};
			const chords: [string, string][] = [
				["palette", "Meta+k"],
				["settings", "Meta+,"],
				["hotkeys", "Meta+/"],
				["sidebar.toggle", "Meta+b"],
				["sidebar.toggle-again", "Meta+b"],
				["panel.toggle", "Meta+j"],
				["panel.toggle-again", "Meta+j"],
				["model.select", "Alt+m"],
				["agents.hub", "Alt+a"],
				["pr.center", "Alt+p"],
				["tools.expand", "Control+o"],
				["thinking.toggle", "Control+t"],
				["plan.toggle", "Alt+Shift+p"],
				["retry", "Alt+r"],
				["dequeue", "Alt+ArrowUp"],
				["model.cycleForward", "Control+p"],
				["model.cycleBackward", "Control+Shift+p"],
				["tab.new", "Meta+t"],
				["tab.prev", "Control+Shift+Tab"],
				["tab.next", "Control+Tab"],
				["tab.newChat", "Meta+Shift+t"],
				["tab.close", "Meta+w"],
				["tab.newWorktree", "Alt+t"],
				["composer.history", "Control+r"],
			];
			for (const [action, chord] of chords) {
				if (action === "composer.history") await page.locator("textarea").first().focus();
				const beforeTabs = JSON.stringify((await tabs()).map(tab => [tab.tabId, tab.active]));
				const before = await signature();
				await page.keyboard.press(chord);
				await page.waitForTimeout(450);
				const after = await signature();
				const afterTabs = JSON.stringify((await tabs()).map(tab => [tab.tabId, tab.active]));
				await shoot(`key-${action}`);
				const changed = before !== after || beforeTabs !== afterTabs;
				notes.push(
					`${action} (${chord}): ${changed ? "changed" : "NO VISIBLE EFFECT"} focus=${JSON.stringify(await focusReport(page))}`,
				);
				if (!changed)
					findings.push({ shot: `key-${action}`, kind: "shortcut-no-effect", detail: `${action} ${chord}` });
				if (
					![
						"sidebar.toggle",
						"panel.toggle",
						"tools.expand",
						"thinking.toggle",
						"tab.new",
						"tab.prev",
						"tab.next",
					].includes(action)
				)
					await goHome();
			}
			// Panel views have no default chord; Escape returns from every overlay.
			await pressShortcutUntilVisible(page, "Meta+k", page.getByRole("dialog"));
			await page.keyboard.press("Escape");
			await expect(page.getByRole("dialog")).toHaveCount(0);
			notes.push(`focus after palette Escape: ${JSON.stringify(await focusReport(page))}`);
			await app.evaluate(() => undefined);
		});
	});

	test(`page focus flow ${language}`, async () => {
		test.setTimeout(180_000);
		await flow("page-focus", language, theme, { sessions: 8 }, async ({ page, app, shoot, notes, findings }) => {
			const composer = page.locator("textarea").first();
			const pages: [string, () => Promise<void>][] = [
				["settings", () => page.keyboard.press("Meta+,")],
				["agents", () => page.keyboard.press("Alt+a")],
				[
					"stats",
					async () => {
						await app.evaluate(({ BrowserWindow }) =>
							BrowserWindow.getAllWindows()[0]?.webContents.send("menu:action", { action: "open-stats" }),
						);
					},
				],
			];
			for (const [name, open] of pages) {
				for (const back of ["Escape", "button"] as const) {
					await composer.focus();
					const before = await focusReport(page);
					await open();
					await expect(
						page.locator(`section[data-destination="${name === "stats" ? "insights" : name}"]`),
					).toBeVisible();
					await page.waitForTimeout(600);
					const opened = await focusReport(page);
					await shoot(`${name}-${back}-opened`);
					if (back === "Escape") {
						// Escape inside a focused search field may clear it first.
						await page.keyboard.press("Escape");
						if (await page.locator("section[data-destination]").count()) await page.keyboard.press("Escape");
					} else
						await page
							.getByRole("button", { name: /^(Back to session|세션으로 돌아가기)$/ })
							.first()
							.click();
					await expect(page.locator("section[data-destination]")).toHaveCount(0);
					await page.waitForTimeout(300);
					const returned = await focusReport(page);
					await shoot(`${name}-${back}-returned`);
					notes.push(
						`${name} via ${back}: before=${JSON.stringify(before)} opened=${JSON.stringify(opened)} returned=${JSON.stringify(returned)}`,
					);
					if (opened.lost)
						findings.push({
							shot: `${name}-${back}-opened`,
							kind: "focus-lost",
							detail: `${name} page left focus on body`,
						});
					if (returned.lost || returned.role !== "textarea")
						findings.push({
							shot: `${name}-${back}-returned`,
							kind: "focus-not-restored",
							detail: `back from ${name} by ${back}: ${JSON.stringify(returned)}`,
						});
				}
			}
		});
	});

	test(`palette and toasts flow ${language}`, async () => {
		test.setTimeout(240_000);
		await flow("palette", language, theme, { sessions: 8 }, async ({ page, app, shoot, notes }) => {
			const dialog = page.getByRole("dialog");
			await pressShortcutUntilVisible(page, "Meta+k", dialog);
			await page.waitForTimeout(250);
			// Walk the full list with the keyboard and record every entry.
			const entries: string[] = [];
			let previous = "";
			for (let i = 0; i < 400; i++) {
				const current = await dialog
					.locator('[aria-selected="true"], [data-selected="true"]')
					.first()
					.innerText()
					.catch(() => "");
				if (i > 0 && current === previous) break;
				entries.push(current.replace(/\s+/g, " ").trim());
				previous = current;
				await page.keyboard.press("ArrowDown");
				if (i === 20 || i === 60) await shoot(`palette-scrolled-${i}`);
			}
			notes.push(`palette entries (${entries.length}):`, ...entries);
			if (directory)
				await fs.writeFile(
					path.join(directory, `palette-${language}-entries.json`),
					JSON.stringify(entries, null, 2),
				);
			await page.keyboard.press("Escape");
			await expect(dialog).toHaveCount(0);

			// Toasts: several different ones in quick succession, then a repeat.
			const composer = page.locator("textarea").first();
			await composer.focus();
			for (const chord of ["Alt+ArrowUp", "Alt+r", "Control+p", "Alt+ArrowUp", "Alt+ArrowUp"]) {
				await page.keyboard.press(chord);
				await page.waitForTimeout(120);
			}
			await page.waitForTimeout(300);
			await shoot("toasts-stack");
			notes.push(`toasts visible: ${await page.locator('[aria-live="polite"] > div').count()}`);
			await resize(app, 800, 600);
			await page.waitForTimeout(300);
			await shoot("toasts-min-window");
			await resize(app, 1440, 900);
			// Hover the first toast for 6 s: it must still be there to read.
			const firstToast = page.locator('[aria-live="polite"] > div').first();
			if (await firstToast.isVisible()) {
				await firstToast.hover();
				await page.waitForTimeout(6_000);
				notes.push(`toast still visible after 6 s hover: ${await firstToast.isVisible()}`);
				await shoot("toast-hovered-6s");
			}
		});
	});

	test(`workspace flow ${language}`, async () => {
		test.setTimeout(300_000);
		await flow(
			"workspace",
			language,
			theme,
			{ sessions: 12 },
			async ({ page, app, shoot, notes, projects, findings }) => {
				const tabs = () => page.evaluate(() => window.omp.tabs.list());
				const first = (await tabs()).find(tab => tab.active)?.tabId;
				if (!first) throw new Error("No active tab");
				await page.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:title:Refactor auth flow" }),
					first,
				);
				// Open another project through the native folder dialog (stubbed in main).
				await app.evaluate(({ dialog }, folder) => {
					dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
				}, projects[2]);
				await app.evaluate(({ BrowserWindow }) =>
					BrowserWindow.getAllWindows()[0]?.webContents.send("menu:action", { action: "open-project" }),
				);
				await page.waitForTimeout(1500);
				await shoot("project-opened");
				notes.push(
					`tabs after open-project: ${JSON.stringify((await tabs()).map(tab => [tab.cwd, tab.active, tab.status]))}`,
				);

				// The project opened into the same tab, a new session: the old title must
				// not stick to its row or pane while the title bar names the new one.
				const reused = (await tabs()).find(tab => tab.active)?.tabId;
				const staleTitle = await page
					.locator("[data-session-path]")
					.filter({ hasText: "Refactor auth flow" })
					.count();
				notes.push(`rows still titled "Refactor auth flow" after the project switch: ${staleTitle}`);
				if (staleTitle > 0)
					findings.push({
						shot: "project-opened",
						kind: "stale-title",
						detail: "old session title kept after open-project",
					});
				// Two more tabs by ⌘T; every tab titled so its sidebar row can be dragged.
				const titles = new Map<string, string>();
				if (reused) {
					titles.set(reused, "Refactor auth flow");
					await page.evaluate(
						id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:title:Refactor auth flow" }),
						reused,
					);
				}
				for (const title of ["Billing export", "Docs search"]) {
					const count = (await tabs()).length;
					await page.keyboard.press("Meta+t");
					await expect.poll(async () => (await tabs()).length).toBe(count + 1);
					await expect.poll(async () => (await tabs()).find(tab => tab.active)?.status).toBe("ready");
					const id = (await tabs()).find(tab => tab.active)?.tabId;
					if (!id) continue;
					titles.set(id, title);
					await page.evaluate(
						([tabId, name]) =>
							window.omp.rpc.commandForTab(tabId, { type: "bash", command: `fixture:title:${name}` }),
						[id, title] as const,
					);
				}
				await page.waitForTimeout(600);
				await shoot("three-tabs");
				notes.push(
					`tabs before splitting: ${JSON.stringify((await tabs()).map(tab => [tab.tabId.slice(-4), titles.get(tab.tabId), tab.active, tab.visible]))}`,
					`sidebar rows: ${JSON.stringify(await page.locator("[data-session-path]").evaluateAll(nodes => nodes.slice(0, 8).map(node => `${node.getAttribute("data-session-path")?.slice(-24)}=${(node.textContent ?? "").slice(0, 30)}`)))}`,
				);
				// A tab's row is keyed `tab:<id>` until its session has a file, then by that file.
				const rowOf = (tabId: string) => {
					const byTab = page.locator(`[data-session-path="tab:${tabId}"]`);
					const title = titles.get(tabId);
					return title ? byTab.or(page.locator("[data-session-path]").filter({ hasText: title })).first() : byTab;
				};
				// Fractions are of `within` (the whole workspace by default).
				const drag = async (
					tabId: string,
					fx: number,
					fy: number,
					within = page.locator(".omp-split-workspace"),
				) => {
					const row = rowOf(tabId);
					const rowBox = await row.boundingBox();
					const box = await within.boundingBox();
					if (!rowBox || !box) throw new Error(`no boxes for ${tabId}`);
					await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
					await page.mouse.down();
					await page.mouse.move(rowBox.x + rowBox.width / 2 + 20, rowBox.y + rowBox.height / 2, { steps: 4 });
					await page.mouse.move(box.x + box.width * fx + 2, box.y + box.height * fy, { steps: 10 });
					await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 2 });
					await shoot(`drag-${tabId.slice(-4)}`);
					await page.mouse.up();
					await page.waitForTimeout(500);
				};
				const hiddenFirst = (await tabs()).find(tab => !tab.visible);
				if (!hiddenFirst) throw new Error("no background tab to drag");
				await drag(hiddenFirst.tabId, 0.92, 0.5);
				await expect(page.locator(".omp-session-pane")).toHaveCount(2);
				await shoot("split-2");
				// A split adds to the pane under the cursor: aim at the left pane's bottom
				// edge. The workspace's own (0.5, 0.92) is the 5px divider between the two
				// columns, which takes no drop.
				const others = (await tabs()).filter(tab => !tab.visible);
				if (others[0]) await drag(others[0].tabId, 0.5, 0.92, page.locator("[data-split]").first());
				await expect(page.locator(".omp-session-pane")).toHaveCount(3);
				await shoot("split-3");
				// A visible pane's row dropped on another edge is refused: the layout stays.
				const visibleOther = (await tabs()).find(tab => tab.visible && !tab.active);
				if (visibleOther) {
					await drag(visibleOther.tabId, 0.08, 0.5);
					await shoot("split-moved");
					notes.push(
						`panes after dragging a visible pane to the left edge: ${await page.locator(".omp-session-pane").count()} order=${JSON.stringify(await page.locator(".omp-session-pane").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-tab-id")?.slice(-4))))}`,
					);
				}

				// Keyboard resize of a divider, then close panes one by one with the ×, then ⌘W.
				const divider = page.getByRole("separator").first();
				await divider.focus();
				await page.keyboard.press("ArrowRight");
				await page.keyboard.press("ArrowRight");
				await page.waitForTimeout(200);
				await shoot("divider-keyboard");
				notes.push(`divider focus: ${JSON.stringify(await focusReport(page))}`);
				const closeButtons = page.getByRole("button", {
					name: /^(Remove this pane from split view|분할 보기에서 이 창 제거)$/,
				});
				notes.push(`pane close buttons: ${await closeButtons.count()}`);
				if ((await closeButtons.count()) > 0) {
					await closeButtons.first().focus();
					await page.keyboard.press("Enter");
					await page.waitForTimeout(400);
					const afterClose = await focusReport(page);
					notes.push(`focus after closing a pane by keyboard: ${JSON.stringify(afterClose)}`);
					if (afterClose.lost)
						findings.push({
							shot: "pane-close",
							kind: "focus-lost",
							detail: "focus fell to body after closing a pane",
						});
					await shoot("pane-closed");
				}
				await page.keyboard.press("Meta+w");
				await page.waitForTimeout(500);
				await shoot("after-meta-w");
				notes.push(
					`after ⌘W: panes=${await page.locator(".omp-session-pane").count()} tabs=${(await tabs()).length} focus=${JSON.stringify(await focusReport(page))}`,
				);

				// Re-split, open the right panel, then resize from maximized to the minimum.
				const hidden = (await tabs()).filter(tab => !tab.visible);
				if (hidden[0]) await drag(hidden[0].tabId, 0.92, 0.5);
				await page.keyboard.press("Meta+j");
				await page.waitForTimeout(400);
				await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.maximize());
				await page.waitForTimeout(600);
				await shoot("maximized");
				for (const [width, height] of [
					[1280, 800],
					[1024, 720],
					[900, 640],
					[800, 600],
					[640, 480],
				] as const) {
					await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.unmaximize());
					await resize(app, width, height);
					await page.waitForTimeout(400);
					const actual = await page.evaluate(() => `${innerWidth}x${innerHeight}`);
					notes.push(`requested ${width}x${height}, got ${actual}`);
					await shoot(`size-${width}x${height}`);
				}
				await resize(app, 1440, 900);
			},
		);
	});

	test(`first message flow ${language}`, async () => {
		test.setTimeout(240_000);
		// A local OpenAI-compatible endpoint: every chat completion streams one short answer.
		const requests: string[] = [];
		const server = http.createServer((request, response) => {
			let body = "";
			request.on("data", chunk => {
				body += chunk;
			});
			request.on("end", () => {
				requests.push(`${request.method} ${request.url} ${body.slice(0, 120)}`);
				if (!request.url?.includes("chat/completions")) {
					response.writeHead(200, { "content-type": "application/json" });
					response.end(JSON.stringify({ object: "list", data: [{ id: "audit-model", object: "model" }] }));
					return;
				}
				response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
				const chunk = (delta: object, finish: string | null) =>
					`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "audit-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
				const words = ["Hello! ", "I'm ", "the ", "audit ", "model ", "and ", "I ", "can ", "hear ", "you."];
				let index = 0;
				response.write(chunk({ role: "assistant", content: "" }, null));
				const timer = setInterval(() => {
					if (index < words.length) {
						response.write(chunk({ content: words[index++] }, null));
						return;
					}
					clearInterval(timer);
					response.write(chunk({}, "stop"));
					response.write(
						`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "audit-model", choices: [], usage: { prompt_tokens: 12, completion_tokens: 10, total_tokens: 22 } })}\n\n`,
					);
					response.end("data: [DONE]\n\n");
				}, 120);
			});
		});
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		try {
			await flow("first-message", language, theme, { real: true }, async ({ page, shoot, notes }) => {
				const setup = page.locator("section[aria-label], [role=region]").first();
				await expect(setup).toBeVisible({ timeout: 60_000 });
				await page.waitForTimeout(400);
				await shoot("setup");
				notes.push(`setup focus at start: ${JSON.stringify(await focusReport(page))}`);
				await page
					.getByRole("button", { name: /^(Add custom endpoint|엔드포인트 직접 추가)$/ })
					.first()
					.click();
				await page.getByLabel(/^(Provider ID|프로바이더 ID)/).fill("audit-local");
				await page.getByLabel(/^(Base URL|기본 URL)/).fill(`http://127.0.0.1:${port}/v1`);
				await page.getByRole("textbox", { name: /^(API key|API 키)/ }).fill("sk-audit");
				await page
					.getByLabel(/^(Model ID|모델 ID)/)
					.first()
					.fill("audit-model");
				await page.getByRole("button", { name: /^(Add provider|프로바이더 추가)$/ }).click();
				await expect(page.getByRole("radiogroup")).toBeVisible({ timeout: 30_000 });
				await shoot("model-step");
				await page.getByRole("button", { name: /^(Start with this model|이 모델로 시작)$/ }).click();
				await page.waitForTimeout(800);
				await shoot("ready-to-type");
				const focus = await focusReport(page);
				notes.push(`focus after setup: ${JSON.stringify(focus)}`);
				const composer = page.locator("textarea").first();
				await expect(composer).toBeVisible();
				if (!focus.lost && focus.role === "textarea") await page.keyboard.type("Say hello in one sentence.");
				else await composer.fill("Say hello in one sentence.");
				await page.keyboard.press("Enter");
				await page.waitForTimeout(500);
				await shoot("streaming");
				await expect(page.getByText("I can hear you.", { exact: false }).first()).toBeVisible({ timeout: 60_000 });
				await page.waitForTimeout(1500);
				await shoot("answered");
				notes.push(`focus after the answer: ${JSON.stringify(await focusReport(page))}`);
				notes.push(...requests.map(line => `request: ${line}`));
			});
		} finally {
			server.close();
		}
	});
}
