/**
 * Settings › Devices & connections › Mobile web, end to end on the fake omp and the fake Tailscale CLI
 * (`e2e/fixture/fake-tailscale-install.ts`, never the user's own Tailscale or its serve config):
 * - the switch on a signed-out Tailscale: the sign-in step, Sign in opens Tailscale's login page, the user
 *   signing in (the scenario changes) walks it to ready with the link, a big Copy button, one QR of the link and
 *   the connected phone (no pairing code anywhere);
 * - a phone's first visit, sent the way `tailscale serve` hands requests on (the secret path prefix serve's target
 *   carries, the Tailscale login and tailnet address headers): headers forged without the prefix get a 404 and no
 *   device; through the prefix the device connects on its own, the desktop shows one notice, the phone talks to the
 *   built app's web server over /ws (`phoneRoundTrip`); Block in the notice keeps it out (old cookie, the page, a
 *   new connection) until Unblock in Settings; "Approve new devices on this computer" brings the dialog back;
 * - the user's own `443 → 127.0.0.1:3010` serve handler is never touched, no `serve reset` or `funnel` ever runs,
 *   and switching off removes only OMPdesk's own handler.
 * A tailnet with HTTPS certificates off (the guidance, the admin page, continuing once it is on) is covered by
 * MobileWebSection.test.tsx and tailscale/service.test.ts.
 * Captures in the test output directory, light/dark × en/ko.
 */
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { WebSocket } from "ws";
import { en } from "../src/renderer/locales/en";
import { ko } from "../src/renderer/locales/ko";
import { IPC_COMMANDS } from "../src/shared/ipc-types";
import { type FixtureTailscale, fixtureTailscale } from "./fixture/fake-tailscale-install";
import { USER_SERVE_HOST } from "./fixture/tailscale-scenario";
import { capture, exitApp, launchApp, pressShortcutUntilVisible, variants } from "./harness";

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

/** The address `tailscale serve` publishes OMPdesk on in the fake scenario. */
const PUBLISHED = `${USER_SERVE_HOST}:47831`;

/** One request to the app's loopback web server, carrying a Host `fetch` would not send. */
function send(
	port: string,
	method: "GET" | "POST",
	pathname: string,
	body: unknown,
	headers: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
	const { promise, resolve, reject } = Promise.withResolvers<{
		status: number;
		headers: http.IncomingHttpHeaders;
		body: string;
	}>();
	const req = http.request(
		{
			host: "127.0.0.1",
			port,
			path: pathname,
			method,
			headers: method === "POST" ? { ...headers, "content-type": "application/json" } : headers,
		},
		res => {
			const chunks: Buffer[] = [];
			res.on("data", chunk => chunks.push(chunk as Buffer));
			res.on("end", () =>
				resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }),
			);
		},
	);
	req.on("error", reject);
	req.end(method === "POST" ? JSON.stringify(body) : undefined);
	return promise;
}

/** The fake `iphone` peer of the scenario: the tailnet address serve puts in `X-Forwarded-For`. */
const PHONE_IP = "100.64.0.9";

/**
 * A phone's first visit, the way `tailscale serve` hands requests on, then Block and Unblock from the desktop.
 * Every frame a WebSocket client sends is masked: v0.34.0's main process died on the first one
 * (`bufferUtil.unmask is not a function`, the bundler's empty stand-in for ws's optional `bufferutil`), which
 * `src/main/web/server.test.ts` cannot see because it runs ws unbundled.
 */
