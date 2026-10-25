import { Suspense, useEffect, useMemo, useState } from "react";
import type { MenuAction, MenuActionPayload, RunProgressState } from "../shared/ipc-types";
import { nextUiLanguage } from "../shared/ui-language";
import { ToastStack } from "./components/common";
import { ActiveToolsDialog } from "./components/dialogs/ActiveToolsDialog";
import { BranchPickerDialog } from "./components/dialogs/BranchPickerDialog";
import { BtwDialog } from "./components/dialogs/BtwDialog";
import { ChangelogDialog, WhatsNewNotice } from "./components/dialogs/ChangelogDialog";
import { CommandPalette } from "./components/dialogs/CommandPalette";
import { CopySelectorDialog } from "./components/dialogs/CopySelectorDialog";
import { ExtensionDialog } from "./components/dialogs/ExtensionDialog";
import { ForceToolDialog } from "./components/dialogs/ForceToolDialog";
import { HandoffDialog } from "./components/dialogs/HandoffDialog";
import { LiveVoiceDialog } from "./components/dialogs/LiveVoiceDialog";
import { ModelPicker } from "./components/dialogs/ModelPicker";
import { ModelRestoreDialog } from "./components/dialogs/ModelRestoreDialog";
import { PlanApprovalDialog } from "./components/dialogs/PlanApprovalDialog";
import { QuickOpenDialog } from "./components/dialogs/QuickOpenDialog";
import { RenameSessionDialog } from "./components/dialogs/RenameSessionDialog";
import { SessionPickerDialog } from "./components/dialogs/SessionPickerDialog";
import { SessionSwitchDialog } from "./components/dialogs/SessionSwitchDialog";
import { ShareSessionDialog } from "./components/dialogs/ShareSessionDialog";
import { TabOverviewDialog } from "./components/dialogs/TabOverviewDialog";
import { TabSwitcher, useTabSwitcherStore } from "./components/dialogs/TabSwitcher";
import { WebDeviceNotice } from "./components/dialogs/WebDeviceNotice";
import { WebPairingDialog } from "./components/dialogs/WebPairingDialog";
import { WorktreeCloseDialog } from "./components/dialogs/WorktreeCloseDialog";
import { WorktreeDialog } from "./components/dialogs/WorktreeDialog";
import { WorktreeLifecycleDialog } from "./components/dialogs/WorktreeLifecycleDialog";
import { AppShell } from "./components/layout/AppShell";
import { DesktopSlotIndicator } from "./components/layout/DesktopSlotIndicator";
import { FirstRunGate } from "./components/onboarding/FirstRunGate";
import { SetupTakeoverHost } from "./components/onboarding/SetupTakeover";
import { StarterTour } from "./components/onboarding/StarterTour";
import { RemoteFolderPickerHost } from "./components/remote/RemoteFolderPicker";
import { SshPromptDialog } from "./components/settings/SshPromptDialog";
import { useExtensionUi } from "./hooks/use-extension-ui";
import { useHostAppearance } from "./hooks/use-host-appearance";
import { useIdleCompactionDraft } from "./hooks/use-idle-compaction-draft";
import { useInterruptedWork } from "./hooks/use-interrupted-work";
import { useOutputStyle } from "./hooks/use-output-style";
import { usePlanApproval } from "./hooks/use-plan-approval";
import { useQuotaResume } from "./hooks/use-quota-resume";
import { useRpcEvents } from "./hooks/use-rpc-events";
import { useSessionAttention } from "./hooks/use-session-attention";
import { newSessionNow, requestSessionSwitch } from "./hooks/use-session-switch";
import { useTraySync } from "./hooks/use-tray-sync";
import { useWorkspaceRecency } from "./hooks/use-workspace-recency";
import { startAgentAppEvents } from "./lib/agent-app";
import { sessionWorking } from "./lib/attention";
import { subscribeBridgeHealth } from "./lib/bridge-health";
import { lazyChunk } from "./lib/chunk-load";
import { restartSidecarFromGui, retryFailedTurn, runSessionCommand } from "./lib/command-registry";
import { hydrateDisplayPreferences, readDisplayPreference, setDisplayPreference } from "./lib/display-preferences";
import { exportSessionHtml } from "./lib/export-session";
import { useLang, useT } from "./lib/i18n";
import { isImeKeyEvent } from "./lib/ime";
import { chordFromEvent, compileKeymap, KEYMAP_ACTION_BY_ID, KEYMAP_ACTIONS, type KeymapActionId } from "./lib/keymap";
import { restoreQueuedMessages, stopFromEscape } from "./lib/messages";
import { openNotifiedTab } from "./lib/notification-click";
import { subscribeOmpUpdated } from "./lib/omp-update";
import { type PaneDirection, paneInDirection, renderedPaneBoxes } from "./lib/pane-focus";
import { watchPluginActivation } from "./lib/plugin-activation";
import { useProjectNames } from "./lib/project-origin";
import { handleRegionKey } from "./lib/region-cycle";
import { writeSidebarVisible } from "./lib/sidebar-memory";
import { closeActiveTab } from "./lib/tab-close";
import { followActivationFocus } from "./lib/tab-focus";
import { installTabHistory, navigateHistory } from "./lib/tab-history";
import {
	acceptsActiveTabEvents,
	onActiveTabRouteSettled,
	onActiveTabRouteState,
	waitForActiveTab,
} from "./lib/tab-routing";
import { focusedTabRpc } from "./lib/tab-rpc";
import { FocusedRuntimeProvider, TabRuntimeProvider } from "./lib/tab-runtime-provider";
import { applyFontSize, watchSystemTheme } from "./lib/theme";
import {
	applyThemeByName,
	clearPluginThemes,
	getPersistedThemeSelection,
	getThemeSelectionVersion,
	initAgentThemeSync,
	loadSystemThemePair,
	refreshPluginThemes,
	resolveThemeSelection,
} from "./lib/themes";
import { startVoiceAutoSpeak } from "./lib/voice";
import { focusWorkBoard } from "./lib/work-board-focus";
import { selectFocusedTabProject } from "./lib/workspace-dirs";
import { hydrateDesktopSlot } from "./stores/desktop-slot";
import { useExtensionUiStore } from "./stores/extension-ui";
import { openHandoffDialog } from "./stores/fork-handoff";
import { useHostedSessionsSync } from "./stores/hosted-sessions";
import { useMachineSetupStore } from "./stores/machine-setup";
import { useModelStore } from "./stores/model";
import { usePreviewVisualEvents } from "./stores/preview-visuals";
import { useRemoteStateSync } from "./stores/remote";
import { useSessionStore } from "./stores/session";
import { useSettingsStore } from "./stores/settings";
import { steppingFromTabId, useActiveTabKind, useSessionTabs, useTabsStore, visibleTabIds } from "./stores/tabs";
import { toast, toastError } from "./stores/toast";
import { isSidebarDrawerMode, migrateDefaultPanelTab, useUiStore } from "./stores/ui";
import { checkForUpdatesInPlace, subscribeUpdaterStatus } from "./stores/updater";
import { WebHostUi } from "./web/host-ui/WebHostUi";

