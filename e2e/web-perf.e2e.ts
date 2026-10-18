/**
 * Opt-in audit of the paired phone page's speed (OMP_GUI_WEB_PERF=<dir> writes `results.json` and `summary.md`
 * there; the default run skips it). The built app's real web server sits behind the fake `tailscale serve`
 * (e2e/fixture/phone-serve.ts), whose proxy also plays the phone's network: 150 ms round trip, 9 Mbit/s down,
 * 1.5 Mbit/s up, one more round trip per new connection. Chromium runs as a Moto G-class phone (4× CPU
 * throttle through CDP) at 390×844; WebKit (iPhone 14, 390×844) cannot be CPU-throttled, so its numbers are
 * the desktop CPU's on the same network.
 *
 * Phases (OMP_GUI_WEB_PERF_PHASES, default all):
 * - load: cold (no service worker, no HTTP cache, still paired) and warm (service worker) loads of `/` on a
 *   long session: TTFB, FCP, LCP, composer visible and responsive (a task posted once it shows runs), first
 *   transcript row, requests before the first paint, JS/CSS/font bytes on the wire before the composer
 *   (eager) and after (lazy), decoded bytes, socket open → first transcript row, socket bytes and the
 *   calls made before the transcript shows.
 * - ws: a dropped socket and a hidden page (idle, and while a reply streams) until the page is usable again,
 *   and one idle minute visible and hidden (socket frames, timer and frame callbacks, main-thread busy time).
 * - stream: 10 s of a reply streaming (the fake's 16 ms deltas, batched by the host): socket arrival → next
 *   frame per delta, frame times, frames over 50 ms, long tasks, main-thread time per delta.
 * - input: keypress → next paint in the composer (Event Timing in Chromium, keydown → frame in both), the
 *   drawer opening, switching sessions, a 3 s fling through the long transcript (frames over 1.5 vsync).
 * - memory: OMP_GUI_WEB_PERF_MINUTES (default 10) of replies streaming one after another, then the JS heap
 *   (Chromium, after a GC) and the DOM node count.
 *
 * OMP_GUI_WEB_PERF_SUBJECTS names checkouts with a built `out/` (`after=/repo,before=/tmp/base`; default
 * `after=<cwd>`), OMP_GUI_WEB_PERF_ENGINES `chromium,webkit`, OMP_GUI_WEB_PERF_RUNS the loads per kind
 * (default 3). Subjects and engines run one at a time (`--workers=1` is implied by serial mode).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type Browser,
	type BrowserContext,
	type CDPSession,
	chromium,
	devices,
	expect,
	type Page,
	test,
	webkit,
} from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { fixtureTailscale } from "./fixture/fake-tailscale-install";
import { type LinkProfile, ServeProxy, serveSites } from "./fixture/phone-serve";
import { exitApp, fixtureOmp } from "./harness";

const OUT = process.env.OMP_GUI_WEB_PERF;
const RUNS = Number(process.env.OMP_GUI_WEB_PERF_RUNS ?? 3);
const MINUTES = Number(process.env.OMP_GUI_WEB_PERF_MINUTES ?? 10);
const PHASES = new Set((process.env.OMP_GUI_WEB_PERF_PHASES ?? "load,ws,stream,input,memory").split(","));
const ENGINES = (process.env.OMP_GUI_WEB_PERF_ENGINES ?? "chromium,webkit").split(",");
const SUBJECTS = (process.env.OMP_GUI_WEB_PERF_SUBJECTS ?? `after=${process.cwd()}`).split(",").map(entry => {
	const at = entry.indexOf("=");
	return { name: entry.slice(0, at), root: path.resolve(entry.slice(at + 1)) };
});

/** "Fast 4G" with the round trip the task names. */
const LINK: LinkProfile = { rttMs: 150, downKbps: 9000, upKbps: 1500 };
const CPU_THROTTLE = 4;
const STREAM_SECONDS = 10;

const PHONES: Record<string, (typeof devices)[string]> = {
	chromium: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } },
	webkit: devices["iPhone 14"],
};

/**
 * Installed before the page's scripts in every document: paint and LCP entries, long tasks, Event Timing,
 * timer/frame callback counts (only while `wake.counting`), the socket's frames and bytes (with the calls the
 * page makes and when their answers come), streamed deltas' arrival and the frame after their text lands, and
 * when the composer and the first transcript row appear.
 */
