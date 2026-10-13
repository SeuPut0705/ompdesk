import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

// Opt-in audit of the user's real shape: a very long session open while a live
// work card runs. OMP_GUI_LIVE_SESSION_SOURCE names a stock session file; the
// app only ever sees a private copy-on-write clone of it and its artifact dir.
// The fake omp serves that copy as its transcript and streams work frames, so
// no model is called. OMP_GUI_BASELINE_DIR (a checkout root holding a built
// `out/`) adds an interleaved "before" subject.

/** Renderer probes installed before the app's scripts: long frames and React commits. */
const PROBE = `(() => {
	const perf = { commits: 0, longtasks: [], frames: [] };
	window.__ompPerf = perf;
	window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
		supportsFiber: true,
		renderers: new Map(),
		inject() { return 1; },
		onCommitFiberRoot() { perf.commits++; },
		onCommitFiberUnmount() {},
		onPostCommitFiberRoot() {},
		onScheduleFiberRoot() {},
		setStrictMode() {},
		checkDCE() {},
	};
	new PerformanceObserver(list => {
		for (const entry of list.getEntries()) perf.longtasks.push({ at: entry.startTime, duration: entry.duration });
	}).observe({ type: "longtask", buffered: true });
	new PerformanceObserver(list => {
		for (const entry of list.getEntries())
			perf.frames.push({
				at: entry.startTime,
				duration: entry.duration,
				blocking: entry.blockingDuration,
				// Where a long frame went: render = rAF callbacks onward; styleLayout =
				// style, layout and paint (the remainder before render is tasks and scripts).
				render: entry.renderStart ? entry.startTime + entry.duration - entry.renderStart : 0,
				styleLayout: entry.styleAndLayoutStart ? entry.startTime + entry.duration - entry.styleAndLayoutStart : 0,
				scripts: entry.scripts.map(script => ({
					duration: script.duration,
					invoker: script.invoker,
					source: script.sourceURL.split("/").at(-1) + ":" + script.sourceCharPosition,
					fn: script.sourceFunctionName,
				})),
			});
	}).observe({ type: "long-animation-frame", buffered: true });
})();`;

interface Probe {
	commits: number;
	longtasks: { at: number; duration: number }[];
	frames: {
		at: number;
		duration: number;
		blocking: number;
		render: number;
		styleLayout: number;
		scripts: { duration: number; invoker: string; source: string; fn: string }[];
	}[];
}

interface Metrics {
	type: string;
	cpu: { cumulativeCPUUsage?: number };
	memory: { workingSetSize: number };
}

async function sample(app: ElectronApplication, page: Page) {
	const [{ metrics, ipc }, probe, now] = await Promise.all([
		app.evaluate(({ app }) => ({
			metrics: app.getAppMetrics() as unknown as Metrics[],
			ipc: { ...(Reflect.get(globalThis, "ompdeskIpcCounts") as Record<string, number> | undefined) },
		})),
		page.evaluate(() => {
			const perf = Reflect.get(window, "__ompPerf") as Probe;
			return { commits: perf.commits, longtasks: perf.longtasks.length, frames: perf.frames.length };
		}),
		page.evaluate(() => performance.now()),
	]);
	const cpu = (type: string) =>
		metrics
			.filter(metric => metric.type === type)
			.reduce((sum, metric) => sum + (metric.cpu.cumulativeCPUUsage ?? 0), 0);
	const memory = (type: string) =>
		metrics.filter(metric => metric.type === type).reduce((sum, metric) => sum + metric.memory.workingSetSize, 0);
	return {
		wall: Date.now(),
		now,
		main: cpu("Browser"),
		renderer: cpu("Tab"),
		gpu: cpu("GPU"),
		rendererKb: memory("Tab"),
		mainKb: memory("Browser"),
		ipc,
		...probe,
	};
}

/**
 * Measure one window of `seconds`, running `during` (if any) inside it. With
 * OMP_GUI_LIVE_SESSION_PROFILE (a directory) the window's renderer CPU profile
 * is written there as `<name>.cpuprofile`.
 */
