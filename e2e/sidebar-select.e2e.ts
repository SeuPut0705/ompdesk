/**
 * Selecting a session row selects that session and moves no row (the owner's report, 9 Nov 2026: a click reshuffled
 * the list and the clicked session was not the one shown, on the MacBook's paired-device section). Real clicks on
 * the built app with the fake omp, over a plain project row, an archived row and a loose child (a session an agent
 * opened whose opener row is not listed), whose place used to depend on whether a tab held it
 * (`sidebar-rows.test.ts` covers every such row). Three lists: this computer's own, a paired computer's section of a
 * host's sessions, and the drawer of a phone page the computer serves. Every order the list draws between a click
 * and its settled tab is recorded, not only the last one, and the painted order is read too.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { type Browser, chromium, devices, expect, type Locator, test } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import { wrapAgentMessage } from "../src/shared/agent-control";
import { fixtureTailscale } from "./fixture/fake-tailscale-install";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { cssString, exitApp, fixtureOmp, launchApp } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, type RemoteInstance } from "./remote-harness";

let app: ElectronApplication | undefined;
let browser: Browser | undefined;
let proxy: ServeProxy | undefined;
let root = "";

test.afterEach(async () => {
	await browser?.close().catch(() => undefined);
	browser = undefined;
	await proxy?.close().catch(() => undefined);
	proxy = undefined;
	if (app) await exitApp(app);
	app = undefined;
	if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	root = "";
});

interface SeedShape {
	/** The first message is this agent brief from a session no list holds: the session reads as opened by an agent. */
	brief?: string;
	/** The last reply ended in an error: the index lists the session as `error`, one that needs a look. */
	failed?: boolean;
}

