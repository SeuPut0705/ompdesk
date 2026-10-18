/**
 * Measurements of the toolbar prototypes: everything comes from Playwright `boundingBox`/`getBoundingClientRect`
 * (no eyeballing). Writes /tmp/composer-best/prototypes/toolbar/measure.json and prints the tables as markdown.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { chromium, type Page } from "@playwright/test";
import { LANGS, open, STATES, startVite, VARIANTS, WIDTHS } from "./capture.mts";

const OUT = "/tmp/composer-best/prototypes/toolbar";

interface Ctl {
	key: string;
	x: number;
	y: number;
	w: number;
	h: number;
	right: number;
	hidden: boolean;
	text: string;
	label: string | null;
}
export interface Snap {
	toolbarH: number;
	toolbarW: number;
	boxW: number;
	boxH: number;
	controls: Ctl[];
	/** px the rightmost control reaches into the toolbar's right padding (>0) or past the box (clipping). */
	overflowIntoPadding: number;
	beyondBox: number;
	overlaps: number;
	truncated: string[];
	visibleText: string[];
}

/** Runs in the page. */
function snapshotInPage(variantId: string): Snap {
	const sec = document.querySelector(`[data-variant="${variantId}"]`) as HTMLElement;
	const box = sec.querySelector("[data-proto-box]") as HTMLElement;
	const tb = sec.querySelector("[data-proto-toolbar]") as HTMLElement;
	const tr = tb.getBoundingClientRect();
	const br = box.getBoundingClientRect();
	const controls: Ctl[] = [];
	for (const el of Array.from(tb.querySelectorAll<HTMLElement>("button, select, [role=button]"))) {
		const cs = getComputedStyle(el);
		const r = el.getBoundingClientRect();
		if (r.width === 0 || cs.display === "none") continue;
		const owner = el.closest<HTMLElement>("[data-proto]");
		controls.push({
			key: owner?.dataset.proto ?? el.getAttribute("aria-label") ?? "?",
			x: r.x - tr.x,
			y: r.y - tr.y,
			w: r.width,
			h: r.height,
			right: r.right,
			hidden: cs.visibility === "hidden",
			text: el.innerText.trim(),
			label: el.getAttribute("aria-label"),
		});
	}
	const rightLimit = tr.right - 10;
	let overflowIntoPadding = -999;
	let beyondBox = -999;
	for (const c of controls) {
		overflowIntoPadding = Math.max(overflowIntoPadding, c.right - rightLimit);
		beyondBox = Math.max(beyondBox, c.right - br.right);
	}
	let overlaps = 0;
	for (let i = 0; i < controls.length; i++) {
		for (let j = i + 1; j < controls.length; j++) {
			const a = controls[i];
			const b = controls[j];
			const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
			const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
			if (ix > 1 && iy > 1) overlaps++;
		}
	}
	const truncated: string[] = [];
	for (const el of Array.from(tb.querySelectorAll<HTMLElement>("span"))) {
		if (el.offsetParent !== null && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== "visible") {
			truncated.push(el.textContent?.trim() ?? "");
		}
	}
	return {
		toolbarH: tr.height,
		toolbarW: tr.width,
		boxW: br.width,
		boxH: br.height,
		controls,
		overflowIntoPadding: Math.round(overflowIntoPadding * 10) / 10,
		beyondBox: Math.round(beyondBox * 10) / 10,
		overlaps,
		truncated,
		visibleText: controls.filter(c => !c.hidden && c.text !== "").map(c => `${c.key}:${c.text}`),
	};
}

export async function snap(page: Page, variant: string): Promise<Snap> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await page.evaluate(snapshotInPage, variant);
		} catch (error) {
			// Vite may reload the page once after it optimizes a dependency: wait for the sheet and look again.
			if (attempt >= 3) throw error;
			await page.waitForTimeout(2000);
			await page.waitForSelector("[data-proto-toolbar]");
		}
	}
}

export interface Delta {
	heightDelta: number;
	maxDx: number;
	maxDy: number;
	maxDw: number;
	moved: string[];
	appeared: string[];
	vanished: string[];
}

