import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { exitApp } from "./harness";
import { realOmpProfile } from "./real-omp";

// Explicit opt-in audit on the user's small model: each scenario is one turn of
// a real omp session, captured light and dark, and the finished transcript is
// captured again in Korean after a relaunch. Invariants that hold whatever the
// model writes are asserted; everything else is evidence for review.
const SCENARIOS: ReadonlyArray<{ name: string; prompt: string; during?: (page: Page, tab: string) => Promise<void> }> =
	[
		{
			name: "edit",
			prompt:
				"Create the file notes.txt containing exactly the line alpha. Then use the edit tool to change alpha to beta. Then reply in one sentence.",
		},
		{
			name: "todo",
			prompt:
				"Use your todo tool to create a list with three tasks: Read, Count, Report. Mark Read in progress, run the bash command `ls`, mark Read completed and Count in progress, run `wc -l notes.txt`, then stop and reply in one sentence. Leave Count and Report open.",
			during: async page => {
				await expect(page.locator(".omp-live-step .omp-work-todo-toggle")).toBeVisible({ timeout: 120_000 });
				await capture(page, "todo-running");
				// The running card carries the todos; the dock above the composer does not repeat them.
				await expect(page.locator('[data-testid="workspace-dock"] section[aria-label="Todos"]')).toHaveCount(0);
			},
		},
		{
			name: "failing-command",
			prompt:
				"Run the bash command `exit 3` exactly once. Do not retry and do not run anything else. Reply in one sentence.",
		},
		{
			name: "silent-then-interrupted",
			prompt: "Run the bash command `sleep 40 && echo done` exactly once and wait for it.",
			during: async (page, tab) => {
				// Stock may move a long command to the background after a few seconds (18.10+),
				// which ends the step before it can go silent; either outcome is a valid capture.
				const clock = page.locator(".omp-live-step .omp-work-clock").filter({ hasText: "without output" });
				const backgrounded = page.locator(".omp-live-step").filter({ hasText: /Background|백그라운드/ });
				await expect(clock.or(backgrounded).first()).toBeVisible({ timeout: 120_000 });
				await capture(page, "silent-running");
				await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "abort" }), tab);
			},
		},
		{
			name: "agent-cancelled",
			prompt:
				"Use the task tool exactly once to start ONE general-purpose agent named Sleeper using @smol. Sleeper runs the bash command `sleep 60` and then reports done. Wait for it.",
			during: async (page, tab) => {
				await expect(page.locator(".omp-work-card-button")).toHaveCount(1, { timeout: 120_000 });
				await page.locator(".omp-work-card-button").first().click();
				await expect(
					page.locator(".omp-work-stage > .omp-work-crossfade > [data-incoming] .omp-live-step"),
				).toBeVisible({
					timeout: 120_000,
				});
				await capture(page, "agent-running");
				await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "abort" }), tab);
			},
		},
		{
			name: "long",
			prompt:
				"Run these twenty bash commands one at a time, each as its own separate bash tool call, in order: echo 1, echo 2, echo 3, echo 4, echo 5, echo 6, echo 7, echo 8, echo 9, echo 10, echo 11, echo 12, echo 13, echo 14, echo 15, echo 16, echo 17, echo 18, echo 19, echo 20. Then reply with the single word done.",
		},
		{ name: "text-only", prompt: "Reply with exactly the word hello. Do not use any tools." },
	];

// Its own subdirectory: the map audit writes to the same variable, and the run clears only what it owns.
const evidence = path.join(
	process.env.OMP_GUI_REAL_WORK_ARTIFACTS ?? path.join(os.tmpdir(), "ompdesk-real-work"),
	"scenarios",
);

async function capture(page: Page, name: string): Promise<void> {
	await fs.mkdir(evidence, { recursive: true });
	for (const [theme, label] of [
		["light", "Porcelain"],
		["dark", "Graphite"],
	]) {
		const input = page.locator("textarea").first();
		const draft = await input.inputValue();
		await input.fill("/theme");
		await page.getByRole("button", { name: /^(Send|보내기)$/ }).click();
		const dialog = page.getByRole("dialog");
		await dialog.getByPlaceholder(/Search themes|테마 검색/).fill(label);
		await dialog.locator("button[aria-pressed]").filter({ hasText: label }).click();
		await expect(dialog).toHaveCount(0);
		await page.getByRole("button", { name: /^(Close|닫기)$/ }).evaluateAll(buttons => {
			for (const button of buttons) if (button instanceof HTMLButtonElement) button.click();
		});
		await input.fill(draft);
		await page.screenshot({
			path: path.join(evidence, `${name}-${theme}.png`),
			animations: "disabled",
			scale: "css",
		});
	}
}

async function launch(
	desktop: string,
	project: string,
	env: Record<string, string>,
): Promise<[ElectronApplication, Page]> {
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env,
	});
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
	await expect
		.poll(() => page.evaluate(() => window.omp.sidecar.getStatus()), { timeout: 60_000 })
		.toMatchObject({ status: "ready" });
	return [app, page];
}