// Heavy overlays code-split: they render null while closed, so they download
// only on first open instead of bloating the eager bundle.
const FeedbackDialog = lazyChunk(() =>
	import("./components/dialogs/FeedbackDialog").then(m => ({ default: m.FeedbackDialog })),
);
const BenchmarkDialog = lazyChunk(() =>
	import("./components/dialogs/BenchmarkDialog").then(m => ({ default: m.BenchmarkDialog })),
);
const ModelSetupDialog = lazyChunk(() =>
	import("./components/settings/model-setup/ModelSetupDialog").then(m => ({ default: m.ModelSetupDialog })),
);
const DebugConsoleDialog = lazyChunk(() =>
	import("./components/dialogs/DebugConsoleDialog").then(m => ({ default: m.DebugConsoleDialog })),
);
const ImportForeignDialog = lazyChunk(() =>
	import("./components/dialogs/ImportForeignDialog").then(m => ({ default: m.ImportForeignDialog })),
);
const ThemePickerDialog = lazyChunk(() =>
	import("./components/dialogs/ThemePickerDialog").then(m => ({ default: m.ThemePickerDialog })),
);

function FocusedSessionEffects() {
	useTraySync();
	useWorkspaceRecency();
	// The run state in the window title and progress on the app icon are always on (no setting).
	// The window title's ● and the dock badge's: a turn that streams, compacts or waits to retry (`sessionWorking`).
	const working = useSessionStore(sessionWorking);
	const titleSessionName = useSessionStore(s => s.sessionName);
	// An extension's `setTitle` (stock rpc `PI_RPC_EMIT_TITLE`) names the window
	// while its tab is in front; each tab keeps its own.
	const titleExtension = useExtensionUiStore(s => s.title);
	// One read for the window title and the dock badge: a waiting child or a failed check counts as a question does.
	const awaiting = useSessionAttention() !== null;
	const compactDensity = useUiStore(s => s.compactDensity);
	const colorBlindMode = useUiStore(s => s.colorBlindMode);

	const titleCwd = useSessionStore(s => s.cwd);
	const titleIsChat = useActiveTabKind() === "chat";
	const titleProjectOf = useProjectNames(
		useMemo(() => (!titleIsChat && titleCwd ? [titleCwd] : []), [titleIsChat, titleCwd]),
	);
	// A linked worktree says which project it belongs to (`acme-web · Autopilot`), never its folder name.
	const titleWorktree = !titleIsChat && titleCwd ? titleProjectOf(titleCwd) : null;
	const titleProject = titleWorktree?.worktree ? titleWorktree.name : null;

	useEffect(() => {
		const base = titleExtension ?? titleSessionName ?? "OMPdesk";
		const name = titleProject ? `${base} — ${titleProject}` : base;
		document.title = awaiting ? `! ${name}` : working ? `● ${name}` : `› ${name}`;
	}, [awaiting, working, titleSessionName, titleExtension, titleProject]);
	useEffect(() => startVoiceAutoSpeak(), []);
	useEffect(() => startAgentAppEvents(), []);
	useEffect(() => {
		const state: RunProgressState = awaiting ? "waiting" : working ? "working" : "idle";
		const timer = setTimeout(() => window.omp.progress.set(state), 200);
		return () => clearTimeout(timer);
	}, [awaiting, working]);
	useEffect(() => {
		document.documentElement.dataset.density = compactDensity ? "tight" : "comfortable";
		document.documentElement.dataset.colorblind = colorBlindMode ? "true" : "false";
	}, [compactDensity, colorBlindMode]);
	return null;
}

