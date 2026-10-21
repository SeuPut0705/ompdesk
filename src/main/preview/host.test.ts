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
import { type CapturedImage, PREVIEW_CHECK_BEHIND_MS } from "./preview-check";
import { parseVisualUrl } from "./visual-navigation";
import type { VisualPages } from "./visuals";

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
	readonly capturePage = vi.fn(async () => pngCapture());
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
	setBounds(): void {}
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

/** A capture as Electron's `NativeImage` gives it: `PNG` bytes, empty when nothing was painted. */
function pngCapture(empty = false): CapturedImage {
	return {
		isEmpty: () => empty,
		getSize: () => ({ width: 800, height: 600 }),
		resize: () => pngCapture(),
		toPNG: () => Buffer.from("png"),
	};
}

let visualPages: VisualPages | undefined;

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
/** An http(s) visual: its page is in the session the person browses. */
const WEB_VISUAL = "aaaaaaaaaaaaaaaa";
const WEB_URL = "https://example.com/";

function register(serve = vi.fn(async () => new Response("served"))) {
	// Only the slice of the store the host reads: one file visual, `VISUAL`, with versions 1 and 2, and one web visual.
	const visuals = {
		parse: parseVisualUrl,
		view: (id: string, version?: number) =>
			id === VISUAL ? { version: version ?? 2 } : id === WEB_VISUAL ? { version: 1 } : null,
		url: (id: string, version = 2) =>
			id === VISUAL ? `${VISUAL_SCHEME}://v${version}-${id}/index.html` : id === WEB_VISUAL ? WEB_URL : null,
		serve,
		list: async () => [],
		forTab: () => [VISUAL, WEB_VISUAL],
		addToTab: async () => true,
	};
	const ipc = new IpcRegistry({ handle: (channel, handler) => electron.handlers.set(channel, handler), on: () => {} });
	visualPages = registerPreviewHost(ipc, () => false, visuals as never);
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

	describe("Preview check", () => {
		const BOUNDS = { x: 0, y: 0, width: 600, height: 400 };
		const BEHIND = PREVIEW_CHECK_BEHIND_MS;
		/** The visual's page, laid out on screen and done loading. */
		async function loadedVisual() {
			const shown = await showVisual();
			await shown.ask({ action: "layout", bounds: BOUNDS, visible: true });
			shown.page.emit("did-stop-loading");
			return shown;
		}

		it("captures only the visual's own page once it is on screen and loaded, as a PNG", async () => {
			const { page } = await loadedVisual();
			const image = await visualPages?.capture(VISUAL, 2, 2000, BEHIND);
			expect(image).toEqual({ data: Buffer.from("png").toString("base64"), mimeType: "image/png" });
			expect(page.capturePage).toHaveBeenCalledTimes(1);
		});

		it.each([
			["a page that is not on screen", false, true, VISUAL, 2],
			["a page still loading", true, false, VISUAL, 2],
			["a version the page does not show", true, true, VISUAL, 1],
			["a visual no page shows", true, true, OTHER, 2],
		])("captures nothing for %s", async (_name, onScreen, loaded, visualId, version) => {
			const { page, ask } = await showVisual();
			if (onScreen) await ask({ action: "layout", bounds: BOUNDS, visible: true });
			if (loaded) page.emit("did-stop-loading");
			expect(await visualPages?.capture(visualId, version, 150, BEHIND)).toBeNull();
			expect(page.capturePage).not.toHaveBeenCalled();
		});

		it("gives up at once on a page of a tab behind, without spending the capture budget", async () => {
			vi.useFakeTimers();
			try {
				// The page exists but its panel is not on screen (no layout), and its tab is not in front: nobody shows it now.
				const { page } = await showVisual();
				page.emit("did-stop-loading");
				let answer: unknown = "pending";
				void visualPages?.capture(VISUAL, 2, 2000, BEHIND).then(image => {
					answer = image;
				});
				await vi.advanceTimersByTimeAsync(399);
				expect(answer).toBe("pending");
				await vi.advanceTimersByTimeAsync(100);
				expect(answer).toBeNull();
				expect(page.capturePage).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		it("gives a page of the tab in front the whole budget to reach the screen: a busy window mounts its panel late", async () => {
			vi.useFakeTimers();
			try {
				// e2e on a renderer 4x and 8x slower: the page was asked for and still not laid out 450 ms after the tool opened it.
				const { page, ask } = await showVisual();
				let answer: unknown = "pending";
				void visualPages?.capture(VISUAL, 2, 2000, 2000).then(image => {
					answer = image;
				});
				await vi.advanceTimersByTimeAsync(1200);
				expect(answer).toBe("pending");
				await ask({ action: "layout", bounds: BOUNDS, visible: true });
				page.emit("did-stop-loading");
				await vi.advanceTimersByTimeAsync(400);
				expect(answer).toEqual({ data: Buffer.from("png").toString("base64"), mimeType: "image/png" });
			} finally {
				vi.useRealTimers();
			}
		});

		it("still gives up when the budget runs out for a tab in front that never reaches the screen", async () => {
			vi.useFakeTimers();
			try {
				const { page } = await showVisual();
				page.emit("did-stop-loading");
				let answer: unknown = "pending";
				void visualPages?.capture(VISUAL, 2, 2000, 2000).then(image => {
					answer = image;
				});
				await vi.advanceTimersByTimeAsync(1900);
				expect(answer).toBe("pending");
				await vi.advanceTimersByTimeAsync(150);
				expect(answer).toBeNull();
				expect(page.capturePage).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		it("still waits for a page that appears on screen a moment after the tool opened it", async () => {
			vi.useFakeTimers();
			try {
				const { page, ask } = await showVisual();
				let answer: unknown = "pending";
				void visualPages?.capture(VISUAL, 2, 2000, BEHIND).then(image => {
					answer = image;
				});
				await vi.advanceTimersByTimeAsync(200);
				await ask({ action: "layout", bounds: BOUNDS, visible: true });
				page.emit("did-stop-loading");
				await vi.advanceTimersByTimeAsync(400);
				expect(answer).toEqual({ data: Buffer.from("png").toString("base64"), mimeType: "image/png" });
			} finally {
				vi.useRealTimers();
			}
		});

		it("never captures a web visual's page, which may show a site the person moved to; a visual-session page is captured", async () => {
			register();
			const { ask, pages } = openWindow();
			await ask({ action: "showVisual", tabId: "tab", visualId: WEB_VISUAL });
			const [web] = pages();
			if (!web) throw new Error("no page");
			await ask({ action: "layout", bounds: BOUNDS, visible: true });
			web.emit("did-stop-loading");
			expect(web.loaded).toEqual([WEB_URL]);
			expect(await visualPages?.capture(WEB_VISUAL, 1, 600, BEHIND)).toBeNull();
			expect(web.capturePage).not.toHaveBeenCalled();
			// Nor does a notice land on it.
			visualPages?.flag(WEB_VISUAL, 1, "error");
			expect((await ask({ action: "clearProblems" })).notice).toBeNull();

			// The person browsing on away from it changes nothing: the page keeps its visual, still never captured.
			web.emit("did-navigate", {}, "https://bank.example/account");
			expect(await visualPages?.capture(WEB_VISUAL, 1, 600, BEHIND)).toBeNull();
			expect(web.capturePage).not.toHaveBeenCalled();

			// A file visual in the visual session beside it is.
			await ask({ action: "showVisual", tabId: "tab", visualId: VISUAL });
			const visual = pages().find(contents => contents !== web);
			if (!visual) throw new Error("no visual page");
			visual.emit("did-stop-loading");
			expect(await visualPages?.capture(VISUAL, 2, 2000, BEHIND)).not.toBeNull();
			expect(visual.capturePage).toHaveBeenCalledTimes(1);
		});

		it("treats a capture with no pixels as no capture", async () => {
			const { page } = await loadedVisual();
			page.capturePage.mockResolvedValueOnce(pngCapture(true));
			expect(await visualPages?.capture(VISUAL, 2, 2000, BEHIND)).toBeNull();
		});

		it("shows the judge's notice on that page, never over another notice, and drops it when the page reloads", async () => {
			const { page, ask } = await loadedVisual();
			visualPages?.flag(VISUAL, 2, "blank");
			expect((await ask({ action: "clearProblems" })).notice).toEqual({ kind: "check", problem: "blank" });
			await ask({ action: "dismissNotice" });
			expect((await ask({ action: "clearProblems" })).notice).toBeNull();

			visualPages?.flag(VISUAL, 2, "error");
			expect((await ask({ action: "clearProblems" })).notice).toEqual({ kind: "check", problem: "error" });
			page.emit("did-start-loading");
			expect((await ask({ action: "clearProblems" })).notice).toBeNull();

			page.emit("unresponsive");
			visualPages?.flag(VISUAL, 2, "error");
			expect((await ask({ action: "clearProblems" })).notice).toEqual({ kind: "unresponsive" });
		});

		it("flags only the version the page shows", async () => {
			const { ask } = await loadedVisual();
			visualPages?.flag(VISUAL, 1, "error");
			expect((await ask({ action: "clearProblems" })).notice).toBeNull();
		});
	});
});
