import { lazy, Suspense, useEffect, useMemo } from "react";
import type { MenuAction, MenuActionPayload, RunProgressState } from "../shared/ipc-types";
import { nextUiLanguage } from "../shared/ui-language";
import { ToastStack } from "./components/common";
import { ActiveToolsDialog } from "./components/dialogs/ActiveToolsDialog";
import { BranchPickerDialog } from "./components/dialogs/BranchPickerDialog";
import { BtwDialog } from "./components/dialogs/BtwDialog";
import { ChangelogDialog } from "./components/dialogs/ChangelogDialog";
import { CommandPalette } from "./components/dialogs/CommandPalette";
import { CopySelectorDialog } from "./components/dialogs/CopySelectorDialog";
import { DebugConsoleDialog } from "./components/dialogs/DebugConsoleDialog";
import { ExtensionDialog } from "./components/dialogs/ExtensionDialog";
import { ForceToolDialog } from "./components/dialogs/ForceToolDialog";
import { HandoffDialog } from "./components/dialogs/HandoffDialog";
import { ImportForeignDialog } from "./components/dialogs/ImportForeignDialog";
import { LiveVoiceDialog } from "./components/dialogs/LiveVoiceDialog";
import { ModelPicker } from "./components/dialogs/ModelPicker";
import { ModelRestoreDialog } from "./components/dialogs/ModelRestoreDialog";
import { PlanApprovalDialog } from "./components/dialogs/PlanApprovalDialog";
import { RenameSessionDialog } from "./components/dialogs/RenameSessionDialog";
import { SessionPickerDialog } from "./components/dialogs/SessionPickerDialog";
import { SessionSwitchDialog } from "./components/dialogs/SessionSwitchDialog";
import { ShareSessionDialog } from "./components/dialogs/ShareSessionDialog";
import { ThemePickerDialog } from "./components/dialogs/ThemePickerDialog";
import { WorktreeCloseDialog } from "./components/dialogs/WorktreeCloseDialog";
import { WorktreeDialog } from "./components/dialogs/WorktreeDialog";
import { AppShell } from "./components/layout/AppShell";
import { FirstRunGate } from "./components/onboarding/FirstRunGate";
import { RemoteFolderPickerHost } from "./components/remote/RemoteFolderPicker";
import { useAwaitingConfirmation } from "./hooks/use-awaiting-confirmation";
import { useExtensionUi } from "./hooks/use-extension-ui";
import { useRpcEvents } from "./hooks/use-rpc-events";
import { newSessionNow, requestSessionSwitch } from "./hooks/use-session-switch";
import { useTraySync } from "./hooks/use-tray-sync";
import { useWorkspaceRecency } from "./hooks/use-workspace-recency";
import { subscribeBridgeHealth } from "./lib/bridge-health";
import { restartSidecarFromGui, retryFailedTurn, runSessionCommand } from "./lib/command-registry";
import {
	hydrateDisplayPreferences,
	readDisplayPreference,
	setDisplayPreference,
	useDisplayPreference,
} from "./lib/display-preferences";
import { exportSessionHtml } from "./lib/export-session";
import { useLang, useT } from "./lib/i18n";
import { isImeKeyEvent } from "./lib/ime";
import { chordFromEvent, compileKeymap, KEYMAP_ACTION_BY_ID, KEYMAP_ACTIONS, type KeymapActionId } from "./lib/keymap";
import { abortActiveTurn, restoreQueuedMessages } from "./lib/messages";
import { watchPluginActivation } from "./lib/plugin-activation";
import { closeActiveTab } from "./lib/tab-close";
import { acceptsActiveTabEvents, onActiveTabRouteSettled, onActiveTabRouteState } from "./lib/tab-routing";
import { focusedTabRpc } from "./lib/tab-rpc";
import { applyFontSize, watchSystemTheme } from "./lib/theme";
import {
	applyThemeByName,
	clearPluginThemes,
	getPersistedThemeSelection,
	getThemeSelectionVersion,
	initAgentThemeSync,
	refreshPluginThemes,
	resolveThemeSelection,
} from "./lib/themes";
import { startVoiceAutoSpeak } from "./lib/voice";
import { selectFocusedTabProject } from "./lib/workspace-dirs";
import { openHandoffDialog } from "./stores/fork-handoff";
import { useModelStore } from "./stores/model";
import { useRemoteStateSync } from "./stores/remote";
import { useSessionStore } from "./stores/session";
import { SessionRuntimeProvider } from "./stores/session-runtime-context";
import { useSettingsStore } from "./stores/settings";
import { ensureTabRuntime } from "./stores/tab-runtime";
import { useSessionTabs, useTabsStore } from "./stores/tabs";
import { toast, toastError } from "./stores/toast";
import { type PanelTab, useUiStore } from "./stores/ui";
import { checkForUpdatesInPlace, subscribeUpdaterStatus } from "./stores/updater";

