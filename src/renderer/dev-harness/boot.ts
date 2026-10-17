/**
 * Entry of the dev harness page (`harness.html`): the app's own renderer, booted the way the web client boots it
 * (`html[data-platform="web"]`, a `window.omp` built over a transport), with fixture state behind the transport
 * instead of a host. `?theme=` and `?lang=` are applied by the page before this runs.
 */

import { createOmpApi } from "../../shared/omp-api";
import { InstallPrompt } from "../web/install";
import { PushClient } from "../web/push-client";
import { setWebPwa } from "../web/pwa";
import { createHarnessTransport } from "./transport";

document.documentElement.dataset.platform = "web";

const query = new URLSearchParams(location.search);

// `?rail=all` pins Agents and Stats under the session list, the way the footer shortcut toggles do.
const prefs: Record<string, unknown> = {};
if (query.get("rail") === "all") prefs.sidebar = { railPins: ["usage", "agents", "stats"] };
// The app takes its theme from prefs once they load (and resolves "system" from the OS, not from localStorage),
// so `?theme=` has to be a pref too or a dark capture paints light.
const theme = query.get("theme");
if (theme === "dark" || theme === "light") prefs.theme = theme;
const { transport, harness } = createHarnessTransport(prefs);
const api = createOmpApi(transport);
// `fs.pathForFile` is the one member only Electron's preload can answer; a browser has no local path to give.
window.omp = { ...api, fs: { ...api.fs, pathForFile: () => "" } };
window.__harness = harness;

// `?pwa=ios` (an iPhone tab: push needs the home-screen install) or `?pwa=push` (installed, permission not asked
// yet) gives Settings › Mobile web the device's own notification and install controls, as the web page has them.
const pwaMode = query.get("pwa");
if (pwaMode === "ios" || pwaMode === "push") {
	const ios = pwaMode === "ios";
	const host = {
		publicKey: "AAAA",
		subscribed: false,
		hideContent: false,
		categories: ["completion", "error", "ask"],
	};
	setWebPwa({
		push: new PushClient({
			fetch: async () => Response.json(host),
			isSecureContext: true,
			needsInstall: ios,
			supported: !ios,
			hostPush: () => true,
			permission: () => "default",
			requestPermission: async () => "default",
			pushManager: async () => null,
		}),
		install: new InstallPrompt({ addEventListener: () => {} }),
		environment: () => ({
			userAgent: ios ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari" : navigator.userAgent,
			platform: ios ? "iPhone" : navigator.platform,
			maxTouchPoints: 5,
			standalone: !ios,
		}),
		guidance: () => (ios ? "ios-share" : "installed"),
		update: null,
	});
}

// Dynamic: the renderer reads `window.omp` as it evaluates, and a static import would run it before the lines above.
await import("../main");
