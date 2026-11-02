/**
 * A folded sidebar section says what its hidden rows would: how many wait on the person, how many work, how many
 * finished unseen (`components/layout/sidebar/fold-summary.ts`), in the rows' own marks; an open or quiet section says
 * nothing. Runs on the dev harness (the renderer in a browser over a fixture transport, `vite.harness.config.ts`) on a
 * desktop window and a 390 px phone, light and dark: this computer's projects and section, and a paired computer's
 * (the harness's `host-1`), whose folded section reads its tabs here and its live list. `OMP_GUI_FOLD_SUMMARY_SHOTS=<dir>`
 * also writes the captures.
 */
import * as fs from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { type Browser, chromium, expect, type Locator, type Page, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

const CAPTURES = process.env.OMP_GUI_FOLD_SUMMARY_SHOTS;
/** The harness's projects and sessions (`src/renderer/dev-harness/fixture.ts`). */
const PROJECT = "/Users/dev/projects/ompdesk";
const WEBSITE = "/Users/dev/projects/website";
const sessionFile = (cwd: string, id: string) => `${cwd.replace(/\//g, "-")}/${id}.jsonl`;
const HOST = "host-1";

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
	{
		name: "phone",
		context: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
	},
	{ name: "desktop", context: { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 } },
];

async function openHarness(surface: Surface, theme: "light" | "dark"): Promise<Page> {
	if (!browser) throw new Error("no browser");
	const context = await browser.newContext(surface.context);
	const page = await context.newPage();
	await page.goto(`${origin}/harness.html?theme=${theme}&lang=en`);
	await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
	await page.waitForFunction(() => window.__stores?.remote !== undefined, undefined, { timeout: 45_000 });
	if (surface.name === "phone") {
		await page.getByRole("button", { name: /Open menu/ }).click();
		await expect(page.locator("[data-drawer] .omp-session-sidebar")).toBeVisible();
	}
	return page;
}

/**
 * This computer: in ompdesk a finished run nobody looked at (tab-2), a new session at work and one waiting for an
 * approval; website (tab-3) idle. The paired computer: a tab here waits on a question in its ompdesk session, and its
 * live list says it works on its website session.
 */
async function seedWork(page: Page): Promise<void> {
	await page.evaluate(
		({ project, sess2, host, hostWaiting, hostWorking }) => {
			const stores = window.__stores;
			if (!stores) throw new Error("no stores");
			type Tab = Record<string, unknown> & { id: string };
			const tabs = (stores.tabs.getState() as { tabs: Tab[] }).tabs;
			const tab = (id: string, extra: Record<string, unknown>) => ({
				id,
				cwd: project,
				kind: "agent",
				unreadDone: false,
				...extra,
			});
			stores.tabs.setState({
				tabs: [
					...tabs.map(entry =>
						entry.sessionPath === sess2 ? { ...entry, status: "ready", unreadDone: true } : entry,
					),
					tab("tab-run", { status: "running", sessionPath: `${project}/run.jsonl`, title: "Run the e2e suite" }),
					tab("tab-ask", {
						status: "running",
						sessionPath: `${project}/ask.jsonl`,
						title: "Push the release",
						awaitingInput: "approval",
					}),
					tab("tab-host", {
						status: "running",
						device: host,
						sessionPath: hostWaiting,
						awaitingInput: "input",
					}),
				],
			});
			const remote = stores.remote.getState() as {
				state: { hosts: { deviceId: string }[] } | null;
				apply(state: unknown): void;
			};
			if (!remote.state) throw new Error("no remote state");
			remote.apply({
				...remote.state,
				hosts: remote.state.hosts.map(entry =>
					entry.deviceId === host ? { ...entry, live: [{ sessionPath: hostWorking, state: "turn" }] } : entry,
				),
			});
		},
		{
			project: PROJECT,
			sess2: sessionFile(PROJECT, "sess-2"),
			host: HOST,
			hostWaiting: sessionFile(PROJECT, "sess-1"),
			hostWorking: sessionFile(WEBSITE, "sess-3"),
		},
	);
}

