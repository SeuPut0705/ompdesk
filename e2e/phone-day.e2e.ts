/**
 * Opt-in audit of a day on the phone (OMP_GUI_PHONE_DAY=<dir> writes `<dir>/report.json`, `<dir>/summary.md` and
 * `<dir>/shots/`; the default run skips it). The built app's real web server sits behind the fake `tailscale serve`
 * (e2e/fixture/phone-serve.ts) and the fake omp; a phone page in WebKit (iPhone 15), Chromium (Pixel 8) and an iPad
 * (portrait and landscape) runs one person's day through the page, tapping as a person does:
 *
 * start the installed app (standalone, warm from the service worker), a notification click opening its tab, a long
 * transcript read upward then "Jump to latest", an ask answered, a tool approved, a steer sent while a turn runs,
 * the Autopilot start sheet, Changes / Files / Terminal, a session renamed and deleted from the drawer, the page
 * sent to the background mid-reply and back, a dropped socket, a rotation, and the soft keyboard with a Korean IME
 * composition.
 *
 * Every step records its taps, wall time, layout shift (Chromium's layout-shift entries; the composer box and the
 * transcript's top visible row on both engines), the responsive audit's issues on what the step left on screen
 * (e2e/responsive-audit.ts `measure`: hit areas, overflow, clipped text, safe areas) and what it checked. Nothing here
 * asserts: a friction found is fixed with its own unit or e2e test. OMP_GUI_PHONE_DAY_DEVICES narrows the devices
 * (`iphone,pixel,ipad-portrait,ipad-landscape`); OMP_GUI_PHONE_DAY_LOOKS=1 adds en/ko × light/dark captures of the
 * main screens on the phones.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type Browser,
	type BrowserContext,
	chromium,
	devices,
	expect,
	type Locator,
	type Page,
	test,
	webkit,
} from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { fixtureTailscale } from "./fixture/fake-tailscale-install";
import { ServeProxy, serveSites } from "./fixture/phone-serve";
import { exitApp, fixtureOmp } from "./harness";
import { type Issue, type Look, measure, safeInsets } from "./responsive-audit";

const OUT = process.env.OMP_GUI_PHONE_DAY;
const LOOKS = process.env.OMP_GUI_PHONE_DAY_LOOKS === "1";

interface DeviceSpec {
	name: string;
	engine: "webkit" | "chromium";
	preset: (typeof devices)[string];
	phone: boolean;
}

const ALL_DEVICES: DeviceSpec[] = [
	{ name: "iphone", engine: "webkit", preset: devices["iPhone 15"], phone: true },
	{ name: "pixel", engine: "chromium", preset: devices["Pixel 8"], phone: true },
	{ name: "ipad-portrait", engine: "webkit", preset: devices["iPad Pro 11"], phone: false },
	{ name: "ipad-landscape", engine: "webkit", preset: devices["iPad Pro 11 landscape"], phone: false },
];
const DEVICES = ALL_DEVICES.filter(device =>
	(process.env.OMP_GUI_PHONE_DAY_DEVICES ?? ALL_DEVICES.map(item => item.name).join(","))
		.split(",")
		.includes(device.name),
);

/** Soft keyboard heights (CSS px) of the real devices with a suggestion strip. */
const KEYBOARD: Record<string, number> = { iphone: 336, pixel: 318, "ipad-portrait": 398, "ipad-landscape": 448 };

interface Step {
	device: string;
	step: string;
	ok: boolean;
	taps: number;
	ms: number;
	/** Chromium's layout-shift score during the step (null on WebKit). */
	cls: number | null;
	/** How far the composer box moved (px) during the step. */
	composerMoved: number;
	issues: Issue[];
	notes: Record<string, unknown>;
	error?: string;
}

/** Installed before the page's scripts: layout shifts (Chromium) and a mark that dies with a reload. */
const PROBE = `(() => {
	if (window.__pd) return;
	const pd = (window.__pd = { cls: 0, loadedAt: Date.now() });
	try {
		new PerformanceObserver(list => {
			for (const entry of list.getEntries()) if (!entry.hadRecentInput) pd.cls += entry.value;
		}).observe({ type: "layout-shift", buffered: true });
	} catch {}
})();`;

/** Answers `display-mode: standalone` the way an installed app's page does (no engine emulates it). */
const STANDALONE = `(() => {
	const original = window.matchMedia.bind(window);
	window.matchMedia = query => {
		const list = original(query);
		if (/display-mode:\\s*standalone/.test(query)) Object.defineProperty(list, "matches", { value: true });
		return list;
	};
	Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
})();`;

interface Rig {
	app: ElectronApplication;
	desk: Page;
	proxy: ServeProxy;
	root: string;
	project: string;
}

