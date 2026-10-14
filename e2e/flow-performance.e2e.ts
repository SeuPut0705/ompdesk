import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { measure, PROBE } from "./frame-probe";
import { exitApp, fixtureOmp } from "./harness";

// Opt-in audit of multi-step flows, end to end: every frame interval (rAF) and
// every Long Animation Frame (scripts, style, layout, paint) while a user
// launches the app, opens a long session, lays four of them out 2×2 and streams
// in all four, expands a huge finished card, opens a big change set's diff,
// opens settings, works a sidebar of 500 sessions, and streams for half an hour
// (memory). OMP_GUI_LIVE_SESSION_SOURCE names the stock session file the
// sessions are cloned from (never written); the fake omp serves the clones.
//
// OMP_GUI_FLOWS picks flows (comma list; default every flow but memory),
// OMP_GUI_FLOW_RUNS runs per subject (default 3), OMP_GUI_CANDIDATE_DIR and
// OMP_GUI_BASELINE_DIR the checkouts (each holding a built `out/`) measured in
// alternating order, OMP_GUI_FLOW_OUT the JSON result file,
// OMP_GUI_FLOW_MEMORY_MINUTES the memory flow's length (default 30).

const source = process.env.OMP_GUI_LIVE_SESSION_SOURCE;
const flows = new Set((process.env.OMP_GUI_FLOWS ?? "launch,open,grid,expand,diff,settings,sidebar").split(","));
const runs = Number(process.env.OMP_GUI_FLOW_RUNS ?? 3);
const subjects = [
	{ name: "after", root: process.env.OMP_GUI_CANDIDATE_DIR ?? process.cwd() },
	...(process.env.OMP_GUI_BASELINE_DIR ? [{ name: "before", root: process.env.OMP_GUI_BASELINE_DIR }] : []),
];
const results: object[] = [];

async function record(result: object) {
	results.push(result);
	console.log(JSON.stringify(result));
	await fs.writeFile(
		process.env.OMP_GUI_FLOW_OUT ?? "test-results/flow-performance.json",
		JSON.stringify(results, null, 2),
	);
}

/**
 * Frame intervals and Long Animation Frames from the document's start, for flows
 * that reload or launch (measure() lives inside one document). Installed with
 * PROBE; `__ompBoot.stop()` freezes it.
 */
const BOOT = `(() => {
	const boot = { deltas: [], last: 0, running: true };
	const tick = now => {
		if (boot.last) boot.deltas.push([boot.last, now - boot.last]);
		boot.last = now;
		if (boot.running) requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
	window.__ompBoot = boot;
})();`;

/** The boot probe's frames up to `until` (page time), with the worst Long Animation Frames. */
async function bootFrames(page: Page, until: number) {
	return page.evaluate(until => {
		const boot = Reflect.get(window, "__ompBoot") as { deltas: [number, number][]; running: boolean };
		boot.running = false;
		const perf = Reflect.get(window, "__ompPerf") as {
			frames: {
				at: number;
				duration: number;
				render: number;
				styleLayout: number;
				scripts: { duration: number; invoker: string; fn: string; source: string }[];
			}[];
		};
		const deltas = boot.deltas.filter(([at, ms]) => at + ms <= until);
		const frames = perf.frames.filter(frame => frame.at <= until);
		return {
			rafCount: deltas.length,
			rafMaxMs: Math.round(Math.max(0, ...deltas.map(([, ms]) => ms))),
			rafOver50: deltas.filter(([, ms]) => ms > 50).length,
			rafWorst: [...deltas]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 5)
				.map(([at, ms]) => `${Math.round(ms)}ms@${Math.round(at)}`),
			loafOver50: frames.filter(frame => frame.duration > 50).length,
			loafWorst: [...frames]
				.sort((a, b) => b.duration - a.duration)
				.slice(0, 4)
				.map(frame => ({
					at: Math.round(frame.at),
					ms: Math.round(frame.duration),
					render: Math.round(frame.render),
					styleLayout: Math.round(frame.styleLayout),
					scripts: frame.scripts
						.filter(script => script.duration >= 3)
						.map(script => `${Math.round(script.duration)}ms ${script.invoker} ${script.fn}@${script.source}`),
				})),
		};
	}, until);
}

/**
 * Page time of the first frame (a frame callback) in which `check(arg)` holds:
 * each check returns `performance.now()` once it holds and 0 before (a string
 * predicate would need `unsafe-eval`, which the app's CSP refuses).
 */
