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
	drain();
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
	waiting.length = 0;
	opening = null;
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

/** How long a command given while the active tab changes waits for it before it is dropped. */
export const ROUTE_WAIT_MS = 2_000;

/** A new tab main has not answered yet (⌘T, the menu). */
let opening: Promise<unknown> | null = null;

/** Commands put off by `waitForActiveTab`, oldest first, each with the time it is dropped. */
const waiting: [command: () => void, until: number][] = [];
/** True while `drain` runs a command: that command's own `waitForActiveTab` call lets it through. */
let passing = false;

/**
 * Run the waiting commands in order, one at a time: a command that moves the active tab (⇧⌘], ⌘T) leaves the rest
 * waiting until its own route lands, so each one starts from where the previous one went.
 */
function drain(): void {
	for (let next = waiting[0]; next && !passing && !opening && acceptsActiveTabEvents(); next = waiting[0]) {
		waiting.shift();
		if (Date.now() >= next[1]) continue;
		passing = true;
		try {
			next[0]();
		} finally {
			passing = false;
		}
	}
}

/** Commands given until `opened` settles belong to the tab it opens, not the one shown now. Returns `opened`. */
export function openingTab<T>(opened: Promise<T>): Promise<T> {
	const pending: Promise<unknown> = opened.finally(() => {
		if (opening !== pending) return;
		opening = null;
		drain();
	});
	opening = pending;
	return opened;
}

/**
 * Whether `command` has to wait for the active tab: true when it was put off until a new tab is in and its route has
 * landed (it then runs in the order given, or never when that takes over `ROUTE_WAIT_MS`), false when the caller may
 * run it now. A key pressed in that gap was dropped, or acted on the tab being left: ⌘W right after ⌘T closed the old
 * tab, or tried to close the window when it was the only one (nightly 39525167897, desktop.e2e).
 */
export function waitForActiveTab(command: () => void): boolean {
	if (passing || (waiting.length === 0 && !opening && acceptsActiveTabEvents())) return false;
	waiting.push([command, Date.now() + ROUTE_WAIT_MS]);
	return true;
}
