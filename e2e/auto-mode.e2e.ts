/**
 * Automatic mode choice on the fake omp (e2e/fixture/rpc-ui.ts answers the bridge's `modes.auto_mode_decide` /
 * `modes.auto_mode_undo` by keyword; the real classifier against stock is covered by src/main/bridge-auto-mode*.test.ts
 * and the opt-in e2e/real-auto-mode.e2e.ts). Covers: a big-change prompt enters plan mode with the "Auto: Plan"
 * chip and one-click undo, "until tests pass" starts a goal, a question stays in no mode, the Mode popover's switch
 * and Settings' row share the pref, a manually chosen mode is never overridden, and an undo stops further
 * automatic decisions in that session. With the decision held like the real judge (`OMP_GUI_TEST_AUTO_MODE_DELAY_MS`)
 * and stock's own goal turn on `goal create` (`OMP_GUI_TEST_GOAL_TURN`), a typed or accepted-suggestion prompt
 * empties the composer at Enter and never comes back to it, and a completed automatic goal drops its chip so the
 * next prompt is classified afresh.
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
const modeButton = (page: Page): Locator => page.locator("[data-composer-modes-trigger]");

async function send(page: Page, message: string, replies: number): Promise<void> {
	await composer(page).fill(message);
	await composer(page).press("Enter");
	await expect(page.getByText("Local fixture reply")).toHaveCount(replies, { timeout: 30_000 });
	await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
}

test("a big change enters plan mode with a chip, one click undoes it; a question stays in no mode", async () => {
	const launched = await launch();
	const { page, record } = launched;
	try {
		await send(page, "what does the settings store do?", 1);
		await expect(chip(page)).toHaveCount(0);
		await expect(modeButton(page)).toContainText("Mode");

		await send(page, "refactor the whole settings module across all files", 2);
		await expect(chip(page)).toHaveText("Auto: Plan");
		await expect(modeButton(page)).toContainText("Plan");
		await expect(composer(page)).toHaveValue("");
		expect((await recordsOfType(record, "modes.auto_mode_decide")).length).toBe(2);

		await chip(page).click();
		await expect(chip(page)).toHaveCount(0);
		await expect(modeButton(page)).not.toContainText("Plan");
		expect(await recordsOfType(record, "modes.auto_mode_undo")).toMatchObject([{ mode: "plan" }]);

		// The undo stops automatic decisions in this session.
		await send(page, "refactor the whole routing layer across all packages", 3);
		await expect(chip(page)).toHaveCount(0);
	} finally {
		await finish(launched);
	}
});

test("a prompt with a completion condition starts a goal", async () => {
	const launched = await launch();
	const { page, record } = launched;
	try {
		await send(page, "keep going until all the tests pass", 1);
		await expect(chip(page)).toHaveText("Auto: Goal");
		await expect(composer(page)).toHaveValue("");
		const writes = async () => (await recordsOfType(record, "goal")).filter(frame => frame.op !== "get");
		expect(await writes()).toMatchObject([{ op: "create", objective: "keep going until all the tests pass" }]);
		await chip(page).click();
		await expect(chip(page)).toHaveCount(0);
		expect((await writes()).map(frame => frame.op)).toEqual(["create", "drop"]);
	} finally {
		await finish(launched);
	}
});

test("the switch in the Mode popover turns it off; a manually chosen mode is never overridden", async () => {
	const launched = await launch();
	const { page } = launched;
	try {
		await modeButton(page).click();
		const toggle = page.getByRole("switch", { name: "Auto mode" });
		await expect(toggle).toBeChecked();
		await expect(page.getByText("Only picks Plan or Goal", { exact: false })).toBeVisible();
		await toggle.click();
		await expect(toggle).not.toBeChecked();
		await page.keyboard.press("Escape");
		await send(page, "refactor the whole settings module across all files", 1);
		await expect(chip(page)).toHaveCount(0);
		expect(await page.evaluate(() => window.omp.prefs.get("autoMode"))).toBe(false);
	} finally {
		await finish(launched);
	}
});

test("a prompt sent in a mode the user picked is not classified", async () => {
	const launched = await launch();
	const { page, record } = launched;
	try {
		await modeButton(page).click();
		await page.getByRole("switch", { name: "Plan mode" }).click();
		await page.keyboard.press("Escape");
		await send(page, "refactor the whole settings module across all files", 1);
		await expect(chip(page)).toHaveCount(0);
		expect(await recordsOfType(record, "modes.auto_mode_decide")).toHaveLength(0);
	} finally {
		await finish(launched);
	}
});

const PLAN_PROMPT = "refactor the whole settings module across all files";
const GOAL_PROMPT = "keep going until all the tests pass";
/** The real judge answers in about a second; the composer must be empty for all of it. */
const SLOW_CHOICE = { OMP_GUI_TEST_AUTO_MODE_DELAY_MS: "800" };

/** Press Enter and check the composer emptied at once, before the choice is in. */
async function sendAndSeeItClear(page: Page): Promise<void> {
	await composer(page).press("Enter");
	await expect(composer(page)).toHaveValue("");
	await expect(chip(page)).toHaveCount(0);
}

