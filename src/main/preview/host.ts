import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, type Session, session, WebContentsView } from "electron";
import {
	clampPreviewZoom,
	EMPTY_PREVIEW,
	EMPTY_PREVIEW_PAGE,
	isLoopbackUrl,
	PREVIEW_COMMAND,
	PREVIEW_PROBLEM_LIMIT,
	PREVIEW_SAVE_PDF,
	PREVIEW_STATE,
	PREVIEW_TAB_LIMIT,
	PREVIEW_VIEWPORTS,
	type PreviewBounds,
	type PreviewPageState,
	type PreviewRequest,
	type PreviewState,
	previewUrl,
} from "../../shared/preview";
import { PreviewRelayExtension, relayExtensionUrl } from "./agent-relay";
import { applyPreviewLayout, fitPreviewFrame, MIN_FRAME_SCALE } from "./layout";

/** Activity marks and console problems reach the panel at most this often. */
const AGENT_ACTIVITY_MS = 250;
/** Longest console message kept per problem. */
const PROBLEM_TEXT_MAX = 2000;

/** One tab of a window's preview: its own sandboxed page in the window's partition. */
interface PreviewPage {
	id: string;
	view: WebContentsView;
	state: PreviewPageState;
	/** Zoom factor last given to the page (user zoom × frame fit). */
	factor: number;
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
}

function windowState(host: PreviewHost): PreviewState {
	return {
		...host.active.state,
		tabs: host.pages.map(page => ({
			id: page.id,
			title: page.state.title,
			url: page.state.url,
			loading: page.state.loading,
		})),
		activeTab: host.active.id,
	};
}

/**
 * No preload, no shell IPC, and a fresh in-memory partition for each window, shared by its tabs.
 * `isRemote(senderId, tabId?)`: the window's active tab (or `tabId`) runs on a paired host.
 */
export function registerPreviewHost(isRemote: (senderId: number, tabId?: string) => boolean): void {
	const hosts = new Map<number, PreviewHost>();
	const send = (host: PreviewHost) => {
		if (!host.sender.isDestroyed()) host.sender.send(PREVIEW_STATE, windowState(host));
	};
	const publish = (host: PreviewHost, page: PreviewPage, patch: Partial<PreviewPageState> = {}) => {
		const contents = page.view.webContents;
		if (contents.isDestroyed()) return;
		page.state = {
			...page.state,
			url: contents.getURL() || page.state.url,
			title: contents.getTitle(),
			loading: contents.isLoading(),
			canGoBack: contents.navigationHistory.canGoBack(),
			canGoForward: contents.navigationHistory.canGoForward(),
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
		const contents = page.view.webContents;
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
	const allowed = (host: PreviewHost, url: string) => {
		const safe = previewUrl(url);
		return safe && !(isRemote(host.sender.id) && isLoopbackUrl(safe)) ? safe : null;
	};
	const closePage = (host: PreviewHost, page: PreviewPage) => {
		if (host.agent?.page === page) stopAgent(host);
		if (!host.win.isDestroyed()) host.win.contentView.removeChildView(page.view);
		if (!page.view.webContents.isDestroyed()) page.view.webContents.close();
	};
	const disposeHost = (host: PreviewHost) => {
		stopAgent(host);
		for (const page of host.pages) closePage(host, page);
		// The window's later close or reload must not drop a preview created after this one was disposed.
		if (hosts.get(host.sender.id) === host) hosts.delete(host.sender.id);
	};
	const loadInto = (host: PreviewHost, page: PreviewPage, url: string) => {
		page.state = { ...page.state, url, title: "", loading: true, error: null };
		send(host);
		// loadURL resolves after navigation; do not hold the toolbar behind that promise.
		void page.view.webContents.loadURL(url).catch(() => {});
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
		const page: PreviewPage = { id: randomUUID(), view, state: { ...EMPTY_PREVIEW_PAGE }, factor: 1 };
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
			if (!allowed(owner(), url)) navigation.preventDefault();
		};
		contents.on("will-frame-navigate", details => guard(details, details.url));
		contents.on("will-redirect", guard);
		contents.on("will-attach-webview", event => event.preventDefault());
		contents.on("did-start-loading", () => update({ error: null, crashed: false }));
		contents.on("did-stop-loading", () => update());
		contents.on("did-navigate", () => {
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
	ipcMain.handle(PREVIEW_COMMAND, async (event, request: PreviewRequest) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win || win.webContents !== event.sender) throw new Error("Invalid preview owner");
		let host = hosts.get(event.sender.id);
		if (request.action === "dispose") {
			if (host) disposeHost(host);
			return EMPTY_PREVIEW;
		}
		if (!host) {
			const partition = session.fromPartition(`preview-${randomUUID()}`);
			partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
			partition.setPermissionCheckHandler(() => false);
			const first = createPage(win, partition, () => created);
			const created: PreviewHost = {
				win,
				sender: event.sender,
				partition,
				pages: [first],
				active: first,
				agent: null,
				layout: null,
			};
			host = created;
			hosts.set(event.sender.id, created);
			// The partition stays download-free; the user may hand the file to the system browser instead.
			partition.on("will-download", (download, item, contents) => {
				download.preventDefault();
				const url = allowed(created, item.getURL());
				const page = created.pages.find(candidate => candidate.view.webContents === contents) ?? created.active;
				if (url) publish(created, page, { notice: { kind: "download", url, filename: item.getFilename() } });
			});
			win.once("closed", () => disposeHost(created));
			event.sender.once("did-start-navigation", () => disposeHost(created));
		}
		const current = host;
		const page = current.active;
		const { view } = page;
		if (request.action === "agentStart") {
			if (isRemote(event.sender.id, request.tabId)) throw new Error("Agent browsing is for tabs on this computer");
			const target = relayExtensionUrl(request.url, request.token);
			if (!target) throw new Error("Invalid browser relay endpoint");
			stopAgent(current);
			const contents = view.webContents;
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
			else {
				const index = current.pages.indexOf(target);
				closePage(current, target);
				current.pages.splice(index, 1);
				if (current.pages.length === 0) openPage(current, true);
				else if (target === current.active)
					select(current, current.pages[Math.min(index, current.pages.length - 1)]);
				else send(current);
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
			loadInto(current, page, url);
		} else if (request.action === "back" && view.webContents.navigationHistory.canGoBack())
			view.webContents.navigationHistory.goBack();
		else if (request.action === "forward" && view.webContents.navigationHistory.canGoForward())
			view.webContents.navigationHistory.goForward();
		else if (request.action === "reload") view.webContents.reload();
		else if (request.action === "stop") view.webContents.stop();
		return windowState(current);
	});
	ipcMain.handle(PREVIEW_SAVE_PDF, async event => {
		const win = BrowserWindow.fromWebContents(event.sender);
		const host = hosts.get(event.sender.id);
		if (!win || win.webContents !== event.sender) throw new Error("Invalid preview owner");
		const page = host?.active;
		if (!page?.state.url || page.state.crashed) throw new Error("No page to save");
		const contents = page.view.webContents;
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
}
