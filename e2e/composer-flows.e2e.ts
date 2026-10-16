/**
 * Composer flows found broken by real use (composer audit, Oct 2026), on the fake omp:
 * - a folded paste that starts with `!` is sent as a prompt (it ran as a local shell command, with no
 *   bash badge), and ↑ sends the paste's text again, never the bare `[Paste #N]` marker;
 * - "+ › Use a skill…" puts the keys in the picker's search (they went to the composer, and Enter
 *   sent the draft);
 * - a Follow-up picked on the send-mode chip lasts for that run only, the chip and Stop leave
 *   typing in the field;
 * - Stop and Esc withdraw a prompt the automatic mode choice still holds back: nothing reaches
 *   omp, the plan it picked ends, the draft returns (there was no Stop, and Esc Esc opened the
 *   rewind picker);
 * - the unsent draft survives a renderer reload and an app relaunch.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { exitApp, launchApp, readRecords } from "./harness";

interface Launched {
	app: ElectronApplication;
	page: Page;
	errors: string[];
}

interface Profile {
	root: string;
	project: string;
	desktop: string;
	agent: string;
	record: string;
}

async function profile(name: string): Promise<Profile> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `omp-gui-composer-${name}-`)));
	const dirs = {
		root,
		project: path.join(root, "project"),
		desktop: path.join(root, "desktop"),
		agent: path.join(root, "agent"),
		record: path.join(root, "commands.jsonl"),
	};
	await Promise.all([fs.mkdir(dirs.project), fs.mkdir(dirs.desktop), fs.mkdir(dirs.agent)]);
	await fs.writeFile(
		path.join(dirs.desktop, "prefs.json"),
		JSON.stringify({ language: "en", firstRunComplete: true }),
	);
	return dirs;
}

async function launch(dirs: Profile, env: Record<string, string> = {}): Promise<Launched> {
	const app = await launchApp({
		project: dirs.project,
		desktop: dirs.desktop,
		agent: dirs.agent,
		profile: dirs.root,
		env: { OMP_GUI_TEST_RECORD: dirs.record, OMP_GUI_TEST_SESSION_FILES: "1", ...env },
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await ready(page);
	return { app, page, errors };
}

async function ready(page: Page): Promise<void> {
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
}

const composer = (page: Page) => page.locator(".omp-composer-input").first();
const stop = (page: Page) => page.getByRole("button", { name: "Stop", exact: true });
const composerFocused = (page: Page) =>
	page.evaluate(() => document.activeElement?.classList.contains("omp-composer-input") === true);

async function sentOfType(file: string, type: string): Promise<string[]> {
	return (await readRecords(file))
		.filter(record => record.type === type)
		.map(record => String(record.message ?? record.command ?? ""));
}

/** A clipboard paste of plain text into the composer, as the platform delivers it. */
async function pasteText(page: Page, text: string): Promise<void> {
	await composer(page).focus();
	await page.evaluate(content => {
		const field = document.querySelector<HTMLTextAreaElement>(".omp-composer-input");
		const data = new DataTransfer();
		data.setData("text/plain", content);
		field?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
	}, text);
}

