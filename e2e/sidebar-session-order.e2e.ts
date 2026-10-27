/**
 * A session row is dragged to a new place in its project's list and the place is remembered (AGENTS.md › Sidebar
 * projects, `sessionOrder`); the same row, open in a tab, still splits when it is dropped on a pane's edge.
 * Real mouse drags on the built app with the fake omp; `OMP_GUI_SESSION_ORDER=<dir>` writes before/after captures.
 * The ordering rules are unit-tested in `Sidebar.test.tsx`.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { ElectronApplication, Locator, Page } from "playwright";
import { captureTo, exitApp, launchApp } from "./harness";

const SHOTS = process.env.OMP_GUI_SESSION_ORDER;

let app: ElectronApplication | undefined;
let root = "";

test.afterEach(async () => {
	if (app) await exitApp(app);
	app = undefined;
	if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	root = "";
});

/** A stored session in the fake omp's journal format; `minutesAgo` sets where the default (newest first) order puts it. */
async function seed(agent: string, id: string, cwd: string, title: string, minutesAgo: number): Promise<string> {
	const file = path.join(agent, "sessions", "seeded", `${id}.jsonl`);
	await fs.mkdir(path.dirname(file), { recursive: true });
	const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
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

const titles = (page: Page) =>
	page
		.locator("[data-session-group] .omp-sidebar-session-row")
		// A row's button also carries screen-reader words after a comma (", Open").
		.evaluateAll(rows => rows.map(row => row.querySelector("button")?.textContent?.split(",")[0]?.trim() ?? ""));

/** A real mouse drag from the middle of one box to the middle of another; the last nudge settles dragover on it. */
async function dragBetween(page: Page, from: Locator, to: Locator): Promise<void> {
	const a = await from.boundingBox();
	const b = await to.boundingBox();
	if (!a || !b) throw new Error("expected both boxes");
	await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
	await page.mouse.down();
	await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2, { steps: 4 });
	await page.mouse.move(b.x + b.width / 2 + 2, b.y + b.height / 2, { steps: 10 });
	await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 2 });
}
test("a dragged session row keeps its new place across a relaunch, and still splits on a pane edge", async () => {
	test.setTimeout(180_000);
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-order-")));
	const [project, desktop, agent] = ["project", "desktop", "agent"].map(name => path.join(root, name));
	await Promise.all([project, desktop, agent].map(dir => fs.mkdir(dir)));
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	await seed(agent, "s-1", project, "Alpha plan", 1);
	await seed(agent, "s-2", project, "Bravo plan", 2);
	await seed(agent, "s-3", project, "Charlie plan", 3);
	const launch = () => launchApp({ project, desktop, agent, profile: root, env: { OMP_GUI_TEST_SESSION_FILES: "1" } });

	app = await launch();
	let page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");

	const rows = () => page.locator("[data-session-group] .omp-sidebar-session-row");
	await expect.poll(() => titles(page)).toEqual(["Alpha plan", "Bravo plan", "Charlie plan"]);
	await captureTo(SHOTS, page, "before");

	// The last row dropped on the first lands above it.
	await dragBetween(page, rows().nth(2), rows().nth(0));
	await expect(rows().nth(0)).toHaveAttribute("data-session-drop", "before");
	await captureTo(SHOTS, page, "during");
	await page.mouse.up();
	await expect.poll(() => titles(page)).toEqual(["Charlie plan", "Alpha plan", "Bravo plan"]);
	await expect(page.locator("[data-session-drop]")).toHaveCount(0);
	await captureTo(SHOTS, page, "after");

	// The order is in the prefs file, and a relaunch draws it again: a session new since then is on top, the rest stay.
	await expect
		.poll(async () => {
			const prefs = JSON.parse(await fs.readFile(path.join(desktop, "prefs.json"), "utf8"));
			return Object.values(prefs.sidebar?.sessionOrder ?? {}).flat();
		})
		.toHaveLength(3);
	await exitApp(app);
	await seed(agent, "s-4", project, "Delta plan", 0);
	app = await launch();
	page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
	await expect.poll(() => titles(page)).toEqual(["Delta plan", "Charlie plan", "Alpha plan", "Bravo plan"]);

	// An open session that is not on screen still drags onto a pane's edge: the split, not a reorder.
	await rows().filter({ hasText: "Charlie plan" }).locator("button").first().click();
	await rows().filter({ hasText: "Alpha plan" }).locator("button").first().click();
	const tabs = () => page.evaluate(() => window.omp.tabs.list());
	await expect.poll(async () => (await tabs()).some(tab => tab.sessionPath?.endsWith("s-3.jsonl"))).toBe(true);
	const order = await titles(page);
	const charlie = rows().filter({ hasText: "Charlie plan" });
	const workspace = await page.locator(".omp-split-workspace").boundingBox();
	if (!workspace) throw new Error("expected the workspace box");
	const ghost = page.locator("[data-split-ghost]");
	// The sidebar redraws its rows while the opened sessions settle, and a row replaced between the press and the
	// first move starts no drag: a drag that shows no ghost is released over the workspace and begun again.
	await expect(async () => {
		const rowBox = await charlie.boundingBox();
		if (!rowBox) throw new Error("expected the row's box");
		await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
		await page.mouse.down();
		await page.mouse.move(rowBox.x + rowBox.width / 2 + 20, rowBox.y + rowBox.height / 2, { steps: 4 });
		await page.mouse.move(workspace.x + workspace.width * 0.92 + 2, workspace.y + workspace.height * 0.5, {
			steps: 10,
		});
		await page.mouse.move(workspace.x + workspace.width * 0.92, workspace.y + workspace.height * 0.5, { steps: 2 });
		try {
			await expect(ghost).toHaveAttribute("data-split-ghost", "right", { timeout: 1_500 });
		} catch (error) {
			await page.mouse.up();
			throw error;
		}
	}).toPass({ timeout: 30_000 });
	await page.mouse.up();
	await expect(page.locator(".omp-session-pane")).toHaveCount(2);
	await expect(page.locator('.omp-sidebar-session-row[data-active="true"]')).toHaveCount(2);
	// The split moved no row.
	expect(await titles(page)).toEqual(order);
});
