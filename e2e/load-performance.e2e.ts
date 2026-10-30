import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { countIpc, measure, measureTree, PROBE, type Probe, type Ready } from "./frame-probe";
import { exitApp, fixtureOmp } from "./harness";

// Opt-in audit of what OMPdesk itself costs under the owner's overload shape (30 Oct 2026: five sessions and
// their subagents ran heavy tools and the Mac froze at load average 70). Five tabs on the fake omp, all
// streaming at once: one long reply (full-message updates every 16 ms), two bash calls' growing output and two
// task calls whose OMP_GUI_LOAD_AGENTS subagents (default 3) stream replies and tool output at ~30 frames a
// second. Then four 10 s windows: watching one tab with the window focused, the same with the window on screen
// but unfocused (lib/cue-clock.ts), switching tabs (⌃⇥, timed to the shown pane) and scrolling, and the same with
// OMP_GUI_LOAD_BUSY busy loops (default: one per core) on the CPU. Per window: main's event-loop delay
// (monitorEventLoopDelay), CPU per process, renderer frames and long tasks, IPC per channel, and the fake omps'
// ticks (the load generator kept pace or not). OMP_GUI_LOAD_AUDIT=1 turns it on; OMP_GUI_BASELINE_DIR (a
// checkout root with a built `out/`) adds an interleaved "before" subject; OMP_GUI_LOAD_RUNS runs per subject
// (default 1); OMP_GUI_LOAD_OUT the JSON result file; OMP_GUI_LOAD_MAIN_PROFILE (a directory) writes main's
// CPU profile of each window. The renderer profile and trace come from measure()'s OMP_GUI_LIVE_SESSION_PROFILE
// and OMP_GUI_LIVE_SESSION_TRACE. What-if knobs: OMP_GUI_LOAD_CSS adds a stylesheet before the windows (e.g.
// every animation paused), OMP_GUI_LOAD_AWAY_SCRIPT runs a script in the page as it loses the focus.

const TABS = 5;
const WINDOW_S = 10;

type LagHistogram = { reset(): void; percentile(p: number): number; max: number; mean: number; count: number };

/** Main's event-loop delay histogram (perf_hooks), installed once per launch and reset per window. */
async function installLag(app: ElectronApplication) {
	await app.evaluate(() => {
		const { monitorEventLoopDelay } = process.getBuiltinModule("node:perf_hooks");
		const histogram = monitorEventLoopDelay({ resolution: 10 });
		histogram.enable();
		Reflect.set(globalThis, "ompdeskLag", histogram);
	});
}

async function readLag(app: ElectronApplication) {
	return app.evaluate(() => {
		// Installed by installLag above.
		const histogram: LagHistogram = Reflect.get(globalThis, "ompdeskLag");
		// Nanoseconds; the 10 ms sampling resolution is included in every sample.
		const ms = (ns: number) => Math.round(ns / 1e5) / 10;
		return {
			p50Ms: ms(histogram.percentile(50)),
			p99Ms: ms(histogram.percentile(99)),
			maxMs: ms(histogram.max),
			meanMs: ms(histogram.mean),
			samples: histogram.count,
		};
	});
}

type ProfilerSession = { post(method: string, params?: object): Promise<{ profile?: object }>; disconnect(): void };

async function startMainProfile(app: ElectronApplication) {
	await app.evaluate(async () => {
		const { Session } = process.getBuiltinModule("node:inspector/promises");
		const session = new Session();
		session.connect();
		await session.post("Profiler.enable");
		await session.post("Profiler.setSamplingInterval", { interval: 250 });
		await session.post("Profiler.start");
		Reflect.set(globalThis, "ompdeskProfiler", session);
	});
}

async function stopMainProfile(app: ElectronApplication): Promise<string> {
	return app.evaluate(async () => {
		// Started by startMainProfile above.
		const session: ProfilerSession = Reflect.get(globalThis, "ompdeskProfiler");
		const { profile } = await session.post("Profiler.stop");
		session.disconnect();
		return JSON.stringify(profile);
	});
}

