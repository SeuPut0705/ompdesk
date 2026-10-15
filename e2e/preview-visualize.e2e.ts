import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

// The agent's gui_visualize tool (C135) shows a page from the project in the
// Preview, keeps versions (C141) and "All visuals"; the user comments on an
// element (C137/C138), tweaks a CSS variable (C139) and sends both to the
// composer; `choose` counts only a real click (C143).
// OMP_GUI_PREVIEW_VISUALIZE_CAPTURES=<dir> keeps the captures.

const LABELS = {
	en: {
		element: "Comment on an element",
		variables: "CSS variables",
		comment: "Comment for 1",
		send: "Add to message",
		version: "Visual version",
		options: "Page options",
		all: "All visuals…",
		header: "Feedback on the page",
	},
	ko: {
		element: "요소에 의견 남기기",
		variables: "CSS 변수",
		comment: "1에 대한 의견",
		send: "메시지에 넣기",
		version: "시각화 버전",
		options: "페이지 옵션",
		all: "모든 시각화…",
		header: "페이지에 대한 의견이에요",
	},
} as const;

const page = (title: string) =>
	`<!doctype html><title>${title}</title><link rel=stylesheet href="style.css"><style>:root{--accent:#3366ff}</style>` +
	`<h1 id=title>Pick a plan</h1><button id=a data-choice=basic>Basic</button> <button id=b data-choice=pro>Pro</button>`;

interface Frame {
	type?: string;
	result?: unknown;
}

