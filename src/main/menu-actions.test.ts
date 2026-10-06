/**
 * Native menu + tray wiring: every MENU_ACTION the main process sends must be a
 * declared MenuAction with a branch in the renderer's dispatcher (App.tsx), so a
 * redesign that removes an opener cannot leave a menu item that does nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..");

/** First capture group of every match of `pattern` in `src/<file>` (or in a given string). */
function captures(file: string, pattern: RegExp, source = fs.readFileSync(path.join(SRC, file), "utf8")): string[] {
	return [...source.matchAll(pattern)].map(match => match[1]);
}

const union = /export type MenuAction =([^;]+);/.exec(
	fs.readFileSync(path.join(SRC, "shared/ipc-types.ts"), "utf8"),
)?.[1];
const declared = captures("", /"([a-z-]+)"/g, union ?? "");
const menuSent = captures("main/menu.ts", /sendMenuAction\(windowManager, spawnWindow, "([a-z-]+)"\)/g);
const traySent = captures("main/tray.ts", /send\(windowManager, "([a-z-]+)"/g);
const handled = captures("renderer/App.tsx", /action === "([a-z-]+)"/g);

describe("menu and tray actions", () => {
	it("finds the declared actions and their senders", () => {
		expect(declared.length).toBeGreaterThan(20);
		expect(menuSent.length).toBeGreaterThan(20);
		expect(traySent.length).toBeGreaterThan(5);
	});

	it("sends only declared actions", () => {
		for (const action of [...menuSent, ...traySent]) expect(declared, action).toContain(action);
	});

	it("handles every declared action in the renderer", () => {
		for (const action of declared) expect(handled, action).toContain(action);
	});

	it("declares no action that neither the menu nor the tray sends", () => {
		for (const action of declared) expect([...menuSent, ...traySent], action).toContain(action);
	});
});
