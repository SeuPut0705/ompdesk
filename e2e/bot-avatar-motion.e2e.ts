/**
 * The bot avatar's motions on the style guide's "Bot avatar" section (`#/styleguide` on the dev harness), as film strips:
 * for each motion (and the speaking one driven by a playback level), its row is shot eight times across one period of its
 * animations and the frames are stitched side by side. The loops are paused and set to a time, so every strip is the
 * same on every run. A still strip per motion is shot under reduced motion. Captures only, to be read by eye (eyes off
 * the body, a clipped ring, a jump between frames); opt in with OMP_GUI_BOT_MOTION_SHOTS=<dir>, which gets
 * `light/` and `dark/` folders of `strip-<motion>.png`, `strip-<motion>-<kind>.png` (one sample at a time, larger), `strip-shapes-*.png` (every mark) and
 * `still-<motion>.png`.
 */
import * as fs from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { type Browser, chromium, expect, type Page, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

const OUT = process.env.OMP_GUI_BOT_MOTION_SHOTS ?? "";
test.skip(!OUT, "OMP_GUI_BOT_MOTION_SHOTS=<dir> turns the avatar's capture on");

const MOTIONS = ["idle", "working", "waiting", "asleep", "speaking", "reconnecting"] as const;
const KINDS = ["bot", "heart", "bird", "image"] as const;
const FRAMES = 8;
/** The last frame lands here in the period: idle's blink and the ring pulse sit near its end. */
const SPAN = 0.95;

let server: ViteDevServer | undefined;
let origin = "";
let browser: Browser;

async function freePort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const probe = createNetServer();
	probe.once("error", reject);
	probe.listen(0, "127.0.0.1", () => {
		const address = probe.address();
		probe.close(() => {
			if (address && typeof address === "object") resolve(address.port);
			else reject(new Error("no port"));
		});
	});
	return promise;
}

