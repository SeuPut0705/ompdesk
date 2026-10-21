/**
 * Opt-in audit of a stranger's first run (`OMP_GUI_FIRST_RUN_WALK=<dir>`): a fresh profile, no omp, no
 * credential. The fake installer puts omp in place (held once so the install screen is captured), the
 * fake omp is signed out, the person signs in to Claude through the featured card (the browser half is
 * the launch page followed back to the fake's callback), takes the steps the app asks for and sends a
 * first message. Every screen is captured in en and ko (light) at the desktop size, and the phone page's
 * provider step at 390 px on the dev harness. `<dir>/walk-<lang>.json` holds, per screen, the seconds
 * since launch, the clicks so far, the visible words and the buttons on it.
 */
import * as fs from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, devices, expect, type Locator, type Page, test } from "@playwright/test";
import { createServer } from "vite";
import { writeFakeOmp } from "../src/main/test-fake-omp";
import { exitApp, fixtureOmp, launchApp } from "./harness";
import { baseTemp } from "./run-temp";

const directory = process.env.OMP_GUI_FIRST_RUN_WALK;
test.skip(!directory, "set OMP_GUI_FIRST_RUN_WALK=<dir> to walk the first run");
test.describe.configure({ mode: "parallel" });

const INSTALLER = `
import { appendFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
const [item, method] = process.argv.slice(2);
const dir = process.env.OMPDESK_FAKE_INSTALLER_DIR;
appendFileSync(join(dir, "installs.log"), item + " " + method + "\\n");
if (item !== "omp") process.exit(0);
console.log("Resolving @oh-my-pi/pi-coding-agent");
while (!existsSync(join(dir, "go"))) await Bun.sleep(25);
renameSync(process.env.OMPDESK_FAKE_OMP + ".staged", process.env.OMPDESK_FAKE_OMP);
console.log("installed @oh-my-pi/pi-coding-agent with binaries:\\n - omp");
`;

interface Screen {
	name: string;
	seconds: number;
	clicks: number;
	words: number;
	buttons: string[];
}

/** What the person sees: the visible words (not the hidden ⓘ texts) and the enabled buttons. */
async function inventory(page: Page): Promise<{ words: number; buttons: string[] }> {
	return page.evaluate(() => {
		const visible = (element: Element) => {
			const box = element.getBoundingClientRect();
			return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden";
		};
		const root =
			document.querySelector('[data-testid="setup-takeover"]') ??
			document.querySelector("[data-first-run-step]") ??
			document.querySelector("main") ??
			document.body;
		const words = (root as HTMLElement).innerText.split(/\s+/).filter(Boolean).length;
		const buttons = [...root.querySelectorAll("button")]
			.filter(button => visible(button) && !button.disabled && !button.closest("[inert]"))
			.map(button => (button.getAttribute("aria-label") ?? button.textContent ?? "").trim())
			.filter(Boolean);
		return { words, buttons };
	});
}

for (const language of ["en", "ko"] as const) {
	test(`first-run walk (${language})`, async () => {
		test.setTimeout(180_000);
		const out = directory ?? baseTemp();
		await fs.mkdir(out, { recursive: true });
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `omp-first-run-walk-${language}-`)));
		const [project, desktop, agent, installer] = ["project", "desktop", "agent", "installer"].map(name =>
			path.join(root, name),
		);
		await Promise.all([project, desktop, agent, installer].map(dir => fs.mkdir(dir)));
		// A stranger's profile: nothing but the language and theme the capture asks for.
		await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language, themeName: "light" }));
		const omp = await fixtureOmp(root);
		await fs.rename(omp, `${omp}.staged`);
		const started = Date.now();
		const app = await launchApp({
			project,
			desktop,
			agent,
			profile: root,
			env: {
				OMP_GUI_OMP: omp,
				OMP_GUI_TEST_LOGIN: "1",
				OMP_GUI_TEST_FEATURED: "1",
				OMP_GUI_TEST_SIGNED_OUT: "1",
				OMP_GUI_TEST_INSTALLER: await writeFakeOmp(installer, INSTALLER),
				OMPDESK_FAKE_INSTALLER_DIR: installer,
				OMPDESK_FAKE_OMP: omp,
				// A stranger's gh holds no account.
				GH_CONFIG_DIR: path.join(root, "gh"),
				GH_TOKEN: undefined,
				GITHUB_TOKEN: undefined,
			},
		});
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on("pageerror", error => errors.push(error.message));
		await app.evaluate(({ BrowserWindow, shell }) => {
			BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860);
			const opened: string[] = [];
			Object.assign(globalThis, { openedUrls: opened });
			shell.openExternal = async (url: string) => {
				opened.push(url);
			};
		});
		const screens: Screen[] = [];
		let clicks = 0;
		const shot = async (name: string) => {
			await page.waitForTimeout(400);
			await page.screenshot({
				path: path.join(out, `${language}-desktop-${String(screens.length + 1).padStart(2, "0")}-${name}.png`),
				animations: "disabled",
			});
			screens.push({ name, seconds: (Date.now() - started) / 1000, clicks, ...(await inventory(page)) });
		};
		const click = async (target: Locator) => {
			await target.click();
			clicks += 1;
		};
		try {
			const takeover = page.getByTestId("setup-takeover");
			await expect(takeover).toBeVisible({ timeout: 30_000 });
			await expect(page.locator('[data-setup-item="omp"]')).toHaveAttribute("data-phase", "running", {
				timeout: 30_000,
			});
			await shot("installing");
			await fs.writeFile(path.join(installer, "go"), "");

			const connect = page.locator('[data-first-run-step="connect"]');
			await expect(connect).toBeVisible({ timeout: 60_000 });
			await expect(takeover).toHaveCount(0);
			await shot("connect");

			await click(connect.locator('button[data-provider-connect="anthropic"]'));
			const opened = async () =>
				((await app.evaluate(() => Reflect.get(globalThis, "openedUrls"))) as string[]).length;
			await expect(page.locator("[data-login-progress]")).toBeVisible();
			await page.waitForTimeout(1_000);
			await shot("signing-in");
			// The person's browser page opens by itself, with no second click.
			await expect.poll(opened).toBe(1);
			const [launchUrl] = (await app.evaluate(() => Reflect.get(globalThis, "openedUrls"))) as string[];
			const launch = await fetch(launchUrl ?? "", { redirect: "manual" });
			const authorize = new URL(launch.headers.get("location") ?? "");
			const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
			callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
			callback.searchParams.set("code", "abc");
			expect((await fetch(callback)).status).toBe(200);

			// No model or GitHub step: the default model is picked on its own and the composer is free.
			await expect(page.locator("[data-first-run-step]"))
				.toHaveCount(0, { timeout: 30_000 })
				.catch(async error => {
					await shot("setup-stuck");
					throw error;
				});
			await shot("ready");

			const composer = page.locator("textarea").first();
			await composer.fill(language === "ko" ? "안녕" : "Hello");
			await page.keyboard.press("Enter");
			await expect(page.locator(".omp-assistant-turn").first()).toBeVisible({
				timeout: 30_000,
			});
			await shot("first-answer");
		} finally {
			await fs.writeFile(
				path.join(out, `walk-${language}.json`),
				JSON.stringify({ screens, clicks, errors }, null, 2),
			);
			await exitApp(app);
			await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
		expect(errors).toEqual([]);
	});
}