/** Take the placeholder suggestion (Tab) after a first turn. */
async function acceptSuggestion(page: Page, suggestion: string): Promise<void> {
	await send(page, "hello there", 1);
	await expect(composer(page)).toHaveAttribute("placeholder", suggestion, { timeout: 30_000 });
	await composer(page).focus();
	await page.keyboard.press("Tab");
	await expect(composer(page)).toHaveValue(suggestion);
}

test("an accepted suggestion the choice puts in plan mode leaves the composer empty", async () => {
	const launched = await launch(
		{},
		{ ...SLOW_CHOICE, OMP_GUI_TEST_NEXT_PROMPT: JSON.stringify({ candidates: [PLAN_PROMPT] }) },
	);
	const { page } = launched;
	try {
		await acceptSuggestion(page, PLAN_PROMPT);
		await sendAndSeeItClear(page);
		await expect(chip(page)).toHaveText("Auto: Plan");
		await expect(page.getByText("Local fixture reply")).toHaveCount(2, { timeout: 30_000 });
		await expect(composer(page)).toHaveValue("");
		await expect(page.getByText("Message not sent")).toHaveCount(0);
	} finally {
		await finish(launched);
	}
});

for (const way of ["a typed prompt", "an accepted suggestion"] as const)
	test(`${way} that starts a goal joins the goal's own turn and never comes back to the composer`, async () => {
		const launched = await launch(
			{},
			{
				...SLOW_CHOICE,
				// Stock's `goal create` starts the goal's turn at once, ahead of the prompt.
				OMP_GUI_TEST_GOAL_TURN: JSON.stringify({ holdMs: 600 }),
				OMP_GUI_TEST_NEXT_PROMPT: JSON.stringify({ candidates: [GOAL_PROMPT] }),
			},
		);
		const { page, record } = launched;
		try {
			if (way === "a typed prompt") await composer(page).fill(GOAL_PROMPT);
			else await acceptSuggestion(page, GOAL_PROMPT);
			await sendAndSeeItClear(page);
			await expect(chip(page)).toHaveText("Auto: Goal");
			await expect(page.getByText("Local fixture reply")).toHaveCount(way === "a typed prompt" ? 1 : 2, {
				timeout: 30_000,
			});
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
		{ ...SLOW_CHOICE, OMP_GUI_TEST_GOAL_TURN: JSON.stringify({ holdMs: 1500, complete: true }) },
	);
	const { page, record } = launched;
	try {
		await composer(page).fill(GOAL_PROMPT);
		await sendAndSeeItClear(page);
		await expect(chip(page)).toHaveText("Auto: Goal");
		// The goal's turn completes it the way stock's `goal` tool does.
		await expect(page.getByText("Local fixture reply")).toHaveCount(1, { timeout: 30_000 });
		await expect(chip(page)).toHaveCount(0);
		expect((await page.evaluate(() => window.omp.rpc.getGoal())).data).toMatchObject({ enabled: false });

		await composer(page).fill(PLAN_PROMPT);
		await sendAndSeeItClear(page);
		await expect(chip(page)).toHaveText("Auto: Plan");
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

const ratchetTab = (page: Page): Locator => page.getByRole("tab", { name: "Ratchet" });
const ratchetSwitch = (page: Page): Locator => page.locator("[data-ratchet-mode]");

test("Ratchet is a manual switch in the Mode popover and a prompt sent with it on is never classified", async () => {
	const launched = await launch({}, { OMP_GUI_TEST_RATCHET: "{}" });
	const { page, record } = launched;
	try {
		await modeButton(page).click();
		await ratchetTab(page).click();
		await expect(ratchetSwitch(page)).not.toBeChecked();
		await ratchetSwitch(page).click();
		await expect(ratchetSwitch(page)).toBeChecked();
		expect(await recordsOfType(record, "modes.set_ratchet")).toMatchObject([{ enabled: true }]);
		await page.keyboard.press("Escape");
		await expect(modeButton(page)).toContainText("Ratchet");
		await send(page, "refactor the whole settings module across all files", 1);
		await expect(chip(page)).toHaveCount(0);
		expect(await recordsOfType(record, "modes.auto_mode_decide")).toHaveLength(0);
	} finally {
		await finish(launched);
	}
});

test("Ratchet says which tools are missing and cannot be turned on", async () => {
	const launched = await launch({}, { OMP_GUI_TEST_RATCHET: JSON.stringify({ missing: ["eval"] }) });
	const { page, record } = launched;
	try {
		await modeButton(page).click();
		await ratchetTab(page).click();
		await expect(page.locator("[data-ratchet-missing]")).toHaveText(/needs the eval tool/);
		await expect(ratchetSwitch(page)).toBeDisabled();
		expect(await recordsOfType(record, "modes.set_ratchet")).toHaveLength(0);
	} finally {
		await finish(launched);
	}
});

test("a Mode popover on an omp without Ratchet has no Ratchet tab", async () => {
	const launched = await launch();
	try {
		await modeButton(launched.page).click();
		await expect(ratchetTab(launched.page)).toHaveCount(0);
	} finally {
		await finish(launched);
	}
});
