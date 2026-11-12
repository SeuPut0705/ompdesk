/**
 * Settings › Models & accounts › Fallback models on the built app and the fake omp holding the owner's setup of
 * 12 Nov 2026 (`OMP_GUI_TEST_FALLBACK`: Default on Fable 5.2, Task on Opus 5.5, `retry.fallbackOn: usage-limit`, one
 * wildcard row per provider). Picks Fable → Opus 5.5 → GPT-6.1 SOL through the block's pickers, reloads the window,
 * and finds the three-model chain again beside the untouched wildcard rows, read back from omp's settings.
 * Captures the block in a 1280 px window in the test's output directory. en light runs by default;
 * `OMP_GUI_VARIANTS=1` adds ko. The phone case pairs the paired phone page (Pixel 8, 390 × 844, touch, Korean) through
 * the fake `tailscale serve` (`e2e/fixture/phone-serve.ts`, as `phone-day.e2e.ts` does), enters the same chain with
 * taps, and pins the phone layout: the "when" cards stacked, nothing wider than the page, every button and picker of
 * the block on screen, and each ↑ ↓ ✕ reaching 44 px. What a row says and writes is pinned by
 * `FallbackModelsSection.test.tsx`; the precedence copy by `fallback-chains.test.ts`.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, devices, type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { fixtureTailscale } from "./fixture/fake-tailscale-install";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { exitApp, hitSizes, launchApp, pressShortcutUntilVisible, variants } from "./harness";

const FABLE = "anthropic/claude-fable-5-2";
const OPUS = "anthropic/claude-opus-5-5";
const SOL = "openai-codex/gpt-6.1-sol";
const SIZES = [["desktop", 1280, 1000]] as const;

let app: ElectronApplication | null = null;
let profile: string | null = null;

let proxy: ServeProxy | null = null;

test.afterEach(async () => {
	await proxy?.close().catch(() => undefined);
	proxy = null;
	if (app) await exitApp(app);
	app = null;
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	profile = null;
});

async function openBlock(page: Page) {
	const settings = page.locator("[data-settings-page]");
	await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
	await settings.locator('[data-settings-section="models"]').click();
	const block = page.locator("#settings-models-fallback");
	await expect(block.locator("[data-fallback-row]").first()).toBeVisible({ timeout: 30_000 });
	await block.scrollIntoViewIfNeeded();
	return block;
}

async function pick(page: Page, trigger: Locator, selector: string): Promise<void> {
	await trigger.click();
	await page.locator(`[role="option"][title$=" · ${selector}"]`).first().click();
}

async function rowKeys(page: Page): Promise<string[]> {
	return page
		.locator("#settings-models-fallback [data-fallback-row]")
		.evaluateAll(rows => rows.map(row => row.getAttribute("data-fallback-row") ?? ""));
}

async function entries(page: Page, key: string): Promise<string[]> {
	return page
		.locator(`[data-fallback-row="${key}"] [data-fallback-entry]`)
		.evaluateAll(items => items.map(item => item.getAttribute("data-fallback-entry") ?? ""));
}

for (const language of variants(["en", "ko"] as const)) {
	test(`fallback models: Fable → Opus 5.5 → GPT-6.1 SOL is saved and shown after a reload (${language})`, async () => {
		test.setTimeout(180_000);
		profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fallback-"));
		const [desktop, project, agent] = ["desktop", "project", "agent"].map(name => path.join(profile ?? "", name));
		await Promise.all([fs.mkdir(desktop), fs.mkdir(project), fs.mkdir(agent)]);
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language, themeName: "light", firstRunComplete: true }),
		);
		app = await launchApp({
			project,
			desktop,
			agent,
			profile,
			env: { OMP_GUI_TEST_LOGIN: "1", OMP_GUI_TEST_MODELS: "1", OMP_GUI_TEST_FALLBACK: "1" },
		});
		const page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 1000));
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");

		const block = await openBlock(page);
		expect(await rowKeys(page)).toEqual(["anthropic/*", "openai-codex/*"]);
		await page.mouse.move(1, 1);
		await block.screenshot({
			path: test.info().outputPath(`before-${language}-desktop.png`),
			animations: "disabled",
		});

		await pick(page, block.locator("#fallback-add-row button").first(), FABLE);
		const fable = block.locator(`[data-fallback-row="${FABLE}"]`);
		await pick(page, fable.locator("[data-fallback-add-entry] button").first(), OPUS);
		await expect.poll(() => entries(page, FABLE)).toEqual([OPUS]);
		await pick(page, fable.locator("[data-fallback-add-entry] button").first(), SOL);
		await expect.poll(() => entries(page, FABLE)).toEqual([OPUS, SOL]);

		await page.reload();
		await page.waitForFunction(() => window.omp?.rpc != null);
		const again = await openBlock(page);
		await expect.poll(() => rowKeys(page)).toEqual(["anthropic/*", "openai-codex/*", FABLE]);
		expect(await entries(page, FABLE)).toEqual([OPUS, SOL]);
		expect(await entries(page, "anthropic/*")).toEqual([SOL]);
		expect(await entries(page, "openai-codex/*")).toEqual([FABLE]);
		// omp's own setting, key order included: the new row is last and the wildcard rows are as they were.
		const stored = await page.evaluate(() => window.omp.rpc.getSettings(["retry.fallbackChains"]));
		expect(JSON.stringify(stored)).toContain(
			`"retry.fallbackChains":${JSON.stringify({ "anthropic/*": [SOL], "openai-codex/*": [FABLE], [FABLE]: [OPUS, SOL] })}`,
		);

		for (const [size, width, height] of SIZES) {
			await app.evaluate(
				({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]?.setContentSize(w, h),
				[width, height],
			);
			await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
			await again.scrollIntoViewIfNeeded();
			await page.mouse.move(1, 1);
			await page.waitForTimeout(300);
			await again.screenshot({
				path: test.info().outputPath(`after-${language}-${size}.png`),
				animations: "disabled",
			});
		}
	});
}

test("fallback models on the paired phone page: stacked, inside the screen, 44 px to tap (ko)", async () => {
	test.setTimeout(240_000);
	profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-fallback-phone-")));
	const [desktop, project, agent] = ["desktop", "project", "agent"].map(name => path.join(profile ?? "", name));
	await Promise.all([fs.mkdir(desktop), fs.mkdir(project), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "ko", themeName: "light", firstRunComplete: true, lastProject: project }),
	);
	const tailscale = await fixtureTailscale(profile, { backendState: "Running" });
	app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: { OMP_GUI_TEST_LOGIN: "1", OMP_GUI_TEST_MODELS: "1", OMP_GUI_TEST_FALLBACK: "1", ...tailscale.env },
	});
	const desk = await app.firstWindow();
	await desk.waitForFunction(() => window.omp?.rpc != null);
	await desk.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
	await expect
		.poll(() => desk.evaluate(async () => (await window.omp.mobileWeb.getState()).phase), { timeout: 60_000 })
		.toBe("ready");
	await expect.poll(() => serveSites(tailscale).length, { timeout: 30_000 }).toBeGreaterThan(0);
	const site = serveSites(tailscale).at(-1);
	if (!site) throw new Error("serve publishes no handler");
	proxy = await ServeProxy.start(site, "seuput@example.com", undefined, { plainCookie: true });

	const browser = await chromium.launch();
	try {
		const context = await browser.newContext({
			...devices["Pixel 8"],
			viewport: { width: 390, height: 844 },
			screen: { width: 390, height: 844 },
			colorScheme: "light",
		});
		const phone = await context.newPage();
		await phone.goto(`${proxy.url}/`);
		await phonePaired(phone);
		await expect(phone.locator("html")).toHaveAttribute("data-shell", "phone", { timeout: 60_000 });

		await phone.locator("button:visible:has(svg.lucide-menu)").first().tap();
		await phone.locator('[data-destination="settings"]').first().tap();
		await phone.locator('[data-settings-section="models"]').tap();
		const block = phone.locator("#settings-models-fallback");
		await expect(block.locator("[data-fallback-row]").first()).toBeVisible({ timeout: 30_000 });
		await expect(phone.locator("html")).toHaveAttribute("data-input", "touch");

		const pickOnPhone = async (trigger: Locator, selector: string) => {
			await trigger.scrollIntoViewIfNeeded();
			await trigger.tap();
			const option = phone.locator(`[role="option"][title$=" · ${selector}"]`).first();
			await option.scrollIntoViewIfNeeded();
			await option.tap();
		};
		await pickOnPhone(block.locator("#fallback-add-row button").first(), FABLE);
		const fable = block.locator(`[data-fallback-row="${FABLE}"]`);
		await pickOnPhone(fable.locator("[data-fallback-add-entry] button").first(), OPUS);
		await expect.poll(() => entries(phone, FABLE)).toEqual([OPUS]);
		await pickOnPhone(fable.locator("[data-fallback-add-entry] button").first(), SOL);
		await expect.poll(() => entries(phone, FABLE)).toEqual([OPUS, SOL]);

		// The three "when" cards stack: each as wide as the first, one under the other.
		const cards = await block.locator("[data-fallback-trigger]").evaluateAll(nodes =>
			nodes.map(node => {
				const { left, top, bottom } = node.getBoundingClientRect();
				return { left, top, bottom };
			}),
		);
		expect(cards).toHaveLength(3);
		for (const [index, card] of cards.entries()) {
			expect(card.left, `card ${index}`).toBe(cards[0]?.left);
			if (index > 0) expect(card.top, `card ${index}`).toBeGreaterThanOrEqual(cards[index - 1]?.bottom ?? 0);
		}

		// Nothing wider than the page, and every control of the block inside the screen's width.
		const widths = await phone.evaluate(() => {
			const root = document.documentElement;
			const content = document.querySelector(".settings-content");
			return {
				page: root.scrollWidth - root.clientWidth,
				content: content ? content.scrollWidth - content.clientWidth : 0,
			};
		});
		expect(widths).toEqual({ page: 0, content: 0 });
		const outside = await block.locator("button").evaluateAll(nodes =>
			nodes.flatMap(node => {
				const box = node.getBoundingClientRect();
				return box.width > 0 && (box.left < 0 || box.right > window.innerWidth)
					? [node.getAttribute("aria-label") ?? node.textContent?.trim() ?? node.tagName]
					: [];
			}),
		);
		expect(outside).toEqual([]);

		// Each ↑ ↓ ✕ names its model, sits on that model's line, and reaches 44 px.
		const actions = fable.locator("[data-fallback-actions] button");
		await expect(actions).toHaveCount(6);
		for (const hit of await hitSizes(actions)) {
			expect(hit.hit.width, hit.label).toBeGreaterThanOrEqual(44);
			expect(hit.hit.height, hit.label).toBeGreaterThanOrEqual(44);
		}
		for (const entry of [OPUS, SOL]) {
			const line = fable.locator(`[data-fallback-entry="${entry}"]`);
			const lineBox = await line.boundingBox();
			for (const button of await line.locator("[data-fallback-actions] button").all()) {
				const box = await button.boundingBox();
				expect(box && lineBox && box.y >= lineBox.y && box.y + box.height <= lineBox.y + lineBox.height + 0.5).toBe(
					true,
				);
			}
		}
		// The pickers are the role rows' own `ModelValueSelect`: on the phone they reach what a role row's picker does.
		const [rolePicker] = await hitSizes(phone.locator("#model-role-default [aria-haspopup='listbox']"));
		if (!rolePicker) throw new Error("the Default role's picker is not on the page");
		for (const hit of await hitSizes(block.locator("[data-fallback-add-entry] button, #fallback-add-row button"))) {
			expect(hit.hit.height, hit.label).toBeGreaterThanOrEqual(rolePicker.hit.height);
		}

		await fable.scrollIntoViewIfNeeded();
		await phone.waitForTimeout(400);
		await phone.screenshot({ path: test.info().outputPath("phone-ko-390.png"), animations: "disabled" });
		await block.screenshot({ path: test.info().outputPath("phone-ko-390-block.png"), animations: "disabled" });
	} finally {
		await browser.close();
	}
});
