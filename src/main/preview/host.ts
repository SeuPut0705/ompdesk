import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, session, shell, WebContentsView } from "electron";
import {
	clampPreviewZoom,
	EMPTY_PREVIEW,
	isLoopbackUrl,
	PREVIEW_COMMAND,
	PREVIEW_PROBLEM_LIMIT,
	PREVIEW_SAVE_PDF,
	PREVIEW_STATE,
	PREVIEW_VIEWPORTS,
	type PreviewBounds,
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

interface AgentLink {
	socket: WebSocket;
	extension: PreviewRelayExtension;
}

interface PreviewHost {
	view: WebContentsView;
	state: PreviewState;
	agent: AgentLink | null;
	/** The panel's last surface box, kept to re-fit the page when the viewport frame changes. */
	layout: { bounds: PreviewBounds; visible: boolean } | null;
	/** Zoom factor last given to the page (user zoom × frame fit). */
	factor: number;
	publish: (patch?: Partial<PreviewState>) => void;
	/** Size the page to the panel and the chosen frame, and zoom it. */
	place: () => void;
}

/**
 * No preload, no shell IPC, and a fresh in-memory partition for each window.
 * `isRemote(senderId, tabId?)`: the window's active tab (or `tabId`) runs on a paired host.
 */
export function registerPreviewHost(isRemote: (senderId: number, tabId?: string) => boolean): void {
	const hosts = new Map<number, PreviewHost>();
	const stopAgent = (host: PreviewHost) => {
		const link = host.agent;
		if (!link) return;
		host.agent = null;
		link.extension.dispose();
		link.socket.close();
		host.publish({ agent: null });
	};
	ipcMain.handle(PREVIEW_COMMAND, async (event, request: PreviewRequest) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win || win.webContents !== event.sender) throw new Error("Invalid preview owner");
		let host = hosts.get(event.sender.id);
		if (request.action === "dispose") {
			if (host) {
				stopAgent(host);
				win.contentView.removeChildView(host.view);
				host.view.webContents.close();
				hosts.delete(event.sender.id);
			}
			return EMPTY_PREVIEW;
		}
		if (!host) {
			const isolated = session.fromPartition(`preview-${randomUUID()}`);
			isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
			isolated.setPermissionCheckHandler(() => false);
			const view = new WebContentsView({
				webPreferences: {
					session: isolated,
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
			const created: PreviewHost = {
				view,
				state: { ...EMPTY_PREVIEW },
				agent: null,
				layout: null,
				factor: 1,
				publish: (patch = {}) => {
					created.state = {
						...created.state,
						url: contents.getURL() || created.state.url,
						title: contents.getTitle(),
						loading: contents.isLoading(),
						canGoBack: contents.navigationHistory.canGoBack(),
						canGoForward: contents.navigationHistory.canGoForward(),
						...patch,
					};
					if (!event.sender.isDestroyed()) event.sender.send(PREVIEW_STATE, created.state);
				},
				place: () => {
					if (!created.layout) return;
					const [width, height] = win.getContentSize();
					const fitted = fitPreviewFrame(created.layout.bounds, PREVIEW_VIEWPORTS[created.state.viewport]);
					applyPreviewLayout(view, fitted.bounds, created.layout.visible, { width, height });
					const factor = Math.max(MIN_FRAME_SCALE, created.state.zoom * fitted.scale);
					if (factor !== created.factor || contents.getZoomFactor() !== factor) {
						created.factor = factor;
						contents.setZoomFactor(factor);
					}
				},
			};
			host = created;
			hosts.set(event.sender.id, created);
			const publish = created.publish;
			const pageUpdated = () => created.agent?.extension.pageUpdated();
			// The partition stays download-free; the user may hand the file to the system browser instead.
			isolated.on("will-download", (download, item) => {
				download.preventDefault();
				const url = previewUrl(item.getURL());
				if (url && !(isRemote(event.sender.id) && isLoopbackUrl(url)))
					publish({ notice: { kind: "download", url, filename: item.getFilename() } });
			});
			let problemsPending: NodeJS.Timeout | undefined;
			contents.on("console-message", ({ level, message, lineNumber, sourceId }) => {
				if (level !== "error" && level !== "warning") return;
				const problem = { level, message: message.slice(0, PROBLEM_TEXT_MAX), source: sourceId, line: lineNumber };
				created.state = {
					...created.state,
					problems: [...created.state.problems, problem].slice(-PREVIEW_PROBLEM_LIMIT),
				};
				if (problemsPending) return;
				problemsPending = setTimeout(() => {
					problemsPending = undefined;
					if (!contents.isDestroyed()) publish();
				}, AGENT_ACTIVITY_MS);
			});
			contents.on("unresponsive", () => publish({ notice: { kind: "unresponsive" } }));
			contents.on("responsive", () => {
				if (created.state.notice?.kind === "unresponsive") publish({ notice: null });
			});
			contents.setWindowOpenHandler(({ url }) => {
				const safe = previewUrl(url);
				if (safe && !(isRemote(event.sender.id) && isLoopbackUrl(safe))) void shell.openExternal(safe);
				return { action: "deny" };
			});
			const guard = (navigation: Electron.Event, url: string) => {
				if (!previewUrl(url) || (isRemote(event.sender.id) && isLoopbackUrl(url))) navigation.preventDefault();
			};
			contents.on("will-frame-navigate", details => guard(details, details.url));
			contents.on("will-redirect", guard);
			contents.on("will-attach-webview", event => event.preventDefault());
			contents.on("did-start-loading", () => publish({ error: null, crashed: false }));
			contents.on("did-stop-loading", () => publish());
			contents.on("did-navigate", () => {
				// Chromium keeps zoom per origin; the user's level follows the page across origins.
				created.place();
				publish({ problems: [] });
				pageUpdated();
			});
			contents.on("did-navigate-in-page", () => {
				publish();
				pageUpdated();
			});
			contents.on("page-title-updated", () => {
				publish();
				pageUpdated();
			});
			contents.on("did-fail-load", (_event, code, description, _url, mainFrame) => {
				if (mainFrame && code !== -3) publish({ error: description, loading: false });
			});
			contents.on("render-process-gone", () => {
				view.setVisible(false);
				publish({ crashed: true, loading: false, notice: null });
			});
			win.once("closed", () => {
				stopAgent(created);
				if (!contents.isDestroyed()) contents.close();
				hosts.delete(event.sender.id);
			});
			event.sender.once("did-start-navigation", () => {
				stopAgent(created);
				if (!contents.isDestroyed()) {
					win.contentView.removeChildView(view);
					contents.close();
				}
				hosts.delete(event.sender.id);
			});
		}
		const { view } = host;
		if (request.action === "agentStart") {
			if (isRemote(event.sender.id, request.tabId)) throw new Error("Agent browsing is for tabs on this computer");
			const target = relayExtensionUrl(request.url, request.token);
			if (!target) throw new Error("Invalid browser relay endpoint");
			stopAgent(host);
			const current = host;
			const contents = view.webContents;
			const socket = new WebSocket(target);
			let lastPublished = 0;
			let latest = "";
			let pending: NodeJS.Timeout | undefined;
			const flushActivity = () => {
				pending = undefined;
				lastPublished = Date.now();
				const agent = current.state.agent;
				if (current.agent?.socket !== socket || !agent) return;
				current.publish({
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
			current.agent = { socket, extension };
			const instanceId = `ompdesk-preview-${randomUUID()}`;
			socket.addEventListener("open", () => socket.send(JSON.stringify(extension.hello(instanceId))));
			socket.addEventListener("message", message => extension.handle(String(message.data)));
			socket.addEventListener("close", () => {
				clearTimeout(pending);
				if (current.agent?.socket === socket) stopAgent(current);
			});
			current.publish({ agent: { tabId: request.tabId, attached: false, lastAction: "" } });
			return current.state;
		}
		if (request.action === "agentStop") {
			stopAgent(host);
			return host.state;
		}
		if (request.action === "layout") {
			host.layout = { bounds: request.bounds, visible: request.visible };
			host.place();
		} else if (request.action === "zoom") {
			host.state = { ...host.state, zoom: clampPreviewZoom(request.zoom) };
			host.place();
			host.publish();
		} else if (request.action === "viewport") {
			if (!Object.hasOwn(PREVIEW_VIEWPORTS, request.viewport)) throw new Error("Unknown preview viewport");
			host.state = { ...host.state, viewport: request.viewport };
			host.place();
			host.publish();
		} else if (request.action === "clearProblems") host.publish({ problems: [] });
		else if (request.action === "dismissNotice") host.publish({ notice: null });
		else if (request.action === "load") {
			const url = previewUrl(request.url);
			if (!url || (isRemote(event.sender.id) && isLoopbackUrl(url))) throw new Error("Preview URL unavailable");
			host.state = { ...host.state, url, title: "", loading: true, error: null };
			event.sender.send(PREVIEW_STATE, host.state);
			// loadURL resolves after navigation; do not hold the toolbar behind that promise.
			void view.webContents.loadURL(url).catch(() => {});
		} else if (request.action === "back" && view.webContents.navigationHistory.canGoBack())
			view.webContents.navigationHistory.goBack();
		else if (request.action === "forward" && view.webContents.navigationHistory.canGoForward())
			view.webContents.navigationHistory.goForward();
		else if (request.action === "reload") view.webContents.reload();
		else if (request.action === "stop") view.webContents.stop();
		return host.state;
	});
	ipcMain.handle(PREVIEW_SAVE_PDF, async event => {
		const win = BrowserWindow.fromWebContents(event.sender);
		const host = hosts.get(event.sender.id);
		if (!win || win.webContents !== event.sender) throw new Error("Invalid preview owner");
		if (!host?.state.url || host.state.crashed) throw new Error("No page to save");
		const contents = host.view.webContents;
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
