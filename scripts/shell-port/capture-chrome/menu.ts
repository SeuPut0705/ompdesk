/**
 * The menu area (`src/main/menu.ts`, `editable-context-menu.ts`): the application menu's wire template for each
 * platform and language, what pressing each of its items does (the frames Node sends), and the text field's context
 * menu for each kind of click. The shim's `MAC` constant is read when it loads, so the platform that is not the
 * machine's runs in a child process (`OMP_CAPTURE_PLATFORM`, applied by `platform-preload.ts` before anything loads)
 * whose steps come back through `OMP_CAPTURE_OUT`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { editableContextMenuTemplate } from "../../../src/main/editable-context-menu";
import { editLabels } from "../../../src/main/i18n";
import { MAIN_TEXT } from "../../../src/main/i18n-text";
import { createMenu } from "../../../src/main/menu";
import { TRAY_LABELS } from "../../../src/main/tray-labels";
import type { Step } from "../capture-chrome";
import { bootUserData, fakeShell } from "./fake-shell";

const LANGUAGES = ["en", "ko"] as const;
const PLATFORMS = ["darwin", "win32"] as const;

interface Wire {
	id: string;
	label: string;
	type: string;
	role?: string;
	submenu?: Wire[];
	[key: string]: unknown;
}

/** The text table Node pushes the shell (`labelTable` of relay.ts), for the language. */
function labelTable(language: (typeof LANGUAGES)[number]): Record<string, string> {
	const text: Record<string, string> = {};
	for (const [key, value] of Object.entries(MAIN_TEXT)) text[key] = value[language];
	for (const [key, value] of Object.entries(TRAY_LABELS)) text[`tray.${key}`] = value[language];
	return text;
}

/** The pressable items, each with where it sits: its top-level menu and its place in that menu's list. */
function clickable(items: Wire[]): { item: Wire; at: [number, number] }[] {
	const out: { item: Wire; at: [number, number] }[] = [];
	for (const [menu, top] of items.entries()) {
		for (const [index, item] of (top.submenu ?? []).entries()) {
			if (item.type !== "separator") out.push({ item, at: [menu, index] });
		}
	}
	return out;
}

/** Frames with Node's ids made stable: a window or page id is `<win>` / `<wc>`. */
function normal(frames: { kind: string; method: string; params: unknown }[]): unknown[] {
	return JSON.parse(
		JSON.stringify(frames, (key, value) => (key === "winId" ? "<win>" : key === "wcId" ? "<wc>" : value)),
	);
}

/**
 * The application menu in one language and what pressing each item does, in a shell of its own: the shim's quit (the
 * Quit item) closes the windows once per app, so a second language in the same shell would record nothing for it.
 */
async function inLanguage(platform: (typeof PLATFORMS)[number], language: (typeof LANGUAGES)[number]): Promise<Step[]> {
	const steps: Step[] = [];
	const shell = await fakeShell({ platform });
	const { BrowserWindow } = shell.electron;
	// index.ts: `app.setName("ompdesk")`; the macOS app menu is labelled with it.
	shell.electron.app.setName("ompdesk");
	const target = new BrowserWindow({ show: false });
	await shell.settle();
	await shell.emit("win.event", { winId: target.id, name: "focus", args: [] });
	let current: unknown = target;
	const spawned: (string | null)[] = [];
	const manager = {
		getTargetWindow: () => current,
		recordFor: () => ({ cwd: "/work/project" }),
	};
	const spawn = (cwd?: string) => {
		spawned.push(cwd ?? null);
		return new BrowserWindow({ show: false });
	};
	// i18n.ts reads the language from the store it opened at load, in the first fake shell's profile.
	const prefs = join(bootUserData(), "prefs.json");

	writeFileSync(prefs, JSON.stringify({ language }));
	shell.take();
	createMenu(manager as never, spawn as never);
	await shell.settle();
	const frame = shell.take().find(f => f.method === "menu.setApplication");
	if (!frame) throw new Error("createMenu sent no menu.setApplication");
	const { menuId, template } = frame.params as { menuId: number; template: Wire[] };
	steps.push({
		fn: "src/main/menu.ts#createMenu",
		input: { platform, language },
		output: { appName: shell.electron.app.name, template, labels: labelTable(language) },
	});
	// Pressing each item (the page's actions, the window actions, the roles Electron runs itself).
	for (const { item, at } of clickable(template)) {
		if (item.role) {
			steps.push({
				fn: "src/main/menu.ts#click",
				input: { platform, language, at, label: item.label },
				output: { native: item.role },
			});
			continue;
		}
		current = target;
		spawned.length = 0;
		shell.take();
		await shell.emit("menu.click", { menuId, itemId: item.id });
		steps.push({
			fn: "src/main/menu.ts#click",
			input: { platform, language, at, label: item.label },
			output: { frames: normal(shell.take()), spawned: [...spawned] },
		});
	}
	shell.close();
	return steps;
}