async function measure(
	app: ElectronApplication,
	page: Page,
	name: string,
	seconds: number,
	during?: () => Promise<void>,
) {
	// Row churn inside the transcript canvas: how many row slots mount, how many
	// of them had already been mounted in this window or were mounted when it
	// began (remounts), the most mounted by one commit, and how many elements
	// appear inside rows that stayed mounted.
	await page.evaluate(() => {
		// Rows sit in the canvas, or in its rows layer (a fixed-size containing block).
		const outer = document.querySelector(".omp-transcript-canvas");
		const canvas = outer?.querySelector(":scope > .omp-transcript-rows") ?? outer;
		const mounted = canvas ? [...canvas.children].map(row => (row as HTMLElement).dataset.rowKey ?? "") : [];
		const churn = {
			rowMounts: 0,
			rowRemounts: 0,
			burst: 0,
			innerElements: 0,
			seen: new Set(mounted),
			mounts: [] as { at: number; rows: number }[],
		};
		const observer = new MutationObserver(records => {
			let batch = 0;
			for (const record of records)
				for (const node of record.addedNodes) {
					if (!(node instanceof HTMLElement)) continue;
					if (record.target === canvas) {
						const key = node.dataset.rowKey ?? "";
						batch++;
						churn.rowMounts++;
						if (churn.seen.has(key)) churn.rowRemounts++;
						churn.seen.add(key);
					} else churn.innerElements += 1 + node.getElementsByTagName("*").length;
				}
			churn.burst = Math.max(churn.burst, batch);
			if (batch) churn.mounts.push({ at: performance.now(), rows: batch });
		});
		if (canvas) observer.observe(canvas, { childList: true, subtree: true });
		Reflect.set(window, "__ompMounts", churn.mounts);
		Reflect.set(window, "__ompChurn", { churn, observer });
	});
	// OMP_GUI_LIVE_SESSION_STABILITY: after every painted frame, read the transcript as
	// it was painted (row transforms and the scroll offset; layout is clean then) and
	// record viewport pixels no row covered, and visible rows that moved up on screen
	// while the reader scrolls up (an anchoring jump). Off for timing runs: it reads
	// layout every frame.
	if (process.env.OMP_GUI_LIVE_SESSION_STABILITY)
		await page.evaluate(() => {
			const stability = {
				frames: 0,
				blankFrames: 0,
				paintedBlankFrames: 0,
				maxBlankPx: 0,
				jumpFrames: 0,
				maxJumpPx: 0,
				events: [] as string[],
				// Each row's last painted height by row kind, to compare with the estimates.
				heights: new Map<string, { kind: string; h: number }>(),
				running: true,
			};
			let last: Map<string, number> | null = null;
			const channel = new MessageChannel();
			// The viewport's uncovered pixels as the DOM stands now.
			const coverage = (scroller: HTMLElement, canvas: HTMLElement) => {
				const top = scroller.scrollTop;
				const bottom = Math.min(top + scroller.clientHeight, canvas.offsetHeight);
				const rows = [...(canvas.querySelector(":scope > .omp-transcript-rows") ?? canvas).children]
					.map(node => {
						const row = node as HTMLElement;
						// Rows sit at a transform (translateY, or the virtualizer's direct
						// translate3d) or at `top`.
						const y = row.style.transform
							? Number(/translate(?:Y\(|3d\([^,]+,\s*)(-?[\d.]+)px/.exec(row.style.transform)?.[1] ?? Number.NaN)
							: Number.parseFloat(row.style.top);
						const sized = { key: row.dataset.rowKey ?? "", y, h: row.offsetHeight };
						stability.heights.set(sized.key, {
							kind: `${row.dataset.transcriptKind ?? ""}${row.querySelector(".omp-user-turn") ? ":user" : ""}`,
							h: sized.h,
						});
						return sized;
					})
					.filter(row => Number.isFinite(row.y))
					.sort((a, b) => a.y - b.y);
				let covered = top;
				let blank = 0;
				let blankAt = -1;
				for (const row of rows) {
					if (row.y >= bottom) break;
					if (row.y > covered) {
						if (blankAt < 0) blankAt = covered - top;
						blank += row.y - covered;
					}
					covered = Math.max(covered, row.y + row.h);
				}
				if (covered < bottom) {
					if (blankAt < 0) blankAt = covered - top;
					blank += bottom - covered;
				}
				return { top, bottom, rows, blank, blankAt };
			};
			channel.port1.onmessage = () => {
				const scroller = document.querySelector<HTMLElement>(".omp-transcript-scroll");
				const canvas = scroller?.querySelector<HTMLElement>(".omp-transcript-canvas");
				if (scroller && canvas) {
					const { top, bottom, rows, blank, blankAt } = coverage(scroller, canvas);
					// This sample runs after a paint, but a task may have changed the DOM since
					// (a page commit whose offset lands on the next frame). Look again in a
					// frame callback queued now, which runs after the app's and right before
					// that frame paints: only a blank still there is one the reader saw.
					if (blank > 4)
						requestAnimationFrame(() => {
							if (coverage(scroller, canvas).blank > 4) stability.paintedBlankFrames++;
						});
					const visible = new Map(
						rows.filter(row => row.y + row.h > top && row.y < bottom).map(row => [row.key, row.y - top]),
					);
					let jump = 0;
					let jumpKey = "";
					if (last)
						for (const [key, screen] of visible) {
							const previous = last.get(key);
							if (previous !== undefined && previous - screen > jump) {
								jump = previous - screen;
								jumpKey = key;
							}
						}
					last = visible;
					stability.frames++;
					if (blank > 4) stability.blankFrames++;
					stability.maxBlankPx = Math.max(stability.maxBlankPx, Math.round(blank));
					if (jump > 2) stability.jumpFrames++;
					stability.maxJumpPx = Math.max(stability.maxJumpPx, Math.round(jump));
					if ((blank > 4 || jump > 2) && stability.events.length < 60)
						stability.events.push(
							`${Math.round(performance.now())} top=${Math.round(top)} rows=${rows.length}${blank > 4 ? ` blank=${Math.round(blank)}@${Math.round(blankAt)}` : ""}${jump > 2 ? ` jump=${Math.round(jump)} ${jumpKey}` : ""}`,
						);
				}
				if (stability.running) requestAnimationFrame(() => channel.port2.postMessage(0));
			};
			requestAnimationFrame(() => channel.port2.postMessage(0));
			Reflect.set(window, "__ompStability", stability);
		});
	const profileDir = process.env.OMP_GUI_LIVE_SESSION_PROFILE;
	const cdp = profileDir ? await page.context().newCDPSession(page) : undefined;
	if (cdp) {
		await cdp.send("Profiler.enable");
		await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
		await cdp.send("Profiler.start");
	}
	// OMP_GUI_LIVE_SESSION_TRACE (a directory) writes the window's Chrome trace as
	// `<name>.trace.json`: native work (IPC decode, GC, style, layout) by task.
	const traceDir = process.env.OMP_GUI_LIVE_SESSION_TRACE;
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
					"mojom",
					"blink",
					"devtools.timeline",
					"disabled-by-default-devtools.timeline",
					// Forced style and layout events then carry the JS stack that forced them.
					"disabled-by-default-devtools.timeline.stack",
					"v8",
					"v8.execute",
					"disabled-by-default-v8.gc",
					"disabled-by-default-v8.cpu_profiler",
				],
			},
		});
	}
	const before = await sample(app, page);
	await Promise.all([during?.(), page.waitForTimeout(seconds * 1000)]);
	const after = await sample(app, page);
	if (cdp && profileDir) {
		const { profile } = await cdp.send("Profiler.stop");
		await fs.mkdir(profileDir, { recursive: true });
		await fs.writeFile(path.join(profileDir, `${name}.cpuprofile`), JSON.stringify(profile));
		await cdp.detach();
	}
	if (tracer && traceDir) {
		const { promise: complete, resolve } = Promise.withResolvers<void>();
		tracer.once("Tracing.tracingComplete", () => resolve());
		await tracer.send("Tracing.end");
		await complete;
		await fs.mkdir(traceDir, { recursive: true });
		await fs.writeFile(path.join(traceDir, `${name}.trace.json`), JSON.stringify({ traceEvents }));
		await tracer.detach();
	}
	const elapsed = (after.wall - before.wall) / 1000;
	const churn = await page.evaluate(() => {
		const { churn, observer } = Reflect.get(window, "__ompChurn") as {
			churn: { rowMounts: number; rowRemounts: number; burst: number; innerElements: number; seen: Set<string> };
			observer: MutationObserver;
		};
		observer.disconnect();
		return {
			rowMounts: churn.rowMounts,
			rowRemounts: churn.rowRemounts,
			largestMountBurst: churn.burst,
			distinctRows: churn.seen.size,
			innerElements: churn.innerElements,
		};
	});
	const stability = await page.evaluate(() => {
		const probe = Reflect.get(window, "__ompStability") as
			| { running: boolean; heights: Map<string, { kind: string; h: number }> }
			| undefined;
		if (!probe) return undefined;
		probe.running = false;
		const { running: _running, heights, ...result } = probe;
		const byKind = Object.groupBy(heights.values(), row => row.kind);
		const sizes = Object.fromEntries(
			Object.entries(byKind).map(([kind, rows = []]) => {
				const sorted = rows.map(row => row.h).sort((a, b) => a - b);
				const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
				return [kind, `n=${sorted.length} p10=${at(0.1)} p50=${at(0.5)} p90=${at(0.9)}`];
			}),
		);
		return { ...result, sizes };
	});
	const detail = await page.evaluate(
		({ from, to }) => {
			const perf = Reflect.get(window, "__ompPerf") as Probe;
			// Commit times of row mounts, set when the window began (in-page probe state).
			const mounts = Reflect.get(window, "__ompMounts") as { at: number; rows: number }[];
			const frames = perf.frames.filter(frame => frame.at >= from && frame.at <= to);
			const longtasks = perf.longtasks.filter(task => task.at >= from && task.at <= to);
			const scripts = new Map<string, number>();
			for (const frame of frames)
				for (const script of frame.scripts) {
					const key = `${script.invoker} ${script.fn}@${script.source}`;
					scripts.set(key, (scripts.get(key) ?? 0) + script.duration);
				}
			return {
				longFrames: frames.length,
				longFrameMs: Math.round(frames.reduce((sum, frame) => sum + frame.duration, 0)),
				blockingMs: Math.round(frames.reduce((sum, frame) => sum + frame.blocking, 0)),
				renderMs: Math.round(frames.reduce((sum, frame) => sum + frame.render, 0)),
				styleLayoutMs: Math.round(frames.reduce((sum, frame) => sum + frame.styleLayout, 0)),
				worstFrameMs: Math.round(Math.max(0, ...frames.map(frame => frame.duration))),
				worstFrames: [...frames]
					.sort((a, b) => b.duration - a.duration)
					.slice(0, 3)
					.map(frame => ({
						ms: Math.round(frame.duration),
						blocking: Math.round(frame.blocking),
						render: Math.round(frame.render),
						styleLayout: Math.round(frame.styleLayout),
						// Row slots mounted by commits inside this frame.
						rowsMounted: mounts
							.filter(mount => mount.at >= frame.at && mount.at <= frame.at + frame.duration)
							.reduce((sum, mount) => sum + mount.rows, 0),
						scripts: frame.scripts.map(
							script => `${Math.round(script.duration)}ms ${script.invoker} ${script.fn}@${script.source}`,
						),
					})),
				longtasks: longtasks.length,
				longtaskMs: longtasks.map(task => Math.round(task.duration)).sort((a, b) => b - a),
				topScripts: [...scripts]
					.sort((a, b) => b[1] - a[1])
					.slice(0, 6)
					.map(([key, ms]) => `${Math.round(ms)}ms ${key}`),
				// What keeps compositing and painting while nothing else changes.
				animations: Object.entries(
					Object.groupBy(
						document.getAnimations().filter(animation => animation.playState === "running"),
						animation => {
							const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
							const kind =
								animation instanceof CSSAnimation
									? animation.animationName
									: animation instanceof CSSTransition
										? `transition:${animation.transitionProperty}`
										: "script";
							const owner = target?.parentElement
								?.closest("[class*='omp-']")
								?.getAttribute("class")
								?.split(" ")[0];
							return `${kind} on ${target?.getAttribute("class")?.split(" ")[0] ?? target?.tagName ?? "?"} in ${owner ?? "?"}`;
						},
					),
				).map(([key, list]) => `${list?.length ?? 0}× ${key}`),
			};
		},
		{ from: before.now, to: after.now },
	);
	const per10 = 10 / elapsed;
	return {
		seconds: Math.round(elapsed * 10) / 10,
		rendererCpuPct: Math.round(((after.renderer - before.renderer) / elapsed) * 1000) / 10,
		mainCpuPct: Math.round(((after.main - before.main) / elapsed) * 1000) / 10,
		gpuCpuPct: Math.round(((after.gpu - before.gpu) / elapsed) * 1000) / 10,
		commitsPerSecond: Math.round(((after.commits - before.commits) / elapsed) * 10) / 10,
		longtasksPer10s: Math.round(detail.longtasks * per10 * 10) / 10,
		longtasks: detail.longtasks,
		longtaskMs: detail.longtaskMs,
		longFramesPer10s: Math.round(detail.longFrames * per10 * 10) / 10,
		blockingMsPer10s: Math.round(detail.blockingMs * per10),
		worstFrameMs: detail.worstFrameMs,
		worstFrames: detail.worstFrames,
		churn,
		...(stability ? { stability } : {}),
		// Of the long frames' time: total, rAF-onward, and style/layout/paint.
		longFrameMsSplit: { total: detail.longFrameMs, render: detail.renderMs, styleLayout: detail.styleLayoutMs },
		rendererMb: Math.round(after.rendererKb / 1024),
		mainMb: Math.round(after.mainKb / 1024),
		topScripts: detail.topScripts,
		animations: detail.animations,
		// Main → renderer sends and renderer → main invokes, per channel per second.
		ipcPerSecond: Object.fromEntries(
			Object.entries(after.ipc)
				.map(([channel, count]) => [
					channel,
					Math.round(((count - (before.ipc[channel] ?? 0)) / elapsed) * 10) / 10,
				])
				.filter(([, rate]) => Number(rate) > 0),
		),
	};
}

