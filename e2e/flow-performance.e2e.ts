import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { writeFakeSsh } from "../src/main/ssh/test-fake-ssh";
import { countIpc, measure, measureTree, PROBE, type Ready } from "./frame-probe";
import { exitApp, fixtureOmp, pressShortcutUntilVisible } from "./harness";
import { tinyPdf } from "./tiny-pdf";

// Opt-in audit of multi-step flows, end to end: every frame interval (rAF) and
// every Long Animation Frame (scripts, style, layout, paint) while a user
// launches the app, opens a long session, lays four of them out 2×2 and streams
// in all four, expands a huge finished card, opens a big change set's diff,
// opens settings, works a sidebar of 500 sessions, types beside @file cards,
// leaves the app idle with its background work on (quota polling and usage
// bars, file cards, a chatty Preview page, an SSH port watch) on screen and
// hidden, opens the side panel's Changes on 500 changed files (git calls and
// their CPU while it idles shown and hidden), Terminal and Preview (`panels`),
// and streams for half an hour (memory, with the process tree's RSS including
// both stock helper workers). OMP_GUI_LIVE_SESSION_SOURCE names the stock
// session file the sessions are cloned from (never written); the fake omp
// serves the clones.
//
// OMP_GUI_FLOWS picks flows (comma list; default every flow but memory and
// daily, the 1600 px work board / usage gauges / suggestions day: idle shown
// and hidden, streaming beside the live board, agents running after a turn,
// typing with inline completion, tab switches, IPC calls per minute),
// OMP_GUI_FLOW_RUNS runs per subject (default 3), OMP_GUI_FLOW_RUN_FROM the
// first run's index (so runs split over several lock holds keep alternating),
// OMP_GUI_FLOW_PARALLEL=1 runs a run's subjects side by side instead (for the
// memory flow, whose half hour per subject is not frame-sensitive),
// OMP_GUI_CANDIDATE_DIR and OMP_GUI_BASELINE_DIR the checkouts (each holding a
// built `out/`; a comma list of baselines names them before, before-2, …)
// measured in alternating order, OMP_GUI_FLOW_OUT the JSON result file,
// OMP_GUI_FLOW_MEMORY_MINUTES the memory flow's length (default 30),
// OMP_GUI_FLOW_WIDTH the window's width (default 1440).

const source = process.env.OMP_GUI_LIVE_SESSION_SOURCE;
const flows = new Set(
	(process.env.OMP_GUI_FLOWS ?? "launch,open,grid,expand,diff,settings,sidebar,compose,background").split(","),
);
const runs = Number(process.env.OMP_GUI_FLOW_RUNS ?? 3);
const firstRun = Number(process.env.OMP_GUI_FLOW_RUN_FROM ?? 0);
const subjects = [
	{ name: "after", root: process.env.OMP_GUI_CANDIDATE_DIR ?? process.cwd() },
	...(process.env.OMP_GUI_BASELINE_DIR?.split(",") ?? []).map((root, index) => ({
		name: index === 0 ? "before" : `before-${index + 1}`,
		root,
	})),
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
	options: { seed?: string; prefs?: object; env?: Record<string, string>; natives?: boolean } = {},
): Promise<{ app: ElectronApplication; page: Page; launchedMs: number; windowMs: number }> {
	await fs.writeFile(
		path.join(where.desktop, "prefs.json"),
		JSON.stringify(options.prefs ?? { language: "en", firstRunComplete: true }),
	);
	const omp = await fixtureOmp(where.profile);
	// The Terminal panel runs stock's PtySession: the fake omp borrows the installed pi-natives.
	if (options.natives)
		await fs.symlink(
			process.env.OMP_GUI_TEST_NATIVES ||
				path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-natives"),
			path.join(path.dirname(omp), "node_modules/@oh-my-pi/pi-natives"),
			"junction",
		);
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: where.agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), where.profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: omp,
		...(options.seed ? { OMP_GUI_TEST_SEED_SESSION: options.seed } : {}),
		...options.env,
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
	// OMP_GUI_FLOW_WIDTH: a wider window (e.g. 1600, where the work board docks beside the transcript).
	const width = Number(process.env.OMP_GUI_FLOW_WIDTH ?? 1440);
	await app.evaluate(
		({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]?.setContentSize(width, 900),
		width,
	);
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
			// Mounted is not enough: the row must sit inside the window, at the scroll
			// position this frame paints.
			const row = document.querySelector(`[data-row-key=${JSON.stringify(key)}]`);
			if (!(row instanceof HTMLElement) || row.offsetHeight === 0) return 0;
			const box = row.getBoundingClientRect();
			return box.top < window.innerHeight && box.bottom > 0 ? performance.now() : 0;
		},
		key,
	);
	const openMs = Math.round(performance.now() - opened);
	return { openMs, paintedAt };
}