test("real omp work scenarios on the small model", async () => {
	test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in model audit");
	test.setTimeout(1_800_000);
	await fs.rm(evidence, { recursive: true, force: true });
	const { profile, project, desktop, env } = await realOmpProfile();
	let [app, page] = await launch(desktop, project, env);
	try {
		// One session, one turn per scenario: each finished group stays above the next.
		const tab = (await page.evaluate(() => window.omp.tabs.list())).find(row => row.active);
		if (!tab) throw new Error("No scenario tab");
		for (const scenario of SCENARIOS) {
			await test.step(scenario.name, async () => {
				const input = page.locator("textarea").first();
				await input.fill(scenario.prompt);
				await input.press("Enter");
				await expect(page.getByPlaceholder(/Steer omp/)).toBeVisible({ timeout: 60_000 });
				await scenario.during?.(page, tab.tabId);
				await expect(page.getByPlaceholder(/Ask omp anything/)).toBeVisible({ timeout: 300_000 });
				if (scenario.name === "agent-cancelled") {
					// Whether stock stops a detached agent with the turn is stock's call: capture
					// the group right after the stop, then once the agent has settled either way.
					await capture(page, "agent-after-stop");
				}
				await expect(page.locator('.omp-execution-group[data-state="running"]')).toHaveCount(0, {
					timeout: 120_000,
				});
				if (scenario.name === "agent-cancelled") {
					// The agent's completion notice starts a follow-up turn; let it finish first.
					await page
						.getByPlaceholder(/Steer omp/)
						.waitFor({ timeout: 20_000 })
						.catch(() => undefined);
					await expect(page.getByPlaceholder(/Ask omp anything/)).toBeVisible({ timeout: 300_000 });
				}
				// Model-independent invariants: a stopped turn never claims success, a failing command fails.
				// Assert on the group that answers this scenario's own prompt: stock's todo-reminder
				// auto-continuation can append a later continuation card after it.
				const ownGroupState = () =>
					page.evaluate(prompt => {
						// The bubble renders `code` without its backticks: drop them, then fold whitespace.
						const plain = (text: string | null) => (text ?? "").replaceAll("`", "").replace(/\s+/g, " ").trim();
						const rows = [...document.querySelectorAll(".omp-user-bubble, .omp-execution-group")];
						const asked = rows.findLastIndex(
							row => row.matches(".omp-user-bubble") && plain(row.textContent).includes(plain(prompt)),
						);
						if (asked === -1) return "prompt not rendered";
						const group = rows.slice(asked + 1).find(row => row.matches(".omp-execution-group"));
						return group?.getAttribute("data-state") ?? "no group";
					}, scenario.prompt);
				if (scenario.name === "silent-then-interrupted") await expect.soft.poll(ownGroupState).toBe("interrupted");
				if (scenario.name === "failing-command") await expect.soft.poll(ownGroupState).toBe("failed");
				await capture(page, scenario.name);
			});
		}
		const tabs = await page.evaluate(() => window.omp.tabs.list());
		await fs.writeFile(path.join(evidence, "tabs.json"), JSON.stringify(tabs, null, 2));
		await exitApp(app);

		// The same finished session, reopened in Korean: each work group in view once.
		const prefsFile = path.join(desktop, "prefs.json");
		await fs.writeFile(
			prefsFile,
			JSON.stringify({ ...JSON.parse(await fs.readFile(prefsFile, "utf8")), language: "ko" }),
		);
		[app, page] = await launch(desktop, project, env);
		const groups = page.locator(".omp-execution-group");
		if ((await groups.count()) === 0) {
			// The relaunch opens a fresh tab; reopen the audited session from the sidebar.
			await page.getByRole("button", { name: /^Create the file notes\.txt/ }).click();
		}
		await expect(groups.first()).toBeVisible({ timeout: 30_000 });
		// One capture per viewport, top to bottom. The transcript is virtualized, so group
		// locators detach while it scrolls, and a scroll without a reader gesture is undone by
		// its tail follower: take the view the way a reader does (focus, Home), then step the
		// virtualized scroller itself. The theme the session last used is kept: the light/dark
		// pass above already covered colour.
		const scroll = page.locator(".omp-transcript-scroll:visible");
		await expect(scroll).toHaveCount(1);
		const settle = () =>
			page.evaluate(() => {
				const { promise, resolve } = Promise.withResolvers<void>();
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
				return promise;
			});
		await scroll.focus();
		// Older pages load while the reader sits at the top: hold it there until the history stops growing.
		let previousHeight = -1;
		await expect
			.poll(
				async () => {
					await page.keyboard.press("Home");
					await scroll.evaluate(element => element.scrollTo({ top: 0 }));
					await settle();
					const { height, top } = await scroll.evaluate(element => ({
						height: element.scrollHeight,
						top: element.scrollTop,
					}));
					const loading = await page.getByTestId("transcript-history-status").count();
					const stable = height === previousHeight && top === 0 && loading === 0;
					previousHeight = height;
					return stable;
				},
				{ timeout: 60_000 },
			)
			.toBe(true);
		const plain = (text: string) => text.replaceAll("`", "").replace(/\s+/g, " ").trim();
		const prompts = new Set<string>();
		let reachedEnd = false;
		for (let index = 0; index < 80 && !reachedEnd; index++) {
			await settle();
			const view = await scroll.evaluate(element => ({
				text: element instanceof HTMLElement ? element.innerText : "",
				prompts: [...element.querySelectorAll(".omp-user-bubble")].map(bubble => bubble.textContent ?? ""),
			}));
			for (const prompt of view.prompts) prompts.add(plain(prompt));
			// Stock's persisted todo reminder reads as the reminder line, never as its prompt text.
			expect(view.text).not.toMatch(/You stopped with \d+ incomplete todo|Please continue working on these tasks/);
			await page.screenshot({
				path: path.join(evidence, `ko-group-${index + 1}.png`),
				animations: "disabled",
				scale: "css",
			});
			reachedEnd = await scroll.evaluate(element => {
				if (element.scrollTop + element.clientHeight >= element.scrollHeight - 2) return true;
				element.scrollTop += Math.round(element.clientHeight * 0.9);
				return false;
			});
		}
		expect(reachedEnd).toBe(true);
		// Every scenario's own prompt survives the reload as its user bubble.
		for (const scenario of SCENARIOS)
			expect(
				[...prompts].some(prompt => prompt.includes(plain(scenario.prompt))),
				scenario.name,
			).toBe(true);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
