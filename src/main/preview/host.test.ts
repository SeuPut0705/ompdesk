/**
 * The preview host (main) against a fake Electron: what one window's preview keeps
 * alive between hosts (its partition) and what it leaves behind when it is disposed.
 */
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_COMMAND, VISUAL_SCHEME } from "../../shared/preview";
import { registerPreviewHost } from "./host";

type VisualHandler = (request: { url: string }) => Promise<Response>;
type CommandHandler = (event: { sender: FakeContents }, request: unknown) => Promise<unknown>;

const electron = vi.hoisted(() => ({
	handlers: new Map<string, unknown>(),
	partitions: new Map<string, unknown>(),
	requested: [] as string[],
}));

class FakeSession extends EventEmitter {
	readonly handled = new Map<string, VisualHandler>();
	clears = 0;
	readonly protocol = {
		handle: (scheme: string, handler: VisualHandler) => {
			// Electron throws when a scheme is handled twice on one session.
			if (this.handled.has(scheme)) throw new Error(`The scheme '${scheme}' has been registered`);
			this.handled.set(scheme, handler);
		},
	};
	setPermissionRequestHandler(): void {}
	setPermissionCheckHandler(): void {}
	async clearStorageData(): Promise<void> {
		this.clears += 1;
	}
	async clearCache(): Promise<void> {}
}

class FakeContents extends EventEmitter {
	static next = 1;
	readonly id = FakeContents.next++;
	/** The window this is the app renderer of (the preview's `BrowserWindow.fromWebContents`). */
	window: FakeWindow | null = null;
	closed = false;
	readonly navigationHistory = { canGoBack: () => false, canGoForward: () => false };
	isDestroyed(): boolean {
		return this.closed;
	}
	send(): void {}
	setWindowOpenHandler(): void {}
	getURL(): string {
		return "";
	}
	getTitle(): string {
		return "";
	}
	isLoading(): boolean {
		return false;
	}
	getZoomFactor(): number {
		return 1;
	}
	setZoomFactor(): void {}
	close(): void {
		this.closed = true;
	}
}

class FakeView {
	readonly webContents = new FakeContents();
	setVisible(): void {}
}

class FakeWindow extends EventEmitter {
	static next = 1;
	readonly id = FakeWindow.next++;
	readonly webContents = new FakeContents();
	readonly views = new Set<FakeView>();
	readonly contentView = {
		addChildView: (view: FakeView) => this.views.add(view),
		removeChildView: (view: FakeView) => this.views.delete(view),
	};
	constructor() {
		super();
		this.webContents.window = this;
	}
	isDestroyed(): boolean {
		return false;
	}
	getContentSize(): [number, number] {
		return [1000, 800];
	}
}

// The factory only builds lookups; the fakes above are used when the host calls them.
vi.mock("electron", () => ({
	app: { getPath: () => "/tmp" },
	dialog: {},
	ipcMain: { handle: (channel: string, handler: unknown) => electron.handlers.set(channel, handler) },
	BrowserWindow: { fromWebContents: (sender: FakeContents) => sender.window },
	session: {
		fromPartition: (name: string) => {
			electron.requested.push(name);
			const found = electron.partitions.get(name) ?? new FakeSession();
			electron.partitions.set(name, found);
			return found;
		},
	},
	WebContentsView: function WebContentsView() {
		return new FakeView();
	},
}));

/** A window whose renderer asks the preview host for things, as `PREVIEW_COMMAND` does. */
function openWindow() {
	const win = new FakeWindow();
	const command = electron.handlers.get(PREVIEW_COMMAND) as CommandHandler;
	return {
		win,
		sender: win.webContents,
		ask: (request: unknown) => command({ sender: win.webContents }, request),
		pages: () => [...win.views].map(view => view.webContents),
	};
}

const sessionOf = (name: string) => electron.partitions.get(name) as FakeSession;

function register(serve = vi.fn(async () => new Response("served"))) {
	// Only the slice of the store the host reads; the page's visual rules are visuals.test.ts's.
	const visuals = { parse: () => null, view: () => null, url: () => null, serve, list: async () => [] };
	registerPreviewHost(() => false, visuals as never);
	return serve;
}

beforeEach(() => {
	electron.handlers.clear();
	electron.partitions.clear();
	electron.requested.length = 0;
});

describe("preview host", () => {
	it("keeps one partition per window across hosts and forgets what the last host browsed", async () => {
		register();
		const first = openWindow();
		await first.ask({ action: "clearProblems" });
		const partition = sessionOf(electron.requested[0] ?? "");
		await first.ask({ action: "dispose" });
		await first.ask({ action: "clearProblems" });
		await first.ask({ action: "dispose" });
		await first.ask({ action: "clearProblems" });
		// One name, one session, one protocol handler (a second `handle` would throw).
		expect(new Set(electron.requested).size).toBe(1);
		expect(electron.partitions.size).toBe(1);
		expect(partition.handled.has(VISUAL_SCHEME)).toBe(true);
		expect(partition.clears).toBe(2);
		// Another window keeps its own.
		const second = openWindow();
		await second.ask({ action: "clearProblems" });
		expect(electron.partitions.size).toBe(2);
	});

	it("leaves no listener on the window or the app renderer once disposed", async () => {
		register();
		const { win, sender, ask } = openWindow();
		for (let round = 0; round < 12; round++) {
			await ask({ action: "clearProblems" });
			expect(win.listenerCount("closed")).toBe(1);
			expect(sender.listenerCount("did-start-navigation")).toBe(1);
			await ask({ action: "dispose" });
			expect(win.listenerCount("closed")).toBe(0);
			expect(sender.listenerCount("did-start-navigation")).toBe(0);
		}
	});

	it("disposes with its window and on the app renderer's own main-frame navigation only", async () => {
		register();
		const { win, sender, ask, pages } = openWindow();
		await ask({ action: "newTab" });
		const shown = pages();
		expect(shown).toHaveLength(2);
		// Frames inside the app and in-page navigation are not a reload.
		sender.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
		sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
		expect(pages()).toHaveLength(2);
		expect(shown.every(contents => !contents.closed)).toBe(true);
		sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
		expect(shown.every(contents => contents.closed)).toBe(true);
		expect(win.views.size).toBe(0);
		expect(win.listenerCount("closed")).toBe(0);

		await ask({ action: "clearProblems" });
		const next = pages();
		expect(next).toHaveLength(1);
		win.emit("closed");
		expect(next.every(contents => contents.closed)).toBe(true);
		expect(sender.listenerCount("did-start-navigation")).toBe(0);
	});

	it("answers every omp-visual request from the store, so each response carries its policy", async () => {
		const serve = register();
		const { ask } = openWindow();
		await ask({ action: "clearProblems" });
		const handler = sessionOf(electron.requested[0] ?? "").handled.get(VISUAL_SCHEME);
		const response = await handler?.({ url: "omp-visual://v1-0123456789abcdef/index.html" });
		expect(await response?.text()).toBe("served");
		expect(serve).toHaveBeenCalledWith("omp-visual://v1-0123456789abcdef/index.html");
	});
});