/** A stored session in the fake omp's journal format. */
async function seed(
	agent: string,
	id: string,
	cwd: string,
	title: string,
	minutesAgo: number,
	shape: SeedShape = {},
): Promise<void> {
	const file = path.join(agent, "sessions", "seeded", `${id}.jsonl`);
	await fs.mkdir(path.dirname(file), { recursive: true });
	const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
	const lines = [
		{ type: "title", v: 1, title, updatedAt: at },
		{ type: "session", version: 3, id, timestamp: at, cwd },
		{
			type: "message",
			id: `${id}-1`,
			parentId: null,
			timestamp: at,
			message: {
				role: "user",
				content: shape.brief === undefined ? title : wrapAgentMessage(shape.brief, "Ghost opener"),
			},
		},
		{
			type: "message",
			id: `${id}-2`,
			parentId: `${id}-1`,
			timestamp: at,
			message: shape.failed
				? { role: "assistant", content: [], stopReason: "error", errorMessage: "429 usage limit reached" }
				: { role: "assistant", content: [{ type: "text", text: `${title} answer` }] },
		},
	];
	await fs.writeFile(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
}

/**
 * Lists the fake omp's index of `bin` with stock's error rule (sidebar-select-store.ts): a loose child that needs a
 * look is one whose last reply failed, and the fixture index alone reads only `complete` or `pending`.
 */
async function installErrorIndex(bin: string): Promise<void> {
	const store = pathToFileURL(path.resolve("e2e/sidebar-select-store.ts")).href;
	await fs.writeFile(
		path.join(path.dirname(bin), "node_modules", "@oh-my-pi", "pi-coding-agent", "session-store.ts"),
		`export * from ${JSON.stringify(store)};\n`,
	);
}

declare global {
	interface Window {
		__orders?: string[];
		__painted?: string[];
	}
}

/** Where a list's session rows are: inside `scope`, the rows `rows` matches (every row names its session file). */
interface Lists {
	scope: string;
	rows: string;
}

/** This computer's own list: project rows, loose children and archived rows. */
const LOCAL: Lists = {
	scope: "body",
	rows: "[data-session-group] [data-session-path], [data-archived-list] [data-session-path]",
};

/**
 * The list's rows in DOM order, by section and session file name: project rows, loose children and archived rows.
 * Empty while the list is not on screen (a phone's drawer is closed after a pick).
 */
const ORDER_JS = (lists: Lists) =>
	[...(document.querySelector(lists.scope)?.querySelectorAll(lists.rows) ?? [])]
		.map(row => {
			const section = row.closest("[data-archived-list]")
				? "archived"
				: row.closest("[data-sidebar-loose-children]")
					? "loose"
					: "project";
			const file = (row.getAttribute("data-device-session") ?? row.getAttribute("data-session-path"))?.split(
				/[\\/]/,
			);
			return `${section}:${file?.at(-1)}`;
		})
		.join(" | ");

/** The same rows by where they are painted, top to bottom: a row a glide left out of place would show here. */
const PAINTED_JS = (lists: Lists) =>
	[...(document.querySelector(lists.scope)?.querySelectorAll(lists.rows) ?? [])]
		.map(row => {
			const section = row.closest("[data-archived-list]")
				? "archived"
				: row.closest("[data-sidebar-loose-children]")
					? "loose"
					: "project";
			const file = (row.getAttribute("data-device-session") ?? row.getAttribute("data-session-path"))?.split(
				/[\\/]/,
			);
			return { name: `${section}:${file?.at(-1)}`, top: row.getBoundingClientRect().top };
		})
		.toSorted((a, b) => a.top - b.top)
		.map(row => row.name)
		.join(" | ");

const orderOf = (page: Page, lists: Lists) => page.evaluate(ORDER_JS, lists);
const paintedOrder = (page: Page, lists: Lists) => page.evaluate(PAINTED_JS, lists);

/**
 * Starts recording every distinct order the list draws, from now on: the DOM order at every mutation and the painted
 * order at every frame, while the list is on screen.
 */
async function recordOrders(page: Page, lists: Lists): Promise<void> {
	await page.evaluate(`(() => {
		const read = ${ORDER_JS.toString()};
		const paint = ${PAINTED_JS.toString()};
		const lists = ${JSON.stringify(lists)};
		const seen = [read(lists)];
		const painted = [];
		const note = (found, order) => {
			if (order && order !== found.at(-1)) found.push(order);
		};
		new MutationObserver(() => {
			note(seen, read(lists));
			note(painted, paint(lists));
		}).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
		const frame = () => {
			note(painted, paint(lists));
			requestAnimationFrame(frame);
		};
		requestAnimationFrame(frame);
		window.__orders = seen;
		window.__painted = painted;
	})()`);
}

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

	const rowOf = (id: string) => page.locator(`[data-session-path$="${id}.jsonl"]`).first();
	await page.locator("[data-sidebar-archived] button[aria-expanded]").first().click();
	const order = "project:s-1.jsonl | project:s-2.jsonl | project:s-3.jsonl | project:s-4.jsonl | archived:s-5.jsonl";
	await expect.poll(() => orderOf(page, LOCAL)).toBe(order);

	// The untouched start tab takes the first pick, every later pick opens a tab of its own, then back to open ones.
	for (const id of ["s-3", "s-5", "s-2", "s-5", "s-3"]) {
		await recordOrders(page, LOCAL);
		await rowOf(id).locator("button").first().click();
		await expect(rowOf(id)).toHaveAttribute("data-active", "true");
		// The tab the click opened or focused has its session and its omp answered: whatever it changes has happened.
		await expect
			.poll(async () =>
				(await page.evaluate(() => window.omp.tabs.list())).some(
					tab => tab.sessionPath?.split(/[\\/]/).at(-1) === `${id}.jsonl` && tab.status === "ready",
				),
			)
			.toBe(true);
		await expect(rowOf(id)).toHaveAttribute("data-active", "true");
		await expect(
			page.locator('[data-session-group] [data-active="true"], [data-archived-list] [data-active="true"]'),
		).toHaveCount(1);
		expect(await page.evaluate(() => window.__orders), `orders drawn after selecting ${id}`).toEqual([order]);
		await expect.poll(() => paintedOrder(page, LOCAL), `painted order after selecting ${id}`).toBe(order);
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

/**
 * The owner's next report (9 Nov 2026, MacBook, v0.119.8): a click on one row selected another session, one at work.
 * Rows sit newest first, so a session another omp starts lands at the top of its project and pushes every row below it
 * down by one: the pointer that rested on Alpha then rests on the newcomer, and the click a person aimed at Alpha
 * selects it. While the pointer is on the list nothing moves into its place; the newcomer joins once it leaves.
 */
test("a session another omp starts never moves into the row the pointer rests on: the click selects the row aimed at", async () => {
	test.setTimeout(120_000);
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidebar-select-")));
	const [project, desktop, agent] = ["project", "desktop", "agent"].map(name => path.join(root, name));
	await Promise.all([project, desktop, agent].map(dir => fs.mkdir(dir)));
	for (const [id, title, minutesAgo] of WORLD.slice(0, 4)) await seed(agent, id, project, title, minutesAgo);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	app = await launchApp({ project, desktop, agent, profile: root, env: { OMP_GUI_TEST_SESSION_FILES: "1" } });
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");

	const rowOf = (id: string) => page.locator(`[data-session-path$="${id}.jsonl"]`).first();
	const order = "project:s-1.jsonl | project:s-2.jsonl | project:s-3.jsonl | project:s-4.jsonl";
	await expect.poll(() => orderOf(page, LOCAL)).toBe(order);
	// No glide left under the pointer: the row's box is where it rests.
	await expect.poll(() => paintedOrder(page, LOCAL)).toBe(order);

	// A person aims at Alpha: the pointer homes in on its row.
	const box = await rowOf("s-1").locator("button").first().boundingBox();
	if (!box) throw new Error("Alpha's row has no box");
	const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	await page.mouse.move(at.x, at.y);
	await recordOrders(page, LOCAL);
	// Meanwhile another omp starts a session in the same project.
	await seed(agent, "s-9", project, "Zulu run", 0);
	// This window has it: it joined the list (where the click lands on it), or it waits for the aim to end. The pointer
	// keeps moving a pixel on Alpha's row meanwhile, as a hand closing in on it does.
	let nudge = 0;
	await expect
		.poll(async () => {
			nudge ^= 1;
			await page.mouse.move(at.x + nudge, at.y);
			return page.evaluate(
				() =>
					document.querySelector('[data-session-path$="s-9.jsonl"]') !== null ||
					document.querySelector('[data-sidebar-held-back]:not([data-sidebar-held-back="0"])') !== null,
			);
		})
		.toBe(true);
	// `OMP_GUI_SIDEBAR_SELECT_SHOTS=<dir>`: the window as the click lands, once it has picked, and once the aim ended.
	const shots = process.env.OMP_GUI_SIDEBAR_SELECT_SHOTS;
	const shoot = async (name: string) => {
		if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) });
	};
	await shoot("1-pointer-on-alpha");
	await page.mouse.down();
	await page.mouse.up();
	await expectNoMove(page, order, "the pointer aimed at Alpha while another session started");

	// The selected row, by file: the one the pointer rested on, not whatever moved into its place.
	const selected = () =>
		page.evaluate(() =>
			[...document.querySelectorAll('[data-session-group] [data-active="true"]')]
				.map(row => row.getAttribute("data-session-path")?.split(/[\\/]/).at(-1))
				.join(" | "),
		);
	await expect.poll(selected).not.toBe("");
	await shoot("2-after-click");
	expect(await selected()).toBe("s-1.jsonl");
	await expect
		.poll(async () =>
			(await page.evaluate(() => window.omp.tabs.list())).some(
				tab => tab.sessionPath?.split(/[\\/]/).at(-1) === "s-1.jsonl" && tab.status === "ready",
			),
		)
		.toBe(true);
	await expect(page.locator('[data-session-group] [data-active="true"]')).toHaveCount(1);
	// The pick's log line names the row's session and the one it selected.
	await expect
		.poll(async () =>
			(await page.evaluate(() => window.omp.runtime.logTail(200))).filter(
				line =>
					line.includes('"message":"select"') &&
					line.includes('"session":"s-1"') &&
					line.includes('"selected":"s-1.jsonl"'),
			),
		)
		.toHaveLength(1);

	// The pointer leaves the list: the newcomer takes its place at the top.
	await page.mouse.move(1000, 450);
	await expect
		.poll(() => orderOf(page, LOCAL))
		.toBe("project:s-9.jsonl | project:s-1.jsonl | project:s-2.jsonl | project:s-3.jsonl | project:s-4.jsonl");
	await shoot("3-pointer-left");
});

