/**
 * Browser sign-in from Settings › Models on the fake omp, which replays stock's
 * `login` sequence (omp 18.10.3, rpc-mode over Anthropic's callback-server
 * flow): open_url with a loopback launch page, the "waiting" notice, then a
 * code-paste `input` that stock races against its callback and never closes.
 *
 * The panel waits for the browser first and keeps the paste as a collapsed,
 * localized fallback; the "browser" (this test) follows the launch page's
 * redirect back to the fake's callback, the login completes, and the leftover
 * paste request is answered for stock and never shows as a chat card. Cancel
 * ends the login through the callback's denial instead of answering the paste
 * (which would only re-ask). Captures in light/dark × en/ko.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { en } from "../src/renderer/locales/en";
import { ko } from "../src/renderer/locales/ko";
import { exitApp, fixtureOmp, pressShortcutUntilVisible, readRecords } from "./harness";

test.describe.configure({ mode: "parallel" });

type Language = "en" | "ko";

function tr(language: Language, key: string, params: Record<string, string> = {}): string {
	const template = (language === "ko" ? ko : en)[key];
	if (template === undefined) throw new Error(`missing locale key ${key}`);
	return template.replace(/\{(\w+)\}/g, (_match, name: string) => params[name] ?? `{${name}}`);
}

interface Launched {
	app: ElectronApplication;
	page: Page;
	record: string;
	errors: string[];
	root: string;
}

async function launch(language: Language, theme: "light" | "dark"): Promise<Launched> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `omp-oauth-${language}-${theme}-`)));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([project, desktop, agent].map(dir => fs.mkdir(dir)));
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language, themeName: theme, firstRunComplete: true }),
	);
	const record = path.join(root, "record.jsonl");
	const env: Record<string, string | undefined> = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(root),
		OMP_GUI_REMOTE_PORT: "0",
		OMP_GUI_TEST_LOGIN: "1",
		OMP_GUI_TEST_RECORD: record,
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await app.evaluate(({ BrowserWindow, shell }) => {
		BrowserWindow.getAllWindows()[0]?.setContentSize(1180, 860);
		const opened: string[] = [];
		Object.assign(globalThis, { openedUrls: opened });
		shell.openExternal = async (url: string) => {
			opened.push(url);
		};
	});
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 90_000 })
		.toBe("ready");
	return { app, page, record, errors, root };
}

/** Settings › Models with the Anthropic row in view; returns the row. */
async function openAnthropicRow(page: Page, language: Language) {
	const settings = page.locator("[data-settings-page]");
	await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
	await settings.locator('[data-settings-section="models"]').click();
	// Providers to connect sit behind "Add a provider" once one (the fixture) is connected.
	await settings.getByRole("button", { name: tr(language, "providers.add") }).click();
	// The sign-in panel is one block under the list, whichever provider started it.
	return settings.locator("[data-login-panel]");
}

/** Settings › Models with the Anthropic row's sign-in started; returns the row. */
async function startSignIn(page: Page, language: Language) {
	const anthropic = await openAnthropicRow(page, language);
	await page
		.locator("[data-settings-page]")
		.getByRole("button", { name: tr(language, "providers.picker.connect", { provider: "Anthropic" }), exact: true })
		.click();
	await expect(anthropic.locator("[data-login-progress]")).toHaveText(tr(language, "providerList.login.waiting"));
	return anthropic;
}

/** The browser half: open the launch page the panel opened and follow it back to omp's callback. */
async function finishInBrowser(launchUrl: string, query: Record<string, string>): Promise<number> {
	const launch = await fetch(launchUrl, { redirect: "manual" });
	expect(launch.status).toBe(302);
	const authorize = new URL(launch.headers.get("location") ?? "");
	expect(authorize.host).toBe("claude.ai");
	const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
	callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
	for (const [key, value] of Object.entries(query)) callback.searchParams.set(key, value);
	return (await fetch(callback)).status;
}