/** Usage-limit resume bookings; its own component so tab updates never re-render App. */
function QuotaResumeEffects() {
	useQuotaResume();
	return null;
}

/** Connectivity reports (online/offline to main's turn-resume); its own component so tab updates never re-render App. */
function InterruptedWorkEffects() {
	useInterruptedWork();
	return null;
}

/** Output style delivery to every tab's bridge; its own component so tab updates never re-render App. */
function OutputStyleEffects() {
	useOutputStyle();
	return null;
}

/** Draft empty ⇄ non-empty reports for the bridge's idle compaction; own component for the same reason. */
function IdleCompactionDraftEffects() {
	useIdleCompactionDraft();
	return null;
}

/** B16: the focused paired host's theme and language while the switch is on; own component for the same reason. */
function HostAppearanceEffects() {
	useHostAppearance();
	return null;
}

/** Boot read of the desktop slot (frames keep it current after); own component so tab updates never re-render App. */
function DesktopSlotEffects() {
	useEffect(() => {
		void hydrateDesktopSlot();
	}, []);
	return <DesktopSlotIndicator />;
}

/** ⌥⌘ arrow actions → the direction `paneInDirection` looks in. */
const PANE_DIRECTION: Record<"pane.focusUp" | "pane.focusDown" | "pane.focusLeft" | "pane.focusRight", PaneDirection> =
	{
		"pane.focusUp": "up",
		"pane.focusDown": "down",
		"pane.focusLeft": "left",
		"pane.focusRight": "right",
	};

/**
 * Shell: Sidebar | (TitleBar / ChatStream / InputArea) | PanelContainer,
 * with command palette, extension dialogs, and the model picker overlaid.
 * useRpcEvents() wires the IPC event stream into the stores exactly once.
 */
