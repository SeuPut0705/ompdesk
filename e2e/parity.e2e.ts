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
 * OMP_GUI_PARITY_ORDERS=both is the order check instead (`bun run parity -- --both-orders`): two tests side by side,
 * every surface into `<dir>/forward` and every surface in reverse order into `<dir>/reverse`.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Browser, chromium, devices, expect, type Locator, type Page, test } from "@playwright/test";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { controlToolCaller, cssString, exitApp, openedSessions, untilAnswered } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, REMOTE_LOGIN, type RemoteInstance } from "./remote-harness";
import { crashed, type Look, panelCrash } from "./responsive-audit";
import { type ParitySession, SURFACES, type Surface } from "./responsive-surfaces";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/**
 * B's project is a git checkout with uncommitted work, so the work session's Changes panel shows its source control
 * and a changed file list, and its Files view has a nested file to open (`panel-diff`, `panel-files-viewer`).
 */
async function seedProject(project: string): Promise<void> {
	const nested = path.join(project, "src/renderer/components/layout/sidebar");
	await fs.mkdir(nested, { recursive: true });
	await fs.writeFile(path.join(project, "README.md"), "# Project\n");
	await fs.writeFile(path.join(nested, "Sidebar.tsx"), "export const rows = 1;\n");
	git(project, "init", "-q", "-b", "main");
	git(project, "config", "user.email", "parity@example.com");
	git(project, "config", "user.name", "Parity");
	git(project, "config", "commit.gpgsign", "false");
	git(project, "add", ".");
	git(project, "commit", "-qm", "feat: seed the project");
	await fs.writeFile(path.join(nested, "Sidebar.tsx"), "export const rows = 2;\nexport const gap = 4;\n");
	await fs.writeFile(path.join(project, "wait-for.ts"), "export const waitFor = () => {};\n");
}

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

/** A surface the sheet can capture. */
type ParitySurface = Surface & { parity: NonNullable<Surface["parity"]> };

