/**
 * The running state's light on the sidebar's session rows and the phone drawer's, on the dev harness (the renderer
 * in a browser over a fixture transport, `vite.harness.config.ts`; desktop and an iPhone 15, light and dark):
 * a running row wears the shared light (`LiveEdge`, two bars running its top and bottom edge, transform only), an
 * idle one and one that waits for an answer wear none, the family chip's count and a running child's dot hold
 * still, and under reduced motion nothing moves and the edge stays as a still 1 px line. `OMP_GUI_ROW_GLOW=<dir>`
 * also writes the captures (three frames of the light on the desktop, the phone drawer).
 */
import * as fs from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { type Browser, chromium, devices, expect, type Page, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

const CAPTURES = process.env.OMP_GUI_ROW_GLOW;

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

interface Surface {
	name: "phone" | "desktop";
	context: Parameters<Browser["newContext"]>[0];
}

const SURFACES: readonly Surface[] = [
	{ name: "phone", context: { ...devices["iPhone 15"] } },
	{ name: "desktop", context: { viewport: { width: 1280, height: 860 } } },
];

async function openHarness(surface: Surface, theme: "light" | "dark", reducedMotion: boolean): Promise<Page> {
	if (!browser) throw new Error("no browser");
	const context = await browser.newContext({
		...surface.context,
		reducedMotion: reducedMotion ? "reduce" : "no-preference",
	});
	const page = await context.newPage();
	await page.goto(`${origin}/harness.html?theme=${theme}&lang=en`);
	await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
	await page.waitForFunction(() => window.__stores?.subagents !== undefined, undefined, { timeout: 45_000 });
	if (surface.name === "phone") {
		await page.getByRole("button", { name: /Open menu/ }).click();
		await expect(page.locator("[data-drawer] .omp-session-sidebar")).toBeVisible();
	}
	return page;
}

/** Tabs 1 and 2 run, tab 3 stays idle; two subagents of the open session run. */
async function seedRunning(page: Page): Promise<void> {
	await page.evaluate(() => {
		const stores = window.__stores;
		if (!stores) throw new Error("no stores");
		const tabs = stores.tabs as unknown as {
			getState(): { tabs: { id: string; status: string }[] };
			setState(partial: unknown): void;
		};
		tabs.setState({
			tabs: tabs.getState().tabs.map(tab => (tab.id === "tab-3" ? tab : { ...tab, status: "running" })),
		});
		const subagents = stores.subagents.getState() as { setSnapshots(rows: unknown[]): void };
		subagents.setSnapshots([
			{
				id: "r1",
				index: 1,
				agent: "task",
				assignment: "Title: Theme cleanup",
				status: "running",
				lastUpdate: Date.now(),
			},
			{
				id: "r2",
				index: 2,
				agent: "task",
				assignment: "Title: Check attachments",
				status: "running",
				lastUpdate: Date.now(),
			},
		]);
	});
	await page.locator("[data-sidebar-subagents-toggle]").first().click();
	await expect(page.locator("[data-sidebar-subagent]")).toHaveCount(2);
}

/** Every running CSS animation of the page: where it is, which properties it moves. */
async function runningAnimations(page: Page) {
	return page.evaluate(() =>
		document
			.getAnimations()
			.filter(animation => animation instanceof CSSAnimation && animation.playState === "running")
			.map(animation => {
				const effect = animation.effect as KeyframeEffect;
				return {
					name: (animation as CSSAnimation).animationName,
					inLight: effect.target?.closest(".omp-live-edge") != null,
					props: [
						...new Set(
							effect
								.getKeyframes()
								.flatMap(frame => Object.keys(frame))
								.filter(key => !["offset", "easing", "composite", "computedOffset"].includes(key)),
						),
					],
				};
			}),
	);
}

for (const surface of SURFACES)
	for (const theme of ["light", "dark"] as const)
		test(`running rows wear the light, idle and waiting ones do not (${surface.name} ${theme})`, async () => {
			test.setTimeout(120_000);
			const page = await openHarness(surface, theme, false);
			await seedRunning(page);
			const sidebar = page.locator(".omp-session-sidebar").first();
			const rows = sidebar.locator(".omp-sidebar-session-row");
			const running = sidebar.locator('.omp-sidebar-session-row[data-signal="running"]');
			await expect(running).toHaveCount(2);
			for (const row of await running.all()) await expect(row.locator(".omp-live-edge")).toHaveCount(1);
			// The idle session (tab 3) and everything unlit has no light.
			expect(await rows.locator(".omp-live-edge").count()).toBe(2 + 0);
			// A running child is a plain row with a still dot: no box, no light; only the 2 top-level rows are lit.
			const children = sidebar.locator("[data-sidebar-subagent]");
			for (const child of await children.all()) await expect(child.locator(".omp-live-edge")).toHaveCount(0);
			// Light = 2 bars per lit card, a transform each and nothing else; no other animation runs in the sidebar.
			const animations = await runningAnimations(page);
			const lights = animations.filter(animation => animation.name === "omp-live-edge-run");
			expect(lights.length).toBe(4);
			for (const light of lights) expect(light.props).toEqual(["transform"]);
			const insideSidebar = await sidebar.evaluate(element =>
				element
					.getAnimations({ subtree: true })
					.filter(animation => animation instanceof CSSAnimation && animation.playState === "running")
					.map(animation => (animation as CSSAnimation).animationName),
			);
			expect(insideSidebar.every(name => name === "omp-live-edge-run")).toBe(true);
			// The family chip shows its count once: the filled running pill with the kind glyph, no plain count beside it.
			await expect(sidebar.locator("[data-family-running]")).toHaveCount(1);
			await expect(sidebar.locator("[data-family-agents], [data-family-sessions]")).toHaveCount(0);
			await expect(sidebar.locator("[data-family-running] svg")).toHaveCount(1);
			await page.waitForTimeout(700);
			if (CAPTURES) {
				await fs.mkdir(CAPTURES, { recursive: true });
				const frames = surface.name === "desktop" ? 3 : 1;
				for (let frame = 0; frame < frames; frame++) {
					await sidebar.screenshot({
						path: path.join(CAPTURES, `final2-${surface.name}-${theme}${frames > 1 ? `-t${frame}` : ""}.png`),
					});
					await page.waitForTimeout(2600);
				}
			}

			// A session that waits for an answer keeps its warning look and wears no light.
			await page.evaluate(() => {
				const tabs = window.__stores?.tabs as unknown as {
					getState(): { tabs: { id: string; awaitingInput?: string }[] };
					setState(partial: unknown): void;
				};
				tabs.setState({
					tabs: tabs.getState().tabs.map(tab => (tab.id === "tab-2" ? { ...tab, awaitingInput: "input" } : tab)),
				});
			});
			await expect(sidebar.locator('.omp-sidebar-session-row[data-signal="waiting"]')).toHaveCount(1);
			await expect(sidebar.locator('.omp-sidebar-session-row[data-signal="waiting"] .omp-live-edge')).toHaveCount(0);
			await expect(sidebar.locator('.omp-sidebar-session-row[data-signal="running"] .omp-live-edge')).toHaveCount(1);
			if (CAPTURES)
				await sidebar.screenshot({ path: path.join(CAPTURES, `final2-${surface.name}-${theme}-waiting.png`) });
			await page.context().close();
		});

for (const surface of SURFACES)
	test(`reduced motion: nothing moves and the edge stays a still line (${surface.name})`, async () => {
		test.setTimeout(120_000);
		const page = await openHarness(surface, "dark", true);
		await seedRunning(page);
		const sidebar = page.locator(".omp-session-sidebar").first();
		const edge = sidebar.locator('.omp-sidebar-session-row[data-signal="running"] .omp-live-edge').first();
		await expect(edge).toHaveCount(1);
		expect((await runningAnimations(page)).filter(animation => animation.inLight)).toEqual([]);
		await expect(edge).toHaveCSS("border-top-width", "1px");
		const bars = await edge.evaluate(element => [
			getComputedStyle(element, "::before").display,
			getComputedStyle(element, "::after").display,
		]);
		expect(bars).toEqual(["none", "none"]);
		await page.context().close();
	});
