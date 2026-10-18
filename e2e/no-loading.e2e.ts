/**
 * No loading screens (AGENTS.md › No loading screens): what a person sees while the app comes up and while it
 * switches, watched frame by frame by `loading-probe.ts`.
 *
 * Always on (the assertions): a warm desktop start, a session switch on the desktop and a warm load of the phone
 * page never show a spinner or an empty window, and move no layout (cumulative layout shift ≤ 0.05).
 *
 * Opt-in numbers (OMP_GUI_LOADING_PERF=<dir>; writes `results.json`, `summary.md` and the frame strips of every
 * scenario there): time to the first meaningful paint (the real layout, not the brand mark), to a composer that
 * answers, to the first transcript row, layout shift, and the time a spinner / a still skeleton was shown, for
 * the desktop (cold start, warm start, tab switch) and the phone page (cold load, warm load, reconnect).
 * OMP_GUI_LOADING_SUBJECTS names checkouts with a built `out/` (`before=/tmp/base,after=/repo`; default
 * `after=<cwd>`), OMP_GUI_LOADING_RUNS the repeats per scenario (default 3). The phone runs on Chromium as a
 * Moto G-class phone (4× CPU throttle) over the web-perf link (150 ms round trip, 9 Mbit/s down).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Browser, type BrowserContext, chromium, devices, expect, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { type FixtureTailscale, fixtureTailscale } from "./fixture/fake-tailscale-install";
import { type LinkProfile, ServeProxy, serveSites } from "./fixture/phone-serve";
import { exitApp, fixtureOmp } from "./harness";
import { LOADING_PROBE, type LoadingReading, readLoading } from "./loading-probe";

const OUT = process.env.OMP_GUI_LOADING_PERF;
const RUNS = Number(process.env.OMP_GUI_LOADING_RUNS ?? 3);
const SUBJECTS = (process.env.OMP_GUI_LOADING_SUBJECTS ?? `after=${process.cwd()}`).split(",").map(entry => {
	const [name, root] = entry.split("=");
	return { name: name as string, root: path.resolve(root as string) };
});
const LINK: LinkProfile = { rttMs: 150, downKbps: 9000, upKbps: 1500 };
const CPU_THROTTLE = 4;
/** The most layout shift the first screens may move (Core Web Vitals' "good" is 0.1; the app holds half). */
const MAX_CLS = 0.05;
/** What the snapshot writer waits for before its first write (`TRANSCRIPT_WRITE_DELAY_MS`), plus margin. */
const SNAPSHOT_SETTLE_MS = 4000;

interface Profile {
	root: string;
	project: string;
	desktop: string;
	env: Record<string, string>;
	tailscale: FixtureTailscale;
}

async function makeProfile(): Promise<Profile> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-no-loading-")));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
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
		OMP_GUI_HEADLESS: "1",
		OMP_GUI_TEST_LONG_SESSION: "1",
		OMP_GUI_TEST_SESSION_FILES: "1",
		// The real omp takes seconds to boot; what the window shows meanwhile is what the audits are about.
		OMP_GUI_TEST_BOOT_DELAY_MS: process.env.OMP_GUI_TEST_BOOT_DELAY_MS ?? (OUT ? "1500" : "800"),
		...tailscale.env,
	});
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	return { root, project, desktop, env, tailscale };
}

interface Desktop {
	app: ElectronApplication;
	page: Page;
	/** Wall clock (ms) just before the process was spawned. */
	spawnedAt: number;
}

/** One launch of `subject`'s built app on the profile; the probe is in before the first document when it can be. */
async function launchDesktop(subjectRoot: string, profile: Profile): Promise<Desktop> {
	const spawnedAt = Date.now();
	const app = await electron.launch({
		args: [path.join(subjectRoot, "out/main/index.js"), profile.project, `--user-data-dir=${profile.desktop}`],
		env: profile.env,
	});
	await app.context().addInitScript(LOADING_PROBE);
	const page = await app.firstWindow();
	// The window can load before the script is registered: then it is a renderer start of the same window, measured
	// from the reload (every later part of the app is as it was at launch).
	if (!(await page.evaluate(() => window.__nl !== undefined))) await page.reload();
	await page.waitForFunction(() => window.omp?.rpc != null);
	return { app, page, spawnedAt };
}

/** The first transcript row and a composer that has answered: the screen a person came for. */
async function settled(page: Page, rows: boolean): Promise<void> {
	await expect(page.locator("[data-composer-input]").first()).toBeVisible({ timeout: 60_000 });
	if (rows) await expect(page.getByText("Long session answer 249", { exact: true })).toBeVisible({ timeout: 60_000 });
	await page.waitForFunction(() => window.__nl?.composerResponsiveAt != null);
	// Whatever else the first second brings (a late hydrate, a reconcile) happens inside the window watched.
	await page.waitForTimeout(1500);
}