const sidebar = (page: Page) => page.locator(".omp-session-sidebar").first();
const localGroup = (page: Page, cwd: string) => sidebar(page).locator(`[data-workspace-group="${cwd}"]`);
const hostSection = (page: Page) => sidebar(page).locator(`[data-sidebar-device="${HOST}"]`);
const hostGroup = (page: Page, cwd: string) => hostSection(page).locator(`[data-device-group="${cwd}"]`);
const toggle = (scope: Locator) => scope.locator("button[aria-expanded]").first();

async function expectCounts(
	scope: Locator,
	expected: { waiting?: number; running?: number; done?: number },
): Promise<void> {
	const summary = scope.locator("[data-fold-summary]").first();
	await expect(summary).toBeVisible();
	for (const kind of ["waiting", "running", "done"] as const) {
		const value = expected[kind];
		if (value === undefined) await expect(summary).not.toHaveAttribute(`data-fold-${kind}`);
		else await expect(summary).toHaveAttribute(`data-fold-${kind}`, String(value));
	}
}

async function capture(page: Page, surface: Surface, theme: string, state: string): Promise<void> {
	if (!CAPTURES) return;
	await fs.mkdir(CAPTURES, { recursive: true });
	// The pointer leaves the header it clicked: a hovered header's menu button covers the marks' end.
	if (surface.name === "desktop") await page.mouse.move(1000, 600);
	await page.waitForTimeout(400);
	await sidebar(page).screenshot({ path: path.join(CAPTURES, `${surface.name}-${state}-${theme}.png`) });
}

for (const surface of SURFACES)
	for (const theme of ["light", "dark"] as const)
		test(`a folded section counts what its rows would show; open or quiet, nothing (${surface.name} ${theme})`, async () => {
			test.setTimeout(120_000);
			const page = await openHarness(surface, theme);
			await seedWork(page);
			await expect(hostGroup(page, PROJECT)).toBeVisible();
			// Every section open: the rows say it themselves.
			await expect(sidebar(page).locator("[data-fold-summary]")).toHaveCount(0);

			await toggle(localGroup(page, PROJECT)).click();
			await expect(toggle(localGroup(page, PROJECT))).toHaveAttribute("aria-expanded", "false");
			await expectCounts(localGroup(page, PROJECT), { waiting: 1, running: 1, done: 1 });
			await expect(localGroup(page, PROJECT).locator("[data-fold-summary]")).toHaveAttribute(
				"title",
				"Needs approval · 1 running · 1 done",
			);
			// A quiet project says nothing folded.
			await toggle(localGroup(page, WEBSITE)).click();
			await expect(toggle(localGroup(page, WEBSITE))).toHaveAttribute("aria-expanded", "false");
			await expect(localGroup(page, WEBSITE).locator("[data-fold-summary]")).toHaveCount(0);

			// The paired computer's projects, by its rows' rule.
			await toggle(hostGroup(page, PROJECT)).click();
			await expectCounts(hostGroup(page, PROJECT), { waiting: 1 });
			await toggle(hostGroup(page, WEBSITE)).click();
			await expectCounts(hostGroup(page, WEBSITE), { running: 1 });
			await capture(page, surface, theme, "projects");

			// Folded whole, each computer sums its sessions.
			await sidebar(page).locator("[data-sidebar-device-toggle='local']").click();
			await expectCounts(sidebar(page).locator('[data-sidebar-device-header="local"]'), {
				waiting: 1,
				running: 1,
				done: 1,
			});
			await sidebar(page).locator(`[data-sidebar-device-toggle='${HOST}']`).click();
			await expectCounts(hostSection(page), { waiting: 1, running: 1 });
			await capture(page, surface, theme, "devices");

			// Opened again, the header gives the word back to its rows.
			await sidebar(page).locator(`[data-sidebar-device-toggle='${HOST}']`).click();
			await expect(hostSection(page).locator("[data-sidebar-device-toggle] [data-fold-summary]")).toHaveCount(0);
			await sidebar(page).locator("[data-sidebar-device-toggle='local']").click();
			await toggle(localGroup(page, PROJECT)).click();
			await expect(localGroup(page, PROJECT).locator("[data-fold-summary]")).toHaveCount(0);
			await page.context().close();
		});
