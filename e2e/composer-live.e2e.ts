/**
 * The composer's working cue on the fake omp: a slow accent light on the box's border while the main turn
 * runs (Stop), a fainter one plus a ring and tooltip on Send while the turn is idle but a subagent still
 * runs, and nothing while a question waits on the user. Also pins what the cue costs: its animation is one
 * transform on one layer, the renderer and GPU stay quiet beside it, and a reduced-motion user gets a still
 * indicator. Captures in light/dark × en/ko go to `OMP_GUI_COMPOSER_LIVE_CAPTURES` (default: the test output).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { exitApp, launchApp } from "./harness";

type Language = "en" | "ko";
type Theme = "light" | "dark";

const TEXT = {
	en: { send: "Send", stop: "Stop", hint: "Background agents running: 2. Sending now starts right away." },
	ko: {
		send: "보내기",
		stop: "중단",
		hint: "2개 에이전트가 백그라운드에서 작업 중이에요. 지금 보내도 바로 시작해요.",
	},
} as const;

async function launch(language: Language, theme: Theme, args: string[] = []) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-composer-live-")));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language, themeName: theme, firstRunComplete: true, workBoard: false }),
	);
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile: root,
		args,
	});
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 800));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page, root };
}

async function fixture(page: Page, line: string): Promise<void> {
	const response = await page.evaluate(command => window.omp.rpc.command({ type: "bash", command }), line);
	expect(response.success).toBe(true);
}

async function send(page: Page, text: string): Promise<void> {
	const input = page.locator("textarea").first();
	await input.fill(text);
	await input.press("Enter");
	await expect(input).toHaveValue("");
}

/** Mean CPU % of the renderer and GPU processes over a window, from Electron's own process metrics. */
async function cpu(app: ElectronApplication, ms: number): Promise<{ renderer: number; gpu: number }> {
	await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics());
	await new Promise(resolve => setTimeout(resolve, ms));
	const metrics = await app.evaluate(({ app: electronApp }) =>
		electronApp.getAppMetrics().map(metric => ({ type: metric.type, cpu: metric.cpu.percentCPUUsage })),
	);
	const sum = (type: string) =>
		metrics.filter(metric => metric.type === type).reduce((n, metric) => n + metric.cpu, 0);
	return { renderer: sum("Tab"), gpu: sum("GPU") };
}
/**
 * Whether the app drew this window in its software-compositing form: the same `html[data-gpu]` signal the CSS reads.
 * Main sets it once the GPU process has reported (`getGPUInfo("complete")`), so wait for that, then give the
 * attribute a moment; a hardware window never gets it.
 */
async function softwareMarked(app: ElectronApplication, page: Page): Promise<boolean> {
	await app.evaluate(({ app: electronApp }) => electronApp.getGPUInfo("complete").catch(() => undefined));
	return page
		.waitForFunction(() => document.documentElement.dataset.gpu === "software", undefined, { timeout: 3000 })
		.then(() => true)
		.catch(() => false);
}