async function onPlatform(platform: (typeof PLATFORMS)[number]): Promise<Step[]> {
	const steps: Step[] = [];
	for (const language of LANGUAGES) steps.push(...(await inLanguage(platform, language)));
	const shell = await fakeShell({ platform });
	const { BrowserWindow, Menu } = shell.electron;
	// index.ts: `app.setName("ompdesk")`; the macOS app menu is labelled with it.
	shell.electron.app.setName("ompdesk");
	const target = new BrowserWindow({ show: false });
	await shell.settle();
	await shell.emit("win.event", { winId: target.id, name: "focus", args: [] });
	let current: unknown = target;
	const spawned: (string | null)[] = [];
	let createdId: number | null = null;
	const manager = {
		getTargetWindow: () => current,
		recordFor: () => ({ cwd: "/work/project" }),
	};
	const spawn = (cwd?: string) => {
		spawned.push(cwd ?? null);
		const win = new BrowserWindow({ show: false });
		createdId = win.id;
		return win;
	};
	// i18n.ts reads the language from the store it opened at load, in the first fake shell's profile.
	const prefs = join(bootUserData(), "prefs.json");

	// No window (macOS keeps running): the action waits for the spawned window's first paint.
	writeFileSync(prefs, JSON.stringify({ language: "en" }));
	createMenu(manager as never, spawn as never);
	await shell.settle();
	const frame = shell.take().find(f => f.method === "menu.setApplication");
	if (!frame) throw new Error("createMenu sent no menu.setApplication");
	const { menuId, template } = frame.params as { menuId: number; template: Wire[] };
	const item = clickable(template).find(i => i.item.label === "Settings…")?.item;
	current = null;
	spawned.length = 0;
	await shell.emit("menu.click", { menuId, itemId: item?.id });
	const before = normal(shell.take());
	if (createdId !== null) await shell.emit("win.event", { winId: createdId, name: "ready-to-show", args: [] });
	steps.push({
		fn: "src/main/menu.ts#noWindow",
		input: { platform, label: item?.label },
		output: { spawned: [...spawned], before, after: normal(shell.take()) },
	});

	// The text field's context menu.
	const base = { isEditable: true, misspelledWord: "teh", dictionarySuggestions: ["the", "tech", "the"] };
	const variants: Record<string, unknown>[] = [
		base,
		{ ...base, dictionarySuggestions: [] },
		{ ...base, misspelledWord: "", dictionarySuggestions: [] },
		{ ...base, misspelledWord: "", dictionarySuggestions: ["a", "b"] },
		{ ...base, dictionarySuggestions: ["a", "b", "c", "d", "e", "f", "g", "a"] },
		{ ...base, dictionarySuggestions: ["a", "a", "a", "b", "b", "c", "c", "d", "d", "e", "e", "f"] },
		{ isEditable: false },
		{ isEditable: false, mediaType: "image", hasImageContents: true, x: 40, y: 72 },
		{ isEditable: false, mediaType: "image", hasImageContents: false, x: 40, y: 72 },
		{ isEditable: false, mediaType: "video", hasImageContents: true },
		{ isEditable: true, mediaType: "image", hasImageContents: true, misspelledWord: "", dictionarySuggestions: [] },
		{ isEditable: true, misspelledWord: "x", dictionarySuggestions: ["ü", "{a}", "a&b"] },
	];
	for (const language of LANGUAGES) {
		for (const params of variants) {
			const calls: unknown[] = [];
			const items = editableContextMenuTemplate(params as never, editLabels(language), {
				replaceMisspelling: suggestion => calls.push({ replaceMisspelling: suggestion }),
				addToDictionary: word => calls.push({ addToDictionary: word }),
				copyImageAt: (x, y) => calls.push({ copyImageAt: [x, y] }),
			});
			const menu = Menu.buildFromTemplate(items);
			const clicks: unknown[] = [];
			for (const [index, entry] of items.entries()) {
				if (!entry.click) continue;
				calls.length = 0;
				(entry.click as () => void)();
				clicks.push({ index, calls: [...calls] });
			}
			steps.push({
				fn: "src/main/editable-context-menu.ts#editableContextMenuTemplate",
				input: { platform, language, params },
				output: { template: menu.toWire(), clicks },
			});
		}
	}
	shell.close();
	return steps;
}

export async function capture(): Promise<Step[]> {
	const only = process.env.OMP_CAPTURE_PLATFORM;
	if (only) {
		const steps = await onPlatform(only as (typeof PLATFORMS)[number]);
		writeFileSync(process.env.OMP_CAPTURE_OUT ?? "", JSON.stringify(steps));
		return steps;
	}
	const own = process.platform as (typeof PLATFORMS)[number];
	const steps: Step[] = [];
	const out = join(process.env.TMPDIR ?? "/tmp", `capture-menu-${process.pid}.json`);
	for (const platform of PLATFORMS) {
		if (platform === own) {
			steps.push(...(await onPlatform(platform)));
			continue;
		}
		execFileSync(
			process.execPath,
			[
				"--preload",
				join(import.meta.dir, "platform-preload.ts"),
				join(import.meta.dir, "..", "capture-chrome.ts"),
				"menu",
			],
			{
				env: { ...process.env, OMP_CAPTURE_PLATFORM: platform, OMP_CAPTURE_OUT: out },
				stdio: "inherit",
			},
		);
		steps.push(...(JSON.parse(readFileSync(out, "utf8")) as Step[]));
	}
	steps.unshift({
		fn: "src/main/i18n-text.ts#labels",
		input: {},
		output: { en: labelTable("en"), ko: labelTable("ko") },
	});
	return steps;
}
