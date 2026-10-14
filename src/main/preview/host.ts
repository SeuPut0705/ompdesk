import { randomUUID } from "node:crypto";
import { BrowserWindow, ipcMain, session, shell, WebContentsView } from "electron";
import {
	EMPTY_PREVIEW,
	isLoopbackUrl,
	PREVIEW_COMMAND,
	PREVIEW_STATE,
	type PreviewRequest,
	type PreviewState,
	previewUrl,
} from "../../shared/preview";
import { PreviewRelayExtension, relayExtensionUrl } from "./agent-relay";
import { applyPreviewLayout } from "./layout";

/** Activity marks reach the panel at most this often while the agent works. */
const AGENT_ACTIVITY_MS = 250;

interface AgentLink {
	socket: WebSocket;
	extension: PreviewRelayExtension;
}

interface PreviewHost {
	view: WebContentsView;
	state: PreviewState;
	agent: AgentLink | null;
	publish: (patch?: Partial<PreviewState>) => void;
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
			isolated.on("will-download", event => event.preventDefault());
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
			};
			host = created;
			hosts.set(event.sender.id, created);
			const publish = created.publish;
			const pageUpdated = () => created.agent?.extension.pageUpdated();
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
			contents.on("did-start-loading", () => publish({ error: null }));
			contents.on("did-stop-loading", () => publish());
			contents.on("did-navigate", () => {
				publish();
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
				publish({ error: "Preview renderer stopped", loading: false });
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
			const [width, height] = win.getContentSize();
			applyPreviewLayout(view, request.bounds, request.visible, { width, height });
		} else if (request.action === "load") {
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
}
