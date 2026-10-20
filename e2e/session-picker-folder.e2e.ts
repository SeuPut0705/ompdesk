/**
 * Picking a stored session of another folder from the session picker (⇧⌘F, also `/resume`). Stock's RPC
 * `switch_session` refuses a session recorded in another folder (`{cancelled: true}`, which the fake omp mirrors), so
 * an in-place switch did nothing; the pick opens it as a tab in its own folder, as a sidebar row does. A session of
 * the tab's own folder still switches in place. The rule is unit-tested in hooks/use-session-switch.test.ts.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import { exitApp, launchApp } from "./harness";

let app: ElectronApplication | undefined;
let root = "";

test.afterEach(async () => {
	if (app) await exitApp(app);
	app = undefined;
	if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A stored session in the fake omp's journal format: header and one exchange. */
async function seed(agent: string, id: string, cwd: string, title: string): Promise<string> {
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

async function pick(page: Page, title: string): Promise<void> {
	const option = page.getByRole("option").filter({ hasText: title });
	// On a loaded runner the first ⇧⌘F right after "ready" opened no picker (nightly 39467829687; the cause is not
	// known, nothing covered the window). Press again while no dialog is open, and note it in the report, so a press
	// the app keeps dropping still shows up.
	let presses = 0;
	await expect(async () => {
		if (!(await page.getByRole("dialog").isVisible())) {
			presses++;
			await page.keyboard.press("ControlOrMeta+Shift+F");
		}
		await expect(option).toBeVisible({ timeout: 5_000 });
	}).toPass({ timeout: 30_000 });
	if (presses > 1) test.info().annotations.push({ type: "picker-presses", description: `${title}: ${presses}` });
	await option.click();
}

const tabs = (page: Page) => page.evaluate(() => window.omp.tabs.list());

test("a session from another folder picked in the session picker opens as a tab in its own folder", async () => {
	test.setTimeout(120_000);
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-picker-folder-")));
	const [project, other, desktop, agent] = ["project", "other", "desktop", "agent"].map(name => path.join(root, name));
	await Promise.all([project, other, desktop, agent].map(dir => fs.mkdir(dir)));
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const elsewhere = await seed(agent, "other-1", other, "Work in the other folder");
	const here = await seed(agent, "here-1", project, "Work in this folder");
	app = await launchApp({ project, desktop, agent, profile: root, env: { OMP_GUI_TEST_SESSION_FILES: "1" } });
	const page = await app.firstWindow();
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
	const [first] = await tabs(page);

	// A session of the focused tab's own folder switches that tab in place: no new tab.
	await pick(page, "Work in this folder");
	await expect
		.poll(async () => (await tabs(page)).find(tab => tab.tabId === first?.tabId)?.sessionPath, { timeout: 30_000 })
		.toBe(here);
	expect((await tabs(page)).length).toBe(1);

	// One recorded in another folder opens as its own tab there (stock refuses it in place).
	await pick(page, "Work in the other folder");
	await expect
		.poll(async () => (await tabs(page)).find(tab => tab.sessionPath === elsewhere)?.cwd, { timeout: 30_000 })
		.toBe(other);
	expect((await tabs(page)).length).toBe(2);

	// "Open in new window" of another folder's session (the tree, a fork) starts that window in the session's folder,
	// where its boot switch is not refused, and the window shows that session.
	const third = await seed(agent, "other-2", other, "More work in the other folder");
	expect(await page.evaluate(file => window.omp.sessions.openInNewWindow({ sessionPath: file }), third)).toBe(true);
	await expect.poll(() => app?.windows().length, { timeout: 30_000 }).toBe(2);
	const second = app.windows().find(win => win !== page);
	await second?.waitForFunction(() => window.omp?.tabs != null);
	const opened = () => second?.evaluate(() => window.omp.tabs.list());
	await expect.poll(async () => (await opened())?.[0]?.cwd, { timeout: 30_000 }).toBe(other);
	await expect.poll(async () => (await opened())?.[0]?.sessionPath, { timeout: 30_000 }).toBe(third);
});