for (const [language, theme] of [
	["en", "light"],
	["en", "dark"],
	["ko", "light"],
	["ko", "dark"],
] as const) {
	test(`browser sign-in finishes through the callback; the code paste stays a fallback (${language} ${theme})`, async () => {
		test.setTimeout(120_000);
		const { app, page, record, errors, root } = await launch(language, theme);
		const shot = (name: string) =>
			page.screenshot({
				animations: "disabled",
				path: test.info().outputPath(`oauth-${language}-${theme}-${name}.png`),
			});
		try {
			const anthropic = await startSignIn(page, language);
			// Stock's paste request reached the app, yet neither the panel nor the chat asks for it.
			await expect.poll(async () => (await readRecords(record)).some(frame => frame.type === "login")).toBe(true);
			const toggle = anthropic.getByRole("button", { name: tr(language, "providerList.login.pasteToggle") });
			await expect(toggle).toHaveAttribute("aria-expanded", "false");
			await expect(anthropic.getByLabel(tr(language, "providerList.login.pasteLabel"))).toHaveCount(0);
			await expect(page.locator("[data-prompt-card]")).toHaveCount(0);
			await expect(page.getByText("Paste the authorization code")).toHaveCount(0);
			await shot("1-waiting");

			await toggle.click();
			await expect(anthropic.getByLabel(tr(language, "providerList.login.pasteLabel"))).toBeVisible();
			await expect(anthropic).toContainText(tr(language, "providerList.login.pasteHint"));
			await expect(anthropic.locator("[data-login-progress]")).toHaveText(
				tr(language, "providerList.login.waiting"),
			);
			await expect(page.locator("[data-prompt-countdown]")).toHaveCount(0);
			await shot("2-fallback-open");

			await anthropic.getByRole("button", { name: tr(language, "providerList.login.openBrowser") }).click();
			await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "openedUrls"))).toHaveLength(1);
			const [launchUrl] = (await app.evaluate(() => Reflect.get(globalThis, "openedUrls"))) as string[];
			expect(launchUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/launch$/);
			expect(await finishInBrowser(launchUrl ?? "", { code: "abc" })).toBe(200);

			await expect(page.getByText(tr(language, "providers.loginSuccess", { provider: "Anthropic" }))).toBeVisible();
			await expect(anthropic.locator("[data-login-progress]")).toHaveCount(0);
			// The paste request stock left open was answered for it, and never became a chat card.
			const frames = await readRecords(record);
			const pasteId = frames.findLast(
				frame => frame.type === "extension_ui_response" && frame.cancelled === true,
			)?.id;
			expect(pasteId).toMatch(/^fixture-login-input-/);
			expect(frames.filter(frame => frame.type === "extension_ui_response" && frame.id === pasteId)).toHaveLength(1);
			await page.keyboard.press("Escape");
			await expect(page.locator("[data-settings-page]")).toHaveCount(0);
			await expect(page.locator("[data-prompt-card]")).toHaveCount(0);
			await expect(page.locator("[data-prompt-countdown]")).toHaveCount(0);
			await shot("3-signed-in-chat");
			expect(errors).toEqual([]);
		} finally {
			await exitApp(app);
			await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});
}

