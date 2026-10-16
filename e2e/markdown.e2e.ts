/**
 * GitHub-flavored markdown in replies, on the fake omp: the live tail renders
 * markdown while streaming (no raw markers), and the finished reply has
 * working footnote refs/backrefs and heading links, a task list without
 * bullets, header case and column alignment kept, the five alerts with color
 * only on their marks, upright quotes, an unlabeled fence left plain, a wrap
 * toggle, a zoomable mermaid diagram with its source, and a local:// link that
 * opens the session file. Captures: light/dark × en/ko and a narrow window.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { capture, exitApp, launchApp } from "./harness";

type Language = "en" | "ko";
type Theme = "light" | "dark";

async function launch(
	language: Language,
	theme: Theme,
): Promise<{ app: ElectronApplication; page: Page; profile: string }> {
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-markdown-")));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(path.join(project, "local"), { recursive: true }), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(project, "local", "PLAN.md"), "# Fixture plan\n\nShip the markdown wave.\n");
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language, themeName: theme, firstRunComplete: true }),
	);
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile,
	});
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page, profile };
}

const ALERT_TITLES: Record<Language, string[]> = {
	en: ["Note", "Tip", "Important", "Warning", "Caution"],
	ko: ["참고", "팁", "중요", "경고", "주의"],
};

for (const language of ["en", "ko"] as const)
	for (const theme of ["light", "dark"] as const)
		test(`replies render GitHub-flavored markdown (${language} ${theme})`, async () => {
			test.setTimeout(150_000);
			const { app, page, profile } = await launch(language, theme);
			try {
				const errors: string[] = [];
				page.on("pageerror", error => errors.push(error.message));
				const input = page.locator("textarea").first();

				// Live tail: markdown, not markers, before the turn ends.
				await input.fill("fixture markdown stream");
				await input.press("Enter");
				const tail = page.locator(".omp-streaming-tail").last();
				await expect(tail).toContainText("render live while the", { timeout: 30_000 });
				await expect(tail.locator("strong")).toHaveText("bold");
				await expect(tail.locator("code")).toHaveText("code");
				await expect(tail.locator("a")).toHaveText("link");
				expect(await tail.textContent()).not.toMatch(/\*\*|`|\]\(/);
				await expect(page.locator(".omp-streaming-block h2").last()).toHaveText("Live answer");
				await capture(page, `${language}-${theme}-streaming`);
				await page.evaluate(command => window.omp.rpc.bash(command), "fixture:finish");
				await expect(page.locator(".omp-streaming-tail")).toHaveCount(0);

				await input.fill("fixture markdown");
				await input.press("Enter");
				const reply = page
					.locator(".omp-transcript-content .markdown-body")
					.filter({ hasText: "Release checklist" });
				await expect(reply.locator("h2#user-content-release-checklist")).toBeVisible({ timeout: 30_000 });

				// Task list: checkboxes in the bullets' place.
				const task = reply.locator("li.task-list-item").first();
				expect(await task.evaluate(item => getComputedStyle(item).listStyleType)).toBe("none");
				// Table: header case and the delimiter row's alignment.
				const headers = reply.locator("th");
				await expect(headers.nth(0)).toHaveText("Step");
				expect(await headers.nth(0).evaluate(cell => getComputedStyle(cell).textTransform)).toBe("none");
				expect(await headers.nth(1).evaluate(cell => getComputedStyle(cell).textAlign)).toBe("center");
				expect(
					await reply
						.locator("td")
						.nth(2)
						.evaluate(cell => getComputedStyle(cell).textAlign),
				).toBe("right");
				// Alerts: localized titles, color on the rule and the label only.
				const alerts = reply.locator("blockquote[data-alert]");
				await expect(alerts).toHaveCount(5);
				await expect(alerts.locator("[data-alert-title]")).toHaveText(ALERT_TITLES[language]);
				const warning = alerts.nth(3);
				const [rule, label, body] = await warning.evaluate(quote => [
					getComputedStyle(quote).borderLeftColor,
					getComputedStyle(quote.querySelector("[data-alert-title]") as Element).color,
					getComputedStyle(quote.querySelector("p:last-child") as Element).color,
				]);
				expect(rule).toBe(label);
				expect(body).not.toBe(label);
				expect(await warning.evaluate(quote => getComputedStyle(quote).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
				// Quotes stay upright.
				const plainQuote = reply.locator("blockquote:not([data-alert])");
				expect(await plainQuote.evaluate(quote => getComputedStyle(quote).fontStyle)).toBe("normal");
				// The unlabeled fence is plain text: no guessed highlighting.
				const plain = reply.locator(".omp-code-block").filter({ hasText: "no guessed colors" });
				await expect(plain.locator("[class^='hljs-']")).toHaveCount(0);
				await reply
					.locator("h2")
					.first()
					.evaluate(heading => heading.scrollIntoView({ block: "start" }));
				await capture(page, `${language}-${theme}-reply-top`);

				// Wrap: the long line wraps inside the block instead of scrolling.
				const typed = reply.locator(".omp-code-block").filter({ hasText: "const answer" });
				const pre = typed.locator("pre");
				const scrolls = () => pre.evaluate(element => element.scrollWidth > element.clientWidth);
				expect(await scrolls()).toBe(true);
				await typed.locator("[data-code-wrap]").click();
				await expect(typed.locator("[data-code-wrap]")).toHaveAttribute("aria-pressed", "true");
				expect(await scrolls()).toBe(false);

				// Mermaid: the diagram zooms, and its source is one switch away.
				const fence = reply.locator("[data-mermaid-fence]");
				const diagram = fence.locator("[data-zoomable-image] img");
				await diagram.scrollIntoViewIfNeeded();
				await expect(diagram).toBeVisible({ timeout: 30_000 });
				await expect.poll(() => diagram.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
				await capture(page, `${language}-${theme}-reply-middle`);
				await fence.locator("[data-zoomable-image]").click();
				const viewer = page.getByRole("dialog");
				await expect(viewer).toBeVisible();
				await capture(page, `${language}-${theme}-mermaid-zoom`);
				await page.keyboard.press("Escape");
				await expect(viewer).toHaveCount(0);
				// The diagram keeps its natural size inside the zoom button instead of collapsing.
				expect((await diagram.boundingBox())?.width ?? 0).toBeGreaterThan(120);
				await fence.getByRole("tab", { name: language === "en" ? "Code" : "코드" }).click();
				await expect(fence.locator(".omp-code-block")).toContainText("Plan --> Build --> Ship");
				await fence.getByRole("tab", { name: language === "en" ? "Preview" : "미리보기" }).click();
				await expect(diagram).toBeVisible();

				// Footnotes: ref → note → back; the heading link lands on its heading.
				await reply.locator("a[data-footnote-ref]").click();
				await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("user-content-fn-1");
				await capture(page, `${language}-${theme}-reply-bottom`);
				await reply.locator("a[data-footnote-backref]").click();
				await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("user-content-fnref-1");
				await reply.locator('a[href="#notes"]').click();
				await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("user-content-notes");

				// local:// opens the session file stock resolves (the fixture's `<cwd>/local`).
				await reply.locator('a[href="local://PLAN.md"]').click();
				const aside = page.locator("aside[data-docked]");
				await expect(aside).toContainText("Ship the markdown wave.", { timeout: 15_000 });
				await capture(page, `${language}-${theme}-local-link`);

				if (language === "en" && theme === "dark") {
					await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(720, 860));
					await reply.locator("table").scrollIntoViewIfNeeded();
					const table = await reply.locator("table").boundingBox();
					const content = await reply.boundingBox();
					if (!table || !content) throw new Error("Missing narrow geometry");
					expect(table.x + table.width).toBeLessThanOrEqual(content.x + content.width + 1);
					await capture(page, "narrow-en-dark");
				}
				expect(errors).toEqual([]);
			} finally {
				await exitApp(app);
				await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});
