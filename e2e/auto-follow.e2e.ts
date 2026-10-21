import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { exitApp, launchApp } from "./harness";

/** Distance from the bottom that still counts as "riding the live edge". Row
 * re-measurement during streaming overshoots a few pixels, so this is deliberately
 * looser than the app's own slack while still ruling out a stranded view. */
const LIVE_EDGE_PX = 200;

/** The app's own live-edge slack: with the stream held still, a pinned view has
 * nothing left to chase, so it must sit flush with the bottom. */
const SETTLED_EDGE_PX = 24;

async function withFollowApp(body: (app: ElectronApplication, page: Page) => Promise<void>): Promise<void> {
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-follow-"));
	const desktop = path.join(profile, "desktop"),
		agent = path.join(profile, "agent"),
		project = path.join(profile, "project");
	await Promise.all([fs.mkdir(desktop), fs.mkdir(agent), fs.mkdir(project)]);
	// The work board would show the todos beside the transcript and their dock strip would step aside; these tests
	// need the dock between transcript and composer. The board has no setting any more (b793deb8d retired the
	// `workBoard` pref this spec still wrote), so the window is one the board does not dock in (a 1280 px window
	// beside the sidebar leaves the pane under `workBoardFits`' 1137 px), as composer-toolbar's is.
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en" }));
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		// Enough history that an abort leaves something to scroll up through, which is
		// the state a reader is actually in when they send the next message.
		env: { OMP_GUI_TEST_HISTORY: "300" },
	});
	try {
		const page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
		await body(app, page);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
}

function followProbe(page: Page) {
	const scroll = page.locator(".omp-transcript-scroll");
	const input = page.locator("textarea").first();
	const gap = () => scroll.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight);
	const height = () => scroll.evaluate(node => node.scrollHeight);
	const viewport = () => scroll.evaluate(node => node.clientHeight);
	const jump = page.getByRole("button", { name: "Jump to latest", exact: true });
	// The control is always mounted and fades out while pinned, so Playwright's
	// visibility check cannot tell "offered" from "hidden"; interactivity can.
	const jumpOffered = () => jump.evaluate(node => getComputedStyle(node).pointerEvents !== "none");
	const send = async (text: string) => {
		await input.fill(text);
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
	};
	const abort = async () => {
		await page.getByRole("button", { name: "Stop", exact: true }).click();
		await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
	};
	const fixture = (line: string) => page.evaluate(command => window.omp.rpc.bash(command), line);
	const scrollUp = async () => {
		await scroll.hover();
		await page.mouse.wheel(0, -1500);
		await expect.poll(jumpOffered).toBe(true);
		// The wheel scroll can still be animating when the control is offered.
		await expect.poll(gap).toBeGreaterThan(LIVE_EDGE_PX);
		// Rows the scroll brought into view are measured over the next frames, which
		// re-sizes the transcript against the estimates (hundreds of px with 300 rows of
		// history); a reader's position has settled once the offset stops moving.
		let lastTop = Number.NaN;
		let stillSamples = 0;
		await expect
			.poll(
				async () => {
					const top = await scroll.evaluate(node => node.scrollTop);
					stillSamples = top === lastTop ? stillSamples + 1 : 0;
					lastTop = top;
					return stillSamples;
				},
				{ timeout: 5_000, intervals: [60] },
			)
			.toBeGreaterThanOrEqual(5);
	};
	// The fixture streams a chunk every 16ms, so a handful of samples proves
	// sustained following rather than one lucky frame.
	const ridesTheStream = async (ticks: number) => {
		const trace: string[] = [];
		let growth = 0;
		let previousHeight = 0;
		// A reclaim converges on the tail over a few frames, so the first sample
		// would otherwise measure the edge moving away faster than the chase closes.
		await expect.poll(gap, { timeout: 3_000, intervals: [50] }).toBeLessThan(LIVE_EDGE_PX);
		for (let tick = 0; tick < ticks; tick++) {
			// Sample what the next frame paints: after its layout and resize
			// observers, where the app pins the tail. A read in the animation-frame
			// callback itself precedes that, so it sees whatever text landed since
			// the previous frame unpinned — on a slow renderer a whole batch of it.
			// A ResizeObserver created now reports its first observation after every
			// earlier observer in the same frame.
			const [distance, measured] = await scroll.evaluate(
				node =>
					new Promise<[number, number]>(resolve =>
						requestAnimationFrame(() => {
							const probe = new ResizeObserver(() => {
								probe.disconnect();
								resolve([node.scrollHeight - node.scrollTop - node.clientHeight, node.scrollHeight]);
							});
							probe.observe(node);
						}),
					),
			);
			if (previousHeight && measured > previousHeight) growth++;
			previousHeight = measured;
			trace.push(`${distance}@${measured}`);
			expect(distance, `gap@height trace ${trace.join(" → ")}`).toBeLessThan(LIVE_EDGE_PX);
			await page.waitForTimeout(120);
		}
		// Without real growth the loop would only prove an idle view stands still.
		expect(growth, `gap@height trace ${trace.join(" → ")}`).toBeGreaterThan(ticks / 3);
	};
	// A reader who scrolled up owns the viewport: the distance from the bottom may
	// only grow while content arrives, never shrink back toward the live edge.
	const holdsPosition = async (ticks: number) => {
		const gaps: number[] = [];
		for (let tick = 0; tick < ticks; tick++) {
			gaps.push(await gap());
			await page.waitForTimeout(80);
		}
		for (let tick = 1; tick < gaps.length; tick++) {
			expect(gaps[tick], `gap trace ${gaps.join(" → ")}`).toBeGreaterThanOrEqual(gaps[tick - 1] - 4);
		}
		expect(gaps[gaps.length - 1], `gap trace ${gaps.join(" → ")}`).toBeGreaterThan(LIVE_EDGE_PX);
	};
	return {
		scroll,
		input,
		gap,
		height,
		viewport,
		jump,
		jumpOffered,
		send,
		abort,
		fixture,
		scrollUp,
		ridesTheStream,
		holdsPosition,
	};
}

