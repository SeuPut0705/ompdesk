/**
 * The "work is going on" light (common/LiveEdge.tsx, components.css `.omp-live-edge`) on the dev harness: what the
 * eye sees, measured. A card's light (a running sidebar row) and the composer's must travel the box's edge as one
 * loop at an even speed along the edge, never vanishing at one end to reappear at the other; a state change
 * (running ↔ background) never moves it; a light that mounts later runs in step with those already running; it fades
 * out when the work ends; the Send ring holds still. `OMP_GUI_LIVE_LIGHT=<dir>` also writes frame strips.
 *
 * Geometry is read from pixels: every animation of the light is paused and stepped through one period, each step is
 * screenshotted, and the brightest pixel on the box's edge (against the same box with the light hidden) is the head.
 */
import * as fs from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { type Browser, chromium, expect, type Locator, type Page, test } from "@playwright/test";
import sharp from "sharp";
import { createServer, type ViteDevServer } from "vite";

const CAPTURES = process.env.OMP_GUI_LIVE_LIGHT;
const STEPS = 48;

let server: ViteDevServer | undefined;
let origin = "";
let browser: Browser | undefined;

async function freePort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const probe = createNetServer();
	probe.once("error", reject);
	probe.listen(0, "127.0.0.1", () => {
		const address = probe.address();
		const port = typeof address === "object" && address ? address.port : 0;
		probe.close(() => resolve(port));
	});
	return promise;
}

test.beforeAll(async () => {
	const port = await freePort();
	server = await createServer({
		configFile: path.resolve("vite.harness.config.ts"),
		server: { host: "127.0.0.1", port, strictPort: true },
		logLevel: "error",
	});
	await server.listen();
	origin = `http://127.0.0.1:${port}`;
	browser = await chromium.launch();
});

test.afterAll(async () => {
	await browser?.close();
	await server?.close();
});

async function openHarness(theme: "light" | "dark" = "light"): Promise<Page> {
	if (!browser) throw new Error("no browser");
	const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
	const page = await context.newPage();
	await page.goto(`${origin}/harness.html?theme=${theme}&lang=en`);
	await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
	await page.waitForFunction(() => window.__stores?.subagents !== undefined, undefined, { timeout: 45_000 });
	return page;
}

/** Sets tabs' fields by id (the sidebar rows follow the tab list). */
async function setTabs(page: Page, fields: Record<string, Record<string, unknown>>): Promise<void> {
	await page.evaluate(next => {
		const tabs = window.__stores?.tabs as unknown as {
			getState(): { tabs: { id: string }[] };
			setState(partial: unknown): void;
		};
		tabs.setState({ tabs: tabs.getState().tabs.map(tab => ({ ...tab, ...(next[tab.id] ?? {}) })) });
	}, fields);
}

async function setStreaming(page: Page, streaming: boolean): Promise<void> {
	await page.evaluate(value => {
		const session = window.__stores?.session as unknown as { setState(partial: unknown): void };
		session.setState({ isStreaming: value });
	}, streaming);
}

async function runSubagents(page: Page): Promise<void> {
	await page.evaluate(() => {
		const subagents = window.__stores?.subagents.getState() as { setSnapshots(rows: unknown[]): void };
		subagents.setSnapshots([
			{
				id: "r1",
				index: 1,
				agent: "task",
				assignment: "Title: Theme cleanup",
				status: "running",
				lastUpdate: Date.now(),
			},
		]);
	});
}

/** One frame of the light's position: the fraction of its loop each of its looping animations has run (a fade's
 * opacity transition is no part of the travel). */
async function phases(box: Locator): Promise<number[]> {
	return box.evaluate(element =>
		element
			.getAnimations({ subtree: true })
			.filter(animation => animation.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY)
			.map(animation => {
				const duration = Number(animation.effect?.getComputedTiming().duration ?? 1);
				const time = Number(animation.currentTime ?? 0);
				return (((time % duration) + duration) % duration) / duration;
			}),
	);
}