const PROBE = `(() => {
	if (window.__wp) return;
	const now = () => performance.now();
	const raf = window.requestAnimationFrame.bind(window);
	const wp = (window.__wp = {
		ws: [], calls: [], arrivals: [], paints: [], longTasks: [], events: [], keys: [],
		wake: { timeouts: 0, intervals: 0, rafs: 0, counting: false },
		fcp: null, lcp: null, composerAt: null, composerResponsiveAt: null, firstRowAt: null,
		watchStream: false, frames: null,
	});
	const observe = (type, fn, extra) => {
		try { new PerformanceObserver(list => list.getEntries().forEach(fn)).observe({ type, buffered: true, ...extra }); } catch {}
	};
	observe("paint", e => { if (e.name === "first-contentful-paint") wp.fcp = e.startTime; });
	observe("largest-contentful-paint", e => { wp.lcp = e.startTime; });
	observe("longtask", e => wp.longTasks.push([e.startTime, e.duration]));
	observe("event", e => wp.events.push([e.name, e.startTime, e.duration]), { durationThreshold: 16 });

	const st = window.setTimeout, si = window.setInterval, wraf = window.requestAnimationFrame;
	window.setTimeout = function (fn, ms, ...rest) {
		return st.call(window, typeof fn === "function" ? (...a) => { if (wp.wake.counting) wp.wake.timeouts++; return fn(...a); } : fn, ms, ...rest);
	};
	window.setInterval = function (fn, ms, ...rest) {
		return si.call(window, typeof fn === "function" ? (...a) => { if (wp.wake.counting) wp.wake.intervals++; return fn(...a); } : fn, ms, ...rest);
	};
	window.requestAnimationFrame = fn => wraf.call(window, t => { if (wp.wake.counting) wp.wake.rafs++; fn(t); });

	const Native = window.WebSocket;
	const CHUNK = /Stream chunk (\\d+)\\./g;
	const RES = /^\\{"t":"res","id":(\\d+)/;
	function Probe(url, protocols) {
		const socket = new Native(url, protocols);
		const rec = { created: now(), open: null, closed: null, inFrames: 0, inChars: 0, outFrames: 0, outChars: 0 };
		wp.ws.push(rec);
		const calls = new Map();
		socket.addEventListener("open", () => { rec.open = now(); });
		socket.addEventListener("close", () => { rec.closed = now(); });
		socket.addEventListener("message", event => {
			const at = now();
			if (typeof event.data !== "string") return;
			rec.inFrames++;
			rec.inChars += event.data.length;
			const res = RES.exec(event.data);
			if (res) {
				const call = calls.get(Number(res[1]));
				if (call) { call.done = at; call.chars = event.data.length; }
			}
			if (wp.watchStream && event.data.includes("Stream chunk")) {
				let match, max = 0;
				CHUNK.lastIndex = 0;
				while ((match = CHUNK.exec(event.data))) max = Math.max(max, Number(match[1]));
				wp.arrivals.push([at, max]);
			}
		});
		const send = socket.send.bind(socket);
		socket.send = data => {
			rec.outFrames++;
			rec.outChars += typeof data === "string" ? data.length : 0;
			if (typeof data === "string" && data.startsWith('{"t":"inv"')) {
				try {
					const frame = JSON.parse(data);
					const call = { ch: frame.ch, type: frame.a?.[0]?.command?.type ?? frame.a?.[0]?.type ?? null, at: now(), done: null, chars: 0 };
					calls.set(frame.id, call);
					wp.calls.push(call);
				} catch {}
			}
			send(data);
		};
		return socket;
	}
	Probe.prototype = Native.prototype;
	Object.assign(Probe, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
	window.WebSocket = Probe;

	// The composer and the first transcript row, timed from the mutation that brought them.
	const boot = new MutationObserver(() => {
		if (wp.composerAt === null && document.querySelector("[data-composer-input]")) {
			wp.composerAt = now();
			const channel = new MessageChannel();
			channel.port1.onmessage = () => { wp.composerResponsiveAt = now(); };
			channel.port2.postMessage(0);
		}
		if (wp.firstRowAt === null && document.querySelector("[data-transcript-kind]")) {
			raf(() => { if (wp.firstRowAt === null) wp.firstRowAt = now(); });
		}
		if (wp.composerAt !== null && wp.firstRowAt !== null) boot.disconnect();
	});
	boot.observe(document, { childList: true, subtree: true });

	// The frame after a streamed delta's text lands in the transcript.
	const textOf = node => (node.nodeType === 3 ? node.data : node.textContent ?? "");
	new MutationObserver(records => {
		if (!wp.watchStream) return;
		let max = 0;
		for (const record of records) {
			const texts = record.type === "characterData" ? [textOf(record.target)] : [...record.addedNodes].map(textOf);
			for (const text of texts) {
				if (!text.includes("Stream chunk")) continue;
				let match;
				CHUNK.lastIndex = 0;
				while ((match = CHUNK.exec(text))) max = Math.max(max, Number(match[1]));
			}
		}
		if (max > 0) raf(() => wp.paints.push([now(), max]));
	}).observe(document, { childList: true, subtree: true, characterData: true });

	// Keydown → the next frame, in any engine.
	document.addEventListener("keydown", event => {
		const at = event.timeStamp;
		raf(() => raf(t => wp.keys.push(t - at)));
	}, true);

	wp.startFrames = () => {
		const frames = (wp.frames = { deltas: [], last: 0, running: true });
		const tick = t => {
			if (frames.last) frames.deltas.push(t - frames.last);
			frames.last = t;
			if (frames.running) raf(tick);
		};
		raf(tick);
	};
	wp.stopFrames = () => {
		if (!wp.frames) return [];
		wp.frames.running = false;
		return wp.frames.deltas;
	};
	/**
	 * Time from the next pointer press or key to the first frame in which the selector matches a shown element
	 * (or, with \`absent\`, matches none).
	 */
	wp.armInteraction = (selector, absent) => {
		wp.interaction = new Promise(resolve => {
			// Nothing within 15 s counts as a miss (-1), never a hang.
			st.call(window, () => resolve(-1), 15000);
			const start = event => {
				const at = event.timeStamp;
				document.removeEventListener("pointerdown", start, true);
				document.removeEventListener("keydown", start, true);
				const poll = t => {
					const element = document.querySelector(selector);
					const box = element?.getBoundingClientRect();
					const shown = box != null && box.width > 0 && box.height > 0;
					if (shown !== Boolean(absent)) resolve(t - at);
					else raf(poll);
				};
				raf(poll);
			};
			document.addEventListener("pointerdown", start, true);
			document.addEventListener("keydown", start, true);
		});
	};
})();`;

interface WsRecord {
	created: number;
	open: number | null;
	closed: number | null;
	inFrames: number;
	inChars: number;
	outFrames: number;
	outChars: number;
}

