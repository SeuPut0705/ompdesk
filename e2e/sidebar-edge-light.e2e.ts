import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import { exitApp, launchApp } from "./harness";

// What the running rows' working cue costs (the shared `LiveText`, components.css `.omp-live-text`): each running
// row's own title shimmers (two transform animations: a masked window and the copy of its words). 16 s of sampling, so it runs with
// the other performance measurements (OMP_GUI_PERFORMANCE=1), not in every run. Three tabs run in the background
// while a fourth sits idle in front, so the composer's own cue is not part of the number. Measured earlier for the
// border lights (1100x800, fake omp, mean of 4 s, three runs each): the old left-edge bar 0.3-0.6 % GPU / 0.3-0.4 %
// renderer; a masked + clipped conic ring per row 1.3-1.7 % GPU; the comet of pills 0.3 % GPU / 0.2-0.3 % renderer.
// The title shimmer (20 Oct 2026, three runs each, light cost = animated minus stopped): as a background position under
// background-clip: text 0.6-0.7 % GPU / 0.6 % renderer (and it drew no words in Electron); as the masked window that
// slides over a counter-moving copy 0.8-0.9 % GPU / 0.2 % renderer, 0 paints. The GPU share is the masked layer drawn
// again every frame because its content moves inside the mask: without the mask 0.3 % GPU, the window's size barely
// matters (100 % wide 0.8 %). Stepped (`steps(50)`, the masked layer drawn about 24 times a second): 0.5-0.6 % GPU.

/** Mean CPU % of the renderer and GPU processes over a window, from Electron's own process metrics. */
async function cpu(app: ElectronApplication, ms: number): Promise<{ renderer: number; gpu: number }> {
	await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics());
	await sleep(ms);
	const metrics = await app.evaluate(({ app: electronApp }) =>
		electronApp.getAppMetrics().map(metric => ({ type: metric.type, cpu: metric.cpu.percentCPUUsage })),
	);
	const sum = (type: string) =>
		metrics.filter(metric => metric.type === type).reduce((n, metric) => n + metric.cpu, 0);
	return { renderer: sum("Tab"), gpu: sum("GPU") };
}

test("three running rows add no visible renderer or GPU cost", async () => {
	test.skip(process.env.OMP_GUI_PERFORMANCE !== "1", "performance measurement: OMP_GUI_PERFORMANCE=1");
	test.setTimeout(180_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-edge-light-"));
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
	try {
		const page: Page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 800));
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		const tabs = () => page.evaluate(() => window.omp.tabs.list());
		// A tab is typed into before the next one is opened: an empty tab the person leaves is closed.
		const open = async (current: string, title: string) => {
			await page.evaluate(([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }), [
				current,
				`fixture:title:${title}`,
			] as const);
			const before = (await tabs()).map(tab => tab.tabId);
			await page.keyboard.press("ControlOrMeta+t");
			await expect.poll(async () => (await tabs()).length).toBe(before.length + 1);
			const created = (await tabs()).find(tab => !before.includes(tab.tabId));
			if (!created) throw new Error("No new tab");
			await expect.poll(async () => (await tabs()).find(tab => tab.tabId === created.tabId)?.status).toBe("ready");
			return created.tabId;
		};
		const ids = [(await tabs())[0]?.tabId ?? ""];
		for (let i = 0; i < 3; i++) ids.push(await open(ids[i] ?? "", `Tab ${i + 1}`)); // ids[0..3]; the last stays in front
		const running = ids.slice(0, 3);

		await page.waitForTimeout(1500);
		const none = await cpu(app, 4000);

		for (const id of running) {
			await page.evaluate(
				tabId => window.omp.rpc.commandForTab(tabId, { type: "prompt", message: "fixture running" }),
				id,
			);
		}
		for (const id of running) {
			const row = page.locator(`[data-session-path="tab:${id}"]`);
			await expect(row).toHaveAttribute("data-signal", "running");
			await expect(row.locator('.omp-live-text[data-working="turn"]')).toHaveCount(1);
		}
		await page.waitForTimeout(1500);
		const lit = await cpu(app, 4000);
		const software = (await page.locator("html").getAttribute("data-gpu")) === "software";

		// The same three runs with the shimmer stopped: what the animation alone costs.
		await page.evaluate(() => {
			for (const animation of document.getAnimations())
				if (animation instanceof CSSAnimation && animation.animationName.startsWith("omp-live-shine-text"))
					animation.pause();
		});
		await page.waitForTimeout(1000);
		const still = await cpu(app, 4000);

		const round = (value: number) => Math.round(value * 10) / 10;
		const report = {
			software,
			zeroRunning: { renderer: round(none.renderer), gpu: round(none.gpu) },
			threeRunning: { renderer: round(lit.renderer), gpu: round(lit.gpu) },
			threeRunningLightOff: { renderer: round(still.renderer), gpu: round(still.gpu) },
			lightCost: { renderer: round(lit.renderer - still.renderer), gpu: round(lit.gpu - still.gpu) },
		};
		await fs.writeFile(test.info().outputPath("edge-light-cost.json"), `${JSON.stringify(report, null, 2)}\n`);
		console.log(`EDGE_LIGHT_COST ${JSON.stringify(report)}`);
		// The light's own cost (animated vs the same page with it stopped); a software compositor draws it still.
		expect(lit.gpu - still.gpu).toBeLessThan(software ? 5 : 4);
		expect(lit.renderer - still.renderer).toBeLessThan(software ? 5 : 2);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
