/**
 * The application menu and the text field's context menu against the real shell (PROTOCOL.md §15.3; was
 * `editable-context-menu.test.ts` and the live half of `menu-actions.test.ts`). A headless run cannot open a native
 * menu, so the cases read the menu the shell would show with `chrome.menuProbe` (the context menu as a dry run for the
 * given click) and press items of the application menu. What stays in Rust (`chrome_core::menu`, replayed against
 * `captured/menu.json`): the whole template per platform and language, what each item does and what each context-menu
 * item calls (replace a misspelling, add to the dictionary, copy the image).
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MenuAction } from "../../../shared/ipc-types";
import { MAIN_TEXT } from "../../i18n-text";
import { TRAY_LABELS } from "../../tray-labels";
import { pointChromeAt } from "./chrome";
import { type MenuProbeItem, menuProbe, publishMenu } from "./chrome-menu";
import { startTestShell, type TestShell, testShellExecutable } from "./test-shell";

vi.mock("electron", () => ({ BrowserWindow: { fromId: () => undefined } }));

const exe = testShellExecutable();
const shells: TestShell[] = [];
let current: TestShell | null = null;
pointChromeAt(() => {
	if (!current) throw new Error("no test shell is running");
	return current.client;
});

afterEach(async () => {
	for (const shell of shells.splice(0)) await shell.close();
});

function labels(language: "en" | "ko") {
	const text: Record<string, string> = {};
	for (const [key, value] of Object.entries(MAIN_TEXT)) text[key] = value[language];
	for (const [key, value] of Object.entries(TRAY_LABELS)) text[`tray.${key}`] = value[language];
	return { language, text };
}

async function start(language: "en" | "ko"): Promise<TestShell> {
	const shell = await startTestShell(exe as string, { env: { OMP_GUI_HEADLESS: "1" } });
	shells.push(shell);
	current = shell;
	publishMenu("ompdesk");
	await shell.client.event("i18n.labels", labels(language));
	return shell;
}

const KO = MAIN_TEXT;
const params = (overrides: Record<string, unknown> = {}) => ({
	isEditable: true,
	misspelledWord: "teh",
	dictionarySuggestions: ["the", "tech", "the"],
	...overrides,
});

describe.skipIf(!exe)("editable context menu", () => {
	it("offers deduplicated spelling replacements and dictionary learning before native edit roles", async () => {
		await start("ko");
		const menu = await menuProbe("context", { params: params() });
		expect(menu.slice(0, 3).map(item => item.label)).toEqual(["the", "tech", KO["menu.addToDictionary"].ko]);
		expect(menu.find(item => item.id === "role:paste")?.label).toBe(KO["menu.paste"].ko);
		// Every native edit item carries the UI language's name, never Electron's English default.
		expect(menu.filter(item => item.type !== "separator" && item.label === "")).toEqual([]);
	});

	it("does not replace non-editable application context menus", async () => {
		await start("ko");
		expect(await menuProbe("context", { params: params({ isEditable: false }) })).toEqual([]);
	});

	it("offers Copy image on an image", async () => {
		await start("ko");
		const menu = await menuProbe("context", {
			params: params({ isEditable: false, mediaType: "image", hasImageContents: true, x: 40, y: 72 }),
		});
		expect(menu.map(item => item.label)).toEqual([KO["menu.copyImage"].ko]);
	});
});

describe.skipIf(!exe)("application menu", () => {
	const walk = (items: MenuProbeItem[]): MenuProbeItem[] => items.flatMap(item => [item, ...walk(item.submenu ?? [])]);

	it("labels every item in the UI language, and reads again when the language changes", async () => {
		const shell = await start("en");
		const english = await menuProbe("application");
		expect(english.map(menu => menu.label)).toContain("File");
		for (const item of walk(english)) if (item.type !== "separator") expect(item.label, item.id).not.toBe("");
		await shell.client.event("i18n.labels", labels("ko"));
		const korean = await menuProbe("application");
		expect(korean.map(menu => menu.label)).toContain(KO["menu.file"].ko);
		expect(walk(korean).find(item => item.id === "role:reload")?.label).toBe(KO["menu.reload"].ko);
	});

	it("sends only the page actions the renderer declares", async () => {
		await start("en");
		const sent = walk(await menuProbe("application"))
			.map(item => /^page:(.+)$/.exec(item.id)?.[1])
			.filter((action): action is MenuAction => action !== undefined);
		expect(sent.length).toBeGreaterThan(20);
		const types = fs.readFileSync(path.resolve(__dirname, "../../../shared/ipc-types.ts"), "utf8");
		const union = /export type MenuAction =([^;]+);/.exec(types)?.[1] ?? "";
		const declared = [...union.matchAll(/"([a-z-]+)"/g)].map(match => match[1]);
		for (const action of sent) expect(declared, action).toContain(action);
	});

	it("opens a window and delivers the action when none is open", async () => {
		const shell = await start("en");
		const asked: unknown[] = [];
		shell.client.handle("chrome.spawn", (spawnParams: unknown) => {
			asked.push(spawnParams);
			return { winId: null };
		});
		await menuProbe("application", { click: "page:open-settings" });
		await vi.waitFor(() => expect(asked).toEqual([{}]));
	});
});
