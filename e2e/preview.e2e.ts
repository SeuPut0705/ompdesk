import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { decodePng } from "../src/main/shell-host/electron/png";
import { exitApp, fixtureOmp, pressShortcutUntilVisible } from "./harness";

/** The Accept-Language a Preview page is sent (the shell's `preview_core/languages.rs`): each system language, its bare language, then English. */
function acceptLanguages(preferred: readonly string[]): string {
	const list: string[] = [];
	const add = (tag: string) => {
		if (tag && !list.some(entry => entry.toLowerCase() === tag.toLowerCase())) list.push(tag);
	};
	for (const raw of preferred) {
		const tag = raw.trim().replaceAll("_", "-");
		add(tag);
		add(tag.split("-")[0] ?? "");
	}
	if (list.length === 0) return "";
	add("en-US");
	add("en");
	return list.join(",");
}

test("@smoke isolated Preview loads a local HTTP page without shell privileges", async () => {
	test.setTimeout(120_000);
	const screenshotDir = process.env.OMP_GUI_PREVIEW_SCREENSHOTS ?? path.join(os.tmpdir(), "ompdesk-preview-captures");
	const acceptLanguage: (string | undefined)[] = [];
	const server = createServer((request, response) => {
		if (request.url === "/") acceptLanguage.push(request.headers["accept-language"]);
		if (request.url === "/slow") {
			response.writeHead(200, { "Content-Type": "text/html" });
			response.flushHeaders();
			return;
		}
		if (request.url === "/error") {
			response.destroy();
			return;
		}
		if (request.url === "/edit") {
			response.writeHead(200, { "Content-Type": "text/html" });
			response.end('<!doctype html><title>Edit fixture</title><input id=field aria-label="Field">');
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
		// `--lang=de` stands for a system language whose locale file the package trims: Chromium alone would send
		// German first; the Preview sends the system's own languages (src/main/system-languages.ts).
		args: [
			path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"),
			project,
			`--user-data-dir=${desktop}`,
			"--lang=de",
		],
		env,
	});
	try {
		const page = await app.firstWindow();
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		/** The Preview page showing the fixture (the shell's preview module owns it): a CDP target, by its address. */
		const previewTarget = () => {
			const target = app.windows().find(candidate => candidate.url() === url);
			if (!target) throw new Error("Missing native preview page");
			return target;
		};
		const aside = page.locator("aside[data-docked]");
		await pressShortcutUntilVisible(page, "ControlOrMeta+j", aside);
		await aside.getByRole("button", { name: "Preview", exact: true }).click();
		await expect(aside.locator(".omp-panel-topbar button")).toHaveCount(5);
		await expect(aside.locator("form").getByRole("button", { name: "Open in browser", exact: true })).toBeVisible();
		await page.getByRole("textbox", { name: "Preview URL" }).fill(url);
		await page.getByRole("textbox", { name: "Preview URL" }).press("Enter");
		await expect(page.locator("[data-preview-status]")).toHaveText("Local preview fixture");
		const preferred = await app.evaluate(({ app }) => app.getPreferredSystemLanguages());
		expect(preferred.length).toBeGreaterThan(0);
		expect(
			acceptLanguage
				.at(-1)
				?.split(",")
				.map(part => part.split(";")[0]),
		).toEqual(acceptLanguages(preferred).split(","));
		// The Preview's page is the shell's own: reached as a CDP target (the shell's preview module owns it).
		await expect.poll(() => app.windows().some(candidate => candidate.url() === url)).toBe(true);
		const fixturePage = app.windows().find(candidate => candidate.url() === url);
		if (!fixturePage) throw new Error("Missing native preview contents");
		const security = await fixturePage.evaluate(() => ({
			title: document.title,
			node: typeof (globalThis as { require?: unknown }).require,
			ipc: typeof (window as { omp?: unknown }).omp,
		}));
		expect(security).toEqual({ title: "Local preview fixture", node: "undefined", ipc: "undefined" });
		expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(false);
		// The application menu's edit commands (Cmd/Ctrl+A, C, V, X, Z) act on the page holding the keyboard focus, as
		// Electron's menu roles do: a Preview page the person typed in, not the window's own page.
		await page.getByRole("textbox", { name: "Preview URL" }).fill(`${url}edit`);
		await page.getByRole("textbox", { name: "Preview URL" }).press("Enter");
		await expect(page.locator("[data-preview-status]")).toHaveText("Edit fixture");
		await expect.poll(() => app.windows().some(candidate => candidate.url() === `${url}edit`)).toBe(true);
		const editPage = app.windows().find(candidate => candidate.url() === `${url}edit`);
		if (!editPage) throw new Error("No Preview page target");
		const field = editPage.getByRole("textbox", { name: "Field" });
		await field.fill("abc");
		// A key the page leaves alone reaches the shell from that page: the window's focus is the Preview page now.
		await field.press("Shift");
		// What the menu's Select All runs: the window's page is told to select all.
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.selectAll());
		await field.pressSequentially("x");
		await expect(field).toHaveValue("x");
		await page.getByRole("textbox", { name: "Preview URL" }).fill(url);
		await page.getByRole("textbox", { name: "Preview URL" }).press("Enter");
		await expect(page.locator("[data-preview-status]")).toHaveText("Local preview fixture");
		const palette = page.getByRole("dialog").getByRole("combobox");
		await pressShortcutUntilVisible(page, "ControlOrMeta+k", palette);
		await palette.fill("Background tasks");
		await page
			.getByRole("dialog")
			.locator("button[data-palette-index]", { hasText: "Background tasks" })
			.first()
			.click();
		await expect(page.locator('[data-view-sheet="jobs"]')).toBeVisible();
		await expect.poll(() => previewTarget().evaluate(() => document.visibilityState === "visible")).toBe(false);
		await page.keyboard.press("Escape");
		for (const [theme, label] of [
			["light", "OMPdesk Light"],
			["dark", "OMPdesk Dark"],
		]) {
			await page.locator("textarea").first().fill("/theme");
			await page.getByRole("button", { name: "Send", exact: true }).click();
			const picker = page.getByRole("dialog", { name: "Choose theme" });
			await picker.getByPlaceholder("Search themes…").fill(label);
			await picker.locator("[data-theme-entry]").filter({ hasText: label }).click();
			await expect(picker).toHaveCount(0);
			await expect.poll(() => previewTarget().evaluate(() => document.visibilityState === "visible")).toBe(true);
			const toast = page.getByRole("status").filter({ hasText: `Theme: ${label}` });
			await toast.getByRole("button", { name: "Close", exact: true }).click();
			await expect(toast).toHaveCount(0);
			let nativeCapture = "";
			await expect
				.poll(async () => {
					const png = await previewTarget().screenshot();
					const image = decodePng(png);
					const captured = {
						painted: image.rgba.some(
							(alpha, index) =>
								index % 4 === 3 &&
								alpha > 0 &&
								Math.min(
									image.rgba[index - 3] ?? 255,
									image.rgba[index - 2] ?? 255,
									image.rgba[index - 1] ?? 255,
								) < 200,
						),
						png: png.toString("base64"),
					};
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