test("a bottom-pinned transcript rides the stream, and 'jump to latest' re-engages it", async () => {
	test.setTimeout(150_000);
	await withFollowApp(async (_app, page) => {
		const errors: string[] = [];
		page.on("pageerror", error => errors.push(error.message));
		const { input, gap, height, jump, jumpOffered, send, abort, scrollUp, ridesTheStream, holdsPosition } =
			followProbe(page);
		await expect(input).toBeVisible({ timeout: 60_000 });

		await send("fixture stream");

		// Send reclaims the live edge, and every later chunk has to keep it.
		await expect.poll(gap).toBeLessThan(LIVE_EDGE_PX);
		await ridesTheStream(12);
		expect(await jumpOffered()).toBe(false);

		await scrollUp();
		const heldHeight = await height();
		await holdsPosition(8);
		expect(await height()).toBeGreaterThan(heldHeight);

		// Re-engaged means it keeps following, not that it jumped once.
		await jump.click();
		await expect.poll(gap).toBeLessThan(LIVE_EDGE_PX);
		expect(await jumpOffered()).toBe(false);
		await ridesTheStream(6);

		// Scrolling back down to the tail re-engages on its own: intent is a gesture
		// toward the tail, so the reader never has to reach for the control.
		await scrollUp();
		for (let step = 0; step < 60 && (await jumpOffered()); step++) await page.mouse.wheel(0, 1_500);
		expect(await jumpOffered()).toBe(false);
		await ridesTheStream(6);
		await abort();

		// A fresh send reclaims the live edge even from a view the reader had scrolled
		// up: the reply must not render off-screen below the fold.
		await scrollUp();
		await send("fixture stream");
		await expect.poll(gap).toBeLessThan(LIVE_EDGE_PX);
		expect(await jumpOffered()).toBe(false);
		await ridesTheStream(6);
		await abort();

		await page.screenshot({ path: "test-results/auto-follow.png", scale: "css", animations: "disabled" });
		expect(errors).toEqual([]);
	});
});

