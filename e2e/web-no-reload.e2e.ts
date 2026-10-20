/**
 * The phone's page never loads itself again on its own (AGENTS.md "Reloads of the web page"), on the built app behind
 * the fake `tailscale serve` (e2e/fixture/phone-serve.ts), in Chromium (Pixel 7) and WebKit (iPhone 14):
 *
 * - The link drops while a reply streams: the page reconnects and catches up in place (web/resync.ts), with no new
 *   page load, and the reply goes on to its end in the same transcript.
 * - The computer updates to another build while the page stays open on the old one, with a draft in the composer.
 *   Opening a view the page never loaded (the feedback dialog, a lazy chunk nothing preloads, which the new build no
 *   longer has) is served from the old build's assets the host kept (main/web/asset-archive.ts); the page does not
 *   reload and the draft is still there.
 * - A view whose chunk nobody has any more (the model setup dialog, gone from the new build and from the kept assets)
 *   stays empty with no prompt of any kind (updates are automatic: no banner, no button) and no reload while the page is in use; the
 *   page is outdated now, and once it comes back after ≥ 30 s hidden with nothing to lose it reloads by itself, its
 *   reason `chunk-load-failed` in the host's runtime log (lib/chunk-load.ts, web-boot.ts, sw-update.ts).
 *
 * A "page load" is `domcontentloaded` plus a marker on `window`: `framenavigated` also fires for same-document
 * history entries (the page's back layers), which are no reload.
 *
 * The rules themselves are unit-tested: resync.test.ts, resync-page.test.ts, ws-transport.test.ts, chunk-load.test.tsx,
 * sw-core.test.ts, sw-update.test.ts, asset-archive.test.ts and server.test.ts.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type BrowserType, chromium, devices, expect, type Page, test, webkit } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { crash } from "./autopilot-harness";
import { fixtureTailscale } from "./fixture/fake-tailscale-install";
import { phonePaired as paired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { cssString, exitApp, fixtureOmp } from "./harness";

const ENGINES: { name: string; type: BrowserType; device: (typeof devices)[string] }[] = [
	{ name: "chromium", type: chromium, device: devices["Pixel 7"] },
	{ name: "webkit", type: webkit, device: devices["iPhone 14"] },
];

/** The build the run pins (playwright.config.ts), the one the page first loads. */
const BUILD_A = path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out");

async function launch(out: string, userData: string, env: Record<string, string>) {
	const app = await electron.launch({ args: [path.join(out, "main/index.js"), `--user-data-dir=${userData}`], env });
	const page = await app.firstWindow();
	await page.waitForFunction(() => window.omp?.rpc != null);
	return { app, page };
}

async function mobileWebReady(page: Page): Promise<void> {
	await expect
		.poll(() => page.evaluate(async () => (await window.omp.mobileWeb.getState()).phase).catch(() => "starting"), {
			timeout: 60_000,
		})
		.toBe("ready");
}

/**
 * A second build beside the first, as an update brings one: the same app with a changed `web.html` (another build
 * id) and without the feedback and model setup dialogs' chunks, whose names a real build changes with their contents.
 * Both are lazy views nothing preloads (the pages and the side panel's views are fetched once the page idles).
 */
async function makeBuildB(): Promise<{ out: string; keptChunk: string; goneChunk: string }> {
	const out = await fs.mkdtemp(path.join(path.dirname(BUILD_A), "out-e2e-"));
	await fs.cp(BUILD_A, out, { recursive: true });
	const assets = path.join(out, "renderer", "assets");
	const names = await fs.readdir(assets);
	const keptChunk = names.find(name => /^FeedbackDialog-.*\.js$/.test(name));
	const goneChunk = names.find(name => /^ModelSetupDialog-.*\.js$/.test(name));
	if (!keptChunk || !goneChunk) throw new Error("no FeedbackDialog or ModelSetupDialog chunk in the build");
	await Promise.all([fs.rm(path.join(assets, keptChunk)), fs.rm(path.join(assets, goneChunk))]);
	const html = path.join(out, "renderer", "web.html");
	await fs.writeFile(html, `${await fs.readFile(html, "utf8")}\n<!-- e2e build B -->\n`);
	return { out, keptChunk, goneChunk };
}

/** The page's visibility as the browser reports it (a phone switching apps), with its `visibilitychange`. */
function setVisibility(phone: Page, state: "hidden" | "visible") {
	return phone.evaluate(next => {
		Object.defineProperty(document, "visibilityState", { value: next, configurable: true });
		Object.defineProperty(document, "hidden", { value: next === "hidden", configurable: true });
		document.dispatchEvent(new Event("visibilitychange"));
	}, state);
}

/** A line the fake omp takes on stdin (`fixture:*`), sent as the tab's `bash` command. */
test.use({ actionTimeout: 30_000 });

async function fixture(phone: Page, tabId: string, line: string) {
	return phone.evaluate(([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }), [
		tabId,
		line,
	] as const);
}

/**
 * Show `tabId` as a person does, by its drawer row. The page has a tab of its own besides it (a paired page with
 * none opens the empty start tab), and after a reload either may be the active one.
 */
