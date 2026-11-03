/**
 * The parity sheet (`bun run parity -- <surface…>`, scripts/parity.ts): each named surface of
 * e2e/responsive-surfaces.ts that declares a `parity` session, captured on the same session of one computer (B, the
 * host) three ways: B's own desktop window, another OMPdesk paired with B viewing that session from B's section of its
 * sidebar (A, the remote host view), and B's phone page at 390×844 (Chromium as a phone behind the fake
 * `tailscale serve`, e2e/fixture/phone-serve.ts). Two apps on the fake omp (e2e/remote-harness.ts), en light.
 *
 * Registered only with OMP_GUI_PARITY=<dir>; OMP_GUI_PARITY_ONLY=<id,…> picks the surfaces (default: every one with a
 * `parity` session). Writes `<dir>/<surface>/{local,remote,phone}.png`, `<dir>/<surface>/sheet.png` (the three side by
 * side, labelled) and `<dir>/parity.json`. A view that cannot reach a surface (its `ready` never shows, the renderer
 * or a panel crashed) fails the test naming the surface and the view, and that surface gets no sheet.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Browser, chromium, devices, expect, type Locator, type Page, test } from "@playwright/test";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { controlToolCaller, cssString, exitApp, openedSessions, untilAnswered } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, REMOTE_LOGIN, type RemoteInstance } from "./remote-harness";
import { crashed, type Look, panelCrash } from "./responsive-audit";
import { type ParitySession, SURFACES, type Surface } from "./responsive-surfaces";

const dir = process.env.OMP_GUI_PARITY;

const VIEWS = ["local", "remote", "phone"] as const;
type View = (typeof VIEWS)[number];

const DESKTOP: Look = {
	width: 1280,
	height: 860,
	dpr: 1,
	orientation: "landscape",
	theme: "light",
	lang: "en",
	device: "electron",
};
const PHONE: Look = { width: 390, height: 844, dpr: 3, orientation: "portrait", theme: "light", lang: "en" };

const VIEW_LOOK: Record<View, Look> = { local: DESKTOP, remote: DESKTOP, phone: PHONE };
const VIEW_LABEL: Record<View, string> = {
	local: "This computer: B's own window",
	remote: "Paired computer: A viewing B's session",
	phone: "Phone 390×844: B's web page",
};

/** One of B's sessions as every view reaches it. */
interface HostSession {
	path: string;
	cwd: string;
}

/** What the run wrote for one surface (`parity.json`). */
interface SurfaceRecord {
	id: string;
	title: string;
	session: ParitySession;
	shots: Partial<Record<View, string>>;
	sheet?: string;
	failures: string[];
}

function paritySurfaces(): Array<Surface & { parity: NonNullable<Surface["parity"]> }> {
	const capable = SURFACES.filter(
		(surface): surface is Surface & { parity: NonNullable<Surface["parity"]> } => surface.parity !== undefined,
	);
	const only = process.env.OMP_GUI_PARITY_ONLY?.split(",").filter(Boolean);
	if (!only) return capable;
	return only.map(id => {
		const surface = capable.find(entry => entry.id === id);
		if (!surface)
			throw new Error(
				`no parity surface "${id}": ${capable.map(entry => entry.id).join(", ")} (responsive-surfaces.ts \`parity\`)`,
			);
		return surface;
	});
}