function spinnerFree(reading: LoadingReading, what: string): void {
	expect(
		reading.spinnerFrames,
		`${what}: a spinner was shown for ${Math.round(reading.spinnerMs)} ms (${reading.spinners.join(", ")})`,
	).toBe(0);
	expect(reading.blankFrames, `${what}: the window was blank for ${reading.blankFrames} frames`).toBe(0);
	expect(reading.cls, `${what}: layout shifted ${JSON.stringify(reading.shifts)}`).toBeLessThanOrEqual(MAX_CLS);
}

/** Open a second tab and wait until its omp shows the long session too. */
async function openSecondTab(page: Page, project: string): Promise<void> {
	const id = await page.evaluate(
		async cwd => (await window.omp.tabs.spawn({ cwd, kind: "agent" }))?.tabId ?? null,
		project,
	);
	expect(id).not.toBeNull();
	await expect
		.poll(() => page.evaluate(async () => (await window.omp.tabs.list()).length), { timeout: 30_000 })
		.toBe(2);
	await page.waitForTimeout(1000);
}

/** Cold start (writes what the next launch paints from), then the warm start that is measured. */
async function warmStart(
	subjectRoot: string,
	profile: Profile,
): Promise<{ cold: Desktop; warm: Desktop; coldReading: LoadingReading; warmReading: LoadingReading }> {
	const cold = await launchDesktop(subjectRoot, profile);
	await settled(cold.page, true);
	const coldReading = await readLoading(cold.page);
	await cold.page.waitForTimeout(SNAPSHOT_SETTLE_MS);
	await exitApp(cold.app);
	const warm = await launchDesktop(subjectRoot, profile);
	await settled(warm.page, true);
	return { cold, warm, coldReading, warmReading: await readLoading(warm.page) };
}

