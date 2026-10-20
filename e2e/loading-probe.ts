/**
 * The page-side probe of the no-loading audits (`no-loading.e2e.ts`): installed before the page's scripts, it
 * records what a person sees while the app comes up or switches. Pure observation, no app hooks.
 *
 * - `fcp`, `lcp`: paint entries (ms since navigation start).
 * - `bootAt`: the first frame that holds the page's own boot skeleton (`.boot-shell`, painted from HTML/CSS before
 *   any script). `shellAt`: the first frame that holds the React layout (`.omp-shell`). `splashUntil`: the frame the
 *   boot skeleton was replaced. `bootShift`: the largest distance (px) between the boot skeleton's sidebar, top bar
 *   and composer box and the React ones that replaced them (`null` when either never showed): the skeleton is the
 *   real layout when it is 0.
 * - `titleAt`: the first frame the title bar names a tab; `selectedAt`: the first frame the sidebar marks the open
 *   session (both come from the tab snapshot, before the tab list answers).
 * - `composerAt` / `composerResponsiveAt`: the composer input is in the DOM / a message posted after it ran.
 * - `rowAt`: the first transcript row painted.
 * - `cls`: layout shifts without a recent input (the Layout Instability API), summed.
 * - `spinnerMs`, `spinnerFrames`, `spinnerFirstAt`: frames in which a spinner (`.animate-spin`, an indeterminate
 *   progress bar) is shown, and the time they cover. `skeletonMs`: the same for the still skeletons.
 * - `blankFrames`: frames, after the first paint, in which `#root` shows neither the app's layout nor the brand
 *   mark (an empty window).
 * - `transcriptEmptyFrames`: frames in which a tab that is showing a transcript has none of its rows (the
 *   `data-probe-expect-rows` attribute a test sets on `<html>` while it expects rows).
 */
export const LOADING_PROBE = `(() => {
	if (window.__nl) return;
	const now = () => performance.now();
	const nl = (window.__nl = {
		fcp: null, lcp: null, bootAt: null, shellAt: null, shellFrame: null, splashUntil: null, titleAt: null, titleFrame: null, selectedAt: null, selectedFrame: null, bootShift: null, bootDetail: null, composerAt: null, composerResponsiveAt: null, rowAt: null,
		cls: 0, shifts: [], spinnerMs: 0, spinnerFrames: 0, spinnerFirstAt: null, skeletonMs: 0, skeletonFrames: 0,
		blankFrames: 0, transcriptEmptyFrames: 0, frames: 0, samples: [], spinners: [],
	});
	const observe = (type, fn, extra) => {
		try { new PerformanceObserver(list => list.getEntries().forEach(fn)).observe({ type, buffered: true, ...extra }); } catch {}
	};
	observe("paint", e => { if (e.name === "first-contentful-paint") nl.fcp = e.startTime; });
	observe("largest-contentful-paint", e => { nl.lcp = e.startTime; });
	observe("layout-shift", e => {
		if (e.hadRecentInput) return;
		nl.cls += e.value;
		nl.shifts.push([Math.round(e.startTime), Math.round(e.value * 10000) / 10000, (e.sources || []).map(s => s.node && (s.node.nodeName + "." + (s.node.className || "").toString().slice(0, 40))).filter(Boolean).slice(0, 2)]);
	});
	const shown = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
	const anyShown = selector => { for (const el of document.querySelectorAll(selector)) if (shown(el)) return true; return false; };
	const who = selector => {
		const found = [];
		for (const el of document.querySelectorAll(selector)) if (shown(el)) {
			const status = el.closest("[role=status]");
			const chain = [];
			for (let node = el, i = 0; node && node.nodeType === 1 && i < 6; node = node.parentElement, i++) chain.push(node.tagName.toLowerCase() + (node.dataset && Object.keys(node.dataset).length ? "[" + Object.keys(node.dataset)[0] + "]" : "") + (node.className && typeof node.className === "string" ? "." + node.className.split(" ")[0] : ""));
			found.push(((status && status.getAttribute("aria-label")) || (status && status.textContent || "").slice(0, 30)) + " < " + chain.join(" < "));
		}
		return found;
	};
	const GEOMETRY = [
		[".boot-shell .omp-session-sidebar", ".omp-shell .omp-session-sidebar"],
		[".boot-shell .omp-topbar", ".omp-shell .omp-topbar"],
		[".boot-shell .omp-composer-box", ".omp-shell .omp-composer-box"],
	];
	const rectOf = selector => { const el = document.querySelector(selector); if (!el) return null; const b = el.getBoundingClientRect(); return b.width > 0 || b.height > 0 ? [b.x, b.y, b.width, b.height] : null; };
	let bootRects = null;
	let last = 0;
	const tick = t => {
		const dt = last ? t - last : 0;
		last = t;
		nl.frames++;
		const root = document.getElementById("root");
		const boot = !!document.querySelector(".boot-shell");
		const splash = boot || (!!root && !!root.querySelector(".boot-mark"));
		const shell = !!document.querySelector(".omp-shell");
		if (boot && nl.bootAt === null) nl.bootAt = t;
		if (boot) bootRects = GEOMETRY.map(([b]) => rectOf(b));
		if (shell && nl.shellAt === null) { nl.shellAt = t; nl.shellFrame = nl.frames; }
		if (shell && nl.titleAt === null) { const id = document.querySelector(".omp-shell .omp-titlebar-identity"); if (id && (id.textContent || "").trim()) { nl.titleAt = t; nl.titleFrame = nl.frames; } }
		if (shell && nl.selectedAt === null && document.querySelector(".omp-shell .omp-session-sidebar [data-session-path][data-current]")) { nl.selectedAt = t; nl.selectedFrame = nl.frames; }
		if (shell && nl.bootShift === null && bootRects) {
			const reactRects = GEOMETRY.map(([, r]) => rectOf(r));
			// The composer box mounts a frame after the shell: wait for it; the sidebar is absent on a phone (both).
			if (reactRects[1] && reactRects[2]) {
				let worst = 0;
				GEOMETRY.forEach((_, i) => { const a = bootRects[i], b = reactRects[i]; if (a && b) for (let k = 0; k < 4; k++) worst = Math.max(worst, Math.abs(a[k] - b[k])); else if (!!a !== !!b) worst = Math.max(worst, 999); });
				nl.bootShift = Math.round(worst * 100) / 100; nl.bootDetail = JSON.stringify({ boot: bootRects, react: reactRects });
			}
		}
		if (!splash && nl.splashUntil === null && nl.frames > 1 && root && root.childElementCount > 0) nl.splashUntil = t;
		if (document.querySelector("[data-composer-input]") && nl.composerAt === null) {
			nl.composerAt = t;
			const channel = new MessageChannel();
			channel.port1.onmessage = () => { nl.composerResponsiveAt = now(); };
			channel.port2.postMessage(0);
		}
		if (nl.rowAt === null && document.querySelector("[data-transcript-kind]")) nl.rowAt = t;
		if (anyShown(".animate-spin, .omp-indeterminate-progress")) {
			nl.spinnerFrames++; nl.spinnerMs += dt;
			if (nl.spinnerFirstAt === null) nl.spinnerFirstAt = t;
			for (const name of who(".animate-spin, .omp-indeterminate-progress")) if (!nl.spinners.includes(name)) nl.spinners.push(name);
		}
		if (anyShown(".omp-skeleton")) { nl.skeletonFrames++; nl.skeletonMs += dt; }
		if (nl.fcp !== null && !splash && !shell) nl.blankFrames++;
		if (document.documentElement.dataset.probeExpectRows === "1" && !document.querySelector("[data-transcript-kind]")) nl.transcriptEmptyFrames++;
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
	nl.reset = () => { nl.cls = 0; nl.shifts = []; nl.spinnerMs = 0; nl.spinnerFrames = 0; nl.spinnerFirstAt = null; nl.skeletonMs = 0; nl.skeletonFrames = 0; nl.blankFrames = 0; nl.transcriptEmptyFrames = 0; nl.spinners = []; };
})();`;