function paritySurfaces(): ParitySurface[] {
	const capable = SURFACES.filter(
		(surface): surface is ParitySurface => surface.parity !== undefined && surface.parity.available?.() !== false,
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
	// A capture launches its own two apps on its own profiles and ports, so the order check's two captures (every
	// surface, and every surface in reverse) run side by side as two tests, each in a worker of its own.
	test.describe.configure({ mode: "parallel", retries: 0 });

	const capture = async (surfaces: readonly ParitySurface[], out: string): Promise<void> => {
		test.setTimeout(300_000 + surfaces.length * 90_000);
		await fs.mkdir(out, { recursive: true });
		const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-parity-")));
		// The composer dictation surfaces script the fake omp's speech through this file (e2e/fixture/rpc-ui.ts `voiceScript`).
		process.env.OMP_GUI_TEST_VOICE_FILE = path.join(parent, "voice.json");
		// `session-slow-start` holds the fake omp's `get_state` through this file (e2e/fixture/rpc-ui.ts `startFile`).
		process.env.OMP_GUI_TEST_START_FILE = path.join(parent, "start.json");
		let host: RemoteInstance | undefined;
		let client: RemoteInstance | undefined;
		let proxy: ServeProxy | undefined;
		const browser = await chromium.launch();
		const pageErrors: string[] = [];
		try {
			const hostProfile = await makeRemoteProfile(parent, "host", {
				language: "en",
				theme: "light",
				// The usage row under a reply (`reply-usage`): on here, on the paired computer and through to the phone.
				prefs: { displayPreferences: { showTokenUsage: true } },
				// Only the host's omp starts under the hold: its slow-start bound is short, so the banner shows within seconds.
				env: { OMP_GUI_START_SLOW_MS: "1500" },
			});
			await seedProject(hostProfile.project);
			const clientProfile = await makeRemoteProfile(parent, "client", {
				language: "en",
				theme: "light",
				port: hostProfile.port,
				prefs: { displayPreferences: { showTokenUsage: true } },
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
			let work: HostSession = { path: "", cwd: "" };
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
						work = { path: tab?.sessionPath ?? "", cwd: tab?.cwd ?? "" };
						return work.path;
					},
					{ timeout: 30_000 },
				)
				.not.toBe("");

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
			// The phone's display switches are its own (device prefs), read when each view loads its page afresh.
			await phone.evaluate(() => window.omp.prefs.set("displayPreferences.showTokenUsage", true));
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
			/** B's sessions of answered turns, each made the first time a surface shows it, by title. */
			const answered = new Map<string, HostSession>();
			const answeredSession = async (title: string, turns: ReadonlyArray<readonly [string, string]>) => {
				const made = answered.get(title);
				if (made) return made;
				const tabId = (await b.evaluate(cwd => window.omp.tabs.spawn({ cwd }), work.cwd))?.tabId ?? "";
				if (!tabId) throw new Error(`B opened no tab for ${title}`);
				await expect
					.poll(
						async () => (await b.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === tabId)?.status,
						{ timeout: 60_000 },
					)
					.toBe("ready");
				await b.evaluate(([id, line]) => window.omp.rpc.commandForTab(id, { type: "bash", command: line }), [
					tabId,
					`fixture:title:${title}`,
				] as const);
				let sessionPath = "";
				for (const [message, answer] of turns) {
					await b.evaluate(([id, sent]) => window.omp.rpc.commandForTab(id, { type: "prompt", message: sent }), [
						tabId,
						message,
					] as const);
					await expect
						.poll(
							async () =>
								(sessionPath = await b.evaluate(
									async ([id, text]) => {
										const tab = (await window.omp.tabs.list()).find(entry => entry.tabId === id);
										if (tab?.status !== "ready") return "";
										const page = await window.omp.rpc.commandForTab(id, {
											type: "get_transcript_page",
											fromEnd: true,
											limit: 10,
										});
										return JSON.stringify(page.data ?? null).includes(text) ? (tab.sessionPath ?? "") : "";
									},
									[tabId, answer] as const,
								)),
							{ timeout: 30_000 },
						)
						.not.toBe("");
				}
				const session = { path: sessionPath, cwd: work.cwd };
				answered.set(title, session);
				return session;
			};
			// The pictures' turn, the media turn, every other way a reply presents something
			// (src/renderer/dev-harness/reply-showcase.ts), then a run whose reply speaks beside its tool call.
			const replySession = () =>
				answeredSession("Parity reply", [
					["fixture reply images", "Here is the changed look."],
					["fixture reply media", "The numbers:"],
					["fixture reply components", "Footnotes link both ways."],
					["fixture narrated", "Narrated run finished."],
					["fixture turn recovered", "The tests pass now."],
					["fixture turn unfixed", "One test still fails."],
					["fixture agent-desktop", "agent-desktop run finished."],
				]);
			// A session of its own: one more turn in the reply session put its first turns past what a phone's view
			// reaches in time (10 Nov 2026).
			const steerSession = () => answeredSession("Parity steer", [["fixture steered", "Steered run finished."]]);
			/** B's `session` as it is when a view shows it. */
			const hostSession = async (session: ParitySession): Promise<HostSession> =>
				session === "work" ? work : session === "reply" ? replySession() : steerSession();
			/** Put `view` on B's `session`, with nothing left open from the surface before. */
			const show: Record<View, (session: ParitySession) => Promise<void>> = {
				local: async session => {
					const { path: sessionPath } = await hostSession(session);
					await openRow(
						b,
						b.locator(`.omp-sidebar-session-row[data-session-path=${cssString(sessionPath)}]`),
						sessionPath,
					);
				},
				remote: async session => {
					const { path: sessionPath } = await hostSession(session);
					const section = a.locator(`[data-sidebar-device="${deviceId}"]`);
					await openRow(a, section.locator(`[data-device-session=${cssString(sessionPath)}]`), sessionPath);
				},
				phone: async session => {
					// A fresh load: nothing a surface before opened survives it.
					await phone.goto(`${phoneUrl}/`, { timeout: 60_000 });
					await phonePaired(phone);
					const { path: sessionPath, cwd } = await hostSession(session);
					// The phone's tab on that file, read from the phone each time and never kept from a surface before.
					let tabId = (await phone.evaluate(() => window.omp.tabs.list())).find(
						tab => tab.sessionPath === sessionPath,
					)?.tabId;
					if (!tabId) {
						const viewed = await phone.evaluate(spawn => window.omp.tabs.spawn(spawn), { cwd, sessionPath });
						tabId = viewed?.tabId ?? undefined;
						if (!tabId) throw new Error(`the phone could not view ${session}: ${JSON.stringify(viewed)}`);
					}
					await phone.goto(`${phoneUrl}/#/open?tab=${tabId}`);
				},
			};

			/** B's work session opens a child on A; A also runs a session of its own, so its folded section has a count. */
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
				const callWork = await controlToolCaller(b, hostProfile.record, start);
				const open = await callWork("ompdesk_session_open", {
					device: "PC-A",
					folder: clientProfile.project,
					message: "Title: Parity remote child\nRun the Windows suites on the other computer",
					show: "background",
				});
				expect(open.isError, open.text).toBe(false);
				const [child] = openedSessions(open.text);
				if (!child) throw new Error(`the work session opened nothing on PC-A: ${open.text}`);
				await untilAnswered(b, child);
				await b.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:title:Parity remote child" }),
					child,
				);
				await b.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture running" }),
					child,
				);
				await expect
					.poll(
						async () => (await b.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === child)?.status,
						{ timeout: 30_000 },
					)
					.toBe("running");
				const own =
					(await a.evaluate(project => window.omp.tabs.spawn({ cwd: project }), clientProfile.project))?.tabId ??
					"";
				if (!own) throw new Error("PC-A opened no session of its own");
				await expect
					.poll(
						async () => (await a.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === own)?.status,
						{ timeout: 60_000 },
					)
					.toBe("ready");
				await a.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture running" }),
					own,
				);
				await expect
					.poll(
						async () => (await a.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === own)?.status,
						{ timeout: 30_000 },
					)
					.toBe("running");
			};

			/**
			 * What a `hiddenRoster` surface shows, set up once before the first: B runs a second session, each view opens
			 * it (so holds a tab of it) and goes back to the work session, and only then a turn of it starts two subagents,
			 * so no view shows the session when they start. The phone's capture loads its page afresh: its tab list reads
			 * them.
			 */
			let hiddenRosterLeft = false;
			const leaveHiddenRoster = async () => {
				hiddenRosterLeft = true;
				const tabId = (await b.evaluate(cwd => window.omp.tabs.spawn({ cwd }), work.cwd))?.tabId ?? "";
				if (!tabId) throw new Error("B opened no tab for the roster session");
				const rosterTab = async () =>
					(await b.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === tabId);
				await expect.poll(async () => (await rosterTab())?.status, { timeout: 60_000 }).toBe("ready");
				await b.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:title:Parity roster" }),
					tabId,
				);
				// One answered turn gives it a file, so a row in every view.
				await b.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "hello" }), tabId);
				let sessionPath = "";
				await expect
					.poll(async () => (sessionPath = (await rosterTab())?.sessionPath ?? ""), { timeout: 30_000 })
					.not.toBe("");
				await openRow(
					a,
					a.locator(`[data-sidebar-device="${deviceId}"] [data-device-session=${cssString(sessionPath)}]`),
					sessionPath,
				);
				const viewed = await phone.evaluate(spawn => window.omp.tabs.spawn(spawn), { cwd: work.cwd, sessionPath });
				if (!viewed?.tabId)
					throw new Error(`the phone could not view the roster session: ${JSON.stringify(viewed)}`);
				for (const view of VIEWS) await show[view]("work");
				// The fake holds "fixture running" open until `fixture:finish`.
				await b.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture running" }),
					tabId,
				);
				await expect.poll(async () => (await rosterTab())?.status, { timeout: 30_000 }).toBe("running");
				await b.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:subagents" }),
					tabId,
				);
			};

			/**
			 * What a `crossProject` surface shows, set up once before the first: B's work session opens "Parity
			 * cross-project" in another folder of B's (`seuoffice`), and that session's turn stays running, so its row is
			 * under its opener (a finished child is no family row) and of its own project.
			 */
			let crossProjectLeft = false;
			const leaveCrossProject = async () => {
				crossProjectLeft = true;
				const folder = path.join(parent, "seuoffice");
				await fs.mkdir(folder, { recursive: true });
				const callWork = await controlToolCaller(b, hostProfile.record, start);
				const open = await callWork("ompdesk_session_open", {
					folder,
					message: "Title: Parity cross-project\nSet the office project up",
					show: "background",
				});
				expect(open.isError, open.text).toBe(false);
				const [child] = openedSessions(open.text);
				if (!child) throw new Error(`the work session opened nothing in ${folder}: ${open.text}`);
				await untilAnswered(b, child);
				await b.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:title:Parity cross-project" }),
					child,
				);
				// The fake holds "fixture running" open until `fixture:finish`.
				await b.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture running" }),
					child,
				);
			};

			/**
			 * What a `folderMissing` surface shows, set up once before the first: B's session "Parity folder gone" answered
			 * one turn in `moda-office`, its tab closed and the folder was deleted. It is made from B's phone page, which
			 * every view loads afresh, so no window of B keeps a tab of it (a desktop window's own tab closed through
			 * `tabs.close` rather than its tab strip stays in that window's list). A turn of the work session afterwards
			 * makes main look at the sessions' folders again (sidebar-projects.ts `schedule`).
			 */
			let folderMissingLeft = false;
			const leaveFolderMissing = async () => {
				folderMissingLeft = true;
				const folder = path.join(parent, "moda-office");
				await fs.mkdir(folder, { recursive: true });
				const tabId = (await phone.evaluate(cwd => window.omp.tabs.spawn({ cwd }), folder))?.tabId ?? "";
				if (!tabId) throw new Error("the phone opened no tab in the folder to delete");
				const goneTab = async () =>
					(await phone.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === tabId);
				await expect.poll(async () => (await goneTab())?.status, { timeout: 60_000 }).toBe("ready");
				await phone.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:title:Parity folder gone" }),
					tabId,
				);
				await phone.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "hello" }), tabId);
				await expect.poll(async () => (await goneTab())?.sessionPath ?? "", { timeout: 30_000 }).not.toBe("");
				await untilAnswered(phone, tabId);
				expect(await phone.evaluate(id => window.omp.tabs.close(id), tabId)).toBe(true);
				await fs.rm(folder, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
				await b.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "hello" }), start);
				await untilAnswered(b, start, { after: "hello" });
			};

			const records: SurfaceRecord[] = [];
			for (const surface of surfaces) {
				if (surface.parity.remoteChild && !remoteChildLeft) await leaveRemoteChild();
				if (surface.parity.hiddenRoster && !hiddenRosterLeft) await leaveHiddenRoster();
				if (surface.parity.crossProject && !crossProjectLeft) await leaveCrossProject();
				if (surface.parity.folderMissing && !folderMissingLeft) await leaveFolderMissing();
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
							// What the surface is about is on screen, so the capture shows it and the sideways check below
							// measures it (6 Nov 2026: two views of `reply-text` captured the transcript's end instead).
							const sample = surface.parity.inView;
							if (sample) {
								const shown = page.locator(sample).first();
								if ((await shown.count()) === 0) throw new Error(`${sample} is not mounted`);
								const where = await shown.evaluate(element => {
									const scroller = element.closest(".omp-transcript-scroll");
									if (!scroller) return "outside the transcript";
									const box = element.getBoundingClientRect();
									const view = scroller.getBoundingClientRect();
									return box.top >= view.top - 1 && box.bottom <= view.bottom + 1
										? null
										: `at ${Math.round(box.top - view.top)}..${Math.round(box.bottom - view.top)}px of a ${Math.round(view.height)}px transcript`;
								});
								if (where !== null) throw new Error(`${sample} is out of view: ${where}`);
							}
							const file = path.join(folder, `${view}.png`);
							await page.screenshot({ path: file, scale: "css", animations: "disabled" });
							record.shots[view] = file;
							// The transcript scrolls down only, in every view (a reply's picture chip spilled its path out of
							// a figure cell and gave it a horizontal scrollbar, 6 Nov 2026).
							const sideways = await page.evaluate(() =>
								[...document.querySelectorAll<HTMLElement>(".omp-transcript-scroll")]
									.filter(scroller => scroller.clientWidth > 0)
									.map(scroller => scroller.scrollWidth - scroller.clientWidth),
							);
							const extra = Math.max(0, ...sideways);
							if (extra > 1) throw new Error(`the transcript scrolls sideways by ${extra}px`);
						} catch (error) {
							// Playwright's first line says what timed out, its call log's "waiting for" line on what.
							const lines = error instanceof Error ? error.message.split("\n") : [String(error)];
							const on = lines.find(line => line.includes("waiting for"))?.trim();
							// What the view showed instead, so the failure is read from its picture and not from a second run.
							const shown = path.join(folder, `${view}-failed.png`);
							const pictured = await page
								.screenshot({ path: shown, scale: "css", animations: "disabled" })
								.then(() => true)
								.catch(() => false);
							record.failures.push(
								`${view}: ${lines[0]}${on ? ` (${on})` : ""}${pictured ? `; what it showed: ${shown}` : ""}`,
							);
						}
						try {
							await surface.parity.after?.(page);
						} catch (error) {
							const first = error instanceof Error ? error.message.split("\n")[0] : String(error);
							record.failures.push(`${view}: putting back what the surface changed: ${first}`);
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
	};

	const sheet = "local window, paired computer's view and phone of the same session";
	if (process.env.OMP_GUI_PARITY_ORDERS === "both") {
		const all = paritySurfaces();
		test(`parity sheet, forward: ${sheet}`, () => capture(all, path.resolve(dir, "forward")));
		test(`parity sheet, reverse: ${sheet}`, () => capture([...all].reverse(), path.resolve(dir, "reverse")));
	} else test(`parity sheet: ${sheet}`, () => capture(paritySurfaces(), path.resolve(dir)));
}