/** The three views side by side under their labels, one PNG. */
async function writeSheet(browser: Browser, surface: Surface, shots: Record<View, string>, file: string) {
	const images = await Promise.all(
		VIEWS.map(async view => ({
			view,
			src: `data:image/png;base64,${(await fs.readFile(shots[view])).toString("base64")}`,
		})),
	);
	const html = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
	const context = await browser.newContext({ viewport: { width: 3200, height: 1000 }, deviceScaleFactor: 1 });
	try {
		const page = await context.newPage();
		await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff;font:15px system-ui,sans-serif;color:#1f2328">
<main style="display:inline-flex;flex-direction:column;gap:12px;padding:16px">
<div><b>${html(surface.id)}</b> · ${html(surface.title)}</div>
<div style="display:flex;gap:16px;align-items:flex-start">
${images
	.map(
		image => `<figure style="margin:0;display:flex;flex-direction:column;gap:6px">
<figcaption>${html(VIEW_LABEL[image.view])}</figcaption>
<img src="${image.src}" style="height:760px;width:auto;border:1px solid #d0d7de">
</figure>`,
	)
	.join("\n")}
</div></main></body></html>`);
		await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
		await page.locator("main").screenshot({ path: file });
	} finally {
		await context.close();
	}
}

if (dir) {
	test.describe.configure({ retries: 0 });

	test("parity sheet: local window, paired computer's view and phone of the same session", async () => {
		const surfaces = paritySurfaces();
		test.setTimeout(300_000 + surfaces.length * 90_000);
		const out = path.resolve(dir);
		await fs.mkdir(out, { recursive: true });
		const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-parity-")));
		// The voice call surfaces script the fake omp's speech through this file (e2e/fixture/rpc-ui.ts `voiceScript`).
		process.env.OMP_GUI_TEST_VOICE_FILE = path.join(parent, "voice.json");
		let host: RemoteInstance | undefined;
		let client: RemoteInstance | undefined;
		let proxy: ServeProxy | undefined;
		const browser = await chromium.launch();
		const pageErrors: string[] = [];
		try {
			const hostProfile = await makeRemoteProfile(parent, "host", {
				language: "en",
				theme: "light",
				prefs: { botEnabled: true },
			});
			const clientProfile = await makeRemoteProfile(parent, "client", {
				language: "en",
				theme: "light",
				port: hostProfile.port,
			});
			host = await launchRemote(hostProfile);
			client = await launchRemote(clientProfile);
			const b = host.page;
			const a = client.page;
			await a.evaluate(() => window.omp.remote.setDeviceName("PC-A"));
			const deviceId = await connectHost(b, a, "PC-B");
			await expect
				.poll(async () => (await a.evaluate(() => window.omp.remote.getState())).hosts[0]?.state, {
					timeout: 30_000,
				})
				.toBe("online");

			// B's work: a titled session with one answered turn.
			const sessions = {} as Record<ParitySession, HostSession>;
			const start = (await b.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId ?? "";
			await b.evaluate(
				id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:title:Parity work" }),
				start,
			);
			const input = b.locator("textarea").first();
			await input.fill("Show this session the same way everywhere");
			await input.press("Enter");
			await expect(b.getByText("Local fixture reply").first()).toBeVisible({ timeout: 30_000 });
			await expect
				.poll(
					async () => {
						const tab = (await b.evaluate(() => window.omp.tabs.list())).find(entry => entry.tabId === start);
						sessions.work = { path: tab?.sessionPath ?? "", cwd: tab?.cwd ?? "" };
						return sessions.work.path;
					},
					{ timeout: 30_000 },
				)
				.not.toBe("");

			// B's bot, awake, with a duty and an open decision, so its bar and decision dock draw.
			let botPath = "";
			await expect
				.poll(
					async () => {
						const value = await b.evaluate(() => window.omp.prefs.get("bot"));
						botPath = typeof value === "string" ? value : "";
						return botPath;
					},
					{ timeout: 30_000 },
				)
				.not.toBe("");
			await b.locator("[data-sidebar-bot-row]").first().click();
			let botTab = "";
			await expect
				.poll(
					async () => {
						const tab = (await b.evaluate(() => window.omp.tabs.list())).find(
							entry => entry.sessionPath === botPath,
						);
						botTab = tab?.tabId ?? "";
						sessions.bot = { path: botPath, cwd: tab?.cwd ?? "" };
						return tab?.status;
					},
					{ timeout: 60_000 },
				)
				.toBe("ready");
			const callBot = await controlToolCaller(b, hostProfile.record, botTab);
			expect((await callBot("ompdesk_bot", { action: "duty_add", text: "Check the nightly build" })).isError).toBe(
				false,
			);
			const decision = await callBot("ompdesk_bot", {
				action: "decide",
				question: "Ship the release today?",
				options: ["Ship it", "Wait"],
			});
			expect(decision.isError, decision.text).toBe(false);
			// B's board started reading its activity log when the bot row opened, before these entries, and reads it
			// again only every BOT_ACTIVITY_POLL_MS (5 s); a view opened later reads it at once. Wait for B's own read,
			// so each view shows the same log, however long the setup below takes.
			const newest = await b.evaluate(
				async () =>
					(await window.omp.sessions.botDesk.activity()).entries.findLast(entry => entry.kind !== "read")?.id ??
					"",
			);
			expect(newest, "the bot's seeding logged activity").not.toBe("");
			await expect(b.locator(`[data-bot-activity="${newest}"]`)).toHaveCount(1, { timeout: 15_000 });

			// B's phone page.
			await b.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
			await expect
				.poll(() => b.evaluate(async () => (await window.omp.mobileWeb.getState()).phase), { timeout: 60_000 })
				.toBe("ready");
			await expect.poll(() => serveSites(hostProfile.tailscale).length, { timeout: 30_000 }).toBeGreaterThan(0);
			const site = serveSites(hostProfile.tailscale).at(-1);
			if (!site) throw new Error("B's Mobile web published no serve handler");
			proxy = await ServeProxy.start(site, REMOTE_LOGIN);
			const phoneUrl = proxy.url;
			const phone = await (
				await browser.newContext({
					...devices["Pixel 7"],
					viewport: { width: PHONE.width, height: PHONE.height },
					deviceScaleFactor: PHONE.dpr,
					colorScheme: "light",
				})
			).newPage();
			for (const [name, page] of [
				["B", b],
				["A", a],
				["phone", phone],
			] as const)
				page.on("pageerror", error => pageErrors.push(`${name}: ${error.message}`));
			await phone.goto(`${phoneUrl}/`, { timeout: 60_000 });
			await phonePaired(phone);
			// B announces the new phone in a toast; the toasts are dismissed before each capture (openRow), so let it land.
			await expect
				.poll(() => b.locator('[data-toast-stack] button[aria-label="Close"]').count(), { timeout: 10_000 })
				.toBeGreaterThan(0)
				.catch(() => undefined);

			const pages: Record<View, Page> = { local: b, remote: a, phone };
			/**
			 * Close what the surface before left open and every toast (a capture is of the surface, not of what the setup
			 * announced), open `row`'s session there, and wait until it is the one shown.
			 */
			const openRow = async (page: Page, row: Locator, sessionPath: string) => {
				await page.keyboard.press("Escape");
				const close = page.locator('[data-toast-stack] button[aria-label="Close"]');
				// One click each: a dismissed toast stays in the DOM, not clickable, while it animates out.
				for (const button of await close.all()) await button.click({ timeout: 5_000 }).catch(() => undefined);
				await expect(close).toHaveCount(0, { timeout: 10_000 });
				await expect(row).toHaveCount(1, { timeout: 30_000 });
				await row.locator("button").first().click();
				await expect
					.poll(
						async () => (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.sessionPath,
						{ timeout: 30_000 },
					)
					.toBe(sessionPath);
			};
			const phoneTabs = new Map<ParitySession, string>();
			/** Put `view` on B's `session`, with nothing left open from the surface before. */
			const show: Record<View, (session: ParitySession) => Promise<void>> = {
				local: session =>
					openRow(
						b,
						session === "bot"
							? b.locator("[data-sidebar-bot-row]")
							: b.locator(`.omp-sidebar-session-row[data-session-path=${cssString(sessions.work.path)}]`),
						sessions[session].path,
					),
				remote: session =>
					openRow(
						a,
						a.locator(
							`[data-sidebar-device="${deviceId}"] [data-device-session=${cssString(sessions[session].path)}]`,
						),
						sessions[session].path,
					),
				phone: async session => {
					// A fresh load: nothing a surface before opened survives it.
					await phone.goto(`${phoneUrl}/`, { timeout: 60_000 });
					await phonePaired(phone);
					let tabId = phoneTabs.get(session);
					if (!tabId) {
						const { path: sessionPath, cwd } = sessions[session];
						const viewed = await phone.evaluate(
							spawn => window.omp.tabs.spawn(spawn),
							session === "bot" ? { cwd, kind: "chat" as const, sessionPath } : { cwd, sessionPath },
						);
						tabId = viewed?.tabId ?? undefined;
						if (!tabId) throw new Error(`the phone could not view ${session}: ${JSON.stringify(viewed)}`);
						phoneTabs.set(session, tabId);
					}
					await phone.goto(`${phoneUrl}/#/open?tab=${tabId}`);
				},
			};

			/**
			 * What a `remoteChild` surface shows, set up once before the first: B pairs with A too, B's bot opens a session
			 * on A and leaves a turn running there, then starts a new conversation and its tab closes, so only the ended
			 * conversation's file names the child's opener (as after a relaunch). A runs a session of its own, so B's
			 * section of A folds to a count.
			 */
			let remoteChildLeft = false;
			const leaveRemoteChild = async () => {
				remoteChildLeft = true;
				await connectHost(a, b, "PC-A");
				await expect
					.poll(
						async () =>
							(await b.evaluate(() => window.omp.remote.getState())).hosts.find(host => host.name === "PC-A")
								?.state,
						{ timeout: 30_000 },
					)
					.toBe("online");
				const open = await callBot("ompdesk_session_open", {
					device: "PC-A",
					message: "Title: Run the Windows suites\nRun them on the other computer",
					show: "background",
				});
				expect(open.isError, open.text).toBe(false);
				const [child] = openedSessions(open.text);
				if (!child) throw new Error(`the bot opened nothing on PC-A: ${open.text}`);
				await untilAnswered(b, child);
				// The fake holds "fixture running" open until `fixture:finish`.
				await b.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture running" }),
					child,
				);
				// Its tab closes first, so the tab layout keeps the ended conversation's file as the child's opener (a tab
				// still open would move it to the new conversation's), then the conversation renews.
				expect(await b.evaluate(id => window.omp.tabs.close(id), botTab)).toBe(true);
				await b.evaluate(() => window.omp.sessions.botDesk.edit({ op: "new_conversation" }));
				await expect
					.poll(
						async () => {
							const value = await b.evaluate(() => window.omp.prefs.get("bot"));
							return typeof value === "string" ? value : "";
						},
						{ timeout: 60_000 },
					)
					.not.toBe(botPath);
				// A's own session (its start tab may be gone: it showed B's sessions), whose turn B's section of A counts.
				const own =
					(await a.evaluate(project => window.omp.tabs.spawn({ cwd: project }), clientProfile.project))?.tabId ??
					"";
				await expect
					.poll(
						async () => (await a.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === own)?.status,
						{
							timeout: 60_000,
						},
					)
					.toBe("ready");
				await a.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture running" }),
					own,
				);
			};

			const records: SurfaceRecord[] = [];
			for (const surface of surfaces) {
				if (surface.parity.remoteChild && !remoteChildLeft) await leaveRemoteChild();
				const record: SurfaceRecord = {
					id: surface.id,
					title: surface.title,
					session: surface.parity.session,
					shots: {},
					failures: [],
				};
				records.push(record);
				await test.step(surface.id, async () => {
					const folder = path.join(out, surface.id);
					await fs.mkdir(folder, { recursive: true });
					for (const view of VIEWS) {
						const page = pages[view];
						try {
							await show[view](surface.parity.session);
							await page.locator("[data-composer-input]").first().waitFor({ state: "visible", timeout: 60_000 });
							await surface.open(page, VIEW_LOOK[view]);
							if (surface.ready)
								await page.locator(surface.ready).first().waitFor({ state: "visible", timeout: 15_000 });
							await page.waitForTimeout(surface.settle ?? 450);
							if (await crashed(page)) throw new Error("the renderer crashed (Reload interface)");
							const panel = await panelCrash(page);
							if (panel !== null) throw new Error(`a panel crashed: ${panel.slice(0, 300)}`);
							const file = path.join(folder, `${view}.png`);
							await page.screenshot({ path: file, scale: "css", animations: "disabled" });
							record.shots[view] = file;
						} catch (error) {
							// Playwright's first line says what timed out, its call log's "waiting for" line on what.
							const lines = error instanceof Error ? error.message.split("\n") : [String(error)];
							const on = lines.find(line => line.includes("waiting for"))?.trim();
							record.failures.push(`${view}: ${lines[0]}${on ? ` (${on})` : ""}`);
						}
					}
					const { local, remote, phone: phoneShot } = record.shots;
					if (record.failures.length === 0 && local && remote && phoneShot) {
						record.sheet = path.join(folder, "sheet.png");
						await writeSheet(browser, surface, { local, remote, phone: phoneShot }, record.sheet);
					}
				});
			}
			await fs.writeFile(
				path.join(out, "parity.json"),
				`${JSON.stringify({ surfaces: records, pageErrors }, null, "\t")}\n`,
			);
			const failed = records.flatMap(record => record.failures.map(failure => `${record.id} › ${failure}`));
			expect(failed, "every surface reached in every view").toEqual([]);
		} finally {
			await browser.close().catch(() => undefined);
			await proxy?.close().catch(() => undefined);
			for (const instance of [client, host]) if (instance) await exitApp(instance.app);
			await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
		}
	});
}
