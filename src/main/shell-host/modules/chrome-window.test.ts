/**
 * The window area against the real shell (PROTOCOL.md §15.3): the shell makes the app window, the shim adopts it, the
 * geometry is read from and saved to `window-state.json`, and a close of the last shown window hides it (close to
 * tray). The rules' own cases are Rust tests over `captured/window.json`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShellClient } from "../client";
import { createElectron, type ElectronShim } from "../electron/create";
import { pointChromeAt } from "./chrome";
import { WindowManager } from "./chrome-window";
import { startTestShell, type TestShell, testShellExecutable } from "./test-shell";

const holder = vi.hoisted(() => ({ electron: null as ElectronShim | null }));
// The client resolves the adopted window through `BrowserWindow.fromId`: the shim over this test's shell.
vi.mock("electron", () => ({
	get BrowserWindow() {
		return holder.electron?.BrowserWindow;
	},
}));

const executable = testShellExecutable();

let shell: TestShell | null = null;

afterEach(async () => {
	await shell?.close();
	shell = null;
	holder.electron = null;
	pointChromeAt();
});

async function start(
	saved?: unknown,
	env?: Record<string, string>,
): Promise<{ client: ShellClient; userData: string }> {
	shell = await startTestShell(executable as string, {
		...(env ? { env } : {}),
		prepare: userData => {
			if (saved) writeFileSync(path.join(userData, "window-state.json"), JSON.stringify({ windowState: saved }));
		},
	});
	pointChromeAt(() => shell?.client as never);
	// The test shell is past `app.ready` already: a shim made now must not wait for it.
	holder.electron = createElectron(shell.client, shell.facts, { attached: true, exitProcess: () => {} });
	return { client: shell.client, userData: shell.userData };
}

function nextEvent<T>(client: ShellClient, name: string, match: (data: T) => boolean = () => true): Promise<T> {
	const seen = Promise.withResolvers<T>();
	const stop = client.on(name, (data: T) => {
		if (!match(data)) return;
		stop();
		seen.resolve(data);
	});
	return seen.promise;
}

describe.skipIf(!executable)("chrome window (real shell)", () => {
	it("makes the window, which the shim adopts before the answer, in the lowest free slot", async () => {
		const { client } = await start();
		const adopted: number[] = [];
		client.on("win.adopted", ({ winId }: { winId: number }) => adopted.push(winId));
		const manager = new WindowManager();
		const first = await manager.createWindow({ cwd: "/work/a" });
		const second = await manager.createWindow({ cwd: "/work/b" });
		expect(adopted).toEqual([first.id, second.id]);
		expect(first.id).toBeGreaterThanOrEqual(2 ** 32);
		expect(holder.electron?.BrowserWindow.fromId(first.id)).toBe(first);
		expect(manager.recordFor(first)).toMatchObject({ cwd: "/work/a", slot: 0 });
		expect(manager.recordFor(second)).toMatchObject({ cwd: "/work/b", slot: 1 });
	});

	it("opens at the saved geometry and saves it again when the window closes", async () => {
		const saved = { x: 120, y: 140, width: 1000, height: 700, isMaximized: false };
		const { client, userData } = await start(saved);
		const adopted = nextEvent<{ options: Record<string, unknown> }>(client, "win.adopted");
		const manager = new WindowManager();
		const win = await manager.createWindow({ cwd: "/work" });
		expect((await adopted).options).toMatchObject({ x: 120, y: 140, width: 1000, height: 700 });
		const closed = nextEvent<{ name: string }>(client, "win.event", data => data.name === "closed");
		// `destroy`: a close that is no person's (a quit's), which the close-to-tray rule never holds.
		win.destroy();
		await closed;
		const store = JSON.parse(readFileSync(path.join(userData, "window-state.json"), "utf8"));
		expect(store.windowState).toMatchObject({ width: expect.any(Number), isMaximized: false });
	});

	it("hides the last shown window a person closes instead of closing it (close to tray)", async () => {
		const { client } = await start();
		const manager = new WindowManager();
		const win = await manager.createWindow({ cwd: "/work" });
		await client.call("win.op", { winId: win.id, op: "show", args: {} });
		const hidden = nextEvent<{ winId: number }>(client, "chrome.hiddenToTray");
		// A close nobody approved: the person's (the caption button, ⌘W).
		await client.call("win.op", { winId: win.id, op: "close", args: {} });
		expect((await hidden).winId).toBe(win.id);
		expect(win.isDestroyed()).toBe(false);
	});

	// Was app-icon.test.ts: macOS filed an unpackaged run's notifications under the development bundle, with its
	// logo, in the person's Notification Center ("Autopilot ended", "From PC-B", 21 Oct 2026).
	it("posts no notification to the OS in a test launch (OMP_GUI_HEADLESS)", async () => {
		const { client } = await start(undefined, { OMP_GUI_HEADLESS: "1" });
		const events: unknown[] = [];
		client.on("notification.event", (data: unknown) => events.push(data));
		await client.call("notification.show", { id: 7, title: "Autopilot ended", body: "" });
		// The close runs on the UI thread after the show's turn: a `show` event would have gone out before its answer.
		await client.call("notification.close", { id: 7 });
		expect(events).toEqual([]);
	});
});
