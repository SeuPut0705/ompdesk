/**
 * The handler table: an Electron call and a caller from outside Electron reach the same handler, the Electron
 * one with the window `BrowserWindow.fromWebContents` finds for its sender, as the handlers looked it up before.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreProcess } from "../core/process";
import { nativeBinPath } from "../native-bin";
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

/** The core's plumbing channels (`crates/core/src/ipc`), classified as `IPC_POLICY` classifies a channel. */
const TEST_POLICY = {
	"test:ipc.record": { dir: "send", permission: "workspace", mode: "pass" },
	"test:ipc.recorded": { dir: "invoke", permission: "workspace", mode: "pass" },
};

describe("IpcRegistry: the channels the core serves", () => {
	const cores: CoreProcess[] = [];
	afterEach(async () => {
		await Promise.all(cores.splice(0).map(core => core.stop()));
	});

	function startCore(binary: () => string = () => nativeBinPath("ompdesk-core")): CoreProcess {
		const core = new CoreProcess({ binary, log: () => {} });
		cores.push(core);
		return core;
	}

	it("runs a page's sends to a core channel in the order the page made them", async () => {
		const { ipc, invokes, sends } = registry();
		await ipc.routeCore(startCore(), TEST_POLICY, { testChannels: true });
		const record = sends.get("test:ipc.record");
		const recorded = invokes.get("test:ipc.recorded");
		if (!record || !recorded) throw new Error("the core's channels were not registered on ipcMain");
		const page = { id: 7 };
		// The first send holds 50 ms in the core before it records: a later send that overtook it would record first.
		record({ sender: page }, "first", 50);
		record({ sender: page }, "second", 0);
		await expect(recorded({ sender: page })).resolves.toEqual(["first", "second"]);
		// A paired page's connection is a caller of its own, through the web table.
		const web = { ...webCaller, connId: "conn-1" };
		ipc.send("test:ipc.record", web, ["web", 0]);
		await expect(ipc.invoke("test:ipc.recorded", web, [])).resolves.toEqual(["web"]);
		await expect(recorded({ sender: page })).resolves.toEqual(["first", "second"]);
	});

	it("fails only the core's channels while the core is down or resting", async () => {
		const { ipc } = registry();
		ipc.handle("main:here", () => "main answers");
		let binary = nativeBinPath("ompdesk-core");
		const core = startCore(() => binary);
		await ipc.routeCore(core, TEST_POLICY, { testChannels: true });
		await expect(ipc.invoke("test:ipc.recorded", webCaller, [])).resolves.toEqual([]);

		await core.stop();
		binary = join(__dirname, "no-such-core.exe");
		// Three starts that fail, then the core rests: every call of its channels fails, none of main's does.
		for (let attempt = 0; attempt < 3; attempt++) {
			await expect(ipc.invoke("test:ipc.recorded", webCaller, [])).rejects.toThrow(/could not run/);
			await expect(ipc.invoke("main:here", webCaller, [])).resolves.toBe("main answers");
		}
		await expect(ipc.invoke("test:ipc.recorded", webCaller, [])).rejects.toThrow(/not started again/);
		await expect(ipc.invoke("main:here", webCaller, [])).resolves.toBe("main answers");
	});

	it("leaves main's channels served when the core cannot take the policy", async () => {
		const { ipc, invokes } = registry();
		ipc.handle("main:here", () => "main answers");
		await expect(
			ipc.routeCore(
				startCore(() => join(__dirname, "no-such-core.exe")),
				TEST_POLICY,
				{ testChannels: true },
			),
		).rejects.toThrow(/could not run/);
		await expect(ipc.routeCore(startCore(), {}, { testChannels: true })).rejects.toThrow(/IPC_POLICY/);
		expect([...invokes.keys()]).toEqual(["main:here"]);
		await expect(ipc.invoke("main:here", webCaller, [])).resolves.toBe("main answers");
	});
});
