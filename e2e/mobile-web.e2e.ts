/**
 * Settings › Devices & connections › Mobile web, end to end on the fake omp and the fake Tailscale CLI
 * (`e2e/fixture/fake-tailscale-install.ts`, never the user's own Tailscale or its serve config):
 * - the switch on a signed-out Tailscale: the sign-in step, Sign in opens Tailscale's login page, the user
 *   signing in (the scenario changes) walks it to ready with the link, the connected phone and the pairing QR;
 * - the user's own `443 → 127.0.0.1:3010` serve handler is never touched, no `serve reset` or `funnel` ever runs,
 *   and switching off removes only OMPdesk's own handler;
 * - a tailnet with HTTPS certificates off: the guidance names the public certificate log, the button opens the
 *   admin page, and enabling HTTPS lets it continue.
 * Captures in the test output directory, light/dark × en/ko.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { en } from "../src/renderer/locales/en";
import { ko } from "../src/renderer/locales/ko";
import { type FixtureTailscale, fixtureTailscale } from "./fixture/fake-tailscale-install";
import { USER_SERVE_HOST } from "./fixture/tailscale-scenario";
import { capture, exitApp, launchApp, pressShortcutUntilVisible } from "./harness";

type Language = "en" | "ko";
type Theme = "light" | "dark";

function translate(language: Language, key: string, vars: Record<string, string | number> = {}): string {
	const template = (language === "ko" ? ko : en)[key];
	if (template === undefined) throw new Error(`no ${language} string ${key}`);
	return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}

interface Launched {
	app: ElectronApplication;
	page: Page;
	tailscale: FixtureTailscale;
	root: string;
	/** Every URL the app handed the default browser (`shell.openExternal`, stubbed: a test never opens one). */
	opened: () => Promise<string[]>;
}

async function launch(
	language: Language,
	theme: Theme,
	scenario: Parameters<typeof fixtureTailscale>[1],
): Promise<Launched> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-mobile-web-${language}-${theme}-`));
	const desktop = path.join(root, "desktop");
	const project = path.join(root, "project");
	const agent = path.join(root, "agent");
	await Promise.all([fs.mkdir(desktop), fs.mkdir(project), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language, themeName: theme, firstRunComplete: true }),
	);
	const tailscale = await fixtureTailscale(root, scenario);
	const app = await launchApp({ project, desktop, agent, profile: root, env: { ...tailscale.env } });
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow, shell }) => {
		BrowserWindow.getAllWindows()[0]?.setContentSize(1180, 1000);
		const opened: string[] = [];
		Object.assign(globalThis, { openedUrls: opened });
		shell.openExternal = async (url: string) => {
			opened.push(url);
		};
	});
	await page.waitForFunction(() => window.omp?.rpc != null);
	return {
		app,
		page,
		tailscale,
		root,
		opened: () => app.evaluate(() => Reflect.get(globalThis, "openedUrls") as string[]),
	};
}

/** Settings › Devices & connections, scrolled to the Mobile web section. */
async function openMobileWeb(page: Page): Promise<Locator> {
	const settings = page.locator("[data-settings-page]");
	await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
	await settings.locator('[data-settings-section="connections"]').click();
	const section = settings.locator("#settings-connections-mobile-web");
	await section.scrollIntoViewIfNeeded();
	await expect(section.locator("[data-mobile-web-section]")).toBeVisible();
	return section;
}

const phase = (section: Locator, name: string) =>
	expect(section.locator("[data-mobile-web-section]")).toHaveAttribute("data-mobile-web-state", name, {
		timeout: 30_000,
	});

/** What the app ever ran on the fake CLI, and what the fake daemon serves now. */
function serveCalls(tailscale: FixtureTailscale): string[][] {
	return tailscale
		.invocations()
		.map(call => call.argv)
		.filter(argv => argv[0] === "serve");
}

function assertNeverReset(tailscale: FixtureTailscale): void {
	for (const { argv } of tailscale.invocations()) {
		expect(argv[0], `tailscale ${argv.join(" ")}`).not.toBe("funnel");
		expect(argv.slice(0, 2).join(" "), `tailscale ${argv.join(" ")}`).not.toBe("serve reset");
	}
}

function userHandlerIntact(tailscale: FixtureTailscale): void {
	const web = tailscale.scenario().serve.Web ?? {};
	expect(web[`${USER_SERVE_HOST}:443`]?.Handlers["/"]?.Proxy).toBe("http://127.0.0.1:3010");
	expect(tailscale.scenario().serve.TCP?.["443"]).toEqual({ HTTPS: true });
}

const ownKeys = (tailscale: FixtureTailscale) =>
	Object.keys(tailscale.scenario().serve.Web ?? {}).filter(key => !key.endsWith(":443"));

for (const language of ["en", "ko"] as const)
	for (const theme of ["light", "dark"] as const)
		test(`Mobile web walks from signed out to a pairing QR, and off removes only its own serve (${language} ${theme})`, async () => {
			test.skip(process.platform === "win32", "the fake Tailscale is a shebang script run by bun");
			test.setTimeout(180_000);
			const t = (key: string, vars?: Record<string, string | number>) => translate(language, key, vars);
			const { app, page, tailscale, root, opened } = await launch(language, theme, { backendState: "NeedsLogin" });
			try {
				const errors: string[] = [];
				page.on("pageerror", error => errors.push(error.message));
				const section = await openMobileWeb(page);
				const toggle = section.locator('#settings-mobile-web-toggle [role="switch"]');
				await expect(toggle).toHaveAttribute("aria-checked", "false");
				await capture(page, `mobile-web-${language}-${theme}-1-off`);

				// Switch on: the signed-out Tailscale asks for one thing, signing in.
				await toggle.click();
				await phase(section, "needs-login");
				await expect(section.getByRole("button", { name: t("mobileWeb.signIn"), exact: true })).toBeVisible();
				await capture(page, `mobile-web-${language}-${theme}-2-needs-login`);

				// Sign in opens Tailscale's own page and waits.
				await section.getByRole("button", { name: t("mobileWeb.signIn"), exact: true }).click();
				await phase(section, "logging-in");
				expect((await opened()).some(url => url.startsWith("https://login.tailscale.com/"))).toBe(true);
				await capture(page, `mobile-web-${language}-${theme}-3-logging-in`);

				// The user signs in in the browser; the page watches Tailscale and moves on by itself.
				tailscale.update({ backendState: "Running" });
				await phase(section, "ready");
				const link = `https://${USER_SERVE_HOST}:47831`;
				await expect(section.locator(`[data-copyable="${link}"]`)).toHaveText(link);
				await expect(section.locator("[data-mobile-web-phones]")).toContainText("iphone");
				// OMPdesk's own handler is in place next to the user's, which stays as it was.
				expect(serveCalls(tailscale).some(argv => argv.includes("--https=47831") && argv.includes("--bg"))).toBe(
					true,
				);
				expect(ownKeys(tailscale)).toEqual([`${USER_SERVE_HOST}:47831`]);
				userHandlerIntact(tailscale);

				// Pair a phone: the code with its countdown and a QR of the pairing page.
				await section.getByRole("button", { name: t("mobileWeb.pair"), exact: true }).click();
				const pairing = section.locator("[data-mobile-web-pairing]");
				await expect(pairing.locator("[data-copyable]").first()).toHaveText(/^[0-9A-Z]{8}$/);
				await expect(pairing.locator("[data-mobile-web-code-expiry]")).toContainText(/\d:\d\d/);
				await expect(pairing.locator("svg[data-qr-code]")).toHaveAttribute("aria-label", t("mobileWeb.pairQr"));
				expect(await pairing.locator("svg[data-qr-code] path").getAttribute("d")).toMatch(/^M4 4/);
				await expect(section.locator("[data-mobile-web-store]")).toHaveCount(2);
				await capture(page, `mobile-web-${language}-${theme}-4-ready`);
				await section.screenshot({
					animations: "disabled",
					path: test.info().outputPath(`mobile-web-${language}-${theme}-5-section.png`),
				});
				await expect(section.locator("[data-mobile-web-users]")).toContainText("seuput@example.com");

				// Off removes OMPdesk's handler and nothing else.
				await toggle.click();
				await phase(section, "off");
				await expect.poll(() => ownKeys(tailscale), { timeout: 30_000 }).toEqual([]);
				userHandlerIntact(tailscale);
				assertNeverReset(tailscale);
				expect(errors).toEqual([]);
			} finally {
				await exitApp(app);
				await fs.rm(root, { recursive: true, force: true });
			}
		});