async function startRig(): Promise<Rig> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-phone-day-")));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	// A repository with a change, so Changes and Files have something to show.
	await fs.writeFile(path.join(project, "README.md"), "# Phone day\n\nA small project.\n");
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", themeName: "light", firstRunComplete: true, lastProject: project }),
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
		OMP_GUI_TEST_SESSION_FILES: "1",
		...tailscale.env,
	});
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"), `--user-data-dir=${desktop}`],
		env,
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
	const proxy = await ServeProxy.start(site, "seuput@example.com", undefined, { plainCookie: true });
	return { app, desk, proxy, root, project };
}

async function stopRig(rig: Rig | null): Promise<void> {
	if (!rig) return;
	await rig.proxy.close().catch(() => undefined);
	await exitApp(rig.app).catch(() => undefined);
	await fs.rm(rig.root, { recursive: true, force: true }).catch(() => undefined);
}

/** The person's day on one device: every step's taps and measurements. */
class Day {
	readonly steps: Step[] = [];
	taps = 0;
	constructor(
		readonly device: DeviceSpec,
		readonly page: Page,
		readonly look: Look,
	) {}

	async tap(locator: Locator): Promise<void> {
		this.taps++;
		await locator.first().tap({ timeout: 10_000 });
	}

	async step(name: string, run: (notes: Record<string, unknown>) => Promise<void>): Promise<void> {
		const { page } = this;
		const notes: Record<string, unknown> = {};
		this.taps = 0;
		const clsBefore = await page.evaluate(() => Reflect.get(window, "__pd")?.cls ?? 0).catch(() => 0);
		const boxBefore = await composerBox(page);
		const started = Date.now();
		let error: string | undefined;
		try {
			await run(notes);
		} catch (caught) {
			error = caught instanceof Error ? caught.message.split("\n")[0] : String(caught);
		}
		const ms = Date.now() - started;
		const clsAfter = await page.evaluate(() => Reflect.get(window, "__pd")?.cls ?? 0).catch(() => 0);
		const boxAfter = await composerBox(page);
		const issues = await measure(page, this.look).catch(() => [] as Issue[]);
		this.steps.push({
			device: this.device.name,
			step: name,
			ok: error === undefined,
			taps: this.taps,
			ms,
			cls: this.device.engine === "chromium" ? round(clsAfter - clsBefore, 4) : null,
			composerMoved:
				boxBefore && boxAfter
					? Math.round(Math.abs(boxAfter.top - boxBefore.top) + Math.abs(boxAfter.height - boxBefore.height))
					: 0,
			issues,
			notes,
			error,
		});
		await shot(page, `${this.device.name}-${name}`);
	}
}

const round = (value: number, digits = 0): number => Number(value.toFixed(digits));

async function shot(page: Page, name: string): Promise<void> {
	if (!OUT) return;
	await fs.mkdir(path.join(OUT, "shots"), { recursive: true });
	await page
		.screenshot({ path: path.join(OUT, "shots", `${name}.png`), scale: "css", animations: "disabled" })
		.catch(() => undefined);
}

async function composerBox(page: Page): Promise<{ top: number; height: number; bottom: number } | null> {
	return page
		.evaluate(() => {
			const box = document.querySelector(".omp-composer-box")?.getBoundingClientRect();
			return box ? { top: box.top, height: box.height, bottom: box.bottom } : null;
		})
		.catch(() => null);
}

/** The transcript's scroller, the first row whose top is on screen and that top. */
async function topRow(page: Page): Promise<{ key: string; top: number; scrollTop: number } | null> {
	return page.evaluate(() => {
		const scroller = document.querySelector<HTMLElement>(
			'[aria-label="Session transcript"], [aria-label="세션 대화"]',
		);
		if (!scroller) return null;
		const view = scroller.getBoundingClientRect();
		for (const row of scroller.querySelectorAll<HTMLElement>("[data-row-key]")) {
			const box = row.getBoundingClientRect();
			if (box.bottom > view.top + 1 && box.height > 0)
				return {
					key: row.dataset.rowKey ?? "",
					top: Math.round(box.top),
					scrollTop: Math.round(scroller.scrollTop),
				};
		}
		return null;
	});
}

async function rowTop(page: Page, key: string): Promise<number | null> {
	return page.evaluate(
		rowKey => document.querySelector(`[data-row-key="${CSS.escape(rowKey)}"]`)?.getBoundingClientRect().top ?? null,
		key,
	);
}

async function distanceFromBottom(page: Page): Promise<number | null> {
	return page.evaluate(() => {
		const scroller = document.querySelector<HTMLElement>(
			'[aria-label="Session transcript"], [aria-label="세션 대화"]',
		);
		return scroller ? Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) : null;
	});
}