interface CallRecord {
	ch: string;
	type: string | null;
	at: number;
	done: number | null;
	chars: number;
}

interface PageProbe {
	ws: WsRecord[];
	calls: CallRecord[];
	arrivals: [number, number][];
	paints: [number, number][];
	longTasks: [number, number][];
	events: [string, number, number][];
	keys: number[];
	wake: { timeouts: number; intervals: number; rafs: number; counting: boolean };
	fcp: number | null;
	lcp: number | null;
	composerAt: number | null;
	composerResponsiveAt: number | null;
	firstRowAt: number | null;
	watchStream: boolean;
	startFrames(): void;
	stopFrames(): number[];
	armInteraction(selector: string, absent?: boolean): void;
	interaction?: Promise<number>;
}

type Metrics = Record<string, number | null>;

const round = (value: number | null | undefined, digits = 0): number | null =>
	value === null || value === undefined || !Number.isFinite(value)
		? null
		: Math.round(value * 10 ** digits) / 10 ** digits;

function quantile(values: readonly number[], q: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? null;
}

function median(values: readonly (number | null)[]): number | null {
	return quantile(
		values.filter((value): value is number => value !== null),
		0.5,
	);
}

/** One subject × engine: the app, the proxy, the browser and the two tabs the phases use. */
interface Rig {
	engine: string;
	subject: string;
	app: ElectronApplication;
	proxy: ServeProxy;
	browser: Browser;
	context: BrowserContext;
	page: Page;
	cdp: CDPSession | null;
	project: string;
	root: string;
	longTab: string;
	shortTab: string;
}

async function makeProfile() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-web-perf-")));
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
		...tailscale.env,
	});
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	return { root, desktop, project, env, tailscale };
}

async function fixture(page: Page, tabId: string, line: string): Promise<void> {
	const response = await page.evaluate(
		([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }),
		[tabId, line] as const,
	);
	expect(response.success).toBe(true);
}

async function waitForApp(page: Page): Promise<void> {
	await expect(page.locator("[data-composer-input]").first()).toBeVisible({ timeout: 120_000 });
}

/** The drawer's row of the long session (the fake titles it) or of the empty one ("New session"). */
function sessionRow(page: Page, which: "long" | "short") {
	const rows = page.locator("[data-drawer] [data-session-path]");
	return which === "long"
		? rows.filter({ hasNotText: "New session" }).first()
		: rows.filter({ hasText: "New session" }).first();
}

/** A pick usually closes the drawer; when it stays (an already shown session), the system back closes it. */
async function closeDrawer(page: Page): Promise<void> {
	const drawer = page.locator("[data-drawer]");
	await expect(drawer)
		.toHaveCount(0, { timeout: 3000 })
		.catch(async () => {
			await page.goBack();
			await expect(drawer).toHaveCount(0, { timeout: 10_000 });
		});
}

async function showSession(page: Page, which: "long" | "short"): Promise<void> {
	await page.getByRole("button", { name: "Open menu" }).click();
	await sessionRow(page, which).click();
	await closeDrawer(page);
	await page.waitForTimeout(1500);
}

async function startRig(engine: string, subject: { name: string; root: string }): Promise<Rig> {
	const subjectRoot = subject.root;
	const profile = await makeProfile();
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
	// Pairing and setup run at loopback speed; the phases switch the phone's link on.
	const proxy = await ServeProxy.start(site, "seuput@example.com", undefined, { plainCookie: engine === "webkit" });
	const browser = await (engine === "webkit" ? webkit : chromium).launch();
	const context = await browser.newContext({ ...PHONES[engine] });
	await context.addInitScript(PROBE);
	const page = await context.newPage();
	await page.goto(`${proxy.url}/`);
	await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 60_000 });
	const longTab = await page.evaluate(
		async cwd => (await window.omp.tabs.spawn({ cwd, kind: "agent" }))?.tabId ?? null,
		profile.project,
	);
	if (!longTab) throw new Error("no long tab");
	await expect
		.poll(async () =>
			page.evaluate(
				id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:long-session" }),
				longTab,
			),
		)
		.toMatchObject({ success: true });
	const shortTab = await page.evaluate(
		async cwd => (await window.omp.tabs.spawn({ cwd, kind: "agent" }))?.tabId ?? null,
		profile.project,
	);
	if (!shortTab) throw new Error("no short tab");
	await page.evaluate(id => window.omp.tabs.setActive(id), longTab);
	await page.reload();
	await waitForApp(page);
	await expect(page.getByText("Long session answer 249", { exact: true })).toBeVisible({ timeout: 60_000 });
	// The worker installed its shell before the measured loads begin.
	await page.waitForFunction(async () => {
		const registration = await navigator.serviceWorker.getRegistration();
		return registration?.active != null && (await caches.keys()).length > 0;
	});
	let cdp: CDPSession | null = null;
	if (engine === "chromium") {
		cdp = await context.newCDPSession(page);
		await cdp.send("Performance.enable");
		await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
	}
	proxy.setLink(LINK);
	return {
		engine,
		subject: subject.name,
		app,
		proxy,
		browser,
		context,
		page,
		cdp,
		project: profile.project,
		root: profile.root,
		longTab,
		shortTab,
	};
}

async function stopRig(rig: Rig | null): Promise<void> {
	if (!rig) return;
	await rig.browser.close().catch(() => undefined);
	await rig.proxy.close().catch(() => undefined);
	await exitApp(rig.app).catch(() => undefined);
	await fs.rm(rig.root, { recursive: true, force: true }).catch(() => undefined);
}

