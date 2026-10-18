import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import type {
	InlineCompletion,
	NextPromptState,
	NextPromptUpdate,
} from "../resources/gui-bridge/modes/next-prompt-contracts";
import { exitApp } from "./harness";
import { realOmpProfile } from "./real-omp";

// Explicit opt-in: this audit spends model tokens (one turn on the main model, one suggestion and
// at most two inline requests on the `smol` role) and copies credentials only into a private
// disposable directory. Ordinary test runs never make calls.
//
// The isolated profile gets a main model that differs from its `smol` role whenever the account
// has two cheap models, so `used.model` proves the suggestion ran on smol and not on the main one.
const RESULT_FILE = "/tmp/real-next-prompt.json";
const CHEAP = /haiku|mini|flash|nano|lite/i;
const NEVER_MAIN = /opus|slow|pro\b|sol\b/i;
const DEFAULT_PLACEHOLDER = /^(Ask anything|Add an instruction|Send after|Connecting)/;
const LIST_MARK = /^\s*(?:\d{1,2}[.)]|[-*•])\s/;

/** `anthropic/claude-haiku-5-5:auto` → `anthropic/claude-haiku-5-5`. */
const bare = (value: string) => value.replace(/:[a-z]+$/i, "");

function pickModels(config: string): { smol: string; main: string; distinct: boolean } {
	const roles = new Map<string, string>();
	for (const match of config.matchAll(/^ {2}([A-Za-z][\w-]*):\s*(\S+)\s*$/gm)) roles.set(match[1], bare(match[2]));
	const smol = roles.get("smol");
	if (!smol) throw new Error("config.yml has no modelRoles.smol");
	const others = [...new Set(roles.values())].filter(model => model !== smol && !NEVER_MAIN.test(model));
	const main = others.find(model => CHEAP.test(model)) ?? others[0];
	return main ? { smol, main, distinct: true } : { smol, main: smol, distinct: false };
}

