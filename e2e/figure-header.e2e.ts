import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { exitApp, launchApp } from "./harness";

// Every figure box (mermaid, svg, code block, a write's figure in its tool card)
// has ONE compact header row: the kind on the left, icon actions on the right,
// no separate Preview/Code row above the box. Geometry and names are asserted in
// both themes and languages; pictures go to OMP_GUI_FIGURE_HEADER=<dir> (also
// into the test's output dir).

const captures = process.env.OMP_GUI_FIGURE_HEADER;

type Language = "en" | "ko";
type Theme = "light" | "dark";

const NAMES = {
	en: {
		preview: "Preview",
		code: "Code",
		copy: "Copy code",
		download: "Download as file",
		expand: "Enlarge",
		wrap: "Wrap lines",
	},
	ko: {
		preview: "미리보기",
		code: "코드",
		copy: "코드 복사",
		download: "파일로 저장",
		expand: "크게 보기",
		wrap: "줄 바꿈",
	},
} as const;

/** The header's labels in reading order, and that it is one row inside the box's top edge. */
async function headerOf(
	box: Locator,
): Promise<{ labels: (string | null)[]; title: string; height: number; boxTop: number; top: number }> {
	const header = box.locator("[data-figure-header]").first();
	return {
		labels: await header
			.locator("button")
			.evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-label"))),
		title: (await header.locator("[data-figure-title]").textContent()) ?? "",
		height: (await header.boundingBox())?.height ?? 0,
		boxTop: (await box.boundingBox())?.y ?? 0,
		top: (await header.boundingBox())?.y ?? 0,
	};
}