test.beforeAll(async () => {
	if (!OUT) return;
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

/** Frames side by side on one canvas of a blank page, so the file is one image. */
async function stitch(canvasPage: Page, frames: Buffer[]): Promise<Buffer> {
	const url = await canvasPage.evaluate(
		async sources => {
			const images = await Promise.all(
				sources.map(async source => {
					const image = new Image();
					image.src = source;
					await image.decode();
					return image;
				}),
			);
			const gap = 6;
			const canvas = document.createElement("canvas");
			canvas.width = images.reduce((sum, image) => sum + image.width + gap, -gap);
			canvas.height = Math.max(...images.map(image => image.height));
			const context = canvas.getContext("2d");
			if (!context) throw new Error("no canvas");
			context.fillStyle = "#7f7f7f";
			context.fillRect(0, 0, canvas.width, canvas.height);
			let x = 0;
			for (const image of images) {
				context.drawImage(image, x, 0);
				x += image.width + gap;
			}
			return canvas.toDataURL("image/png");
		},
		frames.map(frame => `data:image/png;base64,${frame.toString("base64")}`),
	);
	return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
}

/** Pause every animation inside `selector` at `time` ms. Returns the longest iteration among them (ms). */
function scrub(page: Page, selector: string, time: number | null): Promise<number> {
	return page.evaluate(
		([rowSelector, at]) => {
			const row = document.querySelector(rowSelector as string);
			let longest = 0;
			for (const animation of document.getAnimations()) {
				const target = (animation.effect as KeyframeEffect | null)?.target;
				if (!row || !target || !row.contains(target)) continue;
				const duration = animation.effect?.getComputedTiming().duration;
				if (typeof duration === "number") longest = Math.max(longest, duration);
				if (at !== null) {
					animation.pause();
					animation.currentTime = at as number;
				}
			}
			return longest;
		},
		[selector, time] as const,
	);
}

async function open(theme: "light" | "dark", reducedMotion: boolean): Promise<Page> {
	const context = await browser.newContext({
		viewport: { width: 1240, height: 1100 },
		deviceScaleFactor: 3,
		colorScheme: theme,
		reducedMotion: reducedMotion ? "reduce" : "no-preference",
	});
	const page = await context.newPage();
	await page.goto(`${origin}/harness.html?theme=${theme}&lang=en#/styleguide`);
	await expect(page.locator("[data-bot-motion-grid]")).toBeVisible({ timeout: 60_000 });
	await page
		.getByText(theme === "dark" ? "Dark" : "Light", { exact: true })
		.first()
		.click();
	await page.locator("[data-bot-motion-grid]").scrollIntoViewIfNeeded();
	// The harness pins the page to the window (body is fixed); the guide is longer, so let the document scroll to the grid.
	// The transitions that follow the level are not a pose of their own: a frame is the value it was set to.
	await page.addStyleTag({
		content: `html, body, #root { position: static !important; height: auto !important; overflow: visible !important; }
			.omp-bot-avatar, .omp-bot-avatar * { transition: none !important; }`,
	});
	return page;
}

for (const theme of ["light", "dark"] as const) {
	test(`the bot avatar's strips (${theme})`, async () => {
		test.setTimeout(240_000);
		const dir = path.join(OUT, theme);
		await fs.mkdir(dir, { recursive: true });
		const page = await open(theme, false);
		const canvasPage = await page.context().newPage();
		await canvasPage.goto("about:blank");

		const shootRows = async (
			name: string,
			selector: string,
			time: (index: number, period: number) => number | null,
			prepare?: (index: number) => Promise<void>,
		) => {
			const target = page.locator(selector);
			const period = await scrub(page, selector, null);
			const frames: Buffer[] = [];
			for (let index = 0; index < FRAMES; index += 1) {
				await prepare?.(index);
				await scrub(page, selector, time(index, period || 1000));
				frames.push(await target.screenshot({ scale: "device" }));
			}
			await fs.writeFile(path.join(dir, `strip-${name}.png`), await stitch(canvasPage, frames));
		};
		const atFrame = (index: number, period: number) => (index / (FRAMES - 1)) * SPAN * period;

		for (const motion of MOTIONS) {
			await shootRows(motion, `[data-bot-motion-row="${motion}"]`, atFrame);
			for (const kind of KINDS)
				await shootRows(`${motion}-${kind}`, `[data-bot-motion-cell="${motion}-${kind}"]`, atFrame);
		}

		// Speaking again, as a call drives it: the playback level (`--bot-voice`) sweeps 0 to 1 and back.
		const voiced = (scope: string, level: number) =>
			page.evaluate(
				([selector, value]) => {
					for (const element of document.querySelectorAll(`${selector} .omp-bot-avatar`)) {
						element.setAttribute("data-bot-voiced", "");
						(element as HTMLElement).style.setProperty("--bot-voice", String(value));
					}
				},
				[scope, String(level)] as const,
			);
		const sweep = [0, 0.2, 0.5, 0.9, 1, 0.6, 0.3, 0];
		const shootVoiced = (name: string, scope: string) =>
			shootRows(
				name,
				scope,
				() => null,
				index => voiced(scope, sweep[index] ?? 0),
			);
		await shootVoiced("speaking-voiced", '[data-bot-motion-row="speaking"]');
		for (const kind of KINDS)
			await shootVoiced(`speaking-voiced-${kind}`, `[data-bot-motion-cell="speaking-${kind}"]`);

		// Every mark of the picker, idle (a blink among the frames) and speaking.
		await shootRows("shapes-idle", '[data-bot-shape-row="idle"]', atFrame);
		await shootVoiced("shapes-speaking", '[data-bot-shape-row="speaking"]');

		// Every cell must still carry its avatars and none may move the page (the box is the same across motions).
		const widths = await page.evaluate(() =>
			[...document.querySelectorAll("[data-bot-motion-cell]")].map(cell => [
				cell.getAttribute("data-bot-motion-cell"),
				Math.round(cell.getBoundingClientRect().width * 10) / 10,
			]),
		);
		const byKind = new Map<string, Set<number>>();
		for (const [cell, width] of widths as Array<[string, number]>) {
			const kind = cell.split("-").slice(1).join("-");
			byKind.set(kind, (byKind.get(kind) ?? new Set()).add(width));
		}
		for (const [kind, sizes] of byKind)
			expect([...sizes], `the ${kind} cell keeps one width across motions`).toHaveLength(1);
		await page.context().close();
	});

	test(`the bot avatar's still poses under reduced motion (${theme})`, async () => {
		test.setTimeout(120_000);
		const dir = path.join(OUT, theme);
		await fs.mkdir(dir, { recursive: true });
		const page = await open(theme, true);
		for (const motion of MOTIONS) {
			const row = page.locator(`[data-bot-motion-row="${motion}"]`);
			expect(await scrub(page, `[data-bot-motion-row="${motion}"]`, null), `${motion} runs no animation`).toBe(0);
			await row.screenshot({ path: path.join(dir, `still-${motion}.png`), scale: "device" });
		}
		await page.context().close();
	});
}
