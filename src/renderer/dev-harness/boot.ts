/**
 * Entry of the dev harness page (`harness.html`): the app's own renderer, booted the way the web client boots it
 * (`html[data-platform="web"]`, a `window.omp` built over a transport), with fixture state behind the transport
 * instead of a host. `?theme=` and `?lang=` are applied by the page before this runs.
 */

import { createOmpApi } from "../../shared/omp-api";
import { migrateThemeName, schemeOfTheme } from "../../shared/theme-names";
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
// so `?theme=` has to be a pref too or a dark capture paints light. Any theme id works (`?theme=nord`).
const theme = migrateThemeName(query.get("theme"));
if (theme !== null) {
	prefs.themeName = theme;
	prefs.theme = theme === "system" ? "system" : schemeOfTheme(theme);
}
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

// The responsive audit (e2e/responsive-audit.ts) opens dialogs, popovers and panels by setting the stores a click
// would, so it needs them on the page. Stores are plain zustand hooks; the scoped ones follow the focused session.
const [
	ui,
	tabs,
	toast,
	extensionUi,
	planApproval,
	queue,
	composer,
	session,
	workBoard,
	subagents,
	autopilot,
	mobileWeb,
	remote,
	nextPrompt,
] = await Promise.all([
	import("../stores/ui").then(module => module.useUiStore),
	import("../stores/tabs").then(module => module.useTabsStore),
	import("../stores/toast").then(module => module.useToastStore),
	import("../stores/extension-ui").then(module => module.useExtensionUiStore),
	import("../stores/plan-approval").then(module => module.usePlanApprovalStore),
	import("../stores/queue").then(module => module.useQueueStore),
	import("../stores/composer").then(module => module.useComposerStore),
	import("../stores/session").then(module => module.useSessionStore),
	import("../stores/work-board").then(module => module.useWorkBoardStore),
	import("../stores/subagents").then(module => module.useSubagentsStore),
	import("../stores/autopilot").then(module => module.useAutopilotStore),
	import("../stores/mobile-web").then(module => module.useMobileWebStore),
	import("../stores/remote").then(module => module.useRemoteStore),
	import("../stores/next-prompt").then(module => module.useNextPromptStore),
]);
window.__stores = {
	ui,
	tabs,
	toast,
	extensionUi,
	planApproval,
	queue,
	composer,
	session,
	workBoard,
	subagents,
	autopilot,
	mobileWeb,
	remote,
	nextPrompt,
};

interface StoreHandle {
	getState(): unknown;
	setState(partial: unknown): void;
}

declare global {
	interface Window {
		/** The stores the responsive audit drives (harness only). */
		__stores?: Record<string, StoreHandle>;
	}
}
