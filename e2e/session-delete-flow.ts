/**
 * Deleting sessions, code and chat alike, shared by the fake omp
 * (session-delete.e2e.ts) and the real one (real-session-delete.e2e.ts). A
 * deleted session's tab closes as closing a tab does — a split pane, a live
 * background tab, a restored tab that never started, the focused tab — and
 * the window's last tab gives way to the empty start tab. No session takes
 * a deleted one's place: no "New session" row appears, no header-only
 * session file is written, and a relaunch brings nothing back. Deletes go
 * through the row's trash button, its context menu and the composer's
 * `/delete`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { cssString, exitApp } from "./harness";

export interface DeleteProfile {
	desktop: string;
	project: string;
	agent: string;
	/** The GUI's chat workspace (default-workspace.ts): `<agent>/../work`. */
	work: string;
	env: Record<string, string>;
}

/** Writes one stored session with a title and one exchange; returns its file. */
export type SeedSession = (id: string, cwd: string, title: string, chat: boolean) => Promise<string>;

interface Seeded {
	title: string;
	file: string;
}

const rowsText = (page: Page) => page.locator(".omp-sidebar-session-row").allTextContents();
const tabs = (page: Page) => page.evaluate(() => window.omp.tabs.list());
const tabPaths = async (page: Page) => (await tabs(page)).map(tab => tab.sessionPath ?? null);
/** The rows of the projects' groups: chats follow them in the same list, in their own section. */
const codeRowsText = (page: Page) => page.locator("[data-session-group] .omp-sidebar-session-row").allTextContents();
const rowOf = (page: Page, session: Seeded) =>
	page.locator(`.omp-sidebar-session-row[data-session-path=${cssString(session.file)}]`);

/** Every `.jsonl` under `dir`: a session file (stock's lock files are not). */
async function sessionFiles(dir: string): Promise<string[]> {
	const entries = await fs.readdir(dir, { recursive: true }).catch(() => []);
	return entries.filter(name => name.endsWith(".jsonl")).sort();
}

async function expectGone(page: Page, session: Seeded): Promise<void> {
	await expect
		.poll(() =>
			fs.access(session.file).then(
				() => "present",
				() => "gone",
			),
		)
		.toBe("gone");
	await expect.poll(async () => (await rowsText(page)).join("\n")).not.toContain(session.title);
}

async function confirmDialog(page: Page): Promise<void> {
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(dialog).toHaveCount(0);
}

/** The row's ⋯ menu → Delete. */
async function deleteByTrash(page: Page, session: Seeded): Promise<void> {
	const row = rowOf(page, session);
	await expect(row).toBeVisible();
	await row.hover();
	await row.locator("[data-sidebar-row-menu]").click();
	await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
	await confirmDialog(page);
	await expectGone(page, session);
}

/** The row's context menu (right click) → Delete. */
async function deleteByMenu(page: Page, session: Seeded): Promise<void> {
	const row = rowOf(page, session);
	await expect(row).toBeVisible();
	await row.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
	await confirmDialog(page);
	await expectGone(page, session);
}

async function launch(args: string[], env: Record<string, string>): Promise<{ app: ElectronApplication; page: Page }> {
	// `OMP_GUI_TEST_APP`: a packaged OMPdesk instead of this checkout's build (as real-core.e2e.ts).
	const executablePath = process.env.OMP_GUI_TEST_APP;
	const app = await electron.launch({
		...(executablePath ? { executablePath } : {}),
		args: executablePath ? args.slice(1) : args,
		env,
	});
	const page = await app.firstWindow();
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 90_000 })
		.toBe("ready");
	return { app, page };
}