for (const language of ["en", "ko"] as const satisfies readonly Language[]) {
	for (const theme of ["light", "dark"] as const satisfies readonly Theme[]) {
		test(`figure boxes have one header row in ${language} ${theme}`, async () => {
			test.setTimeout(180_000);
			const names = NAMES[language];
			const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-figure-header-"));
			const project = path.join(profile, "project");
			const desktop = path.join(profile, "desktop");
			const agent = path.join(profile, "agent");
			await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
			await fs.writeFile(
				path.join(desktop, "prefs.json"),
				JSON.stringify({ language, themeName: theme, firstRunComplete: true }),
			);
			const app = await launchApp({ project, desktop, agent, profile });
			try {
				const page = await app.firstWindow();
				const errors: string[] = [];
				page.on("pageerror", error => errors.push(error.message));
				await page.waitForFunction(() => window.omp?.rpc != null);
				await expect
					.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, {
						timeout: 60_000,
					})
					.toBe("ready");
				const shoot = async (box: Locator, name: string) => {
					await box.scrollIntoViewIfNeeded();
					const file = `${name}-${language}-${theme}`;
					await box.screenshot({ path: test.info().outputPath(`${file}.png`), animations: "disabled" });
					if (captures) {
						await fs.mkdir(captures, { recursive: true });
						await box.screenshot({ path: path.join(captures, `${file}.png`), animations: "disabled" });
					}
				};

				await page.locator("textarea").first().fill("fixture figures");
				await page.keyboard.press("Enter");

				// Mermaid: kind left, Preview / Code / Copy / Download / Enlarge right, inside the box's top edge.
				const mermaid = page.locator('[data-figure="mermaid"]').first();
				await expect(mermaid.locator("[data-zoomable-image] img")).toBeVisible({ timeout: 30_000 });
				const m = await headerOf(mermaid);
				expect(m.title).toBe("Mermaid");
				expect(m.labels).toEqual([names.preview, names.code, names.copy, names.download, names.expand]);
				expect(m.top - m.boxTop).toBeLessThan(4);
				expect(m.height).toBeGreaterThan(24);
				expect(m.height).toBeLessThan(36);
				await expect(mermaid.locator("[role=tab]")).toHaveCount(0);
				// Left title, right actions.
				const spread = await mermaid.locator("[data-figure-header]").evaluate(header => {
					const rect = header.getBoundingClientRect();
					const title = header.querySelector("[data-figure-title]")?.getBoundingClientRect();
					const actions = header.querySelector("[data-figure-actions]")?.getBoundingClientRect();
					return {
						left: (title?.left ?? 0) - rect.left,
						right: rect.right - (actions?.right ?? 0),
						gap: (actions?.left ?? 0) - (title?.right ?? 0),
					};
				});
				expect(spread.left).toBeLessThan(20);
				expect(spread.right).toBeLessThan(12);
				expect(spread.gap).toBeGreaterThan(40);
				await shoot(mermaid, "mermaid");

				// The toggle switches the view and marks the pressed one; the keyboard reaches it.
				const codeButton = mermaid.getByRole("button", { name: names.code, exact: true });
				await codeButton.focus();
				await page.keyboard.press("Enter");
				await expect(codeButton).toHaveAttribute("aria-pressed", "true");
				await expect(mermaid.getByRole("button", { name: names.preview, exact: true })).toHaveAttribute(
					"aria-pressed",
					"false",
				);
				await expect(mermaid.locator(".omp-code-block")).toContainText("Plan --> Build --> Ship");
				expect((await headerOf(mermaid)).labels.slice(0, 2)).toEqual([names.preview, names.code]);
				await expect(mermaid.locator("[data-figure-header]")).toHaveCount(1);
				await mermaid.getByRole("button", { name: names.preview, exact: true }).press("Space");
				await expect(mermaid.locator("[data-zoomable-image] img")).toBeVisible();

				// The header's Enlarge opens the viewer, Escape closes it.
				await mermaid.getByRole("button", { name: names.expand, exact: true }).click();
				const viewer = page.getByRole("dialog");
				await expect(viewer).toBeVisible();
				await page.keyboard.press("Escape");
				await expect(viewer).toHaveCount(0);

				// SVG.
				const svg = page.locator('[data-figure="svg"]').first();
				await expect(svg.locator("[data-svg-preview] img")).toBeVisible();
				const s = await headerOf(svg);
				expect(s.title).toBe("SVG");
				expect(s.labels).toEqual([names.preview, names.code, names.copy, names.download, names.expand]);
				await shoot(svg, "svg");

				// Code block: language left, Wrap / Copy right, the same compact header.
				const block = page.locator(".omp-code-block").filter({ hasText: "export const answer" }).first();
				const c = await headerOf(block);
				expect(c.title).toBe("TypeScript");
				expect(c.labels).toEqual([names.wrap, names.copy]);
				expect(Math.abs(c.height - m.height)).toBeLessThan(2);
				await shoot(block, "code");

				// A write's figure in its tool card: file name left, the same icons.
				await page.locator("textarea").first().fill("fixture write figure");
				await page.keyboard.press("Enter");
				const card = page.locator("[data-figure]").filter({ hasText: "flow.mmd" }).first();
				await expect(page.getByText("docs/flow.mmd").first()).toBeAttached({ timeout: 30_000 });
				// The finished turn folds its steps; open every fold, then the card's own chevron.
				await page.evaluate(() => {
					for (const details of document.querySelectorAll("details")) details.open = true;
				});
				await page
					.getByRole("button", { name: /flow\.mmd/ })
					.first()
					.click({ timeout: 2_000 })
					.catch(() => undefined);
				for (let attempt = 0; attempt < 6 && !(await card.isVisible()); attempt++) {
					const chevron = page.locator('button[aria-expanded="false"]').filter({ has: page.locator("svg") });
					const count = await chevron.count();
					for (let i = 0; i < count && !(await card.isVisible()); i++) {
						await chevron
							.nth(i)
							.click({ timeout: 2_000 })
							.catch(() => undefined);
					}
				}
				await expect(card).toBeVisible({ timeout: 30_000 });
				expect((await headerOf(card)).title).toBe("flow.mmd");
				await shoot(card, "tool-card");
				expect(errors).toEqual([]);
			} finally {
				await exitApp(app);
				await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});
	}
}