export function App() {
	useRpcEvents();
	// ⌃⇥ / tab overview order and ⌘[ ⌘] history.
	useEffect(installTabHistory, []);
	useExtensionUi();
	usePlanApproval();
	// Session tabs: GET_TABS boot reconciliation + TAB_STATUS subscription.
	useSessionTabs();
	// Remote devices: the RemoteState snapshot + `remote:state` pushes.
	useRemoteStateSync();
	// The sessions paired devices' tabs run on this computer: sidebar rows with their live state.
	useHostedSessionsSync();
	// The agent's visuals (gui_visualize) bring the Preview forward for their tab.
	usePreviewVisualEvents();
	const theme = useUiStore(s => s.theme);
	const fontSize = useUiStore(s => s.fontSize);
	const followAgentTheme = useUiStore(s => s.followAgentTheme);
	const feedbackOpen = useUiStore(s => s.feedbackOpen);
	const benchmarkOpen = useUiStore(s => s.benchmarkOpen);
	const closeBenchmark = useUiStore(s => s.closeBenchmark);
	// Mounted from its first open on (it keeps its form and results while closed), never at start: its chunk loaded
	// at every launch, and on a phone whose page was older than the computer's update that load crashed the page
	// (v0.38.1, "Importing a module script failed." at Lazy under App).
	const [benchmarkMounted, setBenchmarkMounted] = useState(false);
	if (benchmarkOpen && !benchmarkMounted) setBenchmarkMounted(true);
	// The debug console keeps its request and result between opens: mounted from its first open on.
	// The theme picker (and the theme previews it draws) loads on its first open and stays mounted after, so it
	// closes with its own exit as before; it was the phone's first screen's to load at every start.
	const themePickerOpen = useUiStore(s => s.themePickerOpen);
	const [themePickerMounted, setThemePickerMounted] = useState(false);
	if (themePickerOpen && !themePickerMounted) setThemePickerMounted(true);
	const debugOpen = useUiStore(s => s.debugOpen);
	const [debugMounted, setDebugMounted] = useState(false);
	if (debugOpen && !debugMounted) setDebugMounted(true);
	const modelSetupOpen = useUiStore(s => s.modelSetupOpen);
	const importDialogOpen = useUiStore(s => s.importDialogOpen);
	const activeTabId = useTabsStore(s => s.activeTabId);
	const split = useTabsStore(s => s.split);
	const activeTabStatus = useTabsStore(s => s.tabs.find(tab => tab.id === s.activeTabId)?.status);
	const themeSidecarReady = activeTabStatus === "ready" || activeTabStatus === "running";
	const { lang, setLang } = useLang();
	const t = useT();
	// Required machine setup (Bun, Git Bash, omp) takes over the whole window:
	// SetupTakeoverHost (inside the tab's runtime) publishes the flag; everything
	// but the setup screen is inert, and the entry points below that need no
	// focus (menu actions, deep links, chords) read it too.
	const setupTakeover = useMachineSetupStore(s => s.takeover);

	// Seed theme/fontSize from persisted prefs once at boot.
	useEffect(() => {
		let cancelled = false;
		const changedPreferences = new Set<string>();
		const unsubscribe = useUiStore.subscribe((next, previous) => {
			for (const key of [
				"compactDensity",
				"colorBlindMode",
				"followAgentTheme",
				"fontSize",
				"notifications",
				"notificationSound",
				"notificationVolume",
				"linkPreview",
				"panelSide",
				"thinkingExpanded",
				"transcriptDetail",
				"panelTab",
				"sidebarVisible",
			] as const) {
				if (next[key] !== previous[key]) changedPreferences.add(key);
			}
		});
		const initialThemeVersion = getThemeSelectionVersion();
		void window.omp.prefs
			.get()
			.then(async raw => {
				if (cancelled) return;
				const prefs = (raw ?? {}) as Partial<Record<string, unknown>>;
				hydrateDisplayPreferences(prefs.displayPreferences);
				loadSystemThemePair(prefs);
				const selection = await getPersistedThemeSelection(prefs);
				if (cancelled) return;
				if (getThemeSelectionVersion() === initialThemeVersion) {
					applyThemeByName(selection, { persist: false });
					useUiStore.setState({
						theme: selection === "system" ? "system" : resolveThemeSelection(selection).scheme,
					});
				}
				for (const key of [
					"compactDensity",
					"colorBlindMode",
					"followAgentTheme",
					"notificationSound",
					"linkPreview",
				] as const) {
					if (typeof prefs[key] === "boolean" && !changedPreferences.has(key))
						useUiStore.setState({ [key]: prefs[key] });
				}
				if (typeof prefs.fontSize === "number" && !changedPreferences.has("fontSize")) {
					useUiStore.setState({ fontSize: prefs.fontSize });
				}
				if (typeof prefs.notifications === "boolean" && !changedPreferences.has("notifications")) {
					useUiStore.setState({ notifications: prefs.notifications });
				}
				if (
					typeof prefs.notificationVolume === "number" &&
					prefs.notificationVolume >= 0 &&
					prefs.notificationVolume <= 100 &&
					!changedPreferences.has("notificationVolume")
				) {
					useUiStore.setState({ notificationVolume: prefs.notificationVolume });
				}
				if ((prefs.panelSide === "left" || prefs.panelSide === "right") && !changedPreferences.has("panelSide")) {
					useUiStore.setState({ panelSide: prefs.panelSide });
				}
				if (typeof prefs.thinkingExpanded === "boolean" && !changedPreferences.has("thinkingExpanded")) {
					useUiStore.setState({ thinkingExpanded: prefs.thinkingExpanded });
				}
				if (
					(prefs.transcriptDetail === "compact" || prefs.transcriptDetail === "full") &&
					!changedPreferences.has("transcriptDetail")
				) {
					useUiStore.setState({ transcriptDetail: prefs.transcriptDetail });
				}
				// Restore the default workspace panel tab (written by Settings → GUI).
				if (!changedPreferences.has("panelTab") && prefs.defaultPanelTab !== undefined) {
					useUiStore.setState({ panelTab: migrateDefaultPanelTab(prefs.defaultPanelTab) });
				}
				// The sidebar as it was left (the localStorage mirror painted the first frame; a drawer never opens by it).
				if (typeof prefs.sidebarVisible === "boolean" && !changedPreferences.has("sidebarVisible")) {
					if (isSidebarDrawerMode()) writeSidebarVisible(prefs.sidebarVisible);
					else useUiStore.setState({ sidebarVisible: prefs.sidebarVisible });
				}
			})
			.catch(() => {})
			.finally(unsubscribe);
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, []);

	// Terminal palettes affect the application only when explicitly requested.
	useEffect(
		() => (followAgentTheme && themeSidecarReady ? initAgentThemeSync() : undefined),
		[followAgentTheme, themeSidecarReady],
	);
	useEffect(
		() =>
			onActiveTabRouteState(ready => {
				if (!ready) clearPluginThemes();
			}),
		[],
	);

	// Restart-required plugin installs queue while a run is in flight; restart
	// the active sidecar (resuming its session) once the run settles.
	useEffect(() => watchPluginActivation(), []);

	// Plugin themes are session-scoped: refresh only when the selected tab is
	// both routed and ready. Route settlement and sidecar readiness can arrive
	// in either order, so each transition owns one half of the closed loop.
	useEffect(() => {
		if (!activeTabId) return;
		if ((activeTabStatus === "ready" || activeTabStatus === "running") && acceptsActiveTabEvents()) {
			void refreshPluginThemes();
		}
	}, [activeTabId, activeTabStatus]);
	useEffect(
		() =>
			onActiveTabRouteSettled(() => {
				const tabs = useTabsStore.getState();
				const status = tabs.tabs.find(tab => tab.id === tabs.activeTabId)?.status;
				if ((status === "ready" || status === "running") && acceptsActiveTabEvents()) {
					void refreshPluginThemes();
				}
			}),
		[],
	);

	// Font changes do not participate in theme resolution.
	useEffect(() => watchSystemTheme(theme, () => applyThemeByName("system", { persist: false })), [theme]);
	useEffect(() => applyFontSize(fontSize), [fontSize]);

	// A clicked notification about a tab brings that tab forward (lib/notification-click.ts).
	useEffect(() => window.omp.events.onNotificationClick(({ tabId }) => openNotifiedTab(tabId)), []);

	// Handle omp:// deep links (omp://new → new session; omp://session/<id> → switch).
	useEffect(() => {
		const handle = async (link: { action: "new-session" } | { action: "switch-session"; sessionId: string }) => {
			if (useMachineSetupStore.getState().takeover) return;
			if (link.action === "new-session") {
				if (useSessionStore.getState().isStreaming) {
					toast({ variant: "warning", title: t("deepLink.streaming"), message: t("deepLink.streamingDesc") });
					return;
				}
				try {
					await newSessionNow();
				} catch (error) {
					toastError({ title: t("sidebar.openFailed"), error });
				}
				return;
			}
			try {
				const sessions = await window.omp.sessions.list("global");
				const target = sessions.find(s => s.id === link.sessionId);
				if (!target) {
					toast({ variant: "error", title: t("deepLink.notFound"), message: link.sessionId });
					return;
				}
				// Busy sessions route to the switch dialog (new window vs abort);
				// idle sessions switch straight through.
				requestSessionSwitch(target);
			} catch (error) {
				toastError({ title: t("sidebar.openFailed"), error });
			}
		};
		return window.omp.events.onDeepLink(link => void handle(link));
	}, [t]);
	// User keybinding overrides → precompiled chord → actionId lookup (B3,
	// plan/15 §3.5): keydown dispatch is an O(1) map hit, never a config walk.
	// Defaults resolve for the renderer's platform (⌘ → ⌃ on Windows).
	// The memo recomputes only when the overrides object identity changes.
	const keymapOverrides = useUiStore(s => s.keymapOverrides);
	const keymap = useMemo(() => compileKeymap(KEYMAP_ACTIONS, keymapOverrides), [keymapOverrides]);

	// Boot hydration of user keybinding overrides (prefs key "keymapOverrides").
	useEffect(() => {
		void useUiStore.getState().hydrateKeymap();

		// One dispatch switch keyed by actionId: the compiled-map lookup below and
		// the default chords share these handlers (they were the hardcoded chains).
		const dispatchKeymapAction = (actionId: KeymapActionId) => {
			// While a new tab opens and main moves the RPC/event route to it, a shortcut reaches neither the tab being
			// left nor nothing (⌘W right after ⌘T closed the old tab: nightly 39525167897); it waits (waitForActiveTab).
			if (waitForActiveTab(() => dispatchKeymapAction(actionId))) return;
			const ui = useUiStore.getState();
			switch (actionId) {
				case "model.cycleForward":
					// ⌃P — cycle to the next model (TUI parity).
					void runSessionCommand(focusedTabRpc().cycleModel(), t("palette.failed"));
					return;
				case "model.cycleBackward":
					// ⇧⌃P — cycle model backward (TUI app.model.cycleBackward), via the
					// cycle_model direction arg (A1 RPC).
					void runSessionCommand(focusedTabRpc().cycleModel("backward"), t("palette.failed"));
					return;
				case "retry":
					// ⌥R — retry the last failed turn (TUI app.retry) via the retry RPC.
					// Distinct from the palette's re-send-last-message action: this knows
					// what "failed turn" means server-side.
					void retryFailedTurn(focusedTabRpc()).catch(error => toastError({ title: t("palette.failed"), error }));
					return;
				case "dequeue":
					// ⌥↑ — restore queued messages to the composer (TUI app.message.dequeue):
					// newest queued steer/follow-up back into the composer, rest re-queued.
					void restoreQueuedMessages(() => toast({ variant: "info", message: t("input.dequeueEmpty") })).catch(
						error => toastError({ title: t("palette.failed"), error }),
					);
					return;
				case "plan.toggle": {
					// ⌥⇧P — toggle plan mode (TUI app.plan.toggle).
					const enabled = !useSessionStore.getState().planModeEnabled;
					void runSessionCommand(focusedTabRpc().setPlanMode(enabled), t("settings.runtime.planMode"), data => {
						const result = data as { enabled?: boolean } | undefined;
						if (typeof result?.enabled === "boolean")
							useSessionStore.setState({ planModeEnabled: result.enabled });
					});
					return;
				}
				case "tools.expand":
					// ⌃O — expand/collapse all tool cards (TUI app.tools.expand).
					ui.toggleToolsExpandAll();
					return;
				case "thinking.toggle": {
					// ⌃T (⌥⌃T on Windows) — show/hide thinking blocks (TUI app.thinking.toggle).
					void setDisplayPreference("hideThinkingBlock", !readDisplayPreference("hideThinkingBlock"));
					return;
				}
				case "thinking.cycle":
					// ⌥⇧T — next thinking level (the TUI's ⇧Tab, which stays focus navigation in the GUI).
					void runSessionCommand(focusedTabRpc().cycleThinkingLevel(), t("palette.failed"));
					return;
				case "tab.new":
					// ⌘T (⌃T on Windows) — new agent tab (type chosen at creation, immutable).
					void useTabsStore.getState().openTab();
					return;
				case "tab.newChat":
					void useTabsStore.getState().openTab({ kind: "chat" });
					return;
				case "tab.newWorktree":
					// ⌥T — new worktree tab (create dialog, plan/20).
					useUiStore.getState().openWorktreeDialog();
					return;
				case "tab.close":
					// ⌘W (⌃W on Windows) — close the active tab, arming the chip's inline
					// confirm while its run is live (⇧⌘W closes the window from the menu).
					closeActiveTab();
					return;
				case "tab.next":
				case "tab.prev":
				case "pane.next":
				case "pane.prev": {
					// ⇧⌘] steps the strip (the panes while a split shows); ⌥⌘] the panes only.
					const state = useTabsStore.getState();
					if (actionId.startsWith("pane") && !state.split) return;
					const ids = state.split ? visibleTabIds(state) : state.tabs.map(tab => tab.id);
					if (ids.length < 2) return;
					const from = steppingFromTabId(state);
					const index = from ? ids.indexOf(from) : -1;
					const step = actionId.endsWith("next") ? 1 : -1;
					void state.switchTab(ids[(index + step + ids.length) % ids.length]);
					return;
				}
				case "tab.switcher":
				case "tab.switcherBack":
					// Opens on the previous tab (⌃⇥) or the oldest (⌃⇧⇥); the overlay
					// takes further presses itself and commits when ⌃ is released.
					if (useTabsStore.getState().tabs.length < 2) return;
					useTabSwitcherStore.setState({ step: actionId === "tab.switcher" ? 1 : -1 });
					useUiStore.setState({ tabSwitcherOpen: true });
					return;
				case "tab.overview":
					useUiStore.setState({ tabOverviewOpen: true });
					return;
				case "nav.back":
				case "nav.forward":
					void navigateHistory(actionId === "nav.back" ? -1 : 1);
					return;
				case "pane.focusUp":
				case "pane.focusDown":
				case "pane.focusLeft":
				case "pane.focusRight": {
					const state = useTabsStore.getState();
					if (!state.split || !state.activeTabId) return;
					const direction = PANE_DIRECTION[actionId];
					const target = paneInDirection(renderedPaneBoxes(), state.activeTabId, direction);
					if (target) void state.switchTab(target);
					return;
				}
				case "tab.goto1":
				case "tab.goto2":
				case "tab.goto3":
				case "tab.goto4":
				case "tab.goto5":
				case "tab.goto6":
				case "tab.goto7":
				case "tab.goto8":
					// ⌘1…⌘8 — the tab at that strip position (no-op past the end).
					void useTabsStore.getState().switchTabAt(Number(actionId.slice("tab.goto".length)));
					return;
				case "tab.gotoLast":
					void useTabsStore.getState().switchTabAt("last");
					return;
				case "tab.reopen":
					void useTabsStore.getState().reopenClosedTab();
					return;
				case "quickOpen":
					ui.openQuickOpen();
					return;
				case "sessions.search":
					// ⇧⌘F — the session picker searches titles, prompts and transcript text.
					ui.openSessionPicker();
					return;
				case "pr.center":
					// ⌥P — Agents › Pull requests.
					ui.openAgents("prs");
					return;
				case "model.select":
					// ⌥M — model picker (TUI app.model.select).
					ui.openModelPicker();
					return;
				case "agents.hub":
					// ⌥A — Agents › Live (TUI app.agents.hub).
					ui.openAgents("live");
					return;
				case "palette":
					if (ui.commandPaletteOpen) ui.closeCommandPalette();
					else ui.openCommandPalette();
					return;
				case "settings":
					ui.openSettings();
					return;
				case "board.focus":
					// ⌥B — jump into the work board of the focused pane (waiting questions first).
					focusWorkBoard();
					return;
				case "sidebar.toggle":
					ui.toggleSidebar();
					return;
				case "files.search":
					ui.openFilesSearch();
					return;
				case "panel.toggle":
					ui.togglePanel();
					return;
				case "panel.terminal":
				case "panel.diff":
				case "panel.preview":
				case "panel.files":
					ui.setPanelTab(migrateDefaultPanelTab(actionId.slice("panel.".length)));
					return;
				case "hotkeys":
					// ⌘/ or ⌃/ — Settings › Keyboard (/hotkeys parity); again returns.
					if (ui.destination === "settings" && ui.settingsTab === "keyboard") ui.closeDestination();
					else ui.openSettings("keyboard");
					return;
			}
		};

		const onKey = (event: KeyboardEvent) => {
			// One physical shortcut dispatches once; IME composition owns Escape.
			if (event.repeat || isImeKeyEvent(event)) return;
			// The setup screen takes every chord.
			if (useMachineSetupStore.getState().takeover) return;
			const ui = useUiStore.getState();
			const overlayOpen =
				ui.commandPaletteOpen ||
				ui.modelPickerOpen ||
				ui.destination !== "session" ||
				ui.benchmarkOpen ||
				ui.modelSetupOpen ||
				ui.sessionPickerOpen ||
				ui.branchPickerOpen ||
				ui.quickOpenOpen ||
				ui.tabSwitcherOpen ||
				ui.tabOverviewOpen;
			if (event.key === "Escape") {
				// Don't abort when an overlay/dropdown already consumed this Escape to
				// dismiss itself (its handler ran first + preventDefault). With a draft in the
				// field the first Esc only arms "Esc again to stop" (lib/messages.ts stopFromEscape).
				if (
					acceptsActiveTabEvents() &&
					!event.defaultPrevented &&
					!overlayOpen &&
					!document.querySelector('[role="dialog"]')
				)
					stopFromEscape();
				return;
			}

			// Remappable chords (B3): one O(1) lookup in the compiled keymap. The
			// overlayOpen / defaultPrevented / [role=dialog] guards apply exactly
			// as the pre-B3 hardcoded chains — overlay-safe actions (the old
			// unguarded ⌘ block: palette, settings, sidebar, panel, hotkeys, ⌃P)
			// still fire anywhere, the rest stay suppressed.
			const chord = chordFromEvent(event);
			if (!chord) return;
			const actionId = keymap.get(chord);
			if (!actionId) return;
			if (KEYMAP_ACTION_BY_ID[actionId].overlaySafe) {
				event.preventDefault();
				dispatchKeymapAction(actionId);
				return;
			}
			if (!overlayOpen && !event.defaultPrevented && !document.querySelector('[role="dialog"]')) {
				event.preventDefault();
				dispatchKeymapAction(actionId);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [t, keymap]);

	// A session activation (⌃Tab, a sidebar row, New session, ⌘T) hands the next keystroke to the composer.
	useEffect(() => followActivationFocus(), []);
	// F6 / Shift+F6 move between the window's regions (sidebar, transcript, composer, work board, side panel). In
	// the capture phase: the terminal sends every key to its shell, so F6 would never leave it (as VS Code skips the
	// shell for its region keys).
	useEffect(() => {
		window.addEventListener("keydown", handleRegionKey, true);
		return () => window.removeEventListener("keydown", handleRegionKey, true);
	}, []);

	// Updater status: main-process push + boot replay, unsubscribed on unmount.
	useEffect(() => subscribeUpdaterStatus(), []);
	// gui-bridge compatibility warnings: main-process signal + boot drain.
	useEffect(() => subscribeBridgeHealth(), []);
	// "omp updated to X" after omp updated itself (main sends it to one window).
	useEffect(() => subscribeOmpUpdated(), []);

	useEffect(() => {
		const run = async (action: MenuAction, payload?: MenuActionPayload) => {
			const ui = useUiStore.getState();
			// The setup screen blocks every menu command (the tray's "new session"
			// included) except the language switch.
			if (useMachineSetupStore.getState().takeover && action !== "toggle-language") return;
			if (action === "toggle-sidebar") {
				ui.toggleSidebar();
				return;
			}
			if (action === "toggle-panel") {
				ui.togglePanel();
				return;
			}
			if (action === "toggle-language") {
				setLang(nextUiLanguage(lang));
				return;
			}
			// New tab actions never touch the live run — they must stay OUT of the
			// streaming busy-guard below (unlike new-session/open-project).
			if (action === "new-tab") {
				void useTabsStore.getState().openTab();
				return;
			}
			if (action === "new-chat-tab") {
				void useTabsStore.getState().openTab({ kind: "chat" });
				return;
			}
			// Window-only surfaces do not require a live sidecar. Keep these actions
			// usable while the agent is starting, asleep, or recovering.
			if (action === "open-settings") {
				ui.openSettings();
				return;
			}
			if (action === "check-updates") {
				// Claude-style: check in place; the sidebar card reports the outcome.
				void checkForUpdatesInPlace();
				return;
			}
			if (action === "open-usage") {
				ui.openInsights("usage");
				return;
			}
			if (action === "open-model-picker") {
				ui.openModelPicker();
				return;
			}
			if (action === "open-import") {
				ui.openImportDialog();
				return;
			}
			if (action === "open-branch-picker") {
				ui.openBranchPicker();
				return;
			}
			if (action === "open-session-tree") {
				ui.openSessionTree();
				return;
			}
			if (action === "open-capabilities") {
				ui.openSettings("agent");
				return;
			}
			if (action === "open-git") {
				ui.setPanelTab("diff");
				return;
			}
			if (action === "restart-sidecar") {
				void restartSidecarFromGui();
				return;
			}
			if (action === "open-command-center") {
				ui.openCommandPalette();
				return;
			}
			if (action === "open-context-report") {
				ui.openInsights("stats", "session");
				return;
			}
			if (action === "open-jobs") {
				ui.openJobs();
				return;
			}
			if (action === "open-stats") {
				ui.openInsights("stats", "all");
				return;
			}
			if (action === "open-feedback") {
				ui.openFeedback();
				return;
			}
			if (action === "open-hotkeys") {
				ui.openSettings("keyboard");
				return;
			}
			if (action === "open-session-info") {
				ui.openInsights("stats", "session");
				return;
			}
			if (action === "open-share-session") {
				ui.openShareSession();
				return;
			}
			if (action === "open-workspace-dirs") {
				ui.openSettings("workspace");
				return;
			}
			if (action === "open-agent-hub") {
				ui.openAgents("definitions");
				return;
			}
			if (action === "open-modes") {
				ui.openModes();
				return;
			}
			if (action === "open-providers") {
				ui.openProviders();
				return;
			}
			if (action === "open-model-roles") {
				ui.openSettings("models:roles");
				return;
			}
			if (action === "open-extensions") {
				ui.openSettings("tools:skills");
				return;
			}
			if (action === "open-inventory") {
				ui.openSettings("tools:plugins");
				return;
			}
			if (action === "open-pr-center") {
				ui.openAgents("prs");
				return;
			}
			if (action === "open-debug") {
				ui.openDebug();
				return;
			}
			// Menu commands below read or mutate the selected sidecar: after a new tab main has not answered yet, and in
			// the short selected-vs-routed gap, they wait instead of reaching the old tab or being dropped.
			if (waitForActiveTab(() => void run(action, payload))) return;
			if (action === "close-tab") {
				closeActiveTab();
				return;
			}
			if (action === "toggle-fast") {
				void useModelStore.getState().toggleFastMode();
				return;
			}
			if (action === "cycle-thinking") {
				void runSessionCommand(focusedTabRpc().cycleThinkingLevel(), t("palette.failed"));
				return;
			}
			if (action === "set-approval") {
				if (payload?.approvalMode) useSettingsStore.getState().setApprovalMode(payload.approvalMode);
				return;
			}
			if (
				useSessionStore.getState().isStreaming &&
				(action === "new-session" ||
					action === "open-project" ||
					action === "handoff" ||
					action === "switch-project")
			) {
				toast({ variant: "warning", message: t("sessionSwitch.busyBlocked") });
				return;
			}

			try {
				if (action === "open-project") {
					await selectFocusedTabProject();
				} else if (action === "switch-project") {
					if (payload?.cwd) await window.omp.sidecar.setProject(payload.cwd);
				} else if (action === "new-session") {
					await newSessionNow();
				} else if (action === "export-html") {
					await exportSessionHtml();
				} else if (action === "handoff") {
					openHandoffDialog();
				}
			} catch (error) {
				toastError({ title: t("app.actionFailed"), error });
			}
		};
		return window.omp.events.onMenuAction((action, payload) => void run(action, payload));
	}, [lang, setLang, t]);

	const surface = (
		<div className="omp-app-root flex h-screen w-screen overflow-hidden text-(--sc-text)">
			<div className="contents" inert={setupTakeover}>
				{activeTabId && <FocusedSessionEffects />}
				<QuotaResumeEffects />
				<DesktopSlotEffects />
				<InterruptedWorkEffects />
				<OutputStyleEffects />
				<IdleCompactionDraftEffects />
				<HostAppearanceEffects />
				<AppShell />

				<CommandPalette />
				{visibleTabIds({ activeTabId, split }).map(tabId => (
					<TabRuntimeProvider key={tabId} tabId={tabId}>
						<ExtensionDialog />
						<PlanApprovalDialog />
					</TabRuntimeProvider>
				))}
				<FirstRunGate />
				<ModelPicker />
				<RenameSessionDialog />
				<WorktreeDialog />
				<WorktreeCloseDialog />
				<WorktreeLifecycleDialog />
				<SessionPickerDialog />
				<QuickOpenDialog />
				<TabSwitcher />
				<TabOverviewDialog />
				<SessionSwitchDialog />
				<ModelRestoreDialog />
				<BranchPickerDialog />
				<BtwDialog />
				{debugMounted ? (
					<Suspense fallback={null}>
						<DebugConsoleDialog />
					</Suspense>
				) : null}
				<LiveVoiceDialog />
				<CopySelectorDialog />
				<ActiveToolsDialog />
				<ShareSessionDialog />
				<ChangelogDialog />
				<WhatsNewNotice />
				<StarterTour />
				<ForceToolDialog />
				<HandoffDialog />
				<RemoteFolderPickerHost />
				<WebPairingDialog />
				<WebDeviceNotice />
				<WebHostUi />
				<SshPromptDialog />
				{benchmarkMounted ? (
					<Suspense fallback={null}>
						<BenchmarkDialog open={benchmarkOpen} onClose={closeBenchmark} />
					</Suspense>
				) : null}
				<Suspense fallback={null}>{modelSetupOpen && <ModelSetupDialog />}</Suspense>
				{themePickerMounted ? (
					<Suspense fallback={null}>
						<ThemePickerDialog />
					</Suspense>
				) : null}
				<Suspense fallback={null}>{importDialogOpen && <ImportForeignDialog />}</Suspense>
				<Suspense fallback={null}>{feedbackOpen && <FeedbackDialog />}</Suspense>
			</div>
			<SetupTakeoverHost />
			<ToastStack />
		</div>
	);
	return <FocusedRuntimeProvider tabId={activeTabId}>{surface}</FocusedRuntimeProvider>;
}