export async function deleteSessionsEndToEnd(profile: DeleteProfile, seedSession: SeedSession): Promise<void> {
	const { desktop, project, work, agent } = profile;
	await fs.mkdir(work, { recursive: true });
	const seed = async (id: string, cwd: string, title: string, chat = false): Promise<Seeded> => ({
		title,
		file: await seedSession(id, cwd, title, chat),
	});
	const active = await seed("01a11000-0000-7000-8000-0000000000a1", project, "Alpha active");
	const background = await seed("01a11000-0000-7000-8000-0000000000f1", project, "Foxtrot background");
	const pane = await seed("01a11000-0000-7000-8000-0000000000a2", project, "Hotel split pane");
	const asleep = await seed("01a11000-0000-7000-8000-0000000000b1", project, "Beta asleep");
	const stored = await seed("01a11000-0000-7000-8000-0000000000d1", project, "Delta stored");
	const chatActive = await seed("01a11000-0000-7000-8000-0000000000c1", work, "Gamma chat", true);
	const chatAsleep = await seed("01a11000-0000-7000-8000-0000000000c2", work, "Golf chat asleep", true);
	const chatStored = await seed("01a11000-0000-7000-8000-0000000000e1", work, "Echo chat stored", true);
	const deleted = [active, background, pane, asleep, stored, chatActive, chatAsleep, chatStored];
	const sessionsRoot = path.join(agent, "sessions");
	const tab = (session: Seeded, kind: "agent" | "chat") => ({
		cwd: kind === "chat" ? work : project,
		kind,
		sessionPath: session.file,
		title: session.title,
	});
	// Restored tabs: only the active one gets a process at launch.
	const prefsPath = path.join(desktop, "prefs.json");
	const prefs = JSON.parse(await fs.readFile(prefsPath, "utf8").catch(() => "{}")) as Record<string, unknown>;
	await fs.writeFile(
		prefsPath,
		JSON.stringify({
			...prefs,
			language: "en",
			firstRunComplete: true,
			tabLayouts: [
				{
					version: 1,
					activeIndex: 0,
					tabs: [
						tab(active, "agent"),
						tab(background, "agent"),
						tab(pane, "agent"),
						tab(asleep, "agent"),
						tab(chatActive, "chat"),
						tab(chatAsleep, "chat"),
					],
				},
			],
		}),
	);
	const args = [path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"), `--user-data-dir=${desktop}`];
	let app: ElectronApplication | undefined;
	try {
		const first = await launch(args, profile.env);
		app = first.app;
		const { page } = first;
		const shot = (name: string) =>
			page.screenshot({ path: test.info().outputPath(`${name}.png`), animations: "disabled", scale: "css" });
		for (const session of [active, background, pane, asleep, stored])
			await expect(rowOf(page, session)).toBeVisible();
		// The second and third tabs get their processes, then focus goes back: they hold their sessions live.
		for (const [key, index] of [
			["ControlOrMeta+2", 1],
			["ControlOrMeta+3", 2],
		] as const) {
			await page.keyboard.press(key);
			await expect.poll(async () => (await tabs(page))[index]?.status, { timeout: 60_000 }).toBe("ready");
		}
		await page.keyboard.press("ControlOrMeta+1");
		await expect.poll(async () => (await tabs(page)).find(entry => entry.active)?.sessionPath).toBe(active.file);
		// The third session joins the focused one in a split (the row menu's Split right).
		await rowOf(page, pane).click({ button: "right" });
		await page.getByRole("menuitem", { name: "Split right", exact: true }).click();
		await expect.poll(async () => (await tabs(page)).filter(entry => entry.visible).length).toBe(2);
		await shot("code-before");

		// A split pane's session: the pane closes, the split dissolves, the focused session stays.
		await deleteByMenu(page, pane);
		await expect
			.poll(() => tabPaths(page))
			.toEqual([active.file, background.file, asleep.file, chatActive.file, chatAsleep.file]);
		await expect.poll(async () => (await tabs(page)).filter(entry => entry.visible).length).toBe(1);
		// A live background tab closes too.
		await deleteByTrash(page, background);
		await expect.poll(() => tabPaths(page)).toEqual([active.file, asleep.file, chatActive.file, chatAsleep.file]);
		// A restored tab that never started.
		await deleteByMenu(page, asleep);
		await expect.poll(() => tabPaths(page)).toEqual([active.file, chatActive.file, chatAsleep.file]);
		// A stored session no tab holds.
		await deleteByTrash(page, stored);
		// The focused tab's own session: its tab closes and its neighbor takes focus; nothing starts.
		await deleteByMenu(page, active);
		await expect.poll(() => tabPaths(page)).toEqual([chatActive.file, chatAsleep.file]);
		await expect.poll(async () => (await tabs(page)).find(entry => entry.active)?.sessionPath).toBe(chatActive.file);
		// No code tab is left, and no "New session" row took any deleted session's place.
		await expect.poll(async () => (await codeRowsText(page)).length).toBe(0);
		await shot("code-after");

		// Chat: a restored chat tab, a stored chat, then the focused chat through the composer's /delete.
		await deleteByTrash(page, chatAsleep);
		await expect.poll(() => tabPaths(page)).toEqual([chatActive.file]);
		await deleteByMenu(page, chatStored);
		// `/delete` asks with the page's own `window.confirm`; the test answers it the way the user does.
		await page.evaluate(() => {
			window.confirm = () => true;
		});
		await page.locator("textarea").first().fill("/delete");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await expectGone(page, chatActive);
		// The window's last tab gave way to the empty start tab: no session, no row, nothing on disk.
		await expect
			.poll(async () => (await tabs(page)).map(entry => ({ placeholder: entry.placeholder === true })))
			.toEqual([{ placeholder: true }]);
		await expect.poll(async () => (await rowsText(page)).length).toBe(0);
		await shot("chat-after");

		for (const session of deleted) await expect(fs.access(session.file)).rejects.toThrow();
		// No session file at all: none replaced a deleted one, header-only or otherwise.
		await expect.poll(() => sessionFiles(sessionsRoot)).toEqual([]);
		// The saved layout names none of them, so a relaunch cannot bring one back under a tab.
		await expect
			.poll(async () => {
				const saved = await fs.readFile(prefsPath, "utf8");
				return deleted.filter(session => saved.includes(session.title) || saved.includes(session.file));
			})
			.toEqual([]);
		await exitApp(app);
		app = undefined;
		// Stale state that still names deleted sessions, as another window, a paired phone's layout or a crash
		// mid-turn leaves it: a saved tab and an interrupted-turn marker. Neither may bring a tab back.
		const saved = JSON.parse(await fs.readFile(prefsPath, "utf8")) as Record<string, unknown>;
		await fs.writeFile(
			prefsPath,
			JSON.stringify({
				...saved,
				tabLayouts: [{ version: 1, activeIndex: 0, tabs: [tab(background, "agent"), tab(chatAsleep, "chat")] }],
			}),
		);
		await fs.writeFile(
			path.join(desktop, "interrupted-turns.json"),
			JSON.stringify([
				{
					window: 1,
					tab: "stale",
					sessionPath: active.file,
					cwd: project,
					kind: "agent",
					startedAt: Date.now(),
					reason: "running",
				},
			]),
		);

		const second = await launch(args, profile.env);
		app = second.app;
		const again = second.page;
		await expect
			.poll(async () => (await tabs(again)).map(entry => ({ placeholder: entry.placeholder === true })))
			.toEqual([{ placeholder: true }]);
		await expect.poll(async () => (await rowsText(again)).length).toBe(0);
		for (const session of deleted) await expect(fs.access(session.file)).rejects.toThrow();
		expect(await sessionFiles(sessionsRoot)).toEqual([]);
		await again.screenshot({ path: test.info().outputPath("relaunch.png"), animations: "disabled", scale: "css" });
	} finally {
		if (app) await exitApp(app);
	}
}