/** `count` busy loops, one process each, until the returned stop is called. */
function busyLoops(count: number) {
	const children: ChildProcess[] = Array.from({ length: count }, () =>
		spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" }),
	);
	return () => {
		for (const child of children) child.kill("SIGKILL");
	};
}

async function tabIds(page: Page): Promise<string[]> {
	return (await page.evaluate(() => window.omp.tabs.list())).map(tab => tab.tabId);
}

async function command(page: Page, tabId: string, bash: string) {
	return page.evaluate(({ tabId, bash }) => window.omp.rpc.commandForTab(tabId, { type: "bash", command: bash }), {
		tabId,
		bash,
	});
}

/** The fake omps' work-stream ticks, summed over the tabs. */
async function ticks(page: Page, tabs: string[]): Promise<number> {
	const counts = await Promise.all(
		tabs.map(async tabId => {
			const response = await command(page, tabId, "fixture:work-ticks");
			return Number(Reflect.get(Object(Reflect.get(Object(response), "data")), "ticks") ?? Number.NaN);
		}),
	);
	return counts.reduce((sum, count) => sum + count, 0);
}

test("five streaming tabs with subagents, with and without CPU pressure: the app's own cost", async () => {
	test.skip(process.env.OMP_GUI_LOAD_AUDIT !== "1", "Explicit load audit");
	test.setTimeout(1_800_000);
	const runs = Number(process.env.OMP_GUI_LOAD_RUNS ?? 1);
	const busy = Number(process.env.OMP_GUI_LOAD_BUSY ?? os.availableParallelism());
	const agents = Number(process.env.OMP_GUI_LOAD_AGENTS ?? 3);
	const mainProfileDir = process.env.OMP_GUI_LOAD_MAIN_PROFILE;
	const subjects = [
		{ name: "after", root: process.env.OMP_GUI_CANDIDATE_DIR ?? process.cwd() },
		...(process.env.OMP_GUI_BASELINE_DIR ? [{ name: "before", root: process.env.OMP_GUI_BASELINE_DIR }] : []),
	];
	const results: object[] = [];
	for (let run = 0; run < runs; run++)
		for (const subject of run % 2 ? [...subjects].reverse() : subjects) {
			const profile = await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-load-"));
			await fs.chmod(profile, 0o700);
			const project = path.join(profile, "project");
			const desktop = path.join(profile, "desktop");
			const agent = path.join(profile, "agent");
			await Promise.all([project, desktop, agent].map(dir => fs.mkdir(dir, { recursive: true, mode: 0o700 })));
			await fs.writeFile(
				path.join(desktop, "prefs.json"),
				JSON.stringify({ language: "en", firstRunComplete: true }),
			);
			const env = {
				...process.env,
				PI_CODING_AGENT_DIR: agent,
				PI_CONFIG_DIR: path.relative(os.homedir(), profile),
				OMP_PROFILE: "",
				PI_PROFILE: "",
				OMP_GUI_TEST_LAUNCHER_PID: String(process.pid),
				OMP_GUI_OMP: await fixtureOmp(profile),
				OMP_GUI_TEST_HISTORY: "300",
				OMP_GUI_TEST_WORK_AGENTS: String(agents),
			};
			Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
			const app = await electron.launch({
				args: [path.join(subject.root, "out/main/index.js"), project, `--user-data-dir=${desktop}`],
				env,
			});
			const errors: string[] = [];
			let stopBusy: (() => void) | undefined;
			try {
				const page = await app.firstWindow();
				page.on("pageerror", error => errors.push(error.message));
				await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
				await page.waitForFunction(() => window.omp?.rpc != null);
				await expect
					.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, {
						timeout: 120_000,
					})
					.toBe("ready");
				await countIpc(app);
				await page.context().addInitScript(PROBE);
				await page.reload();
				await expect(page.locator('.omp-session-pane[data-active="true"] [data-row-key]').first()).toBeVisible({
					timeout: 120_000,
				});
				for (let tab = 1; tab < TABS; tab++) {
					const before = await tabIds(page);
					await page.keyboard.press("ControlOrMeta+t");
					await expect.poll(async () => (await tabIds(page)).length, { timeout: 60_000 }).toBe(tab + 1);
					const opened = (await tabIds(page)).find(tabId => !before.includes(tabId)) ?? "";
					// The next ⌘T is taken only once this tab's pane shows its transcript.
					await page.waitForFunction(tabId => (Reflect.get(window, "__ompReady") as Ready).pane(tabId), opened, {
						timeout: 120_000,
					});
				}
				const tabs = await tabIds(page);
				for (const tabId of tabs)
					await expect
						.poll(
							async () =>
								Reflect.get(
									Object(
										await page.evaluate(
											tabId => window.omp.rpc.commandForTab(tabId, { type: "get_state" }),
											tabId,
										),
									),
									"success",
								),
							{ timeout: 120_000 },
						)
						.toBe(true);
				// What each tab streams, the active (last) tab last: a long reply (every update carries the whole
				// message, as stock sends it), a bash call's growing output, or a task call's agents (their replies
				// and tool output; a hidden tab's agents send progress only, as stock's subscription has it).
				const roles = ["reply", "output", "agents", "output", "agents"] as const;
				const ok = (label: string, response: unknown) => {
					if (Reflect.get(Object(response), "success") !== true)
						errors.push(`${label}: ${JSON.stringify(response)}`);
				};
				for (const [index, tabId] of tabs.entries())
					ok(
						"prompt",
						await page.evaluate(
							({ tabId, message }) => window.omp.rpc.commandForTab(tabId, { type: "prompt", message }),
							{ tabId, message: roles[index] === "reply" ? "fixture stream" : "fixture work view" },
						),
					);
				await delay(1500);
				for (const [index, tabId] of tabs.entries()) {
					if (roles[index] === "reply") continue;
					// work-next 1 opens the bash step, 4 the task step.
					for (let step = 0; step < (roles[index] === "output" ? 1 : 4); step++)
						ok("work-next", await command(page, tabId, "fixture:work-next"));
					ok("work-output", await command(page, tabId, "fixture:work-output"));
					ok("work-stream", await command(page, tabId, "fixture:work-stream"));
				}
				await installLag(app);
				await delay(2000);
				// What-if knob: OMP_GUI_LOAD_CSS adds a stylesheet (e.g. every animation paused) so a window's cost can
				// be attributed to it.
				if (process.env.OMP_GUI_LOAD_CSS) await page.addStyleTag({ content: process.env.OMP_GUI_LOAD_CSS });
				const scroller = page.locator(".omp-session-pane[data-active=true] .omp-transcript-scroll").first();
				const box = await scroller.boundingBox();
				if (!box) throw new Error("No transcript scroller");
				await page.mouse.move(box.x + 12, box.y + box.height / 2);
				// ⌃⇥ to the next tab, timed from the key press to the first frame whose shown pane is another tab with
				// rows in it, then three wheel steps up its transcript; for the whole window.
				const switchAndScroll = (switchMs: number[]) => async () => {
					const until = Date.now() + WINDOW_S * 1000;
					while (Date.now() < until) {
						const from = await page.evaluate(
							() =>
								document.querySelector('.omp-session-pane[data-active="true"]')?.getAttribute("data-tab-id") ??
								"",
						);
						await page.keyboard.press("Control+Tab");
						const shown = await page.waitForFunction(
							from => {
								const pane = document.querySelector('.omp-session-pane[data-active="true"]');
								if (!pane || pane.getAttribute("data-tab-id") === from) return 0;
								if (!pane.querySelector(".omp-transcript-rows")?.childElementCount) return 0;
								return performance.now() - (Reflect.get(window, "__ompPerf") as Probe).lastInput || 0.1;
							},
							from,
							{ polling: "raf", timeout: 30_000 },
						);
						switchMs.push(Math.round(await shown.jsonValue()));
						for (let step = 0; step < 3; step++) {
							await page.mouse.wheel(0, -600);
							await page.waitForTimeout(80);
						}
						await page.waitForTimeout(250);
					}
				};
				const pid = app.process().pid;
				if (pid === undefined) throw new Error("No main pid");
				const measureWindow = async (name: string, switching: boolean) => {
					const label = `${subject.name}-${run}-${name}`;
					const ticksBefore = await ticks(page, tabs);
					if (mainProfileDir) await startMainProfile(app);
					await app.evaluate(() => {
						const histogram: LagHistogram = Reflect.get(globalThis, "ompdeskLag");
						histogram.reset();
					});
					const switchMs: number[] = [];
					// Watching is measured without the frame-interval probe, whose callback every frame would keep
					// the renderer and GPU drawing and hide what the app itself costs.
					const measured = await measureTree(pid, () =>
						measure(app, page, label, WINDOW_S, switching ? switchAndScroll(switchMs) : undefined, {
							idle: !switching,
						}),
					);
					const lag = await readLag(app);
					if (mainProfileDir) {
						const profileJson = await stopMainProfile(app);
						await fs.mkdir(mainProfileDir, { recursive: true });
						await fs.writeFile(path.join(mainProfileDir, `${label}.main.cpuprofile`), profileJson);
					}
					const generated = (await ticks(page, tabs)) - ticksBefore;
					const sorted = switchMs.toSorted((a, b) => a - b);
					return {
						mainLag: lag,
						workTicksPerSecond: Math.round(generated / measured.seconds),
						...(switching
							? {
									switches: sorted.length,
									switchP50Ms: sorted[Math.floor(sorted.length / 2)],
									switchMaxMs: sorted.at(-1),
								}
							: {}),
						...measured,
					};
				};
				// Watching with the window focused, then on screen but unfocused (the person in another app): the
				// page is told it lost the focus as Chromium tells it (hasFocus, a blur event), then gets it back.
				await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());
				const focused = await page.evaluate(() => document.hasFocus());
				const watch = await measureWindow("watch", false);
				await page.evaluate(() => {
					document.hasFocus = () => false;
					window.dispatchEvent(new Event("blur"));
				});
				await delay(500);
				if (process.env.OMP_GUI_LOAD_AWAY_SCRIPT) await page.evaluate(process.env.OMP_GUI_LOAD_AWAY_SCRIPT);
				const away = await measureWindow("away", false);
				// Looping animations and how many of them run on an effect-level steps() easing (lib/cue-clock.ts).
				const awayLoops = await page.evaluate(() => {
					const loops = document
						.getAnimations()
						.filter(animation => animation.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY);
					return {
						loops: loops.length,
						stepped: loops.filter(animation => animation.effect?.getTiming().easing?.startsWith("steps(")).length,
						unstepped: loops
							.filter(animation => !animation.effect?.getTiming().easing?.startsWith("steps("))
							.map(
								animation =>
									`${animation instanceof CSSAnimation ? animation.animationName : "script"} ${animation.playState} ${animation.effect?.getComputedTiming().duration}`,
							),
					};
				});
				await page.evaluate(() => {
					Reflect.deleteProperty(document, "hasFocus");
					window.dispatchEvent(new Event("focus"));
				});
				await delay(500);
				const switching = await measureWindow("switch", true);
				stopBusy = busyLoops(busy);
				await delay(1000);
				const pressure = await measureWindow("pressure", true);
				stopBusy();
				stopBusy = undefined;
				for (const tabId of tabs)
					await page.evaluate(tabId => window.omp.rpc.commandForTab(tabId, { type: "abort" }), tabId);
				const result = {
					subject: subject.name,
					run,
					tabs: tabs.length,
					agents,
					busy,
					focused,
					watch,
					away: { ...away, loops: awayLoops },
					switching,
					pressure,
					errors,
				};
				results.push(result);
				console.log(JSON.stringify(result));
				const out = process.env.OMP_GUI_LOAD_OUT ?? "test-results/load-performance.json";
				await fs.mkdir(path.dirname(out), { recursive: true });
				await fs.writeFile(out, JSON.stringify(results, null, 2));
				expect(errors).toEqual([]);
			} finally {
				stopBusy?.();
				await exitApp(app);
				await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		}
});
