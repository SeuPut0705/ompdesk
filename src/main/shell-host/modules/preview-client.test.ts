/**
 * The Preview's Node side (PROTOCOL.md §15.3 step 3: tests of callers run over a fake host): what `registerPreview` does
 * with a caller, a window, a relay socket and the tab's omp, as the TypeScript host did before the pages moved into the
 * shell. The pages themselves are proven against the real shell in `preview.test.ts`.
 */
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	EMPTY_PREVIEW,
	PREVIEW_COMMAND,
	PREVIEW_PAGE,
	PREVIEW_SAVE_PDF,
	PREVIEW_STATE,
	PREVIEW_STREAM_COPY,
	PREVIEW_STREAM_DIALOG,
	PREVIEW_STREAM_INPUT,
	PREVIEW_STREAM_PDF,
	PREVIEW_STREAM_POLL,
	PREVIEW_VISUAL,
	PREVIEW_VISUALS,
	type PreviewState,
} from "../../../shared/preview";
import type { ClientWindow } from "../../web/client-window";
import { type IpcCaller, IpcRegistry } from "../../web/ipc-registry";
import type { HostClient } from "../electron/host";
import { shellModule } from "./client";
import {
	type PreviewClient,
	type PreviewDeps,
	type PreviewSpec,
	type RelaySocket,
	registerPreview,
	relayExtensionUrl,
} from "./preview";

const electron = vi.hoisted(() => ({
	saved: null as { filePath?: string; canceled: boolean } | null,
	downloads: "/downloads",
}));
vi.mock("electron", () => ({
	BrowserWindow: { fromWebContents: () => null },
	app: { getPath: () => electron.downloads },
	dialog: { showSaveDialog: async () => electron.saved },
}));

/** What `HostClient` is to the module client: calls, events both ways, asks the shell makes. */
class FakeHost {
	readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
	readonly events: Array<{ name: string; data: Record<string, unknown> }> = [];
	readonly answers = new Map<string, (params: Record<string, unknown>) => unknown>();
	readonly bins = new Map<string, Buffer>();
	readonly #listeners = new Map<string, Set<(data: never, bin?: Buffer) => void>>();
	readonly #handlers = new Map<string, (params: never, context: { signal: AbortSignal }) => unknown>();

