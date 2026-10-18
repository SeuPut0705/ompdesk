/**
 * A session's family in the sidebar stays folded (reported on v0.38.1 on a phone: the family under a long
 * orchestration session kept opening by itself, each follow-up message to a subagent being a new run) and its rows
 * read the ORIGINAL assignment's `Title:` line, never a follow-up message or stock's "Complete assignment
 * thoroughly:" wrapper. Runs on the dev harness (the renderer in a browser over a fixture transport,
 * `vite.harness.config.ts`) with the frames stock emits for a first run, a follow-up to an idle subagent and a
 * restart's revival, on the desktop and on a phone. `OMP_GUI_FAMILY_FOLD=<dir>` also writes the folded/open
 * captures (light/dark × ko).
 */
import * as fs from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { type Browser, chromium, devices, expect, type Page, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

const CAPTURES = process.env.OMP_GUI_FAMILY_FOLD;

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

test.describe.configure({ retries: 1 });

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

const ORIGINALS = [
	["0-MacCheck", "Title: 맥에서 7e3ec34a 확인"],
	["1-ThemeSplit", "Title: 휴대폰 테마 설정 분리"],
	["2-Samsung", "Title: 삼성 휴대폰 첨부 확인"],
	["3-Release", "Title: v0.38.2 배포"],
	["4-Restart", "Title: 재시작 뒤 서브에이전트 이어가기"],
	["5-Review", "Title: 사이드바 묶음 리뷰"],
] as const;

async function openHarness(surface: Surface, theme: "light" | "dark", lang: "en" | "ko"): Promise<Page> {
	if (!browser) throw new Error("no browser");
	const context = await browser.newContext(surface.context);
	const page = await context.newPage();
	await page.goto(`${origin}/harness.html?theme=${theme}&lang=${lang}`);
	await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
	await page.waitForFunction(() => window.__stores?.subagents !== undefined, undefined, { timeout: 45_000 });
	return page;
}

/** The frames stock sends: first runs, then a follow-up to some, and the revival of others. */
async function seedFamily(page: Page): Promise<void> {
	await page.evaluate(originals => {
		const stores = window.__stores;
		if (!stores) throw new Error("no stores");
		const store = stores.subagents.getState() as { applyFrame(frame: unknown): void };
		const wrap = (assignment: string) => `Complete assignment thoroughly:\n\n${assignment}`;
		const progress = (id: string, index: number, task: string, assignment: string | undefined, status: string) => ({
			type: "subagent_progress",
			payload: {
				index,
				agent: "task",
				agentSource: "bundled",
				task,
				assignment,
				detached: true,
				sessionFile: `/tmp/${id}.jsonl`,
				progress: {
					index,
					id,
					agent: "task",
					agentSource: "bundled",
					status,
					task,
					assignment,
					recentTools: [],
					recentOutput: [],
					toolCount: 2,
					requests: 1,
					tokens: 1200,
					cost: 0,
					durationMs: 60_000,
				},
			},
		});
		originals.forEach(([id, assignment], index) => {
			const body = `${assignment}\n\n# Target\nsomething`;
			if (index % 3 === 2) {
				// A revival after a restart: the wrapped original, no assignment.
				store.applyFrame(progress(id, index, wrap(body), undefined, "running"));
				return;
			}
			store.applyFrame(progress(id, index, wrap(body), body, "running"));
			if (index % 3 === 1) {
				// A follow-up message to the idle subagent: its text is `task`, no assignment.
				store.applyFrame(
					progress(id, index, "Your mac check in 7e3ec34a looked fine, now go on.", undefined, "running"),
				);
			}
		});
	}, ORIGINALS);
}

async function openSidebar(page: Page, surface: Surface): Promise<void> {
	if (surface.name !== "phone") return;
	await page.getByRole("button", { name: /Open menu|메뉴 열기/ }).click();
	await expect(page.locator("[data-drawer] .omp-session-sidebar")).toBeVisible();
}

const chip = (page: Page) => page.locator("[data-sidebar-subagents-toggle]").first();

async function capture(page: Page, surface: Surface, theme: string, state: string): Promise<void> {
	if (!CAPTURES) return;
	await fs.mkdir(CAPTURES, { recursive: true });
	await page.screenshot({ path: path.join(CAPTURES, `${surface.name}-${state}-${theme}-ko.png`) });
}

for (const surface of SURFACES)
	for (const theme of ["light", "dark"] as const)
		test(`the family stays folded and reads its original titles (${surface.name} ${theme} ko)`, async () => {
			test.setTimeout(120_000);
			const page = await openHarness(surface, theme, "ko");
			await openSidebar(page, surface);
			await seedFamily(page);
			await expect(chip(page)).toBeVisible();
			// Six at work, folded, and it stays so as more runs start.
			await expect(chip(page)).toHaveAttribute("aria-expanded", "false");
			await expect(chip(page).locator("[data-family-running]")).toHaveText("6");
			await seedFamily(page);
			await page.waitForTimeout(400);
			await expect(chip(page)).toHaveAttribute("aria-expanded", "false");
			await expect(page.locator("[data-sidebar-subagent]")).toHaveCount(0);
			await capture(page, surface, theme, "folded");

			await chip(page).click();
			await expect(chip(page)).toHaveAttribute("aria-expanded", "true");
			const rows = page.locator("[data-sidebar-subagent]");
			await expect(rows).toHaveCount(6);
			const titles = await rows.evaluateAll(nodes =>
				nodes.map(node => node.querySelector("button")?.firstElementChild?.textContent ?? node.textContent ?? ""),
			);
			const text = (await rows.allInnerTexts()).join("\n");
			for (const [, assignment] of ORIGINALS) expect(text).toContain(assignment.slice("Title: ".length));
			expect(text).not.toContain("Complete assignment");
			expect(text).not.toContain("Your mac check");
			expect(titles.length).toBe(6);
			await capture(page, surface, theme, "open");

			// The person's own fold is remembered through a new run.
			await chip(page).click();
			await seedFamily(page);
			await page.waitForTimeout(400);
			await expect(chip(page)).toHaveAttribute("aria-expanded", "false");
			await page.context().close();
		});

test("a child waiting for the person shows alone under the folded parent, the chip tinted (phone dark ko)", async () => {
	test.setTimeout(120_000);
	const surface = SURFACES[0];
	if (!surface) throw new Error("no surface");
	const page = await openHarness(surface, "dark", "ko");
	await openSidebar(page, surface);
	await page.evaluate(() => {
		const stores = window.__stores;
		if (!stores) throw new Error("no stores");
		const subagents = stores.subagents.getState() as { setSnapshots(rows: unknown[]): void };
		subagents.setSnapshots([
			{
				id: "r1",
				index: 1,
				agent: "task",
				assignment: "Title: 테마 정리",
				status: "running",
				lastUpdate: Date.now(),
			},
			{
				id: "r2",
				index: 2,
				agent: "task",
				assignment: "Title: 첨부 확인",
				status: "running",
				lastUpdate: Date.now(),
			},
			{
				id: "w1",
				index: 3,
				agent: "task",
				assignment: "Title: 배포 승인 받기",
				status: "stale",
				live: false,
				lastUpdate: Date.now(),
			},
		]);
	});
	await expect(chip(page)).toHaveAttribute("aria-expanded", "false");
	await expect(chip(page)).toHaveAttribute("data-family-waiting", "1");
	const rows = page.locator("[data-sidebar-subagent]");
	await expect(rows).toHaveCount(1);
	await expect(rows.first()).toContainText("배포 승인 받기");
	// The drawer's slide-in is over before the shot.
	await page.waitForTimeout(700);
	await capture(page, surface, "dark", "waiting");
	await page.context().close();
});
