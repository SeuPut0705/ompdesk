import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { exitApp, launchApp } from "./harness";

// A click never leaves a focus ring behind for a modifier pressed alone (lib/focus-modality.ts): Chromium counts a
// lone Shift as keyboard use, which would ring the transcript, a title bar button, the panel's resize handle or a
// Settings row the click focused. Tab and the arrow keys still ring what they reach.

let app: ElectronApplication;
let page: Page;
let profile: string;
let errors: string[];

test.beforeEach(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-focus-ring-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	app = await launchApp({ project, desktop, agent, profile, env: { OMP_GUI_HEADLESS: "1" } });
	page = await app.firstWindow();
	errors = [];
	page.on("pageerror", error => errors.push(error.message));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
});

test.afterEach(async () => {
	if (app) await exitApp(app);
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	expect(errors).toEqual([]);
});

/** The focused element's outline as drawn, with `::after` (ListRow draws its ring there). */
async function ring(): Promise<{ focused: string; outline: string }> {
	return page.evaluate(() => {
		const el = document.activeElement;
		if (!(el instanceof HTMLElement) || el === document.body) return { focused: "body", outline: "none" };
		const own = getComputedStyle(el);
		const after = getComputedStyle(el, "::after");
		const drawn = [own, after].find(style => style.outlineStyle !== "none" && style.outlineWidth !== "0px");
		return {
			focused: el.getAttribute("aria-label") ?? el.className.toString().split(" ")[0] ?? el.tagName,
			outline: drawn ? `${drawn.outlineStyle} ${drawn.outlineWidth}` : "none",
		};
	});
}

/** Click `target` (focusing it), then press each modifier alone: nothing gains a ring. */
async function expectNoRingAfterModifiers(target: Locator) {
	await target.click();
	const clicked = await ring();
	expect(clicked.focused).not.toBe("body");
	expect(clicked.outline).toBe("none");
	for (const key of ["Shift", "Control", "Alt", "Meta"]) {
		await page.keyboard.press(key);
		expect(await ring(), `${clicked.focused} after ${key}`).toEqual({ focused: clicked.focused, outline: "none" });
	}
}

test("a click then a modifier alone leaves no ring on the transcript, title bar, panel edge or a Settings row", async () => {
	// The transcript scroller (tabindex 0): its ring is the whole main pane's border.
	const transcript = page.locator(".omp-transcript-scroll").first();
	await expect(transcript).toBeVisible();
	await expectNoRingAfterModifiers(transcript);
	// A toggle that keeps focus: the side panel opens and its button stays focused.
	await expectNoRingAfterModifiers(page.getByRole("button", { name: "Side panel" }));
	// The panel's resize handle (a focusable separator).
	await expectNoRingAfterModifiers(page.getByRole("separator", { name: "Resize side panel" }));
	// A Settings section row (ListRow: a ring on the button and on its ::after).
	await page.keyboard.press(process.platform === "darwin" ? "Meta+Comma" : "Control+Comma");
	const settings = page.getByRole("region", { name: "Settings" });
	await expect(settings).toBeVisible();
	await expectNoRingAfterModifiers(settings.locator("nav button").nth(1));
});

test("a click then a modifier alone leaves no focus highlight on a resize handle; an arrow key shows it", async () => {
	// Transitions off (global.css, reduced motion), so each read is the settled color.
	await page.emulateMedia({ reducedMotion: "reduce" });
	const background = () =>
		page.evaluate(() => getComputedStyle(document.activeElement ?? document.body).backgroundColor);
	await page.getByRole("button", { name: "Side panel" }).click();
	// The handle's `focus-visible:bg-(--sc-accent)`: a Tailwind utility, not a ring.
	await page.getByRole("separator", { name: "Resize side panel" }).click();
	// Off the handle, so its hover wash is not what is read.
	const transcript = await page.locator(".omp-transcript-scroll").first().boundingBox();
	if (!transcript) throw new Error("no transcript");
	await page.mouse.move(transcript.x + transcript.width / 2, transcript.y + transcript.height / 2);
	expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Resize side panel");
	const atRest = await background();
	expect(atRest).toBe("rgba(0, 0, 0, 0)");
	for (const key of ["Shift", "Control", "Alt", "Meta"]) {
		await page.keyboard.press(key);
		expect(await background(), `after ${key}`).toBe(atRest);
	}
	await page.keyboard.press("ArrowLeft");
	expect(await background()).not.toBe(atRest);
});

test("Tab and the arrow keys still ring what they reach after a click", async () => {
	const panelButton = page.getByRole("button", { name: "Side panel" });
	await panelButton.click();
	await page.keyboard.press("Shift");
	expect((await ring()).outline).toBe("none");
	// Shift+Tab from the button moves by keyboard: the control it reaches shows its ring.
	await page.keyboard.press("Shift+Tab");
	const reached = await ring();
	expect(reached.focused).not.toBe("Side panel");
	expect(reached.outline).not.toBe("none");
	// Tab back to the button: its ring shows.
	await page.keyboard.press("Tab");
	expect(await ring()).toEqual({ focused: "Side panel", outline: expect.not.stringMatching(/^none$/) });
	// An arrow key on a separator a click focused counts as keyboard use too.
	await page.getByRole("separator", { name: "Resize side panel" }).click();
	expect((await ring()).outline).toBe("none");
	await page.keyboard.press("ArrowLeft");
	expect(await ring()).toEqual({ focused: "Resize side panel", outline: expect.not.stringMatching(/^none$/) });
	// A menu opened by a click: Shift alone rings no item, an arrow key rings the item it moves to.
	await page.getByRole("button", { name: "Session actions" }).click();
	await expect(page.getByRole("menu")).toBeVisible();
	await page.keyboard.press("Shift");
	expect((await ring()).outline).toBe("none");
	await page.keyboard.press("ArrowDown");
	expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("menuitem");
	expect((await ring()).outline).not.toBe("none");
});
