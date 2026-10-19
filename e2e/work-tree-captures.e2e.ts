/**
 * Opt-in captures of the family cost and the Work tree view (`OMP_GUI_WORK_TREE_SHOTS=<dir>`), on the dev harness
 * (`vite.harness.config.ts`): a session with running and finished subagents (each with a model, role and cost), two
 * sessions its agent opened (one on a paired device), and the harness's unused
 * worktrees (`dev-harness/fixture-work-tree.ts`). Writes `<surface>-<view>-<theme>-<lang>.png` for desktop
 * (1280×800) and phone (390 wide) × light/dark × en/ko, and asserts what each child row tells (its model and cost) and that
 * the chip and the Work tree head show the same whole-family cost.
 * Behaviour is covered by `WorkTreePanel.test.tsx`, `work-tree.test.ts`, `sidebar-family.test.ts`.
 */
import * as fs from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { type Browser, chromium, expect, type Page, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

const SHOTS = process.env.OMP_GUI_WORK_TREE_SHOTS;

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

const SURFACES = [
	{ name: "desktop", viewport: { width: 1280, height: 800 }, mobile: false },
	{ name: "phone", viewport: { width: 390, height: 844 }, mobile: true },
] as const;

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

	for (const surface of SURFACES)
		for (const theme of ["light", "dark"] as const)
			for (const lang of ["en", "ko"] as const)
				test(`work tree ${surface.name} ${theme} ${lang}`, async () => {
					test.setTimeout(120_000);
					if (!browser) throw new Error("no browser");
					const context = await browser.newContext({
						viewport: surface.viewport,
						...(surface.mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 3 } : {}),
					});
					const page = await context.newPage();
					await page.goto(`${origin}/harness.html?theme=${theme}&lang=${lang}`);
					await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
					await page.waitForFunction(() => window.__stores?.agentReview !== undefined, undefined, {
						timeout: 45_000,
					});
					await seed(page);
					await fs.mkdir(SHOTS, { recursive: true });
					const file = (view: string) => path.join(SHOTS, `${surface.name}-${view}-${theme}-${lang}.png`);

					if (surface.mobile) await page.getByRole("button", { name: /Open menu|메뉴 열기/ }).click();
					const chip = page.locator("[data-sidebar-subagents-toggle]").first();
					await expect(chip.locator("[data-family-cost]")).toBeVisible();
					const chipCost = (await chip.locator("[data-family-cost]").textContent())?.replace("·", "").trim();
					await chip.click();
					await page.screenshot({ path: file("sidebar") });
					if (surface.mobile) await page.keyboard.press("Escape");

					await page.evaluate(() => window.__stores?.ui.setState({ panelVisible: true, panelTab: "work" }));
					await expect(page.locator("[data-work-tree]")).toBeVisible();
					await expect(page.locator("[data-orphan-worktree]")).toHaveCount(5);
					// Every child row names its model and cost.
					const titles = await page
						.locator("[data-work-tree-row]:not([data-work-tree-depth='0']):not([data-work-tree-kind='branch'])")
						.evaluateAll(rows => rows.map(row => row.getAttribute("title") ?? ""));
					expect(titles.length).toBeGreaterThan(2);
					for (const title of titles) expect(title).toMatch(/\$\d/);
					// One rule everywhere: the chip and the tree head show the same whole-family cost.
					const head = (await page.locator("[data-work-tree-summary]").first().textContent())?.trim();
					expect(head).toBe(chipCost);
					await page.screenshot({ path: file("panel") });
					await page.locator("[data-work-tree-finished]").first().click();
					await page.screenshot({ path: file("panel-finished") });
					await context.close();
				});
}

/** A family with every kind of child the view lists, its usage as main would push it. */
async function seed(page: Page): Promise<void> {
	await page.evaluate(() => {
		const stores = window.__stores;
		if (!stores) throw new Error("no stores");
		const tabsState = stores.tabs.getState() as { tabs: { id: string; sessionPath?: string; cwd: string }[] };
		const parent = tabsState.tabs[0];
		if (!parent) throw new Error("no tab");
		const parentPath = parent.sessionPath ?? "/s/parent.jsonl";
		stores.tabs.setState({
			tabs: [
				{ ...parent, sessionPath: parentPath },
				{
					id: "kid1",
					cwd: "/Users/me/.omp/wt/gui-agent-parser-1a2b3c4",
					status: "running",
					kind: "agent",
					title: "Parser fix",
					openedBy: parent.id,
					sessionPath: "/s/kid1.jsonl",
					worktree: {
						name: "parser",
						path: "/Users/me/.omp/wt/gui-agent-parser-1a2b3c4",
						branch: "omp/agent/parser",
						baseCwd: parent.cwd,
					},
				},
				{
					id: "kid2",
					cwd: "C:\\Users\\me\\acme-web",
					status: "running",
					kind: "agent",
					title: "Windows build check",
					openedBy: parent.id,
					sessionPath: "C:\\s\\kid2.jsonl",
					device: "pc1",
				},
			],
		});
		stores.agentReview.setState({
			byTab: {
				[parent.id]: [
					{
						tabId: "kid1",
						title: "Parser fix",
						state: "running",
						branch: "omp/agent/parser",
						baseBranch: "main",
						commitsAhead: 2,
						files: 3,
						added: 40,
						removed: 6,
						uncommitted: 0,
						answer: "",
						step: "Running tests",
					},
				],
			},
			usage: {
				// The session itself: the base of the family's cost on its chip and its Work tree head.
				[parentPath]: { cost: 0.21 },
				"/s/kid1.jsonl": { model: "openai/gpt-5.5-codex", cost: 0.18 },
				"C:\\s\\kid2.jsonl": { model: "anthropic/claude-sonnet-5", cost: 0.09 },
			},
		});

		const agent = (
			id: string,
			index: number,
			status: string,
			title: string,
			role: string,
			model: string,
			cost: number,
		) => ({
			id,
			index,
			agent: "task",
			status,
			lastUpdate: Date.now(),
			assignment: `Title: ${title}\n\nbody`,
			progress: {
				index,
				id,
				agent: "task",
				agentSource: "bundled",
				status: status === "completed" ? "completed" : "running",
				task: title,
				recentTools: [],
				recentOutput: [],
				toolCount: 4,
				requests: 2,
				tokens: 24_000,
				cost,
				durationMs: 90_000,
				modelRole: role,
				resolvedModel: model,
			},
		});
		(stores.subagents.getState() as { setSnapshots(rows: unknown[]): void }).setSnapshots([
			agent("s1", 1, "running", "Read the config loader", "smol", "anthropic/claude-haiku-5", 0.03),
			agent("s2", 2, "running", "Trace the cache miss", "task", "anthropic/claude-sonnet-5", 0.07),
			agent("s3", 3, "completed", "List the call sites", "smol", "anthropic/claude-haiku-5", 0.01),
		]);
	});
}