export interface LoadingReading {
	fcp: number | null;
	lcp: number | null;
	bootAt: number | null;
	shellAt: number | null;
	/** Which sampled frame (1-based) `shellAt`, `titleAt` and `selectedAt` fell on: a slow machine's frames are long, their order is not. */
	shellFrame: number | null;
	titleFrame: number | null;
	selectedFrame: number | null;
	splashUntil: number | null;
	titleAt: number | null;
	selectedAt: number | null;
	bootShift: number | null;
	/** The rects behind `bootShift` (boot, then React), for a failing audit. */
	bootDetail: string | null;
	composerAt: number | null;
	composerResponsiveAt: number | null;
	rowAt: number | null;
	cls: number;
	shifts: Array<[number, number, string[]]>;
	spinnerMs: number;
	spinnerFrames: number;
	spinnerFirstAt: number | null;
	/** What the spinners that showed were (their status label). */
	spinners: string[];
	skeletonMs: number;
	skeletonFrames: number;
	blankFrames: number;
	transcriptEmptyFrames: number;
	frames: number;
	/** `performance.timeOrigin` of the document, for wall-clock comparisons with the harness. */
	timeOrigin: number;
}

declare global {
	interface Window {
		__nl?: LoadingReading & { reset: () => void };
	}
}

/** The probe's readings now (install `LOADING_PROBE` as an init script first). */
/** The one method the probe needs of a page: Playwright's Page and Electron's both have it. */
interface Evaluates {
	evaluate<R>(fn: () => R): Promise<R>;
}

export async function readLoading(page: Evaluates): Promise<LoadingReading> {
	return page.evaluate(() => {
		const nl = window.__nl;
		if (!nl) throw new Error("the loading probe is not installed");
		const { reset: _reset, ...reading } = nl;
		return { ...JSON.parse(JSON.stringify(reading)), timeOrigin: performance.timeOrigin } as LoadingReading;
	});
}
