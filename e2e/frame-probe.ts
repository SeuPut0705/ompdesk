import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Page } from "@playwright/test";
import type { ElectronApplication } from "playwright";

// Shared renderer frame probes for the opt-in performance audits
// (live-session-performance.e2e.ts, flow-performance.e2e.ts).

/**
 * Renderer probes installed before the app's scripts: long frames, React commits,
 * slow input events (Event Timing: input to the next paint) and the time of the
 * latest key or pointer press, which interaction latencies are measured from.
 */
export const PROBE = `(() => {
	const perf = { commits: 0, longtasks: [], frames: [], events: [], lastInput: 0 };
	window.__ompPerf = perf;
	for (const type of ["keydown", "pointerdown"])
		window.addEventListener(type, event => { perf.lastInput = event.timeStamp; }, { capture: true });
	window.__ompReady = {
		// A tab's pane is on screen with transcript rows in it.
		pane(tabId) {
			const pane = document.querySelector('.omp-session-pane[data-tab-id="' + CSS.escape(tabId) + '"][data-active="true"]');
			const rows = pane && pane.querySelector(".omp-transcript-rows");
			return !!pane && pane.offsetWidth > 0 && !!rows && rows.childElementCount > 0;
		},
		// The right panel is open with its view routed, or gone.
		panel(state) {
			const panel = document.querySelector(".omp-inspector");
			return state === "open" ? !!panel && panel.getAttribute("aria-busy") !== "true" : !panel;
		},
	};
	new PerformanceObserver(list => {
		for (const entry of list.getEntries())
			perf.events.push({ at: entry.startTime, name: entry.name, duration: entry.duration });
	}).observe({ type: "event", durationThreshold: 16, buffered: true });
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

export interface Probe {
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
	events: { at: number; name: string; duration: number }[];
	lastInput: number;
}

/** The probe's interaction checks (`window.__ompReady`). */
export interface Ready {
	pane(tabId: string): boolean;
	panel(state: string): boolean;
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
export async function measure(
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
	// Every frame's interval, end to end (scripts, style, layout, paint, raster
	// waits): the gap between consecutive frame callbacks. A gap over 50 ms is a
	// frame the reader saw stall, whatever the main thread did inside it.
	await page.evaluate(() => {
		const raf = { deltas: [] as [number, number][], last: 0, running: true };
		const tick = (now: number) => {
			if (raf.last) raf.deltas.push([raf.last, now - raf.last]);
			raf.last = now;
			if (raf.running) requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
		Reflect.set(window, "__ompRaf", raf);
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
	const rafFrames = await page.evaluate(
		({ from, to }) => {
			const raf = Reflect.get(window, "__ompRaf") as { deltas: [number, number][]; running: boolean };
			raf.running = false;
			// Only intervals inside the window: the ones around it span the harness's own
			// setup and teardown (starting and flushing a trace stalls the renderer).
			const deltas = raf.deltas.filter(([at, ms]) => at >= from && at + ms <= to);
			const sorted = deltas.map(([, ms]) => ms).sort((a, b) => a - b);
			return {
				count: sorted.length,
				maxMs: Math.round(sorted.at(-1) ?? 0),
				p99Ms: Math.round(sorted[Math.floor(sorted.length * 0.99)] ?? 0),
				over33: sorted.filter(ms => ms > 34).length,
				over50: sorted.filter(ms => ms > 50).length,
				// The longest intervals, at their start (ms into the window).
				worst: [...deltas]
					.sort((a, b) => b[1] - a[1])
					.slice(0, 5)
					.map(([at, ms]) => `${Math.round(ms)}ms@${Math.round(at - from)}`),
			};
		},
		{ from: before.now, to: after.now },
	);
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
			const events = perf.events.filter(event => event.at >= from && event.at <= to);
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
						at: Math.round(frame.at - from),
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
				// Input to next paint, for inputs slower than 16 ms.
				inputMaxMs: Math.round(Math.max(0, ...events.map(event => event.duration))),
				inputOver50: events.filter(event => event.duration > 50).length,
				inputWorst: [...events]
					.sort((a, b) => b.duration - a.duration)
					.slice(0, 3)
					.map(event => `${Math.round(event.duration)}ms ${event.name}@${Math.round(event.at - from)}`),
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
		rafFrames,
		input: { maxMs: detail.inputMaxMs, over50: detail.inputOver50, worst: detail.inputWorst },
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
