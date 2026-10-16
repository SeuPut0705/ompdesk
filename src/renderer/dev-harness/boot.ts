/**
 * Entry of the dev harness page (`harness.html`): the app's own renderer, booted the way the web client boots it
 * (`html[data-platform="web"]`, a `window.omp` built over a transport), with fixture state behind the transport
 * instead of a host. `?theme=` and `?lang=` are applied by the page before this runs.
 */

import { createOmpApi } from "../../shared/omp-api";
import { createHarnessTransport } from "./transport";

document.documentElement.dataset.platform = "web";

// `?rail=all` pins Agents and Stats under the session list, the way the footer shortcut toggles do.
const prefs: Record<string, unknown> = {};
if (new URLSearchParams(location.search).get("rail") === "all")
	prefs.sidebar = { railPins: ["usage", "agents", "stats"] };
const { transport, harness } = createHarnessTransport(prefs);
const api = createOmpApi(transport);
// `fs.pathForFile` is the one member only Electron's preload can answer; a browser has no local path to give.
window.omp = { ...api, fs: { ...api.fs, pathForFile: () => "" } };
window.__harness = harness;

// Dynamic: the renderer reads `window.omp` as it evaluates, and a static import would run it before the lines above.
await import("../main");
