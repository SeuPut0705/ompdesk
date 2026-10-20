import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
	type NativeImage,
	type Session,
	session,
	type WebContents,
	WebContentsView,
} from "electron";
import { z } from "zod";
import {
	clampPreviewZoom,
	EMPTY_PREVIEW,
	EMPTY_PREVIEW_PAGE,
	isLoopbackUrl,
	PREVIEW_COMMAND,
	PREVIEW_PAGE,
	PREVIEW_PROBLEM_LIMIT,
	PREVIEW_SAVE_PDF,
	PREVIEW_STATE,
	PREVIEW_STREAM_COPY,
	PREVIEW_STREAM_DIALOG,
	PREVIEW_STREAM_INPUT,
	PREVIEW_STREAM_PDF,
	PREVIEW_STREAM_POLL,
	PREVIEW_TAB_LIMIT,
	PREVIEW_VIEWPORTS,
	PREVIEW_VISUALS,
	type PreviewBounds,
	type PreviewPageRequest,
	type PreviewPageState,
	type PreviewRequest,
	type PreviewState,
	previewUrl,
	VISUAL_SCHEME,
} from "../../shared/preview";
import { applyAcceptLanguages, seedSpellchecker } from "../system-languages";
import { type ClientWindow, isWebWindow } from "../web/client-window";
import type { IpcCaller, IpcRegistry } from "../web/ipc-registry";
import { DIALOG_CHANNEL, dialogRequestSchema, dialogReturnValue } from "../web/preview-dialog";
import { InputMapper, previewStreamBatchSchema } from "../web/preview-input";
import { streamProfile } from "../web/preview-pacer";
import { type OsrPage, PageStream, POLL_MAX_WAIT_MS } from "../web/preview-stream";
import { PreviewRelayExtension, relayExtensionUrl } from "./agent-relay";
import { applyPreviewLayout, fitPreviewFrame, MIN_FRAME_SCALE } from "./layout";
import { PAGE_WORLD, pageCall } from "./page-scripts";
import { judgeImage, PREVIEW_CHECK_SETTLE_MS, withDeadline } from "./preview-check";
import { visualMayNavigate } from "./visual-navigation";
import type { VisualPages, VisualStore } from "./visuals";

/** Activity marks and console problems reach the panel at most this often. */
const AGENT_ACTIVITY_MS = 250;
/** Longest console message kept per problem. */
const PROBLEM_TEXT_MAX = 2000;
/** A `data-choice` click counts for the agent only after a real mouse or key release on that page this recently (C143). */
const GESTURE_WINDOW_MS = 1000;
/** Widest region screenshot sent to the agent, in pixels. */
const REGION_MAX_WIDTH = 1600;
/** The Preview check looks for its page this often, and gives `capturePage` at least this long. */
const CAPTURE_POLL_MS = 50;
const CAPTURE_MIN_MS = 500;
/**
 * `reveal` reaches the renderer, which then asks for the page: a visual that no window shows within this long after
 * the tool opened it is not going to be shown now (panel hidden, tab not in front), so the check gives up.
 */
const CAPTURE_APPEAR_MS = 400;
/** A viewer's poll for a page that does not exist yet (the panel asks before its first layout) is answered after this. */
const NO_PAGE_RETRY_MS = 500;
/** The most selected text, and the largest PDF, a viewer is sent. */
const SELECTION_MAX_CHARS = 100_000;
const PDF_MAX_BYTES = 5 * 1024 * 1024;

const pollRequestSchema = z.object({
	ack: z.number().int().nonnegative().nullable(),
	wait: z.number().int().min(0).max(POLL_MAX_WAIT_MS).optional(),
});
const dialogAnswerSchema = z.object({
	id: z.number().int().positive(),
	accept: z.boolean(),
	text: z.string().max(2000).nullish(),
});

