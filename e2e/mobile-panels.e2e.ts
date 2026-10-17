import * as fs from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import {
	type Browser,
	type BrowserType,
	chromium,
	devices,
	expect,
	type Locator,
	type Page,
	test,
	webkit,
} from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { variants } from "./harness";

// The side panels on a phone and a tablet (mobile web, design §7) in Chromium and WebKit device emulation, on
// the dev harness (src/renderer/dev-harness): the Preview as streamed frames with touch, the soft keyboard field
// and the page's dialogs; the Terminal's key bar, text size and size-lease banner; Changes and Files as a list
// and then one item. OMP_GUI_MOBILE_PANELS=<dir> also writes the light/dark × en/ko captures.

const captures = process.env.OMP_GUI_MOBILE_PANELS;

// A cold Vite dev server can reload once while it optimizes dependencies; a second try is that, not a flake.
test.describe.configure({ retries: 1 });

const DEVICES: ReadonlyArray<{ name: string; phone: boolean }> = [
	{ name: "iPhone 15", phone: true },
	{ name: "iPad Pro 11", phone: false },
];

const ENGINES: ReadonlyArray<{ name: string; type: BrowserType }> = [
	{ name: "chromium", type: chromium },
	{ name: "webkit", type: webkit },
];

let server: ViteDevServer | undefined;
let origin = "";

async function freePort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const probe = createNetServer();
	probe.once("error", reject);
	probe.listen(0, "127.0.0.1", () => {
		const address = probe.address();
		const port = typeof address === "object" && address ? address.port : 0;
		probe.close(() => resolve(port));
	});
	return promise;
}

test.beforeAll(async () => {
	const port = await freePort();
	server = await createServer({
		configFile: path.resolve("vite.harness.config.ts"),
		server: { host: "127.0.0.1", port, strictPort: true },
		logLevel: "error",
	});
	await server.listen();
	origin = `http://127.0.0.1:${port}`;
});

test.afterAll(async () => {
	await server?.close();
});

interface Look {
	theme: "light" | "dark";
	lang: "en" | "ko";
}

const LIGHT_EN: Look = { theme: "light", lang: "en" };

async function openHarness(browser: Browser, device: string, look: Look): Promise<Page> {
	const context = await browser.newContext({ ...devices[device] });
	const page = await context.newPage();
	page.on("pageerror", error => {
		throw error;
	});
	await page.goto(`${origin}/harness.html?theme=${look.theme}&lang=${look.lang}`);
	await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
	return page;
}

type View = "terminal" | "diff" | "preview" | "files";

const VIEW_NAME: Record<View, Record<Look["lang"], string>> = {
	terminal: { en: "Terminal", ko: "터미널" },
	diff: { en: "Changes", ko: "변경 사항" },
	preview: { en: "Preview", ko: "미리보기" },
	files: { en: "Files", ko: "파일" },
};

/** Open the side panel on `view`: the phone's tab bar under the thumb, the tablet sheet's header buttons. */
async function openView(page: Page, phone: boolean, view: View, lang: Look["lang"] = "en"): Promise<Locator> {
	const sheet = page.locator("[data-sheet-panel]");
	if (!(await sheet.isVisible())) await page.locator('[data-tour="panel"]').click();
	await expect(sheet).toBeVisible();
	const name = VIEW_NAME[view][lang];
	const button = phone
		? page.locator("[data-panel-tabbar]").getByRole("button", { name, exact: true })
		: sheet.getByRole("button", { name, exact: true });
	await button.click();
	return sheet;
}

/** The frames of the harness page are on screen once the address is entered. */
async function showPreview(page: Page, phone: boolean, lang: Look["lang"] = "en"): Promise<Locator> {
	const sheet = await openView(page, phone, "preview", lang);
	const address = sheet.locator('input[inputmode="url"]');
	await address.fill("localhost:3000");
	await address.press("Enter");
	const frame = sheet.locator("[data-preview-stream-frame]");
	await expect(frame).toBeVisible({ timeout: 15_000 });
	return frame;
}

/** The Terminal with its output drawn; the key bar is open at once on a phone and one tap away on a tablet. */
async function showTerminal(page: Page, phone: boolean, lang: Look["lang"] = "en"): Promise<Locator> {
	const sheet = await openView(page, phone, "terminal", lang);
	await expect(sheet.locator(".xterm")).toBeVisible({ timeout: 15_000 });
	await expect(sheet.locator("[data-terminal-viewport]")).toContainText("1200 passed", { timeout: 15_000 });
	if (!phone) await sheet.locator("[data-terminal-keys-toggle]").click();
	await expect(sheet.locator("[data-terminal-keybar]")).toBeVisible();
	return sheet;
}

