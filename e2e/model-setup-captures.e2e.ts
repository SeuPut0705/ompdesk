import * as fs from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { type Browser, chromium, expect, type Page, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

// Model setup ("자동으로 구성") on the dev harness: full auto opens onto its proposal, picked mode, the evidence
// confirm line, the entry's applied + Undo line and its "set up again?" offer. Behaviour is pinned by the
// component tests in src/renderer/components/settings/model-setup/; this only writes captures:
// OMP_GUI_MODEL_SETUP_SHOTS=<dir> (ko/en × light/dark × desktop 1280×800 / phone 390×844).

const captures = process.env.OMP_GUI_MODEL_SETUP_SHOTS;

let server: ViteDevServer | undefined;
let origin = "";
let browser: Browser;

async function freePort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const probe = createNetServer();
	probe.once("error", reject);
	probe.listen(0, "127.0.0.1", () => {
		const address = probe.address();
		const port = typeof address === "object" && address ? address.port : 0;
		probe.close(() => resolve(port));
	});
	return promise;
}

test.beforeAll(async () => {
	if (!captures) return;
	const port = await freePort();
	server = await createServer({
		configFile: path.resolve("vite.harness.config.ts"),
		server: { host: "127.0.0.1", port, strictPort: true },
		logLevel: "error",
	});
	await server.listen();
	origin = `http://127.0.0.1:${port}`;
	browser = await chromium.launch();
});

test.afterAll(async () => {
	await browser?.close();
	await server?.close();
});

const SIZES = {
	desktop: { width: 1280, height: 800, isMobile: false, hasTouch: false },
	phone: { width: 390, height: 844, isMobile: true, hasTouch: true },
} as const;

async function shoot(page: Page, name: string): Promise<void> {
	if (!captures) return;
	await fs.mkdir(captures, { recursive: true });
	await page.screenshot({ path: path.join(captures, `${name}.png`), animations: "disabled" });
}

async function openPage(lang: "en" | "ko", theme: "light" | "dark", size: keyof typeof SIZES): Promise<Page> {
	const { width, height, isMobile, hasTouch } = SIZES[size];
	const context = await browser.newContext({ viewport: { width, height }, isMobile, hasTouch, deviceScaleFactor: 2 });
	const page = await context.newPage();
	page.on("pageerror", error => {
		throw error;
	});
	await page.goto(`${origin}/harness.html?theme=${theme}&lang=${lang}`);
	await page.waitForFunction(() => window.__stores?.ui !== undefined, undefined, { timeout: 45_000 });
	await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
	await page.evaluate(() => {
		// Through the store's own action: it also loads the Settings page.
		const ui = window.__stores?.ui?.getState();
		if (ui && typeof ui === "object" && "openSettings" in ui && typeof ui.openSettings === "function") {
			ui.openSettings("models");
		}
	});
	await expect(page.locator("#settings-models-setup")).toBeVisible({ timeout: 30_000 });
	return page;
}

for (const lang of ["ko", "en"] as const) {
	for (const theme of ["light", "dark"] as const) {
		for (const size of ["desktop", "phone"] as const) {
			test(`model setup captures ${lang} ${theme} ${size}`, async () => {
				test.skip(!captures, "OMP_GUI_MODEL_SETUP_SHOTS unset");
				const tag = `${lang}-${theme}-${size}`;
				const page = await openPage(lang, theme, size);
				const dialog = page.getByRole("dialog");

				// Full auto: one click opens straight onto the proposal.
				const opened = Date.now();
				await page
					.locator("#settings-models-setup")
					.getByRole("button", { name: lang === "ko" ? "자동으로 구성" : "Set up automatically" })
					.click();
				await expect(
					dialog.locator('[data-model-setup-mode="full"] [data-model-setup-role]').first(),
				).toBeVisible();
				const openMs = Date.now() - opened;
				await expect(dialog.locator('[data-model-setup-role="smol"]')).toHaveAttribute(
					"data-model-setup-state",
					"manual",
				);
				await shoot(page, `${tag}-1-full-auto`);

				// The evidence action shows its cost before it runs.
				await dialog
					.page()
					.getByRole("button", { name: lang === "ko" ? "근거 더 찾기" : "Find more evidence" })
					.click();
				await expect(page.locator("[data-model-setup-confirm]")).toBeVisible();
				await shoot(page, `${tag}-2-evidence-confirm`);
				await dialog
					.page()
					.getByRole("button", { name: lang === "ko" ? "근거 더 찾기" : "Find more evidence" })
					.click();

				// Pick models + auto.
				await dialog.getByRole("tab").nth(1).click();
				await expect(dialog.locator('[data-model-setup-mode="picked"]')).toBeVisible();
				await shoot(page, `${tag}-3-picked`);
				await dialog.getByRole("tab").nth(0).click();

				// Apply, then the entry's Undo line.
				await page.getByRole("button", { name: lang === "ko" ? "적용" : "Apply" }).click();
				await expect(dialog).toBeHidden();
				await expect(page.locator("[data-model-setup-last]")).toBeVisible();
				await page.locator("#settings-models-setup").scrollIntoViewIfNeeded();
				await shoot(page, `${tag}-4-applied-undo`);

				// Something new since the last apply: the quiet offer.
				await page.evaluate(async () => {
					const stored: unknown = await window.omp.prefs.get("modelSetup");
					const records = stored && typeof stored === "object" ? stored : {};
					const local =
						"local" in records && records.local && typeof records.local === "object" ? records.local : {};
					await window.omp.prefs.set("modelSetup", { ...records, local: { ...local, signature: "before" } });
					window.__stores?.ui?.setState({ modelSetupOpen: true });
				});
				await expect(dialog).toBeVisible();
				await page.keyboard.press("Escape");
				await expect(page.locator("[data-model-setup-offer]")).toBeVisible();
				await shoot(page, `${tag}-5-offer`);

				if (captures) {
					await fs.appendFile(path.join(captures, "timings.jsonl"), `${JSON.stringify({ tag, openMs })}\n`);
				}
				await page.context().close();
			});
		}
	}
}