async function fixture(page: Page, line: string): Promise<void> {
	const tab = await activeTab(page);
	await page.evaluate(([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }), [
		tab,
		line,
	] as const);
}

async function activeTab(page: Page): Promise<string> {
	const tabs = await page.evaluate(() => window.omp.tabs.list());
	const tab = tabs.find(item => item.active)?.tabId;
	if (!tab) throw new Error("no active tab");
	return tab;
}

const field = (page: Page) => page.locator("[data-composer-input]").first();
const sendButton = (page: Page) =>
	page.locator(".omp-composer-box").getByRole("button", { name: /^(Send|Steer|보내기|조종)$/ });

/** Typing is not tapping: one tap focuses the field, the text goes in, one tap sends. */
async function send(day: Day, text: string): Promise<void> {
	await day.tap(field(day.page));
	await field(day.page).fill(text);
	await day.tap(sendButton(day.page).filter({ visible: true }));
}

async function setHidden(page: Page, hidden: boolean): Promise<void> {
	await page.evaluate(hide => {
		if (hide) {
			Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
			Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
		} else {
			Reflect.deleteProperty(document, "visibilityState");
			Reflect.deleteProperty(document, "hidden");
		}
		document.dispatchEvent(new Event("visibilitychange"));
	}, hidden);
}

/** The drawer on a phone, the docked sidebar elsewhere. */
async function sidebar(day: Day): Promise<Locator> {
	const { page } = day;
	if (day.device.phone) {
		const drawer = page.locator("[data-drawer]");
		if (!(await drawer.isVisible().catch(() => false)))
			await day.tap(page.getByRole("button", { name: "Open menu" }));
		await expect(drawer).toBeVisible();
		return drawer;
	}
	return page.locator(".omp-session-sidebar").first();
}

/** A pick usually closes the drawer by itself; when it stays, the system back gesture closes it. */
async function closeSidebar(day: Day): Promise<void> {
	if (!day.device.phone) return;
	const drawer = day.page.locator("[data-drawer]");
	const closed = await expect(drawer)
		.toHaveCount(0, { timeout: 2500 })
		.then(() => true)
		.catch(() => false);
	if (closed) return;
	await day.page.goBack();
	await expect(drawer).toHaveCount(0, { timeout: 5000 });
}

/** Shrinks the visible area the way the soft keyboard does: Android resizes the layout, iOS the visual viewport. */
async function openKeyboard(day: Day, viewport: { width: number; height: number }): Promise<void> {
	const height = KEYBOARD[day.device.name] ?? 320;
	if (day.device.engine === "chromium") {
		await day.page.setViewportSize({ width: viewport.width, height: viewport.height - height });
		return;
	}
	await day.page.evaluate(kb => {
		const vv = window.visualViewport;
		if (!vv) return;
		Object.defineProperty(vv, "height", { configurable: true, get: () => window.innerHeight - kb });
		vv.dispatchEvent(new Event("resize"));
	}, height);
}

async function closeKeyboard(day: Day, viewport: { width: number; height: number }): Promise<void> {
	if (day.device.engine === "chromium") {
		await day.page.setViewportSize(viewport);
		return;
	}
	await day.page.evaluate(() => {
		const vv = window.visualViewport;
		if (!vv) return;
		Reflect.deleteProperty(vv, "height");
		vv.dispatchEvent(new Event("resize"));
	});
}

/** What the keyboard leaves visible: the field, the composer and the last row above it. */
async function keyboardFacts(page: Page, kb: number, engine: string) {
	return page.evaluate(
		({ kb, engine }) => {
			const visible = engine === "chromium" ? window.innerHeight : window.innerHeight - kb;
			const box = document.querySelector(".omp-composer-box")?.getBoundingClientRect();
			const input = document.querySelector("[data-composer-input]")?.getBoundingClientRect();
			const header = document.querySelector(".omp-topbar")?.getBoundingClientRect();
			const scroller = document.querySelector<HTMLElement>(
				'[aria-label="Session transcript"], [aria-label="세션 대화"]',
			);
			const rows = scroller ? [...scroller.querySelectorAll<HTMLElement>("[data-row-key]")] : [];
			const last = rows.at(-1)?.getBoundingClientRect();
			return {
				visible,
				composerBottom: box ? Math.round(box.bottom) : null,
				composerHidden: box ? Math.max(0, Math.round(box.bottom - visible)) : null,
				fieldHidden: input ? Math.max(0, Math.round(input.bottom - visible)) : null,
				headerTop: header ? Math.round(header.top) : null,
				lastRowUnderComposer: last && box ? Math.max(0, Math.round(last.bottom - box.top)) : null,
				transcriptVisible: scroller
					? Math.round(
							Math.min(scroller.getBoundingClientRect().bottom, box?.top ?? visible) -
								Math.max(0, scroller.getBoundingClientRect().top),
						)
					: null,
				kbOpen: document.documentElement.dataset.kb === "open",
				scrollY: Math.round(window.scrollY),
			};
		},
		{ kb, engine },
	);
}