/** No order but the first was ever drawn, in the DOM or on screen, since `recordOrders`. */
async function expectNoMove(page: Page, order: string, after: string): Promise<void> {
	expect(await page.evaluate(() => window.__orders), `orders drawn after ${after}`).toEqual([order]);
	const moved = (await page.evaluate(() => window.__painted ?? [])).filter(painted => painted !== order);
	expect(moved, `orders painted after ${after}, other than the list's`).toEqual([]);
}

/** Runs every case even when one fails, and names each one's outcome in the report. */
async function runCases(cases: ReadonlyArray<readonly [name: string, run: () => Promise<void>]>): Promise<void> {
	const failed: string[] = [];
	for (const [name, run] of cases) {
		try {
			await test.step(name, run);
			console.log(`CASE ${name}: pass`);
		} catch (error) {
			console.log(`CASE ${name}: FAIL ${String(error)}`);
			failed.push(`${name}: ${String(error)}`);
		}
	}
	expect(failed, "failed cases").toEqual([]);
}

/** The world both lists show: four plain rows, an archived one and a loose child that needs a look. */
const WORLD = [
	["s-1", "Alpha plan", 1],
	["s-2", "Bravo plan", 2],
	["s-3", "Charlie plan", 3],
	["s-4", "Delta plan", 4],
	["s-5", "Echo plan", 5],
] as const;
const LOOSE = ["s-6", "Fix the upload", 6] as const;
const WORLD_ORDER =
	"project:s-1.jsonl | project:s-2.jsonl | project:s-3.jsonl | project:s-4.jsonl | loose:s-6.jsonl | archived:s-5.jsonl";

