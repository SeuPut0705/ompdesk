/**
 * The handler table: an Electron call and a caller from outside Electron reach the same handler, the Electron
 * one with the window `BrowserWindow.fromWebContents` finds for its sender, as the handlers looked it up before.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientWindow } from "./client-window";
import { type IpcCaller, IpcRegistry } from "./ipc-registry";

const electron = vi.hoisted(() => ({ windows: new Map<object, unknown>() }));
vi.mock("electron", () => ({
	BrowserWindow: { fromWebContents: (sender: object) => electron.windows.get(sender) ?? null },
}));

type Listener = (event: { sender: object }, ...args: unknown[]) => unknown;

function registry() {
	const invokes = new Map<string, Listener>();
	const sends = new Map<string, Listener>();
	const ipc = new IpcRegistry({
		handle: (channel, listener) => {
			// Electron refuses a second handler for a channel.
			if (invokes.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
			invokes.set(channel, listener as Listener);
		},
		on: (channel, listener) => sends.set(channel, listener as Listener),
	});
	return { ipc, invokes, sends };
}

function fakeWindow(id: number): ClientWindow {
	return { webContents: { id, send: () => {} }, isDestroyed: () => false, once: () => {}, removeListener: () => {} };
}

const webCaller: IpcCaller = {
	win: fakeWindow(-1),
	browserWindow: null,
	sender: { id: -1, once: () => {} },
};

describe("IpcRegistry", () => {
	afterEach(() => electron.windows.clear());

	it("registers on ipcMain at once and hands an Electron call its sender's window", async () => {
		const { ipc, invokes } = registry();
		const seen: Array<{ win: ClientWindow | null; native: unknown; senderId: number; args: unknown[] }> = [];
		ipc.handle("demo:echo", (caller, ...args: unknown[]) => {
			seen.push({ win: caller.win, native: caller.browserWindow, senderId: caller.sender.id, args });
			return "answer";
		});
		expect([...invokes.keys()]).toEqual(["demo:echo"]);
		const sender = { id: 7 };
		const win = fakeWindow(7);
		electron.windows.set(sender, win);
		expect(await invokes.get("demo:echo")?.({ sender }, "a", 2)).toBe("answer");
		expect(seen).toEqual([{ win, native: win, senderId: 7, args: ["a", 2] }]);
	});

	it("looks the window up again on every read, like the call it replaces", () => {
		const { ipc, invokes } = registry();
		const reads: Array<ClientWindow | null> = [];
		ipc.handle("demo:twice", caller => {
			reads.push(caller.win);
			electron.windows.clear();
			reads.push(caller.win);
		});
		const sender = { id: 3 };
		const win = fakeWindow(3);
		electron.windows.set(sender, win);
		invokes.get("demo:twice")?.({ sender });
		expect(reads).toEqual([win, null]);
	});

	it("runs the same handler for a caller outside Electron", async () => {
		const { ipc } = registry();
		const handler = vi.fn((caller: IpcCaller, value: unknown) => ({ id: caller.win?.webContents.id, value }));
		ipc.handle("demo:echo", handler);
		await expect(ipc.invoke("demo:echo", webCaller, ["x"])).resolves.toEqual({ id: -1, value: "x" });
		expect(handler).toHaveBeenCalledWith(webCaller, "x");
	});

	it("rejects a web invoke the way Electron does: a handler's throw, or a channel nobody handles", async () => {
		const { ipc } = registry();
		ipc.handle("demo:fail", () => {
			throw new Error("refused");
		});
		await expect(ipc.invoke("demo:fail", webCaller, [])).rejects.toThrow("refused");
		await expect(ipc.invoke("demo:missing", webCaller, [])).rejects.toThrow(
			"No handler registered for 'demo:missing'",
		);
	});

	it("keeps Electron's one handler per invoke channel", () => {
		const { ipc } = registry();
		ipc.handle("demo:once", () => 1);
		expect(() => ipc.handle("demo:once", () => 2)).toThrow("second handler");
	});

	it("dispatches fire-and-forget sends from both callers to one listener per channel", () => {
		const { ipc, sends } = registry();
		const listener = vi.fn();
		ipc.on("demo:report", listener);
		expect(() => ipc.on("demo:report", () => {})).toThrow("second listener");
		const sender = { id: 9 };
		sends.get("demo:report")?.({ sender }, true);
		ipc.send("demo:report", webCaller, [false]);
		ipc.send("demo:nobody", webCaller, []);
		expect(listener.mock.calls.map(([caller, value]) => [caller.sender.id, value])).toEqual([
			[9, true],
			[-1, false],
		]);
	});
});
