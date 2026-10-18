import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import { exitApp, launchApp } from "./harness";

let app: ElectronApplication;
let page: Page;
let profile: string;
let record: string;
let errors: string[];

test.beforeEach(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-lazy-transcript-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", firstRunComplete: true, transcriptDetail: "full" }),
	);
	record = path.join(profile, "rpc.jsonl");
	app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: {
			OMP_GUI_TEST_RECORD: record,
			OMP_GUI_TEST_LONG_SESSION: "1",
		},
	});
	page = await app.firstWindow();
	errors = [];
	page.on("pageerror", error => errors.push(error.message));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
	await expect(page.getByText("Long session answer 249", { exact: true })).toBeVisible();
});

test.afterEach(async () => {
	if (app) await exitApp(app);
	if (record) await fs.copyFile(record, test.info().outputPath("rpc.jsonl")).catch(() => {});
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function fixture(command: string): Promise<void> {
	const response = await page.evaluate(command => window.omp.rpc.bash(command), command);
	expect(response.success).toBe(true);
}

async function anchor(): Promise<{ key: string; offset: number }> {
	return page.locator(".omp-transcript-scroll").evaluate(element => {
		const top = element.getBoundingClientRect().top;
		for (const row of element.querySelectorAll<HTMLElement>("[data-row-key]")) {
			const box = row.getBoundingClientRect();
			if (box.bottom > top + 4) return { key: row.dataset.rowKey ?? "", offset: box.top - top };
		}
		throw new Error("No visible transcript anchor");
	});
}

async function capture(name: string): Promise<void> {
	const directory = process.env.OMP_GUI_TRANSCRIPT_SCREENSHOTS;
	if (!directory) return;
	await fs.mkdir(directory, { recursive: true });
	for (const [theme, label] of [
		["light", "OMPdesk Light"],
		["dark", "OMPdesk Dark"],
	]) {
		const input = page.locator("textarea").first();
		await input.fill("/theme");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		const picker = page.getByRole("dialog");
		await picker.getByPlaceholder("Search themes…").fill(label ?? "");
		await picker
			.locator("button[aria-pressed]")
			.filter({ hasText: label ?? "" })
			.click();
		await expect(picker).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
		await page.screenshot({
			path: path.join(directory, `${name}-${theme}.png`),
			scale: "css",
			animations: "disabled",
		});
	}
}

test("renders only the tail, anchors older pages, reaches the first turn and appends live messages", async () => {
	const calls = (await fs.readFile(record, "utf8"))
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as { type: string; offset?: number; limit?: number; snapToTurn?: boolean });
	const pages = calls.filter(call => call.type === "sessions.transcript");
	expect(pages).toEqual(
		expect.arrayContaining([
			{ type: "sessions.transcript", offset: 0, limit: 0, recordedBy: expect.any(String) },
			expect.objectContaining({ offset: 1300, limit: 200, snapToTurn: true }),
		]),
	);
	// Startup identity and ready notifications can each rehydrate; neither may
	// walk forward through the older history.
	const bodies = pages.filter(call => (call.limit ?? 0) > 0);
	expect(bodies.length).toBeGreaterThan(0);
	expect(bodies.every(call => call.offset === 1300 && call.limit === 200 && call.snapToTurn === true)).toBe(true);
	await expect(page.getByText("Long session turn 000", { exact: true })).toHaveCount(0);
	expect(await page.locator("[data-transcript-kind]").count()).toBeLessThan(150);
	// The rail carries only turns: older ones load when the reader scrolls to the top.
	const nav = page.getByRole("navigation", { name: "Turn navigation" });
	await expect(nav).toBeVisible();
	await fixture("fixture:hold-history");
	const scroll = page.locator(".omp-transcript-scroll");
	// Home, repeated until the page starts loading: a key sent while the renderer still settles is lost.
	await expect(async () => {
		await scroll.focus();
		await page.keyboard.press("Home");
		await expect(page.getByRole("status").filter({ hasText: "Loading earlier messages" })).toBeVisible({
			timeout: 2_000,
		});
	}).toPass({ timeout: 20_000 });
	await page.evaluate(
		() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
	);
	const before = await anchor();
	await capture("loading");
	await fixture("fixture:release-history");
	await expect(page.getByTestId("transcript-history-status")).toHaveCount(0);
	await expect
		.poll(async () =>
			page
				.locator("[data-row-key]")
				.evaluateAll((rows, key) => rows.some(row => (row as HTMLElement).dataset.rowKey === key), before.key),
		)
		.toBe(true);
	await expect
		.poll(async () => {
			const after = await page.locator(".omp-transcript-scroll").evaluate((element, key) => {
				const row = Array.from(element.querySelectorAll<HTMLElement>("[data-row-key]")).find(
					row => row.dataset.rowKey === key,
				);
				if (!row) throw new Error("Anchor disappeared after prepend");
				return row.getBoundingClientRect().top - element.getBoundingClientRect().top;
			}, before.key);
			return Math.abs(after - before.offset);
		})
		.toBeLessThan(5);
	await capture("anchored-prepend");
	const firstTurn = nav.getByRole("button", { name: /Jump to turn .*Long session turn 000/ });
	for (let index = 0; index < 12 && (await firstTurn.count()) === 0; index++) {
		const count = await nav.locator("button").count();
		await scroll.focus();
		await page.keyboard.press("Home");
		await expect.poll(async () => await nav.locator("button").count()).toBeGreaterThan(count);
	}
	await firstTurn.click();
	await expect(scroll.getByText("Long session turn 000", { exact: true })).toBeVisible();
	const input = page.locator("textarea").first();
	await input.fill("Live after older history");
	await input.press("Enter");
	await expect(page.getByText("Live after older history", { exact: true })).toBeVisible();
	await expect(page.getByText("Local fixture reply", { exact: true })).toBeVisible();
	expect(errors).toEqual([]);
});
