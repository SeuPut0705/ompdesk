/**
 * The bot on the phone's page (components/bot), behind the fake `tailscale serve`: the phone views the bot session a
 * desktop window holds and gets the one screen there too, the bar over the conversation, the decision docked above
 * the composer (answered with a tap, reaching the bot's omp once), and the duties in the work strip's panel. Chromium
 * as a Pixel 8. `OMPDESK_BOT_SHOTS=<dir>` keeps the screenshots.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, devices, expect, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { fixtureTailscale } from "./fixture/fake-tailscale-install";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { captureTo, controlToolCaller, exitApp, fixtureOmp, mailReports } from "./harness";

const SHOTS = process.env.OMPDESK_BOT_SHOTS;

test("the phone views the bot as one screen: bar, conversation, a decision it answers and the duties", async () => {
	test.setTimeout(240_000);
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-mobile-bot-")));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({
			language: "en",
			themeName: "light",
			firstRunComplete: true,
			lastProject: project,
			botEnabled: true,
		}),
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

		// The desktop holds the bot's tab, and the bot posts a duty and a decision from it.
		let botPath = "";
		await expect
			.poll(
				async () => {
					const value = await desk.evaluate(() => window.omp.prefs.get("bot"));
					botPath = typeof value === "string" ? value : "";
					return botPath;
				},
				{ timeout: 30_000 },
			)
			.not.toBe("");
		await desk.locator("[data-sidebar-bot-row]").click();
		let botTab = "";
		let botCwd = "";
		await expect
			.poll(
				async () => {
					const tab = (await desk.evaluate(() => window.omp.tabs.list())).find(
						entry => entry.sessionPath === botPath,
					);
					botTab = tab?.tabId ?? "";
					botCwd = tab?.cwd ?? "";
					return tab?.status;
				},
				{ timeout: 60_000 },
			)
			.toBe("ready");
		const callBot = await controlToolCaller(desk, record, botTab);
		expect((await callBot("ompdesk_bot", { action: "duty_add", text: "Check the nightly build" })).isError).toBe(
			false,
		);
		const posted = await callBot("ompdesk_bot", {
			action: "decide",
			question: "Ship the release today?",
			options: ["Ship it", "Wait"],
		});
		expect(posted.isError, posted.text).toBe(false);
		const id = /Decision (\S+) is posted/.exec(posted.text)?.[1] ?? "";
		expect(id).not.toBe("");

		await desk.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
		await expect
			.poll(() => desk.evaluate(async () => (await window.omp.mobileWeb.getState()).phase), { timeout: 60_000 })
			.toBe("ready");
		await expect.poll(() => serveSites(tailscale).length, { timeout: 30_000 }).toBeGreaterThan(0);
		const site = serveSites(tailscale).at(-1);
		if (!site) throw new Error("serve publishes no handler");
		proxy = await ServeProxy.start(site, "seuput@example.com");

		// The phone views the bot's session, as its drawer row's tap does.
		const context = await browser.newContext({ ...devices["Pixel 8"] });
		const phone = await context.newPage();
		await phone.goto(`${proxy.url}/`, { timeout: 60_000 });
		await phonePaired(phone);
		const viewed = await phone.evaluate(
			([cwd, sessionPath]) => window.omp.tabs.spawn({ cwd, kind: "chat", sessionPath }),
			[botCwd, botPath] as const,
		);
		if (!viewed?.tabId) throw new Error(`the phone could not view the bot: ${JSON.stringify(viewed)}`);
		await phone.goto(`${proxy.url}/#/open?tab=${viewed.tabId}`);
		await expect(phone.locator("[data-composer-input]").first()).toBeEditable({ timeout: 60_000 });

		const bar = phone.locator("[data-bot-bar] [data-bot-state]");
		await expect(bar).toBeVisible({ timeout: 30_000 });
		await expect(phone.locator("[data-bot-bar] [data-bot-next-wake]")).toBeVisible();
		await expect(phone.getByRole("tablist")).toHaveCount(0);
		const card = phone.locator("[data-bot-decision]");
		await expect(card).toContainText("Ship the release today?");
		const strip = phone.locator("[data-work-strip] [data-work-chip]");
		await expect(strip).toContainText("Duties 1");
		// Bar, strip, decision and composer each keep their own place on the first screen.
		const boxes = await Promise.all(
			[
				phone.locator("[data-bot-bar]"),
				strip,
				phone.locator("[data-bot-decisions-dock]"),
				phone.locator(".omp-composer-box").first(),
			].map(async locator => (await locator.boundingBox()) ?? { y: Number.NaN, height: 0 }),
		);
		for (let index = 1; index < boxes.length; index += 1) {
			const above = boxes[index - 1] ?? { y: Number.NaN, height: 0 };
			expect((boxes[index]?.y ?? Number.NaN) + 0.5).toBeGreaterThanOrEqual(above.y + above.height);
		}
		await captureTo(SHOTS, phone, "bot-phone");

		await strip.tap();
		await phone.locator('[data-board-section="duties"] .omp-work-board-fold').tap();
		await expect(phone.locator("[data-bot-duty]")).toContainText(["Check the nightly build"]);
		await captureTo(SHOTS, phone, "bot-phone-strip");
		await strip.tap();

		await card.locator('[data-bot-option="Ship it"]').tap();
		await expect(card).toHaveCount(0);
		const answers = () => mailReports(record, details => details.id === `bot-decision-${id}`);
		await expect.poll(async () => (await answers()).length, { timeout: 30_000 }).toBe(1);
	} finally {
		await browser.close().catch(() => undefined);
		await proxy?.close().catch(() => undefined);
		if (app) await exitApp(app).catch(() => undefined);
		await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
	}
});