async function frameWhen(page: Page, check: (arg: string) => number, arg = "", timeout = 120_000): Promise<number> {
	const handle = await page.waitForFunction(check, arg, { polling: "raf", timeout });
	return Math.round(Number(await handle.jsonValue()));
}

/** Milliseconds from the latest key or pointer press to the first frame in which `check(arg)` holds. */
async function inputToFrame(page: Page, check: (arg: string) => number, arg = ""): Promise<number> {
	const at = await frameWhen(page, check, arg);
	const input = await page.evaluate(() => (Reflect.get(window, "__ompPerf") as { lastInput: number }).lastInput);
	return Math.round(at - input);
}

interface Profile {
	profile: string;
	project: string;
	desktop: string;
	agent: string;
	sessions: string;
}

async function makeProfile(): Promise<Profile> {
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-flow-")));
	await fs.chmod(profile, 0o700);
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	const sessions = path.join(agent, "sessions", "-flow-audit");
	await Promise.all([project, desktop, sessions].map(dir => fs.mkdir(dir, { recursive: true, mode: 0o700 })));
	return { profile, project, desktop, agent, sessions };
}

/** A private APFS clone of the source session (and its artifact dir) in the profile's sessions dir. */
function cloneSource(where: Profile): string {
	if (!source) throw new Error("OMP_GUI_LIVE_SESSION_SOURCE is required");
	const copy = path.join(where.sessions, path.basename(source));
	execFileSync("cp", ["-c", source, copy]);
	const artifacts = source.slice(0, -".jsonl".length);
	execFileSync("sh", ["-c", 'test ! -d "$1" || cp -c -R "$1" "$2"', "sh", artifacts, where.sessions]);
	return copy;
}

/** Row key of a session file's last assistant answer: the transcript's tail row. */
async function tailKey(file: string): Promise<string> {
	const tail = (await fs.readFile(file, "utf8"))
		.split("\n")
		.filter(Boolean)
		.map(
			line =>
				JSON.parse(line) as { type: string; message?: { role: string; timestamp?: number; content?: unknown } },
		)
		.findLast(
			entry =>
				entry.type === "message" &&
				entry.message?.role === "assistant" &&
				Array.isArray(entry.message.content) &&
				entry.message.content.some(block => block.type === "text" && block.text.trim()),
		);
	if (tail?.message?.timestamp === undefined) throw new Error("Session has no terminal assistant row");
	return `message-assistant-${tail.message.timestamp}`;
}

async function launch(
	root: string,
	where: Profile,
	options: { seed?: string; prefs?: object } = {},
): Promise<{ app: ElectronApplication; page: Page; launchedMs: number; windowMs: number }> {
	await fs.writeFile(
		path.join(where.desktop, "prefs.json"),
		JSON.stringify(options.prefs ?? { language: "en", firstRunComplete: true }),
	);
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: where.agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), where.profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(where.profile),
		...(options.seed ? { OMP_GUI_TEST_SEED_SESSION: options.seed } : {}),
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const started = performance.now();
	const app = await electron.launch({
		args: [path.join(root, "out/main/index.js"), where.project, `--user-data-dir=${where.desktop}`],
		env,
	});
	const launchedMs = Math.round(performance.now() - started);
	const page = await app.firstWindow();
	const windowMs = Math.round(performance.now() - started);
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
	return { app, page, launchedMs, windowMs };
}

async function sidecarReady(page: Page) {
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 120_000 })
		.toBe("ready");
}

/** Pages whose context already runs the probes at every document start. */
const probed = new WeakSet<Page>();

/** Reload with the probes installed; returns ms (test clock) to the tail row and the page-time frame it painted in. */
async function reloadToTail(page: Page, key: string) {
	if (!probed.has(page)) {
		probed.add(page);
		await page.context().addInitScript(PROBE);
		await page.context().addInitScript(BOOT);
	}
	const opened = performance.now();
	await page.reload();
	const paintedAt = await frameWhen(
		page,
		key => {
			const row = document.querySelector(`[data-row-key=${JSON.stringify(key)}]`);
			return row instanceof HTMLElement && row.offsetHeight > 0 ? performance.now() : 0;
		},
		key,
	);
	const openMs = Math.round(performance.now() - opened);
	return { openMs, paintedAt };
}

