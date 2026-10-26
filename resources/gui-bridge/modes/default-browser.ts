/**
 * Default browser (rules and text: default-browser-core.ts): the per-turn section that points agents at ego-browser.
 * Registered like the other OMPdesk sections (../prompt-sections.ts), so the context inspector shows it too.
 */
import { guard } from "../health";
import { setDefaultBrowser } from "./default-browser-core";

export { install } from "./default-browser-core";

/** `capabilities` reports the feature when an internal it needs is gone (none: only the public hook). */
export const methods = guard("defaultBrowser", {
	/** Main sends this to every live local sidecar when the setting changes, and on bridge connect. */
	default_browser_set: async (params: unknown) => setDefaultBrowser(params),
});
