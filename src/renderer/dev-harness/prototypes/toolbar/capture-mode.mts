/**
 * C4 extra (real clicks): what moves when a mode is switched on, a thinking level is picked, or the approval changes
 * to a longer name. Prints a markdown table and writes /tmp/composer-best/prototypes/toolbar/mode-shift.md.
 */

import * as fs from "node:fs/promises";
import { chromium, type Page } from "@playwright/test";
import { delta, snap } from "./capture-measure.mts";
import { open, startVite, VARIANTS } from "./capture.mts";

const sel = (v: string, proto: string) => `[data-variant="${v}"] [data-proto="${proto}"]`;

async function toggleMode(page: Page, v: string): Promise<void> {
	if (v === "c") {
		await page.locator(`[data-variant="c"] [data-proto="plus"] button`).click();
		await page.getByRole("menuitemcheckbox").first().click();
		return;
	}
	const chip = v === "b" ? "run" : "mode";
	await page.locator(sel(v, chip)).click();
	await page.locator(`[data-proto-panel="${chip}"] [data-mode-switch="plan"]`).click();
	await page.keyboard.press("Escape");
}

async function pickThinking(page: Page, v: string): Promise<void> {
	if (v === "a" || v === "base") {
		await page.locator(sel(v, "run")).click();
		await page.locator('[data-proto-panel="run"] select[data-thinking-level]').selectOption("medium");
	} else {
		await page.locator(sel(v, "model")).click();
		await page.locator('[data-proto-panel="model"] [data-tab-id="medium"]').click();
	}
	await page.keyboard.press("Escape");
}

async function pickApproval(page: Page, v: string): Promise<void> {
	await page.locator(sel(v, "run")).click();
	await page.locator('[data-proto-panel="run"] select[data-approval-mode]').selectOption("always-ask");
	await page.keyboard.press("Escape");
}

export async function run(): Promise<void> {
	const harness = await startVite();
	const browser = await chromium.launch();
	const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
	const lines = [
		"| variant | width | change | Δh | max Δx | max Δy | max Δw | controls that moved |",
		"|---|---|---|---|---|---|---|---|",
	];
	try {
		for (const lang of ["en", "ko"]) {
			for (const width of [1000, 560]) {
				for (const variant of VARIANTS) {
					await page.setViewportSize({ width: width + 60, height: 760 });
					await open(page, harness.origin, { variant, state: "idle", theme: "light", lang, width });
					const steps: Array<[string, (p: Page, v: string) => Promise<void>]> = [
						["Plan mode on", toggleMode],
						["Thinking → Medium", pickThinking],
						["Approval → Ask every time", pickApproval],
					];
					for (const [name, act] of steps) {
						const before = await snap(page, variant);
						try {
							await act(page, variant);
						} catch (error) {
							console.error(`retry ${variant} ${width} ${lang} ${name}: ${String(error).slice(0, 120)}`);
							await page.keyboard.press("Escape");
							await page.waitForTimeout(400);
							await act(page, variant);
						}
						await page.waitForTimeout(400);
						const after = await snap(page, variant);
						const d = delta(before, after);
						lines.push(
							`| ${variant} | ${width} ${lang} | ${name} | ${d.heightDelta} | ${d.maxDx} | ${d.maxDy} | ${d.maxDw} | ${d.moved.join(", ") || "—"} |`,
						);
					}
				}
			}
		}
	} finally {
		await browser.close();
		await harness.close();
	}
	await fs.writeFile("/tmp/composer-best/prototypes/toolbar/mode-shift.md", lines.join("\n"));
	console.log(lines.join("\n"));
}
