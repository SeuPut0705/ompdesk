/**
 * Default browser (rules and text: default-browser-core.ts): the per-turn section that points agents at ego-browser
 * or at the user's own browser, and the `browser.relay` / `browser.relayUrl` overrides that make the built-in `browser` tool drive the
 * latter. Registered like the other OMPdesk sections (../prompt-sections.ts), so the context inspector shows it too.
 */
import { guard } from "../health";
import { overridable } from "../settings-override";
import {
	applyDefaultBrowser,
	previewRelayStopped as previewRelayStoppedCore,
	type RelaySetting,
	setDefaultBrowser,
} from "./default-browser-core";

export { install, previewRelayStarted } from "./default-browser-core";

function relaySetting(): RelaySetting {
	const relay = overridable("browser.relay");
	const relayUrl = overridable("browser.relayUrl");
	return {
		hold: (scope, url) => {
			relay.override(scope, true);
			relayUrl.override(scope, url);
		},
		release: scope => {
			relay.clearOverride(scope);
			relayUrl.clearOverride(scope);
		},
	};
}

/** Preview's agent browsing stopped (browser-relay.ts) and cleared its overrides: hold the default browser's again. */
export function previewRelayStopped(scope: object): void {
	previewRelayStoppedCore(scope, relaySetting());
}

export const methods = guard("defaultBrowser", {
	/** Main sends this to every live local sidecar when the setting changes, and on bridge connect. */
	default_browser_set: async (params, env) => {
		const result = setDefaultBrowser(params);
		applyDefaultBrowser(env.session().settings as unknown as object, relaySetting());
		return result;
	},
});