/** Main-thread busy time (ms) from CDP's counters, Chromium only. */
async function busyMs(rig: Rig): Promise<Metrics | null> {
	if (!rig.cdp) return null;
	const { metrics } = (await rig.cdp.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] };
	const value = (name: string) => (metrics.find(metric => metric.name === name)?.value ?? 0) * 1000;
	return {
		task: value("TaskDuration"),
		script: value("ScriptDuration"),
		layout: value("LayoutDuration"),
		style: value("RecalcStyleDuration"),
	};
}

function busyDelta(before: Metrics | null, after: Metrics | null): Metrics {
	if (!before || !after) return { task: null, script: null, layout: null, style: null };
	const out: Metrics = {};
	for (const key of Object.keys(after)) out[key] = round((after[key] ?? 0) - (before[key] ?? 0));
	return out;
}

/** Wait until the page is shown and settled: the composer answers, the transcript painted, LCP stopped moving. */
async function settledLoad(page: Page): Promise<void> {
	await page.waitForFunction(
		() => {
			const wp = Reflect.get(window, "__wp") as { composerResponsiveAt: number | null; firstRowAt: number | null };
			return wp?.composerResponsiveAt != null && wp.firstRowAt != null;
		},
		undefined,
		{ timeout: 120_000, polling: 250 },
	);
	await page.waitForTimeout(2500);
}

async function loadMetrics(page: Page): Promise<Metrics> {
	return page.evaluate(() => {
		const wp = Reflect.get(window, "__wp") as PageProbe;
		const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
		const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
		const composer = wp.composerResponsiveAt ?? Number.POSITIVE_INFINITY;
		const fcp = wp.fcp ?? Number.POSITIVE_INFINITY;
		const kind = (entry: PerformanceResourceTiming) => {
			const name = new URL(entry.name).pathname;
			if (/\.m?js$/.test(name)) return "js";
			if (/\.css$/.test(name)) return "css";
			if (/\.woff2?$/.test(name)) return "font";
			return "other";
		};
		const sum = (filter: (entry: PerformanceResourceTiming) => boolean, field: "transferSize" | "decodedBodySize") =>
			resources.filter(filter).reduce((total, entry) => total + entry[field], 0);
		const socket = wp.ws[0];
		const firstRow = wp.firstRowAt;
		const beforeRow = wp.calls.filter(call => firstRow !== null && call.at < firstRow);
		return {
			ttfb: nav ? nav.responseStart : null,
			domContentLoaded: nav ? nav.domContentLoadedEventEnd : null,
			fcp: wp.fcp,
			lcp: wp.lcp,
			composerVisible: wp.composerAt,
			composerResponsive: wp.composerResponsiveAt,
			firstTranscriptRow: wp.firstRowAt,
			requestsBeforeFcp: resources.filter(entry => entry.startTime < fcp).length + 1,
			requestsBeforeComposer: resources.filter(entry => entry.startTime < composer).length + 1,
			eagerJsWire: sum(entry => kind(entry) === "js" && entry.startTime < composer, "transferSize"),
			eagerJsDecoded: sum(entry => kind(entry) === "js" && entry.startTime < composer, "decodedBodySize"),
			eagerJsFiles: resources.filter(entry => kind(entry) === "js" && entry.startTime < composer).length,
			eagerCssWire: sum(entry => kind(entry) === "css" && entry.startTime < composer, "transferSize"),
			eagerCssDecoded: sum(entry => kind(entry) === "css" && entry.startTime < composer, "decodedBodySize"),
			eagerFontWire: sum(entry => kind(entry) === "font" && entry.startTime < composer, "transferSize"),
			eagerFontFiles: resources.filter(entry => kind(entry) === "font" && entry.startTime < composer).length,
			lazyJsWire: sum(entry => kind(entry) === "js" && entry.startTime >= composer, "transferSize"),
			lazyJsDecoded: sum(entry => kind(entry) === "js" && entry.startTime >= composer, "decodedBodySize"),
			wsCreated: socket?.created ?? null,
			wsOpen: socket?.open ?? null,
			wsOpenToFirstRow: socket?.open != null && firstRow !== null ? firstRow - socket.open : null,
			wsCharsToFirstRow: beforeRow.reduce((total, call) => total + call.chars, 0),
			callsBeforeFirstRow: beforeRow.length,
			transcriptChars: wp.calls
				.filter(call => call.type === "sessions.transcript" || call.type === "get_transcript_page")
				.reduce((total, call) => total + call.chars, 0),
			longTaskMsToComposer: wp.longTasks
				.filter(([start]) => start < composer)
				.reduce((total, [, duration]) => total + duration, 0),
			domNodes: document.getElementsByTagName("*").length,
		};
	});
}

/**
 * One cold load, the device still paired: Chromium clears its HTTP cache, the worker and its caches (the load
 * then fills the HTTP cache as a first visit does); WebKit drops the worker and its caches and routes the load,
 * which keeps its HTTP cache out of it. The bytes the worker's install pulls after the load count separately.
 */
