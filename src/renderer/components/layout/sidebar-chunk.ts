/**
 * The session list (sidebar/Sidebar.tsx with its device sections, subagents, update card, the icons only it draws and
 * dnd-kit) is one chunk of its own (electron.vite.config.ts `session-list`; its stylesheet stays on the first screen,
 * AppShell): a phone keeps it in a closed drawer, so a phone's first screen never draws it, and it was 194 KB of that
 * screen's JavaScript (3 Nov 2026). Rendered from the loaded module, never through lazy() and its Suspense throttle.
 * - A desktop window docks it: index.html loads the chunk with the app's files, so the first render never waits.
 * - A web page that docks it (a landscape or wide portrait tablet) or that no service worker controls (a first visit,
 *   a hard reload) waits for it beside the locale before the first render (main.tsx); web-boot.ts starts its fetch
 *   beside the app's. On a first visit a ☰ tapped as the first screen shows would otherwise wait a round trip for it.
 * - A drawer's page a worker controls (every later visit) renders without it and loads it from the worker's cache in
 *   the first idle moment, or at the first touch or key if that comes sooner (AppShell). The drawer opens only once
 *   it is here (SidebarDrawer): never empty, never filled in after it slid in.
 */
import { useSyncExternalStore } from "react";
import { drawerModeNow } from "../../hooks/use-shell-mode";
import { loadChunk } from "../../lib/chunk-load";
import type { Sidebar as SidebarView } from "./sidebar/Sidebar";

/** Whether the first render waits for the list (above); web-boot.ts preloads its files by the same rule. */
export function sessionListBeforeFirstRender(): boolean {
	return !drawerModeNow() || !navigator.serviceWorker?.controller;
}

type SidebarComponent = typeof SidebarView;

let loaded: SidebarComponent | null = null;
let pending: Promise<SidebarComponent> | null = null;
const listeners = new Set<() => void>();

/** Load the list's chunk once; a failed load is tried again by the next call. */
export function loadSidebar(): Promise<SidebarComponent> {
	if (loaded) return Promise.resolve(loaded);
	pending ??= loadChunk(() => import("./sidebar/Sidebar")).then(
		module => {
			loaded = module.Sidebar;
			for (const listener of listeners) listener();
			return module.Sidebar;
		},
		(error: unknown) => {
			pending = null;
			throw error;
		},
	);
	return pending;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

const current = () => loaded;

/** The list's component once its chunk is here, else null. */
export function useSidebar(): SidebarComponent | null {
	return useSyncExternalStore(subscribe, current, current);
}