async function runDay(browser: Browser, rig: Rig, device: DeviceSpec): Promise<Step[]> {
	const context: BrowserContext = await browser.newContext({ ...device.preset, reducedMotion: "no-preference" });
	await context.addInitScript(PROBE);
	const viewport = device.preset.viewport;
	const look: Look = {
		width: viewport.width,
		height: viewport.height,
		dpr: device.preset.deviceScaleFactor,
		orientation: viewport.width > viewport.height ? "landscape" : "portrait",
		theme: "light",
		lang: "en",
	};
	// The device's notch, home bar and corners, as the audit measures them (no engine emulates env(safe-area-*)).
	const inset = safeInsets(look);
	await context.addInitScript(
		css =>
			document.addEventListener("DOMContentLoaded", () => {
				const style = document.createElement("style");
				style.textContent = css;
				document.head.append(style);
			}),
		`:root:root{--safe-t:${inset.t}px;--safe-r:${inset.r}px;--safe-b:${inset.b}px;--safe-l:${inset.l}px}`,
	);
	const page = await context.newPage();
	page.setDefaultTimeout(15_000);
	const day = new Day(device, page, look);

	// Pairing, the long session and a short one: setup, not part of the day.
	await page.goto(`${rig.proxy.url}/`);
	await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 60_000 });
	const longTab = await page.evaluate(
		async cwd => (await window.omp.tabs.spawn({ cwd, kind: "agent" }))?.tabId ?? null,
		rig.project,
	);
	if (!longTab) throw new Error("no long tab");
	await expect
		.poll(() =>
			page.evaluate(
				id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:long-session" }),
				longTab,
			),
		)
		.toMatchObject({ success: true });
	const shortTab = await page.evaluate(
		async cwd => (await window.omp.tabs.spawn({ cwd, kind: "agent" }))?.tabId ?? null,
		rig.project,
	);
	if (!shortTab) throw new Error("no short tab");
	await page.evaluate(id => window.omp.tabs.setActive(id), longTab);
	await page.reload();
	await expect(field(page)).toBeVisible({ timeout: 60_000 });
	await page
		.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active != null, undefined, {
			timeout: 30_000,
		})
		.catch(() => undefined);

	// 1. The installed app starts: a new page in standalone, warm from the worker.
	const standalone = await context.newPage();
	await standalone.addInitScript(STANDALONE);
	await page.close();
	const started = Date.now();
	await standalone.goto(`${rig.proxy.url}/`);
	await expect(standalone.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 60_000 });
	const shellMs = Date.now() - started;
	await expect(field(standalone)).toBeEditable({ timeout: 60_000 });
	const composerMs = Date.now() - started;
	await expect(standalone.getByText("Long session answer 249", { exact: true })).toBeVisible({ timeout: 60_000 });
	const transcriptMs = Date.now() - started;
	const live = new Day(device, standalone, look);
	await live.step("start", async notes => {
		Object.assign(notes, { shellMs, composerMs, transcriptMs });
		notes.controlled = await standalone.evaluate(() => navigator.serviceWorker.controller != null);
		notes.atBottom = await distanceFromBottom(standalone);
	});
	const p = standalone;

	// 2. A notification click for the short tab (the worker posts it to the open page).
	await live.step("push-click", async notes => {
		const before = Date.now();
		await p.evaluate(tabId => {
			navigator.serviceWorker.dispatchEvent(
				new MessageEvent("message", { data: { type: "notification-click", payload: { tabId } } }),
			);
		}, shortTab);
		await expect.poll(() => activeTab(p), { timeout: 10_000 }).toBe(shortTab);
		notes.switchMs = Date.now() - before;
		// And the cold one: the worker opens `/#/open?tab=<id>` when no page is open.
		await p.evaluate(id => window.omp.tabs.setActive(id), longTab);
		await p.goto("about:blank");
		const cold = Date.now();
		await p.goto(`${rig.proxy.url}/#/open?tab=${shortTab}`);
		await expect.poll(() => activeTab(p), { timeout: 30_000 }).toBe(shortTab);
		await expect(field(p)).toBeEditable({ timeout: 30_000 });
		notes.coldOpenMs = Date.now() - cold;
		notes.hashLeft = await p.evaluate(() => location.hash);
	});

	// 3. Read the long transcript upward, then come back to the latest.
	await live.step("read-long", async notes => {
		const rows = await sidebar(live);
		await live
			.tap(
				rows
					.locator("[data-session-path]")
					.filter({ hasText: /Long|long/ })
					.first(),
			)
			.catch(async () => {
				await p.evaluate(id => window.omp.tabs.setActive(id), longTab);
			});
		await closeSidebar(live);
		await expect(p.getByText("Long session answer 249", { exact: true })).toBeVisible({ timeout: 30_000 });
		const scroller = p.locator('[aria-label="Session transcript"]');
		const box = await scroller.boundingBox();
		if (!box) throw new Error("no transcript");
		// Five upward swipes, the way a thumb reads back: real touch flings on Chromium (CDP's synthesized gesture,
		// momentum included), a touch-released scroll on WebKit (which has no gesture synthesis).
		const cdp = device.engine === "chromium" ? await context.newCDPSession(p) : null;
		for (let swipe = 0; swipe < 5; swipe++) {
			if (cdp)
				await cdp.send("Input.synthesizeScrollGesture", {
					x: Math.round(box.x + box.width / 2),
					y: Math.round(box.y + box.height / 3),
					yDistance: 700,
					gestureSourceType: "touch",
					speed: 2400,
				});
			else
				await p.evaluate(() => {
					const el = document.querySelector<HTMLElement>('[aria-label="Session transcript"]');
					if (!el) return;
					el.dispatchEvent(new TouchEvent("touchmove", { bubbles: true }));
					el.scrollBy({ top: -1400 });
					el.dispatchEvent(new TouchEvent("touchend", { bubbles: true }));
				});
			await p.waitForTimeout(250);
		}
		await cdp?.detach();
		notes.fromBottomAfterSwipes = await distanceFromBottom(p);
		// Older history may still be streaming in above: measure what the page does on its own first.
		const settled = await topRow(p);
		if (settled)
			notes.idleTimeline = await p.evaluate(async key => {
				const el = document.querySelector<HTMLElement>('[aria-label="Session transcript"]');
				const samples: string[] = [];
				for (let i = 0; i < 15; i++) {
					const row = document.querySelector(`[data-row-key="${CSS.escape(key)}"]`);
					samples.push(
						`${Math.round(el?.scrollTop ?? 0)}/${Math.round(el?.scrollHeight ?? 0)}/${row ? Math.round(row.getBoundingClientRect().top) : "x"}/${el?.querySelectorAll("[data-row-key]").length}`,
					);
					const { promise, resolve } = Promise.withResolvers<void>();
					setTimeout(resolve, 100);
					await promise;
				}
				return samples.join(" ");
			}, settled.key);
		if (settled) notes.idleDrift = Math.round(((await rowTop(p, settled.key)) ?? settled.top) - settled.top);
		const anchor = await topRow(p);
		// While read back, a new reply arrives: the row under the thumb must stay put.
		await fixture(p, "fixture:finish");
		await p.waitForTimeout(1200);
		if (anchor) notes.readingJump = Math.round(((await rowTop(p, anchor.key)) ?? anchor.top) - anchor.top);
		const jump = p.getByRole("button", { name: "Jump to latest" });
		notes.jumpVisible = await jump.isVisible();
		const jumpBox = await jump.boundingBox();
		notes.jumpSize = jumpBox ? [Math.round(jumpBox.width), Math.round(jumpBox.height)] : null;
		await live.tap(jump);
		await p.waitForTimeout(800);
		notes.fromBottomAfterJump = await distanceFromBottom(p);
		notes.latestVisible = await p.getByText("Background run finished").last().isVisible();
	});

	// 4. Answer an ask, approve a tool, steer a running turn.
	await live.step("ask", async notes => {
		await send(live, "fixture ask");
		const card = p.locator("form").filter({ has: p.locator("[data-choice]") });
		await expect(card).toBeVisible();
		const boxCard = await card.boundingBox();
		notes.cardTop = boxCard ? Math.round(boxCard.y) : null;
		notes.cardHeight = boxCard ? Math.round(boxCard.height) : null;
		await live.tap(card.locator('[data-choice="Staging"]'));
		await live.tap(card.locator('[data-choice="Unit tests"]'));
		await live.tap(p.getByRole("button", { name: "Next", exact: true }));
		await live.tap(card.locator('[data-choice="Yes"]'));
		await live.tap(p.getByRole("button", { name: "Submit", exact: true }));
		await expect(card).toHaveCount(0);
	});
	await live.step("approve", async notes => {
		await send(live, "fixture approval session");
		const approve = p.locator('[data-choice="Approve"]');
		await expect(approve.first()).toBeVisible();
		const box = await approve.first().boundingBox();
		const composer = await composerBox(p);
		notes.approveAboveComposer = box && composer ? Math.round(composer.top - (box.y + box.height)) : null;
		await live.tap(approve);
		await expect(approve).toHaveCount(0);
	});
	await live.step("steer", async notes => {
		await send(live, "fixture steer work");
		await expect(p.locator(".omp-work-card-button").filter({ hasText: "LaneRace" })).toHaveCount(1, {
			timeout: 20_000,
		});
		const sendLabel = await sendButton(p).filter({ visible: true }).first().getAttribute("aria-label");
		notes.sendLabelWhileRunning = sendLabel;
		await send(live, "Also check the lane order");
		await expect(p.locator("[data-queue-pill]")).toBeVisible({ timeout: 10_000 });
		notes.queued = await p.locator("[data-queue-pill]").innerText();
		await fixture(p, "fixture:steer-next");
		await fixture(p, "fixture:steer-finish");
		await expect(p.locator(".omp-work-outcome")).toBeVisible({ timeout: 20_000 });
	});

	// 5. Autopilot: the start sheet from the Run chip.
	await live.step("autopilot", async notes => {
		await live.tap(p.locator("[data-run-settings-trigger]"));
		const tab = p.getByRole("tab", { name: /Autopilot/ });
		await expect(tab).toBeVisible();
		await live.tap(tab);
		const start = p.getByRole("button", { name: /^Start/ });
		await expect(start.first()).toBeVisible();
		notes.startVisible = await start.first().isVisible();
		const startBox = await start.first().boundingBox();
		notes.startOnScreen = startBox ? startBox.y + startBox.height <= (p.viewportSize()?.height ?? 0) : false;
		// The system back gesture closes the sheet (a back layer), never the app.
		await p.goBack().catch(() => undefined);
		notes.backLeftApp = p.url().startsWith("about:");
		if (notes.backLeftApp) await p.goForward();
		notes.backClosedSheet = (await start.count()) === 0;
		if (!notes.backClosedSheet) await p.keyboard.press("Escape").catch(() => undefined);
	});

	// 6. Panels: Changes, Files, Terminal.
	for (const view of ["Changes", "Files", "Terminal"] as const) {
		await live.step(`panel-${view.toLowerCase()}`, async notes => {
			// A sheet on phones and portrait tablets, docked beside the transcript on a landscape tablet.
			const sheet = p.locator("[data-sheet-panel]").or(p.locator(":has(> .omp-panel-topbar)")).first();
			if (!(await sheet.isVisible().catch(() => false))) await live.tap(p.locator('[data-tour="panel"]'));
			await expect(sheet).toBeVisible();
			const button = device.phone
				? p.locator("[data-panel-tabbar]").getByRole("button", { name: view, exact: true })
				: sheet.getByRole("button", { name: view, exact: true });
			if ((await button.getAttribute("aria-pressed").catch(() => null)) !== "true") await live.tap(button);
			if (view === "Files")
				await expect(sheet.getByRole("treeitem", { name: /README\.md/ })).toBeVisible({ timeout: 15_000 });
			if (view === "Terminal")
				notes.terminal = await sheet
					.locator(".xterm")
					.waitFor({ timeout: 20_000 })
					.then(() => "drawn")
					.catch(
						async () =>
							(await sheet
								.locator(".omp-banner")
								.innerText()
								.catch(() => "")) || "nothing",
					);
			const box = await sheet.boundingBox();
			notes.sheet = box ? [Math.round(box.y), Math.round(box.height)] : null;
		});
	}
	await p.goBack().catch(() => undefined);
	if (p.url().startsWith("about:")) await p.goForward();
	const sheet = p.locator("[data-sheet-panel]").or(p.locator(":has(> .omp-panel-topbar)")).first();
	if (await sheet.isVisible().catch(() => false))
		await p
			.locator('[data-tour="panel"]')
			.tap()
			.catch(() => undefined);

	// 7. Rename the long session from the drawer (deleting it ends the day).
	await live.step("rename", async notes => {
		const list = await sidebar(live);
		const row = list.locator("[data-session-path]").filter({ hasText: "Long session turn 000" }).first();
		await expect(row).toBeVisible({ timeout: 20_000 });
		// The ⋯ appears once the session index lists the row (a tab's title alone has none).
		const menuAt = Date.now();
		await expect(row.locator("[data-sidebar-row-menu]")).toBeVisible({ timeout: 30_000 });
		notes.menuWaitMs = Date.now() - menuAt;
		await live.tap(row.locator("[data-sidebar-row-menu]"));
		await live.tap(p.getByRole("menuitem", { name: /^Rename/ }));
		// The inline rename field takes focus (the soft keyboard opens with no extra tap).
		const input = list.locator("input:focus");
		await expect(input).toHaveValue("Long session turn 000");
		await input.fill("Day long session");
		await input.press("Enter");
		await expect(list.locator("[data-session-path]").filter({ hasText: "Day long session" })).toBeVisible();
		notes.drawerOpenAfter = await p
			.locator("[data-drawer]")
			.isVisible()
			.catch(() => false);
		await closeSidebar(live);
	});

	// 8. Background mid-reply and back; then a dropped socket.
	await live.step("background", async notes => {
		await p.evaluate(() => Reflect.set(window, "__pdMark", true));
		await send(live, "fixture stream");
		await expect(p.getByText(/Stream chunk \d+\./).last()).toBeVisible({ timeout: 30_000 });
		await setHidden(p, true);
		await p.waitForTimeout(6000);
		const shown = Date.now();
		const before = await p.evaluate(() => document.body.innerText.match(/Stream chunk (\d+)\./g)?.length ?? 0);
		await setHidden(p, false);
		await expect
			.poll(() => p.evaluate(() => document.body.innerText.match(/Stream chunk (\d+)\./g)?.length ?? 0), {
				timeout: 15_000,
			})
			.toBeGreaterThan(before);
		notes.caughtUpMs = Date.now() - shown;
		notes.reloaded = !(await p.evaluate(() => Reflect.get(window, "__pdMark") === true));
		await fixture(p, "fixture:pause");
		await fixture(p, "fixture:finish");
	});
	await live.step("reconnect", async notes => {
		await p.evaluate(() => Reflect.set(window, "__pdMark", true));
		const since = Date.now();
		rig.proxy.dropSockets();
		await p.waitForTimeout(300);
		await p.evaluate(() => window.omp.tabs.list());
		notes.usableMs = Date.now() - since;
		notes.reloaded = !(await p.evaluate(() => Reflect.get(window, "__pdMark") === true));
		await expect(field(p)).toBeEditable();
	});

	// 9. Rotate, keep reading where we were.
	await live.step("rotate", async notes => {
		await p.evaluate(() => {
			const el = document.querySelector<HTMLElement>('[aria-label="Session transcript"]');
			el?.dispatchEvent(new TouchEvent("touchmove", { bubbles: true }));
			el?.scrollBy({ top: -900 });
			el?.dispatchEvent(new TouchEvent("touchend", { bubbles: true }));
		});
		await p.waitForTimeout(400);
		const anchor = await topRow(p);
		await p.setViewportSize({ width: viewport.height, height: viewport.width });
		await p.waitForTimeout(800);
		if (anchor) {
			const top = await rowTop(p, anchor.key);
			notes.anchorVisible = top !== null && top > -40 && top < viewport.width;
			notes.anchorDrift = top === null ? null : Math.round(top - anchor.top);
		}
		notes.shell = await p.evaluate(() => document.documentElement.dataset.shell);
		const rotated = await measure(p, {
			...look,
			width: viewport.height,
			height: viewport.width,
			orientation: "landscape",
		}).catch(() => []);
		notes.landscapeIssues = rotated.length;
		notes.landscapeIssueKinds = [...new Set(rotated.map(issue => issue.kind))];
		await shot(p, `${device.name}-rotated`);
		await p.setViewportSize(viewport);
		await p.waitForTimeout(800);
		if (anchor) {
			const back = await rowTop(p, anchor.key);
			notes.anchorBackDrift = back === null ? null : Math.round(back - anchor.top);
		}
	});

	// 10. The soft keyboard with a Korean IME composition.
	await live.step("keyboard-ko", async notes => {
		await live.tap(p.getByRole("button", { name: "Jump to latest" })).catch(() => undefined);
		await live.tap(field(p));
		await openKeyboard(live, viewport);
		await p.waitForTimeout(500);
		const kb = KEYBOARD[device.name] ?? 320;
		Object.assign(notes, await keyboardFacts(p, kb, device.engine));
		if (device.engine === "chromium") {
			const cdp = await context.newCDPSession(p);
			for (const piece of ["ㅇ", "아", "안", "안ㄴ", "안녀", "안녕"])
				await cdp.send("Input.imeSetComposition", {
					text: piece,
					selectionStart: piece.length,
					selectionEnd: piece.length,
				});
			await cdp.send("Input.insertText", { text: "안녕" });
		} else {
			await p.keyboard.insertText("안녕");
		}
		notes.draft = await field(p).inputValue();
		await shot(p, `${device.name}-keyboard`);
		const sendVisible = await sendButton(p).filter({ visible: true }).first().boundingBox();
		notes.sendHidden = sendVisible
			? Math.max(
					0,
					Math.round(
						sendVisible.y +
							sendVisible.height -
							(device.engine === "chromium" ? (p.viewportSize()?.height ?? 0) : viewport.height - kb),
					),
				)
			: null;
		await field(p).fill("");
		await closeKeyboard(live, viewport);
		await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	});
	// 11. Delete the renamed session from the drawer.
	await live.step("delete", async notes => {
		const list = await sidebar(live);
		const row = list.locator("[data-session-path]").filter({ hasText: "Day long session" }).first();
		await live.tap(row.locator("[data-sidebar-row-menu]"));
		await live.tap(p.getByRole("menuitem", { name: /^Delete/ }));
		const confirm = p.getByRole("dialog").getByRole("button", { name: /^Delete/ });
		await live.tap(confirm);
		await expect(list.locator("[data-session-path]").filter({ hasText: "Day long session" })).toHaveCount(0, {
			timeout: 20_000,
		});
		notes.drawerOpenAfter = await p
			.locator("[data-drawer]")
			.isVisible()
			.catch(() => false);
		notes.screenAfter = await p.evaluate(() => document.querySelector("[data-titlebar-session-name]")?.textContent);
		await closeSidebar(live);
	});

	await context.close();
	return [...day.steps, ...live.steps];
}