// Heavy overlays code-split: they render null while closed, so they download
// only on first open instead of bloating the eager bundle.
const FeedbackDialog = lazy(() =>
	import("./components/dialogs/FeedbackDialog").then(m => ({ default: m.FeedbackDialog })),
);
const BenchmarkDialog = lazy(() =>
	import("./components/dialogs/BenchmarkDialog").then(m => ({ default: m.BenchmarkDialog })),
);
const ModelSetupDialog = lazy(() =>
	import("./components/settings/model-setup/ModelSetupDialog").then(m => ({ default: m.ModelSetupDialog })),
);

function FocusedSessionEffects() {
	useTraySync();
	useWorkspaceRecency();
	const titleRunState = useDisplayPreference("titleState");
	const titleStreaming = useSessionStore(s => s.isStreaming);
	const titleSessionName = useSessionStore(s => s.sessionName);
	const titleAwaiting = useAwaitingConfirmation();
	const progressEnabled = useDisplayPreference("showProgress");
	const progressStreaming = useSessionStore(s => s.isStreaming);
	const progressAwaiting = useAwaitingConfirmation();
	const compactDensity = useUiStore(s => s.compactDensity);
	const colorBlindMode = useUiStore(s => s.colorBlindMode);

	useEffect(() => {
		const name = titleSessionName ?? "OMPdesk";
		document.title = !titleRunState ? name : titleAwaiting ? `! ${name}` : titleStreaming ? `● ${name}` : `› ${name}`;
	}, [titleRunState, titleAwaiting, titleStreaming, titleSessionName]);
	useEffect(() => startVoiceAutoSpeak(), []);
	useEffect(() => {
		const state: RunProgressState = !progressEnabled
			? "idle"
			: progressAwaiting
				? "waiting"
				: progressStreaming
					? "working"
					: "idle";
		const timer = setTimeout(() => window.omp.progress.set(state), 200);
		return () => clearTimeout(timer);
	}, [progressEnabled, progressAwaiting, progressStreaming]);
	useEffect(() => {
		document.documentElement.dataset.density = compactDensity ? "tight" : "comfortable";
		document.documentElement.dataset.colorblind = colorBlindMode ? "true" : "false";
	}, [compactDensity, colorBlindMode]);
	return null;
}

/**
 * Shell: Sidebar | (TitleBar / ChatStream / InputArea) | PanelContainer,
 * with command palette, extension dialogs, and the model picker overlaid.
 * useRpcEvents() wires the IPC event stream into the stores exactly once.
 */