async function coldLoad(rig: Rig): Promise<Metrics> {
	const { page } = rig;
	const origin = new URL(rig.proxy.url).origin;
	if (rig.cdp) {
		await rig.cdp.send("Network.enable");
		await rig.cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "cache_storage,service_workers" });
		await rig.cdp.send("Network.clearBrowserCache");
	} else {
		await page.evaluate(async () => {
			for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
			for (const key of await caches.keys()) await caches.delete(key);
		});
		await page.route("**/*", route => route.continue());
	}
	await page.goto("about:blank");
	const bytes = { ...rig.proxy.bytes };
	await page.goto(`${origin}/`);
	await settledLoad(page);
	const metrics = await loadMetrics(page);
	metrics.wireHttpBytes = rig.proxy.bytes.httpDown - bytes.httpDown;
	metrics.wireWsBytes = rig.proxy.bytes.wsDown - bytes.wsDown;
	metrics.httpRequests = rig.proxy.bytes.httpRequests - bytes.httpRequests;
	if (!rig.cdp) await page.unrouteAll();
	// The worker the load registered installs its shell before the next load.
	await page.waitForFunction(
		async () => {
			const registration = await navigator.serviceWorker.getRegistration();
			return registration?.active != null && navigator.serviceWorker.controller != null;
		},
		undefined,
		{ timeout: 120_000, polling: 500 },
	);
	await page.waitForTimeout(1000);
	metrics.wireHttpBytesWithInstall = rig.proxy.bytes.httpDown - bytes.httpDown;
	return metrics;
}

interface CpuProfile {
	nodes: { id: number; callFrame: { url: string; functionName: string } }[];
	samples: number[];
	timeDeltas: number[];
}

/** Self time (ms) per script file and the heaviest functions of a CPU profile. */
function profileSummary(profile: CpuProfile): Metrics {
	const byId = new Map(profile.nodes.map(node => [node.id, node]));
	const files = new Map<string, number>();
	const functions = new Map<string, number>();
	for (const [index, id] of profile.samples.entries()) {
		const node = byId.get(id);
		const ms = (profile.timeDeltas[index] ?? 0) / 1000;
		const file = node?.callFrame.url ? (node.callFrame.url.split("/").pop() ?? "?") : "(native)";
		files.set(file, (files.get(file) ?? 0) + ms);
		const name = `${node?.callFrame.functionName || "(anonymous)"} ${file}`;
		functions.set(name, (functions.get(name) ?? 0) + ms);
	}
	const top = (map: Map<string, number>, prefix: string, count: number) =>
		[...map]
			.sort((a, b) => b[1] - a[1])
			.slice(0, count)
			.map(([name, ms]) => [`${prefix}${name}`, Math.round(ms)] as const);
	return Object.fromEntries([...top(files, "file:", 15), ...top(functions, "fn:", 25)]);
}

