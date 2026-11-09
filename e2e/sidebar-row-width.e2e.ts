/**
 * A session row is as wide as what it draws: picking a session never moves another row's title end or age, nor its
 * own (the owner's report, 9 Nov 2026: on picking a session, the titles of rows that had not changed were cut at
 * another place). A row held a trailing slot for "a tab here holds the session" though the slot drew nothing there,
 * and that slot's flex gap took 10 px from the title of every row a tab held, so a pick, which opens a tab, moved
 * the picked row and every row picked before. Real clicks on the built app with the fake omp, on this computer's
 * own list and on a paired computer's section of a host's sessions. `OMP_GUI_ROW_WIDTH_SHOTS=<dir>` also writes the
 * sidebar after each pick (`<list>-<n>-<session>.png`).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { cssString, exitApp, launchApp } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, type RemoteInstance } from "./remote-harness";

let app: ElectronApplication | undefined;
let root = "";
const SHOTS = process.env.OMP_GUI_ROW_WIDTH_SHOTS;
test.afterEach(async () => {
	if (app) await exitApp(app);
	app = undefined;
	if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	root = "";
});

const WORLD = [
	["s-1", "Rework the release notes so both languages read the same", 1],
	["s-2", "Find why the sidebar cuts titles at a different place", 2],
	["s-3", "Move the upload retry into the shared transport layer", 3],
	["s-4", "Short one", 4],
] as const;

/** `rows` in `agent`'s journal under `cwd`, in the fake omp's format, each with one answered turn. */
async function seedRows(
	agent: string,
	cwd: string,
	rows: ReadonlyArray<readonly [id: string, title: string, minutesAgo: number]>,
): Promise<void> {
	for (const [id, title, minutesAgo] of rows) {
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
}

/** Each row's title box width and its age's right edge, by session file name, as painted. */
function rowGeometry(page: Page, rows: string): Promise<Record<string, string>> {
	return page.evaluate(selector => {
		const out: Record<string, string> = {};
		for (const row of document.querySelectorAll<HTMLElement>(selector)) {
			const file = (row.dataset.deviceSession ?? row.dataset.sessionPath ?? "").split("/").at(-1) ?? "";
			const title = row.querySelector("button[data-roving-item]")?.parentElement?.getBoundingClientRect();
			const end = row.querySelector("time")?.getBoundingClientRect();
			out[file] = `title ${Math.round(title?.width ?? -1)} · age ends ${Math.round(end?.right ?? -1)}`;
		}
		return out;
	}, rows);
}

/**
 * Picks each row in turn and, once the tab it opened or focused is ready and the pointer is off the list (a hovered
 * row shows its ⋯ in place of the age, by design), expects every row painted as before the first pick.
 */
async function expectStableRows(
	page: Page,
	list: string,
	rows: string,
	rowOf: (id: string) => Locator,
	ready: (id: string) => Promise<boolean>,
): Promise<void> {
	await page.mouse.move(900, 500);
	const before = await rowGeometry(page, rows);
	expect(Object.keys(before)).toHaveLength(WORLD.length);
	const shoot = async (name: string) => {
		if (!SHOTS) return;
		await fs.mkdir(SHOTS, { recursive: true });
		await page.locator("aside.omp-session-sidebar").screenshot({ path: path.join(SHOTS, `${list}-${name}.png`) });
	};
	await shoot("0-start");
	let step = 0;
	for (const id of ["s-2", "s-3", "s-1", "s-2"]) {
		await rowOf(id).locator("button").first().click();
		await expect(rowOf(id)).toHaveAttribute("data-active", "true");
		await expect.poll(() => ready(id), { timeout: 60_000 }).toBe(true);
		await page.mouse.move(900, 500);
		await expect
			.poll(() => rowGeometry(page, rows), { timeout: 5_000 })
			.toEqual(before)
			.catch(() => undefined);
		await shoot(`${++step}-${id}`);
		expect(await rowGeometry(page, rows), `rows after picking ${id}`).toEqual(before);
	}
}

test("picking a session moves no row's title end or age on this computer's list", async () => {
	test.setTimeout(120_000);
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidebar-row-width-")));
	const [project, desktop, agent] = ["project", "desktop", "agent"].map(name => path.join(root, name));
	await Promise.all([project, desktop, agent].map(dir => fs.mkdir(dir)));
	await seedRows(agent, project, WORLD);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	app = await launchApp({ project, desktop, agent, profile: root, env: { OMP_GUI_TEST_SESSION_FILES: "1" } });
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
	const rows = "[data-session-group] .omp-sidebar-session-row";
	await expect(page.locator(rows)).toHaveCount(WORLD.length, { timeout: 30_000 });
	await expectStableRows(
		page,
		"local",
		rows,
		id => page.locator(`[data-session-group] [data-session-path$="/${id}.jsonl"]`).first(),
		async id =>
			(await page.evaluate(() => window.omp.tabs.list())).some(
				tab => tab.sessionPath?.endsWith(`/${id}.jsonl`) && tab.status === "ready",
			),
	);
});

test("picking a host's session moves no row's title end or age on a paired computer's section", async () => {
	test.setTimeout(300_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidebar-row-width-device-")));
	let host: RemoteInstance | undefined;
	let client: RemoteInstance | undefined;
	try {
		const hostProfile = await makeRemoteProfile(parent, "host", { language: "en", theme: "light" });
		const clientProfile = await makeRemoteProfile(parent, "client", {
			language: "en",
			theme: "light",
			port: hostProfile.port,
		});
		await seedRows(path.join(hostProfile.root, "agent"), hostProfile.project, WORLD);
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const a = client.page;
		await a.evaluate(() => window.omp.remote.setDeviceName("PC-A"));
		const deviceId = await connectHost(host.page, a, "PC-B");
		const scope = `[data-sidebar-device=${cssString(deviceId)}]`;
		await expect(a.locator(scope)).toHaveAttribute("data-device-state", "online", { timeout: 30_000 });
		const rows = `${scope} [data-device-session]`;
		await expect(a.locator(rows)).toHaveCount(WORLD.length, { timeout: 60_000 });
		await expectStableRows(
			a,
			"device",
			rows,
			id => a.locator(`${scope} [data-device-session$="/${id}.jsonl"]`).first(),
			async id =>
				(await a.evaluate(() => window.omp.tabs.list())).some(
					tab => tab.device === deviceId && tab.sessionPath?.endsWith(`/${id}.jsonl`) && tab.status === "ready",
				),
		);
	} finally {
		for (const instance of [client, host]) if (instance) await exitApp(instance.app);
		for (const instance of [client, host]) expect(instance?.errors ?? []).toEqual([]);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

/**
 * The owner's case across projects: a pick changes how tall the list is (picking a session of another project moves
 * the start tab there, and the project it left, now without a tab and not the current one, folds by default), so
 * the list stops or starts scrolling. Its scrollbar took 9 px from every row of every project while it showed: the
 * rows of the project picked in, the picked one aside, were cut at another place.
 */
test("a pick that changes the list's height moves no row of another project", async () => {
	test.setTimeout(120_000);
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidebar-row-width-scroll-")));
	const [alpha, beta, desktop, agent] = ["alpha", "beta", "desktop", "agent"].map(name => path.join(root, name));
	await Promise.all([alpha, beta, desktop, agent].map(dir => fs.mkdir(dir)));
	const rowsOf = (name: string, from: number) =>
		Array.from(
			{ length: 9 },
			(_, i) => [`${name}-${i}`, `Messenger and mail with the HTML attachment ${name} ${i}`, from + i] as const,
		);
	await seedRows(agent, alpha, rowsOf("alpha", 1));
	await seedRows(agent, beta, rowsOf("beta", 20));
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	app = await launchApp({ project: alpha, desktop, agent, profile: root, env: { OMP_GUI_TEST_SESSION_FILES: "1" } });
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
	const rows = `[data-session-group=${cssString(beta)}] .omp-sidebar-session-row:not([data-session-path$="/beta-2.jsonl"])`;
	// Beta unfolded by hand: both projects open, the list scrolls.
	await page
		.locator(`[data-workspace-group=${cssString(beta)}] button`)
		.first()
		.click();
	await expect(page.locator(rows)).toHaveCount(8, { timeout: 30_000 });
	const scrolls = () =>
		page.evaluate(() => {
			const list = document.querySelector<HTMLElement>('[data-tour="sessions"]');
			return list ? list.scrollHeight > list.clientHeight : null;
		});
	// Once beta's fold has played, the list is taller than its box.
	await expect.poll(scrolls, { timeout: 10_000 }).toBe(true);
	await page.mouse.move(900, 500);
	const before = await rowGeometry(page, rows);
	await page.locator(`[data-session-path$="/beta-2.jsonl"] button`).first().click();
	await expect
		.poll(
			async () =>
				(await page.evaluate(() => window.omp.tabs.list())).some(
					tab => tab.sessionPath?.endsWith("/beta-2.jsonl") && tab.status === "ready",
				),
			{ timeout: 60_000 },
		)
		.toBe(true);
	// The pick changed the list's height: alpha, left with no tab and no longer current, folded.
	await expect(page.locator(`[data-session-group=${cssString(alpha)}]`)).toHaveCount(0);
	await expect.poll(scrolls, { timeout: 10_000 }).toBe(false);
	await page.mouse.move(900, 500);
	await expect
		.poll(() => rowGeometry(page, rows), { timeout: 3_000 })
		.toEqual(before)
		.catch(() => undefined);
	if (SHOTS) {
		await fs.mkdir(SHOTS, { recursive: true });
		await page
			.locator("aside.omp-session-sidebar")
			.screenshot({ path: path.join(SHOTS, "scroll-picked-beta-2.png") });
	}
	expect(await rowGeometry(page, rows), "beta's other rows after the pick").toEqual(before);
});