/** The sessions of `WORLD` in `agent`'s journal, the loose child last: opened by an agent no row holds, its reply failed. */
async function seedWorld(agent: string, cwd: string): Promise<void> {
	for (const [id, title, minutesAgo] of WORLD) await seed(agent, id, cwd, title, minutesAgo);
	const [id, title, minutesAgo] = LOOSE;
	await seed(agent, id, cwd, title, minutesAgo, { brief: `${title}\nDetails follow.`, failed: true });
}

test("a paired computer's section: selecting a host's row selects it and moves no row, archived and loose ones included", async () => {
	test.setTimeout(300_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidebar-select-device-")));
	let host: RemoteInstance | undefined;
	let client: RemoteInstance | undefined;
	try {
		const hostProfile = await makeRemoteProfile(parent, "host", { language: "en", theme: "light" });
		const clientProfile = await makeRemoteProfile(parent, "client", {
			language: "en",
			theme: "light",
			port: hostProfile.port,
		});
		await installErrorIndex(hostProfile.env.OMP_GUI_OMP ?? "");
		await seedWorld(path.join(hostProfile.root, "agent"), hostProfile.project);
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const a = client.page;
		await a.evaluate(() => window.omp.remote.setDeviceName("PC-A"));
		const deviceId = await connectHost(host.page, a, "PC-B");
		await expect
			.poll(async () => (await a.evaluate(() => window.omp.remote.getState())).hosts[0]?.state, { timeout: 30_000 })
			.toBe("online");
		const section = a.locator(`[data-sidebar-device=${cssString(deviceId)}]`);
		const lists: Lists = {
			scope: `[data-sidebar-device=${cssString(deviceId)}]`,
			rows: "[data-device-session], [data-sidebar-loose-children] [data-session-path]",
		};
		const plain = (id: string) => section.locator(`[data-device-session$="${id}.jsonl"]`).first();
		const loose = (id: string) =>
			section.locator(`[data-sidebar-loose-children] [data-session-path$="${id}.jsonl"]`).first();
		await expect(section).toHaveAttribute("data-device-state", "online", { timeout: 30_000 });
		// The person archives the host's fifth session from its menu (this computer keeps it under the host's id).
		await plain("s-5").click({ button: "right" });
		await a.getByRole("menuitem", { name: "Archive", exact: true }).click();
		const toggle = section.locator("[data-sidebar-archived] button[aria-expanded]").first();
		await expect(toggle).toBeVisible({ timeout: 30_000 });
		if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
		// The loose child is listed with no tab anywhere holding it, among its project's rows.
		await expect.poll(() => orderOf(a, lists), { timeout: 60_000 }).toBe(WORLD_ORDER);
		await expect(section.locator("[data-sidebar-loose-children] [data-sidebar-opened-session]")).toHaveCount(1);
		expect((await a.evaluate(() => window.omp.tabs.list())).filter(tab => tab.device === deviceId)).toEqual([]);

		const pick = async (id: string, row: Locator) => {
			await recordOrders(a, lists);
			await row.locator("button").first().click();
			// The device's tab on the host's session is ready, and the host has said it holds it: what it changes is done.
			await expect
				.poll(
					async () =>
						(await a.evaluate(() => window.omp.tabs.list())).some(
							tab =>
								tab.device === deviceId && tab.sessionPath?.endsWith(`${id}.jsonl`) && tab.status === "ready",
						),
					{ timeout: 60_000 },
				)
				.toBe(true);
			await expect
				.poll(
					async () =>
						(await a.evaluate(device => window.omp.sessions.summaries(device), deviceId))?.sessions.some(row =>
							row.sessionPath.endsWith(`${id}.jsonl`),
						),
					{ timeout: 30_000 },
				)
				.toBe(true);
			await expect
				.poll(
					async () =>
						(await a.evaluate(device => window.omp.sessions.list("local", device), deviceId)).find(row =>
							row.path.endsWith(`${id}.jsonl`),
						)?.heldOnHost,
					{ timeout: 30_000 },
				)
				.toBe(true);
			await expect(row).toHaveAttribute("data-active", "true");
			await expect(
				section.locator('[data-device-group] [data-active="true"], [data-archived-list] [data-active="true"]'),
			).toHaveCount(1);
			await expectNoMove(a, WORLD_ORDER, `selecting ${id}`);
			await expect.poll(() => paintedOrder(a, lists), `painted order after selecting ${id}`).toBe(WORLD_ORDER);
			await expect(row).toHaveAttribute("data-active", "true");
		};
		await runCases([
			["a1 device section plain row", () => pick("s-2", plain("s-2"))],
			["a2 device section archived row", () => pick("s-5", plain("s-5"))],
			["a3 device section loose child", () => pick("s-6", loose("s-6"))],
			["a1 again, back to the plain row", () => pick("s-2", plain("s-2"))],
		]);
	} finally {
		for (const instance of [client, host]) if (instance) await exitApp(instance.app);
		for (const instance of [client, host]) expect(instance?.errors ?? []).toEqual([]);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("a phone's drawer: selecting a row selects it and moves no row, archived and loose ones included", async () => {
	test.setTimeout(300_000);
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidebar-select-phone-")));
	const [project, desktop, agent] = ["project", "desktop", "agent"].map(name => path.join(root, name));
	await Promise.all([project, desktop, agent].map(dir => fs.mkdir(dir)));
	await seedWorld(agent, project);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({
			language: "en",
			themeName: "dark",
			firstRunComplete: true,
			sidebar: { archivedSessions: [WORLD[4][0]] },
		}),
	);
	const tailscale = await fixtureTailscale(root, { backendState: "Running" });
	const bin = await fixtureOmp(root);
	await installErrorIndex(bin);
	app = await launchApp({
		project,
		desktop,
		agent,
		profile: root,
		env: { OMP_GUI_OMP: bin, OMP_GUI_TEST_SESSION_FILES: "1", ...tailscale.env },
	});
	const desk = await app.firstWindow();
	await desk.waitForFunction(() => window.omp?.rpc != null);
	await desk.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
	await expect
		.poll(() => desk.evaluate(async () => (await window.omp.mobileWeb.getState()).phase), { timeout: 60_000 })
		.toBe("ready");
	await expect.poll(() => serveSites(tailscale).length, { timeout: 30_000 }).toBeGreaterThan(0);
	const site = serveSites(tailscale).at(-1);
	if (!site) throw new Error("serve publishes no handler");
	proxy = await ServeProxy.start(site, "seuput@example.com");

	browser = await chromium.launch();
	const context = await browser.newContext({ ...devices["Pixel 8"], viewport: { width: 390, height: 844 } });
	const phone = await context.newPage();
	await phone.goto(`${proxy.url}/`);
	await phonePaired(phone);

	const drawer = "[data-drawer] .omp-session-sidebar";
	const lists: Lists = { scope: drawer, rows: LOCAL.rows };
	const openDrawer = async () => {
		if (
			await phone
				.locator(drawer)
				.isVisible()
				.catch(() => false)
		)
			return;
		await phone.locator("header button:has(svg.lucide-menu)").evaluate(button => (button as HTMLElement).click());
		await expect(phone.locator(drawer)).toBeVisible({ timeout: 30_000 });
		const group = phone.locator(drawer).getByRole("button", { name: "project", exact: true });
		await expect(group).toBeVisible({ timeout: 30_000 });
		if ((await group.getAttribute("aria-expanded")) !== "true") await group.click();
		const toggle = phone.locator(`${drawer} [data-sidebar-archived] button[aria-expanded]`).first();
		await expect(toggle).toBeVisible({ timeout: 30_000 });
		if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
	};
	const plain = (id: string) => phone.locator(`${drawer} [data-session-path$="${id}.jsonl"]`).first();
	const pick = async (id: string) => {
		await openDrawer();
		await expect.poll(() => orderOf(phone, lists), { timeout: 60_000 }).toBe(WORLD_ORDER);
		await recordOrders(phone, lists);
		await plain(id).locator("button").first().click();
		await expect
			.poll(
				async () =>
					(await phone.evaluate(() => window.omp.tabs.list())).some(
						tab => tab.sessionPath?.endsWith(`${id}.jsonl`) && tab.status === "ready",
					),
				{ timeout: 60_000 },
			)
			.toBe(true);
		await expect
			.poll(
				async () =>
					(await phone.evaluate(() => window.omp.sessions.summaries()))?.sessions.some(row =>
						row.sessionPath.endsWith(`${id}.jsonl`),
					),
				{ timeout: 30_000 },
			)
			.toBe(true);
		// Selecting a session closes the drawer; opened again, its row is the selected one.
		await expect(phone.locator("[data-drawer]")).toHaveCount(0, { timeout: 30_000 });
		await openDrawer();
		await expect(plain(id)).toHaveAttribute("data-active", "true");
		await expect(
			phone.locator(
				`${drawer} [data-session-group] [data-active="true"], ${drawer} [data-archived-list] [data-active="true"]`,
			),
		).toHaveCount(1);
		await expectNoMove(phone, WORLD_ORDER, `selecting ${id}`);
		await expect.poll(() => orderOf(phone, lists), `order after selecting ${id}`).toBe(WORLD_ORDER);
		await expect.poll(() => paintedOrder(phone, lists), `painted order after selecting ${id}`).toBe(WORLD_ORDER);
	};
	await runCases([
		["b1 phone plain row", () => pick("s-2")],
		["b2 phone archived row", () => pick("s-5")],
		["b3 phone loose child", () => pick("s-6")],
		["b1 again, back to the plain row", () => pick("s-2")],
	]);
});

/** A real mouse drag of a session row onto the right edge of the workspace: its open tab joins the split there. */
async function dragRowToRightEdge(page: Page, row: Locator): Promise<void> {
	const workspace = await page.locator(".omp-split-workspace").boundingBox();
	if (!workspace) throw new Error("expected the workspace box");
	const ghost = page.locator("[data-split-ghost]");
	// A row replaced between the press and the first move starts no drag: a drag that shows no ghost is released
	// over the workspace and begun again.
	await expect(async () => {
		const rowBox = await row.boundingBox();
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
}

test("a split's rows read selected only where the window shows the split: a desktop window and a phone page, narrowed and widened", async () => {
	test.setTimeout(300_000);
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidebar-select-split-")));
	const [project, desktop, agent] = ["project", "desktop", "agent"].map(name => path.join(root, name));
	await Promise.all([project, desktop, agent].map(dir => fs.mkdir(dir)));
	for (const [id, title, minutesAgo] of WORLD.slice(0, 4)) await seed(agent, id, project, title, minutesAgo);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", themeName: "dark", firstRunComplete: true }),
	);
	const tailscale = await fixtureTailscale(root, { backendState: "Running" });
	app = await launchApp({
		project,
		desktop,
		agent,
		profile: root,
		env: { OMP_GUI_TEST_SESSION_FILES: "1", ...tailscale.env },
	});
	const electronApp = app;
	const desk = await electronApp.firstWindow();
	await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
	await desk.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await desk.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
	await desk.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
	await expect
		.poll(() => desk.evaluate(async () => (await window.omp.mobileWeb.getState()).phase), { timeout: 60_000 })
		.toBe("ready");
	await expect.poll(() => serveSites(tailscale).length, { timeout: 30_000 }).toBeGreaterThan(0);
	const site = serveSites(tailscale).at(-1);
	if (!site) throw new Error("serve publishes no handler");
	proxy = await ServeProxy.start(site, "seuput@example.com");
	browser = await chromium.launch();
	const phone = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
	await phone.goto(`${proxy.url}/`);
	await phonePaired(phone);

	// Two sessions side by side show both rows selected. A phone page narrowed to a phone's width shows the focused one
	// alone (a drawer), so one row is selected; an Electron window keeps its desktop layout however narrow it is made
	// (use-shell-mode.ts), so the split is still drawn and both rows still read selected. Widened again, both are.
	const splitCase = async (
		page: Page,
		resize: (width: number, height: number) => Promise<void>,
		narrowShowsDrawer: boolean,
	) => {
		const tabs = () => page.evaluate(() => window.omp.tabs.list());
		const row = (id: string) => page.locator(`[data-session-path$="${id}.jsonl"]`).first();
		const selected = page.locator('[data-session-group] [data-active="true"]');
		// A phone page lists the project folded; the person unfolds it.
		const unfold = async () => {
			const group = page
				.locator('[aria-label="Sidebar"], [data-drawer]')
				.getByRole("button", { name: "project", exact: true });
			await expect(group).toBeVisible({ timeout: 30_000 });
			if ((await group.getAttribute("aria-expanded")) !== "true") await group.click();
		};
		await unfold();
		for (const id of ["s-3", "s-2"]) {
			await row(id).locator("button").first().click();
			await expect
				.poll(
					async () =>
						(await tabs()).some(tab => tab.sessionPath?.endsWith(`${id}.jsonl`) && tab.status === "ready"),
					{ timeout: 60_000 },
				)
				.toBe(true);
		}
		await dragRowToRightEdge(page, row("s-3"));
		await expect(page.locator(".omp-session-pane")).toHaveCount(2);
		await expect(selected, "both panes of the split").toHaveCount(2);
		await expect(row("s-2")).toHaveAttribute("data-active", "true");
		await expect(row("s-3")).toHaveAttribute("data-active", "true");

		await resize(390, 844);
		if (narrowShowsDrawer) {
			const focused = (await tabs()).find(tab => tab.active)?.sessionPath ?? "";
			expect(focused, "a focused tab").not.toBe("");
			await page.locator("header button:has(svg.lucide-menu)").evaluate(button => (button as HTMLElement).click());
			await expect(page.locator("[data-drawer] .omp-session-sidebar")).toBeVisible({ timeout: 30_000 });
			await unfold();
			await expect(selected, "only the focused tab's row, in the drawer").toHaveCount(1);
			await expect(page.locator(`[data-session-path=${cssString(focused)}]`).first()).toHaveAttribute(
				"data-active",
				"true",
			);
		} else {
			await expect(page.locator(".omp-session-pane"), "the split, narrowed").toHaveCount(2);
			await expect(selected, "both panes of the split, narrowed").toHaveCount(2);
		}

		await resize(1440, 900);
		await expect(selected, "both panes of the split, widened again").toHaveCount(2, { timeout: 30_000 });
	};
	await runCases([
		[
			"c1 desktop window",
			() =>
				splitCase(
					desk,
					(width, height) =>
						electronApp.evaluate(
							({ BrowserWindow }, size) =>
								BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height),
							{ width, height },
						),
					false,
				),
		],
		["c2 phone page", () => splitCase(phone, (width, height) => phone.setViewportSize({ width, height }), true)],
	]);
});