/** A timer the tests' fake clock drives (`node:timers/promises` is not faked). */
function pause(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** A page's title as a file name: no separators or control characters, at most 100 characters. */
function pdfName(title: string): string {
	return (
		title
			.replace(/[\\/:*?"<>|]+/g, " ")
			.replace(/\p{Cc}+/gu, " ")
			.trim()
			.slice(0, 100) || "page"
	);
}
/**
 * The visual session's only route out: a proxy at loopback port 1 (tcpmux, which nothing serves on a desktop),
 * loopback included (`<-loopback>` drops Chromium's implicit loopback bypass), with no DIRECT fallback. Its pages
 * load from `omp-visual:` (no network) and CSP blocks their requests; this catches what CSP cannot, WebRTC over
 * TCP (TURN), which goes through the session's proxy. DNS prefetch (`<link rel=dns-prefetch>`) still resolves.
 */
const VISUAL_NO_ROUTE: Electron.ProxyConfig = {
	mode: "fixed_servers",
	proxyRules: "http://127.0.0.1:1",
	proxyBypassRules: "<-loopback>",
};

const selector = z.string().min(1).max(2000);
const pageRequestSchema: z.ZodType<PreviewPageRequest> = z.discriminatedUnion("action", [
	z.object({ action: z.enum(["pick", "region", "cancel", "tweaks", "clearVariables"]) }),
	z.object({ action: z.enum(["parent", "highlight"]), selector }),
	z.object({
		action: z.literal("pins"),
		pins: z.array(z.object({ n: z.number().int().min(1), selector })).max(100),
	}),
	z.object({
		action: z.literal("setVariable"),
		name: z.string().regex(/^--[\w-]+$/),
		value: z.string().max(500),
	}),
]);

/** One tab of a window's preview: its own sandboxed page in the window's web or visual session. */
interface PreviewPage {
	id: string;
	/** The page's native view in the app window; null for a web viewer's offscreen page. */
	view: WebContentsView | null;
	/** A web viewer's offscreen window (its pixels are streamed, never shown); null for a view. */
	osr: BrowserWindow | null;
	/** The view's WebContents, kept: `view.webContents` reads undefined once the window destroyed the view. */
	contents: WebContents;
	state: PreviewPageState;
	/** Zoom factor last given to the page (user zoom × frame fit). */
	factor: number;
	/** The agent's visual this page shows (`gui_visualize`) and its version. */
	visual: { id: string; version: number } | null;
	/** When the user last released a mouse button or key on this page (epoch ms; the C143 gesture). */
	lastInput: number;
	/** A web viewer's frames, acknowledgements and dialogs; null for a view. */
	stream: PageStream | null;
	/** A web viewer's gesture state (a drag in progress). */
	mapper: InputMapper;
	/** A web viewer's window DIPs per frame CSS px (`placeStreamed`): a wheel delta in frame px is scaled by it. */
	streamScale: number;
}

interface AgentLink {
	socket: WebSocket;
	extension: PreviewRelayExtension;
	/** The one page the relay offers; showing or closing another tab releases it. */
	page: PreviewPage;
}

/** A window's two in-memory sessions, shared by its tabs and by every host of the window. */
interface PreviewSessions {
	/** Web pages: what the user, the agent's browser or a web visual browses. */
	web: Session;
	/** Visual pages (`omp-visual:`): no network route, no WebRTC over UDP, never the agent's browser. */
	visual: Session;
	/** Resolves once the visual session's proxy is in place; no visual loads before. */
	ready: Promise<void>;
}

/** What a host needs of the page that owns it: the app window's renderer, or a web viewer's virtual window. */
interface PreviewSender {
	readonly id: number;
	isDestroyed(): boolean;
	send(channel: string, ...args: unknown[]): void;
}

/** The caller of a preview command: an app window's renderer, or a paired viewer's virtual window. */
interface PreviewOwner {
	win: BrowserWindow | null;
	renderer: WebContents | null;
	viewer: ClientWindow | null;
	sender: PreviewSender;
	remote: (tabId?: string) => boolean;
}

/** An offscreen page as the stream sees it: its paints, its frame rate, and whether it paints at all. */
function osrPage(contents: WebContents): OsrPage {
	return {
		onPaint(listener) {
			const handler = (_event: unknown, _dirty: unknown, image: NativeImage) => listener(image);
			contents.on("paint", handler);
			return () => {
				if (!contents.isDestroyed()) contents.off("paint", handler);
			};
		},
		setFrameRate(fps) {
			if (!contents.isDestroyed()) contents.setFrameRate(fps);
		},
		invalidate() {
			if (!contents.isDestroyed()) contents.invalidate();
		},
		setPainting(painting) {
			if (contents.isDestroyed()) return;
			if (painting) contents.startPainting();
			else contents.stopPainting();
		},
		isDestroyed: () => contents.isDestroyed(),
	};
}

interface PreviewHost {
	/** The app window, null for a web viewer (its pages are offscreen windows, not views). */
	win: BrowserWindow | null;
	/** The app window's renderer; null for a web viewer. */
	renderer: WebContents | null;
	/** A web viewer's virtual window; null for an Electron window. */
	viewer: ClientWindow | null;
	sender: PreviewSender;
	/** Whether the owner's active tab (or `tabId`) runs on a paired host: its loopback addresses stay blocked. */
	remote: (tabId?: string) => boolean;
	sessions: PreviewSessions;
	pages: PreviewPage[];
	active: PreviewPage;
	agent: AgentLink | null;
	/** The panel's last surface box, kept to re-fit the page when the viewport frame or the tab changes. */
	layout: { bounds: PreviewBounds; visible: boolean; dpr: number } | null;
	/** Frame numbers of a web viewer's streams share one counter, so an acknowledgement never names another page's frame. */
	nextSeq: (() => number) | null;
	/** The owner's `closed` and the app renderer's `did-start-navigation` handlers, taken off at dispose. */
	onClosed: () => void;
	onNavigated: (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => void;
}

function windowState(host: PreviewHost): PreviewState {
	return {
		...host.active.state,
		tabs: host.pages.map(page => ({
			id: page.id,
			title: page.state.title || page.state.visual?.label || "",
			url: page.state.url,
			loading: page.state.loading,
			...(page.visual ? { visual: page.visual.id } : {}),
		})),
		activeTab: host.active.id,
	};
}

/** What a web viewer's preview needs from the app (ipc.ts hands it over; a test or a build without Mobile web has none). */
export interface PreviewWebSupport {
	/** Whether `win`'s active tab (or `tabId`) runs on a paired host: its loopback addresses stay blocked. */
	isRemote(win: ClientWindow, tabId?: string): boolean;
	/** Device pixels per DIP of the screen the offscreen windows paint on (a frame is the window's size times this). */
	hostScale(): number;
	/** The dialog shim's preload on disk (preview-dialog.ts), written once. */
	preloadPath(): string;
}

/** The widest or tallest an offscreen page's window is made, in DIPs. */
const MAX_STREAM_DIP = 4096;
/** Frames of the viewer's page are never asked for before this size exists. */
const DEFAULT_STREAM_GEOMETRY = {
	rect: { x: 0, y: 0, width: 390, height: 844 },
	pixelWidth: 780,
	profile: streamProfile(390, 2),
};

/**
 * No preload, no shell IPC, and two fresh in-memory sessions for each window, shared by its tabs: `web` for
 * every page the user, a popup or the agent browses, `visual` for `omp-visual:` pages alone. A page stays in the
 * session it was made in; a visual never turns into a web page or back, its tab is replaced instead.
 * `isRemote(senderId, tabId?)`: the window's active tab (or `tabId`) runs on a paired host.
 *
 * A paired phone's preview (`web`) is the same host with the same rules, its pages offscreen windows instead of
 * views, in sessions of their own (`preview-web-<n>`, `preview-visual-web-<n>`); `web` also gives those sessions
 * the one dialog-shim preload (preview-dialog.ts), the single exception to "no preload".
 * Returns what the agent's `gui_visualize` reads and waits on.
 */
export function registerPreviewHost(
	ipc: IpcRegistry,
	isRemote: (senderId: number, tabId?: string) => boolean,
	visuals: VisualStore,
	viewers?: PreviewWebSupport,
): VisualPages {
	const hosts = new Map<number, PreviewHost>();
	/** One pair of sessions per window; Electron keeps a session for a name until the app quits, so hosts reuse it. */
	const windowSessions = new WeakMap<object, PreviewSessions>();
	/** The streams whose page may ask a dialog question (by the page's `webContents.id`). */
	const dialogStreams = new Map<number, PageStream>();
	const send = (host: PreviewHost) => {
		if (!host.sender.isDestroyed()) host.sender.send(PREVIEW_STATE, windowState(host));
	};
	const visualView = (page: PreviewPage) => (page.visual ? visuals.view(page.visual.id, page.visual.version) : null);
	const publish = (host: PreviewHost, page: PreviewPage, patch: Partial<PreviewPageState> = {}) => {
		const { contents } = page;
		if (contents.isDestroyed()) return;
		page.state = {
			...page.state,
			url: contents.getURL() || page.state.url,
			title: contents.getTitle(),
			loading: contents.isLoading(),
			canGoBack: contents.navigationHistory.canGoBack(),
			canGoForward: contents.navigationHistory.canGoForward(),
			visual: visualView(page),
			...patch,
		};
		send(host);
	};
	/**
	 * A web viewer's shown page: its offscreen window is the frame's size times `profile.dpr / screen scale` and
	 * zoomed by the same, so a frame pixel is a phone pixel whatever the host screen's density is.
	 */
	const placeStreamed = (host: PreviewHost, layout: NonNullable<PreviewHost["layout"]>) => {
		const page = host.active;
		for (const other of host.pages) if (other !== page) other.stream?.setVisible(false);
		const { stream, osr, contents } = page;
		if (!stream || !osr || osr.isDestroyed()) return;
		const fitted = fitPreviewFrame(layout.bounds, PREVIEW_VIEWPORTS[page.state.viewport]);
		const profile = streamProfile(fitted.bounds.width, layout.dpr);
		const scale = profile.dpr / Math.max(0.5, viewers?.hostScale() ?? 1);
		page.streamScale = scale;
		const width = Math.max(1, Math.min(MAX_STREAM_DIP, Math.round(fitted.bounds.width * scale)));
		const height = Math.max(1, Math.min(MAX_STREAM_DIP, Math.round(fitted.bounds.height * scale)));
		const [currentWidth, currentHeight] = osr.getContentSize();
		if (currentWidth !== width || currentHeight !== height) osr.setContentSize(width, height);
		const factor = Math.max(MIN_FRAME_SCALE, page.state.zoom * fitted.scale) * scale;
		if (factor !== page.factor || contents.getZoomFactor() !== factor) {
			page.factor = factor;
			contents.setZoomFactor(factor);
		}
		stream.configure({
			rect: {
				x: fitted.bounds.x - layout.bounds.x,
				y: fitted.bounds.y - layout.bounds.y,
				width: fitted.bounds.width,
				height: fitted.bounds.height,
			},
			pixelWidth: Math.round(fitted.bounds.width * profile.dpr),
			profile,
		});
		stream.setVisible(layout.visible && fitted.bounds.width > 0 && fitted.bounds.height > 0);
	};
	/** Size the shown page to the panel and its frame, zoom it, and hide every other tab. */
	const place = (host: PreviewHost) => {
		if (!host.layout) return;
		if (!host.win) {
			placeStreamed(host, host.layout);
			return;
		}
		const [width, height] = host.win.getContentSize();
		for (const page of host.pages) {
			if (page === host.active) continue;
			page.view?.setVisible(false);
		}
		const page = host.active;
		if (!page.view) return;
		const fitted = fitPreviewFrame(host.layout.bounds, PREVIEW_VIEWPORTS[page.state.viewport]);
		applyPreviewLayout(page.view, fitted.bounds, host.layout.visible, { width, height });
		const { contents } = page;
		const factor = Math.max(MIN_FRAME_SCALE, page.state.zoom * fitted.scale);
		if (factor !== page.factor || contents.getZoomFactor() !== factor) {
			page.factor = factor;
			contents.setZoomFactor(factor);
		}
	};
	const stopAgent = (host: PreviewHost) => {
		const link = host.agent;
		if (!link) return;
		host.agent = null;
		link.extension.dispose();
		link.socket.close();
		link.page.state = { ...link.page.state, agent: null };
		send(host);
	};
	/** The web address a web page may show, or null: http(s) only, and no loopback for a paired host's tab. */
	const allowed = (host: PreviewHost, url: string) => {
		const safe = previewUrl(url);
		return safe && !(host.remote() && isLoopbackUrl(safe)) ? safe : null;
	};
	/**
	 * A web address a visual's page tried to reach. It never goes there; right after the user's own click or key
	 * on the page (the C143 gesture window) the panel offers the whole address to open in a new web tab.
	 */
	const offerLink = (host: PreviewHost, page: PreviewPage, url: string) => {
		const safe = allowed(host, url);
		if (safe && Date.now() - page.lastInput <= GESTURE_WINDOW_MS)
			publish(host, page, { notice: { kind: "link", url: safe } });
	};
	const closePage = (host: PreviewHost, page: PreviewPage) => {
		if (host.agent?.page === page) stopAgent(host);
		page.stream?.dispose();
		if (page.view && host.win && !host.win.isDestroyed()) host.win.contentView.removeChildView(page.view);
		if (page.osr) {
			if (!page.osr.isDestroyed()) page.osr.destroy();
		} else if (!page.contents.isDestroyed()) page.contents.close();
	};
	const disposeHost = (host: PreviewHost) => {
		host.win?.off("closed", host.onClosed);
		host.renderer?.off("did-start-navigation", host.onNavigated);
		host.viewer?.removeListener("closed", host.onClosed);
		stopAgent(host);
		for (const page of host.pages) closePage(host, page);
		// The window's later close or reload must not drop a preview created after this one was disposed.
		if (hosts.get(host.sender.id) === host) hosts.delete(host.sender.id);
		// The sessions outlive the host (one pair per window); what this host browsed does not.
		for (const partition of [host.sessions.web, host.sessions.visual]) {
			void partition.clearStorageData().catch(() => {});
			void partition.clearCache().catch(() => {});
		}
	};
	const loadInto = (host: PreviewHost, page: PreviewPage, url: string) => {
		page.state = { ...page.state, url, title: "", loading: true, error: null, visual: visualView(page) };
		send(host);
		// loadURL resolves after navigation; do not hold the toolbar behind that promise.
		void page.contents.loadURL(url).catch(() => {});
	};
	/** Show version `version` (default latest) of `visualId` in `page`, which must be of the visual's session. */
	const loadVisual = (host: PreviewHost, page: PreviewPage, visualId: string, version?: number) => {
		const view = visuals.view(visualId, version);
		const url = view && visuals.url(visualId, view.version);
		if (!view || !url) throw new Error("Unknown visual");
		if (page.state.session !== (visuals.parse(url) ? "visual" : "web"))
			throw new Error("Visual in the wrong session");
		page.visual = { id: visualId, version: view.version };
		loadInto(host, page, url);
	};
	/**
	 * A sandboxed page in one of the owner's preview sessions; its handlers find their host through `owner`. With
	 * a `win` it is a view in that window; without one (a web viewer) an offscreen window whose paints stream to
	 * the viewer, its frames numbered by `nextSeq`. Both carry the same rules below.
	 */
	const createPage = (
		win: BrowserWindow | null,
		sessions: PreviewSessions,
		kind: PreviewPageState["session"],
		owner: () => PreviewHost,
		nextSeq: (() => number) | null,
	): PreviewPage => {
		const webPreferences = {
			session: sessions[kind],
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
			webSecurity: true,
			navigateOnDragDrop: false,
		};
		const view = win ? new WebContentsView({ webPreferences }) : null;
		const osr = win
			? null
			: new BrowserWindow({
					show: false,
					width: DEFAULT_STREAM_GEOMETRY.rect.width,
					height: DEFAULT_STREAM_GEOMETRY.rect.height,
					useContentSize: true,
					webPreferences: { ...webPreferences, offscreen: true, backgroundThrottling: false },
				});
		const contents = view?.webContents ?? osr?.webContents;
		if (!contents) throw new Error("No preview surface");
		if (view && win) {
			view.setVisible(false);
			win.contentView.addChildView(view);
		}
		const id = randomUUID();
		const stream =
			osr && nextSeq
				? new PageStream({ page: osrPage(contents), tab: id, geometry: DEFAULT_STREAM_GEOMETRY, nextSeq })
				: null;
		const page: PreviewPage = {
			id,
			view,
			osr,
			contents,
			state: { ...EMPTY_PREVIEW_PAGE, session: kind },
			factor: 1,
			visual: null,
			lastInput: 0,
			stream,
			mapper: new InputMapper(),
			streamScale: 1,
		};
		if (stream) {
			// The page's dialogs wait for the viewer (preview-dialog.ts); leaving a page is never a question.
			const contentsId = contents.id;
			dialogStreams.set(contentsId, stream);
			contents.once("destroyed", () => dialogStreams.delete(contentsId));
			contents.on("will-prevent-unload", event => event.preventDefault());
		}
		const update = (patch?: Partial<PreviewPageState>) => publish(owner(), page, patch);
		const pageUpdated = () => {
			const agent = owner().agent;
			if (agent?.page === page) agent.extension.pageUpdated();
		};
		let problemsPending: NodeJS.Timeout | undefined;
		contents.on("console-message", ({ level, message, lineNumber, sourceId }) => {
			if (level !== "error" && level !== "warning") return;
			const problem = { level, message: message.slice(0, PROBLEM_TEXT_MAX), source: sourceId, line: lineNumber };
			page.state = { ...page.state, problems: [...page.state.problems, problem].slice(-PREVIEW_PROBLEM_LIMIT) };
			if (problemsPending) return;
			problemsPending = setTimeout(() => {
				problemsPending = undefined;
				update();
			}, AGENT_ACTIVITY_MS);
		});
		contents.on("unresponsive", () => update({ notice: { kind: "unresponsive" } }));
		contents.on("responsive", () => {
			if (page.state.notice?.kind === "unresponsive") update({ notice: null });
		});
		// WebRTC is no CSP directive: over UDP (STUN, TURN) it would leave a visual's page directly; over TCP it
		// takes the visual session's dead proxy.
		if (kind === "visual") contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
		// A web page's popup (window.open, target=_blank) becomes a web tab of this preview under the same URL
		// rules; it opens behind the agent's page while an agent drives, so the relay keeps its one page. A
		// visual's popup never opens.
		contents.setWindowOpenHandler(({ url }) => {
			const host = owner();
			if (kind === "visual") offerLink(host, page, url);
			else {
				const safe = allowed(host, url);
				if (safe && host.pages.length < PREVIEW_TAB_LIMIT) loadInto(host, openPage(host, "web", !host.agent), safe);
			}
			return { action: "deny" };
		});
		// What the page itself starts (a link, `location`, a form, a meta refresh, a frame's load, a redirect):
		// a visual's page stays inside its visual, a web page keeps to web addresses.
		const mayGo = (url: string) =>
			kind === "visual" ? visualMayNavigate(page.visual?.id ?? null, url) : allowed(owner(), url) !== null;
		contents.on("will-frame-navigate", details => {
			if (mayGo(details.url)) return;
			details.preventDefault();
			if (kind === "visual" && details.isMainFrame) offerLink(owner(), page, details.url);
		});
		contents.on("will-redirect", details => {
			if (!mayGo(details.url)) details.preventDefault();
		});
		contents.on("will-attach-webview", event => event.preventDefault());
		// Real input reaching the page; a script's `dispatchEvent` never does. The agent's CDP input may, so
		// `choose` also refuses while the agent or any debugger holds the page.
		contents.on("input-event", (_event, input) => {
			if (input.type === "mouseUp" || input.type === "keyUp") page.lastInput = Date.now();
		});
		// A notice from the Preview check described the document that is now being replaced.
		contents.on("did-start-loading", () =>
			update({ error: null, crashed: false, ...(page.state.notice?.kind === "check" ? { notice: null } : {}) }),
		);
		contents.on("did-stop-loading", () => update());
		contents.on("did-navigate", (_event, url) => {
			// A visual's page that leaves its own address (for an empty document) no longer shows it; a web visual
			// browses on.
			if (page.visual) {
				const shown = visuals.parse(url);
				if (shown?.id === page.visual.id) page.visual = { id: shown.id, version: shown.version };
				else if (kind === "visual") page.visual = null;
			}
			// Chromium keeps zoom per origin; the user's level follows the page across origins.
			if (page === owner().active) place(owner());
			// A viewer's frame must show the new page now, not at the next paint tick.
			page.stream?.refresh();
			update({ problems: [] });
			pageUpdated();
		});
		contents.on("did-navigate-in-page", () => {
			update();
			pageUpdated();
		});
		contents.on("page-title-updated", () => {
			update();
			pageUpdated();
		});
		contents.on("did-fail-load", (_event, code, description, _url, mainFrame) => {
			if (mainFrame && code !== -3) update({ error: description, loading: false });
		});
		contents.on("render-process-gone", () => {
			view?.setVisible(false);
			stream?.setVisible(false);
			update({ crashed: true, loading: false, notice: null });
		});
		return page;
	};
	function openPage(host: PreviewHost, kind: PreviewPageState["session"], show: boolean): PreviewPage {
		const page = createPage(host.win, host.sessions, kind, () => host, host.nextSeq);
		host.pages.push(page);
		if (show) select(host, page);
		else send(host);
		return page;
	}
	function select(host: PreviewHost, page: PreviewPage): void {
		if (host.agent && host.agent.page !== page) stopAgent(host);
		// A viewer's poll held on the page it leaves must not keep the next one waiting.
		if (host.active !== page) host.active.stream?.release();
		host.active = page;
		place(host);
		page.stream?.refresh();
		send(host);
	}
	/** Close one tab; closing the last leaves a fresh empty one. */
	function removePage(host: PreviewHost, target: PreviewPage): void {
		const index = host.pages.indexOf(target);
		if (index < 0) return;
		closePage(host, target);
		host.pages.splice(index, 1);
		if (host.pages.length === 0) openPage(host, "web", true);
		else if (target === host.active) select(host, host.pages[Math.min(index, host.pages.length - 1)]);
		else send(host);
	}
	/** Put a new page of session `kind` in `old`'s place (shown if `old` was), and close `old`. */
	function replacePage(host: PreviewHost, old: PreviewPage, kind: PreviewPageState["session"]): PreviewPage {
		const page = createPage(host.win, host.sessions, kind, () => host, host.nextSeq);
		host.pages.splice(host.pages.indexOf(old), 1, page);
		closePage(host, old);
		if (host.active === old) select(host, page);
		else send(host);
		return page;
	}
	/**
	 * Show `visualId` (`version`, default latest) in the tab that shows it, else in an empty shown tab (only when
	 * `show`), else in a new tab; at the tab limit it replaces the shown page when `show` and is skipped otherwise.
	 * A tab already on that version keeps its page (and the user's tweaks). A file or inline visual needs a page of
	 * the visual session and a web visual one of the web session: a tab of the other kind is replaced, never
	 * reused, so no page ever holds both.
	 */
	function showVisual(host: PreviewHost, visualId: string, version: number | undefined, show: boolean): void {
		const wanted = visuals.view(visualId, version)?.version;
		const url = wanted === undefined ? null : visuals.url(visualId, wanted);
		if (wanted === undefined || !url) return;
		const kind = visuals.parse(url) ? "visual" : "web";
		const inSession = (page: PreviewPage) => (page.state.session === kind ? page : replacePage(host, page, kind));
		const shown = host.pages.find(candidate => candidate.visual?.id === visualId);
		let target: PreviewPage;
		if (shown) target = inSession(shown);
		else if (show && !host.active.state.url && !host.active.visual) target = inSession(host.active);
		else if (host.pages.length < PREVIEW_TAB_LIMIT) target = openPage(host, kind, false);
		else if (show) target = inSession(host.active);
		else return;
		if (target.visual?.id !== visualId || target.visual.version !== wanted)
			loadVisual(host, target, visualId, wanted);
		if (show) select(host, target);
	}
	/** Run one page tool in OMPdesk's isolated world: its result, or null once the page navigates away or closes. */
	function runOnPage(page: PreviewPage, code: string): Promise<unknown> {
		const { contents } = page;
		if (contents.isDestroyed()) return Promise.resolve(null);
		const { promise, resolve } = Promise.withResolvers<unknown>();
		const gone = () => resolve(null);
		const navigated = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
			if (details.isMainFrame && !details.isSameDocument) resolve(null);
		};
		contents.once("destroyed", gone);
		contents.on("did-start-navigation", navigated);
		contents.executeJavaScriptInIsolatedWorld(PAGE_WORLD, [{ code }]).then(resolve, gone);
		return promise.finally(() => {
			if (contents.isDestroyed()) return;
			contents.off("destroyed", gone);
			contents.off("did-start-navigation", navigated);
		});
	}
	/** The owner's two in-memory sessions (its tabs share them, every host of the owner reuses them), set up once. */
	const sessionsOf = (owner: PreviewOwner): PreviewSessions => {
		const keyed = owner.win ?? owner.viewer;
		if (!keyed) throw new Error("Invalid preview owner");
		const known = windowSessions.get(keyed);
		if (known) return known;
		const label = owner.viewer ? `web-${Math.abs(owner.sender.id)}` : String(owner.win?.id);
		const web = session.fromPartition(`preview-${label}`);
		const visual = session.fromPartition(`preview-visual-${label}`);
		const senderId = owner.sender.id;
		for (const partition of [web, visual]) {
			partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
			partition.setPermissionCheckHandler(() => false);
			// A viewer's pages get the dialog shim and nothing else (preview-dialog.ts).
			if (owner.viewer && viewers)
				partition.registerPreloadScript({ type: "frame", filePath: viewers.preloadPath() });
		}
		// Pages see the user's languages, not the en-US the packaged locales leave Chromium (system-languages.ts).
		const languages = app.getPreferredSystemLanguages();
		applyAcceptLanguages(web, languages);
		seedSpellchecker(web, languages, process.platform);
		// Visual pages (C135): only the files `visuals` resolves for that visual, never cached across versions.
		visual.protocol.handle(VISUAL_SCHEME, request => visuals.serve(request.url));
		// Neither session saves files. A web page's download may go to the system browser instead; a visual's
		// never does (its address could carry what the page read).
		visual.on("will-download", download => download.preventDefault());
		web.on("will-download", (download, item, contents) => {
			download.preventDefault();
			const host = hosts.get(senderId);
			if (!host) return;
			const url = allowed(host, item.getURL());
			const page = host.pages.find(candidate => candidate.contents === contents) ?? host.active;
			if (url) publish(host, page, { notice: { kind: "download", url, filename: item.getFilename() } });
		});
		const sessions = { web, visual, ready: visual.setProxy(VISUAL_NO_ROUTE) };
		// A failed setup surfaces where a visual waits on it (it then never loads); nothing else awaits it.
		sessions.ready.catch(() => {});
		windowSessions.set(keyed, sessions);
		return sessions;
	};
	/** Who a preview call is for: the app window that asked, or a paired viewer's virtual window. */
	const previewOwner = (caller: IpcCaller): PreviewOwner => {
		const win = caller.browserWindow;
		if (win) {
			if (win.webContents !== caller.sender) throw new Error("Invalid preview owner");
			const renderer = win.webContents;
			return { win, renderer, viewer: null, sender: renderer, remote: tabId => isRemote(renderer.id, tabId) };
		}
		const viewer = caller.win;
		if (!viewers || !viewer || !isWebWindow(viewer.webContents.id)) throw new Error("Invalid preview owner");
		return {
			win: null,
			renderer: null,
			viewer,
			sender: {
				id: viewer.webContents.id,
				isDestroyed: () => viewer.isDestroyed(),
				send: (channel, ...args) => viewer.webContents.send(channel, ...args),
			},
			remote: tabId => viewers.isRemote(viewer, tabId),
		};
	};
	ipc.handle(PREVIEW_COMMAND, async (caller, request: PreviewRequest) => {
		const owner = previewOwner(caller);
		const { sender } = owner;
		let host = hosts.get(sender.id);
		if (request.action === "dispose") {
			if (host) disposeHost(host);
			return EMPTY_PREVIEW;
		}
		if (!host) {
			const sessions = sessionsOf(owner);
			let frames = 0;
			const nextSeq = owner.viewer ? () => ++frames : null;
			const first = createPage(owner.win, sessions, "web", () => created, nextSeq);
			const created: PreviewHost = {
				win: owner.win,
				renderer: owner.renderer,
				viewer: owner.viewer,
				sender,
				remote: owner.remote,
				sessions,
				pages: [first],
				active: first,
				agent: null,
				layout: null,
				nextSeq,
				onClosed: () => disposeHost(created),
				// Only the app renderer's own page load ends the preview, not a frame in it or an in-page change.
				onNavigated: details => {
					if (details.isMainFrame && !details.isSameDocument) disposeHost(created);
				},
			};
			host = created;
			hosts.set(sender.id, created);
			owner.win?.on("closed", created.onClosed);
			owner.renderer?.on("did-start-navigation", created.onNavigated);
			// A revoked device's window closes: its pages go with it.
			owner.viewer?.once("closed", created.onClosed);
		}
		const current = host;
		const page = current.active;
		if (request.action === "agentStart") {
			if (current.remote(request.tabId)) throw new Error("Agent browsing is for tabs on this computer");
			// The agent's browser drives web pages only; a visual's page has no network and its own rules.
			if (page.state.session === "visual") throw new Error("Agent browsing is for web pages, not visuals");
			const target = relayExtensionUrl(request.url, request.token);
			if (!target) throw new Error("Invalid browser relay endpoint");
			stopAgent(current);
			const { contents } = page;
			const socket = new WebSocket(target);
			let lastPublished = 0;
			let latest = "";
			let pending: NodeJS.Timeout | undefined;
			const flushActivity = () => {
				pending = undefined;
				lastPublished = Date.now();
				const agent = page.state.agent;
				if (current.agent?.socket !== socket || !agent) return;
				publish(current, page, {
					agent: { ...agent, attached: current.agent.extension.attached, lastAction: latest || agent.lastAction },
				});
			};
			const extension = new PreviewRelayExtension(
				{
					id: contents.id,
					url: () => contents.getURL(),
					title: () => contents.getTitle(),
					userAgent: () => contents.getUserAgent(),
					debugger: contents.debugger,
					ensureRenderer: async () => {
						if (!contents.getURL()) await contents.loadURL("about:blank").catch(() => {});
					},
				},
				message => {
					if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
				},
				// "" = the agent let go of the debugger; the mark keeps its last action.
				method => {
					if (method) latest = method;
					if (pending) return;
					const wait = AGENT_ACTIVITY_MS - (Date.now() - lastPublished);
					if (wait <= 0) flushActivity();
					else pending = setTimeout(flushActivity, wait);
				},
			);
			current.agent = { socket, extension, page };
			const instanceId = `ompdesk-preview-${randomUUID()}`;
			socket.addEventListener("open", () => socket.send(JSON.stringify(extension.hello(instanceId))));
			socket.addEventListener("message", message => extension.handle(String(message.data)));
			socket.addEventListener("close", () => {
				clearTimeout(pending);
				if (current.agent?.socket === socket) stopAgent(current);
			});
			publish(current, page, { agent: { tabId: request.tabId, attached: false, lastAction: "" } });
			return windowState(current);
		}
		if (request.action === "agentStop") stopAgent(current);
		else if (request.action === "newTab") {
			if (current.pages.length >= PREVIEW_TAB_LIMIT) throw new Error("Too many preview tabs");
			const url = request.url === undefined ? null : allowed(current, request.url);
			if (request.url !== undefined && !url) throw new Error("Preview URL unavailable");
			const opened = openPage(current, "web", true);
			if (url) loadInto(current, opened, url);
		} else if (request.action === "selectTab" || request.action === "closeTab") {
			const target = current.pages.find(candidate => candidate.id === request.id);
			if (!target) throw new Error("Unknown preview tab");
			if (request.action === "selectTab") select(current, target);
			else removePage(current, target);
		} else if (
			request.action === "showVisual" ||
			request.action === "openVisual" ||
			request.action === "restoreVisuals"
		) {
			if (current.remote(request.tabId)) throw new Error("Visuals are for tabs on this computer");
			if (request.action === "openVisual" && !(await visuals.addToTab(request.tabId, request.visualId)))
				throw new Error("Unknown visual");
			await current.sessions.ready;
			const own = visuals.forTab(request.tabId);
			if (request.action === "restoreVisuals") {
				for (const [index, id] of own.entries()) showVisual(current, id, undefined, request.show && index === 0);
			} else {
				if (!own.includes(request.visualId)) throw new Error("Unknown visual");
				showVisual(current, request.visualId, request.action === "showVisual" ? request.version : undefined, true);
			}
		} else if (request.action === "layout") {
			const dpr = Number.isFinite(request.dpr) ? Math.min(4, Math.max(0.5, request.dpr ?? 1)) : 1;
			current.layout = { bounds: request.bounds, visible: request.visible, dpr };
			place(current);
		} else if (request.action === "zoom") {
			page.state = { ...page.state, zoom: clampPreviewZoom(request.zoom) };
			place(current);
			publish(current, page);
		} else if (request.action === "viewport") {
			if (!Object.hasOwn(PREVIEW_VIEWPORTS, request.viewport)) throw new Error("Unknown preview viewport");
			page.state = { ...page.state, viewport: request.viewport };
			place(current);
			publish(current, page);
		} else if (request.action === "clearProblems") publish(current, page, { problems: [] });
		else if (request.action === "dismissNotice") publish(current, page, { notice: null });
		else if (request.action === "load") {
			const url = allowed(current, request.url);
			if (!url) throw new Error("Preview URL unavailable");
			if (page.state.session === "web") {
				// An address the user types replaces whatever web visual the page showed.
				page.visual = null;
				loadInto(current, page, url);
			} else {
				// A visual's tab stays a visual: the address opens in a new web tab.
				if (current.pages.length >= PREVIEW_TAB_LIMIT) throw new Error("Too many preview tabs");
				loadInto(current, openPage(current, "web", true), url);
			}
		} else if (request.action === "back" && page.contents.navigationHistory.canGoBack())
			page.contents.navigationHistory.goBack();
		else if (request.action === "forward" && page.contents.navigationHistory.canGoForward())
			page.contents.navigationHistory.goForward();
		else if (request.action === "reload") page.contents.reload();
		else if (request.action === "stop") page.contents.stop();
		return windowState(current);
	});
	ipc.handle(PREVIEW_SAVE_PDF, async caller => {
		const win = caller.browserWindow;
		const host = hosts.get(caller.sender.id);
		if (!win || win.webContents !== caller.sender) throw new Error("Invalid preview owner");
		const page = host?.active;
		if (!page?.state.url || page.state.crashed) throw new Error("No page to save");
		const { contents } = page;
		const name = pdfName(contents.getTitle());
		const choice = await dialog.showSaveDialog(win, {
			defaultPath: path.join(app.getPath("downloads"), `${name}.pdf`),
			filters: [{ name: "PDF", extensions: ["pdf"] }],
		});
		if (choice.canceled || !choice.filePath) return null;
		await writeFile(choice.filePath, await contents.printToPDF({ printBackground: true }));
		return choice.filePath;
	});
	ipc.handle(PREVIEW_VISUALS, () => visuals.list());
	ipc.handle(PREVIEW_PAGE, async (caller, raw: unknown) => {
		const request = pageRequestSchema.parse(raw);
		const page = hosts.get(caller.sender.id)?.active;
		if (!page?.state.url || page.state.crashed) throw new Error("No page to work on");
		const args =
			request.action === "parent" || request.action === "highlight"
				? [request.selector]
				: request.action === "pins"
					? [request.pins]
					: request.action === "setVariable"
						? [request.name, request.value]
						: [];
		const result = await runOnPage(page, pageCall(request.action, ...args));
		if (request.action !== "region" || !result) return result ?? null;
		const { rect, elements } = result as {
			rect: { left: number; top: number; width: number; height: number };
			elements: unknown[];
		};
		const { contents } = page;
		// CSS pixels → the view's DIPs.
		const factor = contents.getZoomFactor();
		const shot = await contents.capturePage({
			x: Math.round(rect.left * factor),
			y: Math.round(rect.top * factor),
			width: Math.max(1, Math.round(rect.width * factor)),
			height: Math.max(1, Math.round(rect.height * factor)),
		});
		const image = shot.getSize().width > REGION_MAX_WIDTH ? shot.resize({ width: REGION_MAX_WIDTH }) : shot;
		return { image: image.toPNG().toString("base64"), elements };
	});

	/** A web viewer's host with its shown streamed page, or a refusal: an app window has no stream. */
	const streamOf = (caller: IpcCaller) => {
		const viewer = caller.win;
		const host =
			viewer && !caller.browserWindow && isWebWindow(viewer.webContents.id)
				? hosts.get(viewer.webContents.id)
				: undefined;
		const page = host?.active;
		if (!host || !page?.stream || !page.osr) throw new Error("No streamed preview page");
		return { host, page, stream: page.stream, osr: page.osr };
	};
	ipc.handle(PREVIEW_STREAM_POLL, async (caller, raw: unknown) => {
		const request = pollRequestSchema.parse(raw);
		let found: ReturnType<typeof streamOf>;
		try {
			found = streamOf(caller);
		} catch (error) {
			// The panel polls before its first layout made the page: say nothing happened, a moment from now.
			if (!caller.browserWindow && caller.win && isWebWindow(caller.win.webContents.id)) {
				await sleep(NO_PAGE_RETRY_MS);
				return { frame: null, dialogs: [] };
			}
			throw error;
		}
		return found.stream.poll({ ack: request.ack, ...(request.wait === undefined ? {} : { wait: request.wait }) });
	});
	ipc.on(PREVIEW_STREAM_INPUT, (caller, raw: unknown) => {
		const batch = previewStreamBatchSchema.safeParse(raw);
		if (!batch.success) return;
		let found: ReturnType<typeof streamOf>;
		try {
			found = streamOf(caller);
		} catch {
			return;
		}
		const { host, page, osr } = found;
		if (page.state.crashed || osr.isDestroyed()) return;
		const [width, height] = osr.getContentSize();
		for (const input of batch.data) {
			for (const op of page.mapper.map(input, { width, height, scale: page.streamScale })) {
				if (op.op === "event") page.contents.sendInputEvent(op.event);
				else if (op.op === "text") void page.contents.insertText(op.text).catch(() => {});
				else {
					page.state = { ...page.state, zoom: clampPreviewZoom(page.state.zoom * op.scale) };
					place(host);
					publish(host, page);
				}
			}
		}
	});
	ipc.handle(PREVIEW_STREAM_DIALOG, (caller, raw: unknown) => {
		const { id, accept, text } = dialogAnswerSchema.parse(raw);
		streamOf(caller).stream.answerDialog(id, { accept, text: text ?? null });
	});
	ipc.handle(PREVIEW_STREAM_COPY, async caller => {
		const { page } = streamOf(caller);
		const text = await runOnPage(page, "String(window.getSelection?.() ?? '')");
		return typeof text === "string" ? text.slice(0, SELECTION_MAX_CHARS) : "";
	});
	ipc.handle(PREVIEW_STREAM_PDF, async caller => {
		const { page } = streamOf(caller);
		if (!page.state.url || page.state.crashed) throw new Error("No page to save");
		const pdf = await page.contents.printToPDF({ printBackground: true });
		if (pdf.length > PDF_MAX_BYTES) throw new Error("The page's PDF is too large to send over this link");
		return { name: `${pdfName(page.contents.getTitle())}.pdf`, base64: pdf.toString("base64") };
	});
	if (viewers) {
		// A viewer's page asks `alert`, `confirm` and `prompt` through its session's preload (preview-dialog.ts): the
		// page stays blocked until the viewer answers, a dismissal (or the page's end) answers it, and a sender that
		// is no streamed page gets nothing to show.
		ipcMain.on(DIALOG_CHANNEL, (event, raw: unknown) => {
			const request = dialogRequestSchema.safeParse(raw);
			const stream = dialogStreams.get(event.sender.id);
			if (!request.success || !stream) {
				event.returnValue = null;
				return;
			}
			void stream.openDialog(request.data).then(answer => {
				event.returnValue = dialogReturnValue(request.data, answer);
			});
		});
	}

	/** The first page showing `visualId` (a window's shown page first), or null. */
	const findVisual = (visualId: string) => {
		for (const host of hosts.values()) {
			const page = [host.active, ...host.pages].find(candidate => candidate.visual?.id === visualId);
			if (page) return { host, page };
		}
		return null;
	};
	/**
	 * The preview page of the visual session showing `version` of `visualId`. A web visual (an http(s) address) is
	 * never one: it lives in the session the person browses, keeps `page.visual` after they navigate elsewhere and a
	 * re-open of the same version does not reload it, so its pixels may be a site they moved to.
	 */
	const visualSessionPage = (visualId: string, version: number) => {
		for (const host of hosts.values()) {
			const page = host.pages.find(
				candidate =>
					candidate.visual?.id === visualId &&
					candidate.visual.version === version &&
					candidate.state.session === "visual" &&
					!candidate.contents.isDestroyed(),
			);
			if (page) return { host, page };
		}
		return null;
	};
	/** The visual-session page showing `version` of `visualId` that is on screen, whether or not it finished loading. */
	const onScreenVisualPage = (visualId: string, version: number) => {
		const found = visualSessionPage(visualId, version);
		// A page that is not on screen captures as nothing or as a stale frame; it is never judged.
		return found && found.host.active === found.page && found.host.layout?.visible ? found : null;
	};
	/** The on-screen page that also finished loading. */
	const shownVisualPage = (visualId: string, version: number) => {
		const found = onScreenVisualPage(visualId, version);
		if (!found) return null;
		const { state } = found.page;
		return state.url && !state.loading && !state.error && !state.crashed ? found : null;
	};
	return {
		close(visualId) {
			for (const host of [...hosts.values()])
				for (const page of host.pages.filter(candidate => candidate.visual?.id === visualId))
					removePage(host, page);
		},
		inspect(visualId) {
			const page = findVisual(visualId)?.page;
			return page
				? {
						title: page.state.title,
						url: page.state.url,
						loading: page.state.loading,
						problems: page.state.problems,
					}
				: null;
		},
		async choose(visualId, timeoutMs) {
			const found = findVisual(visualId);
			if (!found) return "none";
			const { host, page } = found;
			const { contents } = page;
			// C143: the agent's browser (or any debugger) on the page could click for the user.
			const held = () => host.agent?.page === page || contents.debugger.isAttached();
			if (held()) return "agent";
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const remaining = deadline - Date.now();
				if (remaining <= 0) return "timeout";
				const { promise: expired, resolve: expire } = Promise.withResolvers<"timeout">();
				const timer = setTimeout(() => expire("timeout"), remaining);
				const picked = await Promise.race([runOnPage(page, pageCall("choose")), expired]);
				clearTimeout(timer);
				if (picked === "timeout") {
					if (!contents.isDestroyed()) void runOnPage(page, pageCall("cancel"));
					return "timeout";
				}
				if (contents.isDestroyed() || page.visual?.id !== visualId || !host.pages.includes(page)) return "closed";
				if (picked === null) {
					// A new version (or a reload) replaced the document: wait on the next one.
					if (!contents.isLoading()) return "closed";
					const { promise: loaded, resolve: settle } = Promise.withResolvers<void>();
					contents.once("did-stop-loading", () => settle());
					contents.once("destroyed", () => settle());
					setTimeout(settle, remaining);
					await loaded;
					continue;
				}
				if (held()) return "agent";
				// Only a click the user made counts: a script's click is not trusted (page-scripts), and a trusted one
				// needs a real release on this page just now.
				if (Date.now() - page.lastInput > GESTURE_WINDOW_MS) continue;
				return picked as { value: string; text: string };
			}
		},
		async capture(visualId, version, budgetMs) {
			const started = Date.now();
			const deadline = started + budgetMs;
			for (;;) {
				const shown = shownVisualPage(visualId, version);
				if (shown) {
					await pause(PREVIEW_CHECK_SETTLE_MS);
					// A reload, a newer version or a tab switch during the settle starts the wait again.
					if (shownVisualPage(visualId, version)?.page === shown.page) {
						// Only this page's own pixels: the app window and the user's other windows are never captured.
						const picture = await withDeadline(
							shown.page.contents.capturePage().catch(() => null),
							Math.max(CAPTURE_MIN_MS, deadline - Date.now()),
						);
						return picture ? judgeImage(picture) : null;
					}
				} else if (!onScreenVisualPage(visualId, version) && Date.now() - started >= CAPTURE_APPEAR_MS) {
					// Nobody shows it (the panel is hidden, another tab is in front): waiting longer would only delay the tool.
					return null;
				}
				if (Date.now() + CAPTURE_POLL_MS >= deadline) return null;
				await pause(CAPTURE_POLL_MS);
			}
		},
		flag(visualId, version, problem) {
			const shown = shownVisualPage(visualId, version);
			// Another notice (a refused download or link, an unresponsive page) is the more urgent one and stays.
			if (shown && !shown.page.state.notice) publish(shown.host, shown.page, { notice: { kind: "check", problem } });
		},
	};
}