async function phoneRoundTrip(
	app: ElectronApplication,
	page: Page,
	section: Locator,
	tailscale: FixtureTailscale,
	t: (key: string, vars?: Record<string, string | number>) => string,
) {
	const target = tailscale.scenario().serve.Web?.[PUBLISHED]?.Handlers["/"]?.Proxy;
	if (!target) throw new Error(`no serve handler for ${PUBLISHED}`);
	const { port, pathname } = new URL(target);
	// Serve's target carries the install's secret path: only traffic that came through serve has it.
	const prefix = pathname.replace(/\/$/, "");
	expect(prefix).toMatch(/^\/[A-Za-z0-9_-]{43}$/);
	const headers = {
		host: PUBLISHED,
		origin: `https://${PUBLISHED}`,
		"tailscale-user-login": "seuput@example.com",
		"x-forwarded-for": PHONE_IP,
		"user-agent": "E2EPhone/1.0",
	};
	const devices = () => page.evaluate(() => window.omp.mobileWeb.devices.list());

	// A local process can write the same headers, but not the prefix: nothing is served and no device is made.
	const forged = await send(port, "POST", "/api/pair", { name: "forged", clientInstanceId: "forged" }, headers);
	expect(forged.status, forged.body).toBe(404);
	expect((await send(port, "GET", "/", undefined, headers)).status).toBe(404);
	expect(await devices()).toEqual([]);

	// The first visit through serve: the page, then the device connects on its own, named from `tailscale whois`.
	const visit = await send(port, "GET", `${prefix}/`, undefined, headers);
	expect(visit.status, visit.body).toBe(200);
	const paired = await send(port, "POST", `${prefix}/api/pair`, { name: "E2E phone" }, headers);
	expect(paired.status, paired.body).toBe(200);
	expect(JSON.parse(paired.body)).toMatchObject({ name: "iphone" });
	const cookie = (paired.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "";
	// One quiet notice on the desktop, with the way to block it; no approval dialog was asked.
	await expect(page.locator("[data-toast-stack]")).toContainText(t("mobileWeb.notice.message", { name: "iphone" }));
	await expect(page.locator("[data-web-pairing-approve]")).toHaveCount(0);
	await expect(section.locator("[data-mobile-web-devices] [data-web-device]")).toHaveCount(1);

	const session = await send(port, "POST", `${prefix}/api/session`, {}, { ...headers, cookie });
	expect(session.status, session.body).toBe(200);
	const { ticket } = JSON.parse(session.body) as { ticket: string };

	// Main records what it throws, so a crash fails this test with its stack instead of a native error dialog
	// (Electron shows one only while no other `uncaughtException` listener exists) holding main until a timeout.
	await app.evaluate(() => {
		const uncaught: string[] = [];
		Reflect.set(globalThis, "mainUncaught", uncaught);
		process.on("uncaughtException", error => uncaught.push(String(error.stack ?? error)));
	});
	const socket = new WebSocket(`ws://127.0.0.1:${port}${prefix}/ws`, ["ompdesk.v1", `ticket.${ticket}`], {
		headers: { ...headers, cookie },
	});
	try {
		const frames: Array<{ t: string; id?: number }> = [];
		socket.on("message", data => frames.push(JSON.parse(data.toString()) as { t: string; id?: number }));
		// An `unexpected-response` (a refused upgrade) reaches `once` as the socket's `error`.
		await once(socket, "open");
		await expect.poll(() => frames[0]?.t).toBe("hello");
		// Masked and over 32 bytes: the length at which ws unmasks through `bufferutil` when it believes it has it.
		socket.send(JSON.stringify({ t: "inv", id: 1, ch: IPC_COMMANDS.SESSIONS_LIST, a: [{ scope: "global" }] }));
		const answer = async () => {
			const uncaught = await app.evaluate(() => Reflect.get(globalThis, "mainUncaught") as string[]);
			return uncaught.length > 0 ? uncaught : frames.find(frame => frame.t === "res")?.id;
		};
		await expect.poll(answer, { timeout: 15_000 }).toBe(1);

		// Block in the notice: the socket closes, the cookie is dead, and the page and a new connection are refused.
		const closed = once(socket, "close");
		await page.locator("[data-toast-action]").click();
		const [code] = await closed;
		expect(code).toBe(4401);
	} finally {
		socket.terminate();
	}
	await expect.poll(devices).toEqual([]);
	expect((await send(port, "POST", `${prefix}/api/session`, {}, { ...headers, cookie })).status).toBe(401);
	const blockedPage = await send(port, "GET", `${prefix}/`, undefined, headers);
	expect(blockedPage.status).toBe(403);
	expect(blockedPage.body).toContain('data-refusal="blocked-node"');
	const again = await send(port, "POST", `${prefix}/api/pair`, { name: "E2E phone" }, headers);
	expect(again.status, again.body).toBe(403);
	expect(JSON.parse(again.body)).toEqual({ error: "blocked" });
	expect(await devices()).toEqual([]);

	// Settings lists the block; Unblock lets the same device connect again.
	await expect(section.locator("[data-web-blocked]")).toHaveCount(1);
	await section.locator("[data-web-unblock]").click();
	await expect(section.locator("[data-web-blocked]")).toHaveCount(0);
	const back = await send(port, "POST", `${prefix}/api/pair`, { name: "E2E phone" }, headers);
	expect(back.status, back.body).toBe(200);
	await expect(section.locator("[data-mobile-web-devices] [data-web-device]")).toHaveCount(1);

	// "Approve new devices on this computer": the visit waits for the desktop's dialog.
	const confirm = section.locator('#settings-mobile-web-confirm [role="switch"]');
	await confirm.click();
	await expect(confirm).toHaveAttribute("aria-checked", "true");
	const asked = send(
		port,
		"POST",
		`${prefix}/api/pair`,
		{ name: "E2E tablet" },
		{ ...headers, "x-forwarded-for": "100.64.0.77" },
	);
	await page.locator("[data-web-pairing-approve]").click();
	const approved = await asked;
	expect(approved.status, approved.body).toBe(200);
	await confirm.click();
	await expect(confirm).toHaveAttribute("aria-checked", "false");
}

for (const language of variants(["en", "ko"] as const))
	for (const theme of variants(["light", "dark"] as const))
		test(`${language === "en" && theme === "light" ? "@smoke " : ""}Mobile web walks from signed out to a link and QR, a phone connects on its first visit through the serve prefix and is blocked and unblocked, and off removes only its own serve (${language} ${theme})`, async () => {
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
				// OMPdesk's own handler is in place next to the user's, which stays as it was; serve's target is
				// the loopback address plus the install's secret path.
				expect(serveCalls(tailscale).some(argv => argv.includes("--https=47831") && argv.includes("--bg"))).toBe(
					true,
				);
				expect(ownKeys(tailscale)).toEqual([`${USER_SERVE_HOST}:47831`]);
				expect(tailscale.scenario().serve.Web?.[PUBLISHED]?.Handlers["/"]?.Proxy).toMatch(
					/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{43}$/,
				);
				userHandlerIntact(tailscale);

				// The link, one big Copy button and one QR of it; no pairing code, countdown or pair button.
				await expect(section.locator("[data-mobile-web-copy]")).toHaveText(t("mobileWeb.copyLink"));
				const qr = section.locator("[data-mobile-web-link] svg[data-qr-code]");
				await expect(qr).toHaveAttribute("aria-label", t("mobileWeb.qr"));
				expect(await qr.locator("path").getAttribute("d")).toMatch(/^M4 4/);
				await expect(section.locator("[data-mobile-web-pairing], [data-mobile-web-pair]")).toHaveCount(0);
				await expect(section.locator("[data-mobile-web-store]")).toHaveCount(2);
				await expect(section.locator('#settings-mobile-web-confirm [role="switch"]')).toHaveAttribute(
					"aria-checked",
					"false",
				);
				await capture(page, `mobile-web-${language}-${theme}-4-ready`);
				await section.screenshot({
					animations: "disabled",
					path: test.info().outputPath(`mobile-web-${language}-${theme}-5-section.png`),
				});
				await expect(section.locator("[data-mobile-web-users]")).toContainText("seuput@example.com");

				// A phone's first visit connects it on its own and talks to the built app over /ws; Block and Unblock.
				await phoneRoundTrip(app, page, section, tailscale, t);

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
