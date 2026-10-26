/**
 * The browser agents use (Settings › Agent behavior › Default browser, prefs `defaultBrowser`). `auto` follows what
 * is installed: ego-browser when it is, else omp's built-in `browser` tool. Main passes the resolved choice to omp
 * as `OMP_GUI_BROWSER` at spawn and through the bridge's `default_browser_set` on change; the gui-bridge
 * (resources/gui-bridge/modes/default-browser.ts) turns `ego` into one system-prompt section.
 */

/** prefs key (electron-store `prefs`). */
export const DEFAULT_BROWSER_PREF = "defaultBrowser";

/** Env main sets at every spawn: `ego` or `builtin`. */
export const DEFAULT_BROWSER_ENV = "OMP_GUI_BROWSER";

export type DefaultBrowserPref = "auto" | "ego" | "builtin";

/** What an agent is pointed at once the pref met the machine. */
export type AgentBrowser = "ego" | "builtin";

export function isDefaultBrowserPref(value: unknown): value is DefaultBrowserPref {
	return value === "auto" || value === "ego" || value === "builtin";
}

/** A stored pref; missing or unknown (hand-edited, a later version's choice) reads as `auto`. */
export function parseDefaultBrowser(value: unknown): DefaultBrowserPref {
	return isDefaultBrowserPref(value) ? value : "auto";
}

/** `ego` only while ego-browser is installed: an agent is never pointed at a missing binary. */
export function resolveAgentBrowser(pref: DefaultBrowserPref, egoInstalled: boolean): AgentBrowser {
	return pref !== "builtin" && egoInstalled ? "ego" : "builtin";
}
