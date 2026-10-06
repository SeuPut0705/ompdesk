/**
 * Renderer-side mirror of the window-global sidecar route. Tab selection
 * paints immediately, while SET_ACTIVE_TAB resolves asynchronously; session
 * events received in that gap belong to the previous route and must not enter
 * the newly selected tab's shared stores.
 */
let selectedTabId: string | null = null;
let routedTabId: string | null = null;
let routeReady = true;
const settledListeners = new Set<() => void>();
const stateListeners = new Set<(ready: boolean) => void>();

function notifyState(): void {
	const ready = acceptsActiveTabEvents();
	for (const listener of stateListeners) listener(ready);
}

function notifySettled(): void {
	if (!acceptsActiveTabEvents()) return;
	for (const listener of settledListeners) listener();
}

export function beginTabRoute(previousTabId: string | null, nextTabId: string): void {
	routedTabId ??= previousTabId;
	selectedTabId = nextTabId;
	routeReady = false;
	notifyState();
}

export function settleTabRoute(tabId: string): void {
	routedTabId = tabId;
	routeReady = selectedTabId === tabId;
	notifyState();
	notifySettled();
}

export function reconcileTabRoute(tabId: string | null, settled: boolean): void {
	selectedTabId = tabId;
	if (settled) {
		routedTabId = tabId;
	}
	routeReady = settled;
	notifyState();
	if (settled) notifySettled();
}

export function acceptsActiveTabEvents(): boolean {
	return routeReady && (selectedTabId === null || routedTabId === null || selectedTabId === routedTabId);
}

export function resetTabRoute(): void {
	selectedTabId = null;
	routedTabId = null;
	routeReady = true;
	notifyState();
}

export function onActiveTabRouteSettled(listener: () => void): () => void {
	settledListeners.add(listener);
	return () => settledListeners.delete(listener);
}

export function onActiveTabRouteState(listener: (ready: boolean) => void): () => void {
	stateListeners.add(listener);
	return () => stateListeners.delete(listener);
}
