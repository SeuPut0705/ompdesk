/**
 * The composer's model chip while a retry fallback runs the session (composer.md › Toolbar, "A fallback never shows on
 * the chip as the person's pick"), on the built app and the fake omp in Korean, light: `OMP_GUI_TEST_STAND_IN=1` starts
 * the fixture's session on GPT-6.1 SOL while the bridge's `model_choice` names the fixture's own model, as stock's
 * journal does after a fallback. The desktop window and the paired phone page (Pixel 8, 390 × 844, through the fake
 * `tailscale serve`, as fallback-models.e2e.ts pairs it) both name the person's model with the stand-in dot, and the
 * tooltip says the last turn ran on GPT-6.1 SOL; a pick of the person's model ends the stand-in and the dot goes, in
 * each view by its own pick (the phone page opens a tab of its own, with its own omp). Captures go to the test's output
 * directory (`--output`).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, devices, type ElectronApplication, expect, type Locator, test } from "@playwright/test";
import { fixtureTailscale } from "./fixture/fake-tailscale-install";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { exitApp, launchApp } from "./harness";

const STOOD_IN = "지난 턴은 Local fixture 모델 대신 GPT-6.1 SOL 모델로 실행했어요";

let app: ElectronApplication | null = null;
let proxy: ServeProxy | null = null;

test.afterEach(async () => {
	await proxy?.close().catch(() => undefined);
	proxy = null;
	if (app) await exitApp(app);
	app = null;
});

async function standingIn(chip: Locator): Promise<void> {
	await expect(chip).toHaveAttribute("data-model-standin", "", { timeout: 60_000 });
	await expect(chip.locator(".omp-composer-model-label")).toHaveText("Local fixture");
	await expect(chip).toHaveAttribute("aria-label", new RegExp(STOOD_IN));
}

test("the model chip keeps the person's model while a fallback answers (ko, light; desktop and phone)", async () => {
	test.setTimeout(240_000);
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-fallback-chip-")));
	const [desktop, project, agent] = ["desktop", "project", "agent"].map(name => path.join(profile, name));
	await Promise.all([fs.mkdir(desktop), fs.mkdir(project), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "ko", themeName: "light", firstRunComplete: true, lastProject: project }),
	);
	const tailscale = await fixtureTailscale(profile, { backendState: "Running" });
	app = await launchApp({ project, desktop, agent, profile, env: { OMP_GUI_TEST_STAND_IN: "1", ...tailscale.env } });
	const desk = await app.firstWindow();
	await desk.setViewportSize({ width: 1280, height: 860 });
	const chip = desk.locator("button[data-model-chip]").first();
	await standingIn(chip);
	await chip.hover();
	await expect(desk.getByRole("tooltip")).toContainText(STOOD_IN, { timeout: 5_000 });
	await desk.screenshot({ path: test.info().outputPath("desktop-ko-light-standin.png") });
	await desk.mouse.move(0, 0);

	await desk.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
	await expect
		.poll(() => desk.evaluate(async () => (await window.omp.mobileWeb.getState()).phase), { timeout: 60_000 })
		.toBe("ready");
	await expect.poll(() => serveSites(tailscale).length, { timeout: 30_000 }).toBeGreaterThan(0);
	const site = serveSites(tailscale).at(-1);
	if (!site) throw new Error("serve publishes no handler");
	proxy = await ServeProxy.start(site, "seuput@example.com", undefined, { plainCookie: true });
	const browser = await chromium.launch();
	try {
		const context = await browser.newContext({
			...devices["Pixel 8"],
			viewport: { width: 390, height: 844 },
			screen: { width: 390, height: 844 },
			colorScheme: "light",
		});
		const phone = await context.newPage();
		await phone.goto(`${proxy.url}/`);
		await phonePaired(phone);
		await expect(phone.locator("html")).toHaveAttribute("data-shell", "phone", { timeout: 60_000 });
		const phoneChip = phone.locator("button[data-model-chip]").first();
		await standingIn(phoneChip);
		await phone.screenshot({ path: test.info().outputPath("phone-390-ko-light-standin.png") });

		await chip.click();
		await desk.locator("[data-model-option]", { hasText: "Local fixture" }).first().click();
		await expect.poll(() => chip.getAttribute("data-model-standin")).toBeNull();
		await expect(chip.locator(".omp-composer-model-label")).toHaveText("Local fixture");
		expect(await chip.getAttribute("aria-label")).not.toContain("GPT-6.1 SOL");
		await desk.screenshot({ path: test.info().outputPath("desktop-ko-light-after-pick.png") });

		await phoneChip.click();
		await phone.locator("[data-model-option]", { hasText: "Local fixture" }).first().click();
		await expect.poll(() => phoneChip.getAttribute("data-model-standin"), { timeout: 30_000 }).toBeNull();
		await expect(phoneChip.locator(".omp-composer-model-label")).toHaveText("Local fixture");
		await phone.screenshot({ path: test.info().outputPath("phone-390-ko-light-after-pick.png") });
	} finally {
		await browser.close();
	}
});
