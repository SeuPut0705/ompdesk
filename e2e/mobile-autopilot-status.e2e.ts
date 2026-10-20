/**
 * One form per idea on a phone: a live Autopilot run's state ("Autopilot · Cycle N · area") is said once, by the work
 * strip under the header. The dock row and the Run chip's label, which said it again, give way where the strip shows;
 * the dock row's stops stay in the strip's panel and the Run sheet. A paired phone page (Pixel 7 at 390) on the fake
 * omp (fixture/autopilot.ts) through fixture/phone-serve.ts's stand-in for `tailscale serve`.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, devices, expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { makeApProfile } from "./autopilot-harness";
import { fixtureTailscale } from "./fixture/fake-tailscale-install";
import { ServeProxy, serveSites } from "./fixture/phone-serve";
import { exitApp, fixtureOmp } from "./harness";

test("a phone says a live run's state once: the strip, not the dock row or the Run chip", async () => {
	test.skip(process.platform === "win32", "the fake Tailscale is a bun shebang script");
	test.setTimeout(180_000);
	const ap = await makeApProfile({ script: { cycleMs: 8000 } });
	const tailscale = await fixtureTailscale(ap.root, { backendState: "Running" });
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries({ ...process.env, ...ap.env })) if (value !== undefined) env[key] = value;
	Object.assign(env, {
		PI_CODING_AGENT_DIR: ap.agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), ap.root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(ap.root),
		...tailscale.env,
	});
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"), `--user-data-dir=${ap.desktop}`],
		env,
	});
	const browser = await chromium.launch();
	let proxy: ServeProxy | null = null;
	try {
		const desk = await app.firstWindow();
		await desk.waitForFunction(() => window.omp?.rpc != null);
		await desk.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
		await expect
			.poll(() => desk.evaluate(async () => (await window.omp.mobileWeb.getState()).phase).catch(() => ""), {
				timeout: 60_000,
			})
			.toBe("ready");
		const [site] = serveSites(tailscale);
		if (!site) throw new Error("no serve handler published");
		proxy = await ServeProxy.start(site, "seuput@example.com");
		const phone = await (
			await browser.newContext({ ...devices["Pixel 7"], viewport: { width: 390, height: 844 } })
		).newPage();
		await phone.goto(`${proxy.url}/`);
		await expect(phone.getByRole("button", { name: "Open menu" })).toBeVisible({ timeout: 60_000 });
		await phone.evaluate(cwd => window.omp.tabs.spawn({ cwd, kind: "agent" }), ap.project);
		await phone.reload();
		await expect(phone.locator("[data-composer-input]").first()).toBeVisible({ timeout: 60_000 });
		await phone.locator("[data-run-settings-trigger]").click();
		await phone.locator("[data-tab-id='autopilot']").click();
		await phone.locator("[data-autopilot-start]").click();
		const closePanel = phone.getByRole("button", { name: "Close side panel" }).first();
		if (await closePanel.isVisible().catch(() => false)) await closePanel.click();
		const strip = phone.locator("[data-work-strip] [data-work-chip]");
		await expect(strip).toContainText(/Autopilot · Cycle \d+/, { timeout: 60_000 });
		// The dock row is in the DOM (the desktop shows it) but gives way beside the strip.
		await expect(phone.locator("[data-autopilot-dock]")).toBeHidden();
		// The Run chip keeps its glyph; its label no longer repeats the state.
		const chipLabel = phone.locator("[data-run-settings-trigger] .omp-composer-control-label");
		await expect(chipLabel).toBeHidden();
		const said = await phone.evaluate(
			() =>
				[...document.querySelectorAll<HTMLElement>("body *")].filter(
					element =>
						element.childElementCount === 0 &&
						/Cycle \d+/.test(element.textContent ?? "") &&
						element.checkVisibility({ visibilityProperty: true }),
				).length,
		);
		expect(said).toBe(1);
	} finally {
		await browser.close();
		await proxy?.close();
		await exitApp(app).catch(() => undefined);
		await fs.rm(ap.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => undefined);
	}
});
