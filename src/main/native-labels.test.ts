/**
 * Native labels (the app menu, the text-field context menu, the tray) follow
 * the UI language and call each place by the name the window uses for it:
 * Electron's role items default to English whatever the language, and a menu
 * item that opens a page under another name reads as a different feature.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "../renderer/locales/en";
import { ko } from "../renderer/locales/ko";
import { UI_LANGUAGES } from "../shared/ui-language";
import { MAIN_TEXT, type MainTextKey } from "./i18n-text";
import { approvalLabel, statusLabel, type TrayLabelKey, thinkingLabel, t as trayT } from "./tray-labels";

const RENDERER = { en, ko };
const source = (file: string) => fs.readFileSync(path.join(__dirname, file), "utf8");

/** Menus use title case and an ellipsis for items that ask for more; the words must match. */
const sameName = (native: string, renderer: string) =>
	native.replace(/…$/, "").toLowerCase() === renderer.replace(/…$/, "").toLowerCase();

describe("native menu roles", () => {
	it.each(["menu.ts", "editable-context-menu.ts"])("%s labels every role item", file => {
		expect(source(file).match(/\{\s*role: "\w+"(?: as const)?\s*\}/g) ?? []).toEqual([]);
	});

	it("keeps Electron's English role names in English", () => {
		const electronNames: Partial<Record<MainTextKey, string>> = {
			"menu.undo": "Undo",
			"menu.redo": "Redo",
			"menu.cut": "Cut",
			"menu.copy": "Copy",
			"menu.paste": "Paste",
			"menu.selectAll": "Select All",
			"menu.reload": "Reload",
			"menu.forceReload": "Force Reload",
			"menu.toggleDevTools": "Toggle Developer Tools",
			"menu.actualSize": "Actual Size",
			"menu.zoomIn": "Zoom In",
			"menu.zoomOut": "Zoom Out",
			"menu.toggleFullScreen": "Toggle Full Screen",
			"menu.minimize": "Minimize",
			"menu.zoom": "Zoom",
			"menu.bringAllToFront": "Bring All to Front",
		};
		const text: Record<string, Record<string, string>> = MAIN_TEXT;
		for (const [key, name] of Object.entries(electronNames)) {
			expect(text[key]?.en, key).toBe(name);
			expect(text[key]?.ko, key).toMatch(/[가-힣]/);
		}
	});
});

describe("one name per place", () => {
	const menuPairs: [MainTextKey, string][] = [
		["menu.newSession", "cmd.new"],
		["menu.newTab", "cmd.newTab"],
		["menu.newChatTab", "cmd.newChatTab"],
		["menu.openProject", "sidebar.project.open"],
		["menu.commandCenter", "help.palette"],
		["menu.contextReport", "cmd.context"],
		["menu.stats", "cmd.stats"],
		["menu.jobs", "cmd.jobs"],
		["menu.hotkeys", "help.shortcuts"],
		["menu.importSession", "cmd.import"],
		["menu.sessionTree", "cmd.tree"],
		["menu.sessionInfo", "cmd.session"],
		["menu.shareSession", "cmd.share"],
		["menu.exportHtml", "cmd.export"],
		["menu.handoff", "cmd.handoff"],
		["menu.agentHub", "cmd.agents"],
		["menu.modes", "cmd.modes"],
		["menu.providers", "settings.section.models"],
		["menu.modelRoles", "cmd.modelRoles"],
		["menu.capabilities", "settings.section.agent"],
		["menu.usage", "cmd.usage"],
		["menu.extensions", "cmd.extensions"],
		["menu.inventory", "cmd.plugins"],
		["menu.prCenter", "cmd.prCenter"],
		["menu.workspaceDirs", "settings.section.workspace"],
		["menu.workspaceChanges", "cmd.git"],
		["menu.restartCore", "cmd.restart"],
		["menu.debugConsole", "debug.title"],
		["menu.reportIssue", "help.feedback"],
	];
	const trayPairs: [TrayLabelKey, string][] = [
		["usageStats", "cmd.usage"],
		["workspaces", "titlebar.switchProject"],
		["addWorkspace", "sidebar.project.open"],
		["openProject", "sidebar.project.open"],
		["newSession", "cmd.new"],
		["handoff", "cmd.handoff"],
		["fastMode", "input.runSettings.fast"],
		["thinking", "input.runSettings.thinking"],
		["approval", "input.runSettings.approval"],
	];

	for (const language of UI_LANGUAGES) {
		it(`names each menu item like the page it opens (${language})`, () => {
			for (const [key, rendererKey] of menuPairs) {
				const native = MAIN_TEXT[key][language];
				expect(sameName(native, RENDERER[language][rendererKey] ?? ""), `${key}: ${native}`).toBe(true);
			}
		});

		it(`names the tray's settings and states like the composer (${language})`, () => {
			for (const [key, rendererKey] of trayPairs) {
				const native = trayT(language, key);
				expect(sameName(native, RENDERER[language][rendererKey] ?? ""), `${key}: ${native}`).toBe(true);
			}
			for (const mode of ["yolo", "write", "always-ask"] as const)
				expect(approvalLabel(language, mode)).toBe(RENDERER[language][`input.approval.${mode}`]);
			for (const level of ["off", "auto", "minimal", "low", "medium", "high", "xhigh", "max"])
				expect(thinkingLabel(language, level)).toBe(RENDERER[language][`input.thinking.name.${level}`]);
			expect(statusLabel(language, "idle")).toBe(RENDERER[language]["titlebar.status.ready"]);
			expect(statusLabel(language, "streaming")).toBe(RENDERER[language]["titlebar.status.working"]);
			for (const kind of ["question", "approval", "childWaiting", "checkFailed"] as const)
				expect(statusLabel(language, kind)).toBe(RENDERER[language][`attention.${kind}`]);
			// The judge's "this reply waits for you" banner says the question word too.
			expect(
				MAIN_TEXT["notify.needsInput"][language].startsWith(`${RENDERER[language]["attention.question"]} · `),
			).toBe(true);
		});
		it(`names each palette command like the help menu and the window it opens (${language})`, () => {
			const strings = RENDERER[language];
			for (const [a, b] of [
				["cmd.changelog", "help.whatsNew"],
				["cmd.changelog", "changelog.title"],
				["cmd.feedback", "help.feedback"],
				["cmd.hotkeys", "help.shortcuts"],
			])
				expect(strings[a], `${a} / ${b}`).toBe(strings[b]);
		});
	}

	it("passes a thinking level it does not know through unchanged", () => {
		expect(thinkingLabel("ko", "turbo")).toBe("turbo");
	});
});