test("long real session with a live work card: open, scroll, idle and streaming cost", async () => {
	const source = process.env.OMP_GUI_LIVE_SESSION_SOURCE;
	test.skip(!source, "Explicit isolated live-session audit");
	if (!source) return;
	test.setTimeout(1_800_000);
	const runs = Number(process.env.OMP_GUI_LIVE_SESSION_RUNS ?? 2);
	const journal = (await fs.readFile(source, "utf8")).split("\n").filter(Boolean);
	const tail = journal
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
	const tailKey = `message-assistant-${tail.message.timestamp}`;
	const subjects = [
		{ name: "after", root: process.env.OMP_GUI_CANDIDATE_DIR ?? process.cwd() },
		...(process.env.OMP_GUI_BASELINE_DIR ? [{ name: "before", root: process.env.OMP_GUI_BASELINE_DIR }] : []),
	];
	const results: object[] = [];
	for (let run = 0; run < runs; run++)
		for (const subject of run % 2 ? [...subjects].reverse() : subjects) {
			const profile = await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-live-session-"));
			await fs.chmod(profile, 0o700);
			const project = path.join(profile, "project");
			const desktop = path.join(profile, "desktop");
			const agent = path.join(profile, "agent");
			const sessions = path.join(agent, "sessions", "-live-session-audit");
			await Promise.all([project, desktop, sessions].map(dir => fs.mkdir(dir, { recursive: true, mode: 0o700 })));
			const copy = path.join(sessions, path.basename(source));
			// APFS clones: instant, private, and the source is only ever read.
			execFileSync("cp", ["-c", source, copy]);
			const artifacts = source.slice(0, -".jsonl".length);
			if (await fs.stat(artifacts).catch(() => undefined)) execFileSync("cp", ["-c", "-R", artifacts, sessions]);
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
				OMP_GUI_OMP: await fixtureOmp(profile),
				OMP_GUI_TEST_SEED_SESSION: copy,
			};
			Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
			const app = await electron.launch({
				args: [path.join(subject.root, "out/main/index.js"), project, `--user-data-dir=${desktop}`],
				env,
			});
			const errors: string[] = [];
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
				// Test-only wrapping at the IPC seam: count messages per channel (and an RPC
				// command's `type`), never their content.
				await app.evaluate(({ BrowserWindow, ipcMain }) => {
					const counts: Record<string, number> = {};
					Reflect.set(globalThis, "ompdeskIpcCounts", counts);
					const contents = BrowserWindow.getAllWindows()[0]?.webContents;
					if (!contents) throw new Error("No window to measure");
					const send = contents.send.bind(contents);
					contents.send = (channel: string, ...args: unknown[]) => {
						counts[channel] = (counts[channel] ?? 0) + 1;
						send(channel, ...args);
					};
					type Handler = (...args: unknown[]) => unknown;
					const handlers = Reflect.get(ipcMain, "_invokeHandlers") as Map<string, Handler> | undefined;
					if (!(handlers instanceof Map)) throw new Error("Electron IPC measurement seam unavailable");
					for (const [channel, original] of handlers)
						handlers.set(channel, (...args: unknown[]) => {
							// RPC commands travel as `{ command }` (per tab) or bare.
							const payload = args[1];
							const command = Reflect.get(Object(payload), "command") ?? payload;
							const type = Reflect.get(Object(command), "type");
							const key = typeof type === "string" ? `invoke:${channel}:${type}` : `invoke:${channel}`;
							counts[key] = (counts[key] ?? 0) + 1;
							return original(...args);
						});
				});
				await page.context().addInitScript(PROBE);
				const opened = performance.now();
				await page.reload();
				await expect(page.locator(`[data-row-key=${JSON.stringify(tailKey)}]`)).toBeVisible({ timeout: 120_000 });
				const openMs = Math.round(performance.now() - opened);
				// What-if knob: OMP_GUI_LIVE_SESSION_CSS adds a stylesheet (e.g. one animation
				// switched off) so a window's cost can be attributed to it.
				if (process.env.OMP_GUI_LIVE_SESSION_CSS)
					await page.addStyleTag({ content: process.env.OMP_GUI_LIVE_SESSION_CSS });
				const cdp = await page.context().newCDPSession(page);
				await cdp.send("HeapProfiler.collectGarbage");
				const openHeapMb = Math.round((await cdp.send("Runtime.getHeapUsage")).usedSize / 1048576);
				await page.waitForTimeout(2000);
				// OMP_GUI_LIVE_SESSION_PHASES=scroll measures only the history scroll.
				const scrollOnly = process.env.OMP_GUI_LIVE_SESSION_PHASES === "scroll";
				const idle = scrollOnly ? undefined : await measure(app, page, `${subject.name}-${run}-idle`, 10);
				// Scroll up through history: the virtualizer mounts and measures new rows.
				const scroller = page.locator(".omp-transcript-scroll").first();
				const box = await scroller.boundingBox();
				if (!box) throw new Error("No transcript scroller");
				// Wheel in the transcript's left gutter: over the column a card's own scroller
				// (overscroll-behavior: contain) can sit under the pointer and swallow the
				// wheel once it reaches its top, which stalled the scroll mid-history.
				const pointer = { x: box.x + 12, y: box.y + box.height / 2 };
				await page.mouse.move(pointer.x, pointer.y);
				// OMP_GUI_LIVE_SESSION_WHEEL_STEPS shortens the scroll, e.g. to stop before
				// history a baseline cannot reach.
				const wheelSteps = Number(process.env.OMP_GUI_LIVE_SESSION_WHEEL_STEPS ?? 60);
				const scroll = await measure(app, page, `${subject.name}-${run}-scroll`, 8, async () => {
					for (let step = 0; step < wheelSteps; step++) {
						await page.mouse.wheel(0, -700);
						await page.waitForTimeout(100);
					}
				});
				// How far through history the scroll got (scrollTop / canvas height), so runs
				// that loaded different pages are told apart. Read after the window: a
				// read during it forces a layout of its own.
				const reached = await page.evaluate(({ x, y }) => {
					const element = document.querySelector(".omp-transcript-scroll");
					const canvas = element?.querySelector<HTMLElement>(".omp-transcript-canvas");
					const chain: string[] = [];
					for (
						let under = document.elementFromPoint(x, y);
						under && under !== element;
						under = under.parentElement
					) {
						const style = getComputedStyle(under);
						if (style.overflowY === "auto" || style.overflowY === "scroll")
							chain.push(
								`${under.className.split(" ")[0]}:${under.scrollTop}/${under.scrollHeight}/${under.clientHeight}:${style.overscrollBehaviorY}`,
							);
					}
					const status = document.querySelector("[data-testid=transcript-history-status]")?.textContent;
					return `${Math.round(element?.scrollTop ?? 0)}/${canvas?.style.height} under=[${chain.join(",")}] status=${status}`;
				}, pointer);
				const live = scrollOnly
					? undefined
					: await (async () => {
							await page.getByRole("button", { name: "Jump to latest" }).click();
							await expect(page.locator(`[data-row-key=${JSON.stringify(tailKey)}]`)).toBeVisible();
							const control = (command: string) =>
								page.evaluate(command => window.omp.rpc.command({ type: "bash", command }), command);
							// The stock session keeps growing while the run streams; main's index watches it.
							const appendJournal = async (seconds: number) => {
								const until = Date.now() + seconds * 1000;
								const line = journal[journal.length - 1];
								while (Date.now() < until) {
									await fs.appendFile(copy, `${line}\n`);
									await delay(250);
								}
							};
							const input = page.locator("textarea").first();
							await input.fill("fixture work view");
							await input.press("Enter");
							await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible({
								timeout: 30_000,
							});
							await control("fixture:work-next");
							const card = page.locator('.omp-execution-group > .omp-live-step[data-state="running"]');
							await expect(card).toHaveAttribute("data-surface", "bash", { timeout: 30_000 });
							await control("fixture:work-stream");
							const streamOutput = await measure(app, page, `${subject.name}-${run}-stream-output`, 10, () =>
								appendJournal(10),
							);
							for (let step = 0; step < 3; step++) await control("fixture:work-next");
							await expect(card.locator('[data-step-id="work-view-3"]')).toHaveAttribute("aria-pressed", "true");
							await control("fixture:work-output");
							await page.waitForTimeout(1000);
							const cardIdle = await measure(app, page, `${subject.name}-${run}-card-idle`, 10);
							await control("fixture:work-stream");
							const streamAgents = await measure(app, page, `${subject.name}-${run}-stream-agents`, 10, () =>
								appendJournal(10),
							);
							return { streamOutput, cardIdle, streamAgents };
						})();
				await cdp.send("HeapProfiler.collectGarbage");
				const endHeapMb = Math.round((await cdp.send("Runtime.getHeapUsage")).usedSize / 1048576);
				if (live) await page.evaluate(() => window.omp.rpc.command({ type: "abort" }));
				await cdp.detach();
				const result = {
					subject: subject.name,
					run,
					openMs,
					openHeapMb,
					endHeapMb,
					idle,
					scroll: { ...scroll, reached },
					...live,
					errors,
				};
				results.push(result);
				console.log(JSON.stringify(result));
				await fs.mkdir("test-results", { recursive: true });
				await fs.writeFile(
					process.env.OMP_GUI_LIVE_SESSION_OUT ?? "test-results/live-session-performance.json",
					JSON.stringify(results, null, 2),
				);
				expect(errors).toEqual([]);
			} finally {
				await exitApp(app);
				await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		}
});
