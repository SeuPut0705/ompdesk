import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { writeViewerSamples } from "./file-viewer-fixtures";
import { exitApp, fixtureOmp, pressShortcutUntilVisible } from "./harness";

// The Files drawer viewer in the built app on the fake omp: the pdf.js worker
// loads under the CSP and paints a page, images, tables, highlighted code,
// Word/Excel/PowerPoint previews and the hex fallback render from the fixture
// project, and no document makes a network request.
test("file viewer renders pdf, image, csv, code, office and binary files", async () => {
	test.setTimeout(120_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-viewer-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	await writeViewerSamples(project);
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
		await aside.getByRole("button", { name: "Files", exact: true }).click();
		const open = async (name: string) => {
			await aside.getByText(name, { exact: true }).click();
			await expect(aside.locator("[data-file-meta]")).toContainText("·");
		};
		const back = () => aside.getByRole("button", { name: "Back to files" }).click();

		await open("doc.pdf");
		const canvas = aside.locator('[data-pdf-page="1"] canvas');
		// Painted, not just sized: some pixel of the page differs from paper white.
		await expect
			.poll(() =>
				canvas.evaluate(element => {
					const node = element as HTMLCanvasElement;
					if (node.width === 0) return 0;
					const pixels = node.getContext("2d")?.getImageData(0, 0, node.width, node.height).data;
					let inked = 0;
					if (pixels) for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 200) inked++;
					return inked;
				}),
			)
			.toBeGreaterThan(1000);
		await expect(aside).toContainText("Pages: 1");
		await back();

		await open("pixel.png");
		await expect(aside.locator('[data-viewer="image"] img')).toHaveJSProperty("naturalWidth", 96);
		await expect(aside.locator("[data-image-info]")).toHaveText("96 × 64 px");
		await back();

		await open("people.csv");
		const table = aside.locator("[data-table-view]");
		await expect(table.locator("thead")).toContainText("quote");
		await expect(table.locator("tbody td")).toContainText(["Ada", "London", 'Said "hello", then left', "Smith, J"]);
		await back();

		await open("sample.ts");
		const code = aside.locator('[data-code-view][data-highlighted="true"]');
		await expect(code.locator(".hljs-keyword").first()).toHaveText("export");
		await expect(code.locator("[data-line-number]")).toHaveCount(7);
		await back();

		await open("report.docx");
		const docx = aside.locator('[data-viewer="docx"]');
		// Rendered inside the host's shadow root; Playwright locators pierce it.
		await expect(docx.getByText("Quarterly report")).toBeVisible();
		const body = docx.getByText("Revenue grew 12% this quarter,");
		await expect(body).toBeVisible();
		// Reading layout by default: text keeps its real size (a fitted page shrank it to ~5px).
		await expect(docx).toHaveAttribute("data-docx-layout", "reflow");
		expect((await body.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(12);
		await expect(docx.getByRole("button", { name: "Zoom in" })).toHaveCount(0);
		const link = docx.locator("a", { hasText: "Read the full analysis" });
		await expect(link).toHaveAttribute("title", "https://example.com/full-analysis");
		expect(await link.getAttribute("href")).toBeNull();
		await docx.getByRole("tab", { name: "Page layout" }).click();
		await expect(docx).toHaveAttribute("data-docx-layout", "pages");
		await expect(docx.getByRole("button", { name: "Zoom in" })).toBeVisible();
		await expect(docx.getByText("Revenue grew 12% this quarter,")).toBeVisible();
		await expect(docx.locator("a", { hasText: "Read the full analysis" })).toHaveAttribute(
			"title",
			"https://example.com/full-analysis",
		);
		await back();

		await open("budget.xlsx");
		const xlsx = aside.locator('[data-viewer="xlsx"]');
		const sheets = xlsx.getByRole("tablist", { name: "Sheets" });
		await expect(sheets.getByRole("tab")).toHaveText(["Summary", "Regions"]);
		const grid = xlsx.locator("[data-sheet-grid]");
		await expect(grid.locator("tbody td")).toContainText(["Name", "Quote", "Ada", 'Said "hello", then left']);
		await expect(grid.locator("tbody td", { hasText: "2024-01-15" })).toHaveCount(1);
		await expect(grid.locator("tbody td", { hasText: "25%" })).toHaveCount(1);
		await sheets.getByRole("tab", { name: "Regions" }).click();
		await expect(sheets.getByRole("tab", { name: "Regions" })).toHaveAttribute("aria-selected", "true");
		await expect(grid.locator("tbody td")).toContainText(["Region", "Total", "North", "1,234.50"]);
		await expect(grid).not.toContainText("Ada");
		await back();

		await open("deck.pptx");
		const pptx = aside.locator('[data-viewer="pptx"]');
		await expect(pptx.locator("[data-slides-simplified]")).toBeVisible();
		await expect(pptx.locator("[data-slide]")).toHaveCount(2);
		await expect(pptx.locator('[data-slide="1"]')).toContainText("Roadmap 2025");
		await expect(pptx.locator('[data-slide="1"]')).toContainText("Ship the Office viewer");
		await expect(pptx.locator('[data-slide="2"]')).toContainText("Results");
		await expect(pptx.locator('[data-slide="2"]')).toContainText("Revenue up 12%");
		const slideImage = pptx.locator('[data-slide="2"] img[data-slide-image]');
		await expect(slideImage).toHaveJSProperty("naturalWidth", 120);
		expect(await slideImage.getAttribute("src")).toMatch(/^blob:/);
		const notes = pptx.locator('[data-slide="1"] [data-slide-notes]');
		await expect(notes.getByText("Mention remote tabs")).toBeHidden();
		await notes.getByText("Speaker notes").click();
		await expect(notes.getByText("Mention remote tabs")).toBeVisible();
		await back();

		await open("blob.bin");
		await expect(aside.locator("[data-hex-dump]")).toContainText("00 01 02 ff 4f 4d 50 00");
		await expect(aside.locator("[data-viewer-fallback]")).toContainText("Open with default app");

		// A transcript image opens over the chat pane only: sidebar and side panel stay visible.
		await page.locator("textarea").first().fill("fixture image");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await page.locator("[data-zoomable-image]").first().click();
		const viewer = page.getByRole("dialog", { name: "chart" });
		await expect(viewer).toBeVisible();
		expect(await viewer.evaluate(element => element.closest(".omp-session-pane") !== null)).toBe(true);
		const paneBox = await page.locator(".omp-session-pane").first().boundingBox();
		const viewerBox = await viewer.boundingBox();
		if (!paneBox || !viewerBox) throw new Error("expected layout boxes");
		expect(viewerBox.x).toBeGreaterThanOrEqual(paneBox.x);
		expect(viewerBox.x + viewerBox.width).toBeLessThanOrEqual(paneBox.x + paneBox.width);
		await expect(page.getByRole("button", { name: "New session" })).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(viewer).toHaveCount(0);
		expect(errors).toEqual([]);
		expect(network).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