test("Mobile web explains HTTPS certificates being off and continues once they are on (en light)", async () => {
	test.skip(process.platform === "win32", "the fake Tailscale is a shebang script run by bun");
	test.setTimeout(180_000);
	const language = "en";
	const t = (key: string) => translate(language, key);
	const { app, page, tailscale, root, opened } = await launch(language, "light", {
		httpsEnabled: false,
		httpsCapability: false,
	});
	try {
		const section = await openMobileWeb(page);
		await section.locator('#settings-mobile-web-toggle [role="switch"]').click();
		await phase(section, "https-disabled");
		// The consent text: the device name goes into the public certificate-transparency log.
		await expect(section.locator("[data-mobile-web-phase]")).toContainText(t("mobileWeb.phase.httpsDisabledDesc"));
		await expect(section.locator("[data-mobile-web-admin-message]")).toContainText(t("mobileWeb.adminMessage"));
		await capture(page, "mobile-web-en-light-https-disabled");

		await section.getByRole("button", { name: t("mobileWeb.enableHttps"), exact: true }).click();
		await expect
			.poll(async () => (await opened()).some(url => url.startsWith("https://login.tailscale.com/")))
			.toBe(true);
		// Nothing was published while the tailnet refused: only the user's own handler exists.
		expect(ownKeys(tailscale)).toEqual([]);

		// The admin turned HTTPS on: Mobile web carries on without another click.
		tailscale.update({ httpsEnabled: true, httpsCapability: true });
		await phase(section, "ready");
		expect(ownKeys(tailscale)).toEqual([`${USER_SERVE_HOST}:47831`]);
		userHandlerIntact(tailscale);
		assertNeverReset(tailscale);
	} finally {
		await exitApp(app);
		await fs.rm(root, { recursive: true, force: true });
	}
});
