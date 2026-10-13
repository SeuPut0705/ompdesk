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
import { applyPreviewLayout } from "./layout";

/** No preload, no shell IPC, and a fresh in-memory partition for each window. */
export function registerPreviewHost(isRemote: (senderId: number) => boolean): void {
	const hosts = new Map<number, { view: WebContentsView; state: PreviewState }>();
	ipcMain.handle(PREVIEW_COMMAND, async (event, request: PreviewRequest) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win || win.webContents !== event.sender) throw new Error("Invalid preview owner");
		let host = hosts.get(event.sender.id);
		if (request.action === "dispose") {
			if (host) {
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
			host = { view, state: { ...EMPTY_PREVIEW } };
			hosts.set(event.sender.id, host);
			const current = host;
			const contents = view.webContents;
			const publish = (patch: Partial<PreviewState> = {}) => {
				current.state = {
					...current.state,
					url: contents.getURL() || current.state.url,
					title: contents.getTitle(),
					loading: contents.isLoading(),
					canGoBack: contents.navigationHistory.canGoBack(),
					canGoForward: contents.navigationHistory.canGoForward(),
					...patch,
				};
				if (!event.sender.isDestroyed()) event.sender.send(PREVIEW_STATE, current.state);
			};
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
			contents.on("did-navigate", () => publish());
			contents.on("did-navigate-in-page", () => publish());
			contents.on("page-title-updated", () => publish());
			contents.on("did-fail-load", (_event, code, description, _url, mainFrame) => {
				if (mainFrame && code !== -3) publish({ error: description, loading: false });
			});
			contents.on("render-process-gone", () => {
				view.setVisible(false);
				publish({ error: "Preview renderer stopped", loading: false });
			});
			win.once("closed", () => {
				if (!contents.isDestroyed()) contents.close();
				hosts.delete(event.sender.id);
			});
			event.sender.once("did-start-navigation", () => {
				if (!contents.isDestroyed()) {
					win.contentView.removeChildView(view);
					contents.close();
				}
				hosts.delete(event.sender.id);
			});
		}
		const { view } = host;
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