	async request(method: string, params: Record<string, unknown>) {
		this.calls.push({ method, params });
		const answer = this.answers.get(method);
		const result = answer ? await answer(params) : {};
		return { result, bin: this.bins.get(method) };
	}
	async call(method: string, params: Record<string, unknown>) {
		return (await this.request(method, params)).result;
	}
	async event(name: string, data: Record<string, unknown>) {
		this.events.push({ name, data });
	}
	on(name: string, listener: (data: never, bin?: Buffer) => void) {
		const set = this.#listeners.get(name) ?? new Set();
		set.add(listener);
		this.#listeners.set(name, set);
		return () => set.delete(listener);
	}
	handle(method: string, handler: (params: never, context: { signal: AbortSignal }) => unknown) {
		this.#handlers.set(method, handler);
	}
	/** The shell sends the module's event `name`. */
	emit(name: string, data: Record<string, unknown>) {
		for (const listener of this.#listeners.get(`preview.${name}`) ?? []) listener(data as never);
	}
	/** The module asks Node `method`. */
	ask(method: string, params: Record<string, unknown>) {
		const handler = this.#handlers.get(`preview.${method}`);
		if (!handler) throw new Error(`nobody serves ${method}`);
		return handler(params as never, { signal: new AbortController().signal });
	}
	callsOf(method: string) {
		return this.calls.filter(call => call.method === `preview.${method}`).map(call => call.params);
	}
	eventsOf(name: string) {
		return this.events.filter(event => event.name === `preview.${name}`).map(event => event.data);
	}
}

/** An app window: `BrowserWindow`'s `id`, `closed` and its renderer's `did-start-navigation`, `send`. */
class FakeWindow extends EventEmitter {
	readonly sent: Array<[string, unknown]> = [];
	readonly webContents: EventEmitter & { id: number; send(channel: string, payload: unknown): void };
	destroyed = false;
	constructor(
		readonly id: number,
		contentsId: number,
	) {
		super();
		const sent = this.sent;
		this.webContents = Object.assign(new EventEmitter(), {
			id: contentsId,
			send: (channel: string, payload: unknown) => {
				sent.push([channel, payload]);
			},
		});
	}
	isDestroyed() {
		return this.destroyed;
	}
}

/** A paired viewer's virtual window: negative id, no native window. */
class FakeViewer extends EventEmitter {
	readonly sent: Array<[string, unknown]> = [];
	readonly webContents: { id: number; send(channel: string, payload: unknown): void };
	constructor(id: number) {
		super();
		const sent = this.sent;
		this.webContents = {
			id,
			send: (channel, payload) => {
				sent.push([channel, payload]);
			},
		};
	}
	isDestroyed() {
		return false;
	}
}

const windowCaller = (win: FakeWindow): IpcCaller => ({
	win: win as unknown as ClientWindow,
	browserWindow: win as never,
	sender: win.webContents as never,
});
const viewerCaller = (viewer: FakeViewer): IpcCaller => ({
	win: viewer as unknown as ClientWindow,
	browserWindow: null,
	sender: { id: viewer.webContents.id, once: () => {} },
});

/** A tunnel to a paired host's relay: frames by hand, an open that the test settles. */
class FakeRelaySocket implements RelaySocket {
	readonly ready: Promise<void>;
	readonly sent: string[] = [];
	isOpen = false;
	closed = false;
	readonly #messages: Array<(data: string) => void> = [];
	readonly #closes: Array<() => void> = [];
	constructor(opening: Promise<void>) {
		this.ready = opening.then(() => {
			this.isOpen = true;
		});
		this.ready.catch(() => {});
	}
	send(data: string) {
		this.sent.push(data);
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		this.isOpen = false;
		for (const listener of this.#closes) listener();
	}
	onMessage(listener: (data: string) => void) {
		this.#messages.push(listener);
	}
	onClose(listener: () => void) {
		this.#closes.push(listener);
	}
	push(data: object) {
		for (const listener of this.#messages) listener(JSON.stringify(data));
	}
}

const TOKEN = "x".repeat(32);
const RELAY = { action: "agentStart", tabId: "tab", url: "http://127.0.0.1:9333", token: TOKEN } as const;

interface Rig {
	host: FakeHost;
	ipc: IpcRegistry;
	deps: PreviewDeps & { remote: Set<string> };
	client: PreviewClient;
	tunnel: { socket: RelaySocket | null };
	prefs: { judge: boolean; active: string | null };
}

function rig(): Rig {
	const host = new FakeHost();
	const ipc = new IpcRegistry({ handle: () => {}, on: () => {} });
	const remote = new Set<string>();
	const tunnel: Rig["tunnel"] = { socket: null };
	const prefs = { judge: false, active: null as string | null };
	const deps = {
		remote,
		// A named tab in `remote` runs on a paired host; any other named tab is not this window's.
		tabTarget: (_win: ClientWindow, tabId?: string) =>
			tabId === undefined ? null : remote.has(tabId) ? { device: "host" } : tabId === "mine" ? {} : null,
		tunnel: () => tunnel.socket,
		judgeAssist: () => prefs.judge,
		activeTab: () => prefs.active,
		appWindowId: (win: ClientWindow) => (win instanceof FakeWindow ? win.id : undefined),
	};
	const client = registerPreview(
		ipc,
		deps,
		shellModule<PreviewSpec>("preview", () => host as unknown as HostClient),
	);
	return { host, ipc, deps, client, tunnel, prefs };
}

const state = (patch: Partial<PreviewState> = {}): PreviewState => ({ ...EMPTY_PREVIEW, ...patch });

describe("the Preview's IPC handlers", () => {
	let r: Rig;
	beforeEach(() => {
		r = rig();
	});

	it("asks the module as the owner it is: an app window's renderer and window, a viewer's virtual window alone", async () => {
		const win = new FakeWindow(3, 17);
		const viewer = new FakeViewer(-4);
		r.host.answers.set("preview.command", () => state());
		await r.ipc.invoke(PREVIEW_COMMAND, windowCaller(win), [{ action: "clearProblems" }]);
		await r.ipc.invoke(PREVIEW_COMMAND, viewerCaller(viewer), [{ action: "clearProblems" }]);
		expect(r.host.callsOf("command")).toEqual([
			{ owner: { key: 17, winId: 3 }, remote: false, request: { action: "clearProblems" } },
			{ owner: { key: -4 }, remote: false, request: { action: "clearProblems" } },
		]);
	});

	it("refuses a caller that is neither an app window's renderer nor a viewer", async () => {
		const win = new FakeWindow(3, 17);
		const other = {
			win: win as unknown as ClientWindow,
			browserWindow: win as never,
			sender: { id: 99, once: () => {} },
		};
		await expect(r.ipc.invoke(PREVIEW_COMMAND, other, [{ action: "reload" }])).rejects.toThrow(
			"Invalid preview owner",
		);
		const positive: IpcCaller = {
			win: new FakeWindow(1, 1) as unknown as ClientWindow,
			browserWindow: null,
			sender: { id: 1, once: () => {} },
		};
		await expect(r.ipc.invoke(PREVIEW_COMMAND, positive, [{ action: "reload" }])).rejects.toThrow(
			"Invalid preview owner",
		);
		expect(r.host.calls).toEqual([]);
	});

	it("says whether the owner's tab runs on a paired host: the active tab when none is named, a tab the window does not own counts as remote", async () => {
		const win = new FakeWindow(3, 17);
		r.host.answers.set("preview.command", () => state());
		const ask = (request: object) => r.ipc.invoke(PREVIEW_COMMAND, windowCaller(win), [request]);
		await ask({ action: "load", url: "https://example.com/" });
		await ask({ action: "restoreVisuals", tabId: "mine", show: true });
		await ask({ action: "restoreVisuals", tabId: "stranger", show: true });
		r.deps.remote.add("tab");
		await ask({ action: "restoreVisuals", tabId: "tab", show: true });
		expect(r.host.callsOf("command").map(call => call.remote)).toEqual([false, false, true, true]);
	});

	it("pushes the module's state to the owner's window, and drops it for a window that is gone", () => {
		const win = new FakeWindow(3, 17);
		r.host.answers.set("preview.command", () => state());
		return r.ipc.invoke(PREVIEW_COMMAND, windowCaller(win), [{ action: "clearProblems" }]).then(() => {
			r.host.emit("state", { owner: { key: 17, winId: 3 }, state: state({ url: "https://example.com/" }) });
			expect(win.sent).toEqual([[PREVIEW_STATE, state({ url: "https://example.com/" })]]);
			win.destroyed = true;
			r.host.emit("state", { owner: { key: 17, winId: 3 }, state: state() });
			r.host.emit("state", { owner: { key: 5 }, state: state() });
			expect(win.sent).toHaveLength(1);
		});
	});

	it("answers dispose with the empty preview and lets go of the window's listeners, round after round", async () => {
		const win = new FakeWindow(3, 17);
		r.host.answers.set("preview.command", () => state({ url: "x" }));
		for (let round = 0; round < 12; round++) {
			await r.ipc.invoke(PREVIEW_COMMAND, windowCaller(win), [{ action: "clearProblems" }]);
			expect(win.listenerCount("closed")).toBe(1);
			expect(win.webContents.listenerCount("did-start-navigation")).toBe(1);
			expect(await r.ipc.invoke(PREVIEW_COMMAND, windowCaller(win), [{ action: "dispose" }])).toEqual(EMPTY_PREVIEW);
			expect(win.listenerCount("closed")).toBe(0);
			expect(win.webContents.listenerCount("did-start-navigation")).toBe(0);
		}
		expect(r.host.eventsOf("ownerGone")).toEqual([]);
	});

	it("ends the owner's pages with its window and on the app renderer's own main-frame navigation only", async () => {
		const win = new FakeWindow(3, 17);
		r.host.answers.set("preview.command", () => state());
		await r.ipc.invoke(PREVIEW_COMMAND, windowCaller(win), [{ action: "newTab" }]);
		// Frames inside the app and in-page navigation are not a reload.
		win.webContents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
		win.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
		expect(r.host.eventsOf("ownerGone")).toEqual([]);
		win.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
		expect(r.host.eventsOf("ownerGone")).toEqual([{ owner: { key: 17, winId: 3 } }]);
		expect(win.listenerCount("closed")).toBe(0);

		await r.ipc.invoke(PREVIEW_COMMAND, windowCaller(win), [{ action: "clearProblems" }]);
		win.emit("closed");
		expect(r.host.eventsOf("ownerGone")).toHaveLength(2);
		expect(win.webContents.listenerCount("did-start-navigation")).toBe(0);
	});

	it("ends a viewer's pages when its virtual window closes, once", async () => {
		const viewer = new FakeViewer(-4);
		r.host.answers.set("preview.command", () => state());
		await r.ipc.invoke(PREVIEW_COMMAND, viewerCaller(viewer), [{ action: "clearProblems" }]);
		viewer.emit("closed");
		viewer.emit("closed");
		expect(r.host.eventsOf("ownerGone")).toEqual([{ owner: { key: -4 } }]);
	});

	it("passes a page request, the visuals and the viewer's stream calls through, refusing a window the stream", async () => {
		const win = new FakeWindow(3, 17);
		const viewer = new FakeViewer(-4);
		r.host.answers.set("preview.page", () => ({ image: "iVBO", elements: [] }));
		r.host.answers.set("preview.visuals", () => [{ id: "v" }]);
		r.host.answers.set("preview.poll", () => ({ frame: null, dialogs: [] }));
		r.host.answers.set("preview.copy", () => ({ text: "picked" }));
		expect(await r.ipc.invoke(PREVIEW_PAGE, windowCaller(win), [{ action: "region" }])).toEqual({
			image: "iVBO",
			elements: [],
		});
		await expect(r.ipc.invoke(PREVIEW_PAGE, windowCaller(win), [{ action: "nope" }])).rejects.toThrow();
		expect(await r.ipc.invoke(PREVIEW_VISUALS, windowCaller(win), [])).toEqual([{ id: "v" }]);

		expect(await r.ipc.invoke(PREVIEW_STREAM_POLL, viewerCaller(viewer), [{ ack: 4, wait: 1000 }])).toEqual({
			frame: null,
			dialogs: [],
		});
		expect(r.host.callsOf("poll")).toEqual([{ owner: { key: -4 }, ack: 4, wait: 1000 }]);
		await expect(
			r.ipc.invoke(PREVIEW_STREAM_POLL, viewerCaller(viewer), [{ ack: 1, wait: 25_000 }]),
		).rejects.toThrow();
		expect(await r.ipc.invoke(PREVIEW_STREAM_COPY, viewerCaller(viewer), [])).toBe("picked");
		await r.ipc.invoke(PREVIEW_STREAM_DIALOG, viewerCaller(viewer), [{ id: 2, accept: true, text: "Ada" }]);
		expect(r.host.callsOf("dialogAnswer")).toEqual([{ owner: { key: -4 }, id: 2, accept: true, text: "Ada" }]);

		await expect(r.ipc.invoke(PREVIEW_STREAM_POLL, windowCaller(win), [{ ack: null }])).rejects.toThrow(
			"No streamed preview page",
		);
		r.ipc.send(PREVIEW_STREAM_INPUT, windowCaller(win), [[{ t: "tap", x: 0.5, y: 0.5 }]]);
		r.ipc.send(PREVIEW_STREAM_INPUT, viewerCaller(viewer), [[{ t: "tap", x: 0.5, y: 0.5 }]]);
		r.ipc.send(PREVIEW_STREAM_INPUT, viewerCaller(viewer), ["not an array"]);
		r.ipc.send(PREVIEW_STREAM_INPUT, viewerCaller(viewer), [
			Array.from({ length: 65 }, () => ({ t: "hover", x: 0, y: 0 })),
		]);
		expect(r.host.eventsOf("input")).toEqual([{ owner: { key: -4 }, events: [{ t: "tap", x: 0.5, y: 0.5 }] }]);
	});

	it("sends a viewer's PDF as base64 with its title, and refuses one over the module's cap", async () => {
		const viewer = new FakeViewer(-4);
		r.host.answers.set("preview.pdfName", () => ({ name: "Report" }));
		r.host.bins.set("preview.pdf", Buffer.from("%PDF-1.7 body"));
		expect(await r.ipc.invoke(PREVIEW_STREAM_PDF, viewerCaller(viewer), [])).toEqual({
			name: "Report.pdf",
			base64: Buffer.from("%PDF-1.7 body").toString("base64"),
		});
		expect(r.host.callsOf("pdf")).toEqual([{ owner: { key: -4 }, maxBytes: 5 * 1024 * 1024 }]);
		r.host.answers.set("preview.pdf", () => {
			throw new Error("The page's PDF is too large to send over this link");
		});
		await expect(r.ipc.invoke(PREVIEW_STREAM_PDF, viewerCaller(viewer), [])).rejects.toThrow("too large");
	});

	describe("Save as PDF", () => {
		let dir: string;
		beforeEach(async () => {
			dir = await mkdtemp(path.join(os.tmpdir(), "preview-pdf-"));
			r.host.answers.set("preview.pdfName", () => ({ name: "My page" }));
			r.host.bins.set("preview.pdf", Buffer.from("%PDF-1.7 saved"));
		});
		afterEach(() => rm(dir, { recursive: true, force: true }));

		it("writes the page's PDF where the save dialog points", async () => {
			const win = new FakeWindow(3, 17);
			const file = path.join(dir, "out.pdf");
			electron.saved = { canceled: false, filePath: file };
			expect(await r.ipc.invoke(PREVIEW_SAVE_PDF, windowCaller(win), [])).toBe(file);
			expect((await readFile(file)).toString()).toBe("%PDF-1.7 saved");
			expect(r.host.callsOf("pdf")).toEqual([{ owner: { key: 17, winId: 3 } }]);
		});

		it("asks the module for the PDF only after the person chose a file, and writes nothing when they cancel", async () => {
			const win = new FakeWindow(3, 17);
			electron.saved = { canceled: true };
			expect(await r.ipc.invoke(PREVIEW_SAVE_PDF, windowCaller(win), [])).toBeNull();
			expect(r.host.callsOf("pdf")).toEqual([]);
		});

		it("is an app window's: a viewer has no window to ask on", async () => {
			await expect(r.ipc.invoke(PREVIEW_SAVE_PDF, viewerCaller(new FakeViewer(-4)), [])).rejects.toThrow(
				"Invalid preview owner",
			);
		});
	});
});

describe("agent browsing over a relay socket", () => {
	const OWNER = { key: 17, winId: 3 };
	const open = () => {
		const opening = Promise.withResolvers<void>();
		return { socket: new FakeRelaySocket(opening.promise), opening };
	};
	let r: Rig;
	let win: FakeWindow;
	const ask = (request: object) => r.ipc.invoke(PREVIEW_COMMAND, windowCaller(win), [request]);
	beforeEach(() => {
		r = rig();
		win = new FakeWindow(3, 17);
		r.deps.remote.add("tab");
		r.host.answers.set("preview.command", () => state());
		r.host.answers.set("preview.agentStart", () =>
			state({ agent: { tabId: "tab", attached: false, lastAction: "" } }),
		);
		r.host.answers.set("preview.agentReady", () =>
			state({ agent: { tabId: "tab", attached: false, lastAction: "" } }),
		);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("opens the tunnel, starts the module's agent, and says hello only once the tunnel is open, never dialing the host's address", async () => {
		const dialed = vi.fn();
		vi.stubGlobal("WebSocket", dialed);
		const { socket, opening } = open();
		r.tunnel.socket = socket;
		const starting = ask(RELAY);
		await vi.waitFor(() => expect(r.host.callsOf("agentStart")).toHaveLength(1));
		// The banner's state is the module's while the tunnel opens; nothing is said to the relay before it is open.
		expect(r.host.callsOf("agentStart")).toEqual([{ owner: OWNER, remote: true, tabId: "tab" }]);
		expect(r.host.callsOf("agentReady")).toEqual([]);
		opening.resolve();
		expect(((await starting) as PreviewState).agent).toEqual({ tabId: "tab", attached: false, lastAction: "" });
		expect(r.host.callsOf("agentReady")).toEqual([{ owner: OWNER }]);
		expect(dialed).not.toHaveBeenCalled();
	});

	it("pipes frames both ways: the relay's to the module, the module's to the relay once open", async () => {
		const { socket, opening } = open();
		r.tunnel.socket = socket;
		opening.resolve();
		await ask(RELAY);
		socket.push({ t: "rpc", id: 1, op: "attach" });
		expect(r.host.eventsOf("relayIn")).toEqual([
			{ owner: OWNER, data: JSON.stringify({ t: "rpc", id: 1, op: "attach" }) },
		]);
		r.host.emit("relayOut", { owner: OWNER, data: '{"t":"rpcResult","id":1,"ok":true,"result":{}}' });
		expect(socket.sent).toEqual(['{"t":"rpcResult","id":1,"ok":true,"result":{}}']);
	});

	it("closes the socket when the module ends the agent (Take over, another tab, the panel closed)", async () => {
		const { socket, opening } = open();
		r.tunnel.socket = socket;
		opening.resolve();
		await ask(RELAY);
		r.host.emit("relayEnd", { owner: OWNER });
		expect(socket.closed).toBe(true);
		// The close the module asked for is not news to it.
		expect(r.host.eventsOf("relayClosed")).toEqual([]);
	});

	it("tells the module when the relay's socket closes on its own", async () => {
		const { socket, opening } = open();
		r.tunnel.socket = socket;
		opening.resolve();
		await ask(RELAY);
		socket.close();
		expect(r.host.eventsOf("relayClosed")).toEqual([{ owner: OWNER }]);
	});

	it("says why when the host's relay cannot be reached, and tells the module", async () => {
		const failing = open();
		r.tunnel.socket = failing.socket;
		failing.opening.reject(new Error("[relay_unavailable] This tab has no browser relay running"));
		await expect(ask(RELAY)).rejects.toThrow("no browser relay");
		expect(r.host.eventsOf("relayClosed")).toEqual([{ owner: OWNER }]);
		expect(failing.socket.closed).toBe(true);
		expect(r.host.callsOf("agentReady")).toEqual([]);
	});

	it("refuses a tab with no tunnel, and an endpoint that is not stock's loopback relay, without opening anything", async () => {
		const dialed = vi.fn();
		vi.stubGlobal("WebSocket", dialed);
		r.tunnel.socket = null;
		await expect(ask(RELAY)).rejects.toThrow("not available for this tab");
		await expect(ask({ ...RELAY, url: "http://localhost:9333" })).rejects.toThrow("Invalid browser relay endpoint");
		await expect(ask({ ...RELAY, token: "short" })).rejects.toThrow("Invalid browser relay endpoint");
		expect(dialed).not.toHaveBeenCalled();
		expect(r.host.callsOf("agentStart")).toEqual([]);
	});

	it("closes the socket of an agent the module refused (a visual's page), and a new start closes the old socket without telling the module", async () => {
		const refused = open();
		r.tunnel.socket = refused.socket;
		r.host.answers.set("preview.agentStart", () => {
			throw new Error("Agent browsing is for web pages, not visuals");
		});
		await expect(ask(RELAY)).rejects.toThrow("not visuals");
		expect(refused.socket.closed).toBe(true);
		expect(r.host.eventsOf("relayClosed")).toEqual([]);

		r.host.answers.set("preview.agentStart", () => state());
		const first = open();
		first.opening.resolve();
		r.tunnel.socket = first.socket;
		await ask(RELAY);
		const second = open();
		second.opening.resolve();
		r.tunnel.socket = second.socket;
		await ask(RELAY);
		expect(first.socket.closed).toBe(true);
		expect(r.host.eventsOf("relayClosed")).toEqual([]);
	});

	it("drops the socket with the owner", async () => {
		const { socket, opening } = open();
		r.tunnel.socket = socket;
		opening.resolve();
		await ask(RELAY);
		win.emit("closed");
		expect(socket.closed).toBe(true);
		expect(r.host.eventsOf("ownerGone")).toEqual([{ owner: OWNER }]);
	});
});

describe("gui_visualize", () => {
	const tab = (win: FakeWindow, rpc: unknown) => ({
		tabId: "tab",
		cwd: "/project",
		win: win as unknown as ClientWindow,
		rpc: rpc as never,
	});

	it("asks the module for the tab's call, on its window, with the switch and whether the tab is in front", async () => {
		const r = rig();
		const win = new FakeWindow(3, 17);
		r.host.answers.set("preview.visualize", () => ({ text: "Showing it", isError: false }));
		r.prefs.judge = true;
		r.prefs.active = "tab";
		expect(await r.client.visualize(tab(win, null), { action: "open", html: "<p>x</p>" })).toEqual({
			text: "Showing it",
			isError: false,
		});
		r.prefs.judge = false;
		r.prefs.active = "other";
		await r.client.visualize(tab(win, null), { action: "check", visual: "v" });
		expect(r.host.callsOf("visualize")).toEqual([
			{
				tabId: "tab",
				cwd: "/project",
				winId: 3,
				judge: true,
				inFront: true,
				args: { action: "open", html: "<p>x</p>" },
			},
			{
				tabId: "tab",
				cwd: "/project",
				winId: 3,
				judge: false,
				inFront: false,
				args: { action: "check", visual: "v" },
			},
		]);
	});

	it("shows the visual to the tab's window when the module reveals it, during the call only", async () => {
		const r = rig();
		const win = new FakeWindow(3, 17);
		const finished = Promise.withResolvers<void>();
		r.host.answers.set("preview.visualize", async () => {
			r.host.emit("reveal", { tabId: "tab", visualId: "abc" });
			await finished.promise;
			return { text: "done", isError: false };
		});
		const running = r.client.visualize(tab(win, null), {});
		await vi.waitFor(() => expect(win.sent).toEqual([[PREVIEW_VISUAL, { tabId: "tab", visualId: "abc" }]]));
		finished.resolve();
		await running;
		r.host.emit("reveal", { tabId: "tab", visualId: "late" });
		expect(win.sent).toHaveLength(1);
	});

	it("serves the module's judge asks through the tab's own omp, with the probe's bound as the command's", async () => {
		const r = rig();
		const win = new FakeWindow(3, 17);
		const rpc = {
			command: vi.fn(async (command: { type: string }) =>
				command.type === "judge_available"
					? { success: true, data: { available: true } }
					: { success: true, data: { judged: true, problem: "error" } },
			),
		};
		const running = Promise.withResolvers<void>();
		const answers: unknown[] = [];
		r.host.answers.set("preview.visualize", async () => {
			answers.push(await r.host.ask("judgeAvailable", { tabId: "tab", budgetMs: 1500 }));
			answers.push(
				await r.host.ask("judge", { tabId: "tab", image: { data: "AAAA", mimeType: "image/png" }, budgetMs: 3000 }),
			);
			running.resolve();
			return { text: "ok", isError: false };
		});
		await r.client.visualize(tab(win, rpc), {});
		await running.promise;
		expect(answers).toEqual([{ available: true }, { judged: true, problem: "error" }]);
		expect(rpc.command.mock.calls).toEqual([
			[{ type: "judge_available" }, 1500],
			[{ type: "judge_preview_check", image: { data: "AAAA", mimeType: "image/png" } }, 3000],
		]);
	});

	it.each([
		["the tab's omp is not running", null, { available: false }, { judged: false, problem: null }],
		[
			"the omp answers with a failure",
			{ command: vi.fn(async () => ({ success: false })) },
			{ available: false },
			{ judged: false, problem: null },
		],
		[
			"the omp names a verdict that is no problem",
			{ command: vi.fn(async () => ({ success: true, data: { judged: true, problem: "fine" } })) },
			{ available: false },
			{ judged: true, problem: null },
		],
	])("keeps today's behaviour when %s", async (_name, rpc, available, judged) => {
		const r = rig();
		const win = new FakeWindow(3, 17);
		const got: unknown[] = [];
		r.host.answers.set("preview.visualize", async () => {
			got.push(await r.host.ask("judgeAvailable", { tabId: "tab", budgetMs: 1500 }));
			got.push(
				await r.host.ask("judge", { tabId: "tab", image: { data: "AAAA", mimeType: "image/png" }, budgetMs: 3000 }),
			);
			return { text: "ok", isError: false };
		});
		await r.client.visualize(tab(win, rpc), {});
		expect(got).toEqual([available, judged]);
	});

	it("is a refusal the caller sees, not a hang, when the module fails the call", async () => {
		const r = rig();
		r.host.answers.set("preview.visualize", () => {
			throw new Error("the shell went away");
		});
		await expect(r.client.visualize(tab(new FakeWindow(3, 17), null), {})).rejects.toThrow("the shell went away");
	});
});

describe("relayExtensionUrl", () => {
	it("accepts only stock's loopback relay with a token", () => {
		const token = "abcdefghijklmnopqrstuvwxyz012345";
		expect(relayExtensionUrl("http://127.0.0.1:9333", token)).toBe(`ws://127.0.0.1:9333/ext?token=${token}`);
		expect(relayExtensionUrl("http://localhost:9333", token)).toBeNull();
		expect(relayExtensionUrl("http://127.0.0.1:9333/x", token)).toBeNull();
		expect(relayExtensionUrl("https://127.0.0.1:9333", token)).toBeNull();
		expect(relayExtensionUrl("http://127.0.0.1:9333", "short")).toBeNull();
		expect(relayExtensionUrl("not a url", token)).toBeNull();
	});
});
