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
import type { VisualPages, VisualStore } from "./visuals";

/** Activity marks and console problems reach the panel at most this often. */
const AGENT_ACTIVITY_MS = 250;
/** Longest console message kept per problem. */
const PROBLEM_TEXT_MAX = 2000;
/** A `data-choice` click counts for the agent only after a real mouse or key release on that page this recently (C143). */
const GESTURE_WINDOW_MS = 1000;
/** Widest region screenshot sent to the agent, in pixels. */
const REGION_MAX_WIDTH = 1600;

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

/** One tab of a window's preview: its own sandboxed page in the window's partition. */
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

interface PreviewHost {
	win: BrowserWindow;
	sender: Electron.WebContents;
	partition: Session;
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
 * No preload, no shell IPC, and a fresh in-memory partition for each window, shared by its tabs.
 * `isRemote(senderId, tabId?)`: the window's active tab (or `tabId`) runs on a paired host.
 * Visual pages load from `omp-visual:` on that partition alone, serving only what `visuals` resolves.
 * Returns what the agent's `gui_visualize` reads and waits on.
 */
export function registerPreviewHost(
	isRemote: (senderId: number, tabId?: string) => boolean,
	visuals: VisualStore,
): VisualPages {
	const hosts = new Map<number, PreviewHost>();
	/** One partition per window; Electron keeps a session for a name until the app quits, so hosts reuse it. */
	const partitions = new WeakMap<BrowserWindow, Session>();
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
	/**
	 * The address a page may show, or null. An `omp-visual:` address loads only from main (`loadVisual`) or
	 * inside `page` while it shows that visual; neither the user's address bar nor another site can reach one.
	 */
	const allowed = (host: PreviewHost, url: string, page?: PreviewPage) => {
		const visual = visuals.parse(url);
		if (visual) return page?.visual?.id === visual.id ? url : null;
		const safe = previewUrl(url);
		return safe && !(isRemote(host.sender.id) && isLoopbackUrl(safe)) ? safe : null;
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
		// The partition outlives the host (one per window); what this host browsed does not.
		void host.partition.clearStorageData().catch(() => {});
		void host.partition.clearCache().catch(() => {});
	};
	const loadInto = (host: PreviewHost, page: PreviewPage, url: string) => {
		page.state = { ...page.state, url, title: "", loading: true, error: null, visual: visualView(page) };
		send(host);
		// loadURL resolves after navigation; do not hold the toolbar behind that promise.
		void page.contents.loadURL(url).catch(() => {});
	};
	/** Show version `version` (default latest) of `visualId` in `page`. */
	const loadVisual = (host: PreviewHost, page: PreviewPage, visualId: string, version?: number) => {
		const view = visuals.view(visualId, version);
		const url = view && visuals.url(visualId, view.version);
		if (!view || !url) throw new Error("Unknown visual");
		page.visual = { id: visualId, version: view.version };
		loadInto(host, page, url);
	};
	/** A sandboxed page in `win`'s preview partition; its handlers find their window through `owner`. */
	const createPage = (win: BrowserWindow, partition: Session, owner: () => PreviewHost): PreviewPage => {
		const view = new WebContentsView({
			webPreferences: {
				session: partition,
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
			state: { ...EMPTY_PREVIEW_PAGE },
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
		// A popup (window.open, target=_blank) becomes a tab of this preview under the same URL rules; it opens
		// behind the agent's page while an agent drives, so the relay keeps its one page.
		contents.setWindowOpenHandler(({ url }) => {
			const host = owner();
			const safe = allowed(host, url);
			if (safe && host.pages.length < PREVIEW_TAB_LIMIT) loadInto(host, openPage(host, !host.agent), safe);
			return { action: "deny" };
		});
		const guard = (navigation: Electron.Event, url: string) => {
			if (!allowed(owner(), url, page)) navigation.preventDefault();
		};
		contents.on("will-frame-navigate", details => guard(details, details.url));
		contents.on("will-redirect", guard);
		contents.on("will-attach-webview", event => event.preventDefault());
		// Real input reaching the page; a script's `dispatchEvent` never does. The agent's CDP input may, so
		// `choose` also refuses while the agent or any debugger holds the page.
		contents.on("input-event", (_event, input) => {
			if (input.type === "mouseUp" || input.type === "keyUp") page.lastInput = Date.now();
		});
		contents.on("did-start-loading", () => update({ error: null, crashed: false }));
		contents.on("did-stop-loading", () => update());
		contents.on("did-navigate", (_event, url) => {
			// A file or inline visual's page that leaves its own address no longer shows it; a web visual browses on.
			if (page.visual) {
				const shown = visuals.parse(url);
				if (shown?.id === page.visual.id) page.visual = { id: shown.id, version: shown.version };
				else if (visuals.url(page.visual.id)?.startsWith(`${VISUAL_SCHEME}:`)) page.visual = null;
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
	function openPage(host: PreviewHost, show: boolean): PreviewPage {
		const page = createPage(host.win, host.partition, () => host);
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
		if (host.pages.length === 0) openPage(host, true);
		else if (target === host.active) select(host, host.pages[Math.min(index, host.pages.length - 1)]);
		else send(host);
	}
	/**
	 * Show `visualId` (`version`, default latest) in the tab that shows it, else in an empty shown tab (only when
	 * `show`), else in a new tab; at the tab limit it replaces the shown page when `show` and is skipped otherwise.
	 * A tab already on that version keeps its page (and the user's tweaks).
	 */
	function showVisual(host: PreviewHost, visualId: string, version: number | undefined, show: boolean): void {
		const wanted = visuals.view(visualId, version)?.version;
		if (wanted === undefined) return;
		let target = host.pages.find(candidate => candidate.visual?.id === visualId);
		if (!target) {
			const blank = !host.active.state.url && !host.active.visual;
			if (show && blank) target = host.active;
			else if (host.pages.length < PREVIEW_TAB_LIMIT) target = openPage(host, false);
			else if (show) target = host.active;
			else return;
		}
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
	/** The window's one in-memory partition (its tabs share it, every host of the window reuses it), set up once. */
	const partitionOf = (win: BrowserWindow): Session => {
		const known = partitions.get(win);
		if (known) return known;
		const partition = session.fromPartition(`preview-${win.id}`);
		partitions.set(win, partition);
		partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
		partition.setPermissionCheckHandler(() => false);
		// Visual pages (C135): only the files `visuals` resolves for that visual, never cached across versions.
		partition.protocol.handle(VISUAL_SCHEME, request => visuals.serve(request.url));
		// The partition stays download-free; the user may hand the file to the system browser instead.
		const senderId = win.webContents.id;
		partition.on("will-download", (download, item, contents) => {
			download.preventDefault();
			const host = hosts.get(senderId);
			if (!host) return;
			const url = allowed(host, item.getURL());
			const page = host.pages.find(candidate => candidate.contents === contents) ?? host.active;
			if (url) publish(host, page, { notice: { kind: "download", url, filename: item.getFilename() } });
		});
		return partition;
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
			const partition = partitionOf(win);
			const first = createPage(win, partition, () => created);
			const created: PreviewHost = {
				win,
				sender: event.sender,
				partition,
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
			const opened = openPage(current, true);
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
			// An address the user types replaces whatever visual the page showed.
			page.visual = null;
			loadInto(current, page, url);
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
