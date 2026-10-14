import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp, pressShortcutUntilVisible } from "./harness";

// Preview page tools: a bare host in the address bar, console problems, zoom,
// responsive frames, a refused download, Save as PDF and crash recovery.
// OMP_GUI_PREVIEW_TOOLS_CAPTURES=<dir> keeps the captures.

const LABELS = {
	en: {
		preview: "Preview",
		options: "Page options",
		zoomIn: "Zoom in",
		phone: "Phone · 390×844",
		fill: "Fill the panel",
		savePdf: "Save as PDF…",
		saved: "Saved as PDF",
		problems: "Page problems (2)",
		download: "file.zip",
		crashed: "This page stopped working",
		restore: "Restore page",
		close: "Close",
	},
	ko: {
		preview: "미리보기",
		options: "페이지 옵션",
		zoomIn: "확대",
		phone: "휴대폰 · 390×844",
		fill: "패널 크기에 맞추기",
		savePdf: "PDF로 저장…",
		saved: "PDF로 저장했어요",
		problems: "페이지 문제 (2)",
		download: "file.zip",
		crashed: "이 페이지가 멈췄어요",
		restore: "페이지 복구하기",
		close: "닫기",
	},
} as const;

for (const [language, theme] of [
	["en", "light"],
	["ko", "dark"],
] as const) {
	test(`preview page tools: address, problems, zoom, frames, download, PDF, crash (${language}-${theme})`, async () => {
		test.setTimeout(120_000);
		const label = LABELS[language];
		const captures = process.env.OMP_GUI_PREVIEW_TOOLS_CAPTURES;
		const server = createServer((request, response) => {
			if (request.url === "/file.zip") {
				response.writeHead(200, {
					"Content-Type": "application/zip",
					"Content-Disposition": 'attachment; filename="file.zip"',
				});
				response.end("PK");
				return;
			}
			response.writeHead(200, { "Content-Type": "text/html" });
			response.end(
				request.url === "/width"
					? "<!doctype html><meta name=viewport content='width=device-width'><title>w</title><script>const show = () => { document.title = 'w=' + innerWidth; }; show(); addEventListener('resize', show);</script>"
					: "<!doctype html><title>Tools fixture</title><h1>Tools fixture</h1><script>console.error('boom from fixture'); console.warn('careful with this');</script>",
			);
		});
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", () => listening.resolve());
		await listening.promise;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No fixture server address");
		const host = `127.0.0.1:${address.port}`;
		const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-preview-tools-"));
		const desktop = path.join(profile, "desktop");
		const project = path.join(profile, "project");
		const agent = path.join(profile, "agent");
		const pdf = path.join(profile, "page.pdf");
		await Promise.all([fs.mkdir(desktop), fs.mkdir(project), fs.mkdir(agent)]);
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language, themeName: theme, firstRunComplete: true }),
		);
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
		const capture = async (name: string) => {
			if (!captures) return;
			await fs.mkdir(captures, { recursive: true });
			await page.locator("aside[data-docked]").screenshot({
				animations: "disabled",
				path: path.join(captures, `${name}-${language}-${theme}.png`),
			});
		};
		/** Act on the preview page's own webContents in main. */
		const child = (op: "zoom" | "download" | "crash") =>
			app.evaluate(
				({ webContents }, source) => {
					const contents = webContents
						.getAllWebContents()
						.find(candidate => candidate.getURL().startsWith(`http://${source.host}/`));
					if (!contents) throw new Error("No preview page");
					if (source.op === "download") contents.downloadURL(`http://${source.host}/file.zip`);
					else if (source.op === "crash") contents.forcefullyCrashRenderer();
					return contents.getZoomFactor();
				},
				{ host, op },
			);
		const page = await app.firstWindow();
		try {
			await page.waitForFunction(() => window.omp?.rpc != null);
			await expect
				.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
				.toBe("ready");
			const aside = page.locator("aside[data-docked]");
			await pressShortcutUntilVisible(page, "ControlOrMeta+j", aside);
			await aside.getByRole("button", { name: label.preview, exact: true }).click();
			const status = page.locator("[data-preview-status]");
			const addressBar = aside.locator("form input[inputmode=url]");

			// C120: a bare loopback host opens over http.
			await addressBar.fill(host);
			await addressBar.press("Enter");
			await expect(status).toHaveText("Tools fixture");
			await expect(addressBar).toHaveValue(`http://${host}/`);

			// C144: console errors and warnings since the load.
			const problems = aside.getByRole("button", { name: label.problems, exact: true });
			await expect(problems).toBeVisible();
			await problems.click();
			const list = page.locator("[data-preview-problem-list] li");
			await expect(list).toHaveCount(2);
			await expect(list.first()).toContainText("boom from fixture");
			await expect(list.last()).toContainText("careful with this");
			await capture("preview-problems");
			await page.keyboard.press("Escape");

			// C123: zoom in twice, the pill names it and resets it.
			const options = aside.getByRole("button", { name: label.options, exact: true });
			for (let step = 0; step < 2; step++) {
				await options.click();
				await page.getByRole("menuitem", { name: label.zoomIn, exact: true }).click();
			}
			const pill = aside.locator("[data-preview-zoom]");
			await expect(pill).toHaveText("120%");
			await expect.poll(() => child("zoom")).toBeCloseTo(1.2);
			await capture("preview-zoom");
			await pill.click();
			await expect(pill).toHaveCount(0);
			await expect.poll(() => child("zoom")).toBeCloseTo(1);

			// C124: a phone frame lays the page out at 390 CSS px.
			await options.click();
			await page.getByRole("menuitemcheckbox", { name: label.phone, exact: true }).click();
			await addressBar.fill(`${host}/width`);
			await addressBar.press("Enter");
			await expect(status).toHaveText("w=390");
			await capture("preview-phone");
			await options.click();
			await page.getByRole("menuitemcheckbox", { name: label.fill, exact: true }).click();
			await expect(status).not.toHaveText("w=390");

			// C126: a download is refused with a notice that offers the system browser.
			await child("download");
			const notice = aside.getByRole("status").filter({ hasText: label.download });
			await expect(notice).toBeVisible();
			await capture("preview-download");
			await notice.getByRole("button", { name: label.close, exact: true }).click();
			await expect(notice).toHaveCount(0);

			// C142: Save as PDF writes the printed page where the save dialog points.
			await app.evaluate(({ dialog }, target) => {
				dialog.showSaveDialog = (async () => ({
					canceled: false,
					filePath: target,
				})) as typeof dialog.showSaveDialog;
			}, pdf);
			await options.click();
			await page.getByRole("menuitem", { name: label.savePdf, exact: true }).click();
			await expect(page.getByRole("status").filter({ hasText: label.saved }).first()).toBeVisible();
			expect((await fs.readFile(pdf)).subarray(0, 4).toString()).toBe("%PDF");

			// C126: a crashed page offers a restore that reloads it.
			await child("crash");
			await expect(aside.getByRole("alert")).toContainText(label.crashed);
			await capture("preview-crashed");
			await aside.getByRole("button", { name: label.restore, exact: true }).click();
			await expect(aside.getByRole("alert")).toHaveCount(0);
			await expect(status).toContainText("w=");
		} finally {
			await exitApp(app);
			server.close();
			await fs.rm(profile, { recursive: true, force: true });
		}
	});
}