async function heap(page: Page, snapshot?: string) {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("HeapProfiler.collectGarbage");
	const used = (await cdp.send("Runtime.getHeapUsage")).usedSize;
	const counters = (await cdp.send("Memory.getDOMCounters")) as {
		documents: number;
		nodes: number;
		jsEventListeners: number;
	};
	if (snapshot) {
		const chunks: string[] = [];
		cdp.on("HeapProfiler.addHeapSnapshotChunk", ({ chunk }) => chunks.push(chunk));
		await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
		await fs.writeFile(snapshot, chunks.join(""));
	}
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

/**
 * With OMP_GUI_FLOW_TRACE set, a Chromium trace (main-thread tasks, style, layout,
 * sampled JS stacks) from now until the returned `stop(name)` writes
 * `<name>.trace.json` there; without it, `stop` does nothing.
 */
async function startTrace(page: Page): Promise<(name: string) => Promise<void>> {
	const traceDir = process.env.OMP_GUI_FLOW_TRACE;
	if (!traceDir) return async () => {};
	const tracer = await page.context().newCDPSession(page);
	const traceEvents: unknown[] = [];
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
	return async name => {
		const { promise, resolve } = Promise.withResolvers<void>();
		tracer.once("Tracing.tracingComplete", () => resolve());
		await tracer.send("Tracing.end");
		await promise;
		await fs.mkdir(traceDir, { recursive: true });
		await fs.writeFile(path.join(traceDir, `${name}.trace.json`), JSON.stringify({ traceEvents }));
		await tracer.detach();
	};
}

/**
 * Each run launches every subject on a fresh profile, alternating which goes
 * first (or, with OMP_GUI_FLOW_PARALLEL=1, both at once).
 */
async function eachRun(
	flow: string,
	body: (subject: { name: string; root: string }, run: number, where: Profile) => Promise<object>,
) {
	const one = async (subject: { name: string; root: string }, run: number) => {
		const where = await makeProfile();
		try {
			await record({ flow, subject: subject.name, run, ...(await body(subject, run, where)) });
		} finally {
			await fs.rm(where.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	};
	for (let run = firstRun; run < firstRun + runs; run++) {
		const order = run % 2 ? [...subjects].reverse() : subjects;
		if (process.env.OMP_GUI_FLOW_PARALLEL === "1") await Promise.all(order.map(subject => one(subject, run)));
		else for (const subject of order) await one(subject, run);
	}
}

/**
 * Resident memory (MB) of the app's whole process tree by kind, from `ps`: the
 * Electron processes, omp, and each stock helper worker (`host.ts <worker>`;
 * v0.30.0's single worker reports as `helper`).
 */
async function treeRss(root: number): Promise<Record<string, number>> {
	const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,command="], { encoding: "utf8" })
		.split("\n")
		.map(line => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line))
		.filter(match => match !== null)
		.map(([, pid, ppid, rss, command]) => ({
			pid: Number(pid),
			ppid: Number(ppid),
			rss: Number(rss),
			command: command ?? "",
		}));
	const children = Map.groupBy(rows, row => row.ppid);
	const byKind: Record<string, number> = {};
	const visit = (row: { pid: number; rss: number; command: string }) => {
		const helper = /stock-helper\/host\.ts(?:\s+(\w+))?/.exec(row.command);
		const electron = /Electron Helper \((\w+)\)/.exec(row.command)?.[1];
		const kind = helper
			? `helper-${helper[1] ?? "single"}`
			: electron
				? `electron-${electron.toLowerCase()}`
				: /MacOS\/Electron/.test(row.command)
					? "electron-main"
					: (row.command.split(" ")[0]?.split("/").at(-1) ?? "?");
		byKind[kind] = (byKind[kind] ?? 0) + row.rss;
		for (const child of children.get(row.pid) ?? []) visit(child);
	};
	const self = rows.find(row => row.pid === root);
	if (self) visit(self);
	return Object.fromEntries(Object.entries(byKind).map(([kind, kb]) => [kind, Math.round(kb / 1024)]));
}

/**
 * Counts the git processes an app starts, which exit too fast for `ps`. With
 * OMP_GUI_FLOW_GIT_SHIM=0, git's own trace2 log (one file per process, child
 * gits left out) counts them and the app runs its own git untouched, so
 * latencies are real; otherwise a `git` first on PATH runs the real one and then
 * writes `times` (its own and its waited children's CPU) and its argv to a fresh
 * file, which adds the CPU, plus a shell start per call. The shim runs the git
 * current main runs: past macOS's `/usr/bin/git` trampoline when a developer
 * dir holds one (v0.30.0 ran the trampoline, ~3.4 ms of CPU more per call).
 * `read()` returns every call since the counter was made, by log file name.
 */
async function gitCounter(
	dir: string,
): Promise<{ env: Record<string, string>; read: () => Promise<Map<string, { argv: string; cpu: number | null }>> }> {
	const log = path.join(dir, "git-log");
	await fs.mkdir(log, { recursive: true });
	const readAll = async (parse: (text: string) => { argv: string; cpu: number | null } | null) => {
		const calls = new Map<string, { argv: string; cpu: number | null }>();
		for (const name of await fs.readdir(log)) {
			const call = parse(await fs.readFile(path.join(log, name), "utf8"));
			if (call) calls.set(name, call);
		}
		return calls;
	};
	if (process.env.OMP_GUI_FLOW_GIT_SHIM === "0")
		return {
			env: { GIT_TRACE2_EVENT: log },
			read: () =>
				readAll(text => {
					const start = text.split("\n").find(line => line.includes('"event":"start"'));
					// A git a git started carries its parent's id before a slash.
					if (!start || /"sid":"[^"]*\//.test(start)) return null;
					const event: unknown = JSON.parse(start);
					const argv =
						event && typeof event === "object" && "argv" in event && Array.isArray(event.argv)
							? event.argv.map(String)
							: [];
					return { argv: argv.slice(1).join(" "), cpu: null };
				}),
		};
	// OMP_GUI_FLOW_GIT_REAL names the git the shim runs instead (e.g. /usr/bin/git, the trampoline a build
	// before the bypass ran).
	let real =
		process.env.OMP_GUI_FLOW_GIT_REAL || execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
	if (!process.env.OMP_GUI_FLOW_GIT_REAL && process.platform === "darwin" && real === "/usr/bin/git") {
		const developer = execFileSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8" }).trim();
		const direct = path.join(developer, "usr", "bin", "git");
		if (await fs.stat(direct).catch(() => null)) real = direct;
	}
	const bin = path.join(dir, "git-shim");
	await fs.mkdir(bin, { recursive: true });
	// Builtins only after git ran, so its children's time is git's alone; `times`
	// runs in the shim's own shell (a `$(…)` subshell would report a fresh child's zeros).
	await fs.writeFile(
		path.join(bin, "git"),
		`#!/bin/sh\n${JSON.stringify(real)} "$@"\nrc=$?\nn=0\nwhile [ -e ${JSON.stringify(log)}/$$.$n ]; do n=$((n + 1)); done\nout=${JSON.stringify(log)}/$$.$n\ntimes > "$out"\nprintf '%s\\n' "$*" >> "$out"\nexit $rc\n`,
		{ mode: 0o755 },
	);
	const seconds = (field: string) => {
		const match = /^(\d+)m([\d.]+)s$/.exec(field);
		return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
	};
	return {
		env: { PATH: [bin, process.env.PATH].join(path.delimiter) },
		read: () =>
			readAll(text => {
				// Line 1: the shim shell's user/system; line 2: its children's (git); line 3: argv.
				const [, children = "", argv = ""] = text.split("\n");
				const [user = "", system = ""] = children.split(" ");
				return { argv, cpu: seconds(user) + seconds(system) };
			}),
	};
}

/** zsh with an empty profile and a fixed prompt, so a terminal's start never times the user's dotfiles. */
async function quietShell(where: Profile): Promise<Record<string, string>> {
	const home = path.join(where.profile, "zdot");
	await fs.mkdir(home, { recursive: true });
	await fs.writeFile(path.join(home, ".zshrc"), "PS1='perf$ '\n");
	return { SHELL: "/bin/zsh", ZDOTDIR: home };
}

/**
 * Tell the page it is hidden (or visible again) the way the app reads it
 * (visibilityState / hidden and the visibilitychange event): Playwright's focus
 * emulation holds the page captured, so Chromium keeps it "visible" whatever the
 * window does. Timers stay unthrottled, so a hidden window is an upper bound of
 * the real hidden cost.
 */
async function setHidden(page: Page, hidden: boolean) {
	await page.evaluate(hidden => {
		if (hidden) {
			Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
			Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
		} else {
			Reflect.deleteProperty(document, "visibilityState");
			Reflect.deleteProperty(document, "hidden");
		}
		document.dispatchEvent(new Event("visibilitychange"));
	}, hidden);
}

/** frameWhen check: the side panel's terminal rows hold `text`. */
function terminalShows(text: string) {
	return (document.querySelector("aside[data-docked] .xterm-rows")?.textContent ?? "").includes(text)
		? performance.now()
		: 0;
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
						?.placeholder.startsWith("Ask anything ·")
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
				const stopTrace = await startTrace(page);
				// The first open after launch (the one the live-session audit times), then
				// a second with the bundle in the code cache, as every later open is.
				const cold = await reloadToTail(page, key);
				const coldFrames = await bootFrames(page, cold.paintedAt);
				await stopTrace(`open-${subject.name}-${run}`);
				await page.waitForTimeout(1000);
				const warm = await reloadToTail(page, key);
				const nav = await page.evaluate(() => {
					const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
					return { domContentLoaded: Math.round(entry?.domContentLoadedEventEnd ?? 0) };
				});
				// Where the view settles a second later: the transcript scroller's distance
				// from its bottom edge (0 = on the tail).
				await page.waitForTimeout(1000);
				const settledGap = await page.evaluate(key => {
					let node = document.querySelector(`[data-row-key=${JSON.stringify(key)}]`)?.parentElement ?? null;
					while (node && !/auto|scroll/.test(getComputedStyle(node).overflowY)) node = node.parentElement;
					return node ? Math.round(node.scrollHeight - node.clientHeight - node.scrollTop) : -1;
				}, key);
				if (process.env.OMP_GUI_FLOW_SHOTS)
					await page.screenshot({
						path: path.join(process.env.OMP_GUI_FLOW_SHOTS, `open-${subject.name}-${run}.png`),
					});
				return {
					coldMs: cold.openMs,
					coldPaintedAt: cold.paintedAt,
					warmMs: warm.openMs,
					warmPaintedAt: warm.paintedAt,
					settledGap,
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
				const stopTrace = await startTrace(page);
				const { openMs, paintedAt } = await reloadToTail(page, key);
				const rowsAt = await frameWhen(page, () =>
					document.querySelectorAll("[data-session-path]").length >= 500 ? performance.now() : 0,
				);
				await stopTrace(`sidebar-${subject.name}-${run}`);
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
				// Rows out of view skip rendering (content-visibility): a row must still
				// paint its hover wash, keyboard focus ring and switch-pending mark, and
				// arrow keys must bring an off-screen row into view.
				const shots = process.env.OMP_GUI_FLOW_SHOTS;
				let rows: object | undefined;
				if (shots) {
					const list = page.locator('.omp-session-sidebar [role="group"][aria-label="Sessions"]');
					const shot = (name: string) =>
						page.locator(".omp-session-sidebar").screenshot({
							path: path.join(shots, `sidebar-${subject.name}-${run}-${name}.png`),
						});
					// Whether the focused row lies fully inside the list's viewport.
					const focusInView = () =>
						list.evaluate(scroller => {
							const focused = document.activeElement?.closest(".omp-sidebar-session-row");
							if (!focused || !scroller.contains(focused)) return "no focused row";
							const box = focused.getBoundingClientRect();
							const view = scroller.getBoundingClientRect();
							return box.top >= view.top - 1 && box.bottom <= view.bottom + 1
								? "in view"
								: `out of view (${Math.round(box.top - view.top)}px)`;
						});
					await list.evaluate(scroller => scroller.scrollTo(0, 0));
					await list.locator(".omp-sidebar-session-row button[data-roving-item]").first().focus();
					for (let step = 0; step < 60; step++) await page.keyboard.press("ArrowDown");
					const afterArrows = await focusInView();
					await shot("focus-arrows");
					await page.keyboard.press("End");
					const afterEnd = await focusInView();
					await shot("focus-end");
					await page.keyboard.press("Home");
					for (let step = 0; step < 3; step++) await page.keyboard.press("ArrowDown");
					const afterHome = await focusInView();
					// A stretch of rows that was skipped until now: hover one, then mark one switch-pending.
					await list.evaluate(scroller => scroller.scrollTo(0, 9000));
					await page.waitForTimeout(300);
					// Tag the 4th and 8th rows fully on screen (a test-only attribute).
					await list.evaluate(scroller => {
						const view = scroller.getBoundingClientRect();
						const onScreen = [...scroller.querySelectorAll(".omp-sidebar-session-row")].filter(row => {
							const box = row.getBoundingClientRect();
							return box.top >= view.top && box.bottom <= view.bottom;
						});
						onScreen[3]?.setAttribute("data-flow-target", "hover");
						onScreen[7]?.setAttribute("data-flow-target", "pending");
					});
					const target = list.locator('[data-flow-target="hover"]');
					await target.hover();
					await page.waitForTimeout(300);
					// The wash, and the room the title makes for the revealed actions (the meta hides).
					const hoverWash = await target.evaluate(row => ({
						hovered: row.matches(":hover"),
						wash: getComputedStyle(row).backgroundColor,
						titlePadding: getComputedStyle(row.querySelector("button")?.parentElement ?? row).paddingRight,
						metaDisplay: getComputedStyle(row.querySelector("time")?.parentElement ?? row).display,
					}));
					await shot("hover");
					await page.mouse.move(5, 5);
					const pending = list.locator('[data-flow-target="pending"]');
					await pending.evaluate(row => row.setAttribute("data-switch-pending", "true"));
					const pendingMark = await pending.evaluate(row => getComputedStyle(row).boxShadow);
					await shot("switch-pending");
					await pending.evaluate(row => row.removeAttribute("data-switch-pending"));
					// Heights of plain session rows (no description) that skip rendering and
					// that render: a mismatch moves the rows on screen as rows above render
					// (the list turns off scroll anchoring).
					const heights = await list.evaluate(scroller => {
						const plain = [...scroller.querySelectorAll<HTMLElement>(".omp-sidebar-session-row")].filter(
							row => !row.querySelector(".text-sc-sm"),
						);
						const height = (rendered: boolean) =>
							[
								...new Set(
									plain
										.filter(row => row.checkVisibility({ contentVisibilityAuto: true }) === rendered)
										.map(row => row.getBoundingClientRect().height),
								),
							].slice(0, 4);
						return { skipped: height(false), rendered: height(true) };
					});
					rows = { afterArrows, afterEnd, afterHome, hoverWash, pendingMark, heights };
				}
				return { openMs, paintedAt, rowsAt, boot, scroll, typing, stream, rows };
			} finally {
				await exitApp(app);
			}
		});
	});

	test("compose: typing in the composer beside @file cards over the long session", async () => {
		test.skip(!flows.has("compose"));
		test.setTimeout(900_000);
		await eachRun("compose", async (subject, run, where) => {
			// One file of each kind a card reads: code, notes, a table and a PDF.
			await fs.mkdir(path.join(where.project, "src"), { recursive: true });
			await Promise.all([
				fs.writeFile(
					path.join(where.project, "src", "server.ts"),
					Array.from({ length: 3000 }, (_, line) => `export const handler${line} = () => ${line};`).join("\n"),
				),
				fs.writeFile(
					path.join(where.project, "notes.md"),
					Array.from({ length: 400 }, (_, line) => `- note ${line}: the server keeps its handlers apart`).join(
						"\n",
					),
				),
				fs.writeFile(
					path.join(where.project, "data.csv"),
					["id,name,value", ...Array.from({ length: 3000 }, (_, row) => `${row},row ${row},${row * 7}`)].join(
						"\n",
					),
				),
				fs.writeFile(path.join(where.project, "spec.pdf"), tinyPdf()),
			]);
			const seed = cloneSource(where);
			const key = await tailKey(seed);
			const { app, page } = await launch(subject.root, where, { seed });
			try {
				await sidecarReady(page);
				await countIpc(app);
				await reloadToTail(page, key);
				await page.waitForTimeout(1500);
				const input = page.locator('textarea[aria-label="Message"]').first();
				await input.click();
				// The draft names four files (a paste or picker insert lands the same way).
				const attach = await measure(app, page, `compose-${subject.name}-${run}-attach`, 4, () =>
					input.fill("Compare @src/server.ts with @notes.md, @data.csv and @spec.pdf "),
				);
				const cards = await page.locator('[data-draft-file-cards] [data-file-card][data-state="ready"]').count();
				const typing = await measure(app, page, `compose-${subject.name}-${run}-type`, 6, () =>
					input.pressSequentially("and say which handler the notes describe, then why.", { delay: 50 }),
				);
				const idle = await measure(app, page, `compose-${subject.name}-${run}-idle`, 10, undefined, { idle: true });
				await input.fill("");
				return { cards, attach, typing, idle };
			} finally {
				await exitApp(app);
			}
		});
	});

	test("background: idle cost of polling and watching work, on screen and hidden", async () => {
		test.skip(!flows.has("background"));
		test.setTimeout(1_200_000);
		// A page that logs an error and repaints a counter every second, as a dev
		// server's page with a failing poll does.
		const server = createServer((_request, response) => {
			response.writeHead(200, { "Content-Type": "text/html" });
			response.end(
				"<!doctype html><title>Chatty page</title><h1 id=n>0</h1><script>let n = 0; setInterval(() => { n++; document.getElementById('n').textContent = n; console.error('poll failed ' + n); }, 1000);</script>",
			);
		});
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", () => listening.resolve());
		await listening.promise;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No page server address");
		const url = `http://127.0.0.1:${address.port}/`;
		try {
			await eachRun("background", async (subject, run, where) => {
				// A git project (the status footer polls it) with files the draft names.
				await fs.mkdir(path.join(where.project, "src"), { recursive: true });
				await fs.writeFile(
					path.join(where.project, "src", "a.ts"),
					Array.from({ length: 400 }, (_, line) => `export const a${line} = ${line};`).join("\n"),
				);
				await fs.writeFile(path.join(where.project, "README.md"), "# Project\n\nNotes.\n");
				const git = (...args: string[]) =>
					execFileSync("git", ["-c", "user.name=flow", "-c", "user.email=flow@example.com", ...args], {
						cwd: where.project,
					});
				git("init", "--quiet");
				git("add", "-A");
				git("commit", "-qm", "init");
				// A fake OpenSSH (it lists the "server's" ports every 300 ms where a real
				// server's loop sleeps 5 s).
				const sshBin = path.join(where.profile, "ssh-bin");
				const ssh = await writeFakeSsh(sshBin);
				await fs.writeFile(path.join(sshBin, "ports"), "22 3000");
				const seed = cloneSource(where);
				const key = await tailKey(seed);
				const { app, page } = await launch(subject.root, where, {
					seed,
					// The usage pin on, with two signed-in accounts whose quota it shows.
					prefs: { language: "en", firstRunComplete: true, sidebar: { railPins: ["usage"] } },
					env: { OMP_GUI_TEST_LOGIN: "1", OMP_GUI_TEST_MODELS: "1", OMP_GUI_SSH: ssh },
				});
				try {
					await sidecarReady(page);
					await countIpc(app);
					await reloadToTail(page, key);
					await page.waitForTimeout(3000);
					const pid = app.process().pid;
					if (!pid) throw new Error("No main process id");
					const span = (name: string, seconds: number) =>
						measureTree(pid, () =>
							measure(app, page, `background-${subject.name}-${run}-${name}`, seconds, undefined, {
								idle: true,
							}),
						);
					const quiet = await span("quiet", 30);
					// The fake omp's own provider reports no quota, so the pin polls but draws no bars.
					const usagePin = await page.locator('[data-rail-pin="usage"]').count();

					const input = page.locator('textarea[aria-label="Message"]').first();
					await input.fill("Read @src/a.ts and @README.md ");
					await page.waitForTimeout(2000);
					const fileCards = await page
						.locator('[data-draft-file-cards] [data-file-card][data-state="ready"]')
						.count();
					const cards = await span("cards", 20);
					await input.fill("");

					const aside = page.locator("aside[data-docked]");
					await pressShortcutUntilVisible(page, "ControlOrMeta+j", aside);
					await aside.getByRole("button", { name: "Preview", exact: true }).click();
					const addressBar = aside.locator("form input[inputmode=url]");
					await addressBar.fill(url);
					await addressBar.press("Enter");
					await expect(page.locator("[data-preview-status]")).toHaveText("Chatty page", { timeout: 30_000 });
					await page.waitForTimeout(2000);
					const preview = await span("preview", 20);
					await page.keyboard.press("ControlOrMeta+j");
					await expect(aside).toBeHidden();
					await page.waitForTimeout(1000);
					const previewClosed = await span("preview-closed", 10);

					// The SSH port watch, with Settings closed (v0.29.0 on).
					const sshTools = await page.evaluate(() => "sshTools" in window.omp);
					let sshWatch: object | undefined;
					if (sshTools) {
						await page.evaluate(() =>
							window.omp.sshTools.command({
								action: "watch",
								target: { name: "box", host: "box.example" },
								on: true,
							}),
						);
						let promptId = "";
						await expect
							.poll(
								async () => {
									promptId = (await page.evaluate(() => window.omp.sshTools.prompts()))[0]?.id ?? "";
									return promptId;
								},
								{ timeout: 30_000 },
							)
							.not.toBe("");
						await page.evaluate(
							id => window.omp.sshTools.command({ action: "answer", id, value: "yes" }),
							promptId,
						);
						await expect
							.poll(
								async () =>
									(await page.evaluate(() => window.omp.sshTools.command({ action: "state" }))).watches[0]
										?.loading,
								{ timeout: 30_000 },
							)
							.toBe(false);
						await page.waitForTimeout(1000);
						sshWatch = await span("ssh-watch", 20);
					}

					// Nothing on screen: the window hidden, everything above still on.
					await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide());
					await setHidden(page, true);
					const hidden = await span("hidden", 30);
					await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.showInactive());
					return { usagePin, fileCards, quiet, cards, preview, previewClosed, sshWatch, hidden };
				} finally {
					await exitApp(app);
				}
			});
		} finally {
			server.close();
		}
	});

	test("panels: Changes on 500 changed files (open, idle git while shown and hidden), terminal, preview", async () => {
		test.skip(!flows.has("panels"));
		test.setTimeout(1_800_000);
		const server = createServer((request, response) => {
			response.writeHead(200, { "Content-Type": "text/html" });
			response.end(`<!doctype html><title>Preview page</title><h1>${request.url}</h1>`);
		});
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", () => listening.resolve());
		await listening.promise;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No page server address");
		const url = `http://127.0.0.1:${address.port}/`;
		try {
			await eachRun("panels", async (subject, run, where) => {
				// 500 committed files, every one of them modified.
				const files = Array.from({ length: 500 }, (_, index) => path.join(where.project, "src", `f${index}.ts`));
				await fs.mkdir(path.join(where.project, "src"), { recursive: true });
				await Promise.all(files.map((file, index) => fs.writeFile(file, `export const v${index} = ${index};\n`)));
				const git = (...args: string[]) =>
					execFileSync("git", ["-c", "user.name=flow", "-c", "user.email=flow@example.com", ...args], {
						cwd: where.project,
					});
				git("init", "--quiet");
				git("add", "-A");
				git("commit", "-qm", "init");
				await Promise.all(files.map((file, index) => fs.appendFile(file, `export const w${index} = ${index};\n`)));
				const counter = await gitCounter(where.profile);
				const seed = cloneSource(where);
				const key = await tailKey(seed);
				const { app, page } = await launch(subject.root, where, {
					seed,
					natives: true,
					env: { ...counter.env, ...(await quietShell(where)) },
				});
				try {
					await sidecarReady(page);
					await countIpc(app);
					await reloadToTail(page, key);
					await page.waitForTimeout(3000);
					const pid = app.process().pid;
					if (!pid) throw new Error("No main process id");
					// Git calls (and with the shim their CPU) inside a window, next to the app tree's CPU.
					const span = async (name: string, seconds: number) => {
						const before = await counter.read();
						const window = await measureTree(pid, () =>
							measure(app, page, `panels-${subject.name}-${run}-${name}`, seconds, undefined, { idle: true }),
						);
						const calls = [...(await counter.read())]
							.filter(([file]) => !before.has(file))
							.map(([, call]) => call);
						const perMinute = 60 / window.seconds;
						const cpu = calls.every(call => call.cpu !== null)
							? calls.reduce((sum, call) => sum + (call.cpu ?? 0), 0)
							: null;
						return {
							...window,
							gitPerMinute: Math.round(calls.length * perMinute * 10) / 10,
							gitCpuSecondsPerMinute: cpu === null ? null : Math.round(cpu * perMinute * 1000) / 1000,
							// By git subcommand (the word after the `-c key=value` options).
							gitCommands: Object.fromEntries(
								Object.entries(
									Object.groupBy(calls, call => {
										const words = call.argv.split(" ");
										for (let index = 0; index < words.length; index++) {
											if (words[index] === "-c") index++;
											else if (!words[index]?.startsWith("-")) return words[index] ?? "?";
										}
										return "?";
									}),
								).map(([command, list]) => [command, list?.length ?? 0]),
							),
						};
					};
					const aside = page.locator("aside[data-docked]");

					// Changes (the panel's default view), then idle on screen and hidden.
					let changesOpenMs = 0;
					const changesOpen = await measure(
						app,
						page,
						`panels-${subject.name}-${run}-changes-open`,
						1,
						async () => {
							await pressShortcutUntilVisible(page, "ControlOrMeta+j", aside);
							changesOpenMs = await inputToFrame(page, () =>
								document.querySelector("aside[data-docked] .omp-changes-list [data-staged]")
									? performance.now()
									: 0,
							);
						},
					);
					const changesRows = await page.locator("aside[data-docked] .omp-changes-list [data-staged]").count();
					await page.waitForTimeout(3000);
					const changesIdle = await span("changes-idle", 60);
					await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide());
					await setHidden(page, true);
					const changesHidden = await span("changes-hidden", 30);
					await setHidden(page, false);
					await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.showInactive());
					await page.waitForTimeout(2000);
					// Resident memory after each view first opened, to attribute growth.
					const rssAfterChanges = await treeRss(pid);

					// Terminal: first open (the worker and the shell start), idle, typing, reopen.
					const terminalButton = aside.getByRole("button", { name: "Terminal", exact: true });
					let terminalColdMs = 0;
					const terminalOpen = await measure(
						app,
						page,
						`panels-${subject.name}-${run}-terminal-open`,
						1,
						async () => {
							await terminalButton.click();
							terminalColdMs = await inputToFrame(page, terminalShows, "perf$ ");
						},
					);
					await page.waitForTimeout(2000);
					// Focused (the cursor blinks), then with focus in the composer (a steady cursor).
					const terminalIdle = await span("terminal-idle", 20);
					await page.locator('textarea[aria-label="Message"]').first().focus();
					await page.waitForTimeout(1000);
					const terminalIdleBlurred = await span("terminal-idle-blurred", 20);
					const echoMs: number[] = [];
					const typing = await measure(app, page, `panels-${subject.name}-${run}-terminal-type`, 1, async () => {
						for (let index = 1; index <= 5; index++) {
							await aside.locator(".xterm-helper-textarea").focus();
							await page.keyboard.type(`echo perf-${index}`, { delay: 30 });
							await page.keyboard.press("Enter");
							echoMs.push(
								await inputToFrame(
									page,
									marker => {
										const text = document.querySelector("aside[data-docked] .xterm-rows")?.textContent ?? "";
										return text.split(marker).length > 2 ? performance.now() : 0;
									},
									`perf-${index}`,
								),
							);
							await page.waitForTimeout(300);
						}
					});
					await aside.getByRole("button", { name: "Changes", exact: true }).click();
					await expect(aside.locator(".omp-changes-list [data-staged]").first()).toBeVisible({ timeout: 30_000 });
					await page.waitForTimeout(1000);
					await terminalButton.click();
					const terminalWarmMs = await inputToFrame(page, terminalShows, "perf-5");
					await page.waitForTimeout(1000);

					const rssAfterTerminal = await treeRss(pid);
					// Preview: the window's first page, then a second one.
					const previewMs: number[] = [];
					const previewOpen = await measure(
						app,
						page,
						`panels-${subject.name}-${run}-preview-open`,
						1,
						async () => {
							await aside.getByRole("button", { name: "Preview", exact: true }).click();
							const addressBar = aside.locator("form input[inputmode=url]");
							for (const target of [url, `${url}second`]) {
								await addressBar.fill(target);
								await addressBar.press("Enter");
								previewMs.push(
									await inputToFrame(
										page,
										title =>
											document.querySelector("[data-preview-status]")?.textContent === title
												? performance.now()
												: 0,
										"Preview page",
									),
								);
								await page.waitForTimeout(1500);
							}
						},
					);
					return {
						changesOpenMs,
						changesRows,
						changesOpen,
						changesIdle,
						changesHidden,
						terminalColdMs,
						terminalWarmMs,
						terminalOpen,
						terminalIdle,
						terminalIdleBlurred,
						echoMs,
						typing,
						previewMs,
						previewOpen,
						rss: { changes: rssAfterChanges, terminal: rssAfterTerminal, preview: await treeRss(pid) },
					};
				} finally {
					await exitApp(app);
				}
			});
		} finally {
			server.close();
		}
	});

	test("daily: work board, usage gauges and suggestions on a 1600 px window", async () => {
		test.skip(!flows.has("daily"));
		test.setTimeout(1_800_000);
		await eachRun("daily", async (subject, run, where) => {
			const seed = cloneSource(where);
			const key = await tailKey(seed);
			const { app, page } = await launch(subject.root, where, {
				seed,
				env: { OMP_GUI_TEST_LOGIN: "1", OMP_GUI_TEST_MODELS: "1" },
			});
			try {
				await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 1000));
				await sidecarReady(page);
				await countIpc(app);
				await reloadToTail(page, key);
				await page.waitForTimeout(3000);
				const pid = app.process().pid;
				if (!pid) throw new Error("No main process id");
				const first = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId;
				if (!first) throw new Error("No active tab");
				const control = (command: string) =>
					page.evaluate(command => window.omp.rpc.command({ type: "bash", command }), command);
				const span = (
					name: string,
					seconds: number,
					options: { idle?: boolean; during?: () => Promise<void> } = {},
				) =>
					measureTree(pid, () =>
						measure(app, page, `daily-${subject.name}-${run}-${name}`, seconds, options.during, {
							idle: options.idle ?? true,
						}),
					);
				const perMinute = (result: { ipcPerSecond: Record<string, number> }) =>
					Math.round(Object.values(result.ipcPerSecond).reduce((sum, rate) => sum + rate, 0) * 60);
				const board = page.locator("[data-work-board-panel]");
				await control("fixture:title:Pane A");
				// Three subscription accounts: the sidebar's and the board's usage gauges draw them.
				await control("fixture:usage-accounts:3");

				// A short turn, stopped: the board sums it up (last turn) beside the usage gauges.
				await page.evaluate(() => window.omp.rpc.command({ type: "prompt", message: "fixture stream" }));
				await page.waitForTimeout(2000);
				await page.evaluate(() => window.omp.rpc.command({ type: "abort" }));
				await page.waitForTimeout(3000);
				const boardIdle = await board.count();
				const idle = await span("idle", 60);
				await setHidden(page, true);
				const idleHidden = await span("idle-hidden", 30);
				await setHidden(page, false);
				await page.waitForTimeout(1000);

				// Streaming with the board live: steps, three agents, todos, a goal, a question.
				await page.evaluate(() => window.omp.rpc.command({ type: "prompt", message: "fixture stream" }));
				await control("fixture:board");
				await page.waitForTimeout(1500);
				const boardStream = await board.count();
				const stream = await span("stream", 15, { idle: false });
				await page.evaluate(() => window.omp.rpc.command({ type: "abort" }));
				await page.waitForTimeout(1500);
				// The agents keep running after the turn (the question still waits): the board's clocks tick.
				const agentsIdle = await span("agents-idle", 30);
				await setHidden(page, true);
				const agentsHidden = await span("agents-hidden", 30);
				await setHidden(page, false);
				for (const id of ["sa-explore", "sa-review", "sa-docs"]) await control(`fixture:subagents:finish:${id}`);
				await page.waitForTimeout(1500);

				// Typing with prompt suggestions (inline completion) on.
				const input = page.locator('textarea[aria-label="Message"]').first();
				await input.click();
				await input.fill("");
				const typing = await span("type", 8, {
					idle: false,
					during: () =>
						input.pressSequentially("please make each settings row read as one dense line", { delay: 60 }),
				});
				await input.fill("");

				// Switching between this session and a second one, by their sidebar rows.
				const spawned = await page.evaluate(cwd => window.omp.tabs.spawn({ cwd, kind: "agent" }), where.project);
				const second = spawned?.tabId;
				if (!second) throw new Error("expected a second tab");
				await expect
					.poll(
						async () =>
							(await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === second)?.status,
						{
							timeout: 120_000,
						},
					)
					.toBe("ready");
				await page.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:title:Pane B" }),
					second,
				);
				const rowOf = (title: string) => page.locator("[data-session-path]").filter({ hasText: title }).first();
				await expect(rowOf("Pane B")).toBeVisible({ timeout: 30_000 });
				const paneShows = (id: string) => {
					const ready: Ready = Reflect.get(window, "__ompReady");
					return ready.pane(id) ? performance.now() : 0;
				};
				const switchMs: number[] = [];
				const switching = await span("switch", 1, {
					idle: false,
					during: async () => {
						for (let turn = 0; turn < 3; turn++)
							for (const [title, id] of [
								["Pane B", second],
								["Pane A", first],
							] as const) {
								await rowOf(title).click();
								switchMs.push(await inputToFrame(page, paneShows, id));
								await page.waitForTimeout(800);
							}
					},
				});
				return {
					boardIdle,
					boardStream,
					ipcPerMinute: {
						idle: perMinute(idle),
						idleHidden: perMinute(idleHidden),
						agentsIdle: perMinute(agentsIdle),
					},
					idle,
					idleHidden,
					stream,
					agentsIdle,
					agentsHidden,
					typing,
					switchMs,
					switching,
				};
			} finally {
				await exitApp(app);
			}
		});
	});

	test("memory: a long simulated stream", async () => {
		test.skip(!flows.has("memory"));
		const minutes = Number(process.env.OMP_GUI_FLOW_MEMORY_MINUTES ?? 30);
		test.setTimeout((minutes + 10) * 60_000 * runs * subjects.length);
		await eachRun("memory", async (subject, run, where) => {
			const seed = cloneSource(where);
			const key = await tailKey(seed);
			const { app, page } = await launch(subject.root, where, {
				seed,
				natives: true,
				env: await quietShell(where),
			});
			try {
				await sidecarReady(page);
				// No frame probes in this document: the boot probe keeps one record per
				// frame (~4,000 arrays a cycle at 120 Hz) and was most of the heap growth
				// this flow measured.
				await frameWhen(
					page,
					key => (document.querySelector(`[data-row-key=${JSON.stringify(key)}]`) ? performance.now() : 0),
					key,
				);
				await page.waitForTimeout(2000);
				const pid = app.process().pid;
				if (!pid) throw new Error("No main process id");
				// A terminal open (then the panel closed), so both stock helper workers
				// live through the half hour.
				const aside = page.locator("aside[data-docked]");
				await pressShortcutUntilVisible(page, "ControlOrMeta+j", aside);
				await aside.getByRole("button", { name: "Terminal", exact: true }).click();
				await frameWhen(page, terminalShows, "perf$ ");
				await page.keyboard.press("ControlOrMeta+j");
				await expect(aside).toBeHidden();
				const control = (command: string) =>
					page.evaluate(command => window.omp.rpc.command({ type: "bash", command }), command);
				const stop = page.getByRole("button", { name: "Stop", exact: true });
				const samples: object[] = [{ minute: 0, cycles: 0, ...(await heap(page)), rss: await treeRss(pid) }];
				// OMP_GUI_FLOW_HEAP_SNAPSHOTS: a directory for two heap snapshots, one
				// after the first few cycles and one at the end, to diff what grows.
				const snapshots = process.env.OMP_GUI_FLOW_HEAP_SNAPSHOTS;
				const snapshotPath = (name: string) =>
					snapshots ? path.join(snapshots, `memory-${subject.name}-${run}-${name}.heapsnapshot`) : undefined;
				let earlySnapshot = false;
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
						const snapshot = !earlySnapshot && cycles >= 3 ? snapshotPath("early") : undefined;
						if (snapshot) earlySnapshot = true;
						samples.push({
							minute: Math.round((Date.now() - started) / 6000) / 10,
							cycles,
							...(await heap(page, snapshot)),
							rss: await treeRss(pid),
						});
						nextSample = Math.floor((Date.now() - started) / 60_000) + 1;
					}
				}
				samples.push({
					minute: Math.round((Date.now() - started) / 6000) / 10,
					cycles,
					...(await heap(page, snapshotPath("late"))),
					rss: await treeRss(pid),
				});
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
