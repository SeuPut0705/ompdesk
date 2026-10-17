import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp } from "./harness";
import { realOmpProfile } from "./real-omp";

// Explicit opt-in audit on the user's small model (OMP_GUI_REAL_WORK=1): with the reply language Korean, the
// texts a person reads in the main agent's tool calls follow it. Stock's task tool has no `description` field, so
// a subagent's title (`progress.description`) is stock's tiny-model label of the assignment; the prompt below is
// English on purpose, so the language can only come from the reply-language section.
/** Every string under a key called `key`, anywhere in `value`. */
function collect(value: unknown, key: string, into: string[] = []): string[] {
	if (Array.isArray(value)) for (const item of value) collect(item, key, into);
	else if (value && typeof value === "object") {
		for (const [name, child] of Object.entries(value)) {
			if (name === key && typeof child === "string") into.push(child);
			else collect(child, key, into);
		}
	}
	return into;
}

/** The first 200 characters of every thinking block the session files recorded (evidence that thinking keeps its language). */
async function readThinking(profile: string): Promise<string[]> {
	const out: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (entry.name.endsWith(".jsonl")) {
				for (const line of (await fs.readFile(full, "utf8")).split("\n")) {
					try {
						for (const text of collect(JSON.parse(line), "thinking")) out.push(text.slice(0, 200));
					} catch {
						// A partial or non-JSON line carries no thinking.
					}
				}
			}
		}
	};
	await walk(path.join(profile, "agent"));
	return out;
}

for (const [run, language, script] of [
	[1, "Korean", /[가-힣]/],
	[2, "Japanese", /[\u3040-\u30ff\u4e00-\u9fff]/],
] as const) {
	test(`real omp: subagent titles and todo items follow the ${language} reply language (run ${run})`, async () => {
		test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in model audit");
		test.setTimeout(420_000);
		const evidenceDir = process.env.OMP_GUI_REAL_WORK_ARTIFACTS ?? path.join(os.tmpdir(), "ompdesk-real-titles");
		await fs.mkdir(evidenceDir, { recursive: true });
		const { profile, project, desktop, env } = await realOmpProfile({ replyLanguage: language, autoTitle: false });
		await fs.writeFile(path.join(project, "alpha.txt"), "alpha\nbeta\ngamma\n");
		const app = await electron.launch({
			args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
			env,
		});
		try {
			const page = await app.firstWindow();
			await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
			await expect
				.poll(() => page.evaluate(() => window.omp.sidecar.getStatus()), { timeout: 60_000 })
				.toMatchObject({ status: "ready" });
			await page.evaluate(() => {
				const frames: unknown[] = [];
				const batches: unknown[] = [];
				Object.assign(window, { __titleFrames: frames, __titleBatches: batches });
				window.omp.events.onTabSubagentFrame(frame => frames.push(frame));
				window.omp.events.onTabBatch(events => batches.push(...events));
				// Subagent rows come and go within seconds: record what every place that lists one showed.
				const shown = new Set<string>();
				Object.assign(window, { __shown: shown });
				new MutationObserver(() => {
					for (const element of document.querySelectorAll(
						"[data-sidebar-subagents], .omp-work-card, [data-testid='workspace-dock']",
					))
						shown.add(element.textContent ?? "");
				}).observe(document.body, { subtree: true, childList: true, characterData: true });
			});
			const input = page.locator("textarea").first();
			await input.fill(
				"First use your todo tool to make a list with two tasks: counting the lines of alpha.txt and reporting the count. Then use the task tool exactly once to start ONE general-purpose agent using @smol that runs `wc -l alpha.txt` in the workspace root and reports the number. Wait for it, then reply in one sentence.",
			);
			await input.press("Enter");
			await expect(page.locator(".omp-work-card-button").first()).toBeVisible({ timeout: 180_000 });
			await expect(page.locator('.omp-execution-group[data-state="running"]')).toHaveCount(0, { timeout: 240_000 });
			const seen = await page.evaluate(() => {
				const audit = window as unknown as { __titleFrames: unknown[]; __titleBatches: unknown[] };
				return { frames: audit.__titleFrames, batches: audit.__titleBatches };
			});
			const titles = [...new Set(collect(seen.frames, "description"))];
			const assignments = [...new Set(collect(seen.frames, "assignment"))];
			const todoText = [...new Set(collect(seen.batches, "content"))].filter(
				text => text.length < 80 && !text.includes("\n"),
			);
			const sessionThinking = await readThinking(profile);
			const rows = await page.locator(".omp-work-card-button").allInnerTexts();
			const report = { titles, assignments, todoText, sessionThinking, rows };
			await fs.writeFile(path.join(evidenceDir, `titles-${language}.json`), JSON.stringify(report, null, 2));
			console.log(`TITLES ${language}: ${JSON.stringify(report)}`);
			const shown: string[] = await page.evaluate(() => Array.from(Reflect.get(window, "__shown")));
			const titleLines = assignments.map(text => text.split("\n")[0] ?? "");
			expect(titleLines.length, "the agent delegated").toBeGreaterThan(0);
			for (const line of titleLines) {
				expect(line, `assignment opens with a ${language} Title: line`).toMatch(script);
				expect(line).toMatch(/^Title: /);
				// What the interface shows is that line, not stock's English label.
				expect(
					shown.some(text => text.includes(line.slice("Title: ".length))),
					`a subagent row showed "${line}" (rows seen: ${JSON.stringify(shown)})`,
				).toBe(true);
			}
		} finally {
			await exitApp(app);
			await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});
}
