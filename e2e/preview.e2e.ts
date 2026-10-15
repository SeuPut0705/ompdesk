import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp, pressShortcutUntilVisible } from "./harness";

test("@smoke isolated Preview loads a local HTTP page without shell privileges", async () => {
	test.setTimeout(120_000);
	const screenshotDir = process.env.OMP_GUI_PREVIEW_SCREENSHOTS ?? path.join(os.tmpdir(), "ompdesk-preview-captures");
	const server = createServer((request, response) => {
		if (request.url === "/slow") {
			response.writeHead(200, { "Content-Type": "text/html" });
			response.flushHeaders();
			return;
		}
		if (request.url === "/error") {
			response.destroy();
			return;
		}
		response.writeHead(200, { "Content-Type": "text/html" });
		response.end(
			'<!doctype html><title>Local preview fixture</title><h1>Real preview page</h1><a href="/next">Next</a>',
		);
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No fixture server address");
	const url = `http://127.0.0.1:${address.port}/`;
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-preview-"));
	const desktop = path.join(profile, "desktop");
	const project = path.join(profile, "project");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(desktop), fs.mkdir(project), fs.mkdir(agent)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const env = {
		...process.env,
		OMP_GUI_HEADLESS: "1",
		PI_CODING_AGENT_DIR: agent,
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
		const aside = page.locator("aside[data-docked]");
		await pressShortcutUntilVisible(page, "ControlOrMeta+j", aside);
		await aside.getByRole("button", { name: "Preview", exact: true }).click();
		await expect(aside.locator(".omp-panel-topbar button")).toHaveCount(6);
		await expect(aside.locator("form").getByRole("button", { name: "Open in browser", exact: true })).toBeVisible();
		await page.getByRole("textbox", { name: "Preview URL" }).fill(url);
		await page.getByRole("textbox", { name: "Preview URL" }).press("Enter");
		await expect(page.locator("[data-preview-status]")).toHaveText("Local preview fixture");
		const security = await app.evaluate(async ({ webContents }) => {
			const child = webContents
				.getAllWebContents()
				.find(contents => contents.getTitle() === "Local preview fixture");
			if (!child) throw new Error("Missing native preview contents");
			return child.executeJavaScript("({ title: document.title, node: typeof require, ipc: typeof window.omp })");
		});
		expect(security).toEqual({ title: "Local preview fixture", node: "undefined", ipc: "undefined" });
		expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(false);
		await page.getByRole("button", { name: "View options", exact: true }).click();
		await expect
			.poll(() =>
				app.evaluate(({ BrowserWindow }) =>
					BrowserWindow.getAllWindows()[0].contentView.children.at(-1)?.getVisible(),
				),
			)
			.toBe(false);
		await page.keyboard.press("Escape");
		for (const [theme, label] of [
			["light", "Porcelain"],
			["dark", "Graphite"],
		]) {
			await page.locator("textarea").first().fill("/theme");
			await page.getByRole("button", { name: "Send", exact: true }).click();
			const picker = page.getByRole("dialog", { name: "Choose theme" });
			await picker.getByPlaceholder("Search themes…").fill(label);
			await picker.locator("button[aria-pressed]").filter({ hasText: label }).click();
			await expect(picker).toHaveCount(0);
			await expect
				.poll(() =>
					app.evaluate(({ BrowserWindow }) =>
						BrowserWindow.getAllWindows()[0].contentView.children.at(-1)?.getVisible(),
					),
				)
				.toBe(true);
			const toast = page.getByRole("status").filter({ hasText: `Theme: ${label}` });
			await toast.getByRole("button", { name: "Close", exact: true }).click();
			await expect(toast).toHaveCount(0);
			let nativeCapture = "";
			await expect
				.poll(async () => {
					const captured = await app.evaluate(async ({ webContents }) => {
						const child = webContents
							.getAllWebContents()
							.find(contents => contents.getTitle() === "Local preview fixture");
						if (!child) throw new Error("Missing native preview capture");
						const image = await child.capturePage(undefined, { stayHidden: true });
						const bitmap = image.toBitmap();
						return {
							painted: bitmap.some(
								(alpha, index) =>
									index % 4 === 3 &&
									alpha > 0 &&
									Math.min(bitmap[index - 3], bitmap[index - 2], bitmap[index - 1]) < 200,
							),
							png: image.toPNG().toString("base64"),
						};
					});
					nativeCapture = captured.png;
					return captured.painted;
				})
				.toBe(true);
			// Shell capture does not composite native child views; keep the observed painted child frame separately.
			const shellCapture = await app.evaluate(async ({ BrowserWindow }) =>
				(await BrowserWindow.getAllWindows()[0].capturePage(undefined, { stayHidden: true }))
					.toPNG()
					.toString("base64"),
			);
			await fs.mkdir(screenshotDir, { recursive: true });
			await fs.writeFile(path.join(screenshotDir, `preview-${theme}.png`), Buffer.from(shellCapture, "base64"));
			await fs.writeFile(
				path.join(screenshotDir, `preview-page-${theme}.png`),
				Buffer.from(nativeCapture, "base64"),
			);
			const addressBar = page.getByRole("textbox", { name: "Preview URL" });
			await addressBar.fill(`${url}slow`);
			await addressBar.press("Enter");
			await expect(page.locator("[data-preview-status]")).toHaveText("Loading…");
			await aside.screenshot({
				animations: "disabled",
				path: path.join(screenshotDir, `preview-loading-${theme}.png`),
			});
			await aside.getByRole("button", { name: "Stop", exact: true }).click();
			await addressBar.fill(`${url}error`);
			await addressBar.press("Enter");
			await expect(aside.getByRole("alert")).toContainText("Couldn't load this page");
			await expect(aside.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
			await aside.screenshot({
				animations: "disabled",
				path: path.join(screenshotDir, `preview-error-${theme}.png`),
			});
			await addressBar.fill(url);
			await addressBar.press("Enter");
			await expect(page.locator("[data-preview-status]")).toHaveText("Local preview fixture");
		}
		console.log(`Preview captures: ${screenshotDir}`);
	} finally {
		await exitApp(app);
		await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
		await fs.rm(profile, { recursive: true, force: true });
	}
});