interface Head {
	/** Distance along the edge, clockwise from the top-left corner, in CSS px. */
	along: number;
	score: number;
}

/** The brightest pixel on the box's edge ring, against `reference` (the same box with the light hidden). */
function findHead(frame: Buffer, reference: Buffer, width: number, height: number): Head {
	const ring = 3;
	let best = { along: 0, score: -1 };
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const inset = Math.min(x, y, width - 1 - x, height - 1 - y);
			if (inset > ring) continue;
			const i = (y * width + x) * 4;
			const score =
				Math.abs(frame[i] - reference[i]) +
				Math.abs(frame[i + 1] - reference[i + 1]) +
				Math.abs(frame[i + 2] - reference[i + 2]);
			if (score <= best.score) continue;
			const edges = [y, width - 1 - x, height - 1 - y, x];
			const side = edges.indexOf(Math.min(...edges));
			const along =
				side === 0
					? x
					: side === 1
						? width + y
						: side === 2
							? width + height + (width - x)
							: 2 * width + height + (height - y);
			best = { along, score };
		}
	}
	return best;
}

/** Steps every animation of the light through one period and finds the head in each step. */
async function walk(
	page: Page,
	box: Locator,
	light: Locator,
	name: string,
): Promise<{ heads: Head[]; perimeter: number }> {
	const rect = await box.boundingBox();
	if (!rect) throw new Error("no box");
	const clip = {
		x: Math.floor(rect.x),
		y: Math.floor(rect.y),
		width: Math.ceil(rect.width),
		height: Math.ceil(rect.height),
	};
	const raw = async (): Promise<Buffer> =>
		sharp(await page.screenshot({ clip, scale: "css", animations: "allow" }))
			.ensureAlpha()
			.raw()
			.toBuffer();
	const period = await light.evaluate(element => {
		const animations = element.getAnimations({ subtree: true });
		for (const animation of animations) {
			animation.pause();
			(animation as Animation & { _start?: number })._start = Number(animation.currentTime ?? 0);
		}
		const loop = animations.find(
			animation => animation.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY,
		);
		return Number(loop?.effect?.getComputedTiming().duration ?? 8000);
	});
	await light.evaluate(element => element.style.setProperty("visibility", "hidden"));
	const reference = await raw();
	await light.evaluate(element => element.style.removeProperty("visibility"));
	const heads: Head[] = [];
	const frames: Buffer[] = [];
	for (let step = 0; step < STEPS; step++) {
		await light.evaluate(
			(element, at) => {
				for (const animation of element.getAnimations({ subtree: true })) {
					animation.currentTime = ((animation as Animation & { _start?: number })._start ?? 0) + at;
				}
			},
			(step * period) / STEPS,
		);
		await page.evaluate(() => {
			const { promise, resolve } = Promise.withResolvers<void>();
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			return promise;
		});
		const frame = await raw();
		heads.push(findHead(frame, reference, clip.width, clip.height));
		if (CAPTURES && step % 4 === 0) frames.push(await page.screenshot({ clip, scale: "css", animations: "allow" }));
	}
	if (CAPTURES) {
		await fs.mkdir(CAPTURES, { recursive: true });
		const strip = sharp({
			create: {
				width: clip.width * 2,
				height: (clip.height * 2 + 4) * frames.length,
				channels: 4,
				background: "#00000000",
			},
		}).composite(
			await Promise.all(
				frames.map(async (frame, index) => ({
					input: await sharp(frame)
						.resize(clip.width * 2, clip.height * 2)
						.toBuffer(),
					top: index * (clip.height * 2 + 4),
					left: 0,
				})),
			),
		);
		await strip.png().toFile(path.join(CAPTURES, `${name}-strip.png`));
	}
	await light.evaluate(element => {
		for (const animation of element.getAnimations({ subtree: true })) animation.play();
	});
	return { heads, perimeter: 2 * (clip.width + clip.height) };
}