/** en/ko × light/dark captures of the main screens. */
async function captureLooks(browser: Browser, rig: Rig, device: DeviceSpec): Promise<void> {
	for (const lang of ["en", "ko"] as const) {
		await rig.desk.evaluate(value => window.omp.prefs.set("language", value), lang);
		for (const theme of ["light", "dark"] as const) {
			const context = await browser.newContext({ ...device.preset, colorScheme: theme });
			const page = await context.newPage();
			await page.goto(`${rig.proxy.url}/`);
			await expect(field(page)).toBeVisible({ timeout: 60_000 });
			await page.evaluate(name => window.omp.prefs.set("themeName", name), theme);
			await page.waitForTimeout(1200);
			await shot(page, `${device.name}-${lang}-${theme}-session`);
			await page
				.getByRole("button", { name: lang === "en" ? "Open menu" : "메뉴 열기" })
				.tap()
				.catch(() => undefined);
			await page.waitForTimeout(600);
			await shot(page, `${device.name}-${lang}-${theme}-drawer`);
			await page.goBack().catch(() => undefined);
			await page
				.locator("[data-run-settings-trigger]")
				.tap()
				.catch(() => undefined);
			await page.waitForTimeout(600);
			await shot(page, `${device.name}-${lang}-${theme}-run-sheet`);
			await context.close();
		}
	}
	await rig.desk.evaluate(() => window.omp.prefs.set("language", "en"));
}