async function heap(page: Page) {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("HeapProfiler.collectGarbage");
	const used = (await cdp.send("Runtime.getHeapUsage")).usedSize;
	const counters = (await cdp.send("Memory.getDOMCounters")) as {
		documents: number;
		nodes: number;
		jsEventListeners: number;
	};
	await cdp.detach();
	const attached = await page.evaluate(() => document.getElementsByTagName("*").length);
	return {
		heapMb: Math.round((used / 1048576) * 10) / 10,
		nodes: counters.nodes,
		attachedElements: attached,
		listeners: counters.jsEventListeners,
		documents: counters.documents,
	};
}

/** Each run launches every subject on a fresh profile, alternating which goes first. */
async function eachRun(
	flow: string,
	body: (subject: { name: string; root: string }, run: number, where: Profile) => Promise<object>,
) {
	for (let run = 0; run < runs; run++)
		for (const subject of run % 2 ? [...subjects].reverse() : subjects) {
			const where = await makeProfile();
			try {
				await record({ flow, subject: subject.name, run, ...(await body(subject, run, where)) });
			} finally {
				await fs.rm(where.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		}
}

test.describe("flow performance", () => {
	test.skip(!source, "Explicit isolated flow audit (OMP_GUI_LIVE_SESSION_SOURCE)");
	test.beforeAll(async () => {
		await fs.mkdir("test-results", { recursive: true });
	});

	test("launch: a fresh profile to an interactive composer", async () => {
		test.skip(!flows.has("launch"));
		test.setTimeout(600_000);
		await eachRun("launch", async (subject, _run, where) => {
			// A fresh profile, but the UI language pinned: the readiness check reads the
			// composer's English placeholder.
			const { app, page, launchedMs, windowMs } = await launch(subject.root, where, { prefs: { language: "en" } });
			try {
				// The window loads before a test can add an init script: Long Animation
				// Frames come from the buffered observer instead.
				const composerAt = await frameWhen(page, () => {
					const box = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
					return box && box.offsetHeight > 0 ? performance.now() : 0;
				});
				const readyAt = await frameWhen(page, () =>
					document
						.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')
						?.placeholder.startsWith("Ask omp anything")
						? performance.now()
						: 0,
				);
				const frames = await page.evaluate(
					until =>
						new Promise<{ ms: number; at: number; styleLayout: number; scripts: string[] }[]>(resolve => {
							const entries: PerformanceEntry[] = [];
							const observer = new PerformanceObserver(list => entries.push(...list.getEntries()));
							observer.observe({ type: "long-animation-frame", buffered: true });
							// Buffered entries arrive in a task of their own; with none the
							// callback never runs, so the read ends on a timer.
							setTimeout(() => {
								observer.disconnect();
								resolve(
									entries
										.filter(entry => entry.startTime <= until)
										.map(entry => {
											const frame = entry as PerformanceEntry & {
												styleAndLayoutStart: number;
												scripts: {
													duration: number;
													invoker: string;
													sourceFunctionName: string;
													sourceURL: string;
												}[];
											};
											return {
												ms: Math.round(frame.duration),
												at: Math.round(frame.startTime),
												styleLayout: Math.round(
													frame.styleAndLayoutStart
														? frame.startTime + frame.duration - frame.styleAndLayoutStart
														: 0,
												),
												scripts: frame.scripts
													.filter(script => script.duration >= 5)
													.map(
														script =>
															`${Math.round(script.duration)}ms ${script.invoker} ${script.sourceFunctionName}@${script.sourceURL.split("/").at(-1)}`,
													),
											};
										})
										.sort((a, b) => b.ms - a.ms),
								);
							}, 200);
						}),
					readyAt,
				);
				const nav = await page.evaluate(() => {
					const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
					return {
						domContentLoaded: Math.round(entry?.domContentLoadedEventEnd ?? 0),
						load: Math.round(entry?.loadEventEnd ?? 0),
					};
				});
				return {
					launchedMs,
					windowMs,
					composerAt,
					readyAt,
					nav,
					loafOver50: frames.filter(frame => frame.ms > 50).length,
					loafWorst: frames.slice(0, 5),
				};
			} finally {
				await exitApp(app);
			}
		});
	});

	test("open: reload into the long session", async () => {
		test.skip(!flows.has("open"));
		test.setTimeout(900_000);
		await eachRun("open", async (subject, run, where) => {
			const seed = cloneSource(where);
			const key = await tailKey(seed);
			const { app, page } = await launch(subject.root, where, { seed });
			try {
				await sidecarReady(page);
				const traceDir = process.env.OMP_GUI_FLOW_TRACE;
				const tracer = traceDir ? await page.context().newCDPSession(page) : undefined;
				const traceEvents: unknown[] = [];
				if (tracer) {
					tracer.on("Tracing.dataCollected", ({ value }) => traceEvents.push(...value));
					await tracer.send("Tracing.start", {
						transferMode: "ReportEvents",
						traceConfig: {
							includedCategories: [
								"toplevel",
								"ipc",
								"blink",
								"devtools.timeline",
								"disabled-by-default-devtools.timeline",
								"disabled-by-default-devtools.timeline.stack",
								"v8",
								"v8.execute",
								"disabled-by-default-v8.cpu_profiler",
							],
						},
					});
				}
				// The first open after launch (the one the live-session audit times), then
				// a second with the bundle in the code cache, as every later open is.
				const cold = await reloadToTail(page, key);
				const coldFrames = await bootFrames(page, cold.paintedAt);
				if (tracer && traceDir) {
					const { promise, resolve } = Promise.withResolvers<void>();
					tracer.once("Tracing.tracingComplete", () => resolve());
					await tracer.send("Tracing.end");
					await promise;
					await fs.mkdir(traceDir, { recursive: true });
					await fs.writeFile(
						path.join(traceDir, `open-${subject.name}-${run}.trace.json`),
						JSON.stringify({ traceEvents }),
					);
					await tracer.detach();
				}
				await page.waitForTimeout(1000);
				const warm = await reloadToTail(page, key);
				const nav = await page.evaluate(() => {
					const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
					return { domContentLoaded: Math.round(entry?.domContentLoadedEventEnd ?? 0) };
				});
				return {
					coldMs: cold.openMs,
					coldPaintedAt: cold.paintedAt,
					warmMs: warm.openMs,
					warmPaintedAt: warm.paintedAt,
					nav,
					cold: coldFrames,
					warm: await bootFrames(page, warm.paintedAt),
				};
			} finally {
				await exitApp(app);
			}
		});
	});

	test("grid: four long sessions laid out 2×2, then four live cards streaming", async () => {
		test.skip(!flows.has("grid"));
		test.setTimeout(1_800_000);
		await eachRun("grid", async (subject, run, where) => {
			const seed = cloneSource(where);
			const key = await tailKey(seed);
			const { app, page } = await launch(subject.root, where, { seed });
			try {
				await sidecarReady(page);
				await reloadToTail(page, key);
				const first = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId;
				if (!first) throw new Error("No active tab");
				await page.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:title:Pane A" }),
					first,
				);
				const spawn = async (title: string) => {
					const spawned = await page.evaluate(cwd => window.omp.tabs.spawn({ cwd, kind: "agent" }), where.project);
					if (!spawned?.tabId) throw new Error("expected a background tab");
					const id = spawned.tabId;
					await expect
						.poll(
							async () =>
								(await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === id)?.status,
							{
								timeout: 120_000,
							},
						)
						.toBe("ready");
					await page.evaluate(
						({ id, title }) =>
							window.omp.rpc.commandForTab(id, { type: "bash", command: `fixture:title:${title}` }),
						{ id, title },
					);
					const row = page.locator("[data-session-path]").filter({ hasText: title });
					await expect(row).toBeVisible({ timeout: 30_000 });
					return { id, row };
				};
				const panes = [await spawn("Pane B"), await spawn("Pane C"), await spawn("Pane D")];
				await page.waitForTimeout(1500);
				const paneReady = (id: string) => {
					const pane = document.querySelector(`.omp-session-pane[data-tab-id="${CSS.escape(id)}"]`);
					const rows = pane?.querySelector(".omp-transcript-rows");
					return pane instanceof HTMLElement && pane.offsetWidth > 0 && rows && rows.childElementCount > 0
						? performance.now()
						: 0;
				};
				const splitMs: number[] = [];
				const split = await measure(app, page, `grid-${subject.name}-${run}-split`, 1, async () => {
					// (A / C) | (B / D): split right with B, then below A and below B.
					for (const [pane, column, item] of [
						[panes[0], undefined, "Split right"],
						[panes[1], "Pane A", "Split below"],
						[panes[2], "Pane B", "Split below"],
					] as const) {
						if (column) await page.locator(`.omp-session-pane[aria-label*="${column}"] textarea`).first().click();
						await pane.row.click({ button: "right" });
						await page.getByRole("menuitem", { name: item }).click();
						splitMs.push(await inputToFrame(page, paneReady, pane.id));
						await page.waitForTimeout(1000);
					}
				});
				await expect(page.locator(".omp-session-pane")).toHaveCount(4);
				const ids = [first, ...panes.map(pane => pane.id)];
				const control = (id: string, command: string) =>
					page.evaluate(({ id, command }) => window.omp.rpc.commandForTab(id, { type: "bash", command }), {
						id,
						command,
					});
				for (const id of ids)
					await page.evaluate(
						id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture work view" }),
						id,
					);
				await page.waitForTimeout(1000);
				for (const id of ids) await control(id, "fixture:work-next");
				const cards = page.locator(
					'.omp-execution-group > .omp-live-step[data-state="running"][data-surface="bash"]',
				);
				await expect(cards).toHaveCount(4, { timeout: 60_000 });
				for (const id of ids) await control(id, "fixture:work-stream");
				const streamOutput = await measure(app, page, `grid-${subject.name}-${run}-stream-output`, 10);
				for (const id of ids) for (let step = 0; step < 3; step++) await control(id, "fixture:work-next");
				await page.waitForTimeout(1000);
				for (const id of ids) await control(id, "fixture:work-output");
				for (const id of ids) await control(id, "fixture:work-stream");
				const streamAgents = await measure(app, page, `grid-${subject.name}-${run}-stream-agents`, 10);
				for (const id of ids) await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "abort" }), id);
				return { splitMs, split, streamOutput, streamAgents };
			} finally {
				await exitApp(app);
			}
		});
	});

	test("expand: open the biggest finished card in the long session", async () => {
		test.skip(!flows.has("expand"));
		test.setTimeout(900_000);
		await eachRun("expand", async (subject, run, where) => {
			if (!source) throw new Error("unreachable");
			// The source's turn with the most tool results, alone: one huge finished card.
			const lines = (await fs.readFile(source, "utf8")).split("\n");
			let best = { start: 0, end: 0, tools: 0 };
			let current = { start: 0, end: 0, tools: 0 };
			lines.forEach((line, index) => {
				if (!line.startsWith('{"type":"message"')) return;
				const role = (JSON.parse(line) as { message: { role: string } }).message.role;
				if (role === "user") current = { start: index, end: index, tools: 0 };
				else current.end = index;
				if (role === "toolResult") current.tools++;
				if (current.tools > best.tools) best = current;
			});
			const seed = path.join(where.sessions, "huge-card.jsonl");
			await fs.writeFile(seed, `${lines.slice(best.start, best.end + 1).join("\n")}\n`);
			const key = await tailKey(seed);
			const { app, page } = await launch(subject.root, where, { seed });
			try {
				await sidecarReady(page);
				await reloadToTail(page, key);
				await page.waitForTimeout(1500);
				const header = page.locator('.omp-execution-group-header[aria-expanded="false"]').first();
				await header.scrollIntoViewIfNeeded();
				await page.waitForTimeout(500);
				let expandMs = 0;
				const expand = await measure(app, page, `expand-${subject.name}-${run}-open`, 1, async () => {
					await header.click();
					expandMs = await inputToFrame(page, () => {
						const body = document.querySelector(".omp-execution-group-body");
						return body instanceof HTMLElement && body.offsetHeight > 0 ? performance.now() : 0;
					});
					await page.waitForTimeout(1500);
				});
				const scroller = page.locator(".omp-transcript-scroll").first();
				const box = await scroller.boundingBox();
				if (!box) throw new Error("No transcript scroller");
				await page.mouse.move(box.x + 12, box.y + box.height / 2);
				const scroll = await measure(app, page, `expand-${subject.name}-${run}-scroll`, 1, async () => {
					for (let step = 0; step < 40; step++) {
						await page.mouse.wheel(0, 700);
						await page.waitForTimeout(100);
					}
				});
				let collapseMs = 0;
				const collapse = await measure(app, page, `expand-${subject.name}-${run}-collapse`, 1, async () => {
					await page.locator('.omp-execution-group-header[aria-expanded="true"]').first().click();
					collapseMs = await inputToFrame(page, () =>
						document.querySelector(".omp-execution-group-body") ? 0 : performance.now(),
					);
					await page.waitForTimeout(1000);
				});
				return { tools: best.tools, expandMs, expand, scroll, collapseMs, collapse };
			} finally {
				await exitApp(app);
			}
		});
	});

	test("diff: the right panel's changes on a big change set", async () => {
		test.skip(!flows.has("diff"));
		test.setTimeout(900_000);
		await eachRun("diff", async (subject, run, where) => {
			// 800 changed files, one of them a 20,000-line rewrite.
			const git = (...args: string[]) =>
				execFileSync("git", ["-c", "user.name=flow", "-c", "user.email=flow@example.com", ...args], {
					cwd: where.project,
				});
			git("init", "--quiet");
			await fs.mkdir(path.join(where.project, "src"), { recursive: true });
			const body = (file: number, version: number, lines: number) =>
				Array.from({ length: lines }, (_, line) =>
					line % 8 === version
						? `export const value${line} = ${file * version + line}; // v${version}`
						: `export const value${line} = ${line};`,
				).join("\n");
			await Promise.all(
				Array.from({ length: 800 }, (_, file) =>
					fs.writeFile(path.join(where.project, "src", `f${file}.ts`), body(file, 0, 40)),
				),
			);
			await fs.writeFile(path.join(where.project, "src", "big.ts"), body(1, 0, 20_000));
			git("add", "-A");
			git("commit", "-qm", "init");
			await Promise.all(
				Array.from({ length: 800 }, (_, file) =>
					fs.writeFile(path.join(where.project, "src", `f${file}.ts`), body(file, 1, 40)),
				),
			);
			await fs.writeFile(
				path.join(where.project, "src", "big.ts"),
				Array.from({ length: 20_000 }, (_, line) => `export const renamed${line} = ${line * 3};`).join("\n"),
			);
			const seed = cloneSource(where);
			const key = await tailKey(seed);
			const { app, page } = await launch(subject.root, where, { seed });
			try {
				await sidecarReady(page);
				await reloadToTail(page, key);
				await page.waitForTimeout(1500);
				const aside = page.locator("aside.omp-inspector");
				let listMs = 0;
				let diffMs = 0;
				let nextMs = 0;
				const open = await measure(app, page, `diff-${subject.name}-${run}-open`, 1, async () => {
					await page.keyboard.press("ControlOrMeta+j");
					listMs = await inputToFrame(page, () =>
						document.querySelector('.omp-inspector button[title="src/big.ts"]') ? performance.now() : 0,
					);
					await page.waitForTimeout(1000);
					await aside.locator('button[title="src/big.ts"]').click();
					diffMs = await inputToFrame(page, () =>
						(document.querySelector(".omp-changes-preview .omp-pane-diff")?.childElementCount ?? 0) > 0
							? performance.now()
							: 0,
					);
					await page.waitForTimeout(1000);
				});
				const preview = aside.locator(".omp-changes-preview");
				const box = await preview.boundingBox();
				if (!box) throw new Error("No diff preview");
				await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
				const scroll = await measure(app, page, `diff-${subject.name}-${run}-scroll`, 1, async () => {
					for (let step = 0; step < 40; step++) {
						await page.mouse.wheel(0, 900);
						await page.waitForTimeout(100);
					}
				});
				// Painted coverage after the scroll: viewport pixels of the diff (below its
				// sticky header) that no line covers, and how far it scrolled.
				const coverage = await page.evaluate(() => {
					const preview = document.querySelector(".omp-changes-preview");
					const header = preview?.firstElementChild;
					if (!preview || !header) return { blankPx: -1, scrollTop: 0 };
					const top = header.getBoundingClientRect().bottom;
					const bottom = preview.getBoundingClientRect().bottom;
					const spans = [...preview.querySelectorAll(".omp-pane-diff [data-index]")]
						.map(row => row.getBoundingClientRect())
						.filter(rect => rect.bottom > top && rect.top < bottom)
						.sort((a, b) => a.top - b.top);
					let covered = top;
					let blankPx = 0;
					for (const rect of spans) {
						if (rect.top > covered) blankPx += rect.top - covered;
						covered = Math.max(covered, rect.bottom);
					}
					if (covered < bottom) blankPx += bottom - covered;
					return { blankPx: Math.round(blankPx), scrollTop: Math.round(preview.scrollTop) };
				});
				if (process.env.OMP_GUI_FLOW_SHOTS)
					await page.screenshot({
						path: path.join(process.env.OMP_GUI_FLOW_SHOTS, `diff-${subject.name}-${run}.png`),
					});
				const step = await measure(app, page, `diff-${subject.name}-${run}-next`, 1, async () => {
					for (let file = 0; file < 4; file++) {
						const before = await page.evaluate(
							() => document.querySelector(".omp-changes-preview")?.textContent?.length ?? 0,
						);
						await aside.getByRole("button", { name: "Next file", exact: true }).click();
						nextMs = Math.max(
							nextMs,
							await inputToFrame(
								page,
								before =>
									String(document.querySelector(".omp-changes-preview")?.textContent?.length ?? 0) !== before
										? performance.now()
										: 0,
								String(before),
							),
						);
						await page.waitForTimeout(500);
					}
					await aside.getByRole("button", { name: "Back to changed files", exact: true }).click();
					await page.waitForTimeout(800);
				});
				return { listMs, diffMs, nextMs, coverage, open, scroll, step };
			} finally {
				await exitApp(app);
			}
		});
	});

	test("settings: open settings over the long session and walk its sections", async () => {
		test.skip(!flows.has("settings"));
		test.setTimeout(900_000);
		await eachRun("settings", async (subject, run, where) => {
			const seed = cloneSource(where);
			const key = await tailKey(seed);
			const { app, page } = await launch(subject.root, where, { seed });
			try {
				await sidecarReady(page);
				await reloadToTail(page, key);
				await page.waitForTimeout(1500);
				let openMs = 0;
				let closeMs = 0;
				const sectionMs: number[] = [];
				const walk = await measure(app, page, `settings-${subject.name}-${run}`, 1, async () => {
					await page.keyboard.press("ControlOrMeta+Comma");
					openMs = await inputToFrame(page, () =>
						document.querySelector("[data-settings-page] [data-settings-section]") ? performance.now() : 0,
					);
					await page.waitForTimeout(800);
					const sections = await page
						.locator("[data-settings-page] button[data-settings-section]")
						.evaluateAll(buttons => buttons.map(button => button.getAttribute("data-settings-section") ?? ""));
					for (const section of sections.slice(1)) {
						await page.locator(`[data-settings-page] button[data-settings-section="${section}"]`).click();
						sectionMs.push(
							await inputToFrame(
								page,
								section =>
									document
										.querySelector(`[data-settings-page] button[data-settings-section="${section}"]`)
										?.getAttribute("aria-current") != null
										? performance.now()
										: 0,
								section,
							),
						);
						await page.waitForTimeout(400);
					}
					await page.keyboard.press("Escape");
					closeMs = await inputToFrame(
						page,
						key =>
							!document.querySelector("[data-settings-page]") &&
							document.querySelector(`[data-row-key=${JSON.stringify(key)}]`)
								? performance.now()
								: 0,
						key,
					);
					await page.waitForTimeout(800);
				});
				return { openMs, sectionMs, closeMs, walk };
			} finally {
				await exitApp(app);
			}
		});
	});

	test("sidebar: 500 stored sessions, scrolled and filtered", async () => {
		test.skip(!flows.has("sidebar"));
		test.setTimeout(900_000);
		await eachRun("sidebar", async (subject, run, where) => {
			const topics = ["authentication flow", "release workflow", "sidebar filter", "diff panel", "settings search"];
			const dir = path.join(where.agent, "sessions", "fixture");
			await fs.mkdir(dir, { recursive: true });
			await Promise.all(
				Array.from({ length: 500 }, async (_, index) => {
					const time = new Date(Date.now() - index * 600_000).toISOString();
					const title = `Session ${index} about the ${topics[index % topics.length]}`;
					const lines = [
						{ type: "title", v: 1, title, updatedAt: time },
						{ type: "session", version: 3, id: `s-${index}`, timestamp: time, cwd: where.project },
						{
							type: "message",
							id: "entry-1",
							parentId: null,
							timestamp: time,
							message: { role: "user", content: title, timestamp: Date.parse(time) },
						},
						{
							type: "message",
							id: "entry-2",
							parentId: "entry-1",
							timestamp: time,
							message: {
								role: "assistant",
								content: [{ type: "text", text: "Done." }],
								timestamp: Date.parse(time) + 1,
								stopReason: "stop",
							},
						},
					];
					const file = path.join(dir, `s-${index}.jsonl`);
					await fs.writeFile(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
					await fs.utimes(file, new Date(time), new Date(time));
				}),
			);
			const seed = cloneSource(where);
			const key = await tailKey(seed);
			const { app, page } = await launch(subject.root, where, { seed });
			try {
				await sidecarReady(page);
				const { openMs, paintedAt } = await reloadToTail(page, key);
				const rowsAt = await frameWhen(page, () =>
					document.querySelectorAll("[data-session-path]").length >= 500 ? performance.now() : 0,
				);
				const boot = await bootFrames(page, rowsAt);
				const sidebar = page.getByRole("complementary").first();
				const list = await sidebar.boundingBox();
				if (!list) throw new Error("No sidebar");
				await page.mouse.move(list.x + list.width / 2, list.y + list.height / 2);
				const scroll = await measure(app, page, `sidebar-${subject.name}-${run}-scroll`, 1, async () => {
					for (let step = 0; step < 40; step++) {
						await page.mouse.wheel(0, 600);
						await page.waitForTimeout(80);
					}
				});
				const filter = page.getByRole("searchbox", { name: "Filter sessions" });
				await filter.click();
				const typing = await measure(app, page, `sidebar-${subject.name}-${run}-filter`, 1, async () => {
					await filter.pressSequentially("release", { delay: 80 });
					await page.waitForTimeout(500);
					for (let index = 0; index < 7; index++) await filter.press("Backspace", { delay: 80 });
					await page.waitForTimeout(500);
				});
				// A run streaming beside the 500 rows: the stock session file grows (the
				// index watches it) while the card streams a command.
				const control = (command: string) =>
					page.evaluate(command => window.omp.rpc.command({ type: "bash", command }), command);
				const input = page.locator('textarea[aria-label="Message"]').first();
				await input.fill("fixture work view");
				await input.press("Enter");
				await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible({ timeout: 30_000 });
				await control("fixture:work-next");
				await control("fixture:work-stream");
				const journal = (await fs.readFile(seed, "utf8")).trimEnd().split("\n").at(-1) ?? "";
				const stream = await measure(app, page, `sidebar-${subject.name}-${run}-stream`, 1, async () => {
					for (let tick = 0; tick < 40; tick++) {
						await fs.appendFile(seed, `${journal}\n`);
						await page.waitForTimeout(250);
					}
				});
				await page.evaluate(() => window.omp.rpc.command({ type: "abort" }));
				return { openMs, paintedAt, rowsAt, boot, scroll, typing, stream };
			} finally {
				await exitApp(app);
			}
		});
	});

	test("memory: a long simulated stream", async () => {
		test.skip(!flows.has("memory"));
		const minutes = Number(process.env.OMP_GUI_FLOW_MEMORY_MINUTES ?? 30);
		test.setTimeout((minutes + 10) * 60_000 * runs * subjects.length);
		await eachRun("memory", async (subject, _run, where) => {
			const seed = cloneSource(where);
			const key = await tailKey(seed);
			const { app, page } = await launch(subject.root, where, { seed });
			try {
				await sidecarReady(page);
				await reloadToTail(page, key);
				await page.waitForTimeout(2000);
				const control = (command: string) =>
					page.evaluate(command => window.omp.rpc.command({ type: "bash", command }), command);
				const stop = page.getByRole("button", { name: "Stop", exact: true });
				const samples: object[] = [{ minute: 0, cycles: 0, ...(await heap(page)) }];
				const started = Date.now();
				let cycles = 0;
				let nextSample = 1;
				while (Date.now() - started < minutes * 60_000) {
					// One run of the work card: thinking, a streaming command, two streaming
					// subagents, then every remaining step to the finished outcome.
					await page.evaluate(() => window.omp.rpc.command({ type: "prompt", message: "fixture work view" }));
					await expect(stop).toBeVisible({ timeout: 30_000 });
					await control("fixture:work-next");
					await control("fixture:work-stream");
					await page.waitForTimeout(15_000);
					for (let step = 0; step < 3; step++) await control("fixture:work-next");
					await control("fixture:work-output");
					await control("fixture:work-stream");
					await page.waitForTimeout(15_000);
					for (let step = 0; step < 11; step++) {
						await control("fixture:work-next");
						await page.waitForTimeout(700);
					}
					await expect(stop).toBeHidden({ timeout: 30_000 });
					cycles++;
					if (Date.now() - started >= nextSample * 60_000) {
						samples.push({
							minute: Math.round((Date.now() - started) / 6000) / 10,
							cycles,
							...(await heap(page)),
						});
						nextSample = Math.floor((Date.now() - started) / 60_000) + 1;
					}
				}
				const metrics = await app.evaluate(({ app }) =>
					app
						.getAppMetrics()
						.filter(metric => metric.type === "Tab")
						.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0),
				);
				return { minutes, cycles, rendererMb: Math.round(metrics / 1024), samples };
			} finally {
				await exitApp(app);
			}
		});
	});
});
