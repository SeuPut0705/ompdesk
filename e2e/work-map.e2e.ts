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
		await expect(page.locator(".omp-work-sub")).toContainText("Preparing the workspace");
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
		// The shown narrative: the step before it fades out underneath for a moment.
		await expect(page.locator(".omp-work-head [data-incoming] > .omp-work-narrative")).toHaveText(
			"Checking the workspace types",
		);
		await capture("narrative");
		await expect(page.locator(".omp-work-clock")).toContainText("No output for", { timeout: 15_000 });
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
		await expect(
			page.locator(".omp-work-stage > .omp-work-crossfade > [data-incoming] .omp-bash-terminal"),
		).toContainText("5 src/workspace.ts");
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
		await expect(
			page.locator(".omp-work-stage > .omp-work-crossfade > [data-incoming] .omp-bash-terminal"),
		).toContainText("5 src/workspace.ts");
		await capture("catch-up");
		await page.locator(".omp-work-catch-up").click();
		for (let index = 0; index < 8; index++) await advance();
		await expect(page.locator(".omp-work-outcome")).toBeVisible();
		await page.locator(".omp-work-outcome summary").click();
		await expect(page.locator(".omp-work-outcome")).toContainText("src/workspace.ts");
		await expect(page.locator('.omp-work-outcome li[data-kind="command"] [role="img"]').first()).toHaveAttribute(
			"aria-label",
			"Passed",
		);
		await expect(page.locator(".omp-work-outcome")).not.toContainText("exit 0");
		// Agent conclusions live on their lanes, not repeated in the outcome.
		await expect(page.locator(".omp-work-card-button").first()).toContainText("Workspace has 5 lines.");
		// Counts live once, in the card's head; the outcome keeps only its title and rows.
		await expect(page.locator(".omp-execution-group-summary").last()).toContainText("3 commands");
		await expect(page.locator(".omp-work-outcome summary")).toHaveText("Outcome");
		await expect(page.locator(".omp-work-outcome li").filter({ hasText: "wc -l src/workspace.ts" })).toHaveCount(2);
		await capture("outcome");
		const commandTape = await fs.readFile(record, "utf8");
		await test.info().attach("bridge-commands", { body: commandTape, contentType: "application/x-ndjson" });
		const log = commandTape
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as { type: string; level?: string });
		// Showing/replaying a surface and outcome hydration are bounded; auto-follow never polls.
		const hydrations = log.filter(command => command.type === "get_subagent_messages").length;
		expect(hydrations).toBeGreaterThanOrEqual(3);
		expect(hydrations).toBeLessThanOrEqual(4);
		expect(log.some(command => command.type === "set_subagent_subscription" && command.level === "events")).toBe(
			true,
		);
		expect(log.some(command => command.type === "set_subagent_subscription" && command.level === "progress")).toBe(
			true,
		);
		// At normal width every finished head shows its whole summary row: duration, counts and meter,
		// none of them ellipsized or dropped while the head has room.
		const cutParts = () =>
			page.locator(".omp-summary-line").evaluateAll(lines =>
				lines.flatMap(line => {
					const box = line.getBoundingClientRect();
					return [...line.querySelectorAll(".omp-summary-part")].flatMap(part => {
						const rect = part.getBoundingClientRect();
						const shown = rect.top < box.bottom - 1;
						return shown && part.scrollWidth <= part.clientWidth
							? []
							: [`${shown ? "cut" : "dropped"}: ${part.textContent}`];
					});
				}),
			);
		await expect.poll(cutParts).toEqual([]);
		// At the narrowest window the finished head keeps a readable narrative and its summary row
		// truncates inside the card instead of running past its edge.
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(800, 900));
		await expect
			.poll(() =>
				page
					.locator(".omp-live-step:not([data-nested='true'])")
					.first()
					.evaluate(card => {
						const head = card.querySelector(".omp-work-head");
						const narrative = card.querySelector(".omp-work-narrative")?.getBoundingClientRect();
						const side = card.querySelector(".omp-work-head-side")?.getBoundingClientRect();
						const bounds = card.getBoundingClientRect();
						if (!head || !narrative || !side || bounds.width > 560) return "not narrow yet";
						return (
							narrative.width >= 120 && side.right <= bounds.right + 0.5 && head.scrollWidth <= head.clientWidth
						);
					}),
			)
			.toBe(true);
		// Narrow, the row drops whole parts from its end and never shows a figure cut mid-word.
		await expect.poll(async () => (await cutParts()).filter(part => part.startsWith("cut"))).toEqual([]);
		await capture("narrow");
		const directory = process.env.OMP_GUI_WORK_SCREENSHOTS;
		if (directory) {
			// The UI language applies on the next load: this is also the reload of a finished run.
			await page.evaluate(() => window.omp.prefs.set("language", "ko"));
			await page.reload();
			await expect(page.locator(".omp-work-outcome summary").first()).toHaveText("결과", { timeout: 60_000 });
			await expect.poll(async () => (await cutParts()).filter(part => part.startsWith("cut"))).toEqual([]);
			await page.screenshot({
				path: path.join(directory, "work-narrow-ko-dark.png"),
				animations: "disabled",
				scale: "css",
			});
		}
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