for (const language of ["en", "ko"] as const)
	for (const theme of ["light", "dark"] as const)
		test(`${language === "en" && theme === "light" ? "@smoke " : ""}the composer shows work in progress: turn, background agents, a waiting question (${language} ${theme})`, async () => {
			test.setTimeout(180_000);
			const text = TEXT[language];
			const { app, page, root } = await launch(language, theme);
			const captures = process.env.OMP_GUI_COMPOSER_LIVE_CAPTURES;
			if (captures) await fs.mkdir(captures, { recursive: true });
			/** `whole`: the window itself, shot at the device scale (a CSS-scale shot resizes the page and the open tooltip closes). */
			const capture = async (stage: string, above = 12, whole = false) => {
				const file = `composer-live-${stage}-${language}-${theme}.png`;
				const target = captures ? path.join(captures, file) : test.info().outputPath(file);
				if (whole) {
					await page.screenshot({ path: target });
					return;
				}
				const box = await page.locator(".omp-composer-box").first().boundingBox();
				if (!box) throw new Error("expected the composer box");
				await page.screenshot({
					path: target,
					clip: { x: box.x - 16, y: box.y - above, width: box.width + 32, height: box.height + above + 16 },
					scale: "css",
				});
			};
			try {
				const errors: string[] = [];
				page.on("pageerror", error => errors.push(error.message));
				const live = page.locator(".omp-composer-box > .omp-composer-live");
				const ring = page.locator(".omp-composer-send-live[data-composer-live]");

				// Idle: nothing moves.
				await expect(live).toHaveCount(0);
				await expect(ring).toHaveCount(0);

				// State 1: a turn runs, Stop is the action, the light turns.
				await send(page, "fixture stream");
				await expect(page.getByRole("button", { name: text.stop })).toBeVisible();
				await expect(live).toHaveAttribute("data-composer-live", "turn");
				await expect(ring).toHaveCount(0);
				await page.waitForTimeout(700);
				await capture("turn");

				// The animation is one transform on one layer: nothing repaints per frame.
				const software = await softwareMarked(app, page);
				const animated = await page.evaluate(() =>
					document
						.getAnimations()
						.filter(
							animation =>
								animation instanceof CSSAnimation &&
								animation.animationName.startsWith("omp-composer-live-turn"),
						)
						.map(animation => ({
							pseudo: (animation.effect as KeyframeEffect).pseudoElement,
							props: [
								...new Set(
									(animation.effect as KeyframeEffect).getKeyframes().flatMap(frame => Object.keys(frame)),
								),
							].filter(key => !["offset", "easing", "composite", "computedOffset"].includes(key)),
							state: animation.playState,
						})),
				);
				// Software compositing (the app's own `html[data-gpu]` signal) draws the cue still: no animation at all.
				if (software) expect(animated).toEqual([]);
				else expect(animated).toEqual([{ pseudo: "::before", props: ["transform"], state: "running" }]);

				// Typing steps the light out of the way; clearing the draft brings it back.
				const input = page.locator("textarea").first();
				await input.fill("draft");
				await expect(live).toHaveCSS("opacity", "0");
				await input.fill("");
				await expect(live).not.toHaveCSS("opacity", "0");

				// The turn ends; no agents run: the cue leaves.
				await fixture(page, "fixture:finish");
				await expect(page.getByRole("button", { name: text.send })).toBeVisible();
				await expect(live).toHaveCount(0);

				// State 2: idle, but a subagent still runs. Send stays Send, fainter light, a ring with the hint.
				await fixture(page, "fixture:subagents");
				await expect(live).toHaveAttribute("data-composer-live", "background");
				await expect(ring).toHaveCount(1);
				await expect(page.getByRole("button", { name: text.send })).toBeVisible();
				const turnOpacity = 0.9;
				expect(Number(await live.evaluate(element => getComputedStyle(element).opacity))).toBeLessThan(turnOpacity);
				// Re-hover until the tooltip shows: under load the Send button can re-render under a single hover.
				await expect(async () => {
					await page.mouse.move(5, 5);
					await page.getByRole("button", { name: text.send }).hover();
					await expect(page.getByRole("tooltip")).toContainText(text.hint, { timeout: 2000 });
				}).toPass({ timeout: 15_000 });
				await page.waitForTimeout(250);
				await capture("background-hint", 90, true);
				await page.mouse.move(5, 5);
				await expect(page.getByRole("tooltip")).toHaveCount(0);
				await capture("background");

				// The cost, while the cue runs and with it off.
				await page.waitForTimeout(1000);
				const on = await cpu(app, 4000);
				await page.evaluate(() =>
					document.querySelector(".omp-composer-live")?.setAttribute("data-composer-live", "turn"),
				);
				const strong = await cpu(app, 4000);
				let bare = strong;
				if (software) {
					await page.evaluate(() => document.querySelector(".omp-composer-live")?.remove());
					bare = await cpu(app, 4000);
				}
				for (const id of ["sa-explore", "sa-nested"]) await fixture(page, `fixture:subagents:finish:${id}`);
				await expect(live).toHaveCount(0);
				await page.waitForTimeout(1000);
				const off = await cpu(app, 4000);
				console.log(
					`composer-live cpu ${language}-${theme} ${JSON.stringify({ off, background: on, turn: strong })}`,
				);
				// Measured here: +0.4 % renderer, +1.4 % GPU of one core; a repainting animation costs several times that.
				// Only meaningful with GPU compositing: a GPU-less runner (Windows CI) composites in software, where
				// any animation costs the "GPU" process real CPU.
				// `software` was read above, from the app's own signal.
				if (!software) {
					expect(strong.gpu - off.gpu).toBeLessThan(4);
					expect(strong.renderer - off.renderer).toBeLessThan(2);
				} else {
					// Software compositing (a GPU-less runner): the cue is the still form, never an animation. The agents
					// and the turn cost what they cost there (`off` has none running), so compare with the cue removed.
					await expect(page.locator("html")).toHaveAttribute("data-gpu", "software");
					// A runner without a GPU is busy and noisy (a few % either way).
					expect(strong.gpu - bare.gpu).toBeLessThan(5);
					expect(strong.renderer - bare.renderer).toBeLessThan(5);
				}

				// A question waiting on the user wins over a running turn.
				await send(page, "fixture ask");
				await expect(page.getByRole("dialog").or(page.locator(".omp-prompt-card")).first()).toBeVisible();
				await expect(live).toHaveCount(0);
				await capture("asking", 260);
				expect(errors).toEqual([]);
			} finally {
				await exitApp(app);
				await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});

test("reduced motion gets a still indicator, and a hidden window pauses the light", async () => {
	test.setTimeout(120_000);
	const { app, page, root } = await launch("en", "light");
	try {
		await page.emulateMedia({ reducedMotion: "reduce" });
		await send(page, "fixture stream");
		const live = page.locator(".omp-composer-box > .omp-composer-live");
		await expect(live).toHaveAttribute("data-composer-live", "turn");
		const running = await page.evaluate(
			() =>
				document
					.getAnimations()
					.filter(
						animation =>
							animation.playState === "running" &&
							animation instanceof CSSAnimation &&
							animation.animationName.startsWith("omp-composer-live"),
					).length,
		);
		expect(running).toBe(0);
		await expect(live).toHaveCSS("opacity", "0.9");
		await page.emulateMedia({ reducedMotion: "no-preference" });
		// Software compositing keeps the still form whatever the media says; hardware gets the turning light.
		const software = await softwareMarked(app, page);
		await expect
			.poll(() => live.evaluate(element => getComputedStyle(element, "::before").animationName))
			.toBe(software ? "none" : "omp-composer-live-turn");
		await page.evaluate(() => {
			Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await expect(live).toHaveAttribute("data-paused", "");
		// Software compositing keeps `animation: none`, whose shorthand also resets the play state: nothing runs to pause.
		if (!software)
			await expect
				.poll(() => live.evaluate(element => getComputedStyle(element, "::before").animationPlayState))
				.toBe("paused");
	} finally {
		await exitApp(app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("software compositing draws the cue still and the cost stays flat", async () => {
	test.setTimeout(120_000);
	// `--disable-gpu` is the same switch the crash fallback honours (main/gpu-fallback.ts): Chromium composites in software.
	const { app, page, root } = await launch("en", "light", ["--disable-gpu"]);
	try {
		const status = await app.evaluate(({ app: electronApp }) =>
			String(electronApp.getGPUFeatureStatus().gpu_compositing),
		);
		expect(status.startsWith("enabled")).toBe(false);
		await expect(page.locator("html")).toHaveAttribute("data-gpu", "software");
		await send(page, "fixture stream");
		const live = page.locator(".omp-composer-box > .omp-composer-live");
		await expect(live).toHaveAttribute("data-composer-live", "turn");
		const running = await page.evaluate(
			() =>
				document
					.getAnimations()
					.filter(
						animation =>
							animation.playState === "running" &&
							animation instanceof CSSAnimation &&
							animation.animationName.startsWith("omp-composer-live"),
					).length,
		);
		expect(running).toBe(0);
		await expect(live).toHaveCSS("opacity", "0.9");
		// The still cue costs nothing next to the running turn's own work: compare it with the cue absent.
		await page.waitForTimeout(1000);
		const withCue = await cpu(app, 4000);
		await page.evaluate(() => document.querySelector(".omp-composer-live")?.remove());
		await page.waitForTimeout(1000);
		const without = await cpu(app, 4000);
		console.log(`composer-live software cpu ${JSON.stringify({ withCue, without })}`);
		expect(withCue.gpu - without.gpu).toBeLessThan(2);
		expect(withCue.renderer - without.renderer).toBeLessThan(2);
	} finally {
		await exitApp(app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