async function showTab(phone: Page, tabId: string): Promise<void> {
	const active = async () => (await phone.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId;
	if ((await active()) === tabId) return;
	const sessionPath = (await phone.evaluate(() => window.omp.tabs.list())).find(
		tab => tab.tabId === tabId,
	)?.sessionPath;
	await phone.getByRole("button", { name: "Open menu" }).click();
	const sidebar = phone.locator("[data-drawer] .omp-session-sidebar");
	for (const fold of await sidebar.locator('[data-workspace-group] button[aria-expanded="false"]').all())
		await fold.click().catch(() => undefined);
	await sidebar
		.locator(`.omp-sidebar-session-row[data-session-path=${cssString(sessionPath ?? `tab:${tabId}`)}]`)
		.click();
	await expect.poll(active).toBe(tabId);
}

for (const engine of ENGINES)
	test(`The phone's page (${engine.name}) catches up in place after a drop mid-reply, and opens a never-loaded view after the computer updated without reloading or losing the draft; a view nobody has any more stays quiet and the page reloads only once unused`, async () => {
		test.skip(process.platform === "win32", "the fake Tailscale is a bun shebang script");
		test.setTimeout(360_000);
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-web-no-reload-")));
		const project = path.join(root, "project");
		const desktop = path.join(root, "desktop");
		const agent = path.join(root, "agent");
		await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({
				language: "en",
				themeName: "light",
				firstRunComplete: true,
				lastProject: project,
			}),
		);
		const tailscale = await fixtureTailscale(root, { backendState: "Running" });
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
		Object.assign(env, {
			PI_CODING_AGENT_DIR: agent,
			PI_CONFIG_DIR: path.relative(os.homedir(), root),
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OMP_GUI_OMP: await fixtureOmp(root),
			// A stock-shaped session file, so the relaunched host's tab is the same session (the draft is filed under it).
			OMP_GUI_TEST_SESSION_FILES: "1",
			...tailscale.env,
		});
		Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
		const browser = await engine.type.launch();
		let current: ElectronApplication | null = null;
		let proxy: ServeProxy | null = null;
		let buildB: string | null = null;
		try {
			const first = await launch(BUILD_A, desktop, env);
			current = first.app;
			await first.page.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
			await mobileWebReady(first.page);
			const [site] = serveSites(tailscale);
			if (!site) throw new Error("no serve handler published");
			proxy = await ServeProxy.start(site, "seuput@example.com", undefined, {
				plainCookie: engine.name === "webkit",
			});
			const phone = await (await browser.newContext({ ...engine.device, colorScheme: "light" })).newPage();
			await phone.goto(`${proxy.url}/`);
			await paired(phone);
			// The tab this test drives: by the id the spawn answers, never "the active one" (see showTab).
			const tabId = (await phone.evaluate(cwd => window.omp.tabs.spawn({ cwd, kind: "agent" }), project))?.tabId;
			if (!tabId) throw new Error("no tab on the phone");
			await phone.reload();
			await paired(phone);
			const field = phone.locator("[data-composer-input]").first();
			await expect(field).toBeVisible({ timeout: 60_000 });
			await showTab(phone, tabId);
			await expect
				.poll(
					() =>
						phone.evaluate(async id => (await window.omp.tabs.list()).find(t => t.tabId === id)?.status, tabId),
					{
						timeout: 60_000,
					},
				)
				.toBe("ready");

			// From here on the page must never load again.
			let loads = 0;
			phone.on("domcontentloaded", () => {
				loads++;
			});
			await phone.evaluate(() => Reflect.set(window, "noReloadRun", true));

			// (b) A reply streams; the link drops under it.
			// Text typed into the page's first, seeded view of the tab stays when the live view takes its place.
			const send = phone.getByRole("button", { name: /^(Send|보내기)$/ });
			await field.fill("fixture stream");
			await phone.waitForTimeout(1500);
			expect(await field.inputValue()).toBe("fixture stream");
			await expect(send).toBeEnabled({ timeout: 1000 });
			await send.click();
			await expect(phone.getByText("Stream chunk 3.", { exact: false }).first()).toBeVisible({ timeout: 60_000 });
			const progress = (await fixture(phone, tabId, "fixture:progress")).data;
			proxy.dropSockets();
			const chunksAtDrop =
				progress && typeof progress === "object" && "chunks" in progress ? Number(progress.chunks) : 0;
			// The reply keeps streaming into the same transcript, past what had arrived when the link dropped.
			await expect(phone.getByText(`Stream chunk ${chunksAtDrop + 20}.`, { exact: false }).first()).toBeVisible({
				timeout: 60_000,
			});
			expect(await fixture(phone, tabId, "fixture:finish")).toMatchObject({ success: true });
			await expect(phone.getByText("Background run finished").first()).toBeVisible({ timeout: 60_000 });
			expect(loads).toBe(0);
			expect(await phone.evaluate(() => Reflect.get(window, "noReloadRun"))).toBe(true);

			// (a) The computer updates to build B (killed and started on the new build, as an update's restart does);
			// the page stays open on build A with a draft.
			const b = await makeBuildB();
			buildB = b.out;
			await field.fill("a draft that must outlive the update");
			// Typing is saved once it pauses (InputArea's DRAFT_SAVE_MS); a crash right after a keystroke loses less.
			await phone.waitForTimeout(1000);
			await crash(current);
			current = null;
			const second = await launch(b.out, desktop, env);
			current = second.app;
			await mobileWebReady(second.page);
			proxy.retarget(serveSites(tailscale).at(-1) ?? site);
			await expect
				.poll(() => phone.evaluate(async () => (await window.omp.tabs.list()).length).catch(() => 0), {
					timeout: 120_000,
				})
				.toBeGreaterThan(0);
			await expect(field).toHaveValue("a draft that must outlive the update", { timeout: 30_000 });

			// The feedback dialog was never loaded: its chunk comes from build A's assets the host kept, build B has none.
			const keptServed = phone.waitForResponse(response => response.url().endsWith(`/assets/${b.keptChunk}`), {
				timeout: 30_000,
			});
			await phone.getByRole("button", { name: "Open menu" }).click();
			await phone.getByRole("button", { name: "Help" }).click();
			// On touch the help menu is a sheet of rows.
			await phone.getByText("Send feedback", { exact: true }).click();
			expect((await keptServed).status()).toBe(200);
			const feedback = phone.getByRole("dialog", { name: "Send feedback" });
			await expect(feedback).toBeVisible({ timeout: 30_000 });
			// Its close button, as on a phone (no Escape key there; an Escape pressed the frame the dialog painted can
			// come before its key listener, attached after paint, and was lost 1 in 20 in WebKit).
			await feedback.getByRole("button", { name: "Close" }).first().click();
			await expect(feedback).toHaveCount(0);
			// The drawer it was opened from is still there: the system back gesture closes it (a same-page entry).
			await phone.goBack();
			await expect(phone.locator("[data-drawer]")).toHaveCount(0);
			await expect(field).toBeVisible({ timeout: 30_000 });
			await expect(field).toHaveValue("a draft that must outlive the update");
			expect(loads).toBe(0);
			expect(await phone.evaluate(() => Reflect.get(window, "noReloadRun"))).toBe(true);

			// The model setup dialog: its chunk is in neither build B nor the kept assets (nor the worker's cache).
			for (const entry of await fs
				.readdir(path.join(desktop, "web-assets"), { withFileTypes: true })
				.catch(() => []))
				if (entry.isDirectory())
					await fs.rm(path.join(desktop, "web-assets", entry.name, "assets", b.goneChunk), { force: true });
			const goneTries: number[] = [];
			phone.on("response", response => {
				if (response.url().endsWith(`/assets/${b.goneChunk}`)) goneTries.push(response.status());
			});
			await phone.getByRole("button", { name: "Open menu" }).click();
			await phone.locator('[data-destination="settings"]').click();
			await phone.locator('[data-settings-section="models"]').click();
			// The button waits for the tab's omp, which the relaunched host is still starting.
			const setup = phone.locator("#settings-models-setup").getByRole("button", { name: "Set up automatically" });
			await expect(setup).toBeEnabled({ timeout: 90_000 });
			await setup.click();
			// Refused (the worker retries behind the page, and a browser keeps a failed module import, so the page sees
			// one answer); the dialog stays away and nothing asks the user anything.
			await expect.poll(() => goneTries.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
			expect(goneTries.every(status => status === 404)).toBe(true);
			await phone.waitForTimeout(4000);
			await expect(phone.getByRole("dialog")).toHaveCount(0);
			await expect(phone.getByText(/new version|새 버전/i)).toHaveCount(0);
			await expect(phone.getByRole("button", { name: /^(Reload|새로고침)$/ })).toHaveCount(0);
			expect(loads).toBe(0);
			await phone.getByRole("button", { name: "Back to session" }).click();
			await expect(field).toHaveValue("a draft that must outlive the update");
			// In use (a draft, a touch): it stays. Once the composer is empty and the page comes back after ≥ 30 s away,
			// the stale page reloads by itself, as an update would.
			await field.fill("");
			await phone.waitForTimeout(500);
			await setVisibility(phone, "hidden");
			await phone.waitForTimeout(31_000);
			expect(loads).toBe(0);
			await setVisibility(phone, "visible");
			await expect.poll(() => loads, { timeout: 30_000, message: "the stale page reloads at its return" }).toBe(1);
			await expect(field).toBeVisible({ timeout: 60_000 });
			await expect
				.poll(
					async () =>
						(await fs.readFile(path.join(desktop, "logs", "gui-runtime.jsonl"), "utf8").catch(() => ""))
							.split("\n")
							.some(line => line.includes("web-reload") && line.includes("chunk-load-failed")),
					{ timeout: 30_000, message: "the reload's reason reaches the host's log" },
				)
				.toBe(true);
		} finally {
			await browser.close();
			await proxy?.close();
			if (current) await exitApp(current).catch(() => undefined);
			if (buildB) await fs.rm(buildB, { recursive: true, force: true }).catch(() => undefined);
			await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => undefined);
		}
	});
