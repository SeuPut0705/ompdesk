/**
 * The `chrome` module's deep-link area (PROTOCOL.md §15.5; was `deep-link.ts`): the shell takes `open-url`,
 * `open-file` and a second launch's argv itself, holds them until Node's startup windows exist, then spawns, shows
 * and tells the window. This file says when the windows exist and hands a link to the window's page.
 */
import { BrowserWindow } from "electron";
import { type DeepLinkPayload, IPC_EVENTS } from "../../../shared/ipc-types";
import { chrome } from "./chrome";

export interface DeepLinkSpec {
	calls: Record<never, never>;
	posts: {
		/** Node's startup windows exist: the shell registers the `omp://` protocol (when `register`) and replays what arrived. */
		linksReady: { register: boolean };
	};
	events: {
		/** The window's page loaded: deliver the link. */
		deepLink: { winId: number; payload: DeepLinkPayload };
	};
	asks: Record<never, never>;
}

function sendToWindow(winId: number, payload: DeepLinkPayload): void {
	const win = BrowserWindow.fromId(winId);
	if (win && !win.isDestroyed()) win.webContents.send(IPC_EVENTS.DEEP_LINK, payload);
}

/**
 * Call where the startup windows exist (index.ts, once the first window is up). The `omp://` protocol is registered
 * except in test runs (OMP_GUI_HEADLESS): that LaunchServices entry belongs to the user's installed OMPdesk. Links
 * still arrive either way. `deliver` is a test seam.
 */
export function startDeepLinks(deliver: (winId: number, payload: DeepLinkPayload) => void = sendToWindow): void {
	chrome().on("deepLink", ({ winId, payload }) => deliver(winId, payload));
	chrome()
		.post("linksReady", { register: process.env.OMP_GUI_HEADLESS !== "1" })
		.catch((error: unknown) => console.warn(`[deep-link] linksReady failed: ${String(error)}`));
}
