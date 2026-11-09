/**
 * Selecting a session row selects that session and moves no row (the owner's report, 9 Nov 2026: a click reshuffled
 * the list and the clicked session was not the one shown). Real clicks on the built app with the fake omp, over a
 * plain project row and an archived row, whose place used to depend on whether a tab held it (a loose child's did
 * the same; `sidebar-rows.test.ts` covers every such row). Every order the list draws between a click and its settled
 * tab is recorded, not only the last one, and the painted order is read too.
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
	root = "";
});

/** A stored session in the fake omp's journal format. */
async function seed(agent: string, id: string, cwd: string, title: string, minutesAgo: number): Promise<void> {
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
}

declare global {
	interface Window {
		__orders?: string[];
	}
}

/** The local list's rows in DOM order, by section and session file name: project rows and archived rows. */
const ORDER_JS = () =>
	[...document.querySelectorAll("[data-session-group] [data-session-path], [data-archived-list] [data-session-path]")]
		.map(
			row =>
				`${row.closest("[data-archived-list]") ? "archived" : "project"}:${row.getAttribute("data-session-path")?.split("/").at(-1)}`,
		)
		.join(" | ");

/** Starts recording every distinct order the list draws, from now on. */
async function recordOrders(page: Page): Promise<void> {
	await page.evaluate(`(() => {
		const read = ${ORDER_JS.toString()};
		const seen = [read()];
		new MutationObserver(() => {
			const order = read();
			if (order !== seen.at(-1)) seen.push(order);
		}).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
		window.__orders = seen;
	})()`);
}

/** The same rows by where they are painted, top to bottom: a row a glide left out of place would show here. */
const paintedOrder = (page: Page) =>
	page.evaluate(() =>
		[
			...document.querySelectorAll(
				"[data-session-group] [data-session-path], [data-archived-list] [data-session-path]",
			),
		]
			.map(row => ({
				name: `${row.closest("[data-archived-list]") ? "archived" : "project"}:${row.getAttribute("data-session-path")?.split("/").at(-1)}`,
				top: row.getBoundingClientRect().top,
			}))
			.toSorted((a, b) => a.top - b.top)
			.map(row => row.name)
			.join(" | "),
	);

test("selecting a session row selects it and moves no row, an archived one's included", async () => {
	test.setTimeout(120_000);
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidebar-select-")));
	const [project, desktop, agent] = ["project", "desktop", "agent"].map(name => path.join(root, name));
	await Promise.all([project, desktop, agent].map(dir => fs.mkdir(dir)));
	await seed(agent, "s-1", project, "Alpha plan", 1);
	await seed(agent, "s-2", project, "Bravo plan", 2);
	await seed(agent, "s-3", project, "Charlie plan", 3);
	await seed(agent, "s-4", project, "Delta plan", 4);
	await seed(agent, "s-5", project, "Echo plan", 5);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", firstRunComplete: true, sidebar: { archivedSessions: ["s-5"] } }),
	);
	app = await launchApp({ project, desktop, agent, profile: root, env: { OMP_GUI_TEST_SESSION_FILES: "1" } });
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");

	const rowOf = (id: string) => page.locator(`[data-session-path$="/${id}.jsonl"]`).first();
	await page.locator("[data-sidebar-archived] button[aria-expanded]").first().click();
	const order = "project:s-1.jsonl | project:s-2.jsonl | project:s-3.jsonl | project:s-4.jsonl | archived:s-5.jsonl";
	await expect.poll(() => page.evaluate(ORDER_JS)).toBe(order);

	// The untouched start tab takes the first pick, every later pick opens a tab of its own, then back to open ones.
	for (const id of ["s-3", "s-5", "s-2", "s-5", "s-3"]) {
		await recordOrders(page);
		await rowOf(id).locator("button").first().click();
		await expect(rowOf(id)).toHaveAttribute("data-active", "true");
		// The tab the click opened or focused has its session and its omp answered: whatever it changes has happened.
		await expect
			.poll(async () =>
				(await page.evaluate(() => window.omp.tabs.list())).some(
					tab => tab.sessionPath?.endsWith(`/${id}.jsonl`) && tab.status === "ready",
				),
			)
			.toBe(true);
		await expect(rowOf(id)).toHaveAttribute("data-active", "true");
		await expect(
			page.locator('[data-session-group] [data-active="true"], [data-archived-list] [data-active="true"]'),
		).toHaveCount(1);
		expect(await page.evaluate(() => window.__orders), `orders drawn after selecting ${id}`).toEqual([order]);
		await expect.poll(() => paintedOrder(page), `painted order after selecting ${id}`).toBe(order);
	}
	// Each pick is one line of the runtime log, so a report of a list that moved can be read back.
	await expect
		.poll(async () =>
			(await page.evaluate(() => window.omp.runtime.logTail(200))).filter(
				line => line.includes('"source":"sidebar"') && line.includes('"message":"select"'),
			),
		)
		.toHaveLength(5);
});
