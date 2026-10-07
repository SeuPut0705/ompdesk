import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

async function withLiveWorkApp(history: number, body: (page: Page) => Promise<void>): Promise<void> {
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-steps-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(profile),
		OMP_GUI_TEST_HISTORY: String(history),
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env,
	});
	try {
		const page = await app.firstWindow();
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		await body(page);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
}

// A multi-step turn (separate assistant messages, each thinking then running a
// tool, with gaps) must show ONE live work group whose log window survives the
// steps — it used to mount a second group per streaming step and swap back at
// each message_end, so the window blinked every step.
test("a multi-step turn keeps one live work group and log window", async () => {
	await withLiveWorkApp(0, async page => {
		await page.evaluate(() => {
			const w = window as unknown as { __probe: string[]; __panels: number };
			w.__probe = [];
			w.__panels = 0;
			let last = "";
			const seen = new WeakSet<Element>();
			setInterval(() => {
				const groups = document.querySelectorAll(".omp-execution-group").length;
				const running = document.querySelectorAll('.omp-execution-group[data-state="running"]').length;
				const panels = [...document.querySelectorAll(".omp-live-step")];
				for (const panel of panels)
					if (!seen.has(panel)) {
						seen.add(panel);
						w.__panels++;
					}
				const tag = `groups=${groups} running=${running} panels=${panels.length}`;
				if (tag !== last) {
					w.__probe.push(tag);
					last = tag;
				}
			}, 10);
		});
		const input = page.locator("textarea").first();
		await input.fill("fixture steps");
		await input.press("Enter");
		await expect(page.locator("[data-transcript-kind]").filter({ hasText: "Steps finished" })).toHaveCount(1, {
			timeout: 30_000,
		});
		const result = await page.evaluate(() => {
			const w = window as unknown as { __probe: string[]; __panels: number };
			return { probe: w.__probe, panelMounts: w.__panels };
		});
		// Never two work groups, at most one handoff remount (streaming row → history row).
		expect(result.probe.filter(state => !state.startsWith("groups=0") && !state.startsWith("groups=1"))).toEqual([]);
		expect(result.panelMounts).toBeLessThanOrEqual(2);
	});
});

// The live log scrolls inside a fixed window, but its `sr-only` step labels are
// absolutely positioned: when they escaped the window they sat at their
// unscrolled place in the whole log, below the work row, and stretched the
// transcript's scroll height. Following the tail then parked the view on an
// empty band under the running row that grew with every step.
test("the live log never stretches the transcript below its rows", async () => {
	await withLiveWorkApp(40, async page => {
		const input = page.locator("textarea").first();
		await input.fill("fixture edits");
		await input.press("Enter");
		const log = page.locator(".omp-live-step-log");
		await expect(log).toContainText("step 7 output 8", { timeout: 30_000 });
		await expect(log).toContainText("+2");

		const layout = () =>
			page.evaluate(() => {
				const scroll = document.querySelector<HTMLElement>(".omp-transcript-scroll");
				const canvas = document.querySelector<HTMLElement>(".omp-transcript-canvas");
				const rows = [...(canvas?.querySelectorAll<HTMLElement>(":scope > [data-index]") ?? [])];
				if (!scroll || !canvas || rows.length === 0) return null;
				const contentBottom = Math.max(...rows.map(row => row.getBoundingClientRect().bottom));
				return {
					// Scrollable height the rows do not account for.
					overflow: scroll.scrollHeight - canvas.offsetHeight,
					// Empty band between the last row and the bottom of the viewport.
					emptyBelow: scroll.getBoundingClientRect().bottom - contentBottom,
				};
			});
		// Let the tail follower settle on the finished log, then the transcript must
		// end at its last row and the view must sit on it.
		await expect.poll(async () => (await layout())?.emptyBelow, { timeout: 5_000 }).toBeLessThan(40);
		const settled = await layout();
		expect(settled?.overflow).toBe(0);
		expect(settled?.emptyBelow).toBeLessThan(40);
	});
});