export function delta(a: Snap, b: Snap): Delta {
	const am = new Map(a.controls.map(c => [c.key, c]));
	const bm = new Map(b.controls.map(c => [c.key, c]));
	let maxDx = 0;
	let maxDy = 0;
	let maxDw = 0;
	const moved: string[] = [];
	for (const [key, ca] of am) {
		const cb = bm.get(key);
		if (!cb) continue;
		const dx = Math.abs(ca.x - cb.x);
		const dy = Math.abs(ca.y - cb.y);
		const dw = Math.abs(ca.w - cb.w);
		maxDx = Math.max(maxDx, dx);
		maxDy = Math.max(maxDy, dy);
		maxDw = Math.max(maxDw, dw);
		if (dx > 0.5 || dy > 0.5 || dw > 0.5) moved.push(`${key}(${Math.round(cb.x - ca.x)},${Math.round(cb.y - ca.y)},${Math.round(cb.w - ca.w)}w)`);
	}
	const round = (n: number) => Math.round(n * 10) / 10;
	return {
		heightDelta: round(b.toolbarH - a.toolbarH),
		maxDx: round(maxDx),
		maxDy: round(maxDy),
		maxDw: round(maxDw),
		moved,
		appeared: [...bm.keys()].filter(key => !am.has(key)),
		vanished: [...am.keys()].filter(key => !bm.has(key)),
	};
}

/** Runs in the page: how wide/tall is the area a press hits around a control's centre (pseudo-elements count). */
function hitInPage(variantId: string): Array<{ key: string; w: number; h: number; boxW: number; boxH: number }> {
	const tb = document.querySelector(`[data-variant="${variantId}"] [data-proto-toolbar]`) as HTMLElement;
	const out: Array<{ key: string; w: number; h: number; boxW: number; boxH: number }> = [];
	for (const el of Array.from(tb.querySelectorAll<HTMLElement>("button"))) {
		const cs = getComputedStyle(el);
		const r = el.getBoundingClientRect();
		if (r.width === 0 || cs.visibility === "hidden") continue;
		const cx = r.x + r.width / 2;
		const cy = r.y + r.height / 2;
		const ok = (x: number, y: number) => {
			const hit = document.elementFromPoint(x, y);
			return hit !== null && (hit === el || el.contains(hit));
		};
		let l = 0;
		let rr = 0;
		let u = 0;
		let d = 0;
		while (l < 80 && ok(cx - l - 1, cy)) l++;
		while (rr < 80 && ok(cx + rr + 1, cy)) rr++;
		while (u < 80 && ok(cx, cy - u - 1)) u++;
		while (d < 80 && ok(cx, cy + d + 1)) d++;
		out.push({
			key: el.closest<HTMLElement>("[data-proto]")?.dataset.proto ?? el.getAttribute("aria-label") ?? "?",
			w: l + rr + 1,
			h: u + d + 1,
			boxW: r.width,
			boxH: r.height,
		});
	}
	return out;
}

const sel = (v: string, proto: string) => `[data-variant="${v}"] [data-proto="${proto}"]`;

/** Live transitions: idle → typing → turn starts → typing while running → Stop. Each step is a real click/keypress. */
async function transitions(page: Page, variant: string) {
	const steps: Array<{ name: string; snap: Snap }> = [];
	const field = page.locator(`[data-variant="${variant}"] textarea`);
	steps.push({ name: "idle", snap: await snap(page, variant) });
	await field.click();
	await page.keyboard.type("go ahead");
	steps.push({ name: "draft typed", snap: await snap(page, variant) });
	await page.locator(sel(variant, "send")).click();
	await page.waitForTimeout(120);
	steps.push({ name: "turn started (Send clicked)", snap: await snap(page, variant) });
	await field.click();
	await page.keyboard.type("one more thing");
	steps.push({ name: "draft typed while running", snap: await snap(page, variant) });
	await page.locator(sel(variant, "stop")).click();
	await page.waitForTimeout(120);
	steps.push({ name: "turn ended (Stop clicked)", snap: await snap(page, variant) });
	const rows = [];
	for (let i = 1; i < steps.length; i++) rows.push({ step: `${steps[i - 1].name} → ${steps[i].name}`, ...delta(steps[i - 1].snap, steps[i].snap) });
	return rows;
}

async function popoverPass(page: Page, variant: string, id: string) {
	const trigger = id === "plus" ? page.locator(`[data-variant="${variant}"] [data-proto="plus"] button`) : page.locator(sel(variant, id));
	if ((await trigger.count()) === 0) return null;
	const before = await snap(page, variant);
	await trigger.click();
	await page.waitForTimeout(350);
	const during = await snap(page, variant);
	const panel = page.locator(id === "plus" ? '[role="menu"]' : `[data-proto-panel="${id}"]`).first();
	const bb = await panel.boundingBox();
	const vp = page.viewportSize() ?? { width: 0, height: 0 };
	await page.keyboard.press("Escape");
	await page.waitForTimeout(250);
	const after = await snap(page, variant);
	return {
		id,
		open: delta(before, during),
		close: delta(before, after),
		panel: bb && { w: Math.round(bb.width), h: Math.round(bb.height), top: Math.round(bb.y), inViewport: bb.y >= 0 && bb.x >= 0 && bb.x + bb.width <= vp.width && bb.y + bb.height <= vp.height },
	};
}