// A new row rises into place (omp-row-arrive: 10px up, 220ms). Its transform must
// never reach past the rows into the scroll height: a pinned view rides that extra
// height, and when the rise ends it drops back and the whole transcript jumps.
test("a row's entrance leaves a pinned transcript's scroll height to the rows", async () => {
	await withFollowApp(async (_app, page) => {
		const errors: string[] = [];
		page.on("pageerror", error => errors.push(error.message));
		const { input, gap } = followProbe(page);
		await expect(input).toBeVisible({ timeout: 60_000 });
		const entering = () =>
			page.evaluate(() =>
				[...document.querySelectorAll(".omp-row-arrive > .omp-transcript-row")].some(row =>
					row.getAnimations().some(animation => animation.playState === "running"),
				),
			);
		const sendTurn = async (text: string) => {
			await input.fill(text);
			await page.getByRole("button", { name: "Send", exact: true }).click();
			await expect(page.locator(".omp-user-text").filter({ hasText: text })).toBeVisible({ timeout: 30_000 });
		};
		await sendTurn("fixture turn 0");
		await expect.poll(entering).toBe(false);
		await expect.poll(gap).toBeLessThan(SETTLED_EDGE_PX);
		// Each entrance, measured as it starts (the row 10px low, where it reaches furthest): the animation's own event,
		// so a slow machine whose frames outlast the 220 ms rise still measures it (a hosted runner's frame sampler saw
		// no frame of the rise at all).
		await page.evaluate(() => {
			const scroll = document.querySelector<HTMLElement>(".omp-transcript-scroll");
			const canvas = document.querySelector<HTMLElement>(".omp-transcript-canvas");
			if (!scroll || !canvas) throw new Error("expected the transcript");
			const probe = { overflow: 0, entrances: 0 };
			// Test-only global the second evaluate reads back.
			(window as unknown as { __entrance: typeof probe }).__entrance = probe;
			const measured = new WeakSet<Element>();
			canvas.addEventListener("animationstart", event => {
				const row = event.target as HTMLElement;
				if (!row.matches(".omp-row-arrive > .omp-transcript-row") || measured.has(row)) return;
				measured.add(row);
				probe.entrances++;
				probe.overflow = Math.max(
					probe.overflow,
					scroll.scrollHeight - Math.max(canvas.offsetHeight, scroll.clientHeight),
				);
			});
		});
		await sendTurn("fixture turn 1");
		await expect.poll(entering).toBe(false);
		const seen = await page.evaluate(
			() => (window as unknown as { __entrance: { overflow: number; entrances: number } }).__entrance,
		);
		// The rise itself was measured, not only the frames around it.
		expect(seen.entrances).toBeGreaterThan(0);
		// Scroll height beyond the rows (a pixel of rounding between the two).
		expect(seen.overflow).toBeLessThanOrEqual(1);
		await expect.poll(gap).toBeLessThan(SETTLED_EDGE_PX);
		expect(errors).toEqual([]);
	});
});

test("viewport resizes from the dock and composer never stop a pinned transcript following", async () => {
	test.setTimeout(150_000);
	await withFollowApp(async (_app, page) => {
		const errors: string[] = [];
		page.on("pageerror", error => errors.push(error.message));
		const { input, gap, viewport, jumpOffered, send, abort, fixture, scrollUp, ridesTheStream } = followProbe(page);
		const dock = page.getByTestId("workspace-dock");
		await expect(input).toBeVisible({ timeout: 60_000 });

		await send("fixture stream");
		await ridesTheStream(6);

		// With the stream held still, nothing but the layout change can move the
		// view: a pinned transcript must end every resize flush with the bottom.
		const settlesAtTail = async (what: string) => {
			await expect
				.poll(gap, { message: `${what}: gap from the bottom`, timeout: 3_000 })
				.toBeLessThan(SETTLED_EDGE_PX);
			expect(await jumpOffered(), `${what}: jump to latest offered`).toBe(false);
		};
		await fixture("fixture:pause");
		await settlesAtTail("held stream");

		// The todo card appears between transcript and composer and takes its height
		// from the transcript viewport.
		const before = await viewport();
		await fixture("fixture:todo");
		await expect(dock).toBeVisible();
		await expect.poll(viewport).toBeLessThan(before);
		await settlesAtTail("dock appeared");

		// Expanding and collapsing a card resizes the viewport both ways.
		const card = dock.locator("button[aria-expanded]").first();
		for (const step of ["toggled once", "toggled back"]) {
			const height = await viewport();
			await card.click();
			await expect.poll(viewport).not.toBe(height);
			await settlesAtTail(`dock card ${step}`);
		}

		// A growing composer shrinks the viewport the same way.
		const height = await viewport();
		await input.fill(Array.from({ length: 8 }, (_, line) => `draft line ${line + 1}`).join("\n"));
		await expect.poll(viewport).toBeLessThan(height);
		await settlesAtTail("composer grew");
		await input.fill("");
		await settlesAtTail("composer shrank");

		// Following is still on: new output keeps riding the tail.
		await fixture("fixture:resume");
		await ridesTheStream(6);

		// A reader who scrolled up still owns the viewport through a resize.
		await scrollUp();
		await fixture("fixture:pause");
		const held = await gap();
		await card.click();
		await page.waitForTimeout(300);
		expect(await jumpOffered()).toBe(true);
		expect(await gap()).toBeGreaterThan(LIVE_EDGE_PX);
		expect(Math.abs((await gap()) - held)).toBeLessThan(400);
		await abort();
		expect(errors).toEqual([]);
	});
});

