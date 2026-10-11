import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

test("inline work cards stream tool evidence, catch up and retain outcomes without polling", async () => {
	test.setTimeout(180_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-work-map-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	const record = path.join(profile, "commands.jsonl");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(profile),
		OMP_GUI_TEST_RECORD: record,
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env,
	});
	try {
		const page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		const input = page.locator("textarea").first();
		await input.fill("fixture work view");
		await input.press("Enter");
		await expect(page.locator(".omp-live-work-calm")).toContainText("Preparing the workspace");
		const tab = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId;
		if (!tab) throw new Error("Missing work tab");
		const advance = () =>
			page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:work-next" }), tab);
		const output = () =>
			page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:work-output" }), tab);
		const capture = async (state: string) => {
			const directory = process.env.OMP_GUI_WORK_SCREENSHOTS;
			if (!directory) return;
			await fs.mkdir(directory, { recursive: true });
			for (const [theme, label] of [
				["light", "Porcelain"],
				["dark", "Graphite"],
			]) {
				await input.fill("/theme");
				await page.getByRole("button", { name: "Send", exact: true }).click();
				const dialog = page.getByRole("dialog");
				await dialog.getByPlaceholder("Search themes…").fill(label);
				await dialog.locator("button[aria-pressed]").filter({ hasText: label }).click();
				await expect(dialog).toHaveCount(0);
				const notice = page
					.getByRole("status")
					.filter({ hasText: `Theme: ${label}` })
					.last();
				await expect(notice).toBeVisible();
				await page.getByRole("button", { name: "Close", exact: true }).evaluateAll(buttons => {
					for (const button of buttons) if (button instanceof HTMLButtonElement) button.click();
				});
				await expect(page.locator(".omp-toast-in, .omp-toast-out")).toHaveCount(0);
				await page.screenshot({
					path: path.join(directory, `work-${state}-${theme}.png`),
					animations: "disabled",
					scale: "css",
				});
			}
		};
		await advance();
		await expect(page.locator(".omp-work-narrative")).toHaveText("Checking the workspace types");
		await capture("narrative");
		await expect(page.locator(".omp-work-clock")).toContainText("without output", { timeout: 15_000 });
		await capture("stall");
		await advance();
		await advance();
		await advance();
		const cards = page.locator(".omp-work-card-button");
		await expect(cards).toHaveCount(2);
		await expect(cards.first()).toContainText("Reading source files");
		await capture("cards");
		await cards.first().click();
		await output();
		await expect(page.locator(".omp-work-card .omp-bash-terminal")).toContainText("5 src/workspace.ts");
		await expect(cards.first()).toContainText("Counting source lines");
		await expect(cards.first()).toContainText("2 tools · 84 tokens");
		await capture("expanded");
		await cards.first().click();
		await page.keyboard.press("ControlOrMeta+t");
		await expect(page.locator(".omp-work-card")).toHaveCount(0);
		await advance();
		await advance();
		await page.locator(`[data-session-path="tab:${tab}"]`).click();
		await expect(page.locator(".omp-work-catch-up")).toContainText(/steps? advanced while you were away/);
		await capture("catch-up");
		await page.locator(".omp-work-catch-up").click();
		for (let index = 0; index < 8; index++) await advance();
		await expect(page.locator(".omp-work-outcome")).toBeVisible();
		await page.locator(".omp-work-outcome summary").click();
		await expect(page.locator(".omp-work-outcome")).toContainText("src/workspace.ts");
		await expect(page.locator(".omp-work-outcome")).toContainText("Passed · exit 0");
		await expect(page.locator(".omp-work-outcome")).toContainText("Workspace has 5 lines.");
		await expect(page.locator(".omp-work-outcome summary")).toContainText("3 commands");
		await expect(page.locator(".omp-work-outcome li").filter({ hasText: "wc -l src/workspace.ts" })).toHaveCount(2);
		await capture("outcome");
		const log = (await fs.readFile(record, "utf8"))
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as { type: string; level?: string });
		expect(log.filter(command => command.type === "get_subagent_messages")).toHaveLength(3);
		expect(log.some(command => command.type === "set_subagent_subscription" && command.level === "events")).toBe(
			true,
		);
		expect(log.some(command => command.type === "set_subagent_subscription" && command.level === "progress")).toBe(
			true,
		);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
