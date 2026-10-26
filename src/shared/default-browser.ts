/**
 * The browser agents use (Settings › Agent behavior › Default browser, prefs `defaultBrowser`). `auto` follows what
 * is installed: ego-browser, else a Chromium browser whose omp Browser Relay extension is loaded (agents then drive
 * the user's own signed-in browser through stock's relay), else omp's built-in browser. Main resolves the pref
 * against the machine and passes the result to omp as `OMP_GUI_BROWSER` at spawn and through the bridge's
 * `default_browser_set` on change; the gui-bridge (resources/gui-bridge/modes/default-browser.ts) turns it into a
 * prompt section and, for the relay, a per-session `browser.relay` override.
 */
import { type AgentBrowser, DEFAULT_BROWSER_ENV } from "../../resources/gui-bridge/modes/default-browser-contracts";

export type { AgentBrowser };
export { DEFAULT_BROWSER_ENV };

/** prefs key (electron-store `prefs`). */
export const DEFAULT_BROWSER_PREF = "defaultBrowser";

/** The Chromium browsers Settings can offer, in the order `auto` tries them. */
export const CHROMIUM_BROWSER_IDS = ["chrome", "edge", "brave", "arc", "chromium"] as const;

export type ChromiumBrowserId = (typeof CHROMIUM_BROWSER_IDS)[number];

export const CHROMIUM_BROWSER_NAMES: Record<ChromiumBrowserId, string> = {
	chrome: "Google Chrome",
	edge: "Microsoft Edge",
	brave: "Brave",
	arc: "Arc",
	chromium: "Chromium",
};

export type DefaultBrowserPref = "auto" | "ego" | "builtin" | `chromium:${ChromiumBrowserId}`;

/** One Chromium browser found on this computer. */
export interface InstalledBrowser {
	id: ChromiumBrowserId;
	name: string;
	/** This browser's own omp Browser Relay extension copy (`extension-<id>`) is loaded in one of its profiles. */
	relayInstalled: boolean;
	/** That copy is connected to its relay right now (only asked of an installed one; false otherwise). */
	relayConnected: boolean;
}

/** What this computer has: the answer of `DEFAULT_BROWSER_STATUS`, in `auto` order. */
export interface AgentBrowserStatus {
	egoInstalled: boolean;
	browsers: InstalledBrowser[];
}

const CHROMIUM_PREFS: readonly string[] = CHROMIUM_BROWSER_IDS.map(id => `chromium:${id}`);

export function isDefaultBrowserPref(value: unknown): value is DefaultBrowserPref {
	return (
		value === "auto" ||
		value === "ego" ||
		value === "builtin" ||
		(typeof value === "string" && CHROMIUM_PREFS.includes(value))
	);
}

/** A stored pref; missing or unknown (hand-edited, a later version's choice) reads as `auto`. */
export function parseDefaultBrowser(value: unknown): DefaultBrowserPref {
	return isDefaultBrowserPref(value) ? value : "auto";
}

/** The Chromium browser a `chromium:<id>` pref names. */
export function chromiumBrowserOf(pref: DefaultBrowserPref): ChromiumBrowserId | undefined {
	return CHROMIUM_BROWSER_IDS.find(id => pref === `chromium:${id}`);
}

/**
 * One relay endpoint per browser. Every extension dials one default port (9224) and stock's relay serves several
 * connected browsers at once, opening a new tab in whichever it picks: a shared endpoint lets "Chrome" drive a
 * connected Edge, which can be another account. Each browser's extension copy is bound to its own port instead
 * (src/main/agent-browsers.ts), and a session is pointed at that port only. Beside stock's 9224, below the kernel's
 * ephemeral range that Preview's relay takes its port from.
 */
export const CHROMIUM_RELAY_PORTS: Record<ChromiumBrowserId, number> = {
	chrome: 9231,
	edge: 9232,
	brave: 9233,
	arc: 9234,
	chromium: 9235,
};

/** The loopback relay endpoint of `id`'s extension copy. */
export function relayUrl(id: ChromiumBrowserId): string {
	return `http://127.0.0.1:${CHROMIUM_RELAY_PORTS[id]}`;
}

/**
 * What the pref comes to on this computer. An agent is never pointed at a missing binary, and a Chromium browser
 * without its own relay extension copy cannot be driven, so those fall back to omp's built-in browser (never to the
 * system browser binary itself: stock documents that a headless daemon from `Google Chrome.app` takes the user's link
 * clicks). A relay choice carries the endpoint only that browser's copy dials.
 */
export function resolveAgentBrowser(pref: DefaultBrowserPref, status: AgentBrowserStatus): AgentBrowser {
	if (pref === "builtin") return { kind: "builtin" };
	const relay = (browser: InstalledBrowser | undefined): AgentBrowser =>
		browser?.relayInstalled ? { kind: "relay", name: browser.name, url: relayUrl(browser.id) } : { kind: "builtin" };
	if (pref === "ego") return status.egoInstalled ? { kind: "ego" } : { kind: "builtin" };
	if (pref === "auto") {
		if (status.egoInstalled) return { kind: "ego" };
		return relay(status.browsers.find(browser => browser.relayInstalled));
	}
	return relay(status.browsers.find(browser => browser.id === chromiumBrowserOf(pref)));
}
