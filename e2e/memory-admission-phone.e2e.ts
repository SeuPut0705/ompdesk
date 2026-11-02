import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { devices, expect, test, webkit } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { fixtureTailscale } from "./fixture/fake-tailscale-install";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import {
	capture,
	controlToolCaller,
	exitApp,
	hitSizes,
	launchApp,
	openedSessions,
	openSidebarFamily,
	untilAnswered,
} from "./harness";

// A phone at 390 px views a session of this computer that waits for memory (src/main/memory-admission.ts; the
// owner's rule of 2 Nov 2026): the waiting row says the same words as the desktop's, its Start now is a touch target
// (36 px or taller: the row-touch rule of the phone shell), a tap starts the session on the computer that holds it
// (`viewForDevice` → `MEMORY_START_NOW`), and the phone's session list carries the label "Waiting for memory". The
// row's text and wiring are component-tested (ChatStream.turn-status.test.tsx, tab-signal.test.ts); this is the
// built app's real web page behind the fake `tailscale serve`, on WebKit as an iPhone 15 cut to 390 px.

test("a phone at 390 px shows the memory wait the way the desktop does, with a Start now that is a touch target and starts the session", async () => {
	test.setTimeout(240_000);
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-memory-phone-")));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", themeName: "light", firstRunComplete: true, lastProject: project }),
	);
	const memory = path.join(root, "memory.json");
	// 3 GB free of 16: less than one expected session (2.5 GB) above the 2.4 GB kept free.
	await fs.writeFile(memory, JSON.stringify({ totalGb: 16, availableGb: 3, pressure: "normal" }));
	const tailscale = await fixtureTailscale(root, { backendState: "Running" });
	const record = path.join(root, "omp-received.jsonl");
	let app: ElectronApplication | null = null;
	let proxy: ServeProxy | null = null;
	const browser = await webkit.launch();
	try {
		app = await launchApp({
			project,
			desktop,
			agent,
			profile: root,
			env: {
				OMP_GUI_HEADLESS: "1",
				OMP_GUI_TEST_SESSION_FILES: "1",
				OMP_GUI_TEST_RECORD: record,
				OMP_GUI_TEST_MEMORY: memory,
				OMP_GUI_TEST_MEMORY_MS: "200",
				...tailscale.env,
			},
		});
		const desk = await app.firstWindow();
		const errors: string[] = [];
		desk.on("pageerror", error => errors.push(error.message));
		await desk.waitForFunction(() => window.omp?.rpc != null);
		await expect.poll(async () => (await desk.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");

		// The person's own session leads (it has a row), and the session its agent opens nests under it as a family
		// row, which the person has talked to too. The agent's next message to it starts a turn: held while memory is short.
		const main = (await desk.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId ?? "";
		await desk.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "lead the work" }), main);
		await untilAnswered(desk, main);
		const call = await controlToolCaller(desk, record, main);
		const open = await call("ompdesk_session_open", { show: "focus" });
		expect(open.isError, open.text).toBe(false);
		const [child] = openedSessions(open.text);
		if (!child) throw new Error(open.text);
		await expect
			.poll(
				async () => (await desk.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === child)?.status,
				{
					timeout: 60_000,
				},
			)
			.toBe("ready");
		await desk.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "hello" }), child);
		await untilAnswered(desk, child);
		const sent = await call("ompdesk_session_send", { session: child, message: "Phone follow-up" });
		expect(sent.isError, sent.text).toBe(false);
		expect(sent.text).toContain("waiting for memory: 3 GB free of 16 GB (pressure normal); #1 in line");
		const deskRow = desk.locator("[data-memory-wait]");
		await expect(deskRow).toBeVisible({ timeout: 30_000 });
		const wanted = "Waiting for memory: 3 GB free of 16 GB · #1 in line · starts by itself";
		await expect(deskRow).toContainText(wanted);
		let sessionPath = "";
		await expect
			.poll(
				async () => {
					sessionPath =
						(await desk.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === child)?.sessionPath ??
						"";
					return sessionPath;
				},
				{ timeout: 30_000 },
			)
			.not.toBe("");

		// The phone: paired through the fake serve, 390 px wide.
		await desk.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
		await expect
			.poll(() => desk.evaluate(async () => (await window.omp.mobileWeb.getState()).phase), { timeout: 60_000 })
			.toBe("ready");
		await expect.poll(() => serveSites(tailscale).length, { timeout: 30_000 }).toBeGreaterThan(0);
		const site = serveSites(tailscale).at(-1);
		if (!site) throw new Error("serve publishes no handler");
		proxy = await ServeProxy.start(site, "seuput@example.com", undefined, { plainCookie: true });
		const context = await browser.newContext({ ...devices["iPhone 15"], viewport: { width: 390, height: 844 } });
		const phone = await context.newPage();
		await phone.goto(`${proxy.url}/`, { timeout: 60_000 });
		await phonePaired(phone);
		const viewed = await phone.evaluate(
			([cwd, session]) => window.omp.tabs.spawn({ cwd, kind: "agent", sessionPath: session }),
			[project, sessionPath] as const,
		);
		if (!viewed?.tabId) throw new Error(`the phone could not view it: ${JSON.stringify(viewed)}`);
		await phone.goto(`${proxy.url}/#/open?tab=${viewed.tabId}`);
		expect(phone.viewportSize()?.width).toBe(390);

		// The row: the desktop's words, inside the 390 px screen, with its own Start now.
		const row = phone.locator("[data-memory-wait]");
		await expect(row).toBeVisible({ timeout: 60_000 });
		await expect(row).toContainText(wanted);
		expect((await row.innerText()).replace(/\s+/g, " ").trim()).toBe(
			`${(await deskRow.innerText()).replace(/\s+/g, " ").trim()}`,
		);
		const box = await row.boundingBox();
		expect(box?.x).toBeGreaterThanOrEqual(0);
		expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
		expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
		const start = row.getByRole("button", { name: "Start now" });
		await expect(start).toBeVisible();
		const [size] = await hitSizes(start);
		expect(size?.hit.height, "Start now's tap reaches 36 px or more").toBeGreaterThanOrEqual(36);
		await capture(phone, "phone-390-memory-wait");

		// The session list says it too, on the family row under the person's session: the same words and its own Start
		// now, a touch target.
		await phone.locator("header button:has(svg.lucide-menu)").click();
		const drawer = phone.locator("[data-drawer]");
		await expect(drawer).toBeVisible();
		await openSidebarFamily(phone);
		const familyRow = drawer.locator(`[data-sidebar-opened-session][data-session-path="${sessionPath}"]`);
		await expect(familyRow).toHaveAttribute("data-family-state", "queued");
		await expect(familyRow.locator("[data-family-memory-wait]")).toHaveText("Waiting for memory");
		const [familyStart] = await hitSizes(familyRow.getByRole("button", { name: "Start now" }));
		expect(familyStart?.hit.height, "the family row's Start now reaches 36 px or more").toBeGreaterThanOrEqual(36);
		await capture(phone, "phone-390-memory-wait-drawer");
		await phone.goBack().catch(() => undefined);
		await expect(drawer).toHaveCount(0);

		// A tap on Start now starts it on this computer, whatever its memory says; the row goes and the brief is answered.
		await start.tap();
		await untilAnswered(desk, child);
		await expect(row).toHaveCount(0, { timeout: 30_000 });
		await expect(deskRow).toHaveCount(0);
		await expect(phone.getByText("Local fixture reply").first()).toBeVisible({ timeout: 30_000 });
		expect(errors).toEqual([]);
	} finally {
		await browser.close().catch(() => undefined);
		await proxy?.close().catch(() => undefined);
		if (app) await exitApp(app).catch(() => undefined);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
	}
});
