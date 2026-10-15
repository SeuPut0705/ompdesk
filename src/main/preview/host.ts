import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
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
import { PreviewRelayExtension, relayExtensionUrl } from "./agent-relay";
import { applyPreviewLayout, fitPreviewFrame, MIN_FRAME_SCALE } from "./layout";
import { PAGE_WORLD, pageCall } from "./page-scripts";
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
	view: WebContentsView;
	/** The view's WebContents, kept: `view.webContents` reads undefined once the window destroyed the view. */
	contents: WebContents;
	state: PreviewPageState;
	/** Zoom factor last given to the page (user zoom × frame fit). */
	factor: number;
	/** The agent's visual this page shows (`gui_visualize`) and its version. */
	visual: { id: string; version: number } | null;
	/** When the user last released a mouse button or key on this page (epoch ms; the C143 gesture). */
	lastInput: number;
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

interface PreviewHost {
	win: BrowserWindow;
	sender: Electron.WebContents;
	sessions: PreviewSessions;
	pages: PreviewPage[];
	active: PreviewPage;
	agent: AgentLink | null;
	/** The panel's last surface box, kept to re-fit the page when the viewport frame or the tab changes. */
	layout: { bounds: PreviewBounds; visible: boolean } | null;
	/** The window's `closed` and the app renderer's `did-start-navigation` handlers, taken off at dispose. */
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

/**
 * No preload, no shell IPC, and two fresh in-memory sessions for each window, shared by its tabs: `web` for
 * every page the user, a popup or the agent browses, `visual` for `omp-visual:` pages alone. A page stays in the
 * session it was made in; a visual never turns into a web page or back, its tab is replaced instead.
 * `isRemote(senderId, tabId?)`: the window's active tab (or `tabId`) runs on a paired host.
 * Returns what the agent's `gui_visualize` reads and waits on.
 */
export function registerPreviewHost(
	isRemote: (senderId: number, tabId?: string) => boolean,
	visuals: VisualStore,
): VisualPages {
	const hosts = new Map<number, PreviewHost>();
	/** One pair of sessions per window; Electron keeps a session for a name until the app quits, so hosts reuse it. */
	const windowSessions = new WeakMap<BrowserWindow, PreviewSessions>();
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
	/** Size the shown page to the panel and its frame, zoom it, and hide every other tab. */
	const place = (host: PreviewHost) => {
		if (!host.layout) return;
		const [width, height] = host.win.getContentSize();
		for (const page of host.pages) {
			if (page === host.active) continue;
			page.view.setVisible(false);
		}
		const page = host.active;
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
		return safe && !(isRemote(host.sender.id) && isLoopbackUrl(safe)) ? safe : null;
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
		if (!host.win.isDestroyed()) host.win.contentView.removeChildView(page.view);
		if (!page.contents.isDestroyed()) page.contents.close();
	};
	const disposeHost = (host: PreviewHost) => {
		host.win.off("closed", host.onClosed);
		host.sender.off("did-start-navigation", host.onNavigated);
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
	/** A sandboxed page in one of `win`'s preview sessions; its handlers find their window through `owner`. */
	const createPage = (
		win: BrowserWindow,
		sessions: PreviewSessions,
		kind: PreviewPageState["session"],
		owner: () => PreviewHost,
	): PreviewPage => {
		const view = new WebContentsView({
			webPreferences: {
				session: sessions[kind],
				nodeIntegration: false,
				contextIsolation: true,
				sandbox: true,
				webSecurity: true,
				navigateOnDragDrop: false,
			},
		});
		view.setVisible(false);
		win.contentView.addChildView(view);
		const contents = view.webContents;
		const page: PreviewPage = {
			id: randomUUID(),
			view,
			contents,
			state: { ...EMPTY_PREVIEW_PAGE, session: kind },
			factor: 1,
			visual: null,
			lastInput: 0,
		};
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
		contents.on("did-start-loading", () => update({ error: null, crashed: false }));
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
			view.setVisible(false);
			update({ crashed: true, loading: false, notice: null });
		});
		return page;
	};
	function openPage(host: PreviewHost, kind: PreviewPageState["session"], show: boolean): PreviewPage {
		const page = createPage(host.win, host.sessions, kind, () => host);
		host.pages.push(page);
		if (show) select(host, page);
		else send(host);
		return page;
	}
	function select(host: PreviewHost, page: PreviewPage): void {
		if (host.agent && host.agent.page !== page) stopAgent(host);
		host.active = page;
		place(host);
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
		const page = createPage(host.win, host.sessions, kind, () => host);
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
	/** The window's two in-memory sessions (its tabs share them, every host of the window reuses them), set up once. */
	const sessionsOf = (win: BrowserWindow): PreviewSessions => {
		const known = windowSessions.get(win);
		if (known) return known;
		const web = session.fromPartition(`preview-${win.id}`);
		const visual = session.fromPartition(`preview-visual-${win.id}`);
		const senderId = win.webContents.id;
		for (const partition of [web, visual]) {
			partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
			partition.setPermissionCheckHandler(() => false);
		}
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
		windowSessions.set(win, sessions);
		return sessions;
	};
	ipcMain.handle(PREVIEW_COMMAND, async (event, request: PreviewRequest) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win || win.webContents !== event.sender) throw new Error("Invalid preview owner");
		let host = hosts.get(event.sender.id);
		if (request.action === "dispose") {
			if (host) disposeHost(host);
			return EMPTY_PREVIEW;
		}
		if (!host) {
			const sessions = sessionsOf(win);
			const first = createPage(win, sessions, "web", () => created);
			const created: PreviewHost = {
				win,
				sender: event.sender,
				sessions,
				pages: [first],
				active: first,
				agent: null,
				layout: null,
				onClosed: () => disposeHost(created),
				// Only the app renderer's own page load ends the preview, not a frame in it or an in-page change.
				onNavigated: details => {
					if (details.isMainFrame && !details.isSameDocument) disposeHost(created);
				},
			};
			host = created;
			hosts.set(event.sender.id, created);
			win.on("closed", created.onClosed);
			event.sender.on("did-start-navigation", created.onNavigated);
		}
		const current = host;
		const page = current.active;
		if (request.action === "agentStart") {
			if (isRemote(event.sender.id, request.tabId)) throw new Error("Agent browsing is for tabs on this computer");
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
			if (isRemote(event.sender.id, request.tabId)) throw new Error("Visuals are for tabs on this computer");
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
			current.layout = { bounds: request.bounds, visible: request.visible };
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
	ipcMain.handle(PREVIEW_SAVE_PDF, async event => {
		const win = BrowserWindow.fromWebContents(event.sender);
		const host = hosts.get(event.sender.id);
		if (!win || win.webContents !== event.sender) throw new Error("Invalid preview owner");
		const page = host?.active;
		if (!page?.state.url || page.state.crashed) throw new Error("No page to save");
		const { contents } = page;
		const name =
			contents
				.getTitle()
				.replace(/[\\/:*?"<>|]+/g, " ")
				.replace(/\p{Cc}+/gu, " ")
				.trim()
				.slice(0, 100) || "page";
		const choice = await dialog.showSaveDialog(win, {
			defaultPath: path.join(app.getPath("downloads"), `${name}.pdf`),
			filters: [{ name: "PDF", extensions: ["pdf"] }],
		});
		if (choice.canceled || !choice.filePath) return null;
		await writeFile(choice.filePath, await contents.printToPDF({ printBackground: true }));
		return choice.filePath;
	});
	ipcMain.handle(PREVIEW_VISUALS, () => visuals.list());
	ipcMain.handle(PREVIEW_PAGE, async (event, raw: unknown) => {
		const request = pageRequestSchema.parse(raw);
		const page = hosts.get(event.sender.id)?.active;
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

	/** The first page showing `visualId` (a window's shown page first), or null. */
	const findVisual = (visualId: string) => {
		for (const host of hosts.values()) {
			const page = [host.active, ...host.pages].find(candidate => candidate.visual?.id === visualId);
			if (page) return { host, page };
		}
		return null;
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
	};
}
