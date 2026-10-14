import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron, type Page } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

let app: ElectronApplication;
let page: Page;
let profile: string;
let record: string;
const errors: string[] = [];

async function command(text: string) {
	const composer = page.locator("textarea").first();
	await composer.fill(text);
	await page.getByRole("button", { name: "Send", exact: true }).click();
}
async function recorded(type: string) {
	const text = await fs.readFile(record, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line))
		.filter(command => command.type === type);
}

/**
 * Live processes under the app's main process: renderers, helpers and every
 * tab's sidecar (an exited child is reaped, so zombies are not counted).
 */
function descendants(root: number): number {
	const children = new Map<number, number[]>();
	for (const line of execFileSync("ps", ["-A", "-o", "pid=,ppid=,stat="], { encoding: "utf8" }).split("\n")) {
		const [pid, ppid, stat] = line.trim().split(/\s+/);
		if (!pid || stat?.startsWith("Z")) continue;
		children.set(Number(ppid), [...(children.get(Number(ppid)) ?? []), Number(pid)]);
	}
	let count = 0;
	const queue = [root];
	for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
		for (const child of children.get(next) ?? []) {
			count++;
			queue.push(child);
		}
	}
	return count;
}

test.beforeAll(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-audit-"));
	const project = path.join(profile, "project");
	const userData = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(userData), fs.mkdir(agent)]);
	record = path.join(profile, "rpc.jsonl");
	await fs.writeFile(path.join(userData, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const fixture = await fixtureOmp(profile);
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: fixture,
		OMP_GUI_TEST_RECORD: record,
		OMP_GUI_TEST_STATS_BINARY: "omp",
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${userData}`],
		env,
	});
	page = await app.firstWindow();
	page.on("pageerror", error => errors.push(error.message));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
	await page.screenshot({ path: "test-results/desktop-start.png", scale: "css", animations: "disabled" });
});

test.afterAll(async () => {
	if (app) await exitApp(app);
	if (record) await fs.copyFile(record, "test-results/desktop-rpc.jsonl").catch(() => {});
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("initially closed modal receives focus and Escape closes it", async () => {
	// /jobs is a side-panel tab now; /tools is still a modal dialog.
	await command("/tools");
	const modal = page.getByRole("dialog");
	await expect(modal).toBeVisible();
	await expect.poll(() => modal.evaluate(node => node.contains(document.activeElement))).toBe(true);
	await page.keyboard.press("Escape");
	await expect(modal).toHaveCount(0);
});

test("composer recalls shared history and restores its draft", async () => {
	await command("shared history recall regression");
	await expect
		.poll(async () => {
			const response = await page.evaluate(() => window.omp.rpc.historyRecent(1));
			return response.data;
		})
		.toMatchObject([{ prompt: "shared history recall regression" }]);
	await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
	const composer = page.locator("textarea").first();
	await composer.fill("unfinished draft");
	// ↑ inside a draft moves the caret; only from the very start does it reach history.
	await composer.press("ArrowUp");
	await expect(composer).toHaveValue("unfinished draft");
	await composer.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 0));
	await composer.press("ArrowUp");
	await expect(composer).toHaveValue("shared history recall regression");
	// The recall leaves the caret at position 0, so ↓ there is the caret's; from the end it walks back.
	expect(await composer.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(0);
	await composer.press("ArrowDown");
	await expect(composer).toHaveValue("shared history recall regression");
	await composer.evaluate((element: HTMLTextAreaElement) =>
		element.setSelectionRange(element.value.length, element.value.length),
	);
	await composer.press("ArrowDown");
	await expect(composer).toHaveValue("unfinished draft");
	await composer.fill("");
});

test("stock session identity, cycling in both directions, and /copy stay usable", async () => {
	const identity = await page.evaluate(async () => {
		const before = await window.omp.rpc.getState();
		const forward = await window.omp.rpc.command({ type: "cycle_model", direction: "forward" });
		const backward = await window.omp.rpc.command({ type: "cycle_model", direction: "backward" });
		const after = await window.omp.rpc.getState();
		return { before, forward, backward, after };
	});
	expect(identity.before.success).toBe(true);
	expect(identity.before.data).toMatchObject({ sessionId: expect.stringMatching(/^fixture-/) });
	expect(identity.forward).toMatchObject({ success: true, data: { model: { id: "local-fixture-alt" } } });
	expect(identity.backward).toMatchObject({ success: true, data: { model: { id: "local-fixture" } } });
	const beforeState = identity.before.data;
	if (!beforeState || typeof beforeState !== "object" || !("sessionId" in beforeState)) {
		throw new Error("Stock get_state omitted session identity");
	}
	expect(identity.after.data).toMatchObject({ sessionId: beforeState.sessionId });
	await command("/copy");
	const modal = page.getByRole("dialog");
	await expect(modal.getByRole("button", { name: "Fixture copy target", exact: true })).toBeVisible();
	await modal.getByRole("button", { name: "Copy", exact: true }).click();
	await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe("Fixture copy target");
	await expect(modal).toHaveCount(0);
	expect(await recorded("composer.copy_targets")).toHaveLength(1);
});

test("opening sharing performs local preview only, upload needs a button click", async () => {
	await command("/share");
	const modal = page.getByRole("dialog");
	await expect(modal.getByRole("button", { name: "Upload and create link" })).toBeVisible();
	expect(await recorded("composer.share")).toHaveLength(0);
	await modal.getByRole("button", { name: "Upload and create link" }).click();
	await expect(modal).toContainText("http://127.0.0.1/shared#local");
	expect(await recorded("composer.share")).toHaveLength(1);
	await page.keyboard.press("Escape");
});

test("a running task keeps both send and stop reachable", async () => {
	await command("fixture running");
	await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
	const composer = page.locator("textarea").first();
	await composer.fill("queued instruction");
	await page.getByRole("button", { name: "Send", exact: true }).click();
	await expect.poll(async () => (await recorded("steer")).length + (await recorded("follow_up")).length).toBe(1);
	await page.getByRole("button", { name: "Stop", exact: true }).click();
	// Stop is the TUI's Esc: the queued input comes back into the composer instead of running later.
	await expect(composer).toHaveValue("queued instruction");
	expect(await recorded("abort_and_restore_queue")).toHaveLength(1);
	await composer.fill("");
	// The run ends only once agent_end lands (after main stamps its entry ids); until
	// then a send is a steer, so the next test must start from an idle session.
	await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
});

test("long approval remains complete and Enter is neutral", async () => {
	await command("fixture approval");
	const modal = page.locator("[data-prompt-card]");
	await expect(modal.locator("pre")).toContainText("critical final argument");
	await expect.poll(() => page.evaluate(() => document.activeElement?.textContent)).not.toBe("Approve");
	await page.keyboard.press("Escape");
	await expect(modal).toHaveCount(0);
	// The answer ends the fixture's turn; until agent_end lands a send is a steer,
	// so the next test must start from an idle session.
	await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
	expect(errors).toEqual([]);
});

test("ask walks one question at a time with numbered keys and submits every answer", async () => {
	await command("fixture ask");
	const card = page.getByRole("region", { name: "Question" });
	await expect(card).toContainText("Where should this deploy?");
	await expect(card).not.toContainText("Which checks should run first?");
	await expect(card).toContainText("1 of 3");
	await page.screenshot({ path: "test-results/ask-step-1.png", scale: "css", animations: "disabled" });
	// "2" picks Production and moves on.
	await page.keyboard.press("2");
	await expect(card).toContainText("Which checks should run first?");
	await expect(card).toContainText("2 of 3");
	// Multi-select stays put: pick two, then Next.
	await page.keyboard.press("1");
	await page.keyboard.press("3");
	await card.getByRole("button", { name: "Next", exact: true }).click();
	await expect(card).toContainText("Tell the team when it lands?");
	await page.screenshot({ path: "test-results/ask-step-3.png", scale: "css", animations: "disabled" });
	await page.keyboard.press("1");
	await card.getByRole("button", { name: "Submit", exact: true }).click();
	await expect(card).toHaveCount(0);
	await expect
		.poll(async () => (await recorded("extension_ui_response")).filter(entry => entry.id === "fixture-ask"))
		.toEqual([
			expect.objectContaining({
				type: "extension_ui_response",
				id: "fixture-ask",
				answers: [
					{ id: "env", selectedOptions: ["Production"] },
					{ id: "checks", selectedOptions: ["Unit tests", "Lint"] },
					{ id: "notify", selectedOptions: ["Yes"] },
				],
			}),
		]);
	expect(errors).toEqual([]);
});

test("Check for Updates… from the app menu reports in the sidebar without opening Settings", async () => {
	await app.evaluate(({ Menu }) => {
		const item = Menu.getApplicationMenu()
			?.items.flatMap(top => top.submenu?.items ?? [])
			.find(entry => entry.label === "Check for Updates…");
		if (!item) throw new Error("Check for Updates… is missing from the app menu");
		item.click();
	});
	const card = page.locator("[data-sidebar-update]");
	await expect(card).toBeVisible();
	await expect(page.locator("[data-settings-page]")).toHaveCount(0);
	// The outcome depends on the runner's GitHub access; it settles past "checking" either way.
	await expect(card).not.toHaveAttribute("data-update-tone", "busy", { timeout: 30_000 });
	await card.getByRole("button", { name: /Close|Later/ }).click();
	await expect(card).toHaveCount(0);
});

test("settings page lists its sections, searches across languages, and Escape returns to the session", async () => {
	await page.keyboard.press("ControlOrMeta+Comma");
	const settings = page.locator("[data-settings-page]");
	await expect(settings).toBeVisible();
	await expect(settings.locator("[data-settings-section]")).toHaveCount(11);
	await settings.locator('[data-settings-section="appearance"]').click();
	await expect(settings.getByRole("radiogroup", { name: "Theme" })).toBeVisible();
	await page.screenshot({ path: "test-results/01-settings.png", scale: "css", animations: "disabled" });
	const search = settings.getByRole("searchbox", { name: "Search settings" });
	await search.fill("압축");
	await expect(settings.locator('[data-search-path="compaction.enabled"]')).toHaveCount(1);
	await search.fill("paste.largeMenuThreshold");
	await expect(settings.locator("[data-settings-search-results]")).toContainText("paste");
	await search.fill("");
	await page.keyboard.press("Escape");
	await expect(settings).toHaveCount(0);
});

test("voice and side question require an explicit start", async () => {
	const voiceBefore = (await recorded("live_start")).length;
	await command("/live");
	let modal = page.getByRole("dialog");
	await expect(modal).toBeVisible();
	expect(await recorded("live_start")).toHaveLength(voiceBefore);
	await page.screenshot({ path: "test-results/02-voice.png", scale: "css", animations: "disabled" });
	await page.keyboard.press("Escape");
	const before = (await recorded("btw")).length;
	await command("/btw explain the current approach");
	modal = page.getByRole("dialog");
	await expect(modal).toBeVisible();
	expect(await recorded("btw")).toHaveLength(before);
	await page.keyboard.press("Escape");
});

test("Escape cancels a settings edit without saving its abandoned value", async () => {
	await page.keyboard.press("ControlOrMeta+Comma");
	const settings = page.locator("[data-settings-page]");
	await settings.getByRole("searchbox", { name: "Search settings" }).fill("compaction.reserveTokens");
	await settings.getByRole("button", { name: "Reserve tokens", exact: true }).click();
	const input = settings.locator('[id="setting-compaction.reserveTokens"] input[type="number"]');
	await expect(input).toHaveValue("8192");
	const before = (await recorded("settings_set")).length;
	await input.fill("12345");
	await input.press("Escape");
	// The first Escape discards the edit; the page stays open.
	await expect(input).toHaveValue("8192");
	await expect(settings).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(settings).toHaveCount(0);
	expect((await recorded("settings_set")).length).toBe(before);
	const response = await page.evaluate(() => window.omp.rpc.getSettings(["compaction.reserveTokens"]));
	expect(response.data).toMatchObject({ values: { "compaction.reserveTokens": 8192 } });
});

test("math survives history reload and scrolls inside its column in both themes", async () => {
	await command("fixture math");
	const markdown = page.locator(".markdown-body").filter({ has: page.locator(".katex-display") });
	await expect(markdown.locator(".katex-display")).toHaveCount(4);
	await expect(markdown).toContainText("只有统计口径相同时");
	await page.reload();
	await expect(markdown.locator(".katex-display")).toHaveCount(4);
	await expect(markdown.locator(".katex-html").filter({ hasText: "显存有效带宽" })).toHaveCount(1);
	await expect(markdown.locator("h1, h2, .katex-error")).toHaveCount(0);
	const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
	for (const theme of ["Graphite", "Porcelain"]) {
		await command("/theme");
		const picker = page.getByRole("dialog");
		await picker.getByPlaceholder("Search themes…").fill(theme);
		await picker.locator("button[aria-pressed]").filter({ hasText: theme }).click();
		await expect(picker).toHaveCount(0);
		await page.setViewportSize({ width: 900, height: 1050 });
		await markdown.scrollIntoViewIfNeeded();
		await page.evaluate(() => document.fonts.ready);
		expect(await page.evaluate(() => document.fonts.check("16px KaTeX_Main"))).toBe(true);
		const layout = await markdown.evaluate(element => {
			const displays = Array.from(element.querySelectorAll<HTMLElement>(".katex-display"));
			return {
				columnFits: element.scrollWidth <= element.clientWidth + 1,
				formulasFit: displays.every(node => node.getBoundingClientRect().width <= element.clientWidth + 1),
				canScroll: displays.some(node => node.scrollWidth > node.clientWidth),
				startsVisible: displays.every(node => {
					const formula = node.querySelector(".katex-html");
					return formula && formula.getBoundingClientRect().left >= node.getBoundingClientRect().left - 1;
				}),
			};
		});
		expect(layout).toEqual({ columnFits: true, formulasFit: true, canScroll: true, startsVisible: true });
		expect(
			await markdown
				.locator(".katex-display")
				.last()
				.evaluate(node => {
					node.scrollLeft = node.scrollWidth;
					const moved = node.scrollLeft > 0;
					node.scrollLeft = 0;
					return moved;
				}),
		).toBe(true);
		await page.screenshot({ path: `test-results/math-${theme}.png`, scale: "css", animations: "disabled" });
	}
	await page.setViewportSize(viewport);
	expect(errors).toEqual([]);
});

test("all named themes apply with readable primary text and no stale scheme tokens", async () => {
	test.setTimeout(90_000);
	const labels = [
		"Graphite",
		"Slate",
		"Deep sea",
		"Espresso",
		"Ember",
		"Porcelain",
		"Ivory",
		"Sand",
		"Rose quartz",
		"Glacier",
		"Sage",
	];
	const colors: Record<string, string> = {};
	const contrastValues: Record<string, { body: number; send: number }> = {};
	for (const label of labels) {
		await command("/theme");
		const picker = page.getByRole("dialog");
		await picker.getByPlaceholder("Search themes…").fill(label);
		const option = picker.locator("button[aria-pressed]").filter({ hasText: new RegExp(label, "i") });
		await option.click();
		await expect(picker).toHaveCount(0);
		colors[label] = await page.evaluate(() =>
			getComputedStyle(document.documentElement).getPropertyValue("--omp-bg-primary"),
		);
		await page.locator("textarea").first().fill("Theme contrast sample");
		const send = page.getByRole("button", { name: "Send", exact: true });
		await expect(send).toBeEnabled();
		await send.click({ trial: true, timeout: 1000 });
		await send.evaluate(async button => {
			await Promise.all(button.getAnimations().map(animation => animation.finished.catch(() => {})));
		});
		contrastValues[label] = await send.evaluate(button => {
			const luminance = (color: string) => {
				const match = color.match(/^rgb\(([\d.]+), ([\d.]+), ([\d.]+)\)$/);
				if (!match) throw new Error(`Expected an opaque computed RGB color, received ${color}`);
				const [r, g, b] = match.slice(1).map(value => {
					const channel = Number(value) / 255;
					return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
				});
				return 0.2126 * r + 0.7152 * g + 0.0722 * b;
			};
			const ratio = (element: Element) => {
				const style = getComputedStyle(element);
				const light = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => a - b);
				return (light[1] + 0.05) / (light[0] + 0.05);
			};
			return { body: ratio(document.body), send: ratio(button) };
		});
		expect(contrastValues[label].body, `${label} body text`).toBeGreaterThanOrEqual(4.5);
		expect(contrastValues[label].send, `${label} send icon`).toBeGreaterThanOrEqual(4.5);
		await page.screenshot({
			path: `test-results/theme-${label.replaceAll(" ", "-")}.png`,
			scale: "css",
			animations: "disabled",
		});
	}
	expect(new Set(Object.values(colors)).size).toBeGreaterThan(8);
	await fs.writeFile("test-results/theme-values.json", JSON.stringify(colors, null, 2));
	await fs.writeFile("test-results/theme-contrast.json", JSON.stringify(contrastValues, null, 2));
});

test("uncertain delivery preserves the draft and blocks duplicate sending until reviewed", async () => {
	const before = (await recorded("prompt")).length;
	await command("fixture uncertain");
	const input = page.locator("textarea").first();
	await expect(input).toHaveValue("fixture uncertain");
	await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
	await input.press("Enter");
	expect(await recorded("prompt")).toHaveLength(before + 1);
	await page.getByRole("button", { name: "I checked; allow sending", exact: true }).click();
	await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
	await input.fill("");
});

test("security distinguishes unavailable, disabled, unscanned, running, failed and completed scans", async () => {
	test.setTimeout(90_000);
	const states = {
		disabled: "Security is off",
		unscanned: "This project has not been scanned",
		unavailable: "Scan status unavailable",
		running: "Scan in progress",
		failed: "The selected scan failed",
		incomplete: "The selected scan did not complete",
		clear: "No findings in this scan",
		findings: "Untrusted path reaches file access",
	};
	for (const [state, expected] of Object.entries(states)) {
		await page.evaluate(value => window.omp.rpc.bash(`fixture:security:${value}`), state);
		await page.keyboard.press("ControlOrMeta+Comma");
		const settings = page.locator("[data-settings-page]");
		await settings.locator('[data-settings-section="permissions"]').click();
		await expect(settings).toContainText(expected);
		if (state !== "clear") await expect(settings).not.toContainText("No findings in this scan");
		await page.screenshot({ path: `test-results/security-${state}.png`, scale: "css", animations: "disabled" });
		await page.keyboard.press("Escape");
		await expect(settings).toHaveCount(0);
	}
});

test("repeated modal and task lifecycles release sidecars and document listeners", async () => {
	test.setTimeout(120_000);
	await page.emulateMedia({ reducedMotion: "reduce" });
	const cdp = await page.context().newCDPSession(page);
	const listeners = async () => {
		const { result } = await cdp.send("Runtime.evaluate", { expression: "document" });
		return (await cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId! })).listeners.length;
	};
	const pid = app.process().pid;
	const checkProcesses = pid !== undefined && process.platform !== "win32";
	const processes = () => (checkProcesses ? descendants(pid) : 0);
	const cycle = async (whileOpen?: () => Promise<void>) => {
		await command("/tools");
		await expect(page.getByRole("dialog")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await page.keyboard.press("ControlOrMeta+t");
		await expect.poll(() => page.evaluate(() => window.omp.tabs.list())).toHaveLength(2);
		await expect.poll(async () => (await page.evaluate(() => window.omp.tabs.list())).at(-1)?.status).toBe("ready");
		await whileOpen?.();
		await page.keyboard.press("ControlOrMeta+w");
		await expect.poll(() => page.evaluate(() => window.omp.tabs.list())).toHaveLength(1);
	};
	// Both checks are exact, so one leaked listener or sidecar per cycle fails at any
	// count; 20 cycles still pass Node's 10-listener warning twice. The open tab's
	// sidecar must show up in the process count, or the count would guard nothing.
	const cycles = 20;
	const before = await listeners();
	const processesBefore = processes();
	await cycle(async () => {
		if (checkProcesses) expect(processes()).toBeGreaterThan(processesBefore);
	});
	for (let index = 1; index < cycles; index++) await cycle();
	const after = await listeners();
	expect(after).toBeLessThanOrEqual(before);
	expect(await page.evaluate(() => window.omp.tabs.list())).toHaveLength(1);
	// A closed tab's sidecar exits once its stdin closes; wait for that, never for a fixed time.
	await expect.poll(processes).toBeLessThanOrEqual(processesBefore);
	await fs.writeFile(
		"test-results/lifecycle.json",
		JSON.stringify(
			{
				modalCycles: cycles,
				taskCycles: cycles,
				documentListenersBefore: before,
				documentListenersAfter: after,
				tabsAfter: 1,
				processesBefore,
			},
			null,
			2,
		),
	);
	await cdp.detach();
	expect(errors).toEqual([]);
});

test("narrow windows and 200 percent zoom keep settings and primary actions reachable", async () => {
	test.setTimeout(90_000);
	for (const [width, height, zoom] of [
		[1280, 800, 1],
		[1000, 700, 1],
		[1280, 900, 2],
		// Minimum window size at 200% zoom: 400×300 CSS px.
		[800, 600, 2],
	]) {
		await app.evaluate(
			({ BrowserWindow, screen }, dimensions) => {
				const win = BrowserWindow.getAllWindows()[0];
				// CI displays are ~1024×720: a window larger than the work area renders
				// into a viewport the OS clips, so keep it on screen (and in place).
				const { workArea } = screen.getPrimaryDisplay();
				win.setBounds({
					x: workArea.x,
					y: workArea.y,
					width: Math.min(dimensions.width, workArea.width),
					height: Math.min(dimensions.height, workArea.height),
				});
				win.webContents.setZoomFactor(dimensions.zoom);
			},
			{ width, height, zoom },
		);
		await page.keyboard.press("ControlOrMeta+Comma");
		const settings = page.locator("[data-settings-page]");
		await settings.locator('[data-settings-section="appearance"]').click();
		const toggle = settings.locator("#setting-gui-compactDensity").getByRole("switch");
		await toggle.scrollIntoViewIfNeeded();
		await toggle.click();
		const captured = await app.evaluate(async ({ BrowserWindow }) =>
			(await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString("base64"),
		);
		await fs.writeFile(`test-results/layout-${width}-${zoom}.png`, Buffer.from(captured, "base64"));
		await page.keyboard.press("Escape");
		await expect(settings).toHaveCount(0);
		const input = page.locator("textarea").first();
		await input.fill("layout draft");
		await expect(input).toBeEditable();
		const send = page.getByRole("button", { name: "Send", exact: true });
		// Window/screen geometry in the failure message: a CI display can clamp the requested size.
		const geometry = await app.evaluate(({ BrowserWindow, screen }) => {
			const win = BrowserWindow.getAllWindows()[0];
			return JSON.stringify({
				bounds: win.getBounds(),
				content: win.getContentBounds(),
				workArea: screen.getPrimaryDisplay().workArea,
			});
		});
		const viewport = await send.evaluate(node =>
			JSON.stringify({ inner: [innerWidth, innerHeight], send: node.getBoundingClientRect() }),
		);
		await expect(send, `${geometry} ${viewport}`).toBeInViewport();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		await input.fill("");
	}
	await app.evaluate(({ BrowserWindow }) => {
		const win = BrowserWindow.getAllWindows()[0];
		win.webContents.setZoomFactor(1);
		win.setSize(1400, 900);
	});
});

test("model benchmark, tools and debug open without external mutations", async () => {
	for (const name of ["benchmark", "tools", "debug", "import"]) {
		await command(`/${name}`);
		const modal = page.getByRole("dialog");
		await expect(modal).toBeVisible();
		await expect.poll(() => modal.evaluate(node => node.contains(document.activeElement))).toBe(true);
		await page.screenshot({ path: `test-results/03-${name}.png`, scale: "css", animations: "disabled" });
		await page.keyboard.press("Escape");
		await expect(modal).toHaveCount(0);
	}
	expect(errors).toEqual([]);
});

test("settings search opens advanced controls and old refreshes cannot undo a saved edit", async () => {
	await page.keyboard.press("ControlOrMeta+Comma");
	const settings = page.locator("[data-settings-page]");
	const search = settings.getByRole("searchbox", { name: "Search settings" });
	await search.fill("proxyUrl");
	await settings.getByRole("button", { name: /^HTTP proxy/ }).click();
	await expect(page.locator("#setting-gui-proxy input")).toBeEditable();
	await search.fill("launchProfiles");
	await settings.getByRole("button", { name: /^Launch profile/ }).click();
	await expect(settings.getByPlaceholder("Leave empty to use the default system prompt")).toBeEditable();
	await search.fill("compaction.reserveTokens");
	await settings.getByRole("button", { name: "Reserve tokens", exact: true }).click();
	const input = settings.locator('[id="setting-compaction.reserveTokens"] input[type="number"]');
	await expect(input).toHaveValue("8192");
	await page.evaluate(() => window.omp.rpc.prompt("fixture hold settings"));
	const before = (await recorded("settings_get")).length;
	// Main forwards every tab-scoped event wrapped in the tab's envelope, so the
	// simulated config_update has to wear the same wire shape.
	const activeTabId = await page.evaluate(() =>
		window.omp.tabs.list().then(tabs => tabs.find(tab => tab.active === true)?.tabId ?? ""),
	);
	expect(activeTabId).toBeTruthy();
	await app.evaluate(
		({ BrowserWindow }, tabId) =>
			BrowserWindow.getAllWindows()[0].webContents.send("config:update", { tabId, payload: {} }),
		activeTabId,
	);
	await expect.poll(async () => (await recorded("settings_get")).length).toBeGreaterThan(before);
	await input.fill("12345");
	await input.press("Enter");
	await expect
		.poll(async () => await page.evaluate(() => window.omp.rpc.getSettings(["compaction.reserveTokens"])))
		.toMatchObject({ success: true, data: { values: { "compaction.reserveTokens": 12345 } } });
	await page.evaluate(() => window.omp.rpc.prompt("fixture release settings"));
	await page.evaluate(() => window.omp.rpc.getState());
	await expect(input).toHaveValue("12345");
	await input.fill("8192");
	await input.press("Enter");
	await page.keyboard.press("Escape");
});

test("a failing ipc handler cannot take the other handlers on its channel down with it", async () => {
	// One subscriber throwing during an emit used to abort the rest, so an
	// unrelated feature (a settings refresh, a transcript batch) silently stopped
	// receiving its own events.
	type Boom = { hits: number; stop?: () => void };
	const scratch = () => page.evaluate(() => (globalThis as unknown as { __boom?: Boom }).__boom);
	await page.evaluate(() => {
		const boom: Boom = { hits: 0 };
		(globalThis as unknown as { __boom: Boom }).__boom = boom;
		const throwing = window.omp.events.onConfigUpdate(() => {
			throw new Error("simulated handler failure");
		});
		const counting = window.omp.events.onConfigUpdate(() => {
			boom.hits += 1;
		});
		boom.stop = () => {
			throwing();
			counting();
		};
	});
	const activeTabId = await page.evaluate(() =>
		window.omp.tabs.list().then(tabs => tabs.find(tab => tab.active === true)?.tabId ?? ""),
	);
	expect(activeTabId).toBeTruthy();
	await app.evaluate(
		({ BrowserWindow }, tabId) =>
			BrowserWindow.getAllWindows()[0].webContents.send("config:update", { tabId, payload: {} }),
		activeTabId,
	);
	await expect.poll(async () => (await scratch())?.hits).toBe(1);
	await page.evaluate(() => (globalThis as unknown as { __boom?: Boom }).__boom?.stop?.());
});

test("workspace navigation cannot replace the trusted desktop with an untrusted document", async () => {
	const documentPath = path.join(profile, "untrusted.html");
	await fs.writeFile(documentPath, "<!doctype html><title>Untrusted document</title><h1>Untrusted document</h1>");
	const trustedUrl = page.url();
	await app.evaluate(({ BrowserWindow }) => {
		BrowserWindow.getAllWindows()[0].webContents.once("will-navigate", event => {
			Reflect.set(globalThis, "auditNavigationPrevented", event.defaultPrevented);
		});
	});
	await page.evaluate(url => {
		const link = document.createElement("a");
		link.href = url;
		link.textContent = "Untrusted document";
		document.body.append(link);
		link.click();
		link.remove();
	}, pathToFileURL(documentPath).href);
	await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "auditNavigationPrevented"))).toBe(true);
	// Read the live document directly: Playwright's locator waits for a native
	// navigation which Electron has already cancelled outside the browser stack.
	expect(await page.evaluate(() => document.querySelector("textarea")?.disabled)).toBe(false);
	expect(page.url()).toBe(trustedUrl);
	await page.reload();
	await expect(page.locator("textarea").first()).toBeEditable();
});

test("launch profile updates preserve concurrent fields and workspaces through the real preferences store", async () => {
	const result = await page.evaluate(async () => {
		const status = await window.omp.sidecar.getStatus();
		const cwd = status.cwd;
		const other = `${cwd}/other.workspace`;
		await Promise.all([
			window.omp.prefs.updateLaunchProfile(cwd, { noRules: true }),
			window.omp.prefs.updateLaunchProfile(cwd, { noLsp: true }),
			window.omp.prefs.updateLaunchProfile(other, { profile: " isolated " }),
		]);
		const saved = (await window.omp.prefs.get("launchProfiles")) as Record<string, unknown>;
		await window.omp.prefs.updateLaunchProfile(cwd, { noRules: false, noLsp: false });
		const cleared = (await window.omp.prefs.get("launchProfiles")) as Record<string, unknown>;
		return { saved: saved[cwd], other: saved[other], cleared: cleared[cwd], preserved: cleared[other] };
	});
	expect(result).toEqual({
		saved: { noRules: true, noLsp: true },
		other: { profile: "isolated" },
		cleared: undefined,
		preserved: { profile: "isolated" },
	});
});

test("failed preference writes retain edits and never allow a premature restart", async () => {
	await app.evaluate(({ ipcMain }) => {
		const pending = Promise.withResolvers<void>();
		Reflect.set(globalThis, "auditProxySave", pending);
		const launch = Promise.withResolvers<void>();
		Reflect.set(globalThis, "auditLaunchSave", launch);
		Reflect.set(globalThis, "auditRestarts", []);
		ipcMain.removeHandler("prefs:set");
		ipcMain.handle("prefs:set", async (_event, payload: { key: string }) => {
			if (payload.key === "codeLineNumbers" || payload.key === "themeName")
				throw new Error("audit appearance write refused");
			if (payload.key === "proxyUrl") {
				Reflect.set(globalThis, "auditProxyRequested", true);
				await pending.promise;
				throw new Error("audit disk write refused");
			}
		});
		ipcMain.removeHandler("prefs:update-launch-profile");
		ipcMain.handle("prefs:update-launch-profile", async () => {
			Reflect.set(globalThis, "auditLaunchRequested", true);
			await launch.promise;
			throw new Error("audit launch write refused");
		});
		ipcMain.removeHandler("sidecar:restart");
		ipcMain.handle("sidecar:restart", (_event, payload) => {
			Reflect.get(globalThis, "auditRestarts").push(payload);
		});
	});
	await page.keyboard.press("ControlOrMeta+Comma");
	const settings = page.locator("[data-settings-page]");
	await settings.locator('[data-settings-section="general"]').click();
	const proxy = page.locator("#setting-gui-proxy input");
	await proxy.fill("http://127.0.0.1:7899");
	await proxy.press("Enter");
	await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "auditProxyRequested"))).toBe(true);
	await page.evaluate(() => window.omp.prefs.get("proxyUrl"));
	expect(await app.evaluate(() => Reflect.get(globalThis, "auditRestarts"))).toEqual([]);
	await app.evaluate(() => Reflect.get(globalThis, "auditProxySave").resolve());
	await expect(page.getByRole("alert")).toContainText("audit disk write refused");
	await expect(proxy).toHaveValue("http://127.0.0.1:7899");
	expect(await app.evaluate(() => Reflect.get(globalThis, "auditRestarts"))).toEqual([]);
	await settings.locator('[data-settings-section="workspace"]').click();
	const prompt = settings.getByPlaceholder("Leave empty to use the default system prompt");
	await prompt.fill("Preserve this unsaved instruction.");
	await prompt.press("Tab");
	await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "auditLaunchRequested"))).toBe(true);
	const restart = settings.getByRole("button", { name: "Restart now", exact: true });
	await expect(restart).toBeDisabled();
	await app.evaluate(() => Reflect.get(globalThis, "auditLaunchSave").resolve());
	await expect(page.getByRole("alert").filter({ hasText: "audit launch write refused" })).toBeVisible();
	await expect(prompt).toHaveValue("Preserve this unsaved instruction.");
	await expect(prompt).toBeEditable();
	await expect(restart).toBeDisabled();
	expect(await app.evaluate(() => Reflect.get(globalThis, "auditRestarts"))).toEqual([]);
	await settings.getByRole("searchbox", { name: "Search settings" }).fill("codeLineNumbers");
	await settings.getByRole("button", { name: /^Line numbers/ }).click();
	const lineNumbers = page.locator('#setting-gui-lineNumbers [role="switch"]');
	const checked = await lineNumbers.getAttribute("aria-checked");
	await lineNumbers.click();
	await expect(page.getByRole("alert").filter({ hasText: "audit appearance write refused" })).toBeVisible();
	await expect(lineNumbers).toHaveAttribute("aria-checked", checked ?? "false");
	await settings.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Porcelain" }).click();
	await expect(page.getByRole("alert").filter({ hasText: "audit appearance write refused" })).toBeVisible();
	await page.keyboard.press("Escape");
	expect(errors).toEqual([]);
});
