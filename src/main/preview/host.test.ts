/**
 * The preview host (main) against a fake Electron: what one window's preview keeps
 * alive between hosts (its two sessions), what it leaves behind when it is disposed,
 * and where a page may go: a visual's page stays in its visual, a web page on the web.
 */
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_COMMAND, type PreviewState, VISUAL_SCHEME } from "../../shared/preview";
import { IpcRegistry } from "../web/ipc-registry";
import { registerPreviewHost } from "./host";
import { parseVisualUrl } from "./visual-navigation";

type VisualHandler = (request: { url: string }) => Promise<Response>;
type CommandHandler = (event: { sender: FakeContents }, request: unknown) => Promise<PreviewState>;
type OpenHandler = (details: { url: string }) => { action: string };

const electron = vi.hoisted(() => ({
	handlers: new Map<string, unknown>(),
	partitions: new Map<string, unknown>(),
	requested: [] as string[],
}));

class FakeSession extends EventEmitter {
	readonly handled = new Map<string, VisualHandler>();
	clears = 0;
	proxy: unknown = null;
	readonly protocol = {
		handle: (scheme: string, handler: VisualHandler) => {
			// Electron throws when a scheme is handled twice on one session.
			if (this.handled.has(scheme)) throw new Error(`The scheme '${scheme}' has been registered`);
			this.handled.set(scheme, handler);
		},
	};
	userAgent: [string, string?] = ["Mozilla/5.0 Electron"];
	readonly availableSpellCheckerLanguages = ["en-US", "de-DE"];
	setPermissionRequestHandler(): void {}
	setPermissionCheckHandler(): void {}
	getUserAgent(): string {
		return this.userAgent[0];
	}
	setUserAgent(userAgent: string, acceptLanguages?: string): void {
		this.userAgent = [userAgent, acceptLanguages];
	}
	getSpellCheckerLanguages(): string[] {
		return ["en-US"];
	}
	setSpellCheckerLanguages(): void {}
	async setProxy(config: unknown): Promise<void> {
		this.proxy = config;
	}
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
	/** The session the page was made in (the view's `webPreferences.session`). */
	session: FakeSession | null = null;
	closed = false;
	webrtc = "default";
	readonly loaded: string[] = [];
	openHandler: OpenHandler | null = null;
	readonly navigationHistory = { canGoBack: () => false, canGoForward: () => false };
	isDestroyed(): boolean {
		return this.closed;
	}
	send(): void {}
	setWindowOpenHandler(handler: OpenHandler): void {
		this.openHandler = handler;
	}
	setWebRTCIPHandlingPolicy(policy: string): void {
		this.webrtc = policy;
	}
	async loadURL(url: string): Promise<void> {
		this.loaded.push(url);
	}
	getURL(): string {
		return this.loaded.at(-1) ?? "";
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
	constructor(options?: { webPreferences?: { session?: FakeSession } }) {
		this.webContents.session = options?.webPreferences?.session ?? null;
	}
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
	app: { getPath: () => "/tmp", getPreferredSystemLanguages: () => ["de-DE"] },
	dialog: {},
	BrowserWindow: { fromWebContents: (sender: FakeContents) => sender.window },
	session: {
		fromPartition: (name: string) => {
			electron.requested.push(name);
			const found = electron.partitions.get(name) ?? new FakeSession();
			electron.partitions.set(name, found);
			return found;
		},
	},
	WebContentsView: function WebContentsView(options?: { webPreferences?: { session?: FakeSession } }) {
		return new FakeView(options);
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

const VISUAL = "0123456789abcdef";
const OTHER = "fedcba9876543210";

function register(serve = vi.fn(async () => new Response("served"))) {
	// Only the slice of the store the host reads: one file visual, `VISUAL`, with versions 1 and 2.
	const visuals = {
		parse: parseVisualUrl,
		view: (id: string, version?: number) => (id === VISUAL ? { version: version ?? 2 } : null),
		url: (id: string, version = 2) => (id === VISUAL ? `${VISUAL_SCHEME}://v${version}-${id}/index.html` : null),
		serve,
		list: async () => [],
		forTab: () => [VISUAL],
		addToTab: async () => true,
	};
	const ipc = new IpcRegistry({ handle: (channel, handler) => electron.handlers.set(channel, handler), on: () => {} });
	registerPreviewHost(ipc, () => false, visuals as never);
	return serve;
}

/** The page asks to go to `url` (a link, `location`, a meta refresh…); true when the host let it. */
function navigate(contents: FakeContents, url: string, isMainFrame = true, event = "will-frame-navigate"): boolean {
	const preventDefault = vi.fn();
	contents.emit(event, { url, isMainFrame, preventDefault });
	return preventDefault.mock.calls.length === 0;
}

/** A real mouse release on the page, as Electron's `input-event` reports it. */
const release = (contents: FakeContents) => contents.emit("input-event", {}, { type: "mouseUp" });

/** A window showing `VISUAL` in its one tab; its page's contents. */
async function showVisual() {
	register();
	const window = openWindow();
	await window.ask({ action: "showVisual", tabId: "tab", visualId: VISUAL });
	const [page] = window.pages();
	if (!page) throw new Error("no page");
	return { ...window, page };
}

beforeEach(() => {
	electron.handlers.clear();
	electron.partitions.clear();
	electron.requested.length = 0;
});

describe("preview host", () => {
	it("keeps one pair of sessions per window across hosts and forgets what the last host browsed", async () => {
		register();
		const first = openWindow();
		await first.ask({ action: "clearProblems" });
		// The packaged locales leave Chromium on en-US; pages get the system's languages instead.
		expect(sessionOf(`preview-${first.win.id}`).userAgent).toEqual(["Mozilla/5.0 Electron", "de-DE,de,en-US,en"]);
		const web = sessionOf(`preview-${first.win.id}`);
		const visual = sessionOf(`preview-visual-${first.win.id}`);
		await first.ask({ action: "dispose" });
		await first.ask({ action: "clearProblems" });
		await first.ask({ action: "dispose" });
		await first.ask({ action: "clearProblems" });
		// Two names, two sessions, one protocol handler (a second `handle` would throw).
		expect(new Set(electron.requested)).toEqual(
			new Set([`preview-${first.win.id}`, `preview-visual-${first.win.id}`]),
		);
		expect(electron.partitions.size).toBe(2);
		expect(web.clears).toBe(2);
		expect(visual.clears).toBe(2);
		// Another window keeps its own.
		const second = openWindow();
		await second.ask({ action: "clearProblems" });
		expect(electron.partitions.size).toBe(4);
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

	it("serves omp-visual only on the visual session, which has no route out", async () => {
		const serve = register();
		const { win, ask } = openWindow();
		await ask({ action: "clearProblems" });
		expect(sessionOf(`preview-${win.id}`).handled.has(VISUAL_SCHEME)).toBe(false);
		expect(sessionOf(`preview-${win.id}`).proxy).toBeNull();
		const visual = sessionOf(`preview-visual-${win.id}`);
		expect(visual.proxy).toEqual({
			mode: "fixed_servers",
			proxyRules: "http://127.0.0.1:1",
			proxyBypassRules: "<-loopback>",
		});
		const response = await visual.handled.get(VISUAL_SCHEME)?.({
			url: "omp-visual://v1-0123456789abcdef/index.html",
		});
		expect(await response?.text()).toBe("served");
		expect(serve).toHaveBeenCalledWith("omp-visual://v1-0123456789abcdef/index.html");
	});

	it("shows a visual in a page of the visual session, replacing an empty web tab, never loading it into the web", async () => {
		const { win, ask, page, pages } = await showVisual();
		expect(pages()).toHaveLength(1);
		expect(page.session).toBe(sessionOf(`preview-visual-${win.id}`));
		expect(page.loaded).toEqual([`omp-visual://v2-${VISUAL}/index.html`]);
		// WebRTC over UDP never leaves; over TCP it meets the session's dead proxy.
		expect(page.webrtc).toBe("disable_non_proxied_udp");
		expect((await ask({ action: "clearProblems" })).session).toBe("visual");

		// An address the user types on a visual's tab opens a web tab beside it.
		const state = await ask({ action: "load", url: "https://example.com/" });
		expect(state.session).toBe("web");
		expect(pages()).toHaveLength(2);
		const web = pages()[1];
		expect(web?.session).toBe(sessionOf(`preview-${win.id}`));
		expect(web?.loaded).toEqual(["https://example.com/"]);
		expect(web?.webrtc).toBe("default");
		expect(page.loaded).toHaveLength(1);
	});

	it("keeps a visual's page inside its own visual, whatever the page starts", async () => {
		const { page, pages } = await showVisual();
		// Leaving for the web, by link, `location`, form, meta refresh or a frame, never happens.
		expect(navigate(page, "https://evil.example/?d=secret")).toBe(false);
		expect(navigate(page, "http://127.0.0.1:9/")).toBe(false);
		expect(navigate(page, "https://evil.example/frame", false)).toBe(false);
		expect(navigate(page, "data:text/html,<p>x")).toBe(false);
		expect(navigate(page, `blob:omp-visual://v2-${VISUAL}/uuid`)).toBe(false);
		expect(navigate(page, `omp-visual://v1-${OTHER}/index.html`)).toBe(false);
		// Nor through a redirect.
		expect(navigate(page, "https://evil.example/", true, "will-redirect")).toBe(false);
		// Within its own visual (any version) and to an empty document it may.
		expect(navigate(page, `omp-visual://v1-${VISUAL}/index.html`)).toBe(true);
		expect(navigate(page, `omp-visual://v2-${VISUAL}/other.html#x`)).toBe(true);
		expect(navigate(page, "about:blank")).toBe(true);
		expect(navigate(page, "about:srcdoc", false)).toBe(true);
		// Its popups never open, as tabs or otherwise.
		expect(page.openHandler?.({ url: "https://evil.example/?d=secret" })).toEqual({ action: "deny" });
		expect(page.openHandler?.({ url: `omp-visual://v2-${VISUAL}/index.html` })).toEqual({ action: "deny" });
		expect(pages()).toHaveLength(1);
		expect(page.loaded).toHaveLength(1);
	});

	it("offers the whole address a visual tried to open only right after the user's own click", async () => {
		const { page, ask } = await showVisual();
		const url = "https://docs.example/guide?q=a%20b#part";
		// A script's navigation or popup, with no real input, is refused without a word.
		navigate(page, url);
		page.openHandler?.({ url });
		expect((await ask({ action: "clearProblems" })).notice).toBeNull();
		// A frame's is refused too, without an offer.
		release(page);
		navigate(page, url, false);
		expect((await ask({ action: "clearProblems" })).notice).toBeNull();
		// After a real release on the page, the user sees it in full and decides.
		navigate(page, url);
		expect((await ask({ action: "clearProblems" })).notice).toEqual({ kind: "link", url });
		await ask({ action: "dismissNotice" });
		release(page);
		page.openHandler?.({ url: "https://other.example/" });
		expect((await ask({ action: "clearProblems" })).notice).toEqual({ kind: "link", url: "https://other.example/" });
		// Never for something that is no web address.
		await ask({ action: "dismissNotice" });
		release(page);
		navigate(page, "file:///etc/passwd");
		expect((await ask({ action: "clearProblems" })).notice).toBeNull();
	});

	it("keeps a web page on web addresses and opens its popups as web tabs", async () => {
		register();
		const { ask, pages } = openWindow();
		await ask({ action: "load", url: "https://example.com/" });
		const [web] = pages();
		if (!web) throw new Error("no page");
		expect(navigate(web, "https://example.org/")).toBe(true);
		expect(navigate(web, `omp-visual://v2-${VISUAL}/index.html`)).toBe(false);
		expect(navigate(web, "file:///etc/passwd")).toBe(false);
		expect(web.openHandler?.({ url: "https://example.org/popup" })).toEqual({ action: "deny" });
		expect(pages()).toHaveLength(2);
		expect(pages()[1]?.loaded).toEqual(["https://example.org/popup"]);
	});

	it("never lets the agent's browser onto a visual's page", async () => {
		const { ask } = await showVisual();
		await expect(
			ask({ action: "agentStart", tabId: "tab", url: "ws://127.0.0.1:1/extension", token: "x".repeat(32) }),
		).rejects.toThrow("Agent browsing is for web pages, not visuals");
	});
});
