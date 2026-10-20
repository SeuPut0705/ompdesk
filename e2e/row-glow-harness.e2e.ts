/**
 * The working cue on the sidebar's session rows, the phone drawer's and the composer, on the dev harness (the
 * renderer in a browser over a fixture transport, `vite.harness.config.ts`; desktop and an iPhone 15, light and dark):
 * a running row's own title shimmers (`LiveText`, two transforms: a masked window and the words going back), an idle one's
 * stays plain and one that waits for an answer holds a still warning colour, a session whose turn ended while its
 * subagents still work shimmers fainter at the same pace, the family chip's count and a running child's dot hold
 * still, the composer's background carries the same sweep (one transform), and under reduced motion nothing moves.
 * No border light anywhere. `OMP_GUI_ROW_GLOW=<dir>` also writes the sidebar captures; `OMP_GUI_WORKING_SHOTS=<dir>`
 * writes every surface × theme × language, with frame strips of the motion and the composer while typing in a turn.
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

async function openHarness(
	surface: Surface,
	theme: "light" | "dark",
	reducedMotion: boolean,
	lang: "en" | "ko" = "en",
): Promise<Page> {
	if (!browser) throw new Error("no browser");
	const context = await browser.newContext({
		...surface.context,
		reducedMotion: reducedMotion ? "reduce" : "no-preference",
	});
	const page = await context.newPage();
	await page.goto(`${origin}/harness.html?theme=${theme}&lang=${lang}`);
	await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
	await page.waitForFunction(() => window.__stores?.subagents !== undefined, undefined, { timeout: 45_000 });
	if (surface.name === "phone") {
		await page.getByRole("button", { name: /Open menu|메뉴 열기/ }).click();
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

/** Every running loop of the page (pseudo-elements included); a fade is no loop. */
async function runningAnimations(page: Page) {
	return page.evaluate(() =>
		document
			.getAnimations()
			.filter(animation => !(animation instanceof CSSTransition) && animation.playState === "running")
			.map(animation => {
				const effect = animation.effect as KeyframeEffect;
				return {
					name: animation instanceof CSSAnimation ? animation.animationName : "",
					inSidebar: effect.target?.closest(".omp-session-sidebar") != null,
					duration: effect.getComputedTiming().duration,
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

async function setTabs(page: Page, change: Record<string, Record<string, unknown>>): Promise<void> {
	await page.evaluate(change => {
		const tabs = window.__stores?.tabs as unknown as {
			getState(): { tabs: { id: string }[] };
			setState(partial: unknown): void;
		};
		tabs.setState({ tabs: tabs.getState().tabs.map(tab => ({ ...tab, ...change[tab.id] })) });
	}, change);
}

/** The harness's session store (`window.__stores`): `isStreaming` drives the composer's own cue. */
async function setSession(page: Page, patch: Record<string, unknown>): Promise<void> {
	await page.evaluate(patch => {
		const session = window.__stores?.session;
		if (!session) throw new Error("no session store");
		session.setState(patch);
	}, patch);
}

/** Replace the open session's subagent roster. */
async function setSubagents(page: Page, rows: unknown[]): Promise<void> {
	await page.evaluate(rows => {
		const roster = window.__stores?.subagents?.getState() as { setSnapshots(rows: unknown[]): void } | undefined;
		if (!roster) throw new Error("no subagents store");
		roster.setSnapshots(rows);
	}, rows);
}

const RUNNING_AGENT = {
	id: "r9",
	index: 9,
	agent: "task",
	assignment: "Title: Watch the build",
	status: "running",
	lastUpdate: Date.now(),
};

for (const surface of SURFACES)
	for (const theme of ["light", "dark"] as const)
		test(`running rows' titles shimmer, idle ones stay plain, a waiting one holds a still colour (${surface.name} ${theme})`, async () => {
			test.setTimeout(120_000);
			const page = await openHarness(surface, theme, false);
			await seedRunning(page);
			const sidebar = page.locator(".omp-session-sidebar").first();
			const running = sidebar.locator('.omp-sidebar-session-row[data-signal="running"]');
			await expect(running).toHaveCount(2);
			for (const row of await running.all())
				await expect(row.locator('.omp-live-text[data-working="turn"]')).toHaveCount(1);
			// The idle session (tab 3) and every child row stays plain; no border light anywhere.
			await expect(sidebar.locator("[data-working]")).toHaveCount(2);
			await expect(page.locator(".omp-live-edge")).toHaveCount(0);
			// Two transforms per working title (the masked window, the copy of its words going back); nothing else in
			// the sidebar loops, and nothing repaints.
			const inSidebar = (await runningAnimations(page)).filter(animation => animation.inSidebar);
			const shine = { inSidebar: true, duration: 3000, props: ["transform"] };
			expect(inSidebar.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
				{ name: "omp-live-shine-text", ...shine },
				{ name: "omp-live-shine-text", ...shine },
				{ name: "omp-live-shine-text-hold", ...shine },
				{ name: "omp-live-shine-text-hold", ...shine },
			]);
			// The family chip shows its count once: the filled running pill with the kind glyph, no plain count beside it.
			await expect(sidebar.locator("[data-family-running]")).toHaveCount(1);
			await expect(sidebar.locator("[data-family-agents], [data-family-sessions]")).toHaveCount(0);
			await expect(sidebar.locator("[data-family-running] svg")).toHaveCount(1);
			if (CAPTURES) {
				await fs.mkdir(CAPTURES, { recursive: true });
				await sidebar.screenshot({ path: path.join(CAPTURES, `working-${surface.name}-${theme}.png`) });
			}

			// A session that waits for an answer keeps its warning look; its title holds a still warning colour.
			await setTabs(page, { "tab-2": { awaitingInput: "input" } });
			const waiting = sidebar.locator('.omp-sidebar-session-row[data-signal="waiting"] .omp-live-text');
			await expect(waiting).toHaveAttribute("data-working", "waiting");
			await expect(waiting).toHaveCSS("animation-name", "none");
			if (CAPTURES)
				await sidebar.screenshot({ path: path.join(CAPTURES, `working-${surface.name}-${theme}-waiting.png`) });

			// The open session's turn ends while its two subagents still work: its title keeps the shimmer, fainter at
			// the same pace, and says nothing is running in front.
			await setTabs(page, { "tab-1": { status: "ready" } });
			const background = sidebar.locator('.omp-sidebar-session-row .omp-live-text[data-working="background"]');
			await expect(background).toHaveCount(1);
			await expect(sidebar.locator('.omp-sidebar-session-row[data-signal="running"]')).toHaveCount(0);
			await expect(background.locator(".omp-live-shine-window")).toHaveCSS("animation-duration", "3s");
			if (CAPTURES)
				await sidebar.screenshot({ path: path.join(CAPTURES, `working-${surface.name}-${theme}-background.png`) });
			await page.context().close();
		});

for (const surface of SURFACES)
	test(`the composer's background sweeps while a turn runs, fainter for background work, still while waiting (${surface.name})`, async () => {
		test.setTimeout(120_000);
		const page = await openHarness(surface, "light", false);
		if (surface.name === "phone") await page.keyboard.press("Escape");
		const box = page.locator(".omp-composer-box").first();
		const sweep = box.locator(":scope > .omp-live-sweep");
		await expect(sweep).toHaveCount(0);
		await setSession(page, { isStreaming: true });
		await expect(sweep).toHaveAttribute("data-working", "turn");
		// Behind the box's content, never over the text; one transform loop.
		await expect(sweep).toHaveCSS("z-index", "-1");
		await expect(sweep).toHaveCSS("pointer-events", "none");
		const loops = (await runningAnimations(page)).filter(animation => animation.name === "omp-live-shine-sweep");
		expect(loops).toEqual([{ name: "omp-live-shine-sweep", inSidebar: false, duration: 3000, props: ["transform"] }]);
		// Typing during the turn: the text stays above the light.
		const field = box.locator("textarea").first();
		await field.fill("Check the attachments again");
		await expect(sweep).toHaveAttribute("data-working", "turn");
		await setSubagents(page, [RUNNING_AGENT]);
		await setSession(page, { isStreaming: false });
		await expect(sweep).toHaveAttribute("data-working", "background");
		await page.context().close();
	});

const SHOTS = process.env.OMP_GUI_WORKING_SHOTS;
if (SHOTS)
	for (const surface of SURFACES)
		for (const theme of ["light", "dark"] as const)
			for (const lang of ["en", "ko"] as const)
				test(`captures: working cue (${surface.name} ${theme} ${lang})`, async () => {
					test.setTimeout(180_000);
					const page = await openHarness(surface, theme, false, lang);
					await seedRunning(page);
					const tag = `${surface.name}-${theme}-${lang}`;
					await fs.mkdir(path.join(SHOTS, "frames"), { recursive: true });
					const sidebar = page.locator(".omp-session-sidebar").first();
					await sidebar.screenshot({ path: path.join(SHOTS, `sidebar-turn-${tag}.png`) });
					// Frame strip of the title shimmer: eight frames across one period.
					const row = sidebar.locator('.omp-sidebar-session-row[data-signal="running"]').first();
					for (let frame = 0; frame < 8; frame++) {
						await row.screenshot({ path: path.join(SHOTS, "frames", `row-${tag}-${frame}.png`) });
						await page.waitForTimeout(375);
					}
					await setTabs(page, { "tab-2": { awaitingInput: "input" } });
					await sidebar.screenshot({ path: path.join(SHOTS, `sidebar-waiting-${tag}.png`) });
					await setTabs(page, { "tab-1": { status: "ready" } });
					await sidebar.screenshot({ path: path.join(SHOTS, `sidebar-background-${tag}.png`) });
					await setTabs(page, {
						"tab-1": { status: "ready" },
						"tab-2": { status: "ready", awaitingInput: undefined },
					});
					await setSubagents(page, []);
					await sidebar.screenshot({ path: path.join(SHOTS, `sidebar-done-${tag}.png`) });
					if (surface.name === "phone") await page.keyboard.press("Escape");
					const box = page.locator(".omp-composer-box").first();
					await setSession(page, { isStreaming: true });
					await page.waitForTimeout(400);
					for (let frame = 0; frame < 8; frame++) {
						await box.screenshot({ path: path.join(SHOTS, "frames", `composer-${tag}-${frame}.png`) });
						await page.waitForTimeout(375);
					}
					await box.screenshot({ path: path.join(SHOTS, `composer-turn-${tag}.png`) });
					await box
						.locator("textarea")
						.first()
						.fill(
							lang === "ko"
								? "첨부 파일을 다시 확인해 줘. 특히 PDF가 열리는지"
								: "Check the attachments again, especially whether the PDF opens",
						);
					await page.waitForTimeout(1500);
					await box.screenshot({ path: path.join(SHOTS, `composer-typing-${tag}.png`) });
					await page.screenshot({ path: path.join(SHOTS, `window-typing-${tag}.png`) });
					await box.locator("textarea").first().fill("");
					await setSession(page, { isStreaming: false });
					await setSubagents(page, [RUNNING_AGENT]);
					await page.waitForTimeout(1500);
					await box.screenshot({ path: path.join(SHOTS, `composer-background-${tag}.png`) });
					await page.context().close();
				});

for (const surface of SURFACES)
	test(`a session title starts at its group's content edge; a child sits one step in (${surface.name})`, async () => {
		test.setTimeout(120_000);
		const page = await openHarness(surface, "light", false);
		await seedRunning(page);
		const sidebar = page.locator(".omp-session-sidebar").first();
		const geometry = await sidebar.evaluate(root => {
			const contentLeft = (element: Element) =>
				element.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(element).paddingLeft);
			const headerOf = (row: Element) => {
				const device = row.closest("[data-device-group]");
				if (device) return device.querySelector(":scope > div:first-child button");
				return row.closest("[data-session-group]")?.previousElementSibling?.querySelector("button") ?? null;
			};
			const rows = [...root.querySelectorAll(".omp-sidebar-session-row")].map(row => {
				const header = headerOf(row);
				return {
					text: (row.textContent ?? "").slice(0, 20),
					title: Math.round((row.querySelector("button") as Element).getBoundingClientRect().left),
					group: header ? Math.round(contentLeft(header)) : null,
				};
			});
			const parent = root.querySelector(".omp-sidebar-session-row[data-signal='running'] button");
			const child = root.querySelector("[data-sidebar-subagent] [data-family-glyph]");
			return {
				rows,
				parentTitle: parent ? Math.round(parent.getBoundingClientRect().left) : null,
				childGlyph: child ? Math.round(child.getBoundingClientRect().left) : null,
			};
		});
		// Local rows and a paired host's rows alike: nothing leads a title.
		expect(geometry.rows.length).toBeGreaterThan(3);
		for (const row of geometry.rows) expect(row, row.text).toMatchObject({ title: row.group });
		// A family child's glyph starts 6 px past its parent's title (its own title one step further in).
		expect(geometry.childGlyph).toBe((geometry.parentTitle ?? 0) + 6);
		// The unseen-finish mark, when a row has one, sits at its end.
		for (const mark of await sidebar.locator("[data-sidebar-done]").all())
			await expect(mark.locator("xpath=ancestor::*[@data-sidebar-row-end]")).toHaveCount(1);
		await page.context().close();
	});

for (const surface of SURFACES)
	test(`reduced motion: nothing moves; a working title holds a still accent cast (${surface.name})`, async () => {
		test.setTimeout(120_000);
		const page = await openHarness(surface, "dark", true);
		await seedRunning(page);
		const sidebar = page.locator(".omp-session-sidebar").first();
		const title = sidebar.locator('.omp-sidebar-session-row[data-signal="running"] .omp-live-text').first();
		await expect(title).toHaveAttribute("data-working", "turn");
		await setSession(page, { isStreaming: true });
		expect((await runningAnimations(page)).filter(animation => animation.name.startsWith("omp-live-"))).toEqual([]);
		await expect(title).not.toHaveCSS("-webkit-text-fill-color", "rgba(0, 0, 0, 0)");
		await page.context().close();
	});
