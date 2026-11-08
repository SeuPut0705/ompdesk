/**
 * The owner's phone, 8 Nov 2026: "모바일 저장된 캐시를 계속 가지고있어서 누르기 전까지 갱신되지않음". A phone page
 * served by one computer (M, a device) shows the section of the computer it is paired with (S, the host). M has just
 * relaunched for an update, onto a new build, with its saved layout: its tabs on S's sessions are back asleep. The
 * phone's page was loaded from M's old build, and that build's service worker controls it.
 *
 * Without a tap anywhere, each change S's sessions go through must reach the row within a few seconds on S's own
 * window, on M's window (S's section) and on the phone (S's section in the drawer): a turn starts and ends, subagents
 * start and finish, the omp retitles the session, a new message moves its last activity. Cases: a session M holds as
 * an asleep tab, one no tab of M holds, one S runs for M's live tab; then the phone hidden with its link down while
 * things change, then the phone reloaded (it paints its snapshot first). Through the resume and the reload the page
 * must end up on M's new build, the one the host serves, with no tap.
 *
 * `OMP_GUI_PHONE_HOST_ROWS_FROM=<out/ of an older release>` starts M on that release instead, so the phone's page
 * runs that release's code when M updates to this run's build (the owner's phone, if it kept v0.118's page against
 * v0.119's host). Without it, M updates from this run's build to a copy with another build id (`makeBuildB`).
 *
 * A failed check is recorded and the run goes on, so one run prints every failing cell (`phone-host-rows.txt`).
 * `OMP_GUI_PHONE_HOST_ROWS=<dir>` writes captures of the three surfaces at each step.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, devices, _electron as electron, expect, type Page, test } from "@playwright/test";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { captureTo, cssString, exitApp } from "./harness";
import {
	connectHost,
	launchRemote,
	makeRemoteProfile,
	openHostFolder,
	REMOTE_LOGIN,
	type RemoteInstance,
	type RemoteProfile,
} from "./remote-harness";

const CAPTURES = process.env.OMP_GUI_PHONE_HOST_ROWS;
/** "Within a few seconds": what a person waits before calling a row stale. */
const SETTLE = 8_000;
/** The build the run pins (playwright.config.ts). */
const BUILD_A = path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out");
const FROM = process.env.OMP_GUI_PHONE_HOST_ROWS_FROM;

const ENTRY = /<script type="module" crossorigin src="\.\/assets\/(web-[^"]+\.js)"/;

/** A build's page entry chunk and its worker's build id. */
async function buildOf(out: string): Promise<{ entry: string; id: string }> {
	const html = await fs.readFile(path.join(out, "renderer", "web.html"), "utf8");
	const worker = await fs.readFile(path.join(out, "renderer", "sw.js"), "utf8");
	const entry = ENTRY.exec(html)?.[1];
	const ids = new Set([...worker.matchAll(/"([0-9a-f]{12})"/g)].map(match => match[1] as string));
	if (!entry || ids.size !== 1) throw new Error(`${out}: no entry chunk or not one build id`);
	return { entry, id: [...ids][0] as string };
}

/**
 * The next build, as an update brings one: the app of build A with another entry chunk name, page and worker build
 * id, so a page that runs it says so (`pageBuild`) and its worker is a new one.
 */
async function makeBuildB(): Promise<string> {
	const out = await fs.mkdtemp(path.join(path.dirname(BUILD_A), "out-e2e-rows-"));
	await fs.cp(BUILD_A, out, { recursive: true });
	const renderer = path.join(out, "renderer");
	const htmlPath = path.join(renderer, "web.html");
	const workerPath = path.join(renderer, "sw.js");
	const a = await buildOf(BUILD_A);
	const entry = a.entry.replace(/\.js$/, "-b.js");
	const id = `${a.id.slice(0, 11)}${a.id.endsWith("b") ? "c" : "b"}`;
	await fs.copyFile(path.join(renderer, "assets", a.entry), path.join(renderer, "assets", entry));
	const html = await fs.readFile(htmlPath, "utf8");
	const worker = await fs.readFile(workerPath, "utf8");
	await fs.writeFile(htmlPath, html.replaceAll(a.entry, entry).replaceAll(a.id, id));
	await fs.writeFile(workerPath, worker.replaceAll(a.entry, entry).replaceAll(`"${a.id}"`, `"${id}"`));
	return out;
}

