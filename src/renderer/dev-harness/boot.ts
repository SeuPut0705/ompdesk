/**
 * Entry of the dev harness page (`harness.html`): the app's own renderer, booted the way the web client boots it
 * (`html[data-platform="web"]`, a `window.omp` built over a transport), with fixture state behind the transport
 * instead of a host. `?theme=` and `?lang=` are applied by the page before this runs.
 */

import { createOmpApi } from "../../shared/omp-api";
import { migrateThemeName, schemeOfTheme } from "../../shared/theme-names";
import type { HostActions } from "../web/host-hooks";
import { InstallPrompt } from "../web/install";
import { PushClient } from "../web/push-client";
import { setWebPwa } from "../web/pwa";
import { setWebRuntime } from "../web/runtime";
import { BOARD_BUSY, boardBusyStores, CHILDREN_WAIT, CHILDREN_WAIT_CALL } from "./fixture-board";
import { CARD_LIVE_CALL } from "./fixture-card";
import { createHarnessTransport } from "./transport";

const query = new URLSearchParams(location.search);

// `?platform=darwin|win32` paints the page as an Electron window of that OS would (desktop layout, no mobile shell,
// the OS's title-bar room): the responsive audit's desktop looks. Without it the page is the web client.
const platform = query.get("platform");
document.documentElement.dataset.platform = platform === "darwin" || platform === "win32" ? platform : "web";

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

// `?host=1` gives the page a web runtime with a fake host, so `<WebHostUi />` mounts and the audit can put the host
// sheets (path actions, folder browser, editor, save image, models file, quit, update, install steps) on screen.
// Off by default: a runtime changes the connection banner and the device Settings of the harness.
if (query.get("host") === "1") {
	const listing = {
		path: "/Users/dev/projects",
		parent: "/Users/dev",
		home: "/Users/dev",
		entries: [
			{ name: "ompdesk", path: "/Users/dev/projects/ompdesk", directory: true, size: null },
			{
				name: "a-folder-with-a-very-long-name-that-has-to-truncate",
				path: "/Users/dev/projects/long",
				directory: true,
				size: null,
			},
			{ name: "notes.md", path: "/Users/dev/projects/notes.md", directory: false, size: 2048 },
		],
		truncated: false,
	};
	const done = { path: "/Users/dev/.omp/agent/models.yml", opened: true };
	const host: HostActions = {
		openExternalOnComputer: async () => {},
		openPathOnComputer: async () => ({ ok: true }),
		revealPathOnComputer: async () => ({ ok: true }),
		editOnComputer: async () => ({ ok: true, unavailable: false, text: null }),
		openModelsConfigOnComputer: async () => done,
		listDirs: async () => listing,
		saveToHost: async () => ({ ok: true, path: "/Users/dev/projects/image.png" }),
		modelsConfigRead: async () => ({ ...done, text: "providers: {}\n", exists: true, stamp: "1" }),
		modelsConfigWrite: async () => ({ ok: true, stamp: "2" }),
		downloadToPhone: async () => ({ ok: true }),
		saveBytesToPhone: async () => ({ saved: true }),
		pickPhoneFiles: async () => null,
	};
	setWebRuntime({
		host,
		connectionState: () => "open",
		onConnectionState: () => () => {},
		features: () => ({ push: true, preview: true, upload: true, passkey: false }),
		emitMenuAction: () => {},
		onResynced: () => () => {},
		reload: () => location.reload(),
		requestNotifications: async () => "default",
	});
	window.__hostActions = host;
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
	hostUi,
	updater,
	settings,
	model,
	agentReview,
	closedChildren,
	todo,
	tools,
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
	import("../web/host-ui/host-ui-store").then(module => module.useHostUiStore),
	import("../stores/updater").then(module => module.useUpdaterStore),
	import("../stores/settings").then(module => module.useSettingsStore),
	import("../stores/model").then(module => module.useModelStore),
	import("../stores/agent-review").then(module => module.useAgentReviewStore),
	import("../stores/closed-children").then(module => module.useClosedChildrenStore),
	import("../stores/todo").then(module => module.useTodoStore),
	import("../stores/tools").then(module => module.useToolsStore),
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
	hostUi,
	updater,
	settings,
	model,
	agentReview,
	closedChildren,
	todo,
};

// `?board=busy` (./fixture-board.ts): the running turn, the waiting question and the goal come from events and
// cards, not from a transport answer, so they are put into the stores once the session has hydrated.
if (BOARD_BUSY) {
	setTimeout(() => {
		const busy = boardBusyStores();
		todo.setState(busy.todo);
		session.setState(busy.session);
		extensionUi.getState().pushRequest(busy.request);
		// `&children=wait`: the transcript's unanswered wait loads as stopped; while the turn runs it is in flight.
		if (CHILDREN_WAIT) {
			const state = tools.getState();
			const finishedTools = new Map(state.finishedTools);
			const liveTools = new Map(state.liveTools);
			for (const [key, entry] of state.finishedTools) {
				if (!key.startsWith(CHILDREN_WAIT_CALL)) continue;
				finishedTools.delete(key);
				liveTools.set(key, { ...entry, status: "running", endTime: null, startTime: Date.now() - 95_000 });
			}
			tools.setState({ finishedTools, liveTools, finishedVersion: state.finishedVersion + 1 });
		}
	}, 1_500);
}

// `?card=live` (./fixture-card.ts): the card's run still goes on, its test run in flight, with a goal.
if (query.get("card") === "live") {
	setTimeout(() => {
		const ko = query.get("lang") === "ko";
		todo.setState({ turnActive: true, turnStartedAt: Date.now() - 50_000 });
		session.setState({
			goal: {
				objective: ko
					? "휴대폰, 태블릿, 4K 모니터 어디서든 한눈에 읽히는 작업현황을 출시하기"
					: "Ship a work board that reads at a glance on a phone, a tablet and a 4K monitor alike",
			},
			goalState: { status: "active" },
			isStreaming: true,
		});
		const state = tools.getState();
		const finishedTools = new Map(state.finishedTools);
		const liveTools = new Map(state.liveTools);
		const partialResults = new Map(state.partialResults);
		for (const [key, entry] of state.finishedTools) {
			if (!key.startsWith(CARD_LIVE_CALL)) continue;
			finishedTools.delete(key);
			liveTools.set(key, { ...entry, status: "running", endTime: null, startTime: Date.now() - 12_000 });
			// The run has printed its first files, so the stage shows output rather than a silent command.
			partialResults.set(key, {
				content: [
					{
						type: "text",
						text: " RUN  v3.2.4 /repo\n\n ✓ src/state/workspace.test.ts (12 tests) 31ms\n ✓ src/state/todo.test.ts (8 tests) 22ms\n ✓ src/components/WorkBoard.test.tsx (41 tests) 410ms\n ✓ src/components/ExecutionGroup.test.tsx (36 tests) 388ms\n ❯ src/components/LiveStepPeek.test.tsx (31 tests | 2 skipped) 290ms",
					},
				],
			});
		}
		tools.setState({ finishedTools, liveTools, partialResults, finishedVersion: state.finishedVersion + 1 });
	}, 1_500);
}

declare global {
	interface Window {
		/** The fake host of `?host=1`, for the audit's host sheets. */
		__hostActions?: HostActions;
	}
}

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