for (const [language, theme] of [
	["en", "light"],
	["ko", "dark"],
] as const) {
	test(`gui_visualize: versions, element comments, CSS variables, real-click choice (${language}-${theme})`, async () => {
		test.setTimeout(120_000);
		const label = LABELS[language];
		const captures = process.env.OMP_GUI_PREVIEW_VISUALIZE_CAPTURES;
		const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-preview-visualize-"));
		const desktop = path.join(profile, "desktop");
		const project = path.join(profile, "project");
		const agent = path.join(profile, "agent");
		const record = path.join(profile, "record.jsonl");
		await Promise.all([fs.mkdir(desktop), fs.mkdir(project), fs.mkdir(agent)]);
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language, themeName: theme, firstRunComplete: true }),
		);
		await fs.writeFile(path.join(project, "plans.html"), page("Plan options"));
		await fs.writeFile(path.join(project, "style.css"), "h1 { color: var(--accent); }");
		await fs.writeFile(path.join(project, ".env"), "SECRET=1");
		const env = {
			...process.env,
			OMP_GUI_HEADLESS: "1",
			PI_CODING_AGENT_DIR: agent,
			OMP_GUI_OMP: await fixtureOmp(profile),
			OMP_GUI_TEST_RECORD: record,
		};
		Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
		const app = await electron.launch({
			args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
			env,
		});
		const window = await app.firstWindow();
		const capture = async (name: string) => {
			if (!captures) return;
			await fs.mkdir(captures, { recursive: true });
			await window.locator("aside[data-docked]").screenshot({
				animations: "disabled",
				path: path.join(captures, `${name}-${language}-${theme}.png`),
			});
		};
		const results = async () =>
			(await fs.readFile(record, "utf8").catch(() => ""))
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line) as Frame)
				.filter(frame => frame.type === "host_tool_result")
				.map(frame => JSON.stringify(frame.result));
		const composer = window.locator("textarea").first();
		const tool = async (args: object) => {
			await composer.fill(`!fixture:host-tool:gui_visualize ${JSON.stringify(args)}`);
			await composer.press("Enter");
		};
		/** Run in the visual's page (its main world), found by its omp-visual address. */
		const inPage = (code: string) =>
			app.evaluate(async ({ webContents }, source) => {
				const contents = webContents.getAllWebContents().find(item => item.getURL().startsWith("omp-visual://"));
				if (!contents) throw new Error("No visual page");
				return contents.executeJavaScript(source, true);
			}, code);
		/** A real mouse click (trusted, through the page's input pipeline) on `selector`. */
		const realClick = (selector: string) =>
			app.evaluate(async ({ webContents }, target) => {
				const contents = webContents.getAllWebContents().find(item => item.getURL().startsWith("omp-visual://"));
				if (!contents) throw new Error("No visual page");
				const box = (await contents.executeJavaScript(
					`(() => { const r = document.querySelector(${JSON.stringify(target)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
				)) as { x: number; y: number };
				const factor = contents.getZoomFactor();
				const x = Math.round(box.x * factor);
				const y = Math.round(box.y * factor);
				contents.sendInputEvent({ type: "mouseMove", x, y });
				contents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
				contents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
			}, selector);
		try {
			await window.waitForFunction(() => window.omp?.rpc != null);
			await expect
				.poll(async () => (await window.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
				.toBe("ready");
			const aside = window.locator("aside[data-docked]");
			const status = window.locator("[data-preview-status]");

			// C135: the agent shows a project file; the Preview comes forward with it.
			await tool({ action: "open", target: "plans.html" });
			await expect.poll(async () => (await results()).join("\n")).toContain("Showing");
			const id = /visual ([0-9a-f]{16})/.exec((await results())[0] ?? "")?.[1] ?? "";
			expect(id).toMatch(/^[0-9a-f]{16}$/);
			await expect(status).toHaveText("Plan options");
			const bar = aside.locator(`[data-preview-visual="${id}"]`);
			await expect(bar).toContainText("plans.html");
			// Its stylesheet loads from the project; hidden files never do.
			expect(await inPage("getComputedStyle(document.getElementById('title')).color")).toBe("rgb(51, 102, 255)");
			expect(
				await inPage("fetch('/.env').then(response => response.status, () => 0)").catch(() => "refused"),
			).not.toBe(200);

			// C141: a changed file is a new version; the bar flips back to the first.
			await fs.writeFile(path.join(project, "plans.html"), page("Plan options v2"));
			await tool({ action: "open", target: "plans.html" });
			await expect(status).toHaveText("Plan options v2");
			const versions = aside.getByRole("combobox", { name: label.version, exact: true });
			await expect(versions).toHaveValue("2");
			await versions.selectOption("1");
			await expect(status).toHaveText("Plan options");
			await versions.selectOption("2");
			await expect(status).toHaveText("Plan options v2");

			// C137/C138: pick the heading with a real click, comment on it.
			await aside.getByRole("button", { name: label.element, exact: true }).click();
			await expect(aside.locator("[data-preview-picking=element]")).toBeVisible();
			await realClick("#title");
			const note = aside.locator('[data-preview-note="1"]');
			await expect(note).toContainText("<h1> Pick a plan");
			await aside.getByRole("textbox", { name: label.comment, exact: true }).fill("Make it friendlier");

			// C139: a CSS variable changes the page live.
			await aside.getByRole("button", { name: label.variables, exact: true }).click();
			const accent = aside
				.locator("[data-preview-variables] label")
				.filter({ hasText: "--accent" })
				.locator("input");
			await expect(accent).toHaveValue("#3366ff");
			await accent.fill("#ff0000");
			await expect
				.poll(() => inPage("getComputedStyle(document.getElementById('title')).color"))
				.toBe("rgb(255, 0, 0)");
			await capture("visualize-feedback");

			// Both go to the composer as one message.
			await aside.getByRole("button", { name: label.send, exact: true }).click();
			await expect(composer).toHaveValue(new RegExp(label.header));
			const message = await composer.inputValue();
			expect(message).toContain('1. <h1> `#title` "Pick a plan" — Make it friendlier');
			expect(message).toContain("- --accent: #3366ff → #ff0000");
			await expect(note).toHaveCount(0);
			await composer.fill("");

			// gui_visualize check reads the shown page.
			await tool({ action: "check", visual: id });
			await expect.poll(async () => (await results()).join("\n")).toContain("Title: Plan options v2");

			// C143: choose waits for a real click; a script's click on another choice never counts.
			const before = (await results()).length;
			await tool({ action: "choose", visual: id, timeout_seconds: 30 });
			await expect
				.poll(
					async () => {
						await inPage("document.getElementById('a').click()");
						await realClick("#b");
						return (await results()).slice(before).join("\n");
					},
					{ intervals: [500] },
				)
				.toContain('The user chose \\"pro\\" (Pro).');
			expect((await results()).slice(before).join("\n")).not.toContain("basic");

			// C141: "All visuals" lists it across tabs and launches.
			await aside.getByRole("button", { name: label.options, exact: true }).click();
			await window.getByRole("menuitem", { name: label.all, exact: true }).click();
			const dialog = window.getByRole("dialog");
			await expect(dialog.locator("[data-preview-visual-list] li")).toHaveCount(1);
			await expect(dialog).toContainText("plans.html");
			if (captures) await dialog.screenshot({ path: path.join(captures, `visualize-all-${language}-${theme}.png`) });
			await window.keyboard.press("Escape");
			await expect(dialog).toHaveCount(0);

			// close removes its tab.
			await tool({ action: "close", visual: id });
			await expect(bar).toHaveCount(0);
		} finally {
			await exitApp(app);
			await fs.rm(profile, { recursive: true, force: true });
		}
	});
}
