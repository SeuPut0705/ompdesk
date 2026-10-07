import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

// A multi-step turn (separate assistant messages, each thinking then running a
// tool, with gaps) must show ONE live work group whose log window survives the
// steps — it used to mount a second group per streaming step and swap back at
// each message_end, so the window blinked every step.
test("a multi-step turn keeps one live work group and log window", async () => {
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
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
