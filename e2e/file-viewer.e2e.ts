import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { writeViewerSamples } from "./file-viewer-fixtures";
import { exitApp, fixtureOmp, pressShortcutUntilVisible } from "./harness";

// The Files drawer viewer in the built app on the fake omp: the pdf.js worker
// loads under the CSP and paints a page, images, tables, highlighted code and
// the hex fallback render from the fixture project.
test("file viewer renders pdf, image, csv, code and binary files", async () => {
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
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");

		const aside = page.locator("aside[data-docked]");
		await pressShortcutUntilVisible(page, "ControlOrMeta+j", aside);
		await aside.getByRole("tab", { name: "Files" }).click();
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
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
