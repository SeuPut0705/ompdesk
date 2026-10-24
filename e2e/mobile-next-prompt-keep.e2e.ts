/**
 * A phone viewing a computer's session shows the suggestion that session already has (the user's report, 24 Oct
 * 2026: suggestions "날라감" on the phone). The suggestion frame went to the window that showed the session when its
 * turn ended; a phone that opens the session afterwards, or reloads, missed it and showed none until the next turn.
 * Its hydration now reads the session's last suggestion from the tab's bridge (`get_next_prompt` → `last`). The
 * desktop cases (a background tab, a reload, a relaunch) are e2e/next-prompt-keep.e2e.ts, a paired host's lost link
 * e2e/remote-resume.e2e.ts.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, devices, expect, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { fixtureTailscale } from "./fixture/fake-tailscale-install";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { exitApp, fixtureOmp } from "./harness";

test("a phone opening a session after its turn ended shows the suggestion it had, and again after a reload", async () => {
	test.setTimeout(240_000);
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-phone-suggestion-")));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", themeName: "light", firstRunComplete: true, lastProject: project }),
	);
	const tailscale = await fixtureTailscale(root, { backendState: "Running" });
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	Object.assign(env, {
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(root),
		OMP_GUI_TEST_SESSION_FILES: "1",
		OMP_GUI_TEST_NEXT_PROMPT: JSON.stringify({ latencyMs: 1 }),
		...tailscale.env,
	});
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	let app: ElectronApplication | null = null;
	let proxy: ServeProxy | null = null;
	const browser = await chromium.launch();
	try {
		app = await electron.launch({
			args: [path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"), `--user-data-dir=${desktop}`],
			env,
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

		// The desktop runs a turn; its suggestion is made while no phone looks.
		const deskTabs = () => desk.evaluate(() => window.omp.tabs.list());
		const tabId = await desk.evaluate(
			async cwd => (await window.omp.tabs.spawn({ cwd, kind: "agent" }))?.tabId,
			project,
		);
		if (!tabId) throw new Error("no tab");
		await expect
			.poll(async () => (await deskTabs()).find(tab => tab.tabId === tabId)?.status, { timeout: 60_000 })
			.toBe("ready");
		await desk.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "hello" }), tabId);
		await expect
			.poll(async () => (await deskTabs()).find(tab => tab.tabId === tabId)?.lastRun?.reply, { timeout: 30_000 })
			.toBe("Local fixture reply");
		await expect
			.poll(
				async () => {
					const response = await desk.evaluate(
						id => window.omp.rpc.commandForTab(id, { type: "get_next_prompt" }),
						tabId,
					);
					return (response.data as { requests?: { suggest?: number } } | undefined)?.requests?.suggest ?? 0;
				},
				{ timeout: 20_000 },
			)
			.toBe(1);
		const sessionPath = (await deskTabs()).find(tab => tab.tabId === tabId)?.sessionPath ?? "";
		expect(sessionPath).not.toBe("");

		// The phone views that session.
		const context = await browser.newContext({ ...devices["Pixel 8"] });
		const phone = await context.newPage();
		await phone.goto(`${proxy.url}/`);
		await phonePaired(phone);
		const viewed = await phone.evaluate(
			([cwd, file]) => window.omp.tabs.spawn({ cwd, kind: "agent", sessionPath: file }),
			[project, sessionPath] as const,
		);
		if (!viewed?.tabId) throw new Error(`the phone could not view the session: ${JSON.stringify(viewed)}`);
		await phone.goto(`${proxy.url}/#/open?tab=${viewed.tabId}`);
		await expect(phone.locator("[data-composer-input]").first()).toBeEditable({ timeout: 60_000 });
		// On touch the best candidate leads the chips.
		const chips = phone.getByRole("group", { name: "Suggested messages" }).locator("button[data-next-chip]");
		await expect(chips.first()).toContainText("Run the tests", { timeout: 15_000 });

		await phone.reload();
		await expect(phone.locator("[data-composer-input]").first()).toBeEditable({ timeout: 60_000 });
		await expect(chips.first()).toContainText("Run the tests", { timeout: 15_000 });
	} finally {
		await browser.close().catch(() => undefined);
		await proxy?.close().catch(() => undefined);
		if (app) await exitApp(app).catch(() => undefined);
		await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
	}
});