test("a folded paste that starts with ! is a prompt, and ↑ sends a paste's text again", async () => {
	test.setTimeout(120_000);
	const dirs = await profile("paste");
	const { app, page, errors } = await launch(dirs);
	try {
		const input = composer(page);
		const lines = Array.from({ length: 11 }, (_, line) => `log line ${line}`);
		const bang = ["!echo pasted", ...lines].join("\n");
		await pasteText(page, bang);
		await expect(input).toHaveValue(/^\[Paste #\d+, \+12 lines\]$/);
		await expect(page.locator("[data-composer-mode]")).toHaveCount(0);
		await input.press("Enter");
		await expect.poll(() => sentOfType(dirs.record, "prompt")).toEqual([bang]);
		await expect(stop(page)).toHaveCount(0, { timeout: 20_000 });
		expect(await sentOfType(dirs.record, "bash")).toEqual([]);

		const block = ["see this log:", ...lines].join("\n");
		await pasteText(page, block);
		await input.press("Enter");
		await expect.poll(() => sentOfType(dirs.record, "prompt")).toEqual([bang, block]);
		await expect(stop(page)).toHaveCount(0, { timeout: 20_000 });
		await input.click();
		await page.keyboard.press("ArrowUp");
		await expect(input).toHaveValue(block);
		await input.press("Enter");
		await expect.poll(() => sentOfType(dirs.record, "prompt")).toEqual([bang, block, block]);
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(dirs.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("+ › Use a skill… takes the keys; the send-mode chip lasts one run; the chip and Stop keep typing in the field", async () => {
	test.setTimeout(120_000);
	const dirs = await profile("focus");
	const { app, page, errors } = await launch(dirs);
	try {
		const input = composer(page);
		await input.fill("keep me");
		await page.getByRole("button", { name: "Attach and more" }).click();
		await page.getByRole("menuitem", { name: /Use a skill/ }).click();
		await expect(page.getByRole("searchbox", { name: "Search skills" })).toBeFocused();
		await page.keyboard.type("tdd");
		await page.keyboard.press("Enter");
		await expect(input).toHaveValue("keep me /skill:tdd ");
		await expect(input).toBeFocused();
		expect(await sentOfType(dirs.record, "prompt")).toEqual([]);

		await input.fill("fixture running");
		await input.press("Enter");
		const chip = page.locator("[data-send-mode]");
		await expect(chip).toHaveAttribute("data-send-mode", "steer");
		await chip.click();
		await expect(chip).toHaveAttribute("data-send-mode", "followUp");
		expect(await composerFocused(page)).toBe(true);
		await stop(page).click();
		await expect(stop(page)).toHaveCount(0);
		expect(await composerFocused(page)).toBe(true);

		await input.fill("fixture running");
		await input.press("Enter");
		await expect(chip).toHaveAttribute("data-send-mode", "steer");
		await input.fill("steer again");
		await input.press("Enter");
		await expect.poll(() => sentOfType(dirs.record, "steer")).toEqual(["steer again"]);
		expect(await sentOfType(dirs.record, "follow_up")).toEqual([]);
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(dirs.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("Stop and Esc withdraw a prompt the automatic mode choice still holds back", async () => {
	test.setTimeout(120_000);
	const dirs = await profile("withdraw");
	const { app, page, errors } = await launch(dirs, { OMP_GUI_TEST_AUTO_MODE_DELAY_MS: "2500" });
	try {
		const input = composer(page);
		const request = "refactor the parser into separate modules";
		for (const how of ["Esc", "Stop"] as const) {
			await input.fill(request);
			await input.press("Enter");
			await expect(input).toHaveValue("");
			await expect(stop(page)).toBeVisible();
			if (how === "Esc") await input.press("Escape");
			else await stop(page).click();
			await expect(input).toHaveValue(request);
			await expect(stop(page)).toHaveCount(0);
			expect(await composerFocused(page)).toBe(true);
			// The decision (Plan) lands after the withdrawal: the plan it entered ends, the prompt never leaves.
			await expect
				.poll(
					async () =>
						(await readRecords(dirs.record)).filter(r => r.type === "modes.set_plan_mode").map(r => r.enabled),
					{
						timeout: 10_000,
					},
				)
				.toEqual(how === "Esc" ? [true, false] : [true, false, true, false]);
		}
		expect(await sentOfType(dirs.record, "prompt")).toEqual([]);
		await expect(page.getByRole("dialog")).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(dirs.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("the unsent draft survives a renderer reload and an app relaunch", async () => {
	test.setTimeout(150_000);
	const dirs = await profile("draft");
	let launched = await launch(dirs);
	try {
		await composer(launched.page).fill("an unsent thought");
		await launched.page.waitForTimeout(600);
		await launched.page.reload();
		await ready(launched.page);
		await expect(composer(launched.page)).toHaveValue("an unsent thought");

		await exitApp(launched.app);
		launched = await launch(dirs);
		await expect(composer(launched.page)).toHaveValue("an unsent thought");

		// Sent, it is gone for good.
		await composer(launched.page).press("Enter");
		await expect.poll(() => sentOfType(dirs.record, "prompt")).toEqual(["an unsent thought"]);
		await launched.page.reload();
		await ready(launched.page);
		await launched.page.waitForTimeout(800);
		await expect(composer(launched.page)).toHaveValue("");
		expect(launched.errors).toEqual([]);
	} finally {
		await exitApp(launched.app);
		await fs.rm(dirs.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