// Typing a draft line by line (the field re-fitted on every keystroke, the composer one line taller per
// Shift+Enter) must keep a pinned transcript's last row above the composer in every painted frame. The
// field's height fit used to collapse the composer for its measuring layout; the transcript grew into
// that space, Chromium clamped its scroll offset to the larger viewport, and the restored height never
// gave it back: past the third line the last reply sat under the composer (DI-2).
test("a draft growing line by line keeps a pinned transcript's last row above the composer in every frame", async () => {
	test.setTimeout(150_000);
	await withFollowApp(async (app, page) => {
		const errors: string[] = [];
		page.on("pageerror", error => errors.push(error.message));
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
		const { input, gap, viewport, jumpOffered, scrollUp } = followProbe(page);
		await expect(input).toBeVisible({ timeout: 60_000 });
		for (let turn = 0; turn < 3; turn++) {
			await input.fill(`seed message number ${turn} `.repeat(6));
			await input.press("Enter");
			await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
		}
		await expect.poll(gap).toBeLessThan(SETTLED_EDGE_PX);
		await input.click();

		// Every painted frame: after its layout and resize observers (a ResizeObserver made in the frame's
		// animation callback reports after every earlier one), the distance from the bottom and how far the
		// last row reaches past the composer's top edge.
		await page.evaluate(() => {
			const scroller = document.querySelector<HTMLElement>(".omp-transcript-scroll");
			const box = document.querySelector<HTMLElement>(".omp-composer-box");
			if (!scroller || !box) throw new Error("no transcript or composer");
			const frames: string[] = [];
			Object.assign(window, { __followFrames: frames });
			const sample = () => {
				const probe = new ResizeObserver(() => {
					probe.disconnect();
					const rows = scroller.querySelectorAll<HTMLElement>("[data-index]");
					const last = [...rows].reduce<HTMLElement | null>(
						(found, row) => (found && Number(found.dataset.index) > Number(row.dataset.index) ? found : row),
						null,
					);
					const under = last
						? Math.round(last.getBoundingClientRect().bottom - box.getBoundingClientRect().top)
						: 0;
					frames.push(`${scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight}/${under}`);
					requestAnimationFrame(sample);
				});
				probe.observe(scroller);
			};
			requestAnimationFrame(sample);
		});
		const takeFrames = () =>
			page.evaluate(() => {
				const frames = (window as Window & { __followFrames?: string[] }).__followFrames ?? [];
				return frames.splice(0);
			});

		const before = await viewport();
		await takeFrames();
		for (let line = 0; line < 10; line++) {
			await page.keyboard.type(`draft line ${line + 1}`);
			await page.keyboard.press("Shift+Enter");
			await page.waitForTimeout(250);
			const frames = await takeFrames();
			expect(frames.length, `line ${line + 1}: frames sampled`).toBeGreaterThan(0);
			for (const frame of frames) {
				const [distance, under] = frame.split("/").map(Number);
				const trace = `line ${line + 1}, distance/under per frame: ${frames.join(" ")}`;
				expect(distance, trace).toBeLessThan(SETTLED_EDGE_PX);
				expect(under, trace).toBeLessThanOrEqual(0);
			}
		}
		// The composer really grew into the transcript, and the view never let go of the tail.
		expect(await viewport()).toBeLessThan(before - 150);
		expect(await jumpOffered()).toBe(false);

		// A reader who scrolled up still owns the viewport while the draft grows.
		await scrollUp();
		const held = await gap();
		for (let line = 0; line < 3; line++) {
			await page.keyboard.type(`more ${line + 1}`);
			await page.keyboard.press("Shift+Enter");
		}
		await page.waitForTimeout(300);
		expect(await jumpOffered()).toBe(true);
		expect(await gap()).toBeGreaterThan(LIVE_EDGE_PX);
		expect(Math.abs((await gap()) - held)).toBeLessThan(400);
		expect(errors).toEqual([]);
	});
});
