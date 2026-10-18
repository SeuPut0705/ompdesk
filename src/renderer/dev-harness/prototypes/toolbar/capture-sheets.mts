import * as fs from "node:fs/promises";
import * as path from "node:path";
import { chromium } from "@playwright/test";
import { LANGS, open, startVite, STATES, THEMES, WIDTHS } from "./capture.mts";

const OUT = "/tmp/composer-best/prototypes/toolbar/sheets";

export async function run(): Promise<void> {
	await fs.mkdir(OUT, { recursive: true });
	const harness = await startVite();
	const browser = await chromium.launch();
	let count = 0;
	try {
		for (const theme of THEMES) {
			for (const lang of LANGS) {
				const context = await browser.newContext({ viewport: { width: 1100, height: 700 } });
				const page = await context.newPage();
				const jobs: Array<{ state: string; width: number; model?: "long" }> = [];
				for (const state of STATES) for (const width of WIDTHS) jobs.push({ state, width });
				for (const state of ["plan-goal", "running-draft"]) for (const width of WIDTHS) jobs.push({ state, width, model: "long" });
				for (const job of jobs) {
					await page.setViewportSize({ width: Math.max(job.width + 60, 400), height: 700 });
					await open(page, harness.origin, { variant: "all", theme, lang, ...job });
					const name = `sheet-${job.state}-${job.width}-${theme}-${lang}${job.model ? "-longmodel" : ""}.png`;
					await page.screenshot({ path: path.join(OUT, name), fullPage: true });
					count++;
				}
				await context.close();
			}
		}
		console.log(`${count} sheets in ${OUT}`);
	} finally {
		await browser.close();
		await harness.close();
	}
}