test.describe("no loading screens: desktop", () => {
	test.skip(Boolean(OUT), "the perf run measures instead");
	let profile: Profile;
	test.beforeEach(async () => {
		profile = await makeProfile();
	});
	test.afterEach(async () => {
		await fs.rm(profile.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	});

	test("a warm start and a tab switch show no spinner, no empty window and move no layout", async () => {
		const { warm, warmReading } = await warmStart(SUBJECTS[0]?.root ?? process.cwd(), profile);
		try {
			spinnerFree(warmReading, "warm start");

			// A second tab (it seeds the same long session in its own omp), then ⌘1 / ⌘2 between the two: the rows
			// are there in the first frame of every switch.
			await openSecondTab(warm.page, profile.project);
			// Each tab is shown once first (a tab never shown has nothing to switch back to).
			for (const key of ["ControlOrMeta+2", "ControlOrMeta+1"]) {
				await warm.page.keyboard.press(key);
				await expect(warm.page.getByText("Long session answer 249", { exact: true })).toBeVisible();
				await warm.page.waitForTimeout(800);
			}
			await warm.page.evaluate(() => {
				window.__nl?.reset();
				document.documentElement.dataset.probeExpectRows = "1";
			});
			for (const key of ["ControlOrMeta+1", "ControlOrMeta+2", "ControlOrMeta+1"]) {
				await warm.page.keyboard.press(key);
				await expect(warm.page.getByText("Long session answer 249", { exact: true })).toBeVisible();
				await warm.page.waitForTimeout(500);
			}
			const switched = await readLoading(warm.page);
			spinnerFree(switched, "tab switch");
			expect(switched.transcriptEmptyFrames, "a tab with rows was empty for a frame").toBe(0);
		} finally {
			await exitApp(warm.app);
		}
	});
});

interface Web {
	browser: Browser;
	context: BrowserContext;
	page: Page;
	proxy: ServeProxy;
	app: ElectronApplication;
}

const PHONE = devices["Moto G Power"] ?? devices["Pixel 5"];

async function startWeb(subjectRoot: string, profile: Profile): Promise<Web> {
	const app = await electron.launch({
		args: [path.join(subjectRoot, "out/main/index.js"), `--user-data-dir=${profile.desktop}`],
		env: profile.env,
	});
	const desk = await app.firstWindow();
	await desk.waitForFunction(() => window.omp?.rpc != null);
	await desk.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
	await expect
		.poll(() => desk.evaluate(async () => (await window.omp.mobileWeb.getState()).phase), { timeout: 60_000 })
		.toBe("ready");
	await expect.poll(() => serveSites(profile.tailscale).length, { timeout: 30_000 }).toBeGreaterThan(0);
	const site = serveSites(profile.tailscale).at(-1);
	if (!site) throw new Error("serve publishes no handler");
	const proxy = await ServeProxy.start(site, "seuput@example.com", undefined, {});
	const browser = await chromium.launch();
	const context = await browser.newContext({ ...PHONE });
	await context.addInitScript(LOADING_PROBE);
	const page = await context.newPage();
	await page.goto(`${proxy.url}/`);
	await expect(page.locator("[data-composer-input]").first()).toBeVisible({ timeout: 60_000 });
	return { browser, context, page, proxy, app };
}

async function stopWeb(web: Web | null): Promise<void> {
	if (!web) return;
	await web.browser.close().catch(() => undefined);
	await web.proxy.close().catch(() => undefined);
	await exitApp(web.app).catch(() => undefined);
}

test.describe("no loading screens: phone page", () => {
	test.skip(Boolean(OUT), "the perf run measures instead");
	let profile: Profile;
	let web: Web | null = null;
	test.beforeEach(async () => {
		profile = await makeProfile();
	});
	test.afterEach(async () => {
		await stopWeb(web);
		web = null;
		await fs.rm(profile.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	});

	test("a warm load shows no spinner, no empty window and moves no layout", async () => {
		web = await startWeb(SUBJECTS[0]?.root ?? process.cwd(), profile);
		const { page } = web;
		await expect(page.getByText("Long session answer 249", { exact: true })).toBeVisible({ timeout: 60_000 });
		// The worker installed its shell and the page wrote its snapshots.
		await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active != null);
		await page.waitForTimeout(SNAPSHOT_SETTLE_MS);
		// The phone's link and CPU, as the perf run has them: a slow load is where a wait would show.
		const cdp = await web.context.newCDPSession(page);
		await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
		web.proxy.setLink(LINK);
		await page.reload();
		await settled(page, true);
		spinnerFree(await readLoading(page), "warm phone load");
	});
});

/* ------------------------------------------------------------------ the opt-in numbers */

type Numbers = Record<string, number | null>;

const round = (value: number | null | undefined): number | null =>
	value === null || value === undefined || !Number.isFinite(value) ? null : Math.round(value * 1000) / 1000;

function median(values: Array<number | null>): number | null {
	const sorted = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
	if (sorted.length === 0) return null;
	return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

/** One scenario's reading as the numbers the summary lists (ms unless named). */
function numbers(reading: LoadingReading, launched?: { spawnedAt: number }): Numbers {
	const sinceSpawn = (at: number | null) =>
		at === null || !launched ? null : reading.timeOrigin + at - launched.spawnedAt;
	return {
		fcpMs: round(reading.fcp),
		shellMs: round(reading.shellAt),
		composerMs: round(reading.composerAt),
		composerResponsiveMs: round(reading.composerResponsiveAt),
		firstRowMs: round(reading.rowAt),
		splashUntilMs: round(reading.splashUntil),
		spawnToShellMs: round(sinceSpawn(reading.shellAt)),
		spawnToComposerMs: round(sinceSpawn(reading.composerResponsiveAt)),
		spawnToRowMs: round(sinceSpawn(reading.rowAt)),
		cls: round(reading.cls),
		spinnerMs: round(reading.spinnerMs),
		skeletonMs: round(reading.skeletonMs),
		blankFrames: reading.blankFrames,
		transcriptEmptyFrames: reading.transcriptEmptyFrames,
	};
}

function aggregate(runs: Numbers[]): Numbers {
	const out: Numbers = {};
	for (const key of Object.keys(runs[0] ?? {})) out[key] = median(runs.map(run => run[key] ?? null));
	return out;
}

/** Screenshots every `everyMs` until `stop` resolves: the frame strip of one scenario. */
async function recordFrames(
	target: Pick<Page, "screenshot">,
	dir: string,
	stop: Promise<unknown>,
	everyMs = 90,
): Promise<string[]> {
	await fs.mkdir(dir, { recursive: true });
	const files: string[] = [];
	let done = false;
	void stop.then(() => {
		done = true;
	});
	const started = Date.now();
	while (!done && files.length < 60) {
		const file = path.join(dir, `${String(files.length).padStart(2, "0")}-${Date.now() - started}ms.png`);
		const ok = await target.screenshot({ path: file, scale: "css", animations: "allow" }).then(
			() => true,
			() => false,
		);
		if (ok) files.push(file);
		const pause = Promise.withResolvers<void>();
		setTimeout(pause.resolve, everyMs);
		await pause.promise;
	}
	return files;
}

/** A contact sheet of the frames, rendered by a throwaway page. */
async function composeStrip(files: string[], out: string, browser: Browser): Promise<void> {
	if (files.length === 0) return;
	const frames = await Promise.all(
		files.map(
			async file =>
				`<figure><img src="data:image/png;base64,${(await fs.readFile(file)).toString("base64")}"><figcaption>${path.basename(file, ".png")}</figcaption></figure>`,
		),
	);
	const page = await browser.newPage({ viewport: { width: 1800, height: 900 } });
	await page.setContent(
		`<style>body{margin:0;background:#222;display:flex;flex-wrap:wrap;gap:6px;padding:6px}figure{margin:0;width:340px;color:#ddd;font:11px sans-serif}img{width:340px;display:block;border:1px solid #555}</style>${frames.join("")}`,
	);
	await page.waitForLoadState("load");
	await page.screenshot({ path: out, fullPage: true });
	await page.close();
}

interface Results {
	[subject: string]: { [scenario: string]: Numbers };
}

async function save(results: Results): Promise<void> {
	if (!OUT) return;
	await fs.mkdir(OUT, { recursive: true });
	await fs.writeFile(path.join(OUT, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
	const scenarios = [...new Set(Object.values(results).flatMap(subject => Object.keys(subject)))];
	const keys = [
		"shellMs",
		"composerResponsiveMs",
		"firstRowMs",
		"spawnToShellMs",
		"spawnToComposerMs",
		"cls",
		"spinnerMs",
		"skeletonMs",
		"blankFrames",
	];
	const lines = ["# Loading perf", "", `median of ${RUNS} runs per scenario; ms unless named`, ""];
	for (const scenario of scenarios) {
		lines.push(
			`## ${scenario}`,
			"",
			`| subject | ${keys.join(" | ")} |`,
			`| --- |${keys.map(() => " ---:").join(" |")} |`,
		);
		for (const [subject, byScenario] of Object.entries(results))
			if (byScenario[scenario])
				lines.push(`| ${subject} | ${keys.map(key => byScenario[scenario]?.[key] ?? "–").join(" | ")} |`);
		lines.push("");
	}
	await fs.writeFile(path.join(OUT, "summary.md"), `${lines.join("\n")}\n`);
}

test.describe("loading perf (opt-in)", () => {
	test.skip(!OUT, "set OMP_GUI_LOADING_PERF=<dir> to measure");
	test.describe.configure({ mode: "serial", timeout: 30 * 60_000 });
	const results: Results = {};

	for (const subject of SUBJECTS)
		test(`desktop: ${subject.name}`, async () => {
			const scenarios: Record<string, Numbers[]> = { "cold start": [], "warm start": [], "tab switch": [] };
			for (let run = 0; run < RUNS; run++) {
				const profile = await makeProfile();
				try {
					const record = run === 0;
					const stripBase = path.join(OUT as string, "strips", subject.name);
					// Cold: a fresh profile; the frames are taken while it comes up.
					const cold = await launchDesktop(subject.root, profile);
					const coldStop = Promise.withResolvers<void>();
					const coldFrames = record
						? recordFrames(cold.page, path.join(stripBase, "desktop-cold"), coldStop.promise)
						: null;
					await settled(cold.page, true);
					coldStop.resolve();
					scenarios["cold start"]?.push(numbers(await readLoading(cold.page), cold));
					const browser = await chromium.launch();
					if (coldFrames) await composeStrip(await coldFrames, path.join(stripBase, "desktop-cold.png"), browser);
					await cold.page.waitForTimeout(SNAPSHOT_SETTLE_MS);
					await exitApp(cold.app);
					// Warm: the same profile again.
					const warm = await launchDesktop(subject.root, profile);
					const warmStop = Promise.withResolvers<void>();
					const warmFrames = record
						? recordFrames(warm.page, path.join(stripBase, "desktop-warm"), warmStop.promise)
						: null;
					await settled(warm.page, true);
					warmStop.resolve();
					scenarios["warm start"]?.push(numbers(await readLoading(warm.page), warm));
					if (warmFrames) await composeStrip(await warmFrames, path.join(stripBase, "desktop-warm.png"), browser);
					// Switch: a second tab, each shown once, then ⌘2 and back with ⌘1 (the measured switch).
					await openSecondTab(warm.page, profile.project);
					for (const key of ["ControlOrMeta+2", "ControlOrMeta+1"]) {
						await warm.page.keyboard.press(key);
						await expect(warm.page.getByText("Long session answer 249", { exact: true })).toBeVisible();
						await warm.page.waitForTimeout(800);
					}
					await warm.page.evaluate(() => {
						window.__nl?.reset();
						document.documentElement.dataset.probeExpectRows = "1";
					});
					const switchStop = Promise.withResolvers<void>();
					const switchFrames = record
						? recordFrames(warm.page, path.join(stripBase, "desktop-switch"), switchStop.promise, 40)
						: null;
					await warm.page.keyboard.press("ControlOrMeta+2");
					await expect(warm.page.getByText("Long session answer 249", { exact: true })).toBeVisible();
					await warm.page.waitForTimeout(800);
					switchStop.resolve();
					scenarios["tab switch"]?.push(numbers(await readLoading(warm.page)));
					if (switchFrames)
						await composeStrip(await switchFrames, path.join(stripBase, "desktop-switch.png"), browser);
					await browser.close();
					await exitApp(warm.app);
				} finally {
					await fs.rm(profile.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
				}
			}
			results[subject.name] = {
				...results[subject.name],
				...Object.fromEntries(
					Object.entries(scenarios).map(([name, runs]) => [`desktop ${name}`, aggregate(runs)]),
				),
			};
			await save(results);
		});

	for (const subject of SUBJECTS)
		test(`phone: ${subject.name}`, async () => {
			const profile = await makeProfile();
			let web: Web | null = null;
			const scenarios: Record<string, Numbers[]> = { "cold load": [], "warm load": [], reconnect: [] };
			try {
				web = await startWeb(subject.root, profile);
				const { page, context, proxy, browser } = web;
				await expect(page.getByText("Long session answer 249", { exact: true })).toBeVisible({ timeout: 60_000 });
				await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active != null);
				await page.waitForTimeout(SNAPSHOT_SETTLE_MS);
				const cdp = await context.newCDPSession(page);
				await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
				proxy.setLink(LINK);
				const stripBase = path.join(OUT as string, "strips", subject.name);
				for (let run = 0; run < RUNS; run++) {
					const record = run === 0;
					// Cold: no worker, no HTTP cache (the device stays paired); snapshots are page data and stay.
					await cdp.send("Network.enable");
					await cdp.send("Network.clearBrowserCache");
					await page.evaluate(async () => {
						for (const registration of await navigator.serviceWorker.getRegistrations())
							await registration.unregister();
						for (const key of await caches.keys()) await caches.delete(key);
					});
					const coldStop = Promise.withResolvers<void>();
					const coldFrames = record
						? recordFrames(page, path.join(stripBase, "phone-cold"), coldStop.promise, 120)
						: null;
					await page.reload();
					await settled(page, true);
					coldStop.resolve();
					scenarios["cold load"]?.push(numbers(await readLoading(page)));
					if (coldFrames) await composeStrip(await coldFrames, path.join(stripBase, "phone-cold.png"), browser);
					await page.waitForFunction(
						async () => (await navigator.serviceWorker.getRegistration())?.active != null,
					);
					await page.waitForTimeout(1500);
					// Warm: the worker has the shell.
					const warmStop = Promise.withResolvers<void>();
					const warmFrames = record
						? recordFrames(page, path.join(stripBase, "phone-warm"), warmStop.promise, 120)
						: null;
					await page.reload();
					await settled(page, true);
					warmStop.resolve();
					scenarios["warm load"]?.push(numbers(await readLoading(page)));
					if (warmFrames) await composeStrip(await warmFrames, path.join(stripBase, "phone-warm.png"), browser);
					// Reconnect: the socket drops and comes back; the page keeps what it shows.
					await page.evaluate(() => {
						window.__nl?.reset();
						document.documentElement.dataset.probeExpectRows = "1";
					});
					const reconnectStop = Promise.withResolvers<void>();
					const reconnectFrames = record
						? recordFrames(page, path.join(stripBase, "phone-reconnect"), reconnectStop.promise, 150)
						: null;
					await context.setOffline(true);
					await page.waitForTimeout(1200);
					await context.setOffline(false);
					await page.waitForTimeout(4000);
					reconnectStop.resolve();
					scenarios.reconnect?.push(numbers(await readLoading(page)));
					if (reconnectFrames)
						await composeStrip(await reconnectFrames, path.join(stripBase, "phone-reconnect.png"), browser);
					await page.evaluate(() => {
						document.documentElement.dataset.probeExpectRows = "0";
					});
				}
				results[subject.name] = {
					...results[subject.name],
					...Object.fromEntries(
						Object.entries(scenarios).map(([name, runs]) => [`phone ${name}`, aggregate(runs)]),
					),
				};
				await save(results);
			} finally {
				await stopWeb(web);
				await fs.rm(profile.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});
});
