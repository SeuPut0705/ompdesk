/**
 * Automatic mode choice on the fake omp (e2e/fixture/rpc-ui.ts answers the bridge's `modes.auto_mode_decide` /
 * `modes.auto_mode_undo` by keyword and, like the bridge, answers none for a busy session; the real classifier
 * against stock is covered by src/main/bridge-auto-mode*.test.ts). A decision is used for one request only: a
 * big-change prompt gets plan with the "This request: Plan" chip and one-click undo while the Mode picker stays on the
 * user's own modes, and that plan ends when it is approved, rejected or followed by an unrelated message (stock's own
 * exit, `set_plan_mode` off); "until tests pass" gets a goal that ends when it completes or the user stops it; a
 * question stays plain; a session that ran a turn moments ago is never classified (`OMP_GUI_TEST_AUTO_MODE_IDLE_MS`
 * turns that window off for the other tests); the Mode popover's switch and Settings' row share the pref; a manually
 * chosen mode always wins; an undo stops further automatic decisions in that session. With the decision held like
 * the real judge (`OMP_GUI_TEST_AUTO_MODE_DELAY_MS`) and stock's own goal turn on `goal create`
 * (`OMP_GUI_TEST_GOAL_TURN`), a typed or accepted-suggestion prompt empties the composer at Enter and never comes back.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { exitApp, launchApp, recordsOfType } from "./harness";

interface Launched {
	app: ElectronApplication;
	page: Page;
	profile: string;
	record: string;
}

let launches = 0;

async function launch(prefs: Record<string, unknown> = {}, extraEnv: Record<string, string> = {}): Promise<Launched> {
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-auto-mode-")));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	const record = path.join(profile, `commands-${++launches}.jsonl`);
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", themeName: "light", firstRunComplete: true, ...prefs }),
	);
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: { OMP_GUI_TEST_RECORD: record, ...extraEnv },
	});
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page, profile, record };
}

async function finish(launched: Launched): Promise<void> {
	await exitApp(launched.app);
	await fs.rm(launched.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

const composer = (page: Page): Locator => page.locator(".omp-composer-input").first();
const chip = (page: Page): Locator => page.locator("[data-auto-mode-chip]");
const modeButton = (page: Page): Locator => page.locator("[data-run-settings-trigger]");

async function send(page: Page, message: string, replies: number): Promise<void> {
	await composer(page).fill(message);
	await composer(page).press("Enter");
	await expect(page.getByText("Local fixture reply")).toHaveCount(replies, { timeout: 30_000 });
	await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
}

/** The fake omp's busy window off: every prompt counts as new work (the busy guard has its own test). */
const EVERY_PROMPT_IS_NEW = { OMP_GUI_TEST_AUTO_MODE_IDLE_MS: "0" };
const PLAN_PROMPT = "refactor the whole settings module across all files";
const GOAL_PROMPT = "keep going until all the tests pass";

test("a big change uses plan for that request only: a chip shows it, the Mode picker does not; a question stays plain", async () => {
	const launched = await launch({}, EVERY_PROMPT_IS_NEW);
	const { page, record } = launched;
	try {
		await send(page, "what does the settings store do?", 1);
		await expect(chip(page)).toHaveCount(0);
		await expect(modeButton(page)).toContainText("Run settings");

		await send(page, "refactor the whole settings module across all files", 2);
		await expect(chip(page)).toHaveText("This request: Plan");
		await expect(modeButton(page)).toContainText("Run settings");
		await expect(modeButton(page)).not.toContainText("Plan");
		await modeButton(page).click();
		// The popover's own Plan switch (the plan dock card above the composer has its own exit switch).
		await expect(page.locator("[data-plan-mode]")).not.toBeChecked();
		await page.keyboard.press("Escape");
		await expect(composer(page)).toHaveValue("");
		expect(await recordsOfType(record, "modes.set_plan_mode")).toMatchObject([{ enabled: true, auto: true }]);
		expect((await recordsOfType(record, "modes.auto_mode_decide")).length).toBe(2);

		await chip(page).click();
		await expect(chip(page)).toHaveCount(0);
		expect(await recordsOfType(record, "modes.auto_mode_undo")).toMatchObject([{ mode: "plan" }]);

		// The undo stops automatic decisions in this session.
		await send(page, "refactor the whole routing layer across all packages", 3);
		await expect(chip(page)).toHaveCount(0);
	} finally {
		await finish(launched);
	}
});

