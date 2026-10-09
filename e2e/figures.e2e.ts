import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp, pressShortcutUntilVisible } from "./harness";

// Figures in the built app on the fake omp: a .mmd file in the Files drawer
// renders as a Mermaid diagram with a Source switch, and an assistant ```svg
// fence renders as a sanitized data: URL image (its script never runs) with a
// Code switch and click-to-zoom, under the app's unchanged CSP.
test("mermaid files and svg replies render as figures", async () => {
	test.setTimeout(120_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-figures-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	await fs.writeFile(path.join(project, "flow.mmd"), "graph TD\n  Start --> Finish\n");
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
		const errors: string[] = [];
		page.on("pageerror", error => errors.push(error.message));
		const network: string[] = [];
		page.on("request", request => {
			if (/^(https?|wss?):/i.test(request.url())) network.push(request.url());
		});
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");

		const aside = page.locator("aside[data-docked]");
		await pressShortcutUntilVisible(page, "ControlOrMeta+j", aside);
		await aside.getByRole("tab", { name: "Files" }).click();
		await aside.getByText("flow.mmd", { exact: true }).click();
		const diagram = aside.locator("[data-mermaid-rendered] img");
		await expect(diagram).toBeVisible({ timeout: 30_000 });
		await expect.poll(() => diagram.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
		await expect(aside.locator("[data-file-meta]")).toContainText("Mermaid diagram");
		await aside.getByRole("tab", { name: "Source" }).click();
		await expect(aside.locator("[data-code-view]")).toContainText("Start --> Finish");
		await aside.getByRole("tab", { name: "Rendered" }).click();
		await expect(diagram).toBeVisible();

		await page.locator("textarea").first().fill("fixture svg");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		const figure = page.locator("[data-svg-block]").first();
		const image = figure.locator("[data-svg-preview] img");
		await expect(image).toBeVisible();
		await expect.poll(() => image.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
		const src = (await image.getAttribute("src")) ?? "";
		expect(src.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
		const svg = decodeURIComponent(src.slice(src.indexOf(",") + 1));
		expect(svg).not.toMatch(/script|onload|__svgPwned|var\(/);
		expect(await page.evaluate(() => Reflect.get(window, "__svgPwned"))).toBeUndefined();
		// No inline SVG from the reply reaches the DOM.
		expect(await figure.locator("svg").count()).toBe(0);

		await figure.getByRole("tab", { name: "Code" }).click();
		await expect(figure).toContainText("<script>window.__svgPwned = 2</script>");
		await figure.getByRole("tab", { name: "Preview" }).click();
		await figure.locator("[data-zoomable-image]").click();
		const viewer = page.getByRole("dialog", { name: "SVG image" });
		await expect(viewer).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(viewer).toHaveCount(0);
		expect(await page.evaluate(() => Reflect.get(window, "__svgPwned"))).toBeUndefined();
		expect(errors).toEqual([]);
		expect(network).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
