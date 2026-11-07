/**
 * A session's sidebar row stays current while nobody looks at it (the owner's report, 6 Nov 2026, v0.116.0: a
 * background session's subagent chip and run state were stale until the row was clicked). Fake omp, which like stock
 * starts its subagent stream off and writes no `subagent_*` frame until the GUI asks. A relaunch restores two sessions,
 * the second asleep; an agent's message wakes it in the background, so no window ever shows its new omp. It runs
 * subagents: its row's chip counts them up and down, the shown session's row never gets them, a reload of the page
 * (a runtime made after they started) reads what still runs, the row follows running, waiting and done, and a split's
 * unfocused pane follows too. Then the phone's page: a tab of its own it does not show. `OMP_GUI_SIDEBAR_LIVE=<dir>`
 * writes captures.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, devices, expect, type Locator, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { fixtureTailscale } from "./fixture/fake-tailscale-install";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { captureTo, controlToolCaller, cssString, exitApp, fixtureOmp } from "./harness";

const CAPTURES = process.env.OMP_GUI_SIDEBAR_LIVE;

const tabsOf = (page: Page) => page.evaluate(() => window.omp.tabs.list());

async function send(
	page: Page,
	tabId: string,
	command: { type: "prompt"; message: string } | { type: "bash"; command: string },
) {
	const response = await page.evaluate(([id, body]) => window.omp.rpc.commandForTab(id, body), [
		tabId,
		command,
	] as const);
	expect(response.success, JSON.stringify(response)).toBe(true);
}

/** Until the tab's turn has answered: it has a file, so a sidebar row. */
async function answered(page: Page, tabId: string): Promise<void> {
	await expect
		.poll(async () => (await tabsOf(page)).find(tab => tab.tabId === tabId)?.lastRun?.reply, { timeout: 30_000 })
		.toBe("Local fixture reply");
}

async function rowOf(page: Page, scope: Locator, tabId: string): Promise<Locator> {
	const sessionPath = (await tabsOf(page)).find(tab => tab.tabId === tabId)?.sessionPath ?? "";
	expect(sessionPath).not.toBe("");
	return scope.locator(`.omp-sidebar-session-row[data-session-path=${cssString(sessionPath)}]`);
}

/** The running count on a row's family chip, or 0 without one. */
async function running(row: Locator): Promise<number> {
	const pill = row.locator("[data-family-running]");
	return (await pill.count()) === 0 ? 0 : Number(await pill.getAttribute("data-family-running"));
}

