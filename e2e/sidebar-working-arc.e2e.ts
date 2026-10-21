/**
 * The working arc in a sidebar session row's age slot, on the dev harness (the renderer in a browser over a fixture
 * transport, `vite.harness.config.ts`) with 50 sessions, 10 of them working: each working row trades its age for the
 * arc (two stepped transform loops, nothing else), the row keeps its width, a session waiting on the person shows its
 * waiting token instead, the arcs rest while the page is hidden and hold still under reduced motion.
 *
 * Opt-in: `OMP_GUI_WORKING_ARC=<dir>` writes captures (ko, light and dark, desktop and an iPhone 15, a frame strip of
 * the motion, the still form); `OMP_GUI_WORKING_ARC_CPU=1` measures what the ten arcs cost (Chromium's own process
 * CPU times through CDP `SystemInfo.getProcessInfo`, three runs of 15 s per phase: no work, ten working rows with
 * their arcs, the same rows with the arcs hidden).
 */
import * as fs from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { type Browser, chromium, devices, expect, type Page, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

const SHOTS = process.env.OMP_GUI_WORKING_ARC;
const CPU = process.env.OMP_GUI_WORKING_ARC_CPU === "1";
const ROWS = 50;
const WORKING = 10;

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

type Surface = "desktop" | "phone";

async function openHarness(
	surface: Surface,
	options: { theme?: "light" | "dark"; lang?: "en" | "ko"; reducedMotion?: boolean } = {},
): Promise<Page> {
	if (!browser) throw new Error("no browser");
	const context = await browser.newContext({
		...(surface === "phone" ? devices["iPhone 15"] : { viewport: { width: 1280, height: 900 } }),
		reducedMotion: options.reducedMotion ? "reduce" : "no-preference",
	});
	const page = await context.newPage();
	await page.goto(
		`${origin}/harness.html?theme=${options.theme ?? "light"}&lang=${options.lang ?? "en"}&rows=${ROWS}`,
	);
	await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
	await page.waitForFunction(() => window.__stores?.tabs !== undefined, undefined, { timeout: 45_000 });
	if (surface === "phone") {
		await page.getByRole("button", { name: /Open menu|메뉴 열기/ }).click();
		await expect(page.locator("[data-drawer] .omp-session-sidebar")).toBeVisible();
	}
	// The harness's paired host lists the same fixture sessions: wait for this device's row.
	await expect(
		sessionSidebar(page)
			.getByText(`Saved session ${ROWS - 3}`, { exact: true })
			.first(),
	).toBeVisible({
		timeout: 30_000,
	});
	return page;
}

/**
 * `count` saved sessions get a tab, running unless `status` says otherwise (the first one's turn waits on the
 * person when `waitingFirst`).
 */
async function startWork(page: Page, count: number, waitingFirst = false, status = "running"): Promise<void> {
	await page.evaluate(
		({ count, waitingFirst, status }) => {
			const tabs = window.__stores?.tabs as unknown as {
				getState(): { tabs: { id: string }[] };
				setState(partial: unknown): void;
			};
			const extra = Array.from({ length: count }, (_, index) => ({
				id: `arc-${index + 1}`,
				cwd: "/Users/dev/projects/ompdesk",
				status,
				kind: "agent",
				unreadDone: false,
				sessionPath: `-Users-dev-projects-ompdesk/sess-row-${index + 1}.jsonl`,
				...(waitingFirst && index === 0 ? { awaitingInput: "input" } : {}),
			}));
			tabs.setState({ tabs: [...tabs.getState().tabs.filter(tab => !tab.id.startsWith("arc-")), ...extra] });
		},
		{ count, waitingFirst, status },
	);
}

async function stopWork(page: Page): Promise<void> {
	await page.evaluate(() => {
		const tabs = window.__stores?.tabs as unknown as {
			getState(): { tabs: { id: string }[] };
			setState(partial: unknown): void;
		};
		tabs.setState({ tabs: tabs.getState().tabs.filter(tab => !tab.id.startsWith("arc-")) });
	});
}

/** The sidebar on screen (the docked one, or a phone's drawer). */
const sessionSidebar = (page: Page) => page.locator(".omp-session-sidebar:visible").first();

const arcRow = (page: Page, n: number) =>
	sessionSidebar(page)
		.locator(".omp-sidebar-session-row")
		.filter({ has: page.getByText(`Saved session ${n}`, { exact: true }) })
		.first();

test("ten of fifty rows trade their age for the arc, keep their width and rest while hidden", async () => {
	test.setTimeout(120_000);
	const page = await openHarness("desktop");
	const sidebar = sessionSidebar(page);
	// The age slot's box (its width and where it sits): what must not move when work starts.
	const width = () =>
		arcRow(page, 3)
			.locator("[data-sidebar-row-end]")
			.evaluate(slot => {
				const box = slot.getBoundingClientRect();
				return `${Math.round(box.left)}:${Math.round(box.width)}`;
			});
	// Its tab is open and idle first (a session works only in an open tab): only the work starting may change the slot.
	await startWork(page, WORKING, false, "ready");
	await expect(arcRow(page, 3).locator("[data-sidebar-row-end] time")).toHaveCount(1);
	const idleWidth = await width();

	await startWork(page, WORKING, true);
	// The first waits on the person: its waiting token, never the arc. The other nine work.
	await expect(sidebar.locator("[data-session-working] .omp-working-arc")).toHaveCount(WORKING - 1);
	await expect(arcRow(page, 1).locator(".omp-working-arc")).toHaveCount(0);
	await expect(arcRow(page, 1).locator(".omp-sidebar-approval")).toHaveCount(1);
	// The age stays in the slot, hidden, so the slot keeps its place and width.
	await expect(arcRow(page, 3).locator("[data-session-working] time")).toHaveCSS("visibility", "hidden");
	expect(await width()).toBe(idleWidth);

	// Two transform loops per arc, on one shared phase; nothing else in the sidebar loops but the titles' light.
	const loops = await page.evaluate(() =>
		document
			.getAnimations()
			.filter(animation => animation instanceof CSSAnimation && animation.playState === "running")
			.map(animation => {
				const effect = animation.effect as KeyframeEffect;
				return {
					name: (animation as CSSAnimation).animationName,
					props: [
						...new Set(
							effect
								.getKeyframes()
								.flatMap(frame => Object.keys(frame))
								.filter(key => !["offset", "easing", "composite", "computedOffset"].includes(key)),
						),
					],
					phase: Math.round(Number(animation.currentTime ?? 0)) % 3000,
				};
			})
			.filter(loop => loop.name.startsWith("omp-working-arc")),
	);
	expect(loops).toHaveLength((WORKING - 1) * 2);
	for (const loop of loops) expect(loop.props).toEqual(["transform"]);
	const turns = loops.map(loop => loop.phase);
	expect(Math.max(...turns) - Math.min(...turns)).toBeLessThan(60);

	// Hidden: every arc rests.
	await page.evaluate(() => {
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await expect(sidebar.locator(".omp-working-arc[data-paused]")).toHaveCount(WORKING - 1);
	const playing = await page.evaluate(
		() =>
			document
				.getAnimations()
				.filter(a => a instanceof CSSAnimation && a.animationName.startsWith("omp-working-arc"))
				.filter(a => a.playState === "running").length,
	);
	expect(playing).toBe(0);

	await stopWork(page);
	await expect(sidebar.locator(".omp-working-arc")).toHaveCount(0);
	await expect(arcRow(page, 3).locator("[data-sidebar-row-end] time")).toBeVisible();
	await page.context().close();
});

test("reduced motion: the arc holds still as a 270° arc", async () => {
	test.setTimeout(120_000);
	const page = await openHarness("desktop", { reducedMotion: true });
	await startWork(page, 2);
	const arc = arcRow(page, 2).locator(".omp-working-arc");
	await expect(arc).toHaveCount(1);
	await expect(arc.locator('[data-arc="head"]')).toHaveCSS("animation-name", "none");
	await expect(arc.locator('[data-arc="head"]')).not.toHaveCSS("transform", "none");
	await page.context().close();
});

if (SHOTS)
	for (const surface of ["desktop", "phone"] as const)
		for (const theme of ["light", "dark"] as const)
			test(`captures: working arc (${surface} ${theme} ko)`, async () => {
				test.setTimeout(180_000);
				const page = await openHarness(surface, { theme, lang: "ko" });
				const tag = `${surface}-${theme}-ko`;
				await fs.mkdir(path.join(SHOTS, "frames"), { recursive: true });
				const sidebar = sessionSidebar(page);
				await startWork(page, 4, true);
				await page.waitForTimeout(600);
				await sidebar.screenshot({ path: path.join(SHOTS, `sidebar-${tag}.png`) });
				const end = arcRow(page, 2).locator("[data-sidebar-row-end]");
				for (let frame = 0; frame < 12; frame++) {
					await arcRow(page, 2).screenshot({ path: path.join(SHOTS, "frames", `row-${tag}-${frame}.png`) });
					await end.screenshot({ path: path.join(SHOTS, "frames", `arc-${tag}-${frame}.png`), scale: "device" });
					await page.waitForTimeout(125);
				}
				await stopWork(page);
				await sidebar.screenshot({ path: path.join(SHOTS, `sidebar-idle-${tag}.png`) });
				await page.context().close();
				const still = await openHarness(surface, { theme, lang: "ko", reducedMotion: true });
				await startWork(still, 4, true);
				await still
					.locator(".omp-session-sidebar")
					.first()
					.screenshot({ path: path.join(SHOTS, `sidebar-still-${tag}.png`) });
				await still.context().close();
			});

if (CPU)
	test("cost: ten working arcs in a fifty-row sidebar", async () => {
		test.setTimeout(600_000);
		if (!browser) throw new Error("no browser");
		const page = await openHarness("desktop");
		const cdp = await browser.newBrowserCDPSession();
		const cpu = async () => {
			const { processInfo } = (await cdp.send("SystemInfo.getProcessInfo")) as {
				processInfo: { type: string; id: number; cpuTime: number }[];
			};
			return processInfo.reduce((sum, process) => sum + process.cpuTime, 0);
		};
		const measure = async (seconds: number) => {
			const before = await cpu();
			await page.waitForTimeout(seconds * 1000);
			return ((await cpu()) - before) / seconds;
		};
		const phases: Record<string, number[]> = { idle: [], arcs: [], titlesOnly: [] };
		for (let run = 0; run < 3; run++) {
			await stopWork(page);
			await page.waitForTimeout(2000);
			phases.idle!.push(await measure(15));
			await startWork(page, WORKING);
			await page.waitForTimeout(2000);
			phases.arcs!.push(await measure(15));
			await page.addStyleTag({ content: ".omp-working-arc { display: none !important; }" });
			await page.waitForTimeout(2000);
			phases.titlesOnly!.push(await measure(15));
			await page.evaluate(() =>
				document
					.querySelectorAll("style")
					.item(document.querySelectorAll("style").length - 1)
					?.remove(),
			);
		}
		const pct = (values: number[]) => values.map(value => `${(value * 100).toFixed(1)}%`).join(" ");
		const report = Object.entries(phases).map(([phase, values]) => `${phase}: ${pct(values)} of one core`);
		console.log(report.join("\n"));
		if (SHOTS) await fs.writeFile(path.join(SHOTS, "cpu.txt"), `${report.join("\n")}\n`);
		await page.context().close();
	});
