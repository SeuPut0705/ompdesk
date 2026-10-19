/**
 * A session that works wears the composer's light on its card (`LiveEdge`): three tabs run on the fake omp while a
 * fourth sits idle in front. Their sidebar rows carry the light (two transform-only bars over a still 1 px accent
 * edge), the idle row does not; split with one of them, the running pane's header carries it and the idle pane's
 * does not; under reduced motion nothing moves and the still edge stays. `OMP_GUI_ROW_GLOW=<dir>` writes captures.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import { captureTo, exitApp, launchApp } from "./harness";

const CAPTURES = process.env.OMP_GUI_ROW_GLOW;

/** Running CSS animations inside `scope`, with the properties each one moves. */
async function lightAnimations(page: Page, scope: string) {
	return page.evaluate(selector => {
		const root = document.querySelector(selector);
		if (!root) return [];
		return root
			.getAnimations({ subtree: true })
			.filter(
				animation =>
					animation instanceof CSSAnimation &&
					animation.playState === "running" &&
					animation.animationName.startsWith("omp-live-edge"),
			)
			.map(animation => ({
				name: (animation as CSSAnimation).animationName,
				owner:
					(animation.effect as KeyframeEffect).target
						?.closest("[data-session-path]")
						?.getAttribute("data-session-path") ?? "",
				props: [
					...new Set(
						(animation.effect as KeyframeEffect)
							.getKeyframes()
							.flatMap(frame => Object.keys(frame))
							.filter(key => !["offset", "easing", "composite", "computedOffset"].includes(key)),
					),
				],
			}));
	}, scope);
}

async function launch(): Promise<{ app: ElectronApplication; page: Page; profile: string }> {
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-row-glow-"));
	const [project, desktop, agent] = ["project", "desktop", "agent"].map(name => path.join(profile, name));
	await Promise.all([project, desktop, agent].map(dir => fs.mkdir(dir as string)));
	await fs.writeFile(
		path.join(desktop as string, "prefs.json"),
		JSON.stringify({ language: "en", firstRunComplete: true }),
	);
	const app = await launchApp({
		project: project as string,
		desktop: desktop as string,
		agent: agent as string,
		profile,
	});
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
	return { app, page, profile };
}

/** Three running tabs (ids[0..2]) and a fourth idle one in front. */
async function threeRunning(page: Page): Promise<string[]> {
	const tabs = () => page.evaluate(() => window.omp.tabs.list());
	const ids = [(await tabs())[0]?.tabId ?? ""];
	for (let i = 0; i < 3; i++) {
		const before = (await tabs()).map(tab => tab.tabId);
		await page.keyboard.press("ControlOrMeta+t");
		await expect.poll(async () => (await tabs()).length).toBe(before.length + 1);
		const created = (await tabs()).find(tab => !before.includes(tab.tabId));
		if (!created) throw new Error("No new tab");
		await expect.poll(async () => (await tabs()).find(tab => tab.tabId === created.tabId)?.status).toBe("ready");
		ids.push(created.tabId);
	}
	for (const id of ids.slice(0, 3))
		await page.evaluate(
			tabId => window.omp.rpc.commandForTab(tabId, { type: "prompt", message: "fixture running" }),
			id,
		);
	return ids;
}

const row = (page: Page, id: string) => page.locator(`[data-session-path="tab:${id}"]`);

test("three running tabs light their rows and a split's running pane header, the idle ones stay dark", async () => {
	test.setTimeout(120_000);
	const { app, page, profile } = await launch();
	try {
		const ids = await threeRunning(page);
		const running = ids.slice(0, 3);
		const idle = ids[3] ?? "";
		const software = (await page.locator("html").getAttribute("data-gpu")) === "software";
		for (const id of running) {
			await expect(row(page, id)).toHaveAttribute("data-signal", "running");
			await expect(row(page, id).locator(".omp-live-edge[data-live-edge-inside]")).toHaveCount(1);
		}
		await expect(row(page, idle)).not.toHaveAttribute("data-signal", "running");
		await expect(row(page, idle).locator(".omp-live-edge")).toHaveCount(0);
		// No row wears the old left-edge bar or its light any more.
		await expect(page.locator(".omp-sidebar-session-row[data-signal='running']")).toHaveCount(3);

		// The light is two bars per card moving a transform and nothing else; software compositing keeps it still.
		const moving = await lightAnimations(page, ".omp-session-sidebar");
		if (software) expect(moving).toEqual([]);
		else {
			// Two bars per lit card, nothing else in the sidebar.
			const owners = moving.map(animation => animation.owner);
			expect(owners.toSorted()).toEqual(running.flatMap(id => [`tab:${id}`, `tab:${id}`]).toSorted());
			for (const animation of moving)
				expect(animation).toMatchObject({ name: "omp-live-edge-run", props: ["transform"] });
		}
		for (const theme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: theme });
			await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
			await captureTo(CAPTURES, page, `electron-three-running-${theme}`);
		}

		// Split the idle pane with a running tab: the running pane's header wears the light, the idle one's does not.
		await row(page, running[0] ?? "").click({ button: "right" });
		await page.getByRole("menuitem", { name: "Split right" }).click();
		const header = (id: string) => page.locator(`.omp-session-pane[data-tab-id="${id}"] header`);
		await expect(header(running[0] ?? "")).toHaveAttribute("data-pane-running", "true");
		await expect(header(running[0] ?? "").locator(".omp-live-edge[data-live-edge-inside]")).toHaveCount(1);
		await expect(header(idle).locator(".omp-live-edge")).toHaveCount(0);
		await captureTo(CAPTURES, page, "electron-split-header");

		// Reduced motion: nothing moves in a row's or a header's light (the composer's own is pinned by
		// composer-live.e2e.ts); the still edge stays.
		await page.emulateMedia({ reducedMotion: "reduce" });
		await expect.poll(() => lightAnimations(page, ".omp-session-sidebar")).toEqual([]);
		await expect
			.poll(() => lightAnimations(page, `.omp-session-pane[data-tab-id="${running[0]}"] header`))
			.toEqual([]);
		await expect(row(page, running[1] ?? "").locator(".omp-live-edge")).toHaveCSS("border-top-width", "1px");
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