test("cancel ends the browser sign-in through its callback, never through the paste request", async () => {
	test.setTimeout(120_000);
	const { app, page, record, errors, root } = await launch("en", "light");
	try {
		const anthropic = await startSignIn(page, "en");
		await anthropic.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(anthropic.locator("[data-login-progress]")).toHaveCount(0);
		// omp's callback saw the denial with the flow's state, as a provider's Deny button sends it.
		await expect
			.poll(async () => (await readRecords(record)).find(frame => frame.type === "login_callback"))
			.toMatchObject({
				path: "/callback",
				query: { error: "access_denied", error_description: "Sign-in cancelled in OMPdesk", state: "xyz" },
			});
		// The login failed quietly and its paste request went with it: answered once, after the login.
		await expect
			.poll(async () =>
				(await readRecords(record)).filter(
					frame => frame.type === "extension_ui_response" && frame.cancelled === true,
				),
			)
			.toHaveLength(1);
		await expect(page.getByText("Couldn't connect Anthropic")).toHaveCount(0);
		await expect(page.locator("[data-prompt-card]")).toHaveCount(0);
		// A new sign-in starts cleanly afterwards.
		await page
			.locator("[data-settings-page]")
			.getByRole("button", { name: "Connect Anthropic", exact: true })
			.click();
		await expect(anthropic.locator("[data-login-progress]")).toHaveText("Waiting for you to finish in the browser…");
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

/** Reload the window mid-sign-in: main still runs `login`, so it hands the sign-in back. */
async function reloadMidSignIn(page: Page): Promise<void> {
	await page.reload();
	await page.waitForFunction(() => window.omp?.rpc != null);
	// What main hands the reloaded page: stock's paste request, the panel's while `login` runs.
	await expect
		.poll(() => page.evaluate(() => window.omp.ui.openRequests().then(open => open.map(o => o.signIn?.active))))
		.toEqual([true]);
}

test("a reload mid-sign-in leaves no chat card and the panel shows the sign-in again, through to connected", async () => {
	test.setTimeout(120_000);
	const { app, page, record, errors, root } = await launch("en", "light");
	try {
		await startSignIn(page, "en");
		await page.keyboard.press("Escape");
		await reloadMidSignIn(page);
		await expect(page.locator("[data-prompt-card]")).toHaveCount(0);
		await expect(page.getByText("Paste the authorization code")).toHaveCount(0);

		const anthropic = await openAnthropicRow(page, "en");
		await expect(anthropic.locator("[data-login-progress]")).toHaveText(en["providerList.login.inProgress"] ?? "");
		await expect(anthropic.getByRole("button", { name: en["providerList.login.pasteToggle"] })).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		await expect(page.locator("[data-prompt-card]")).toHaveCount(0);

		// The browser half still reaches the callback server of the login that survived the reload.
		await anthropic.getByRole("button", { name: en["providerList.login.openBrowser"] }).click();
		await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "openedUrls"))).toHaveLength(1);
		const [launchUrl] = (await app.evaluate(() => Reflect.get(globalThis, "openedUrls"))) as string[];
		expect(await finishInBrowser(launchUrl ?? "", { code: "abc" })).toBe(200);

		await expect(page.getByText(tr("en", "providers.loginSuccess", { provider: "Anthropic" }))).toBeVisible();
		await expect(anthropic.locator("[data-login-progress]")).toHaveCount(0);
		// The leftover paste was answered once for stock, by the page that took the sign-in over.
		await expect
			.poll(async () =>
				(await readRecords(record)).filter(
					frame => frame.type === "extension_ui_response" && frame.cancelled === true,
				),
			)
			.toHaveLength(1);
		await expect(page.locator("[data-prompt-card]")).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("a reload mid-sign-in, then Cancel in the panel: the login ends through its callback and the chat stays clean", async () => {
	test.setTimeout(120_000);
	const { app, page, record, errors, root } = await launch("en", "light");
	try {
		await startSignIn(page, "en");
		await page.keyboard.press("Escape");
		await reloadMidSignIn(page);
		const anthropic = await openAnthropicRow(page, "en");
		await expect(anthropic.locator("[data-login-progress]")).toHaveText(en["providerList.login.inProgress"] ?? "");
		await anthropic.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(anthropic.locator("[data-login-progress]")).toHaveCount(0);
		await expect
			.poll(async () => (await readRecords(record)).find(frame => frame.type === "login_callback"))
			.toMatchObject({ path: "/callback", query: { error: "access_denied", state: "xyz" } });
		// `login` answered: the page that took it over answers the leftover paste, and nothing reaches the chat.
		await expect
			.poll(async () =>
				(await readRecords(record)).filter(
					frame => frame.type === "extension_ui_response" && frame.cancelled === true,
				),
			)
			.toHaveLength(1);
		await expect(page.locator("[data-prompt-card]")).toHaveCount(0);
		await expect(page.getByText("Couldn't connect Anthropic")).toHaveCount(0);
		expect(await page.evaluate(() => window.omp.ui.openRequests())).toEqual([]);
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("a sign-in that ends while the reloaded page has Settings closed is answered quietly, never a chat card", async () => {
	test.setTimeout(120_000);
	const { app, page, record, errors, root } = await launch("en", "light");
	try {
		const anthropic = await startSignIn(page, "en");
		await anthropic.getByRole("button", { name: en["providerList.login.openBrowser"] }).click();
		await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "openedUrls"))).toHaveLength(1);
		const [launchUrl] = (await app.evaluate(() => Reflect.get(globalThis, "openedUrls"))) as string[];
		await page.keyboard.press("Escape");
		await reloadMidSignIn(page);
		await expect(page.locator("[data-prompt-card]")).toHaveCount(0);
		expect(await finishInBrowser(launchUrl ?? "", { code: "abc" })).toBe(200);
		await expect
			.poll(async () =>
				(await readRecords(record)).filter(
					frame => frame.type === "extension_ui_response" && frame.cancelled === true,
				),
			)
			.toHaveLength(1);
		await expect(page.locator("[data-prompt-card]")).toHaveCount(0);
		expect(await page.evaluate(() => window.omp.ui.openRequests())).toEqual([]);
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
