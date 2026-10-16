/**
 * A window main routes tabs, events and IPC callers to: an Electron `BrowserWindow` satisfies it as is, and a
 * paired web device's virtual window will (its ids are negative, so they never meet a webContents id). Only
 * what the sidecar pool, the window records and the IPC handlers read of a window is here; a handler that
 * needs the native window (a dialog sheet, the title-bar overlay, the preview's views) takes
 * `IpcCaller.browserWindow` instead.
 */
export interface ClientWindow {
	readonly webContents: {
		/** The window's routing id: Electron's webContents id. */
		readonly id: number;
		send(channel: string, ...args: unknown[]): void;
	};
	isDestroyed(): boolean;
	once(event: "closed", listener: () => void): unknown;
	removeListener(event: "closed", listener: () => void): unknown;
}

/** A paired web device's virtual window: its ids are negative, an Electron webContents id never is. */
export function isWebWindow(windowId: number): boolean {
	return windowId < 0;
}
