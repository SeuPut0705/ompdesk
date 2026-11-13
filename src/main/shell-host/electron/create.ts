/**
 * Builds the `electron` module object over a host connection and its facts: what `require("electron")` returns in
 * main, in electron-store and in electron-updater. `index.ts` makes the one real instance; tests make their own
 * over a fake shell.
 */
import type { HostFacts } from "../facts";
import { App, type InitState } from "./app";
import { createWindowClasses } from "./browser-window";
import { createDesktopModules } from "./desktop";
import { Host, type HostClient } from "./host";
import { IpcMain, serveIpc } from "./ipc-main";
import { createMenuModule } from "./menu";
import { NativeImage } from "./native-image";
import { createNet } from "./net";
import { createSafeStorage, keychainFetcher } from "./safe-storage";
import { DEFAULT_PARTITION, type ProtocolHandler, Session, serveDownloads, serveProtocolRequests } from "./session";
import { servePages, webContentsModule } from "./web-contents";

export interface CreateOptions {
	/** Ends the process; tests replace it. */
	exitProcess?(code: number): void;
	/** Whether to set `process.resourcesPath` and `process.versions` (the real instance does). */
	patchProcess?: boolean;
}

/** Requests that need CEF wait for `app.ready` (the shell has no context before it); `app.*` and `hello` never wait. */
function gated(client: HostClient, ready: Promise<void>): HostClient {
	const isEarly = (method: string): boolean => method === "hello" || method.startsWith("app.");
	return {
		request: async (method, params, options) => {
			if (!isEarly(method)) await ready;
			return client.request(method, params, options);
		},
		call: async (method, params, options) => {
			if (!isEarly(method)) await ready;
			return client.call(method, params, options);
		},
		event: (name, data, bin) => client.event(name, data, bin),
		handle: (method, handler) => client.handle(method, handler),
		on: (name, listener) => client.on(name, listener),
		flush: () => client.flush(),
	};
}

export function createElectron(client: HostClient, facts: HostFacts, options: CreateOptions = {}) {
	const { promise: ready, resolve: markReady } = Promise.withResolvers<void>();
	client.on("app.ready", () => markReady());
	const host = new Host(gated(client, ready), facts);
	if (options.patchProcess) {
		Object.defineProperty(process, "resourcesPath", {
			value: facts.resourcesPath,
			configurable: true,
			writable: true,
		});
		Object.defineProperty(process.versions, "chrome", { value: facts.versions.chrome, configurable: true });
		Object.defineProperty(process.versions, "shell", { value: facts.versions.shell, configurable: true });
		Object.defineProperty(process.versions, "cef", { value: facts.versions.cef, configurable: true });
	}

	const initState: InitState = { schemes: [] };
	let closeAll: () => Promise<boolean> = async () => true;
	const app = new App(host, initState, {
		closeWindows: () => closeAll(),
		...(options.exitProcess ? { exitProcess: options.exitProcess } : {}),
	});

	const sessions = new Map<string, Session>();
	const sessionFor = (partition: string, cache?: boolean): Session => {
		let found = sessions.get(partition);
		if (!found) {
			found = new Session(host, partition, { cache });
			sessions.set(partition, found);
		}
		return found;
	};
	serveProtocolRequests(host, sessionFor);
	serveDownloads(host, partition => sessions.get(partition));
	servePages(host);

	const { BrowserWindow, WebContentsView, closeAll: closeWindows } = createWindowClasses(host, app, sessionFor);
	closeAll = closeWindows;

	const ipcMain = new IpcMain();
	serveIpc(host, ipcMain);

	const desktop = createDesktopModules(host, { focusedWindowId: () => BrowserWindow.getFocusedWindow()?.id });
	const menus = createMenuModule(host, {
		focusedWindow: () => BrowserWindow.getFocusedWindow(),
		quit: () => app.quit(),
		showAboutPanel: () => app.showAboutPanel(),
	});

	const session = {
		get defaultSession(): Session {
			return sessionFor(DEFAULT_PARTITION);
		},
		fromPartition: (partition: string, sessionOptions?: { cache?: boolean }): Session =>
			sessionFor(partition, sessionOptions?.cache),
	};

	const protocol = {
		registerSchemesAsPrivileged(schemes: InitState["schemes"]): void {
			if (app.isReady())
				throw new Error("protocol.registerSchemesAsPrivileged should be called before app is ready");
			initState.schemes.push(...schemes);
		},
		handle: (scheme: string, handler: ProtocolHandler): void =>
			session.defaultSession.protocol.handle(scheme, handler),
		unhandle: (scheme: string): void => session.defaultSession.protocol.unhandle(scheme),
		isProtocolHandled: (scheme: string): boolean => session.defaultSession.protocol.isProtocolHandled(scheme),
	};

	return {
		app,
		BrowserWindow,
		WebContentsView,
		webContents: webContentsModule(host),
		session,
		protocol,
		ipcMain,
		...menus,
		dialog: desktop.dialog,
		clipboard: desktop.clipboard,
		shell: desktop.shell,
		Notification: desktop.Notification,
		screen: desktop.screen,
		nativeTheme: desktop.nativeTheme,
		systemPreferences: desktop.systemPreferences,
		powerMonitor: desktop.powerMonitor,
		powerSaveBlocker: desktop.powerSaveBlocker,
		globalShortcut: desktop.globalShortcut,
		autoUpdater: desktop.autoUpdater,
		net: createNet(host),
		nativeImage: {
			createEmpty: NativeImage.createEmpty,
			createFromBuffer: NativeImage.createFromBuffer,
			createFromPath: NativeImage.createFromPath,
			createFromDataURL: NativeImage.createFromDataURL,
		},
		safeStorage: createSafeStorage(facts.safeStorage, {
			warn: message => host.warn(message),
			fetchKey: keychainFetcher(facts.exe, facts.paths.userData),
		}),
		/** Not an Electron member: the shim's connection, gated on `app.ready` like the shim's own requests. Each moved
		 * module's typed client (`shell-host/modules/client.ts`) speaks through it. */
		shellHost: host.client,
	};
}

export type ElectronShim = ReturnType<typeof createElectron>;