/** Each step's move along the loop (wrapping at the perimeter). */
function moves(heads: Head[], perimeter: number): number[] {
	return heads.map((head, index) => {
		const next = heads[(index + 1) % heads.length] as Head;
		return (((next.along - head.along) % perimeter) + perimeter) % perimeter;
	});
}

test("a running row's light travels its whole edge as one loop at an even pace", async () => {
	test.setTimeout(120_000);
	const page = await openHarness();
	await setTabs(page, { "tab-1": { status: "running" } });
	const box = page.locator('.omp-session-sidebar .omp-sidebar-session-row[data-signal="running"]').first();
	await expect(box.locator(".omp-live-edge")).toHaveCount(1);
	await page.waitForTimeout(500);
	const { heads, perimeter } = await walk(page, box, box.locator(".omp-live-edge"), "row");
	for (const head of heads) expect(head.score, "the light is on the edge at every step").toBeGreaterThan(40);
	const steps = moves(heads, perimeter);
	const expected = perimeter / STEPS;
	// One loop: the head never jumps backwards or across the box (a teleport is a move of most of the perimeter).
	expect(Math.max(...steps), `moves ${steps.map(Math.round).join(",")}`).toBeLessThan(expected * 2.5);
	expect(steps.reduce((sum, step) => sum + step, 0)).toBeGreaterThan(perimeter * 0.9);
});

test("the composer's light keeps an even pace along every edge", async () => {
	test.setTimeout(120_000);
	const page = await openHarness();
	await setStreaming(page, true);
	const box = page.locator(".omp-composer-box").first();
	await expect(box.locator(".omp-live-edge")).toHaveCount(1);
	await page.waitForTimeout(500);
	const { heads, perimeter } = await walk(page, box, box.locator(".omp-live-edge"), "composer");
	const steps = moves(heads, perimeter);
	const expected = perimeter / STEPS;
	expect(Math.max(...steps), `moves ${steps.map(Math.round).join(",")}`).toBeLessThan(expected * 1.6);
	expect(Math.min(...steps), `moves ${steps.map(Math.round).join(",")}`).toBeGreaterThan(expected * 0.5);
});

test("a state change never moves the light, and a light that starts later runs in step", async () => {
	test.setTimeout(60_000);
	const page = await openHarness();
	await setTabs(page, { "tab-1": { status: "running" } });
	const lit = page.locator(".omp-session-sidebar .omp-sidebar-session-row:has(.omp-live-edge)");
	await expect(lit).toHaveCount(1);
	const first = lit.first().locator(".omp-live-edge");
	await page.waitForTimeout(1300);
	// running → background (its turn ended, background work still runs): the same light, dimmer, in place.
	const before = (await phases(first))[0] ?? 0;
	await setTabs(page, { "tab-1": { status: "running", settling: true } });
	await expect(first).toHaveAttribute("data-live-edge", "background");
	const after = (await phases(first))[0] ?? 0;
	const drift = Math.abs(after - before);
	// A frame or two of travel at most (8 s a loop: 0.004 a frame at 60 Hz, plus the round trip of this probe).
	expect(Math.min(drift, 1 - drift), `phase ${before} → ${after}`).toBeLessThan(0.02);
	// A second row starts later: its light is where the first one is.
	await setTabs(page, { "tab-2": { status: "running" } });
	await expect(lit).toHaveCount(2);
	const both = await Promise.all(
		(await lit.all()).map(async card => (await phases(card.locator(".omp-live-edge")))[0] ?? 0),
	);
	const apart = Math.abs((both[0] ?? 0) - (both[1] ?? 0));
	expect(Math.min(apart, 1 - apart), `phases ${both.join(", ")}`).toBeLessThan(0.02);
});