/** The real judge answers in about a second; the composer must be empty for all of it. */
const SLOW_CHOICE = { OMP_GUI_TEST_AUTO_MODE_DELAY_MS: "800" };

/** Press Enter and check the composer emptied at once, before the choice is in. */
async function sendAndSeeItClear(page: Page): Promise<void> {
	await composer(page).press("Enter");
	await expect(composer(page)).toHaveValue("");
	await expect(chip(page)).toHaveCount(0);
}

test("a typed prompt that starts a goal joins the goal's own turn and never comes back to the composer", async () => {
	const launched = await launch(
		{},
		{
			...SLOW_CHOICE,
			...EVERY_PROMPT_IS_NEW,
			// Stock's `goal create` starts the goal's turn at once, ahead of the prompt.
			OMP_GUI_TEST_GOAL_TURN: JSON.stringify({ holdMs: 600 }),
		},
	);
	const { page, record } = launched;
	try {
		await composer(page).fill(GOAL_PROMPT);
		await sendAndSeeItClear(page);
		await expect(chip(page)).toHaveText("This request: Goal");
		await expect(page.getByText("Local fixture reply")).toHaveCount(1, { timeout: 30_000 });
		await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
		await expect(composer(page)).toHaveValue("");
		await expect(page.getByText("Message not sent")).toHaveCount(0);
		const prompts = (await recordsOfType(record, "prompt")).filter(frame => frame.message === GOAL_PROMPT);
		expect(prompts).toMatchObject([{ streamingBehavior: "steer" }]);
	} finally {
		await finish(launched);
	}
});

test("a goal the choice started ends with its chip and goal mode, and the next prompt is classified afresh", async () => {
	const launched = await launch(
		{},
		{
			...SLOW_CHOICE,
			...EVERY_PROMPT_IS_NEW,
			OMP_GUI_TEST_GOAL_TURN: JSON.stringify({ holdMs: 1500, complete: true }),
		},
	);
	const { page, record } = launched;
	try {
		await composer(page).fill(GOAL_PROMPT);
		await sendAndSeeItClear(page);
		await expect(chip(page)).toHaveText("This request: Goal");
		await expect(modeButton(page)).not.toContainText("Goal");
		// The goal's turn completes it the way stock's `goal` tool does.
		await expect(page.getByText("Local fixture reply")).toHaveCount(1, { timeout: 30_000 });
		await expect(chip(page)).toHaveCount(0);
		expect((await page.evaluate(() => window.omp.rpc.getGoal())).data).toMatchObject({ enabled: false });

		await composer(page).fill(PLAN_PROMPT);
		await sendAndSeeItClear(page);
		await expect(chip(page)).toHaveText("This request: Plan");
		expect(await recordsOfType(record, "modes.auto_mode_decide")).toMatchObject([
			{ message: GOAL_PROMPT },
			{ message: PLAN_PROMPT },
		]);
		await expect(page.getByText("Local fixture reply")).toHaveCount(2, { timeout: 30_000 });
		await expect(composer(page)).toHaveValue("");
	} finally {
		await finish(launched);
	}
});

test("Stop ends a goal the choice started; it never stays as the session's goal", async () => {
	const launched = await launch({}, { OMP_GUI_TEST_GOAL_TURN: JSON.stringify({ holdMs: 20_000 }) });
	const { page, record } = launched;
	try {
		await composer(page).fill(GOAL_PROMPT);
		await composer(page).press("Enter");
		await expect(chip(page)).toHaveText("This request: Goal");
		const stop = page.getByRole("button", { name: "Stop", exact: true });
		await expect(stop).toBeVisible();
		await stop.click();
		await expect(chip(page)).toHaveCount(0);
		await expect
			.poll(async () => (await recordsOfType(record, "goal")).filter(frame => frame.op !== "get").map(f => f.op))
			.toEqual(["create", "drop"]);
		expect((await page.evaluate(() => window.omp.rpc.getGoal())).data).toMatchObject({ enabled: false });
		// Ending it is not an undo: the session still gets automatic choices.
		expect(await recordsOfType(record, "modes.auto_mode_undo")).toHaveLength(0);
	} finally {
		await finish(launched);
	}
});
