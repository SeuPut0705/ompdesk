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
 * - the unsent draft survives a renderer reload and an app relaunch;
 * - the completion menu: never a command menu mid-sentence, Shift+Enter is a newline, a closed menu
 *   stays closed while the caret moves, `@` reads Hangul and quotes a path with a space;
 * - `->` comes off with Backspace; ⌘Z undoes a completion and a ⌃R pick (the draft comes back);
 * - removing a picture, a file card, a queued message or cancelling the paste choice leaves typing
 *   in the field; a file pasted with text keeps the text; keys wait while the paste choice is open;
 * - the field grows again when it gets narrower;
 * - Esc with a draft only arms the stop (a second Esc stops, an empty field stops at once), and a double Esc or
 *   double Stop sends one command; Stop with queued messages and a draft keeps their order and releases nothing;
 * - Shift+Tab is focus navigation in the composer, the thinking level cycles on ⌥⇧T;
 * - a new tab, ⌃Tab and New session leave the next keystroke in the composer.
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

async function launch(dirs: Profile, env: Record<string, string> = {}, args: string[] = []): Promise<Launched> {
	const app = await launchApp({
		project: dirs.project,
		desktop: dirs.desktop,
		agent: dirs.agent,
		profile: dirs.root,
		env: { OMP_GUI_TEST_RECORD: dirs.record, OMP_GUI_TEST_SESSION_FILES: "1", ...env },
		args,
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
			const asked = (await readRecords(dirs.record)).filter(r => r.type === "modes.auto_mode_decide").length;
			await input.fill(request);
			await input.press("Enter");
			await expect(input).toHaveValue("");
			await expect(stop(page)).toBeVisible();
			// Withdraw only once the choice is in flight: on a slow runner Esc could come before the request left, and
			// a prompt withdrawn that early is never classified at all (nothing for this test to see).
			await expect
				.poll(async () => (await readRecords(dirs.record)).filter(r => r.type === "modes.auto_mode_decide").length)
				.toBe(asked + 1);
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

const menu = (page: Page) => page.locator('[role="listbox"][aria-label="Suggestions"]');

test("the completion menu keeps modified keys and its closing; `->` comes off; ⌘Z undoes completions and ⌃R picks", async () => {
	test.setTimeout(120_000);
	const dirs = await profile("menu");
	await fs.writeFile(path.join(dirs.project, "문서.md"), "korean\n");
	await fs.writeFile(path.join(dirs.project, "My Report.md"), "report\n");
	const { app, page, errors } = await launch(dirs);
	try {
		const input = composer(page);
		await input.click();
		// Mid-sentence a slash offers skills only (the fixture's skills may match): never `/retry`.
		await page.keyboard.type("hello /re");
		await page.waitForTimeout(300);
		const rows = await menu(page).getByRole("option").allInnerTexts();
		expect(rows.filter(row => !row.startsWith("/skill:"))).toEqual([]);
		// At the start it opens, and Shift+Enter is still a newline, never the completion.
		await input.fill("");
		await page.keyboard.type("/re");
		await expect(menu(page)).toBeVisible();
		await page.keyboard.press("Shift+Enter");
		await expect(input).toHaveValue("/re\n");

		// Closed with Esc, it stays closed while the caret moves through its token.
		await input.fill("");
		await page.keyboard.type("/re");
		await expect(menu(page)).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(menu(page)).toHaveCount(0);
		await page.keyboard.press("ArrowLeft");
		await page.keyboard.press("ArrowRight");
		await page.waitForTimeout(300);
		await expect(menu(page)).toHaveCount(0);
		// Typing opens it again; the picked completion is one undo step.
		await page.keyboard.type("t");
		await expect(menu(page)).toBeVisible();
		await page.keyboard.press("Tab");
		await expect(input).toHaveValue("/retry ");
		await page.keyboard.press("Meta+z");
		await expect(input).toHaveValue("/ret");

		// `@` reads Hangul, and a picked name with a space goes in quoted, as stock reads it.
		await input.fill("");
		await page.keyboard.type("see @문");
		await expect(menu(page).getByRole("option").first()).toHaveText("문서.md");
		await input.fill("");
		await page.keyboard.type('see @"My R');
		await expect(menu(page).getByRole("option").first()).toHaveText("My Report.md");
		await page.keyboard.press("Enter");
		await expect(input).toHaveValue('see @"My Report.md" ');

		// `->` gets its newline from typing only: Backspace takes it off.
		await input.fill("");
		await page.keyboard.type("->");
		await expect(input).toHaveValue("->\n");
		await page.keyboard.press("Backspace");
		await expect(input).toHaveValue("->");
		await page.keyboard.press("Backspace");
		await expect(input).toHaveValue("-");

		// A ⌃R pick replaces the draft as one edit: ⌘Z brings the draft back.
		await input.fill("older prompt");
		await input.press("Enter");
		await expect.poll(() => sentOfType(dirs.record, "prompt")).toEqual(["older prompt"]);
		await expect(stop(page)).toHaveCount(0, { timeout: 20_000 });
		await input.fill("precious draft");
		await page.keyboard.press("Control+r");
		await page.getByRole("dialog", { name: "History" }).getByRole("option", { name: "older prompt" }).click();
		await expect(input).toHaveValue("older prompt");
		await expect(input).toBeFocused();
		await page.keyboard.press("Meta+z");
		await expect(input).toHaveValue("precious draft");
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(dirs.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("removing an attachment, a card or a queued message, or cancelling a paste, keeps typing in the field", async () => {
	test.setTimeout(120_000);
	const dirs = await profile("focus-after");
	await fs.writeFile(path.join(dirs.project, "notes.md"), "notes\n");
	const { app, page, errors } = await launch(dirs);
	try {
		const input = composer(page);
		// A picture pasted with its caption: both arrive.
		await input.focus();
		await page.evaluate(() => {
			const field = document.querySelector<HTMLTextAreaElement>(".omp-composer-input");
			const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
			const data = new DataTransfer();
			data.items.add(new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], "p.png", { type: "image/png" }));
			data.setData("text/plain", "caption text");
			field?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
		});
		await expect(input).toHaveValue("caption text");
		const removeImage = page.getByRole("button", { name: "Remove image 1" });
		await expect(removeImage).toHaveCount(1);
		await removeImage.click();
		await expect(removeImage).toHaveCount(0);
		expect(await composerFocused(page)).toBe(true);
		await page.keyboard.type("!");
		await expect(input).toHaveValue("caption text!");

		// A file card's ✕.
		await input.fill("see @notes.md ");
		const removeCard = page.getByRole("button", { name: "Remove notes.md" });
		await expect(removeCard).toBeVisible();
		await removeCard.click();
		await expect(removeCard).toHaveCount(0);
		expect(await composerFocused(page)).toBe(true);

		// The paste choice: other keys wait, Cancel hands typing back, Enter pastes inline.
		await input.fill("");
		const block = Array.from({ length: 120 }, (_, line) => `row ${line}`).join("\n");
		await pasteText(page, block);
		const choice = page.getByRole("dialog", { name: /Pasted 120 lines/ });
		await expect(choice).toBeVisible();
		await page.keyboard.press("x");
		await expect(input).toHaveValue("");
		await choice.getByRole("button", { name: "Cancel" }).click();
		await expect(choice).toHaveCount(0);
		expect(await composerFocused(page)).toBe(true);
		await pasteText(page, block);
		await expect(choice).toBeVisible();
		await page.keyboard.press("Enter");
		await expect(input).toHaveValue(/^\[Paste #\d+, \+120 lines\]$/);

		// A queued steer's edit and removal.
		await input.fill("fixture running");
		await input.press("Enter");
		await expect(stop(page)).toBeVisible();
		await input.fill("queued one");
		await input.press("Enter");
		const pill = page.locator("[data-queue-pill]");
		await expect(pill).toContainText("1 queued");
		await pill.click();
		await page.getByRole("button", { name: "Edit: queued one" }).click();
		// The field itself edits the queued message; Enter saves it.
		await expect(input).toHaveValue("queued one");
		await input.fill("queued edited");
		await input.press("Enter");
		await expect(page.locator("[data-queue-edit-banner]")).toHaveCount(0);
		expect(await composerFocused(page)).toBe(true);
		await page.waitForTimeout(800);
		await pill.click();
		await page.getByRole("button", { name: "More actions: queued edited" }).click();
		await page.getByRole("menuitem", { name: "Remove" }).click();
		await expect(pill).toHaveCount(0);
		expect(await composerFocused(page)).toBe(true);
		await stop(page).click();
		await expect(stop(page)).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(dirs.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("the field fits its draft again when it gets narrower", async () => {
	test.setTimeout(90_000);
	const dirs = await profile("width");
	const { app, page, errors } = await launch(dirs);
	try {
		const input = composer(page);
		await input.fill(
			Array.from({ length: 5 }, () => "a long line of words that wraps once the composer gets narrower").join(" "),
		);
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(720, 860));
		await expect
			.poll(() => input.evaluate(el => el.scrollHeight - el.clientHeight), { timeout: 5_000 })
			.toBeLessThanOrEqual(1);
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(dirs.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

/** The Stop commands the fake omp received (the TUI-Esc `abort_and_restore_queue`). */
const aborts = async (dirs: Profile) =>
	(await readRecords(dirs.record)).filter(record => record.type === "abort_and_restore_queue").length;

test("Esc with a draft only arms the stop; an empty field stops at once; a double Esc or double Stop sends one", async () => {
	test.setTimeout(150_000);
	const dirs = await profile("esc-stop");
	const { app, page, errors } = await launch(dirs);
	try {
		const input = composer(page);
		const run = async () => {
			await input.fill("fixture running");
			await input.press("Enter");
			await expect(stop(page)).toBeVisible();
			// The turn itself runs (the send-mode chip appears): before that Stop only withdraws the pending prompt.
			await expect(page.locator("[data-send-mode]")).toBeVisible();
		};

		await run();
		await input.fill("my unsent draft");
		await input.press("Escape");
		await page.waitForTimeout(400);
		// A stray Esc never kills a turn that has a draft.
		expect(await aborts(dirs)).toBe(0);
		await expect(stop(page)).toBeVisible();
		await input.press("Escape");
		await expect(stop(page)).toHaveCount(0);
		expect(await aborts(dirs)).toBe(1);
		await expect(input).toHaveValue("my unsent draft");

		// The first Esc is forgotten after its window: the next one arms again instead of stopping.
		await run();
		await input.fill("another draft");
		await input.press("Escape");
		await page.waitForTimeout(1_800);
		await input.press("Escape");
		await page.waitForTimeout(400);
		expect(await aborts(dirs)).toBe(1);
		await expect(stop(page)).toBeVisible();
		// That Esc armed again; the next one inside its window stops.
		await input.press("Escape");
		await expect(stop(page)).toHaveCount(0);
		expect(await aborts(dirs)).toBe(2);

		// An empty field stops with the first Esc, and two Esc in one tick send one command.
		await input.fill("");
		await run();
		await page.evaluate(() => {
			for (let press = 0; press < 2; press++)
				document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		await expect(stop(page)).toHaveCount(0);
		await page.waitForTimeout(400);
		expect(await aborts(dirs)).toBe(3);

		// Two clicks on Stop in one tick send one command too.
		await run();
		await stop(page).evaluate(button => {
			(button as HTMLElement).click();
			(button as HTMLElement).click();
		});
		await expect.poll(() => aborts(dirs)).toBe(4);
		await expect(stop(page)).toHaveCount(0);
		await page.waitForTimeout(400);
		expect(await aborts(dirs)).toBe(4);
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(dirs.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("Stop with queued messages pauses the queue: separate chips in one row, the draft untouched, nothing sent until Resume", async () => {
	test.setTimeout(120_000);
	const dirs = await profile("stop-queue");
	const { app, page, errors } = await launch(dirs);
	try {
		const input = composer(page);
		await input.fill("fixture running");
		await input.press("Enter");
		await expect(stop(page)).toBeVisible();
		for (const text of ["queued one", "queued two"]) {
			await input.fill(text);
			await input.press("Enter");
			await expect(input).toHaveValue("");
		}
		await expect(page.locator("[data-queue-pill]")).toContainText("2 queued");
		await input.fill("my half-typed draft");
		await stop(page).click();
		await expect(stop(page)).toHaveCount(0);

		// The draft stays the user's own; the queued messages come back as their own chips, oldest first.
		await expect(input).toHaveValue("my half-typed draft");
		const paused = page.locator("[data-restored-queue]");
		await expect(paused).toBeVisible();
		await expect(paused).toContainText("Queue paused because you stopped");
		await expect(paused.locator("[data-restored-item]")).toHaveText([/queued one$/, /queued two$/]);
		expect(Math.round((await paused.boundingBox())?.height ?? 0)).toBe(36);
		await expect(page.locator("[data-queue-pill]")).toHaveCount(0);
		await expect(page.locator("[data-composer-live]")).toContainText(
			"Stopped. 2 queued messages are back, nothing will send until you resume",
		);
		// Nothing was released: the stopped turn's queue is not sent on its own.
		await page.waitForTimeout(800);
		expect(await sentOfType(dirs.record, "prompt")).toEqual(["fixture running"]);
		expect(await sentOfType(dirs.record, "follow_up")).toEqual([]);

		// Resume sends them in order through stock's calls: the first starts the turn again, the rest queue behind it.
		await page.mouse.move(0, 0);
		await paused.getByRole("button", { name: "Resume" }).click();
		await expect(paused).toHaveCount(0);
		await expect.poll(() => sentOfType(dirs.record, "prompt")).toEqual(["fixture running", "queued one"]);
		await expect.poll(() => sentOfType(dirs.record, "follow_up")).toEqual(["queued two"]);
		await expect(input).toHaveValue("my half-typed draft");
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(dirs.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("Discard and a chip's × drop restored messages; a chip's text puts it in the field; Esc arms the stop with a hint", async () => {
	test.setTimeout(120_000);
	const dirs = await profile("stop-queue-discard");
	const { app, page, errors } = await launch(dirs);
	try {
		const input = composer(page);
		await input.fill("fixture running");
		await input.press("Enter");
		await expect(stop(page)).toBeVisible();
		for (const text of ["queued one", "queued two", "queued three"]) {
			await input.fill(text);
			await input.press("Enter");
			await expect(input).toHaveValue("");
		}
		await stop(page).click();
		const paused = page.locator("[data-restored-queue]");
		await expect(paused.locator("[data-restored-item]")).toHaveCount(3);
		await paused.getByRole("button", { name: "Remove restored message: queued two" }).click();
		await expect(paused.locator("[data-restored-item]")).toHaveText([/queued one$/, /queued three$/]);
		await paused.getByRole("button", { name: "Put in the field: queued three" }).click();
		await expect(input).toHaveValue("queued three");
		await paused.getByRole("button", { name: "Discard all restored messages" }).click();
		await expect(paused).toHaveCount(0);
		expect(await sentOfType(dirs.record, "follow_up")).toEqual([]);

		// Esc with a draft while a turn runs only arms the stop, and the field says so; typing disarms it.
		await input.fill("fixture running");
		await input.press("Enter");
		await expect(stop(page)).toBeVisible();
		await expect(page.locator("[data-send-mode]")).toBeVisible();
		await input.fill("an unsent draft");
		await input.press("Escape");
		await expect(page.locator("[data-stop-hint]")).toHaveText("Press Esc again to stop the turn. Your draft stays.");
		await input.press("x");
		await expect(page.locator("[data-stop-hint]")).toHaveCount(0);
		expect(await aborts(dirs)).toBe(1);
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(dirs.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("Shift+Tab moves focus back out of the composer; the thinking level cycles on ⌥⇧T from anywhere", async () => {
	test.setTimeout(90_000);
	const dirs = await profile("thinking-chord");
	const { app, page, errors } = await launch(dirs);
	try {
		const input = composer(page);
		const cycles = async () =>
			(await readRecords(dirs.record)).filter(record => record.type === "cycle_thinking_level").length;
		await input.focus();
		await page.keyboard.press("Shift+Tab");
		expect(await composerFocused(page)).toBe(false);
		await page.waitForTimeout(300);
		expect(await cycles()).toBe(0);

		await input.focus();
		await page.keyboard.press("Alt+Shift+KeyT");
		await expect.poll(cycles).toBe(1);
		await page.keyboard.press("Alt+Shift+KeyT");
		await expect.poll(cycles).toBe(2);
		await input.evaluate(el => (el as HTMLElement).blur());
		await page.keyboard.press("Alt+Shift+KeyT");
		await expect.poll(cycles).toBe(3);
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(dirs.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("a new tab, ⌃Tab and New session put the next keystroke in the composer", async () => {
	test.setTimeout(120_000);
	const dirs = await profile("activation-focus");
	const { app, page, errors } = await launch(dirs);
	try {
		const field = () => page.locator('.omp-session-pane[data-active="true"] textarea[data-composer-input]');
		await composer(page).fill("first tab draft");
		await page.keyboard.press("Meta+t");
		const tabs = () => page.evaluate(() => window.omp.tabs.list());
		await expect.poll(async () => (await tabs()).length).toBe(2);
		await expect.poll(async () => (await tabs()).find(tab => tab.active)?.status, { timeout: 30_000 }).toBe("ready");
		await page.keyboard.type("second tab text");
		await expect(field()).toHaveValue("second tab text");

		// ⌃Tab from inside the composer used to leave focus on <body>: typed keys vanished.
		await page.keyboard.press("Control+Tab");
		await expect(field()).toHaveValue("first tab draft");
		await expect(field()).toBeFocused();
		await page.keyboard.type("!");
		await expect(field()).toHaveValue(/!/);

		// A sidebar button keeps focus after it is clicked; the new session's composer takes it.
		await page
			.getByRole("button", { name: /^New session/ })
			.first()
			.click();
		await expect(field()).toBeFocused();
		await page.keyboard.type("typed after the click");
		await expect(field()).toHaveValue("typed after the click");
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(dirs.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("+ › Dictation explains where to turn dictation on while it is off", async () => {
	test.setTimeout(90_000);
	const dirs = await profile("dictation-off");
	const { app, page, errors } = await launch(dirs);
	try {
		await expect(page.getByRole("button", { name: "Start dictation" })).toHaveCount(0);
		await page.getByRole("button", { name: "Attach and more" }).click();
		const item = page.getByRole("menuitem", { name: /Dictation/ });
		await expect(item).toContainText("Turn on speech-to-text in Settings");
		await item.click();
		await expect(page.locator('[data-settings-page="true"]')).toBeVisible();
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(dirs.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("dictation leaves the draft in view, Esc discards the take without stopping a running turn, a failure says what to do", async () => {
	test.setTimeout(120_000);
	const dirs = await profile("dictation");
	const { app, page, errors } = await launch(dirs, {}, [
		"--use-fake-device-for-media-stream",
		"--use-fake-ui-for-media-stream",
	]);
	try {
		const input = composer(page);
		await page.evaluate(() => window.omp.rpc.setSetting("stt.enabled", true));
		const mic = page.getByRole("button", { name: "Start dictation" });
		await expect(mic).toBeVisible();
		await input.fill("fixture running");
		await input.press("Enter");
		await expect(stop(page)).toBeVisible();
		await expect(page.locator("[data-send-mode]")).toBeVisible();
		await input.fill("my draft");

		await mic.click();
		const bar = page.locator('[data-dictation="recording"]');
		await expect(bar).toBeVisible();
		// The bar sits under the field, never over it: the draft stays readable.
		const fieldBox = await input.boundingBox();
		const barBox = await bar.boundingBox();
		if (!fieldBox || !barBox) throw new Error("no boxes");
		expect(barBox.y).toBeGreaterThanOrEqual(fieldBox.y + fieldBox.height - 1);
		await expect(input).toHaveValue("my draft");
		await expect(bar).toContainText("Enter");

		// Esc discards the take; the running turn is not stopped.
		await page.keyboard.press("Escape");
		await expect(bar).toHaveCount(0);
		await page.waitForTimeout(400);
		expect(await aborts(dirs)).toBe(0);
		await expect(stop(page)).toBeVisible();
		await expect(input).toHaveValue("my draft");

		// The fake omp cannot transcribe: the failure is a plain sentence, the raw error sits behind Details.
		await mic.click();
		await expect(bar).toBeVisible();
		await page.waitForTimeout(700);
		await page.keyboard.press("Enter");
		const failure = page.locator("[data-dictation-failure]");
		await expect(failure).toBeVisible({ timeout: 20_000 });
		await expect(failure).toContainText("Dictation failed. Try again.");
		await expect(failure).not.toContainText("transcribe_audio");
		await failure.getByRole("button", { name: "Details" }).click();
		await expect(failure.locator("[data-error-detail]")).not.toBeEmpty();
		await failure.getByRole("button", { name: "Dismiss" }).click();
		await expect(failure).toHaveCount(0);
		expect(await aborts(dirs)).toBe(0);
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(dirs.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