/** The safe part of the real path: the installed omp on an empty agent dir, no credential, no sign-in. */
for (const language of ["en", "ko"] as const) {
	test(`first-run walk on the real omp (${language})`, async () => {
		test.setTimeout(120_000);
		const out = directory ?? baseTemp();
		await fs.mkdir(out, { recursive: true });
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `omp-first-run-real-${language}-`)));
		const [project, desktop, agent] = ["project", "desktop", "agent"].map(name => path.join(root, name));
		await Promise.all([project, desktop, agent].map(dir => fs.mkdir(dir)));
		await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language, themeName: "light" }));
		const started = Date.now();
		const app = await launchApp({
			project,
			desktop,
			agent,
			profile: root,
			env: Object.fromEntries([
				["OMP_GUI_OMP", undefined],
				["GH_CONFIG_DIR", path.join(root, "gh")],
				// A provider key in this shell would make a provider serve: a stranger has none.
				...Object.keys(process.env)
					.filter(key => /_API_KEY$|_TOKEN$/.test(key))
					.map(key => [key, undefined] as const),
			]),
		});
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on("pageerror", error => errors.push(error.message));
		const timings: Record<string, number> = {};
		try {
			await app.evaluate(({ BrowserWindow, shell }) => {
				BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860);
				shell.openExternal = async () => {};
			});
			const connect = page.locator('[data-first-run-step="connect"]');
			await expect(connect).toBeVisible({ timeout: 60_000 });
			timings.connectVisible = (Date.now() - started) / 1000;
			await expect(connect.locator('button[data-provider-connect="anthropic"]')).toBeEnabled({ timeout: 60_000 });
			timings.connectUsable = (Date.now() - started) / 1000;
			await page.waitForTimeout(400);
			await page.screenshot({ path: path.join(out, `${language}-real-01-connect.png`), animations: "disabled" });
			await connect.locator('button[data-provider-connect="anthropic"]').click();
			await expect(page.locator("[data-login-panel]")).toBeVisible({ timeout: 30_000 });
			await page.waitForTimeout(1_000);
			timings.signInShown = (Date.now() - started) / 1000;
			await page.screenshot({ path: path.join(out, `${language}-real-02-signing-in.png`), animations: "disabled" });
			await page
				.getByRole("button", { name: /^(Cancel|취소)$/ })
				.first()
				.click();
		} finally {
			await fs.writeFile(path.join(out, `real-${language}.json`), JSON.stringify({ timings, errors }, null, 2));
			await exitApp(app);
			await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
		expect(errors).toEqual([]);
	});
}

test("first-run walk: the phone page's provider step at 390 px", async () => {
	test.setTimeout(120_000);
	const out = directory ?? baseTemp();
	const port = await new Promise<number>((resolve, reject) => {
		const probe = createNetServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const free = typeof address === "object" && address ? address.port : 0;
			probe.close(() => resolve(free));
		});
	});
	const server = await createServer({
		configFile: path.resolve("vite.harness.config.ts"),
		server: { host: "127.0.0.1", port, strictPort: true },
		logLevel: "error",
	});
	await server.listen();
	const browser = await chromium.launch();
	try {
		for (const language of ["en", "ko"] as const) {
			const context = await browser.newContext({ ...devices["Pixel 7"], viewport: { width: 390, height: 844 } });
			const page = await context.newPage();
			await page.goto(`http://127.0.0.1:${port}/harness.html?theme=light&lang=${language}&firstrun=1`);
			const step = page.locator('[data-first-run-step="connect"]');
			await expect(step).toBeVisible({ timeout: 30_000 });
			await page.waitForTimeout(400);
			await page.screenshot({ path: path.join(out, `${language}-phone-connect.png`), fullPage: true });
			await context.close();
		}
	} finally {
		await browser.close();
		await server.close();
	}
});
