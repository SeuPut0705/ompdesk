import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

test("actual stock frames preserve live and completed agent replay without false failures", async () => {
	test.setTimeout(180_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-real-replay-"));
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
		await input.fill("fixture real work replay");
		await input.press("Enter");
		const tab = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId;
		if (!tab) throw new Error("Missing replay tab");
		const advance = () =>
			page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:replay-next" }), tab);
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
				await page.getByRole("button", { name: "Close", exact: true }).evaluateAll(buttons => {
					for (const button of buttons) if (button instanceof HTMLButtonElement) button.click();
				});
				await expect(page.locator(".omp-toast-in, .omp-toast-out")).toHaveCount(0);
				await page.screenshot({
					path: path.join(directory, `real-replay-${state}-${theme}.png`),
					animations: "disabled",
					scale: "css",
				});
			}
		};
		const cards = page.locator(".omp-work-card-button");
		await expect(cards).toHaveCount(2);
		await expect(cards.first()).toContainText("Count lines in alpha.txt");
		await capture("running");
		await cards.first().click();
		const surface = page.locator(".omp-work-card .omp-live-step").first();
		await expect(surface).toHaveAttribute("data-surface", "bash");
		await expect(surface).toContainText("sleep 3 && wc -l alpha.txt");
		await expect(cards.first()).not.toContainText("0 tools");
		await expect(cards.first()).not.toContainText("0 tokens");
		const work = page.locator(".omp-execution-group > .omp-live-step");
		await expect(work.locator(".omp-live-step-scroll:visible")).toHaveCount(1);
		// The open lane hangs its agent's surface directly beneath its own row.
		await expect(work.locator('.omp-work-card[data-open="true"]')).toHaveCount(1);
		const rowBox = await cards.first().boundingBox();
		const surfaceBox = await surface.boundingBox();
		if (!rowBox || !surfaceBox) throw new Error("Missing lane geometry");
		expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(surfaceBox.y);
		const nextBox = await cards.nth(1).boundingBox();
		if (!nextBox) throw new Error("Missing second lane");
		expect(surfaceBox.y + surfaceBox.height).toBeLessThanOrEqual(nextBox.y);
		await capture("expanded-live");
		await advance();
		await expect(surface).toContainText("3 alpha.txt");
		await expect(cards.first()).toContainText("1 tool ·");
		await cards.first().click();
		await advance();
		await expect(page.locator('.omp-execution-group[data-state="running"]')).toHaveCount(0);
		await expect(page.locator('.omp-execution-group[data-state="failed"]')).toHaveCount(0);
		await expect(page.locator(".omp-execution-group-summary")).toHaveText("2 steps complete");
		await expect(page.locator(".omp-execution-group-duration")).toHaveText(/^· [1-9]\d*(?:\.\d+)?s$/);
		await expect(page.locator(".omp-execution-group-header")).toContainText("408 tokens");
		await expect(work.locator(".omp-work-head .omp-work-narrative")).toHaveText("Work complete");
		await expect(work).toHaveAttribute("data-state", "complete");
		await expect(cards.first()).toContainText("alpha.txt contains 3 lines.");
		await expect(cards.nth(1)).toContainText("beta.txt contains 2 lines.");
		await expect(work).toHaveAttribute("data-outcome", "true");
		await expect(work.locator(".omp-live-work-heading:visible")).toHaveCount(0);
		await expect(work.locator(".omp-live-work-chips button")).toHaveCount(2);
		await expect(work).not.toContainText("Skipped due to");
		await expect(work).not.toContainText("retry the skipped tool");
		await expect(work.locator(".omp-work-outcome")).toBeVisible();
		const outcome = page.locator(".omp-work-outcome");
		await expect(outcome).toBeVisible();
		await expect(outcome.locator("summary")).toContainText("2 commands");
		await outcome.locator("summary").click();
		await expect(outcome).toContainText("AlphaCounter");
		await expect(outcome).toContainText("BetaCounter");
		await expect(outcome.locator("li").filter({ hasText: "sleep 3" })).toHaveCount(2);
		await expect(outcome.locator('li[data-kind="command"] [role="img"][aria-label="Succeeded"]')).toHaveCount(2);
		await expect(outcome.locator("li").filter({ hasText: "exit 0" })).toHaveCount(0);
		await expect(outcome.locator('li[data-kind="agent"]')).toHaveCount(0);
		await capture("complete");
		await cards.first().click();
		await expect(surface).toBeVisible();
		await expect(surface).toHaveAttribute("data-running", "false");
		await expect(surface).toHaveAttribute("data-surface", "yield");
		// A finished group keeps its outcome under an open lane.
		await expect(work).toHaveAttribute("data-outcome", "true");
		await expect(work.locator(":scope > .omp-work-outcome")).toBeVisible();
		// Opening a lane is not a replay: no "back" control on the group.
		await expect(work.locator(":scope > .omp-live-work-strip .omp-live-work-follow")).toHaveCount(0);
		await capture("completed-last-step");
		await surface.getByRole("button", { name: /Run command/ }).click();
		await expect(surface).toHaveAttribute("data-surface", "bash");
		await expect(surface).toContainText("3 alpha.txt");
		await capture("completed-replay");
		await cards.first().click();
		await expect(work).toHaveAttribute("data-outcome", "true");
		await expect(surface).toHaveCount(0);
		await work.locator(":scope > .omp-live-work-strip .omp-live-work-chips button").last().click();
		await expect(work).toHaveAttribute("data-outcome", "false");
		await expect(work.locator(":scope > .omp-work-surface .omp-live-step-scroll")).toContainText(
			"Waiting for background activity",
		);
		await expect(work).not.toContainText("Skipped due to");
		await work.locator(":scope > .omp-live-work-strip .omp-live-work-follow").click();
		await expect(work).toHaveAttribute("data-outcome", "true");
		await cards.first().click();
		await cards.first().click();
		await cards.nth(1).click();
		await page
			.locator(".omp-work-card .omp-live-step")
			.getByRole("button", { name: /Run command/ })
			.click();
		await expect(page.locator(".omp-work-card .omp-live-step")).toContainText("2 beta.txt");
		const commands = (await fs.readFile(record, "utf8"))
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as { type: string; subagentId?: string; level?: string });
		expect(
			commands.filter(command => command.type === "get_subagent_messages" && command.subagentId === "AlphaCounter"),
		).toHaveLength(2);
		expect(
			commands.filter(command => command.type === "get_subagent_messages" && command.subagentId === "BetaCounter"),
		).toHaveLength(1);
		expect(commands.some(command => command.type === "set_subagent_subscription" && command.level === "events")).toBe(
			true,
		);
		expect(commands.filter(command => command.type === "set_subagent_subscription").at(-1)?.level).toBe("progress");
		if (process.env.OMP_GUI_WORK_SCREENSHOTS) {
			const drag = async (id: string, targetIndex: number, x: number, y: number) => {
				const source = await page.locator(`[data-session-path="tab:${id}"]`).boundingBox();
				const target = await page.locator(".omp-session-pane").nth(targetIndex).boundingBox();
				if (!source || !target) throw new Error("Missing split drag geometry");
				await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
				await page.mouse.down();
				await page.mouse.move(source.x + source.width / 2 + 20, source.y + source.height / 2, { steps: 4 });
				await page.mouse.move(target.x + target.width * x + 2, target.y + target.height * y, { steps: 12 });
				await page.mouse.move(target.x + target.width * x, target.y + target.height * y, { steps: 2 });
				await expect(page.locator("[data-split-ghost]")).toHaveCount(1);
				await page.mouse.up();
			};
			for (const [target, x, y] of [
				[0, 0.92, 0.5],
				[0, 0.5, 0.92],
				[2, 0.5, 0.92],
			]) {
				const spawned = await page.evaluate(() => window.omp.tabs.spawn({ kind: "agent" }));
				if (!spawned?.tabId) throw new Error("Missing split tab");
				await expect
					.poll(
						async () =>
							(await page.evaluate(() => window.omp.tabs.list())).find(row => row.tabId === spawned.tabId)
								?.status,
					)
					.toBe("ready");
				await drag(spawned.tabId, target, x, y);
			}
			await expect(page.locator(".omp-session-pane")).toHaveCount(4);
			const pane = page.locator(`[data-tab-id="${tab}"]`);
			await pane.locator(".omp-work-card-button").first().scrollIntoViewIfNeeded();
			const paneBox = await pane.boundingBox();
			const workBox = await pane.locator(".omp-live-step").first().boundingBox();
			if (!paneBox || !workBox) throw new Error("Missing bounded split surface");
			expect(workBox.height).toBeLessThan(paneBox.height * 0.65);
			const summaryBox = await pane.locator(".omp-work-outcome summary").boundingBox();
			const stripBox = await pane
				.locator(".omp-live-step")
				.first()
				.locator(":scope > .omp-live-work-strip")
				.boundingBox();
			if (!summaryBox || !stripBox) throw new Error("Missing split outcome geometry");
			expect(summaryBox.y).toBeGreaterThanOrEqual(workBox.y);
			expect(summaryBox.y + summaryBox.height).toBeLessThanOrEqual(stripBox.y);
			await expect(pane.locator(".omp-work-outcome summary")).toBeVisible();
			await page.screenshot({
				path: path.join(process.env.OMP_GUI_WORK_SCREENSHOTS, "real-replay-split-2x2-dark.png"),
				animations: "disabled",
				scale: "css",
			});
		}
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
