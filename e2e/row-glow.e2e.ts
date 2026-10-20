/**
 * A session that works shimmers its own title: three tabs run on the fake omp while a fourth sits idle in front.
 * Their sidebar rows' titles carry the sweep (one CSS animation of the text's background position, nothing else
 * moves), the idle row's does not; split with one of them, the running pane's header title sweeps and the idle pane's
 * does not; when that pane's turn ends while a subagent it started still works, its row and header keep the sweep in
 * its fainter form, at the same pace, until the subagents finish, and so does a tab stock reports unsettled after its
 * turn (`prompt_result.sessionSettled: false`, main's `settling`); under reduced motion nothing moves and the title
 * holds a still accent cast. No border light anywhere. `OMP_GUI_ROW_GLOW=<dir>` writes captures.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import { captureTo, exitApp, launchApp } from "./harness";

const CAPTURES = process.env.OMP_GUI_ROW_GLOW;

/** The running loops inside `scope` (pseudo-elements included), with what each animates. */
async function lightAnimations(page: Page, scope: string) {
	return page.evaluate(selector => {
		const root = document.querySelector(selector);
		if (!root) return [];
		return root
			.getAnimations({ subtree: true })
			.filter(
				animation =>
					animation.playState === "running" &&
					animation.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY,
			)
			.map(animation => {
				const target = (animation.effect as KeyframeEffect).target;
				return {
					name: animation instanceof CSSAnimation ? animation.animationName : "",
					title: target?.classList.contains("omp-live-text") === true,
					owner: target?.closest("[data-session-path]")?.getAttribute("data-session-path") ?? "",
					duration: animation.effect?.getComputedTiming().duration,
					props: [
						...new Set(
							(animation.effect as KeyframeEffect)
								.getKeyframes()
								.flatMap(frame => Object.keys(frame))
								.filter(key => !["offset", "easing", "composite", "computedOffset"].includes(key)),
						),
					],
				};
			});
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

test("three running tabs sweep their titles and a split's running pane header title, the idle ones stay plain", async () => {
	test.setTimeout(120_000);
	const { app, page, profile } = await launch();
	try {
		const ids = await threeRunning(page);
		const running = ids.slice(0, 3);
		const idle = ids[3] ?? "";
		const software = (await page.locator("html").getAttribute("data-gpu")) === "software";
		for (const id of running) {
			await expect(row(page, id)).toHaveAttribute("data-signal", "running");
			await expect(row(page, id).locator('.omp-live-text[data-working="turn"]')).toHaveCount(1);
		}
		await expect(row(page, idle)).not.toHaveAttribute("data-signal", "running");
		await expect(row(page, idle).locator("[data-working]")).toHaveCount(0);
		await expect(page.locator(".omp-live-edge")).toHaveCount(0);
		await expect(page.locator(".omp-sidebar-session-row[data-signal='running']")).toHaveCount(3);

		// The sweep is one animation per working title, of its text's background position and nothing else;
		// software compositing keeps it still.
		const moving = await lightAnimations(page, ".omp-session-sidebar");
		if (software) expect(moving).toEqual([]);
		else {
			// Only the working titles move, nothing else in the sidebar.
			expect(moving.map(animation => animation.owner).toSorted()).toEqual(running.map(id => `tab:${id}`).toSorted());
			for (const animation of moving)
				expect(animation).toMatchObject({
					name: "omp-live-shine-text",
					title: true,
					props: ["backgroundPositionX"],
					duration: 3000,
				});
		}
		for (const theme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: theme });
			await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
			await captureTo(CAPTURES, page, `electron-three-running-${theme}`);
		}

		// Split the idle pane with a running tab: the running pane's header title sweeps, the idle one's does not.
		await row(page, running[0] ?? "").click({ button: "right" });
		await page.getByRole("menuitem", { name: "Split right" }).click();
		const header = (id: string) => page.locator(`.omp-session-pane[data-tab-id="${id}"] header`);
		await expect(header(running[0] ?? "")).toHaveAttribute("data-pane-running", "true");
		await expect(header(running[0] ?? "").locator('.omp-live-text[data-working="turn"]')).toHaveCount(1);
		await expect(header(idle).locator("[data-working]")).toHaveCount(0);
		await captureTo(CAPTURES, page, "electron-split-header");

		// The pane's turn ends while the subagents it started still work: its row and its header title keep the
		// sweep, fainter at the same pace (a switch never retimes it); the subagents finishing end it.
		const behind = running[0] ?? "";
		const fixture = (command: string) =>
			page.evaluate(
				([tabId, line]) => window.omp.rpc.commandForTab(tabId as string, { type: "bash", command: line as string }),
				[behind, command],
			);
		await fixture("fixture:subagents");
		await fixture("fixture:finish");
		await expect(row(page, behind)).not.toHaveAttribute("data-signal", "running");
		await expect(header(behind)).not.toHaveAttribute("data-pane-running", "true");
		await expect(row(page, behind).locator('.omp-live-text[data-working="background"]')).toHaveCount(1);
		await expect(header(behind).locator('.omp-live-text[data-working="background"]')).toHaveCount(1);
		if (!software)
			expect(
				new Set(
					(await lightAnimations(page, `[data-session-path="tab:${behind}"]`)).map(
						animation => animation.duration,
					),
				),
			).toEqual(new Set([3000]));
		for (const theme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: theme });
			await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
			await captureTo(CAPTURES, page, `electron-background-${theme}`);
		}
		for (const id of ["sa-explore", "sa-nested"]) await fixture(`fixture:subagents:finish:${id}`);
		await expect(row(page, behind).locator("[data-working]")).toHaveCount(0);
		await expect(header(behind).locator("[data-working]")).toHaveCount(0);

		// Stock's own case: a turn spawns a background subagent and ends, and `prompt_result` says the session is not
		// settled. Main still reports the tab running (resume, Stop), marked `settling`: the idle pane's row and header
		// wear the background form, never the turn's.
		await page.evaluate(
			tabId => window.omp.rpc.commandForTab(tabId, { type: "prompt", message: "fixture background subagent" }),
			idle,
		);
		await expect(page.getByText("Watcher is on the release build in the background.")).toBeVisible();
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === idle))
			.toMatchObject({ status: "running", settling: true });
		await expect(row(page, idle).locator('.omp-live-text[data-working="background"]')).toHaveCount(1);
		await expect(header(idle).locator('.omp-live-text[data-working="background"]')).toHaveCount(1);
		await expect(header(idle)).not.toHaveAttribute("data-pane-running", "true");
		await captureTo(CAPTURES, page, "electron-settling");

		// Reduced motion: nothing moves in a row's or a header's title (the composer's own sweep is pinned by
		// composer-live.e2e.ts); the title keeps a still accent cast.
		await page.emulateMedia({ reducedMotion: "reduce" });
		await expect.poll(() => lightAnimations(page, ".omp-session-sidebar")).toEqual([]);
		await expect
			.poll(() => lightAnimations(page, `.omp-session-pane[data-tab-id="${running[0]}"] header`))
			.toEqual([]);
		await expect(row(page, running[1] ?? "").locator(".omp-live-text")).not.toHaveCSS(
			"-webkit-text-fill-color",
			"rgba(0, 0, 0, 0)",
		);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