/** A load with the service worker; OMP_GUI_WEB_PERF_PROFILE=1 also records where its main-thread time goes. */
async function warmLoad(rig: Rig, profiles?: Metrics[]): Promise<Metrics> {
	const { page, cdp } = rig;
	const bytes = { ...rig.proxy.bytes };
	await page.goto("about:blank");
	const profile = cdp && profiles && process.env.OMP_GUI_WEB_PERF_PROFILE === "1";
	if (profile) {
		await cdp.send("Profiler.enable");
		await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
		await cdp.send("Profiler.start");
	}
	await page.goto(`${rig.proxy.url}/`);
	await settledLoad(page);
	if (profile) {
		const { profile: recorded } = (await cdp.send("Profiler.stop")) as { profile: CpuProfile };
		profiles.push(profileSummary(recorded));
		// The load's timeline: script files as they arrived, the socket, and every call with its answer time.
		const timeline = await page.evaluate(() => {
			const wp = Reflect.get(window, "__wp") as PageProbe;
			const scripts = (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
				.filter(entry => /\.(m?js|css)$/.test(entry.name))
				.map(entry => ({
					file: entry.name.split("/").pop(),
					start: Math.round(entry.startTime),
					end: Math.round(entry.responseEnd),
				}));
			return { scripts, ws: wp.ws, calls: wp.calls, composer: wp.composerAt, firstRow: wp.firstRowAt };
		});
		if (OUT)
			await fs.writeFile(
				path.join(OUT, `timeline-${rig.subject}-${rig.engine}-${profiles.length}.json`),
				JSON.stringify(timeline, null, 1),
			);
	}
	const metrics = await loadMetrics(page);
	metrics.wireHttpBytes = rig.proxy.bytes.httpDown - bytes.httpDown;
	metrics.wireWsBytes = rig.proxy.bytes.wsDown - bytes.wsDown;
	metrics.httpRequests = rig.proxy.bytes.httpRequests - bytes.httpRequests;
	return metrics;
}

function aggregate(prefix: string, runs: Metrics[]): Metrics {
	const out: Metrics = {};
	const keys = new Set(runs.flatMap(run => Object.keys(run)));
	for (const key of keys) out[`${prefix}.${key}`] = round(median(runs.map(run => run[key] ?? null)));
	return out;
}

/** Wall-clock ms from `since` (Date.now in this process) until the page's composer answers again. */
async function usableAgainMs(page: Page, since: number, marker: string): Promise<{ ms: number; reloaded: boolean }> {
	const reloaded = await page
		.waitForFunction(name => Reflect.get(window, name) !== true, marker, { timeout: 4000, polling: 50 })
		.then(() => true)
		.catch(() => false);
	if (!reloaded) {
		// No reload: the socket is open again when a call answers.
		await page.evaluate(() => window.omp.tabs.list());
		return { ms: Date.now() - since, reloaded };
	}
	await settledLoad(page);
	const done = await page.evaluate(() => {
		const wp = Reflect.get(window, "__wp") as PageProbe;
		return performance.timeOrigin + (wp.composerResponsiveAt ?? 0);
	});
	return { ms: Math.round(done - since), reloaded };
}

async function markDocument(page: Page, marker: string): Promise<void> {
	await page.evaluate(name => Reflect.set(window, name, true), marker);
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

async function sendPrompt(page: Page, text: string): Promise<void> {
	const field = page.locator("[data-composer-input]").first();
	await field.fill(text);
	await field.press("Enter");
}

async function stopStream(rig: Rig, tabId: string): Promise<void> {
	await fixture(rig.page, tabId, "fixture:pause");
	await fixture(rig.page, tabId, "fixture:finish");
	await expect(rig.page.getByText("Background run finished").last()).toBeVisible({ timeout: 30_000 });
}

async function idleMinute(rig: Rig, hidden: boolean): Promise<Metrics> {
	const { page } = rig;
	if (hidden) await setHidden(page, true);
	await page.waitForTimeout(2000);
	const before = await page.evaluate(() => {
		const wp = Reflect.get(window, "__wp") as PageProbe;
		wp.wake = { timeouts: 0, intervals: 0, rafs: 0, counting: true };
		const socket = wp.ws.at(-1);
		return { inFrames: socket?.inFrames ?? 0, outFrames: socket?.outFrames ?? 0 };
	});
	const bytes = { ...rig.proxy.bytes };
	const busy = await busyMs(rig);
	await page.waitForTimeout(60_000);
	const after = await page.evaluate(() => {
		const wp = Reflect.get(window, "__wp") as PageProbe;
		wp.wake.counting = false;
		const socket = wp.ws.at(-1);
		return { inFrames: socket?.inFrames ?? 0, outFrames: socket?.outFrames ?? 0, wake: wp.wake };
	});
	const delta = busyDelta(busy, await busyMs(rig));
	if (hidden) await setHidden(page, false);
	return {
		wsFramesIn: after.inFrames - before.inFrames,
		wsFramesOut: after.outFrames - before.outFrames,
		wsWireBytes: rig.proxy.bytes.wsDown - bytes.wsDown + rig.proxy.bytes.wsUp - bytes.wsUp,
		timeouts: after.wake.timeouts,
		intervals: after.wake.intervals,
		rafs: after.wake.rafs,
		busyMs: delta.task ?? null,
	};
}

async function wsPhase(rig: Rig): Promise<Metrics> {
	const { page } = rig;
	const out: Metrics = {};
	// A dropped socket (a network blip).
	const drops: Metrics[] = [];
	for (let run = 0; run < RUNS; run++) {
		await markDocument(page, "__wpMark");
		const since = Date.now();
		rig.proxy.dropSockets();
		const result = await usableAgainMs(page, since, "__wpMark");
		drops.push({ usableMs: result.ms, reloaded: result.reloaded ? 1 : 0 });
		await page.waitForTimeout(1500);
	}
	Object.assign(out, aggregate("drop", drops));
	// The page hidden for 10 s with nothing running, then shown.
	const idle: Metrics[] = [];
	for (let run = 0; run < RUNS; run++) {
		await markDocument(page, "__wpMark");
		await setHidden(page, true);
		await page.waitForTimeout(10_000);
		const since = Date.now();
		await setHidden(page, false);
		const result = await usableAgainMs(page, since, "__wpMark");
		idle.push({ usableMs: result.ms, reloaded: result.reloaded ? 1 : 0 });
		await page.waitForTimeout(1500);
	}
	Object.assign(out, aggregate("hiddenIdle", idle));
	// Hidden for 10 s while a reply streams, then shown.
	const streaming: Metrics[] = [];
	for (let run = 0; run < RUNS; run++) {
		await sendPrompt(page, "fixture stream");
		await expect(page.getByText(/Stream chunk \d+\./).last()).toBeVisible({ timeout: 30_000 });
		await markDocument(page, "__wpMark");
		await setHidden(page, true);
		await page.waitForTimeout(10_000);
		const since = Date.now();
		await setHidden(page, false);
		const result = await usableAgainMs(page, since, "__wpMark");
		streaming.push({ usableMs: result.ms, reloaded: result.reloaded ? 1 : 0 });
		await stopStream(rig, rig.longTab);
		await page.waitForTimeout(1500);
	}
	Object.assign(out, aggregate("hiddenStreaming", streaming));
	Object.assign(out, aggregate("idleVisible", [await idleMinute(rig, false)]));
	Object.assign(out, aggregate("idleHidden", [await idleMinute(rig, true)]));
	return out;
}

async function streamPhase(rig: Rig): Promise<Metrics> {
	const { page } = rig;
	await page.evaluate(() => {
		const wp = Reflect.get(window, "__wp") as PageProbe;
		wp.arrivals = [];
		wp.paints = [];
		wp.longTasks = [];
		wp.watchStream = true;
	});
	await sendPrompt(page, "fixture stream");
	await expect(page.getByText(/Stream chunk \d+\./).last()).toBeVisible({ timeout: 30_000 });
	const busy = await busyMs(rig);
	const bytes = { ...rig.proxy.bytes };
	const startedAt = await page.evaluate(() => {
		const wp = Reflect.get(window, "__wp") as PageProbe;
		wp.startFrames();
		wp.longTasks = [];
		return performance.now();
	});
	await page.waitForTimeout(STREAM_SECONDS * 1000);
	const probe = await page.evaluate(() => {
		const wp = Reflect.get(window, "__wp") as PageProbe;
		const deltas = wp.stopFrames();
		wp.watchStream = false;
		return { deltas, arrivals: wp.arrivals, paints: wp.paints, longTasks: wp.longTasks, now: performance.now() };
	});
	const busy2 = await busyMs(rig);
	const wsWire = rig.proxy.bytes.wsDown - bytes.wsDown;
	const frames = rig.proxy.bytes.wsFramesDown - bytes.wsFramesDown;
	await stopStream(rig, rig.longTab);
	const arrived = probe.arrivals.filter(([at]) => at >= startedAt);
	const chunks = (arrived.at(-1)?.[1] ?? 0) - (arrived[0]?.[1] ?? 0);
	// Latency of each socket arrival to the first frame showing its highest delta.
	const latencies = arrived.flatMap(([at, chunk]) => {
		const paint = probe.paints.find(([paintAt, shown]) => paintAt >= at && shown >= chunk);
		return paint ? [paint[0] - at] : [];
	});
	const gaps = arrived.slice(1).map(([at], index) => at - (arrived[index]?.[0] ?? at));
	const busyDeltaMs = busyDelta(busy, busy2);
	const seconds = (probe.now - startedAt) / 1000;
	return {
		"stream.deltas": chunks,
		"stream.batchesPerSecond": round(arrived.length / seconds, 1),
		"stream.batchGapP50": round(quantile(gaps, 0.5)),
		"stream.arrivalToFrameP50": round(quantile(latencies, 0.5)),
		"stream.arrivalToFrameP95": round(quantile(latencies, 0.95)),
		"stream.frameP50": round(quantile(probe.deltas, 0.5), 1),
		"stream.frameP95": round(quantile(probe.deltas, 0.95), 1),
		"stream.framesOver50": probe.deltas.filter(delta => delta > 50).length,
		"stream.frames": probe.deltas.length,
		"stream.longTasks": probe.longTasks.length,
		"stream.longTaskMs": round(probe.longTasks.reduce((total, [, duration]) => total + duration, 0)),
		"stream.busyMsPerSecond": round((busyDeltaMs.task ?? Number.NaN) / seconds),
		"stream.scriptMsPerSecond": round((busyDeltaMs.script ?? Number.NaN) / seconds),
		"stream.layoutStyleMsPerSecond": round(((busyDeltaMs.layout ?? Number.NaN) + (busyDeltaMs.style ?? 0)) / seconds),
		"stream.busyMsPerDelta": round((busyDeltaMs.task ?? Number.NaN) / Math.max(1, chunks), 2),
		"stream.busyMsPerBatch": round((busyDeltaMs.task ?? Number.NaN) / Math.max(1, arrived.length), 1),
		"stream.wsWireBytesPerSecond": round(wsWire / seconds),
		"stream.wsChunksPerSecond": round(frames / seconds, 1),
	};
}

async function inputPhase(rig: Rig): Promise<Metrics> {
	const { page } = rig;
	const out: Metrics = {};
	// Typing in the composer.
	const field = page.locator("[data-composer-input]").first();
	await field.click();
	await page.evaluate(() => {
		const wp = Reflect.get(window, "__wp") as PageProbe;
		wp.keys = [];
		wp.events = [];
	});
	await page.keyboard.type("the quick brown fox jumps over the lazy dog", { delay: 120 });
	await page.waitForTimeout(500);
	const typing = await page.evaluate(() => {
		const wp = Reflect.get(window, "__wp") as PageProbe;
		const keyEvents = wp.events.filter(([name]) =>
			["keydown", "keypress", "keyup", "input", "beforeinput"].includes(name),
		);
		return { keys: wp.keys, eventDurations: keyEvents.map(([, , duration]) => duration) };
	});
	await field.fill("");
	out["input.keyToFrameP50"] = round(quantile(typing.keys, 0.5));
	out["input.keyToFrameP95"] = round(quantile(typing.keys, 0.95));
	out["input.keyToFrameMax"] = round(Math.max(...typing.keys));
	out["input.eventTimingMax"] = typing.eventDurations.length ? round(Math.max(...typing.eventDurations)) : 0;
	out["input.eventTimingOver16"] = typing.eventDurations.length;

	// Opening the drawer, then switching sessions from it.
	const drawer: number[] = [];
	const switches: number[] = [];
	for (let run = 0; run < RUNS * 2; run++) {
		await page.evaluate(() =>
			(Reflect.get(window, "__wp") as PageProbe).armInteraction("[data-drawer] .omp-session-sidebar"),
		);
		await page.getByRole("button", { name: "Open menu" }).click();
		drawer.push(
			await page.evaluate(() => (Reflect.get(window, "__wp") as PageProbe).interaction ?? Promise.resolve(-1)),
		);
		await page.waitForTimeout(600);
		const target = run % 2 === 0 ? "short" : "long";
		// The long session's last answer, or the short one's empty transcript (the long one's rows gone).
		await page.evaluate(
			to => (Reflect.get(window, "__wp") as PageProbe).armInteraction("[data-row-key]", to === "short"),
			target,
		);
		await sessionRow(page, target).click();
		switches.push(
			await page.evaluate(() => (Reflect.get(window, "__wp") as PageProbe).interaction ?? Promise.resolve(-1)),
		);
		await closeDrawer(page);
		await page.waitForTimeout(1000);
	}
	out["input.drawerOpenP50"] = round(median(drawer.filter(ms => ms >= 0)));
	out["input.sessionSwitchP50"] = round(median(switches.filter(ms => ms >= 0)));
	out["input.interactionMisses"] = [...drawer, ...switches].filter(ms => ms < 0).length;

	// A fling through the long transcript: 3 s of scrolling up 40 px a frame.
	await expect(page.getByText("Long session answer 249", { exact: true })).toBeVisible({ timeout: 30_000 });
	const scroll = await page.evaluate(async () => {
		const wp = Reflect.get(window, "__wp") as PageProbe;
		const scroller = document.querySelector<HTMLElement>(".omp-transcript-scroll");
		if (!scroller) return null;
		wp.longTasks = [];
		wp.startFrames();
		const start = performance.now();
		const { promise, resolve } = Promise.withResolvers<void>();
		const step = () => {
			scroller.scrollTop -= 40;
			if (performance.now() - start < 3000) requestAnimationFrame(step);
			else resolve();
		};
		requestAnimationFrame(step);
		await promise;
		return {
			deltas: wp.stopFrames(),
			longTasks: wp.longTasks.length,
			domNodes: document.getElementsByTagName("*").length,
		};
	});
	if (scroll) {
		const vsync = quantile(scroll.deltas, 0.1) ?? 16.7;
		out["scroll.frames"] = scroll.deltas.length;
		out["scroll.framesOver1.5Vsync"] = scroll.deltas.filter(delta => delta > vsync * 1.5).length;
		out["scroll.framesOver50"] = scroll.deltas.filter(delta => delta > 50).length;
		out["scroll.frameP95"] = round(quantile(scroll.deltas, 0.95), 1);
		out["scroll.longTasks"] = scroll.longTasks;
		out["scroll.domNodes"] = scroll.domNodes;
	}
	return out;
}

async function memoryPhase(rig: Rig): Promise<Metrics> {
	const { page } = rig;
	await showSession(page, "short");
	const until = Date.now() + MINUTES * 60_000;
	let replies = 0;
	while (Date.now() < until) {
		await sendPrompt(page, "fixture stream");
		await expect(page.getByText(/Stream chunk \d+\./).last()).toBeVisible({ timeout: 30_000 });
		await page.waitForTimeout(Math.min(20_000, Math.max(1000, until - Date.now())));
		await stopStream(rig, rig.shortTab);
		replies++;
	}
	await page.waitForTimeout(3000);
	let heap: number | null = null;
	let listeners: number | null = null;
	if (rig.cdp) {
		await rig.cdp.send("HeapProfiler.collectGarbage");
		const usage = (await rig.cdp.send("Runtime.getHeapUsage")) as { usedSize: number };
		heap = usage.usedSize;
		const counters = (await rig.cdp.send("Memory.getDOMCounters")) as { jsEventListeners: number };
		listeners = counters.jsEventListeners;
	}
	const domNodes = await page.evaluate(() => document.getElementsByTagName("*").length);
	return {
		"memory.minutes": MINUTES,
		"memory.replies": replies,
		"memory.heapMB": round(heap === null ? null : heap / 1024 / 1024, 1),
		"memory.domNodes": domNodes,
		"memory.jsListeners": listeners,
	};
}

interface Result {
	subject: string;
	engine: string;
	metrics: Metrics;
	raw: Record<string, Metrics[]>;
}

/** Merge one phase's numbers into `results.json` and rewrite `summary.md` (a failed later phase keeps them). */
async function saveResult(result: Result): Promise<void> {
	if (!OUT) return;
	await fs.mkdir(OUT, { recursive: true });
	const file = path.join(OUT, "results.json");
	const previous = JSON.parse(await fs.readFile(file, "utf8").catch(() => "[]")) as Result[];
	const prior = previous.find(r => r.subject === result.subject && r.engine === result.engine);
	const merged: Result = {
		...result,
		metrics: { ...prior?.metrics, ...result.metrics },
		raw: { ...prior?.raw, ...result.raw },
	};
	const results = [...previous.filter(r => r !== prior), merged].sort((a, b) =>
		`${a.engine} ${a.subject}`.localeCompare(`${b.engine} ${b.subject}`),
	);
	await fs.writeFile(file, JSON.stringify(results, null, 2));
	const columns = results.map(r => `${r.subject} ${r.engine}`);
	const keys = [...new Set(results.flatMap(r => Object.keys(r.metrics)))].sort();
	const lines = [`| metric | ${columns.join(" | ")} |`, `|---|${columns.map(() => "---:").join("|")}|`];
	for (const key of keys) lines.push(`| ${key} | ${results.map(r => String(r.metrics[key] ?? "–")).join(" | ")} |`);
	await fs.writeFile(path.join(OUT, "summary.md"), `${lines.join("\n")}\n`);
}

test.describe.configure({ mode: "serial" });

for (const engine of ENGINES)
	for (const subject of SUBJECTS)
		test(`phone web performance: ${subject.name} on ${engine}`, async () => {
			test.skip(!OUT, "opt-in: OMP_GUI_WEB_PERF=<dir>");
			test.setTimeout((30 + (PHASES.has("memory") ? MINUTES * 1.2 : 0)) * 60_000);
			let rig: Rig | null = null;
			const save = (metrics: Metrics, raw: Record<string, Metrics[]> = {}) => {
				console.log(JSON.stringify({ subject: subject.name, engine, metrics }));
				return saveResult({ subject: subject.name, engine, metrics, raw });
			};
			try {
				rig = await startRig(engine, subject);
				if (PHASES.has("load")) {
					const raw: Record<string, Metrics[]> = { cold: [], warm: [], warmProfile: [] };
					for (let run = 0; run < RUNS; run++) {
						raw.cold?.push(await coldLoad(rig));
						raw.warm?.push(await warmLoad(rig, raw.warmProfile));
					}
					await save({ ...aggregate("cold", raw.cold ?? []), ...aggregate("warm", raw.warm ?? []) }, raw);
				}
				if (PHASES.has("ws")) await save(await wsPhase(rig));
				if (PHASES.has("stream")) await save(await streamPhase(rig));
				if (PHASES.has("input")) await save(await inputPhase(rig));
				if (PHASES.has("memory")) await save(await memoryPhase(rig));
			} finally {
				await stopRig(rig);
			}
		});