test("frame by frame, the light follows one clock through a state change, a wait, an end and a restart", async () => {
	test.setTimeout(60_000);
	const page = await openHarness();
	await setTabs(page, { "tab-1": { status: "running" } });
	await expect(page.locator(".omp-session-sidebar .omp-live-edge")).toHaveCount(1);
	await page.waitForTimeout(600);
	// Every frame for 3 s: the head's phase and the timeline time, while the row runs, turns to background work,
	// waits on the person, ends (the light fades out and goes) and starts again (a new light mounts).
	const samples = await page.evaluate(async () => {
		const tabs = window.__stores?.tabs as unknown as {
			getState(): { tabs: { id: string }[] };
			setState(partial: unknown): void;
		};
		const set = (fields: Record<string, unknown>) =>
			tabs.setState({
				tabs: tabs.getState().tabs.map(tab => (tab.id === "tab-1" ? { ...tab, ...fields } : tab)),
			});
		const steps: [number, Record<string, unknown>][] = [
			[400, { settling: true }],
			[900, { settling: false, awaitingInput: "input" }],
			[1300, { awaitingInput: undefined }],
			[1600, { status: "idle" }],
			[2200, { status: "running" }],
		];
		for (const [at, fields] of steps) setTimeout(() => set(fields), at);
		const out: { t: number; phase: number | null }[] = [];
		const { promise, resolve } = Promise.withResolvers<void>();
		const started = performance.now();
		const frame = () => {
			const edge = document.querySelector(".omp-session-sidebar .omp-live-edge");
			const loop = edge
				?.getAnimations({ subtree: true })
				.find(animation => animation.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY);
			const duration = Number(loop?.effect?.getComputedTiming().duration ?? 1);
			const time = Number(loop?.currentTime ?? 0);
			out.push({
				t: Number(document.timeline.currentTime),
				phase: loop && loop.playState === "running" ? (((time % duration) + duration) % duration) / duration : null,
			});
			if (performance.now() - started < 3000) requestAnimationFrame(frame);
			else resolve();
		};
		requestAnimationFrame(frame);
		await promise;
		return out;
	});
	const lit = samples.filter((sample): sample is { t: number; phase: number } => sample.phase !== null);
	expect(lit.length).toBeGreaterThan(60);
	// The light dropped out (the wait, the gap between end and restart) and came back.
	expect(lit.length).toBeLessThan(samples.length);
	const period = 8000;
	let worst = 0;
	for (let index = 1; index < lit.length; index++) {
		const a = lit[index - 1] as { t: number; phase: number };
		const b = lit[index] as { t: number; phase: number };
		const expected = ((b.t - a.t) / period) % 1;
		const moved = (((b.phase - a.phase) % 1) + 1) % 1;
		const off = Math.abs(moved - expected);
		worst = Math.max(worst, Math.min(off, 1 - off));
	}
	// Within one 120 Hz frame of travel of where the clock says, across every switch and the remount.
	expect(worst).toBeLessThan(1 / (period / 8));
});

test("the light fades out when the work ends, and the Send ring holds still", async () => {
	test.setTimeout(60_000);
	const page = await openHarness();
	await setTabs(page, { "tab-1": { status: "running" } });
	const lit = page.locator(".omp-session-sidebar .omp-sidebar-session-row:has(.omp-live-edge)");
	await expect(lit).toHaveCount(1);
	await page.waitForTimeout(400);
	await setTabs(page, { "tab-1": { status: "idle" } });
	await page.waitForTimeout(80);
	await expect(lit, "still on screen while it fades").toHaveCount(1);
	await expect(lit).toHaveCount(0, { timeout: 1500 });
	// Background work behind an idle turn: Send wears a ring, and nothing in it moves.
	await runSubagents(page);
	const ring = page.locator(".omp-composer-send-live[data-composer-live]");
	await expect(ring).toHaveCount(1);
	const moving = await ring.evaluate(
		element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === "running").length,
	);
	expect(moving).toBe(0);
});