export function App() {
	useRpcEvents();
	useExtensionUi();
	// Session tabs: GET_TABS boot reconciliation + TAB_STATUS subscription.
	useSessionTabs();
	// Remote devices: the RemoteState snapshot + `remote:state` pushes.
	useRemoteStateSync();
	const theme = useUiStore(s => s.theme);
	const fontSize = useUiStore(s => s.fontSize);
	const followAgentTheme = useUiStore(s => s.followAgentTheme);
	const feedbackOpen = useUiStore(s => s.feedbackOpen);
	const benchmarkOpen = useUiStore(s => s.benchmarkOpen);
	const closeBenchmark = useUiStore(s => s.closeBenchmark);
	const modelSetupOpen = useUiStore(s => s.modelSetupOpen);
	const importDialogOpen = useUiStore(s => s.importDialogOpen);
	const activeTabId = useTabsStore(s => s.activeTabId);
	const activeTabStatus = useTabsStore(s => s.tabs.find(tab => tab.id === s.activeTabId)?.status);
	const themeSidecarReady = activeTabStatus === "ready" || activeTabStatus === "running";
	const { lang, setLang } = useLang();
	const t = useT();

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
				"thinkingExpanded",
				"transcriptDetail",
				"panelTab",
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
				const selection = await getPersistedThemeSelection(prefs);
				if (cancelled) return;
				if (getThemeSelectionVersion() === initialThemeVersion) {
					applyThemeByName(selection, { persist: false });
					useUiStore.setState({
						theme: selection === "system" ? "system" : resolveThemeSelection(selection).scheme,
					});
				}
				for (const key of ["compactDensity", "colorBlindMode", "followAgentTheme"] as const) {
					if (typeof prefs[key] === "boolean" && !changedPreferences.has(key))
						useUiStore.setState({ [key]: prefs[key] });
				}
				if (typeof prefs.fontSize === "number" && !changedPreferences.has("fontSize")) {
					useUiStore.setState({ fontSize: prefs.fontSize });
				}
				if (typeof prefs.notifications === "boolean" && !changedPreferences.has("notifications")) {
					useUiStore.setState({ notifications: prefs.notifications });
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
				if (
					!changedPreferences.has("panelTab") &&
					typeof prefs.defaultPanelTab === "string" &&
					["diff", "files", "logs"].includes(prefs.defaultPanelTab)
				) {
					useUiStore.setState({ panelTab: prefs.defaultPanelTab as PanelTab });
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

	// Handle omp:// deep links (omp://new → new session; omp://session/<id> → switch).
	useEffect(() => {
		const handle = async (link: { action: "new-session" } | { action: "switch-session"; sessionId: string }) => {
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
			// The visible tab changes before main finishes moving the RPC/event route.
			// Never let a shortcut mutate the outgoing sidecar during that gap.
			if (!acceptsActiveTabEvents()) return;
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
					void retryFailedTurn().catch(error => toastError({ title: t("palette.failed"), error }));
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
				case "tab.prev": {
					const { tabs, activeTabId, switchTab } = useTabsStore.getState();
					if (tabs.length < 2) return;
					const index = tabs.findIndex(tab => tab.id === activeTabId);
					const step = actionId === "tab.next" ? 1 : -1;
					void switchTab(tabs[(index + step + tabs.length) % tabs.length].id);
					return;
				}
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
				case "sidebar.toggle":
					ui.toggleSidebar();
					return;
				case "panel.toggle":
					ui.togglePanel();
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
			const ui = useUiStore.getState();
			const overlayOpen =
				ui.commandPaletteOpen ||
				ui.modelPickerOpen ||
				ui.destination !== "session" ||
				ui.benchmarkOpen ||
				ui.modelSetupOpen ||
				ui.sessionPickerOpen ||
				ui.branchPickerOpen;
			if (event.key === "Escape") {
				// Don't abort when an overlay/dropdown already consumed this Escape to
				// dismiss itself (its handler ran first + preventDefault).
				if (
					acceptsActiveTabEvents() &&
					!event.defaultPrevented &&
					!overlayOpen &&
					!document.querySelector('[role="dialog"]')
				)
					void abortActiveTurn();
				return;
			}

			// ⇧Tab — cycle thinking level (TUI app.thinking.cycle). In the TUI the
			// binding lives in the editor, so hijack it only while a textarea (the
			// composer) owns focus; elsewhere Shift+Tab keeps its focus-traversal
			// role. Focus-gated and NOT remappable.
			if (event.key === "Tab" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
				if (
					acceptsActiveTabEvents() &&
					!overlayOpen &&
					!event.defaultPrevented &&
					!document.querySelector('[role="dialog"]') &&
					document.activeElement instanceof HTMLTextAreaElement
				) {
					event.preventDefault();
					void runSessionCommand(focusedTabRpc().cycleThinkingLevel(), t("palette.failed"));
				}
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

	// Updater status: main-process push + boot replay, unsubscribed on unmount.
	useEffect(() => subscribeUpdaterStatus(), []);
	// gui-bridge compatibility warnings: main-process signal + boot drain.
	useEffect(() => subscribeBridgeHealth(), []);

	useEffect(() => {
		const run = async (action: MenuAction, payload?: MenuActionPayload) => {
			const ui = useUiStore.getState();
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
				ui.openSettings("features");
				return;
			}
			if (action === "open-git") {
				const active = useTabsStore.getState().tabs.find(tab => tab.id === useTabsStore.getState().activeTabId);
				if (active?.kind === "chat") {
					toast({ variant: "warning", message: t("unavailable.chatSession") });
					return;
				}
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
				ui.openSettings("models");
				return;
			}
			if (action === "open-extensions") {
				ui.openSettings("extensions");
				return;
			}
			if (action === "open-inventory") {
				ui.openSettings("plugins");
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
			// Menu commands below read or mutate the selected sidecar. Ignore the
			// short selected-vs-routed gap instead of sending them to the old tab.
			if (!acceptsActiveTabEvents()) return;
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

	const focusedRuntime = activeTabId ? ensureTabRuntime(activeTabId) : null;
	const surface = (
		<div className="flex h-screen w-screen overflow-hidden text-(--sc-text)">
			{focusedRuntime && <FocusedSessionEffects />}
			<AppShell />

			<CommandPalette />
			<ExtensionDialog />
			<FirstRunGate />
			<ModelPicker />
			<RenameSessionDialog />
			<WorktreeDialog />
			<WorktreeCloseDialog />
			<SessionPickerDialog />
			<SessionSwitchDialog />
			<ModelRestoreDialog />
			<BranchPickerDialog />
			<BtwDialog />
			<DebugConsoleDialog />
			<LiveVoiceDialog />
			<CopySelectorDialog />
			<ActiveToolsDialog />
			<ShareSessionDialog />
			<ChangelogDialog />
			<ForceToolDialog />
			<HandoffDialog />
			<RemoteFolderPickerHost />
			<Suspense fallback={null}>
				<BenchmarkDialog open={benchmarkOpen} onClose={closeBenchmark} />
			</Suspense>
			<Suspense fallback={null}>{modelSetupOpen && <ModelSetupDialog />}</Suspense>
			<ThemePickerDialog />
			<PlanApprovalDialog />
			{importDialogOpen && <ImportForeignDialog />}
			<Suspense fallback={null}>{feedbackOpen && <FeedbackDialog />}</Suspense>
			<ToastStack />
		</div>
	);
	return focusedRuntime ? (
		<SessionRuntimeProvider runtime={focusedRuntime}>{surface}</SessionRuntimeProvider>
	) : (
		surface
	);
}
