/**
 * Opt-in captures of an Autopilot run's home on the work board (`OMP_GUI_AUTOPILOT_BOARD_SHOTS=<dir>`, optional
 * `OMP_GUI_AUTOPILOT_BOARD_LABEL=<prefix>`), on the dev harness (`vite.harness.config.ts`) with a run's status put into
 * the focused tab's Autopilot store. Every layout a run must be reachable in: the board docked in a wide window, a
 * narrow window, a split pane too narrow for the board, the side panel open on Terminal, the board dismissed with ✕
 * and a phone; each × light/dark × en/ko. Where the board cannot dock, the composer chip's "open" button expands the
 * strip into the board. Writes `<label>-<layout>-<theme>-<lang>.png`.
 * Behaviour is covered by `WorkBoard.autopilot.test.tsx`, `ComposerModes.autopilot.test.tsx`, `work-board.test.ts`.
 */
import * as fs from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { type Browser, chromium, expect, type Page, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

const SHOTS = process.env.OMP_GUI_AUTOPILOT_BOARD_SHOTS;
const LABEL = process.env.OMP_GUI_AUTOPILOT_BOARD_LABEL ?? "after";

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

type Layout = "wide" | "narrow" | "split" | "panel" | "dismissed" | "phone";

const LAYOUTS: readonly { layout: Layout; viewport: { width: number; height: number }; mobile?: boolean }[] = [
	{ layout: "wide", viewport: { width: 1700, height: 950 } },
	{ layout: "narrow", viewport: { width: 1000, height: 820 } },
	{ layout: "split", viewport: { width: 1700, height: 950 } },
	{ layout: "panel", viewport: { width: 1700, height: 950 } },
	{ layout: "dismissed", viewport: { width: 1700, height: 950 } },
	{ layout: "phone", viewport: { width: 390, height: 844 }, mobile: true },
];

/** A run in its fourth cycle: three finished cycles (one red with the reason), a pushed PR landing, a child session. */
async function seedRun(page: Page): Promise<void> {
	await page.evaluate(() => {
		const now = Date.now();
		const cycle = (n: number, extra: Record<string, unknown>) => ({
			n,
			area: "tests",
			title: `Cycle ${n}`,
			summary: "",
			verify: "green",
			commit: `${n}a9f1c2deadbeef`,
			followups: [],
			children: [],
			startedAt: now - (5 - n) * 600_000,
			durationMs: 252_000,
			tokens: 212_000,
			usd: 0.42,
			compactions: 0,
			...extra,
		});
		const stores = (window as unknown as { __stores: Record<string, { getState: () => Record<string, unknown> }> })
			.__stores;
		(stores.autopilot.getState().apply as (status: unknown) => void)({
			active: true,
			role: "parent",
			state: "running",
			cycle: 4,
			run: "2026-10-21",
			root: "/Users/dev/projects/acme-web",
			branch: "autopilot/2026-10-21",
			baseBranch: "main",
			now: { n: 4, area: "performance", title: "Cache the session list's first read", startedAt: now - 95_000 },
			startedAt: now - 3_600_000,
			activeMs: 3_400_000,
			settings: {
				focus: [],
				ship: {
					autoPush: false,
					autoRelease: { on: false, cadence: { kind: "agent" } },
					remote: "origin",
					land: true,
				},
				limits: { tokens: null, minutes: null, cycles: null, usd: null },
				maxParallel: null,
			},
			cycles: [
				cycle(1, {
					area: "bugs",
					title: "Fix the stale draft after a tab switch",
					change: { files: 3, added: 42, removed: 5, commits: 1 },
				}),
				cycle(2, {
					area: "docs",
					title: "Explain the release cadence in AUTOPILOT.md",
					change: { files: 1, added: 8, removed: 2, commits: 1, docOnly: true },
				}),
				cycle(3, {
					area: "tests",
					title: "Cover the quota wait's wake",
					verify: "red",
					verifyNote: { kind: "check_failed", command: "bun run test" },
					commit: undefined,
				}),
			],
			redStreak: 2,
			totals: { tokens: 1_840_000, usd: 6.2, tokensPerHour: 1_200_000, usdPerHour: 3.9 },
			ship: {
				policy: {
					autoPush: false,
					autoRelease: { on: false, cadence: { kind: "agent" } },
					remote: "origin",
					land: true,
				},
				queue: [],
				landing: { via: "pr", url: "https://github.com/acme/web/pull/42", reason: "protected" },
			},
			children: [
				{ tabId: "tab-9", area: "performance", branch: "autopilot/2026-10-21-c4-performance", status: "running" },
			],
		});
	});
}

if (SHOTS) {
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

	for (const { layout, viewport, mobile } of LAYOUTS)
		for (const theme of ["light", "dark"] as const)
			for (const lang of ["en", "ko"] as const)
				test(`autopilot board ${layout} ${theme} ${lang}`, async () => {
					test.setTimeout(120_000);
					if (!browser) throw new Error("no browser");
					const context = await browser.newContext({
						viewport,
						...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 3 } : {}),
					});
					const page = await context.newPage();
					await page.goto(`${origin}/harness.html?theme=${theme}&lang=${lang}`);
					await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
					await page.waitForFunction(() => window.__stores?.autopilot !== undefined, undefined, {
						timeout: 45_000,
					});
					await page.waitForTimeout(800);
					await seedRun(page);
					const ui = (method: string, ...args: unknown[]) =>
						page.evaluate(
							({ method, args }) => {
								const state = (window.__stores?.ui.getState() ?? {}) as unknown as Record<string, unknown>;
								const fn = state[method];
								if (typeof fn === "function") (fn as (...rest: unknown[]) => unknown)(...args);
								return typeof fn === "function";
							},
							{ method, args },
						);
					if (layout === "split")
						await page.evaluate(() => {
							const tabs = window.__stores?.tabs?.getState() as
								| { splitTab: (id: string, placement: string, target?: string) => Promise<void> }
								| undefined;
							return tabs?.splitTab("tab-2", "right", "tab-1");
						});
					if (layout === "panel") await ui("setPanelTab", "terminal");
					if (layout === "panel") await page.evaluate(() => window.__stores?.ui.setState({ panelVisible: true }));
					if (layout === "dismissed") await ui("setWorkBoard", false);
					await page.waitForTimeout(600);
					await fs.mkdir(SHOTS, { recursive: true });
					const file = (name: string) => path.join(SHOTS, `${LABEL}-${name}-${theme}-${lang}.png`);
					await page.screenshot({ path: file(layout) });
					// What the composer's "open" button shows: the old build's side panel, or the board itself.
					const open = page.locator("[data-autopilot-chip-open]").first();
					if (await open.isVisible().catch(() => false)) {
						await open.click();
						await page.waitForTimeout(700);
						await page.screenshot({ path: file(`${layout}-opened`) });
					}
					await context.close();
				});
}
