import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { capture, exitApp, launchApp, pressShortcutUntilVisible } from "./harness";

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
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile,
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
		await aside.getByRole("button", { name: "Files", exact: true }).click();
		await aside.getByText("flow.mmd", { exact: true }).click();
		const diagram = aside.locator("[data-mermaid-rendered] img");
		await expect(diagram).toBeVisible({ timeout: 30_000 });
		await expect.poll(() => diagram.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
		await expect(aside.locator("[data-file-meta]")).toContainText("Mermaid diagram");
		const fileFigure = aside.locator('[data-figure="mermaid"]');
		await fileFigure.getByRole("button", { name: "Code", exact: true }).click();
		await expect(aside.locator("[data-code-view]")).toContainText("Start --> Finish");
		await fileFigure.getByRole("button", { name: "Preview", exact: true }).click();
		await expect(diagram).toBeVisible();

		await page.locator("textarea").first().fill("fixture svg");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		const figure = page.locator('[data-figure="svg"]').first();
		const image = figure.locator("[data-svg-preview] img");
		await expect(image).toBeVisible();
		await expect.poll(() => image.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
		const src = (await image.getAttribute("src")) ?? "";
		expect(src.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
		const svg = decodeURIComponent(src.slice(src.indexOf(",") + 1));
		expect(svg).not.toMatch(/script|onload|__svgPwned|var\(/);
		expect(await page.evaluate(() => Reflect.get(window, "__svgPwned"))).toBeUndefined();
		// No inline SVG from the reply reaches the DOM.
		expect(await figure.locator("svg:not(.lucide)").count()).toBe(0);

		await figure.getByRole("button", { name: "Code", exact: true }).click();
		await expect(figure).toContainText("<script>window.__svgPwned = 2</script>");
		await figure.getByRole("button", { name: "Preview", exact: true }).click();
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

// A viewBox-only figure (no width/height, as models write them) once laid out
// at 0×0: the empty chip of the report. It fills the chip's width at the
// viewBox ratio, and its theme tokens take the app's --sc-* colors in both themes.
for (const theme of ["light", "dark"] as const) {
	test(`a viewBox-only svg reply fills the chip width in ${theme}`, async () => {
		test.setTimeout(120_000);
		const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-figures-viewbox-"));
		const project = path.join(profile, "project");
		const desktop = path.join(profile, "desktop");
		const agent = path.join(profile, "agent");
		await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language: "ko", themeName: theme, firstRunComplete: true }),
		);
		const app = await launchApp({ project, desktop, agent, profile });
		try {
			const page = await app.firstWindow();
			const errors: string[] = [];
			page.on("pageerror", error => errors.push(error.message));
			await page.waitForFunction(() => window.omp?.rpc != null);
			await expect
				.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
				.toBe("ready");

			await page.locator("textarea").first().fill("fixture svg viewbox");
			await page.keyboard.press("Enter");
			const chip = page.locator('[data-figure="svg"] [data-svg-preview]').first();
			const image = chip.locator("img");
			await expect(image).toBeVisible();
			await expect.poll(() => image.evaluate(img => (img as HTMLImageElement).complete)).toBe(true);
			// The chip's content box, from its fractional border box (clientWidth rounds).
			const layout = await chip.evaluate(node => {
				const style = getComputedStyle(node);
				const edges = ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"] as const;
				const room = edges.reduce(
					(width, edge) => width - Number.parseFloat(style[edge]),
					node.getBoundingClientRect().width,
				);
				const box = (node.querySelector("img") as HTMLImageElement).getBoundingClientRect();
				return { room, width: box.width, height: box.height };
			});
			expect(layout.width).toBeCloseTo(layout.room, 0);
			expect(layout.height / layout.width).toBeCloseTo(470 / 760, 2);

			const src = (await image.getAttribute("src")) ?? "";
			const svg = decodeURIComponent(src.slice(src.indexOf(",") + 1));
			expect(svg).not.toContain("var(");
			const palette = await page.evaluate(() => {
				const style = getComputedStyle(document.documentElement);
				const read = (name: string) => style.getPropertyValue(name).trim();
				return {
					surface: read("--sc-surface-3"),
					border: read("--sc-border-subtle"),
					fg: read("--sc-text"),
					muted: read("--sc-text-muted"),
					accent: read("--sc-accent"),
					success: read("--sc-success"),
					error: read("--sc-danger"),
					c2: read("--sc-info"),
				};
			});
			expect(svg).toContain(`fill="${palette.surface}" stroke="${palette.border}"`);
			expect(svg).toContain(`fill="${palette.fg}">요청 흐름</text>`);
			expect(svg).toContain(`fill="${palette.muted}">브라우저에서 데이터베이스까지</text>`);
			expect(svg).toContain(`stroke="${palette.accent}"`);
			expect(svg).toContain(`stroke="${palette.c2}"`);
			expect(svg).toContain(`fill="${palette.success}"`);
			expect(svg).toContain(`fill="${palette.error}"`);
			await chip.scrollIntoViewIfNeeded();
			await capture(page, `svg-viewbox-${theme}`);
			expect(errors).toEqual([]);
		} finally {
			await exitApp(app);
			await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});
}