function summary(steps: Step[]): string {
	const lines = [
		"| device | step | ok | taps | ms | CLS | composer moved | issues | notes |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	];
	for (const step of steps) {
		const kinds = new Map<string, number>();
		for (const issue of step.issues) kinds.set(issue.kind, (kinds.get(issue.kind) ?? 0) + 1);
		lines.push(
			`| ${step.device} | ${step.step} | ${step.ok ? "✓" : `✕ ${step.error ?? ""}`} | ${step.taps} | ${step.ms} | ${step.cls ?? "–"} | ${step.composerMoved} | ${[...kinds].map(([kind, count]) => `${kind}×${count}`).join(" ")} | ${JSON.stringify(step.notes).replaceAll("|", "/")} |`,
		);
	}
	return `${lines.join("\n")}\n`;
}

test.describe("a day on the phone", () => {
	test.skip(!OUT, "opt-in: OMP_GUI_PHONE_DAY=<dir>");
	test.describe.configure({ mode: "serial" });

	test("runs the day on every device and writes the report", async () => {
		test.setTimeout(30 * 60_000);
		if (!OUT) return;
		await fs.mkdir(OUT, { recursive: true });
		let rig: Rig | null = null;
		const browsers: Partial<Record<DeviceSpec["engine"], Browser>> = {};
		const steps: Step[] = [];
		try {
			rig = await startRig();
			for (const device of DEVICES) {
				const browser =
					browsers[device.engine] ?? (await (device.engine === "webkit" ? webkit : chromium).launch());
				browsers[device.engine] = browser;
				try {
					steps.push(...(await runDay(browser, rig, device)));
				} catch (error) {
					steps.push({
						device: device.name,
						step: "setup",
						ok: false,
						taps: 0,
						ms: 0,
						cls: null,
						composerMoved: 0,
						issues: [],
						notes: {},
						error: error instanceof Error ? error.message.split("\n")[0] : String(error),
					});
				}
				if (LOOKS && device.phone) await captureLooks(browser, rig, device);
				await fs.writeFile(path.join(OUT, "report.json"), JSON.stringify(steps, null, "\t"));
				await fs.writeFile(path.join(OUT, "summary.md"), summary(steps));
			}
		} finally {
			for (const browser of Object.values(browsers)) await browser?.close().catch(() => undefined);
			await stopRig(rig);
		}
	});
});