/** The entry chunk the page runs: the build it actually loaded, whatever the host serves now. */
const pageBuild = (page: Page) =>
	page
		.evaluate(
			() =>
				document
					.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/web-"]')
					?.getAttribute("src")
					?.split("/")
					.at(-1) ?? "",
		)
		.catch(() => "");

/** The page's service workers, for a build cell's detail: which build a reload would load, and what waits. */
const workerState = (page: Page) =>
	page
		.evaluate(async () => {
			const registration = await navigator.serviceWorker?.getRegistration();
			return `controller=${navigator.serviceWorker?.controller?.state ?? "none"} waiting=${registration?.waiting?.state ?? "none"} installing=${registration?.installing?.state ?? "none"}`;
		})
		.catch(() => "no read");

/** Launch on `out` (a build other than the run's); with `project`, open it and wait for the tab, as a first launch. */
async function launchOn(out: string, profile: RemoteProfile, project?: string): Promise<RemoteInstance> {
	const app = await electron.launch({
		args: [path.join(out, "main/index.js"), ...(project ? [project] : []), `--user-data-dir=${profile.desktop}`],
		env: profile.env,
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.remote != null);
	if (project)
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
	return { app, page, profile, errors };
}

type Command = { type: "prompt"; message: string } | { type: "bash"; command: string };

const tabsOf = (page: Page) => page.evaluate(() => window.omp.tabs.list());

async function runCommand(page: Page, tabId: string, command: Command): Promise<void> {
	const response = await page.evaluate(([id, body]) => window.omp.rpc.commandForTab(id, body), [
		tabId,
		command,
	] as const);
	expect(response.success, JSON.stringify(response)).toBe(true);
}

/** What a row says, read from the page. */
interface RowView {
	present: boolean;
	/** The title's `data-working` light ("turn", "background", "waiting"); "" without one. */
	working: string;
	/** The family chip's running count; 0 without a chip. */
	running: number;
	/** The age slot's `datetime`: the session's last activity as the row shows it. */
	age: string;
	text: string;
}

interface Outcome {
	step: string;
	surface: string;
	what: string;
	ok: boolean;
	detail: string;
}

interface Session {
	/** The page whose tab drives it, and that tab. */
	page: Page;
	tabId: string;
	title: string;
	path: string;
}

test("a paired host's rows on the phone and the serving computer follow the host with no tap, after the serving computer's update", async () => {
	test.setTimeout(1_500_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-phone-host-rows-")));
	let host: RemoteInstance | undefined;
	let device: RemoteInstance | undefined;
	let proxy: ServeProxy | undefined;
	let madeB: string | undefined;
	const browser = await chromium.launch();
	const outcomes: Outcome[] = [];
	try {
		if (!FROM) madeB = await makeBuildB();
		/** The build M updates to: the one the host then serves, which the phone's page must end up on. */
		const target = await buildOf(madeB ?? BUILD_A);
		const hostProfile = await makeRemoteProfile(parent, "s", { language: "en", theme: "light" });
		const deviceProfile = await makeRemoteProfile(parent, "m", {
			language: "en",
			theme: "light",
			port: hostProfile.port,
		});
		host = await launchRemote(hostProfile);
		device = FROM ? await launchOn(FROM, deviceProfile, deviceProfile.project) : await launchRemote(deviceProfile);
		const s = host.page;
		await device.page.evaluate(() => window.omp.remote.setDeviceName("Mac-M"));
		const deviceId = await connectHost(s, device.page, "PC-S");
		const linkState = async () => (await device?.page.evaluate(() => window.omp.remote.getState()))?.hosts[0]?.state;
		await expect.poll(linkState, { timeout: 30_000 }).toBe("online");

		/** A named session with a file: one answered turn in `tabId`. */
		const seed = async (page: Page, tabId: string, title: string): Promise<Session> => {
			await expect
				.poll(async () => (await tabsOf(page)).find(tab => tab.tabId === tabId)?.status, { timeout: 60_000 })
				.toBe("ready");
			await runCommand(page, tabId, { type: "bash", command: `fixture:title:${title}` });
			await runCommand(page, tabId, { type: "prompt", message: "hello" });
			let sessionPath = "";
			await expect
				.poll(
					async () => {
						const tab = (await tabsOf(page)).find(entry => entry.tabId === tabId);
						sessionPath = tab?.lastRun?.reply === "Local fixture reply" ? (tab.sessionPath ?? "") : "";
						return sessionPath;
					},
					{ timeout: 30_000 },
				)
				.not.toBe("");
			return { page, tabId, title, path: sessionPath };
		};

		// S's window runs two sessions: "held" (M will hold it as an asleep tab) and "free" (no tab of M's holds it).
		const frontTab = (await tabsOf(s)).find(tab => tab.active)?.tabId ?? "";
		const held = await seed(s, frontTab, "Rows held asleep on M");
		await s.keyboard.press("ControlOrMeta+t");
		await expect.poll(async () => (await tabsOf(s)).length).toBe(2);
		const freeTab = (await tabsOf(s)).find(tab => tab.tabId !== frontTab)?.tabId ?? "";
		const free = await seed(s, freeTab, "Rows no tab on M");

		const section = (scope: string) => `${scope} [data-sidebar-device=${cssString(deviceId)}]`;
		/** Open S's section and its folded groups by script: a script click is no touch, so no update waits on it. */
		const unfold = (page: Page, scope: string) =>
			page.evaluate(selector => {
				const root = document.querySelector(selector);
				const toggle = root?.querySelector<HTMLElement>("[data-sidebar-device-toggle]");
				if (toggle?.getAttribute("aria-expanded") === "false") toggle.click();
				for (const button of root?.querySelectorAll<HTMLElement>(
					'button[data-roving-item^="device-group:"][aria-expanded="false"]',
				) ?? [])
					button.click();
			}, section(scope));

		// M opens "held" from S's section: its tab views the tab S's window runs.
		await unfold(device.page, "");
		const heldRow = device.page.locator(`${section("")} [data-device-session=${cssString(held.path)}]`);
		await expect(heldRow).toBeVisible({ timeout: 30_000 });
		await heldRow.click();
		await expect
			.poll(
				async () =>
					(await tabsOf(device?.page as Page)).find(
						tab => tab.device === deviceId && tab.sessionPath === held.path,
					)?.status,
				{ timeout: 60_000 },
			)
			.toBe("ready");

		// M serves the phone.
		await device.page.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
		await expect
			.poll(
				() =>
					device?.page.evaluate(async () => (await window.omp.mobileWeb.getState()).phase).catch(() => "starting"),
				{ timeout: 60_000 },
			)
			.toBe("ready");
		// A session of M's own in front: the relaunch starts the front tab and leaves "held" asleep.
		const known = new Set((await tabsOf(device.page)).map(tab => tab.tabId));
		await device.page.keyboard.press("ControlOrMeta+t");
		let frontOfM = "";
		await expect
			.poll(async () => {
				frontOfM = (await tabsOf(device?.page as Page)).find(tab => !known.has(tab.tabId))?.tabId ?? "";
				return frontOfM;
			})
			.not.toBe("");
		await seed(device.page, frontOfM, "M's own session");
		await expect.poll(() => serveSites(deviceProfile.tailscale).length, { timeout: 30_000 }).toBeGreaterThan(0);
		const firstSite = serveSites(deviceProfile.tailscale).at(-1);
		if (!firstSite) throw new Error("M's Mobile web published no serve handler");
		proxy = await ServeProxy.start(firstSite, REMOTE_LOGIN);
		const phoneContext = await browser.newContext({ ...devices["Pixel 8"] });
		const phone = await phoneContext.newPage();
		await phone.goto(`${proxy.url}/`, { timeout: 60_000 });
		await phonePaired(phone);
		// Build A's worker controls the page before the update.
		await expect
			.poll(() => phone.evaluate(() => navigator.serviceWorker?.controller?.state ?? "none"), { timeout: 60_000 })
			.toBe("activated");
		const buildA = await pageBuild(phone);
		expect(buildA).not.toBe("");
		expect(buildA).not.toBe(target.entry);
		// The person used the page: the launch moment is over (sw-update.ts ResumeGate).
		await phone.locator("body").dispatchEvent("pointerdown");

		const drawer = "[data-drawer] .omp-session-sidebar";
		const openDrawer = async () => {
			if (
				await phone
					.locator(drawer)
					.isVisible()
					.catch(() => false)
			)
				return;
			await phone.locator("header button:has(svg.lucide-menu)").evaluate(button => (button as HTMLElement).click());
			await expect(phone.locator(drawer)).toBeVisible({ timeout: 30_000 });
		};
		await openDrawer();
		await unfold(phone, drawer);
		await expect(phone.locator(`${section(drawer)} [data-device-session=${cssString(held.path)}]`)).toBeVisible({
			timeout: 60_000,
		});

		// M updates: it quits and starts on the target build with its saved layout. Its tab on "held" comes back asleep.
		await exitApp(device.app);
		device = await launchOn(madeB ?? BUILD_A, deviceProfile);
		const m = device.page;
		await expect.poll(linkState, { timeout: 60_000 }).toBe("online");
		await expect
			.poll(async () => (await tabsOf(m)).find(tab => tab.sessionPath === held.path)?.status, { timeout: 60_000 })
			.toBe("asleep");
		await expect
			.poll(() => m.evaluate(async () => (await window.omp.mobileWeb.getState()).phase).catch(() => "starting"), {
				timeout: 60_000,
			})
			.toBe("ready");
		const site = serveSites(deviceProfile.tailscale).at(-1);
		if (site) proxy.retarget(site);
		// The page reconnects to M on its own, as a phone does after its host restarted.
		await phonePaired(phone);

		// After the relaunch M opens a new tab on S: S runs it for M ("a session another device's tab holds").
		await m.locator(`[data-sidebar-device=${cssString(deviceId)}]`).waitFor({ timeout: 30_000 });
		const forM = await seed(m, await openHostFolder(m, deviceId, hostProfile.project), "Rows S runs for M");

		const record = (step: string, surface: string, what: string, ok: boolean, detail = "") =>
			outcomes.push({ step, surface, what, ok, detail });

		interface Surface {
			name: "S" | "M" | "phone";
			page: Page;
			row: (session: Session) => string;
			prepare: () => Promise<void>;
		}
		const surfaces: Surface[] = [
			{
				name: "S",
				page: s,
				row: session => `.omp-session-sidebar [data-session-path=${cssString(session.path)}]`,
				prepare: () =>
					s.evaluate(() => {
						for (const button of document.querySelectorAll<HTMLElement>(
							'.omp-session-sidebar button:has([data-sidebar-workspace-icon])[aria-expanded="false"]',
						))
							button.click();
					}),
			},
			{
				name: "M",
				page: m,
				row: session => `${section("")} [data-device-session=${cssString(session.path)}]`,
				prepare: () => unfold(m, ""),
			},
			{
				name: "phone",
				page: phone,
				row: session => `${section(drawer)} [data-device-session=${cssString(session.path)}]`,
				prepare: async () => {
					await openDrawer();
					await unfold(phone, drawer);
				},
			},
		];
		const surfaceOf = (name: Surface["name"]) => surfaces.find(surface => surface.name === name) as Surface;

		const observe = async (surface: Surface, session: Session): Promise<RowView> => {
			await surface.prepare();
			return surface.page.evaluate(selector => {
				const row = [...document.querySelectorAll(selector)].find(
					element => !element.hasAttribute("data-sidebar-opened-session"),
				);
				if (!row) return { present: false, working: "", running: 0, age: "", text: "" };
				const pill = row.querySelector("[data-family-running]");
				return {
					present: true,
					working: row.querySelector(".omp-live-text[data-working]")?.getAttribute("data-working") ?? "",
					running: pill ? Number(pill.getAttribute("data-family-running")) : 0,
					age: row.querySelector("time[datetime]")?.getAttribute("datetime") ?? "",
					text: row.textContent ?? "",
				};
			}, surface.row(session));
		};

		const expectRow = async (
			step: string,
			what: string,
			session: Session,
			want: (view: RowView) => boolean,
			on: readonly Surface[] = surfaces,
		) => {
			await Promise.all(
				on.map(async surface => {
					let last: RowView | undefined;
					const ok = await expect
						.poll(
							async () => {
								last = await observe(surface, session).catch(() => undefined);
								return last !== undefined && want(last);
							},
							{ timeout: SETTLE },
						)
						.toBe(true)
						.then(
							() => true,
							() => false,
						);
					const shown = last
						? `working=${last.working || "-"} running=${last.running} age=${last.age || "-"} title="${last.text.slice(0, 60)}"`
						: "no read";
					record(step, surface.name, what, ok, ok ? "" : `got ${shown}`);
				}),
			);
		};

		const captureAll = async (tag: string) => {
			for (const surface of surfaces) {
				await surface.prepare().catch(() => undefined);
				await captureTo(CAPTURES, surface.page, `${tag}-${surface.name}`);
			}
		};

		const tabOf = async (session: Session) => (await tabsOf(session.page)).find(tab => tab.tabId === session.tabId);
		const shell = (session: Session, line: string) =>
			runCommand(session.page, session.tabId, { type: "bash", command: line });

		/** Every change of step 1, on one session, checked on every surface. */
		const lifecycle = async (step: string, session: Session) => {
			const before = await observe(surfaceOf("S"), session);
			await runCommand(session.page, session.tabId, { type: "prompt", message: "hello again" });
			await expect.poll(async () => (await tabOf(session))?.status, { timeout: 30_000 }).toBe("ready");
			await expectRow(step, "a new message moves its last activity", session, view => view.age > before.age);
			await runCommand(session.page, session.tabId, { type: "prompt", message: "fixture running" });
			await expectRow(step, "a turn starts", session, view => view.working === "turn");
			await shell(session, "fixture:subagents");
			await expectRow(step, "two subagents start", session, view => view.running === 2);
			await captureAll(`${step}-subagents`);
			await shell(session, "fixture:subagents:finish:sa-explore");
			await expectRow(step, "one subagent finishes", session, view => view.running === 1);
			await shell(session, "fixture:subagents:finish:sa-nested");
			await expectRow(step, "both subagents finish", session, view => view.running === 0);
			await shell(session, "fixture:finish");
			await expectRow(step, "the turn ends", session, view => view.working === "" && view.running === 0);
			session.title = `${session.title} (retitled)`;
			await shell(session, `fixture:title:${session.title}`);
			await expectRow(step, "the omp retitles it", session, view => view.text.includes(session.title));
			await captureAll(`${step}-settled`);
		};

		for (const session of [held, free, forM])
			await expectRow("0", `listed: ${session.title}`, session, view => view.present);

		await test.step("1. a session M holds as an asleep tab", () => lifecycle("1", held));
		await test.step("2. a session no tab of M holds", () => lifecycle("2", free));
		await test.step("3. a session S runs for M's live tab", () => lifecycle("3", forM));
		record("3", "phone", `the page still runs build A while in use (${await pageBuild(phone)})`, true);

		const presence = (state: "hidden" | "visible") =>
			phone.evaluate(next => {
				Object.defineProperty(document, "visibilityState", { value: next, configurable: true });
				Object.defineProperty(document, "hidden", { value: next === "hidden", configurable: true });
				document.dispatchEvent(new Event("visibilitychange"));
			}, state);

		await test.step("4. the phone locked with its link down while things change, then back", async () => {
			await presence("hidden");
			const outage = proxy?.outage("refuse");
			await runCommand(held.page, held.tabId, { type: "prompt", message: "fixture running" });
			await shell(held, "fixture:subagents");
			held.title = "Rows held, renamed while the phone slept";
			await shell(held, `fixture:title:${held.title}`);
			await expectRow("4", "M and S see it while the phone sleeps", held, view => view.running === 2, [
				surfaceOf("S"),
				surfaceOf("M"),
			]);
			// A phone left in a pocket: past the 30 s that make its return a moment an update may land in.
			await phone.waitForTimeout(31_000);
			outage?.restore();
			await presence("visible");
			// The person touches the screen at once, as anyone opening the drawer does.
			await phone.mouse.click(200, 400).catch(() => undefined);
			const landed = await expect
				.poll(() => pageBuild(phone), { timeout: 20_000 })
				.toBe(target.entry)
				.then(
					() => true,
					() => false,
				);
			record(
				"4",
				"phone",
				"after the resume the page runs the host's build",
				landed,
				`runs ${await pageBuild(phone)}, ${await workerState(phone)}`,
			);
			await phonePaired(phone).catch(() => undefined);
			await expectRow(
				"4",
				"after the resume, with no tap on the row",
				held,
				view => view.working === "turn" && view.running === 2 && view.text.includes(held.title),
				[surfaceOf("phone")],
			);
			await captureAll("4-resumed");
			await shell(held, "fixture:subagents:finish:sa-explore");
			await expectRow("4", "and keeps following", held, view => view.running === 1);
		});

		await test.step("5. the phone reloads: the snapshot paints first, the live read replaces it", async () => {
			await phone.reload({ timeout: 60_000 });
			await shell(held, "fixture:subagents:finish:sa-nested");
			await shell(held, "fixture:finish");
			await phonePaired(phone);
			const landed = await expect
				.poll(() => pageBuild(phone), { timeout: 30_000 })
				.toBe(target.entry)
				.then(
					() => true,
					() => false,
				);
			record(
				"5",
				"phone",
				"after the reload the page runs the host's build",
				landed,
				`runs ${await pageBuild(phone)}, ${await workerState(phone)}`,
			);
			await phonePaired(phone).catch(() => undefined);
			await expectRow("5", "after the reload", held, view => view.working === "" && view.running === 0, [
				surfaceOf("phone"),
			]);
			free.title = `${free.title} again`;
			await shell(free, `fixture:title:${free.title}`);
			await expectRow("5", "a change after the reload", free, view => view.text.includes(free.title));
			await captureAll("5-reloaded");
			// M's runtime log says which build each of the page's reloads landed on (how a real phone is checked).
			const reloads = (await fs.readFile(path.join(deviceProfile.desktop, "logs", "gui-runtime.jsonl"), "utf8"))
				.split("\n")
				.flatMap(line => {
					try {
						const entry = JSON.parse(line) as { source?: string; details?: { build?: unknown } };
						return entry.source === "web-reload" ? [entry.details?.build ?? null] : [];
					} catch {
						return [];
					}
				});
			record(
				"5",
				"phone",
				"M's web-reload line names the build the page landed on",
				reloads.includes(target.id),
				`builds on web-reload lines: ${JSON.stringify(reloads)}`,
			);
		});

		const lines = outcomes.map(
			outcome =>
				`${outcome.ok ? "PASS" : "FAIL"} ${outcome.step} ${outcome.surface}: ${outcome.what}${outcome.detail ? ` (${outcome.detail})` : ""}`,
		);
		const table = lines.join("\n");
		console.log(`\n${table}\n`);
		await test.info().attach("phone-host-rows.txt", { body: table, contentType: "text/plain" });
		if (CAPTURES) {
			await fs.mkdir(CAPTURES, { recursive: true });
			await fs.writeFile(path.join(CAPTURES, "phone-host-rows.txt"), `${table}\n`);
		}
		expect(
			outcomes
				.filter(outcome => !outcome.ok)
				.map(outcome => `${outcome.step} ${outcome.surface}: ${outcome.what} ${outcome.detail}`),
			"failing cells",
		).toEqual([]);
		await phoneContext.close();
	} finally {
		await proxy?.close();
		await browser.close();
		for (const instance of [device, host]) if (instance) await exitApp(instance.app);
		if (madeB) await fs.rm(madeB, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
