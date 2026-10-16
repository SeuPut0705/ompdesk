/**
 * Deleting sessions from the sidebar, code and chat alike, shared by the fake
 * omp (session-delete.e2e.ts) and the real one (real-session-delete.e2e.ts):
 * the session the focused tab shows (stock `drop_session`: the tab moves to a
 * fresh empty session), one a background tab has live, one a restored tab
 * holds without a process, and stored ones no tab holds. Each leaves the
 * sidebar and the disk, no stray row takes its place, and a relaunch brings
 * none back.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp } from "./harness";

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
const selectedMode = (page: Page) => page.locator(".omp-sidebar-controls [role=tab][aria-selected=true]");

async function deleteRow(page: Page, session: Seeded): Promise<void> {
	const row = page.locator(`.omp-sidebar-session-row[data-session-path="${session.file}"]`);
	await expect(row).toBeVisible();
	await row.hover();
	await row.locator('[aria-label="Delete session"]').click();
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(dialog).toHaveCount(0);
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

/** The tab now shows a session of its own, not the deleted one. */
async function expectFreshSession(page: Page, index: number, deleted: Seeded): Promise<void> {
	await expect
		.poll(async () => {
			const sessionPath = (await tabs(page))[index]?.sessionPath ?? "";
			return sessionPath.endsWith(".jsonl") && sessionPath !== deleted.file;
		})
		.toBe(true);
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
	const { desktop, project, work } = profile;
	await fs.mkdir(work, { recursive: true });
	const seed = async (id: string, cwd: string, title: string, chat = false): Promise<Seeded> => ({
		title,
		file: await seedSession(id, cwd, title, chat),
	});
	const active = await seed("01a11000-0000-7000-8000-0000000000a1", project, "Alpha active");
	const background = await seed("01a11000-0000-7000-8000-0000000000f1", project, "Foxtrot background");
	const asleep = await seed("01a11000-0000-7000-8000-0000000000b1", project, "Beta asleep");
	const stored = await seed("01a11000-0000-7000-8000-0000000000d1", project, "Delta stored");
	const chatActive = await seed("01a11000-0000-7000-8000-0000000000c1", work, "Gamma chat", true);
	const chatAsleep = await seed("01a11000-0000-7000-8000-0000000000c2", work, "Golf chat asleep", true);
	const chatStored = await seed("01a11000-0000-7000-8000-0000000000e1", work, "Echo chat stored", true);
	const deleted = [active, background, asleep, stored, chatActive, chatAsleep, chatStored];
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
						tab(asleep, "agent"),
						tab(chatActive, "chat"),
						tab(chatAsleep, "chat"),
					],
				},
			],
		}),
	);
	const args = [path.resolve("out/main/index.js"), `--user-data-dir=${desktop}`];
	let app: ElectronApplication | undefined;
	try {
		const first = await launch(args, profile.env);
		app = first.app;
		const { page } = first;
		const shot = (name: string) =>
			page.screenshot({ path: test.info().outputPath(`${name}.png`), animations: "disabled", scale: "css" });
		for (const session of [active, background, asleep, stored]) {
			await expect(page.locator(`.omp-sidebar-session-row[data-session-path="${session.file}"]`)).toBeVisible();
		}
		// The second tab gets its process, then focus goes back: it holds its session live in the background.
		await page.keyboard.press("ControlOrMeta+2");
		await expect.poll(async () => (await tabs(page))[1]?.status, { timeout: 60_000 }).toBe("ready");
		await page.keyboard.press("ControlOrMeta+1");
		await expect.poll(async () => (await tabs(page)).find(entry => entry.active)?.sessionPath).toBe(active.file);
		await shot("code-before");

		// The focused tab's own session: stock drop_session moves the tab to a fresh empty session.
		await deleteRow(page, active);
		await expectFreshSession(page, 0, active);
		// A tab with its process in the background moves to a fresh session too.
		await deleteRow(page, background);
		await expectFreshSession(page, 1, background);
		// A restored tab that never started: the stored file goes, and the tab forgets it.
		await deleteRow(page, asleep);
		await expect
			.poll(async () => {
				const forgotten = (await tabs(page))[2];
				return [forgotten?.sessionPath ?? null, forgotten?.sessionId ?? null, forgotten?.title ?? null];
			})
			.toEqual([null, null, null]);
		await deleteRow(page, stored);
		// One row per open code tab and nothing else: no stray "new session" rows pile up.
		await expect.poll(async () => (await rowsText(page)).length).toBe(3);
		await shot("code-after");

		// Chat: the focused chat, a restored chat tab, a stored chat.
		await page.keyboard.press("ControlOrMeta+4");
		await expect
			.poll(async () => (await tabs(page)).find(entry => entry.active)?.sessionPath, { timeout: 60_000 })
			.toBe(chatActive.file);
		await expect(selectedMode(page)).toHaveText("Chat");
		await deleteRow(page, chatActive);
		await expectFreshSession(page, 3, chatActive);
		await deleteRow(page, chatAsleep);
		await deleteRow(page, chatStored);
		await expect.poll(async () => (await rowsText(page)).length).toBe(2);
		await shot("chat-after");

		for (const session of deleted) await expect(fs.access(session.file)).rejects.toThrow();
		// The saved layout names none of them, so a relaunch cannot bring one back under a tab.
		await expect
			.poll(async () => {
				const saved = await fs.readFile(prefsPath, "utf8");
				return deleted.filter(session => saved.includes(session.title) || saved.includes(session.file));
			})
			.toEqual([]);
		await exitApp(app);
		app = undefined;

		const second = await launch(args, profile.env);
		app = second.app;
		const again = second.page;
		await expect.poll(async () => (await tabs(again)).length).toBe(5);
		for (const name of ["Code", "Chat"] as const) {
			await again.locator(".omp-sidebar-controls [role=tab]").filter({ hasText: name }).click();
			await expect(selectedMode(again)).toHaveText(name);
			// One row per tab of the mode, none of them a deleted session.
			await expect.poll(async () => (await rowsText(again)).length).toBe(name === "Code" ? 3 : 2);
			const text = (await rowsText(again)).join("\n");
			for (const session of deleted) expect(text).not.toContain(session.title);
		}
		for (const session of deleted) await expect(fs.access(session.file)).rejects.toThrow();
		await again.screenshot({ path: test.info().outputPath("relaunch.png"), animations: "disabled", scale: "css" });
	} finally {
		if (app) await exitApp(app);
	}
}