async function capture(page: Page, name: string, tag: string): Promise<void> {
	if (!captures) return;
	await fs.mkdir(captures, { recursive: true });
	await page.waitForTimeout(450);
	await page.screenshot({ path: path.join(captures, `${tag}-${name}.png`), animations: "disabled" });
}

/** The fields of the payloads this spec reads back (a stream input, a layout, a terminal operation). */
interface Recorded {
	t?: string;
	x?: number;
	y?: number;
	text?: string;
	key?: string;
	action?: string;
	dpr?: number;
	data?: string;
	id?: string;
	budget?: number;
	waitMs?: number;
}

/** What the harness recorded for one channel, oldest first: each call's arguments. */
async function calls(page: Page, channel: string): Promise<Recorded[][]> {
	return page.evaluate(
		name =>
			(window.__harness?.calls ?? []).filter(call => call.channel === name).map(call => call.args as Recorded[]),
		channel,
	);
}

// The default run keeps Chromium on a phone; the tablet and WebKit run with OMP_GUI_VARIANTS=1.
for (const { engine, device } of variants(
	ENGINES.flatMap(engine => DEVICES.map(device => ({ engine, device }))),
	({ engine, device }) => engine.name === "chromium" && device.phone,
)) {
	test.describe(`${engine.name} · ${device.name}`, () => {
		let browser: Browser;

		test.beforeAll(async () => {
			browser = await engine.type.launch();
		});
		test.afterAll(async () => {
			await browser.close();
		});

		test("the preview is the host's page as frames: a tap, a swipe and a pinch-free scroll reach it as pointer input", async () => {
			const page = await openHarness(browser, device.name, LIGHT_EN);
			const frame = await showPreview(page, device.phone);
			expect(await frame.getAttribute("src")).toMatch(/^data:image\/jpeg;base64,/);
			await frame.tap({ position: { x: 100, y: 200 } });
			await expect
				.poll(async () => (await calls(page, "preview:stream-input")).flat(2).find(event => event.t === "tap"))
				.toMatchObject({ t: "tap" });
			const tap = (await calls(page, "preview:stream-input")).flat(2).find(event => event.t === "tap");
			// Fractions of the frame, not pixels: the host maps them onto its own page.
			expect(tap?.x).toBeGreaterThan(0);
			expect(tap?.x).toBeLessThan(1);
			expect(tap?.y).toBeGreaterThan(0);
			expect(tap?.y).toBeLessThan(1);
			// The layout the host sizes the page to carries this screen's pixel ratio.
			const layouts = (await calls(page, "preview:command"))
				.map(args => args[0])
				.filter(request => request.action === "layout");
			expect(layouts.some(request => typeof request.dpr === "number" && request.dpr >= 1)).toBe(true);
			await page.context().close();
		});

		test("the soft keyboard field takes focus on request, and text, a line break and a composition go to the page", async () => {
			const page = await openHarness(browser, device.name, LIGHT_EN);
			await showPreview(page, device.phone);
			await page.locator("[data-preview-stream-keyboard]").click();
			const field = page.locator("[data-preview-stream-input]");
			await expect(field).toBeFocused();
			// The field is 16 px: iOS never zooms the page for it.
			expect(
				await field.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize)),
			).toBeGreaterThanOrEqual(16);
			await page.keyboard.type("hi");
			await page.keyboard.press("Enter");
			await expect
				.poll(
					async () =>
						(await calls(page, "preview:stream-input")).flat(2).filter(event => event.t === "text").length,
				)
				.toBeGreaterThanOrEqual(2);
			const sent = (await calls(page, "preview:stream-input")).flat(2);
			expect(
				sent
					.filter(event => event.t === "text")
					.map(event => event.text)
					.join(""),
			).toBe("hi");
			expect(sent.some(event => event.t === "key" && event.key === "Enter")).toBe(true);
			// An IME composition shows on the phone and is sent once, committed.
			await field.evaluate(element => {
				element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
				element.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "ㅎ" }));
			});
			await expect(page.locator("[data-preview-stream-composing]")).toHaveText("ㅎ");
			const before = (await calls(page, "preview:stream-input")).length;
			await field.evaluate(element => {
				element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "한" }));
			});
			await expect(page.locator("[data-preview-stream-composing]")).toHaveCount(0);
			const after = (await calls(page, "preview:stream-input")).slice(before).flat(2);
			expect(after).toEqual([{ t: "text", text: "한" }]);
			await page.context().close();
		});

		test("a dialog the page opens is a sheet the page waits on until it is answered; the selection copies", async () => {
			const page = await openHarness(browser, device.name, LIGHT_EN);
			await showPreview(page, device.phone);
			await page.evaluate(() => {
				window.__harness?.stream.dialogs.push({
					id: 41,
					kind: "confirm",
					message: "Delete this row?",
					initial: null,
				});
			});
			const dialog = page.locator("[data-preview-dialog]");
			await expect(dialog).toContainText("Delete this row?", { timeout: 10_000 });
			await capture(page, "dialog", `${engine.name}-${device.name.replace(/ /g, "-")}-light-en`);
			await page.locator("[data-preview-dialog-ok]").click();
			await expect(dialog).toHaveCount(0);
			await expect
				.poll(() => page.evaluate(() => window.__harness?.stream.answers))
				.toEqual([{ id: 41, accept: true }]);
			await page.evaluate(() => {
				window.__harness?.stream.dialogs.push({ id: 42, kind: "prompt", message: "Name?", initial: "Ada" });
			});
			await expect(page.locator("[data-preview-dialog-input]")).toHaveValue("Ada", { timeout: 10_000 });
			await page.locator("[data-preview-dialog-input]").fill("Grace");
			await page.locator("[data-preview-dialog-input]").press("Enter");
			await expect
				.poll(() => page.evaluate(() => window.__harness?.stream.answers.at(-1)))
				.toEqual({ id: 42, accept: true, text: "Grace" });
			await page.context().close();
		});

		test("the terminal has a key bar of touch-sized keys that write what a PTY expects, with sticky Ctrl", async () => {
			const page = await openHarness(browser, device.name, LIGHT_EN);
			const sheet = await showTerminal(page, device.phone);
			const bar = sheet.locator("[data-terminal-keybar]");
			await expect(bar).toBeVisible();
			const smallest = await bar
				.locator("[data-terminal-key]")
				.evaluateAll(keys => Math.min(...keys.map(key => key.getBoundingClientRect().height)));
			expect(smallest).toBeGreaterThanOrEqual(44);
			await bar.locator('[data-terminal-key="esc"]').dispatchEvent("pointerdown");
			await bar.locator('[data-terminal-key="ctrl"]').dispatchEvent("pointerdown");
			await expect(bar.locator('[data-terminal-key="ctrl"]')).toHaveAttribute("aria-pressed", "true");
			await bar.locator('[data-terminal-key="up"]').dispatchEvent("pointerdown");
			await bar.locator('[data-terminal-key="up"]').dispatchEvent("pointerup");
			await expect(bar.locator('[data-terminal-key="ctrl"]')).toHaveAttribute("aria-pressed", "false");
			const written = (await calls(page, "terminal:request"))
				.map(args => args[1])
				.filter(operation => operation.action === "write")
				.map(operation => operation.data);
			expect(written).toEqual(["\u001b", "\u001b[1;5A"]);
			// The reads are long polls with an output budget, not the desktop's 80 ms poll.
			const reads = (await calls(page, "terminal:request"))
				.map(args => args[1])
				.filter(operation => operation.action === "list" && operation.waitMs);
			expect(reads.length).toBeGreaterThan(0);
			expect(reads[0].budget).toBe(65_536);
			await page.context().close();
		});

		test("the text size steps from 50 to 200 percent and the key bar hides on request", async () => {
			const page = await openHarness(browser, device.name, LIGHT_EN);
			const sheet = await showTerminal(page, device.phone);
			const reset = sheet.locator('[data-terminal-font="reset"]');
			await expect(reset).toHaveText("100%");
			await sheet.locator('[data-terminal-font="larger"]').click();
			await expect(reset).toHaveText("110%");
			// 110 → 50 in six steps; the last one disables the button.
			for (let step = 0; step < 6; step++) await sheet.locator('[data-terminal-font="smaller"]').click();
			await expect(reset).toHaveText("50%");
			await expect(sheet.locator('[data-terminal-font="smaller"]')).toBeDisabled();
			for (let step = 0; step < 15; step++) await sheet.locator('[data-terminal-font="larger"]').click();
			await expect(reset).toHaveText("200%");
			await expect(sheet.locator('[data-terminal-font="larger"]')).toBeDisabled();
			await reset.click();
			await expect(reset).toHaveText("100%");
			await sheet.locator("[data-terminal-keys-toggle]").click();
			await expect(sheet.locator("[data-terminal-keybar]")).toHaveCount(0);
			await page.context().close();
		});

		test("when another device sizes the terminal a banner says so and fitting it here takes the size back", async () => {
			const page = await openHarness(browser, device.name, LIGHT_EN);
			const sheet = await showTerminal(page, device.phone);
			await expect(sheet.locator("[data-terminal-lease]")).toHaveCount(0);
			await page.evaluate(() => {
				if (window.__harness) window.__harness.terminal.lease = "other";
			});
			const banner = sheet.locator("[data-terminal-lease]");
			await expect(banner).toContainText("Another device is setting the size", { timeout: 10_000 });
			await capture(page, "lease", `${engine.name}-${device.name.replace(/ /g, "-")}-light-en`);
			await banner.locator("[data-terminal-lease-claim]").click();
			await expect(banner).toHaveCount(0);
			const claims = (await calls(page, "terminal:request"))
				.map(args => args[1])
				.filter(operation => operation.action === "claim");
			expect(claims).toEqual([{ action: "claim", id: "term-1" }]);
			await page.context().close();
		});

		test("changes are a list first, then one file's unified diff with a way back", async () => {
			const page = await openHarness(browser, device.name, LIGHT_EN);
			const sheet = await openView(page, device.phone, "diff");
			const changes = sheet.locator(".omp-changes");
			const row = changes.locator('button[title$="wait-for.ts"]');
			await expect(row).toBeVisible({ timeout: 15_000 });
			await expect(changes.locator(".omp-changes-body")).toHaveAttribute("data-open", "false");
			const testFile = changes.locator('button[title$="Sidebar.test.tsx"]');
			await testFile.click();
			// On a phone and a portrait tablet the list gives way to the diff; nothing splits into columns.
			await expect(changes.locator(".omp-changes-body")).toHaveAttribute("data-open", "true");
			await expect(changes.locator(".omp-changes-list")).toBeHidden();
			await expect(changes.locator(".omp-changes-preview")).toContainText("waitFor(() => expect(rowFor", {
				timeout: 10_000,
			});
			await capture(page, "diff", `${engine.name}-${device.name.replace(/ /g, "-")}-light-en`);
			await changes.getByRole("button", { name: "Back to changed files" }).click();
			await expect(changes.locator(".omp-changes-body")).toHaveAttribute("data-open", "false");
			await expect(row).toBeVisible();
			await page.context().close();
		});

		test("the Changes panel polls git only while it is on screen", async () => {
			const page = await openHarness(browser, device.name, LIGHT_EN);
			const fingerprints = () =>
				page.evaluate(
					() =>
						(window.__harness?.calls ?? []).filter(
							call =>
								call.channel === "rpc:command-for-tab" &&
								JSON.stringify(call.args).includes("get_git_fingerprint"),
						).length,
				);
			expect(await fingerprints()).toBe(0);
			await openView(page, device.phone, "diff");
			await expect.poll(fingerprints, { timeout: 15_000 }).toBeGreaterThan(0);
			// Closed, the panel is gone with its timer: the count stops moving.
			await page.keyboard.press("Escape");
			await expect(page.locator("[data-sheet-panel]")).toHaveCount(0);
			const settled = await fingerprints();
			await page.waitForTimeout(3600);
			expect(await fingerprints()).toBe(settled);
			await page.context().close();
		});

		test("files are a tree first, then one file in a viewer that is read-only until Edit", async () => {
			const page = await openHarness(browser, device.name, LIGHT_EN);
			const sheet = await openView(page, device.phone, "files");
			const tree = sheet.locator(".omp-files-tree");
			await expect(tree.getByRole("treeitem", { name: /README\.md/ })).toBeVisible({ timeout: 15_000 });
			await tree.getByRole("treeitem", { name: /README\.md/ }).click();
			await expect(sheet.locator("[data-file-preview-title]")).toContainText("README.md", { timeout: 10_000 });
			await expect(tree).toHaveCount(0);
			await expect(sheet.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
			await expect(sheet.locator(".cm-content[contenteditable='true']")).toHaveCount(0);
			await capture(page, "file", `${engine.name}-${device.name.replace(/ /g, "-")}-light-en`);
			await sheet.getByRole("button", { name: "Back to files" }).click();
			await expect(tree).toBeVisible();
			await page.context().close();
		});

		for (const theme of ["light", "dark"] as const) {
			for (const lang of ["en", "ko"] as const) {
				test(`captures: ${theme} ${lang}`, async () => {
					test.skip(!captures, "OMP_GUI_MOBILE_PANELS=<dir> writes the captures");
					const page = await openHarness(browser, device.name, { theme, lang });
					const tag = `${engine.name}-${device.name.replace(/ /g, "-")}-${theme}-${lang}`;
					await showPreview(page, device.phone, lang);
					await capture(page, "preview", tag);
					await showTerminal(page, device.phone, lang);
					await capture(page, "terminal", tag);
					await openView(page, device.phone, "diff", lang);
					await page.locator('.omp-changes button[title$="Sidebar.tsx"]').click();
					await capture(page, "changes", tag);
					await openView(page, device.phone, "files", lang);
					await capture(page, "files", tag);
					await page.context().close();
				});
			}
		}
	});
}