test("real omp built-in next prompt runs on smol and reaches the composer", async () => {
	test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in model audit");
	test.setTimeout(420_000);
	const { profile, project, desktop, agent, env } = await realOmpProfile();
	const configPath = path.join(agent, "config.yml");
	const { smol, main, distinct } = pickModels(
		await fs.readFile(path.join(os.homedir(), ".omp/agent/config.yml"), "utf8"),
	);
	const isolated = (await fs.readFile(configPath, "utf8"))
		.replace(/^ {2}default:\s*\S+\s*$/m, `  default: ${main}`)
		.replace(/^ {2}smol:\s*\S+\s*$/m, `  smol: ${smol}`);
	await fs.writeFile(configPath, isolated);

	const app = await electron.launch({
		args: [
			path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"),
			project,
			`--user-data-dir=${desktop}`,
		],
		env,
	});
	try {
		const page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
		await expect
			.poll(() => page.evaluate(() => window.omp.sidecar.getStatus()), { timeout: 60_000 })
			.toMatchObject({ status: "ready" });
		await page.evaluate(() => {
			const frames: Array<{ type?: string; [key: string]: unknown }> = [];
			Object.assign(window, { __nextPromptFrames: frames });
			window.omp.events.onTabBatch(events => {
				for (const event of events) {
					if (event.type === "next_prompt_update" || event.type === "agent_end") frames.push({ ...event });
				}
			});
		});
		const frames = () => page.evaluate(() => Reflect.get(window, "__nextPromptFrames") as Array<{ type?: string }>);
		const state = async (): Promise<NextPromptState> => {
			const response = await page.evaluate(() => window.omp.rpc.command({ type: "get_next_prompt" }));
			if (!response.success) throw new Error(`get_next_prompt failed: ${response.error}`);
			return response.data as NextPromptState;
		};

		// The bridge is loaded (state answers), the built-in is on, and the isolated profile
		// loads no extension, so the legacy `next-prompt` detection is false against the real omp.
		const before = await state();
		expect(before).toMatchObject({ suggestions: true, inline: true, legacyExtension: false });
		expect(before.requests).toEqual({ suggest: 0, inline: 0 });

		const mainState = await page.evaluate(() => window.omp.rpc.getState());
		const mainModel = (mainState.data as { model?: { provider?: string; id?: string } } | undefined)?.model;
		const mainId = mainModel?.provider && mainModel.id ? `${mainModel.provider}/${mainModel.id}` : main;

		// One turn.
		const input = page.locator("textarea").first();
		await input.fill("Reply with the single word ready.");
		await input.press("Enter");
		await expect
			.poll(async () => (await frames()).some(frame => frame.type === "agent_end"), { timeout: 180_000 })
			.toBe(true);

		// The suggestion reaches the composer: the placeholder is the best candidate.
		await expect
			.poll(async () => (await input.getAttribute("placeholder")) ?? "", { timeout: 120_000 })
			.not.toMatch(DEFAULT_PLACEHOLDER);
		const placeholder = (await input.getAttribute("placeholder")) ?? "";
		expect(placeholder.trim()).not.toBe("");

		const update = (await frames()).find(
			frame => frame.type === "next_prompt_update" && (frame as NextPromptUpdate).status === "ready",
		) as NextPromptUpdate | undefined;
		if (!update) throw new Error("No ready next_prompt_update frame was recorded");
		const candidates = update.candidates ?? [];
		expect(candidates.length).toBeGreaterThanOrEqual(1);
		expect(candidates.length).toBeLessThanOrEqual(3);
		for (const line of candidates) {
			expect(line.trim()).not.toBe("");
			expect(line).not.toContain("\n");
			expect(line).not.toMatch(LIST_MARK);
		}
		expect(placeholder).toBe(candidates[0]);
		expect(update.used?.role).toBe("smol");
		expect(update.used?.model).toBe(smol);
		if (distinct) {
			expect(mainId).toBe(main);
			expect(update.used?.model).not.toBe(mainId);
		}
		expect(typeof update.ms).toBe("number");

		// Inline completion: type a draft of at least 8 characters; ghost text arrives, or the
		// reason it did not is read from a direct request (the second and last inline request).
		await input.click();
		await input.pressSequentially("Please summarize the ");
		let ghost: string | null = null;
		let inlineReason: string | undefined;
		let inlineModel: string | undefined;
		let inlineMs: number | undefined;
		const ghostLocator = page.locator("[data-inline-ghost] .omp-inline-ghost-text");
		try {
			await expect(ghostLocator).toBeVisible({ timeout: 45_000 });
			ghost = (await ghostLocator.textContent()) ?? "";
		} catch {
			const direct = await page.evaluate(() =>
				window.omp.rpc.command({
					type: "complete_inline",
					draft: "Please summarize the ",
					requestId: "real-next-prompt-direct",
				}),
			);
			if (!direct.success) throw new Error(`complete_inline failed: ${direct.error}`);
			const result = direct.data as InlineCompletion;
			ghost = result.text;
			inlineReason = result.reason ?? (result.text === null ? "no continuation fits" : undefined);
			inlineModel = result.used?.model;
			inlineMs = result.ms;
		}

		const after = await state();
		expect(after.requests.suggest).toBe(1);
		expect(after.requests.inline).toBeLessThanOrEqual(2);
		expect(after.legacyExtension).toBe(false);

		const report = {
			mainModel: mainId,
			smolModel: smol,
			distinctModels: distinct,
			used: update.used,
			ms: update.ms,
			candidateCount: candidates.length,
			candidates,
			placeholder,
			requests: after.requests,
			legacyExtension: after.legacyExtension,
			inline: { ghost, reason: inlineReason, model: inlineModel, ms: inlineMs },
		};
		await fs.writeFile(RESULT_FILE, JSON.stringify(report, null, 2));
		console.log(`real-next-prompt ${JSON.stringify(report)}`);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