async function taps(page: Page, variant: string) {
	const results: Array<{ task: string; taps: number; ok: boolean }> = [];
	const v = (proto: string) => page.locator(sel(variant, proto));
	const panel = (id: string) => page.locator(`[data-proto-panel="${id}"]`);
	const label = async (proto: string) => (await v(proto).first().getAttribute("aria-label")) ?? "";
	// plan on
	if (variant === "c") {
		await page.locator(`[data-variant="c"] [data-proto="plus"] button`).click();
		await page.getByRole("menuitemcheckbox", { name: /Plan mode/ }).click();
		results.push({ task: "Plan mode on", taps: 2, ok: (await label("mode")).includes("Plan") });
	} else {
		const chip = variant === "b" ? "run" : "mode";
		await v(chip).click();
		await panel(chip).locator('[data-mode-switch="plan"]').click();
		await page.keyboard.press("Escape");
		results.push({ task: "Plan mode on", taps: 2, ok: (await label(chip)).includes("Plan") });
	}
	// thinking → High
	if (variant === "a" || variant === "base") {
		await v("run").click();
		await panel("run").locator("select[data-thinking-level]").selectOption("low");
		await page.keyboard.press("Escape");
		results.push({ task: "Thinking → Low", taps: 3, ok: (await label("run")).includes("Low") });
	} else {
		await v("model").click();
		await panel("model").getByRole("tab", { name: "Low" }).click();
		await page.keyboard.press("Escape");
		results.push({ task: "Thinking → Low", taps: 2, ok: (await label("model")).includes("Low") });
	}
	// model → Opus 5
	await v("model").click();
	await panel("model").getByRole("radio", { name: /Opus 5/ }).click();
	await page.waitForTimeout(150);
	results.push({ task: "Model → Opus 5", taps: 2, ok: (await label("model")).includes("Opus 5") });
	// approval → full access
	const runId = "run";
	await v(runId).click();
	await panel(runId).locator("select[data-approval-mode]").selectOption("yolo");
	await page.keyboard.press("Escape");
	results.push({ task: "Approval → Full access", taps: 3, ok: (await label("run")).includes("Full access") });
	// delegation → swarm
	if (variant === "a" || variant === "base") {
		await v("delegation").click();
		await panel("delegation").getByRole("radio", { name: /Swarm/ }).click();
		await page.keyboard.press("Escape");
		results.push({ task: "Delegation → Swarm", taps: 2, ok: (await label("delegation")).includes("Swarm") });
	} else {
		await v("run").click();
		await panel("run").locator("select[data-delegation-select]").selectOption("swarm");
		await page.keyboard.press("Escape");
		results.push({ task: "Delegation → Swarm", taps: 3, ok: (await label("run")).includes("Swarm") });
	}
	// attach / expand present in +
	await page.locator(`[data-variant="${variant}"] [data-proto="plus"] button`).click();
	const attach = await page.getByRole("menuitem", { name: /Attach files/ }).count();
	const expand = await page.getByRole("menuitem", { name: /Expand composer/ }).count();
	await page.keyboard.press("Escape");
	results.push({ task: "Attach files", taps: 2, ok: attach === 1 });
	results.push({ task: "Expand composer", taps: 2, ok: expand === 1 });
	return results;
}