test("a session no window shows keeps its sidebar row current: subagents, run state, a split pane, the phone", async () => {
	test.setTimeout(300_000);
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidebar-live-")));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", themeName: "light", firstRunComplete: true, lastProject: project }),
	);
	const tailscale = await fixtureTailscale(root, { backendState: "Running" });
	const record = path.join(root, "omp-received.jsonl");
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	Object.assign(env, {
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(root),
		OMP_GUI_TEST_SESSION_FILES: "1",
		OMP_GUI_TEST_RECORD: record,
		...tailscale.env,
	});
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	// No folder argument: a relaunch restores the saved layout.
	const launch = async () => {
		const app = await electron.launch({
			args: [path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"), `--user-data-dir=${desktop}`],
			env,
		});
		const page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		return { app, page };
	};
	let app: ElectronApplication | null = null;
	let proxy: ServeProxy | null = null;
	const browser = await chromium.launch();
	try {
		// Two sessions, the first in front when the app quits.
		const first = await launch();
		app = first.app;
		const front = (await tabsOf(first.page)).find(tab => tab.active)?.tabId ?? "";
		await send(first.page, front, { type: "prompt", message: "hello" });
		await answered(first.page, front);
		await first.page.keyboard.press("ControlOrMeta+t");
		await expect.poll(async () => (await tabsOf(first.page)).length).toBe(2);
		const second = (await tabsOf(first.page)).find(tab => tab.tabId !== front)?.tabId ?? "";
		await expect.poll(async () => (await tabsOf(first.page)).find(tab => tab.tabId === second)?.status).toBe("ready");
		await send(first.page, second, { type: "prompt", message: "hello" });
		await answered(first.page, second);
		await (await rowOf(first.page, first.page.locator(".omp-session-sidebar"), front)).click();
		await expect.poll(async () => (await tabsOf(first.page)).find(tab => tab.active)?.tabId).toBe(front);
		await exitApp(first.app);

		const { app: relaunched, page: desk } = await launch();
		app = relaunched;
		const restored = await tabsOf(desk);
		const shown = restored.find(tab => tab.active)?.tabId ?? "";
		const back = restored.find(tab => !tab.active)?.tabId ?? "";
		expect(restored.find(tab => tab.tabId === back)?.status).toBe("asleep");
		const sidebar = desk.locator(".omp-session-sidebar");
		const frontRow = await rowOf(desk, sidebar, shown);
		const backRow = await rowOf(desk, sidebar, back);
		await expect(backRow).toBeVisible({ timeout: 30_000 });

		// An agent's message wakes the session in the background: an omp no window shows.
		const call = await controlToolCaller(desk, record, shown);
		const sent = await call("ompdesk_session_send", { session: back, message: "Pick this up" });
		expect(sent.isError, sent.text).toBe(false);
		await expect
			.poll(async () => (await tabsOf(desk)).find(tab => tab.tabId === back)?.status, { timeout: 60_000 })
			.toBe("ready");
		expect((await tabsOf(desk)).find(tab => tab.active)?.tabId).toBe(shown);

		// A turn runs there and starts subagents: its row says it runs and counts them, the shown session's row does not.
		await send(desk, back, { type: "prompt", message: "fixture running" });
		await expect(backRow).toHaveAttribute("data-signal", "running", { timeout: 15_000 });
		await send(desk, back, { type: "bash", command: "fixture:subagents" });
		await expect.poll(() => running(backRow), { timeout: 15_000 }).toBe(2);
		expect(await running(frontRow)).toBe(0);
		await captureTo(CAPTURES, desk, "desktop-1-subagents-running");

		// A page that loads while they run reads them at once.
		await desk.reload();
		await desk.waitForFunction(() => window.omp?.rpc != null);
		await expect.poll(() => running(backRow), { timeout: 15_000 }).toBe(2);
		expect((await tabsOf(desk)).find(tab => tab.active)?.tabId).toBe(shown);
		expect(await running(frontRow)).toBe(0);

		// They finish one by one: the count goes down, then the chip goes.
		await send(desk, back, { type: "bash", command: "fixture:subagents:finish:sa-explore" });
		await expect.poll(() => running(backRow), { timeout: 15_000 }).toBe(1);
		await send(desk, back, { type: "bash", command: "fixture:subagents:finish:sa-nested" });
		await expect.poll(() => running(backRow), { timeout: 15_000 }).toBe(0);
		await captureTo(CAPTURES, desk, "desktop-2-subagents-finished");

		// The turn ends unseen (done), then the session waits on an approval.
		await send(desk, back, { type: "bash", command: "fixture:finish" });
		await expect(backRow.locator("[data-sidebar-done]")).toHaveCount(1, { timeout: 15_000 });
		await send(desk, back, { type: "prompt", message: "fixture approval" });
		await expect(backRow).toHaveAttribute("data-signal", "waiting", { timeout: 15_000 });
		await captureTo(CAPTURES, desk, "desktop-3-waiting");
		// Answered by an agent (another session's `ompdesk_session_answer`): the row stops waiting by itself.
		const answer = await call("ompdesk_session_answer", { session: back, request: "approval", choice: "Deny" });
		expect(answer.isError, answer.text).toBe(false);
		await expect(backRow).not.toHaveAttribute("data-signal", "waiting", { timeout: 15_000 });

		// Shown in a split, focus on the other pane: the unfocused pane's row follows its subagents too.
		await backRow.click({ button: "right" });
		await desk.getByRole("menuitem", { name: "Split right" }).click();
		await expect(desk.locator(`.omp-session-pane[data-tab-id="${back}"]`)).toBeVisible();
		await frontRow.click();
		await expect.poll(async () => (await tabsOf(desk)).find(tab => tab.active)?.tabId).toBe(shown);
		await send(desk, back, { type: "bash", command: "fixture:subagents" });
		await expect.poll(() => running(backRow), { timeout: 15_000 }).toBe(2);
		expect(await running(frontRow)).toBe(0);
		await captureTo(CAPTURES, desk, "desktop-4-split-unfocused");
		for (const id of ["sa-explore", "sa-nested"])
			await send(desk, back, { type: "bash", command: `fixture:subagents:finish:${id}` });
		await expect.poll(() => running(backRow), { timeout: 15_000 }).toBe(0);

		// The phone: a tab of its own it does not show.
		await desk.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
		await expect
			.poll(() => desk.evaluate(async () => (await window.omp.mobileWeb.getState()).phase), { timeout: 60_000 })
			.toBe("ready");
		await expect.poll(() => serveSites(tailscale).length, { timeout: 30_000 }).toBeGreaterThan(0);
		const site = serveSites(tailscale).at(-1);
		if (!site) throw new Error("serve publishes no handler");
		proxy = await ServeProxy.start(site, "seuput@example.com");
		const context = await browser.newContext({ ...devices["Pixel 8"] });
		const phone = await context.newPage();
		await phone.goto(`${proxy.url}/`, { timeout: 60_000 });
		await phonePaired(phone);
		const own: string[] = [];
		for (let index = 0; index < 2; index++) {
			const tabId = await phone.evaluate(
				async cwd => (await window.omp.tabs.spawn({ cwd, kind: "agent" }))?.tabId,
				project,
			);
			if (!tabId) throw new Error("no phone tab");
			await expect
				.poll(async () => (await tabsOf(phone)).find(tab => tab.tabId === tabId)?.status, { timeout: 60_000 })
				.toBe("ready");
			await send(phone, tabId, { type: "prompt", message: "hello" });
			await answered(phone, tabId);
			own.push(tabId);
		}
		await phone.reload({ timeout: 60_000 });
		await phone.waitForFunction(() => window.omp?.rpc != null);
		await phone.locator("header button:has(svg.lucide-menu)").click();
		const drawer = phone.locator("[data-drawer] .omp-session-sidebar");
		const [phoneFront = "", phoneBack = ""] = own;
		await (await rowOf(phone, drawer, phoneFront)).click();
		await expect.poll(async () => (await tabsOf(phone)).find(tab => tab.active)?.tabId).toBe(phoneFront);
		if (!(await drawer.isVisible())) await phone.locator("header button:has(svg.lucide-menu)").click();
		const hiddenRow = await rowOf(phone, drawer, phoneBack);
		const shownRow = await rowOf(phone, drawer, phoneFront);
		await expect(hiddenRow).toBeVisible({ timeout: 30_000 });
		await send(phone, phoneBack, { type: "bash", command: "fixture:subagents" });
		await expect.poll(() => running(hiddenRow), { timeout: 15_000 }).toBe(2);
		expect(await running(shownRow)).toBe(0);
		await captureTo(CAPTURES, phone, "phone-1-subagents-running");
		await send(phone, phoneBack, { type: "bash", command: "fixture:subagents:finish:sa-explore" });
		await expect.poll(() => running(hiddenRow), { timeout: 15_000 }).toBe(1);
		await send(phone, phoneBack, { type: "bash", command: "fixture:subagents:finish:sa-nested" });
		await expect.poll(() => running(hiddenRow), { timeout: 15_000 }).toBe(0);
		// The page goes to the background while the session works, every time (the owner's report, 7 Nov 2026: a paired
		// host's session on the phone, its row with no count until tapped): the computer drops a hidden page's stream
		// pushes, these subagents' starts among them. Back in front, the row counts them with no tap. The first time, the
		// tab list's one read of a hidden running tab's roster covers it; the next time nothing did.
		const presence = (state: "hidden" | "visible") =>
			phone.evaluate(next => {
				Object.defineProperty(document, "visibilityState", { value: next, configurable: true });
				Object.defineProperty(document, "hidden", { value: next === "hidden", configurable: true });
				document.dispatchEvent(new Event("visibilitychange"));
			}, state);
		await send(phone, phoneBack, { type: "prompt", message: "fixture running" });
		await expect(hiddenRow).toHaveAttribute("data-signal", "running", { timeout: 15_000 });
		for (const round of [1, 2]) {
			await presence("hidden");
			await send(phone, phoneBack, { type: "bash", command: "fixture:subagents" });
			await presence("visible");
			await expect.poll(() => running(hiddenRow), { timeout: 15_000, message: `round ${round}` }).toBe(2);
			expect(await running(shownRow)).toBe(0);
			expect((await tabsOf(phone)).find(tab => tab.active)?.tabId).toBe(phoneFront);
			if (round === 2) await captureTo(CAPTURES, phone, "phone-2-subagents-started-while-hidden");
			// They end while the page is in front: the count goes with them.
			for (const id of ["sa-explore", "sa-nested"])
				await send(phone, phoneBack, { type: "bash", command: `fixture:subagents:finish:${id}` });
			await expect.poll(() => running(hiddenRow), { timeout: 15_000 }).toBe(0);
		}
		await context.close();
	} finally {
		await proxy?.close();
		await browser.close();
		if (app) await exitApp(app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("a hidden session's row counts the subagents its agent starts after its omp died and came back", async () => {
	test.skip(process.platform === "win32", "the omp's pid comes from ps");
	test.setTimeout(180_000);
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidebar-restart-")));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", themeName: "light", firstRunComplete: true, lastProject: project }),
	);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	Object.assign(env, {
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(root),
		OMP_GUI_TEST_SESSION_FILES: "1",
	});
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	let app: ElectronApplication | null = null;
	try {
		app = await electron.launch({
			args: [path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"), `--user-data-dir=${desktop}`],
			env,
		});
		const desk = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
		await desk.waitForFunction(() => window.omp?.rpc != null);
		await expect
			.poll(async () => (await desk.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		const shown = (await tabsOf(desk)).find(tab => tab.active)?.tabId ?? "";
		await send(desk, shown, { type: "prompt", message: "hello" });
		await answered(desk, shown);
		await desk.keyboard.press("ControlOrMeta+t");
		await expect.poll(async () => (await tabsOf(desk)).length).toBe(2);
		const back = (await tabsOf(desk)).find(tab => tab.tabId !== shown)?.tabId ?? "";
		await expect.poll(async () => (await tabsOf(desk)).find(tab => tab.tabId === back)?.status).toBe("ready");
		await send(desk, back, { type: "prompt", message: "hello" });
		await answered(desk, back);
		const sidebar = desk.locator(".omp-session-sidebar");
		await (await rowOf(desk, sidebar, shown)).click();
		await expect.poll(async () => (await tabsOf(desk)).find(tab => tab.active)?.tabId).toBe(shown);
		const backRow = await rowOf(desk, sidebar, back);

		// It runs subagents when its omp dies (the owner's report, 7 Nov 2026: an uncaught exception) and the app starts
		// another: those died with it.
		await send(desk, back, { type: "prompt", message: "fixture running" });
		await expect(backRow).toHaveAttribute("data-signal", "running", { timeout: 15_000 });
		await send(desk, back, { type: "bash", command: "fixture:subagents" });
		await expect.poll(() => running(backRow), { timeout: 15_000 }).toBe(2);
		const state = await desk.evaluate(
			id => window.omp.rpc.commandForTab(id, { type: "get_state", brief: true }),
			back,
		);
		const pid = Number((state.data as { sessionId?: string } | undefined)?.sessionId?.replace("fixture-", ""));
		expect(pid).toBeGreaterThan(0);
		process.kill(pid, "SIGKILL");
		// The app starts another omp for the tab: two fake omps run again, the killed one not among them.
		await expect
			.poll(
				() => {
					const now = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
						.split("\n")
						.filter(line => line.includes(root) && line.includes("rpc-ui"))
						.map(line => Number.parseInt(line, 10));
					return now.length === 2 && !now.includes(pid);
				},
				{ timeout: 60_000 },
			)
			.toBe(true);
		await expect
			.poll(async () => (await tabsOf(desk)).find(tab => tab.tabId === back)?.status, { timeout: 60_000 })
			.toBe("ready");
		// The row no longer counts the agents that died with the omp.
		await expect.poll(() => running(backRow), { timeout: 15_000 }).toBe(0);
		expect((await tabsOf(desk)).find(tab => tab.active)?.tabId).toBe(shown);

		// A later turn of the new omp starts subagents: the row counts them with no click.
		await send(desk, back, { type: "prompt", message: "fixture running" });
		await expect(backRow).toHaveAttribute("data-signal", "running", { timeout: 15_000 });
		await send(desk, back, { type: "bash", command: "fixture:subagents" });
		await expect.poll(() => running(backRow), { timeout: 15_000 }).toBe(2);
		await captureTo(CAPTURES, desk, "desktop-5-after-omp-restart");
	} finally {
		if (app) await exitApp(app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
