/**
 * Hero: a prompt, the agent working (tool steps, two subagents, a todo list on the work board) and the result.
 * Light is the README's hero; the dark variant is its `prefers-color-scheme: dark` source.
 */
import { expect, test } from "@playwright/test";
import { exitApp } from "../../../e2e/harness";
import { cleanup, fixture, flow, launch, makeProfile, Recorder, type Theme, typePrompt } from "../lib";

const PROMPT = "Add a dark theme toggle to the settings page, then run the checks.";

const TASKS = [
	"Find where the theme is set",
	"Add the toggle to Settings",
	"Remember the choice",
	"Run the checks",
] as const;

const todo = (done: number) => ({
	phases: [
		{
			name: "Dark theme",
			tasks: TASKS.map((content, index) => ({
				content,
				status: index < done ? "completed" : index === done ? "in_progress" : "pending",
			})),
		},
	],
});

const DIFF = [
	"@@ -1,4 +1,6 @@",
	" export const settings = {",
	"   theme: 'light',",
	"+  themeToggle: true,",
	"+  rememberTheme: true,",
	"   language: 'en',",
	" };",
].join("\n");

const REPLY = [
	"Dark theme is in. The Settings page has a theme toggle and remembers the choice.",
	"",
	"- `src/settings.ts` now exposes `themeToggle` and `rememberTheme`",
	"- Two reviewers checked the code and the contrast: no issues",
	"- `bun test`: 12 passed",
].join("\n");

for (const theme of ["light", "dark"] as const satisfies readonly Theme[])
	test(`hero (${theme})`, async () => {
		const name = theme === "light" ? "hero" : "hero-dark";
		const profile = await makeProfile({ name, theme });
		const { app, page } = await launch(profile, 1440, 900);
		const recorder = new Recorder(name, {
			width: 1440,
			height: 900,
			maxHold: 1_500,
			endHold: 2_500,
			maxMB: 6,
			fps: 12,
		});
		try {
			await recorder.reset();
			await recorder.attach(page);
			await page.waitForTimeout(900);
			await typePrompt(page, PROMPT);
			await expect(page.locator("[data-transcript-kind]").first()).toBeVisible({ timeout: 30_000 });
			// The composer hands a prompt over a task after Enter: the first op repeats until the turn exists.
			await expect(async () =>
				flow(page, {
					op: "call",
					id: "c1",
					name: "bash",
					args: { command: 'grep -rn "theme" src', intent: "Finding where the theme is set" },
				}),
			).toPass({ timeout: 15_000 });
			await fixture(page, "fixture:title:Dark theme toggle");
			await page.waitForTimeout(800);
			await flow(page, {
				op: "output",
				id: "c1",
				text: "src/settings.ts:2:  theme: 'light',\nsrc/app.ts:4:  return settings.theme;",
			});
			await page.waitForTimeout(500);
			await flow(page, {
				op: "end",
				id: "c1",
				text: "src/settings.ts:2:  theme: 'light',\nsrc/app.ts:4:  return settings.theme;",
			});
			await flow(page, { op: "call", id: "c2", name: "todo", args: {} });
			await flow(page, { op: "end", id: "c2", text: "todo updated", details: todo(1) });
			await page.waitForTimeout(900);
			await flow(page, {
				op: "call",
				id: "c3",
				name: "task",
				args: {
					tasks: [
						{ name: "SettingsScout", task: "Map the settings code" },
						{ name: "ContrastReview", task: "Check contrast in dark mode" },
					],
				},
				agents: ["SettingsScout", "ContrastReview"],
			});
			await expect(page.getByRole("complementary", { name: "Work board" })).toBeVisible({ timeout: 15_000 });
			await page.waitForTimeout(2_600);
			await flow(page, { op: "end", id: "c3", text: "Both agents finished." });
			await page.waitForTimeout(500);
			await flow(page, {
				op: "call",
				id: "c4",
				name: "edit",
				args: {
					path: "src/settings.ts",
					edits: [
						{
							old_text: "  theme: 'light',",
							new_text: "  theme: 'light',\n  themeToggle: true,\n  rememberTheme: true,",
						},
					],
				},
			});
			await page.waitForTimeout(800);
			await flow(page, { op: "end", id: "c4", text: "Updated src/settings.ts", details: { diff: DIFF } });
			await flow(page, { op: "call", id: "c5", name: "todo", args: {} });
			await flow(page, { op: "end", id: "c5", text: "todo updated", details: todo(3) });
			await page.waitForTimeout(700);
			await flow(page, {
				op: "call",
				id: "c6",
				name: "bash",
				args: { command: "bun test", intent: "Running the checks" },
			});
			await page.waitForTimeout(900);
			await flow(page, { op: "output", id: "c6", text: "bun test v1.2\n\n 12 pass\n 0 fail" });
			await page.waitForTimeout(700);
			await flow(page, { op: "end", id: "c6", text: "bun test v1.2\n\n 12 pass\n 0 fail" });
			await flow(page, { op: "call", id: "c7", name: "todo", args: {} });
			await flow(page, { op: "end", id: "c7", text: "todo updated", details: todo(4) });
			await page.waitForTimeout(600);
			await flow(page, { op: "reply", text: REPLY });
			await expect(page.getByText("Dark theme is in.")).toBeVisible();
			await page.waitForTimeout(2_000);
			await recorder.finish({ width: 1600 });
		} finally {
			await recorder.detach();
			await exitApp(app);
			await cleanup(profile);
		}
	});