export async function run(): Promise<void> {
	await fs.mkdir(OUT, { recursive: true });
	const harness = await startVite();
	const browser = await chromium.launch();
	const result: Record<string, unknown> = {};
	try {
		const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
		const page = await context.newPage();

		// 1. Static grid.
		const grid: Array<Record<string, unknown>> = [];
		const jobs: Array<{ state: string; width: number; lang: string; model?: "long" }> = [];
		for (const lang of LANGS) {
			for (const state of STATES) for (const width of WIDTHS) jobs.push({ state, width, lang });
			for (const state of ["plan-goal", "running-draft"]) for (const width of WIDTHS) jobs.push({ state, width, lang, model: "long" });
		}
		for (const job of jobs) {
			await page.setViewportSize({ width: Math.max(job.width + 60, 400), height: 760 });
			await open(page, harness.origin, { variant: "all", theme: "light", ...job });
			for (const variant of VARIANTS) grid.push({ variant, ...job, snap: await snap(page, variant) });
		}
		result.grid = grid;

		// 2. Live transitions at two widths, en and ko.
		const trans: Array<Record<string, unknown>> = [];
		for (const lang of LANGS) {
			for (const width of [1000, 560, 340]) {
				await page.setViewportSize({ width: Math.max(width + 60, 400), height: 760 });
				await open(page, harness.origin, { variant: "all", state: "idle", theme: "light", lang, width });
				for (const variant of VARIANTS) {
					try {
						trans.push({ variant, lang, width, rows: await transitions(page, variant) });
					} catch (error) {
						console.log(`transition failed: ${variant} ${lang} ${width}: ${String(error).slice(0, 160)}`);
					}
				}
			}
		}
		result.transitions = trans;

		// 3. Popovers: open/close deltas and panel boxes (single-variant pages, bottom aligned), shots in every theme/lang.
		const pops: Array<Record<string, unknown>> = [];
		const ids: Record<string, string[]> = {
			base: ["plus", "mode", "run", "delegation", "model", "context"],
			a: ["plus", "mode", "run", "delegation", "model", "context"],
			b: ["plus", "run", "model", "context"],
			c: ["plus", "mode", "run", "model", "context"],
		};
		await fs.mkdir(path.join(OUT, "popovers"), { recursive: true });
		for (const theme of ["light", "dark"]) {
			for (const lang of LANGS) {
				for (const variant of VARIANTS) {
					for (const id of ids[variant]) {
						await page.setViewportSize({ width: 900, height: 760 });
						await open(page, harness.origin, { variant, state: "plan-goal", theme, lang, width: 760 });
						const measured = await popoverPass(page, variant, id);
						if (theme === "light") pops.push({ variant, lang, ...measured });
						const trigger = id === "plus" ? page.locator(`[data-variant="${variant}"] [data-proto="plus"] button`) : page.locator(sel(variant, id));
						await trigger.click();
						await page.waitForTimeout(350);
						await page.screenshot({ path: path.join(OUT, "popovers", `popover-${variant}-${id}-plan-goal-${theme}-${lang}.png`) });
					}
				}
			}
		}
		result.popovers = pops;

		// 4. Hit areas: desktop boxes (mouse) and the tablet touch shell's real hit reach.
		const hits: Array<Record<string, unknown>> = [];
		for (const shell of [false, true]) {
			for (const width of [760, 340]) {
				await page.setViewportSize({ width: Math.max(width + 60, 400), height: 760 });
				await open(page, harness.origin, { variant: "all", state: "running-draft", theme: "light", lang: "en", width, shell });
				for (const variant of VARIANTS) hits.push({ variant, shell, width, controls: await page.evaluate(hitInPage, variant), snap: await snap(page, variant) });
				if (shell) {
					await page.evaluate(() => {
						document.documentElement.dataset.hitfix = "1";
					});
					for (const variant of VARIANTS) hits.push({ variant, shell, hitfix: true, width, controls: await page.evaluate(hitInPage, variant), snap: await snap(page, variant) });
				}
			}
		}
		result.hits = hits;
		await fs.writeFile(path.join(OUT, "measure.json"), JSON.stringify(result, null, 1));

		// 5. Task paths (real clicks) at 1000 px.
		const tasks: Array<Record<string, unknown>> = [];
		for (const variant of VARIANTS) {
			await page.setViewportSize({ width: 1100, height: 760 });
			await open(page, harness.origin, { variant, state: "running-draft", theme: "light", lang: "en", width: 1000 });
			const t = await taps(page, variant);
			// Single-tap actions, measured by one click each.
			const steerBefore = await page.locator(sel(variant, "steer")).first().getAttribute("data-send-mode");
			await page.locator(sel(variant, "steer")).first().click();
			const steerAfter = await page.locator(sel(variant, "steer")).first().getAttribute("data-send-mode");
			t.push({ task: "Steer ⇄ follow-up", taps: 1, ok: steerBefore !== steerAfter });
			await page.locator(sel(variant, "send")).click();
			t.push({ task: "Send / Steer", taps: 1, ok: (await page.locator(`[data-variant="${variant}"] textarea`).inputValue()) === "" });
			await page.locator(sel(variant, "stop")).click();
			t.push({ task: "Stop", taps: 1, ok: (await page.locator(sel(variant, "stop")).count()) === 0 || (await page.locator(sel(variant, "stop")).first().evaluate(el => getComputedStyle(el).visibility)) === "hidden" });
			tasks.push({ variant, tasks: t });
		}
		result.tasks = tasks;
		await fs.writeFile(path.join(OUT, "measure.json"), JSON.stringify(result, null, 1));
		console.log("measure.json written");
	} finally {
		await browser.close();
		await harness.close();
	}
}
