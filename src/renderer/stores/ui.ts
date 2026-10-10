import { create } from "zustand";
import type { CustomProviderView, SessionInfo } from "../../shared/ipc-types";
import type { SidecarRestartProgress } from "../../shared/rpc-types";
import { KEYMAP_ACTIONS, type KeymapOverrides, sanitizeOverrides } from "../lib/keymap";
import { readPrepaintThemeMode, type ThemeMode } from "../lib/theme";

export type { ThemeMode };

/** Side panel views (design-spec §2.2): Changes · Files · Logs · Queue · Tree · Jobs. */
export type PanelTab = "diff" | "files" | "logs" | "queue" | "tree" | "jobs";
/**
 * What fills the main area: the open session (transcript + composer) or one
 * of the three destination pages. The sidebar stays visible for all of them.
 */
export type Destination = "session" | "agents" | "insights" | "settings";
export type PageDestination = Exclude<Destination, "session">;
export type AgentsTab = "live" | "definitions" | "prs";
export type InsightsTab = "stats" | "usage";
export type InsightsStatsScope = "session" | "all";
const AGENTS_TABS: readonly string[] = ["live", "definitions", "prs"] satisfies AgentsTab[];
const INSIGHTS_TABS: readonly string[] = ["stats", "usage"] satisfies InsightsTab[];
/** Settings section a cold ⌘, lands on (SettingsPage maps legacy ids). */
const DEFAULT_SETTINGS_TAB = "general";
/** Below this width the side panel becomes a sheet (design-spec §8); the sidebar never folds on its own. */
export const COMPACT_SHELL_QUERY = "(max-width: 999px)";

/** Center-dock card identifiers: todo/plan render as live cards above the composer. */
export type DockCardId = "todo" | "plan";

/** The todo card starts collapsed: its header peek (progress, current task) is
 * the at-a-glance view, and the full list is one click away. The plan card
 * starts open because a proposed plan is there to be read. */
const DOCK_CARD_DEFAULT_COLLAPSED: Record<DockCardId, boolean> = { todo: true, plan: false };

/** Whether a center-dock card is collapsed: the user's override, else the card's default. */
export function isDockCardCollapsed(overrides: Partial<Record<DockCardId, boolean>>, id: DockCardId): boolean {
	return overrides[id] ?? DOCK_CARD_DEFAULT_COLLAPSED[id];
}

export type TranscriptDetail = "compact" | "full";
/** Composer Modes popover tabs a request can open (`openModes`). */
export type ModesTab = "vibe" | "goal" | "loop" | "pool";
/** What a model-picker pick does: switch the session model, or add a model-pool member. */
export type ModelPickerPurpose = "session" | "pool";

export interface GuiDisplayPreferences {
	hideThinkingBlock?: boolean | null;
	proseOnlyThinking?: boolean | null;
	showTokenUsage?: boolean | null;
	collapseCompacted?: boolean | null;
	titleState?: boolean | null;
	goalStatusInFooter?: boolean | null;
	showProgress?: boolean | null;
	emojiAutocomplete?: boolean | null;
	pasteMenuThreshold?: number | null;
}

interface UiStore {
	displayPreferences: GuiDisplayPreferences;
	sidebarVisible: boolean;
	panelVisible: boolean;
	panelTab: PanelTab;
	/** Local file currently shown in the Files drawer. */
	filePreviewPath: string | null;
	/** The Files drawer's viewer asked for a wider docked panel (not persisted; the drag width stays the pref). */
	filePreviewExpanded: boolean;
	commandPaletteOpen: boolean;
	modelPickerOpen: boolean;
	/** "pool" adds the picked model to the session's model pool instead of switching to it. */
	modelPickerPurpose: ModelPickerPurpose;
	/** What the main area shows: the session or a destination page. */
	destination: Destination;
	agentsTab: AgentsTab;
	insightsTab: InsightsTab;
	insightsStatsScope: InsightsStatsScope;
	settingsTab: string;
	benchmarkOpen: boolean;
	/** The model setup assistant (Settings › Models, the advisor row, `/advisor on`). */
	modelSetupOpen: boolean;
	themePickerOpen: boolean;
	modesOpen: boolean;
	modesTab: ModesTab;
	importDialogOpen: boolean;
	copySelectorOpen: boolean;
	changelogOpen: boolean;
	activeToolsOpen: boolean;
	shareSessionOpen: boolean;
	forceToolOpen: boolean;
	btwRequest: string | null;
	debugOpen: boolean;
	liveOpen: boolean;
	/** Inline custom-endpoint form in Settings › Models & providers (`edit` null = add). */
	providerForm: { edit: CustomProviderView | null } | null;
	renameDialogOpen: boolean;
	/** Worktree-create dialog (plan/20): non-null opens it; baseCwd pins the
	 * repo when invoked from a Sidebar group (default = active session cwd). */
	worktreeDialog: { baseCwd?: string } | null;
	/** Close-time cleanup prompt for a worktree-bound tab (plan/20): the tab
	 * awaiting the user's delete/keep decision before closeTab proceeds. */
	worktreeClosePrompt: { tabId: string } | null;
	/** Live tab whose close is armed for confirmation: set by the chip's ×, ⌘W or
	 * the menu, so all three share one inline confirm (the second commit closes). */
	armedCloseTab: { tabId: string } | null;
	sessionPickerOpen: boolean;
	branchPickerOpen: boolean;
	/** Session the user tried to open while the attached session was busy
	 * (streaming/compacting). Non-null shows the SessionSwitchDialog offering
	 * a parallel new tab (recommended) / new window vs abort-and-switch. */
	sessionSwitchPrompt: SessionInfo | null;
	/** Session whose saved model could not be restored on switch; non-null shows
	 * the ModelRestoreDialog offering to open it with the current model. */
	modelRestorePrompt: { session: SessionInfo; missingModel: string } | null;
	sidecarError: string | null;
	/** Crash-loop progress carried by the status behind `sidecarError`: non-null
	 * while the sidecar is respawning itself, and on the terminal error once the
	 * attempts run out. Null for renderer-detected health failures. */
	sidecarRestart: SidecarRestartProgress | null;
	/** The banner was dismissed by the user. A new diagnostic — or the sidecar
	 * coming back — clears it; the one that was closed stays hidden. */
	sidecarDismissed: boolean;
	theme: ThemeMode;
	fontSize: number;
	/** Application-wide display preferences, independent of a task's terminal configuration. */
	compactDensity: boolean;
	colorBlindMode: boolean;
	followAgentTheme: boolean;
	/** Master switch for desktop notifications (Settings → GUI, default on). */
	notifications: boolean;
	/** Expand reasoning (thinking) blocks by default (Settings → GUI, default off). */
	thinkingExpanded: boolean;
	/** Transcript density: compact folds reasoning/tools; full shows every step. */
	transcriptDetail: TranscriptDetail;
	/** Expand/collapse-all signal for tool cards (⌃O); `seq` bumps per toggle so cards re-sync their local state. */
	toolsExpandAll: { expanded: boolean; seq: number };
	/** Show / hide the docked sidebar (only ever by the user). */
	toggleSidebar: () => void;
	togglePanel: () => void;
	toggleToolsExpandAll: () => void;
	setPanelTab: (tab: PanelTab) => void;
	openFilePreview: (path: string) => void;
	closeFilePreview: () => void;
	toggleFilePreviewExpanded: () => void;
	/** Per-card collapse overrides for the center dock (absent = the card's default, see `isDockCardCollapsed`). */
	dockCollapsed: Partial<Record<DockCardId, boolean>>;
	toggleDockCard: (id: DockCardId) => void;
	/** Focus signal: bumps seq so the target card expands and flashes (command-palette deep links). */
	dockFocus: { id: DockCardId; seq: number } | null;
	focusDockCard: (id: DockCardId) => void;
	openCommandPalette: () => void;
	closeCommandPalette: () => void;
	/** Open the model picker; `"pool"` picks a model-pool member (anything else switches the session model). */
	openModelPicker: (purpose?: ModelPickerPurpose) => void;
	closeModelPicker: () => void;
	/** Open a destination page; `section` selects its tab/section when valid. */
	openDestination: (destination: PageDestination, section?: string) => void;
	/** Back to the session view (Esc on a page, selecting a session). */
	closeDestination: () => void;
	openAgents: (tab?: AgentsTab) => void;
	openInsights: (tab?: InsightsTab, scope?: InsightsStatsScope) => void;
	/** Settings page; without `tab` a cold open lands on the default section and a re-open keeps the current one. */
	openSettings: (tab?: string) => void;
	/** Switch the Settings page section (SettingsPage navigation; no destination change). */
	setSettingsSection: (tab: string) => void;
	/** Settings › Models & providers. */
	openProviders: () => void;
	feedbackOpen: boolean;
	/** Error text carried in from a crash/error surface; shown read-only in the dialog. */
	feedbackPrefill: { error?: string; title?: string; description?: string } | null;
	openFeedback: (prefill?: { error?: string; title?: string; description?: string } | null) => void;
	closeFeedback: () => void;
	openBenchmark: () => void;
	closeBenchmark: () => void;
	openModelSetup: () => void;
	closeModelSetup: () => void;
	openThemePicker: () => void;
	closeThemePicker: () => void;
	openModes: (tab?: ModesTab) => void;
	closeModes: () => void;
	openImportDialog: () => void;
	closeImportDialog: () => void;
	openCopySelector: () => void;
	closeCopySelector: () => void;
	openChangelog: () => void;
	closeChangelog: () => void;
	openActiveTools: () => void;
	closeActiveTools: () => void;
	openShareSession: () => void;
	closeShareSession: () => void;
	/** Side panel › Jobs. */
	openJobs: () => void;
	openForceTool: () => void;
	closeForceTool: () => void;
	openBtw: (question: string) => void;
	closeBtw: () => void;
	openDebug: () => void;
	closeDebug: () => void;
	openLive: () => void;
	closeLive: () => void;
	/** Settings › Models & providers with the custom-endpoint form open (pre-filled when editing). */
	openProviderConfig: (editProvider?: CustomProviderView | null) => void;
	closeProviderForm: () => void;
	openRenameDialog: () => void;
	closeRenameDialog: () => void;
	openWorktreeDialog: (context?: { baseCwd?: string }) => void;
	closeWorktreeDialog: () => void;
	openWorktreeClosePrompt: (tabId: string) => void;
	closeWorktreeClosePrompt: () => void;
	armCloseTab: (tabId: string) => void;
	cancelCloseTab: () => void;
	openSessionPicker: () => void;
	closeSessionPicker: () => void;
	openBranchPicker: () => void;
	closeBranchPicker: () => void;
	/** Side panel › Tree. */
	openSessionTree: () => void;
	requestSessionSwitch: (session: SessionInfo) => void;
	closeSessionSwitch: () => void;
	requestModelRestore: (prompt: { session: SessionInfo; missingModel: string }) => void;
	closeModelRestore: () => void;
	/** Close UI whose data or actions belong to the outgoing tab. */
	closeSessionOverlays: () => void;
	/** In-flight sidebar/picker session switch: keep the outgoing transcript painted. */
	setSidecarError: (error: string | null, restart?: SidecarRestartProgress | null) => void;
	clearSidecarError: () => void;
	dismissSidecarBanner: () => void;
	setTheme: (theme: ThemeMode) => void;
	setFontSize: (size: number) => void;
	setNotifications: (enabled: boolean) => void;
	setThinkingExpanded: (enabled: boolean) => void;
	setTranscriptDetail: (detail: TranscriptDetail) => void;
	/**
	 * User keybinding overrides (B3 remap layer): actionId → replacement chord
	 * list, compiled with the defaults in lib/keymap.ts into the keydown
	 * dispatch map. GUI-local only — never synced to the TUI's keybindings.yml.
	 */
	keymapOverrides: KeymapOverrides;
	/** One-shot boot hydration guard for keymapOverrides (input-history pattern). */
	keymapHydrated: boolean;
	hydrateKeymap: () => Promise<void>;
	/** Replace one action's chords; an empty list removes the override (reset to default). */
	setKeymapOverride: (actionId: string, chords: string[]) => void;
	resetKeymapOverrides: () => void;
}

export const useUiStore = create<UiStore>()((set, get) => ({
	displayPreferences: {},
	sidebarVisible: true,
	panelVisible: false,
	panelTab: "diff",
	filePreviewPath: null,
	filePreviewExpanded: false,
	commandPaletteOpen: false,
	modelPickerOpen: false,
	modelPickerPurpose: "session",
	destination: "session",
	agentsTab: "live",
	insightsTab: "stats",
	insightsStatsScope: "session",
	settingsTab: DEFAULT_SETTINGS_TAB,
	theme: readPrepaintThemeMode(),
	fontSize: 15,
	compactDensity: false,
	colorBlindMode: false,
	followAgentTheme: false,
	notifications: true,
	thinkingExpanded: false,
	transcriptDetail: "compact",
	toggleSidebar: () => set({ sidebarVisible: !get().sidebarVisible }),
	togglePanel: () => set({ panelVisible: !get().panelVisible }),
	toolsExpandAll: { expanded: false, seq: 0 },
	toggleToolsExpandAll: () =>
		set({ toolsExpandAll: { expanded: !get().toolsExpandAll.expanded, seq: get().toolsExpandAll.seq + 1 } }),
	setPanelTab: tab => set({ panelTab: tab, panelVisible: true }),
	openFilePreview: path => set({ filePreviewPath: path, panelTab: "files", panelVisible: true }),
	closeFilePreview: () => set({ filePreviewPath: null, filePreviewExpanded: false }),
	toggleFilePreviewExpanded: () => set({ filePreviewExpanded: !get().filePreviewExpanded }),
	dockCollapsed: {},
	toggleDockCard: id =>
		set({
			dockCollapsed: { ...get().dockCollapsed, [id]: !isDockCardCollapsed(get().dockCollapsed, id) },
		}),
	dockFocus: null,
	focusDockCard: id =>
		set({
			dockCollapsed: { ...get().dockCollapsed, [id]: false },
			dockFocus: { id, seq: (get().dockFocus?.seq ?? 0) + 1 },
		}),
	openCommandPalette: () => set({ commandPaletteOpen: true }),
	closeCommandPalette: () => set({ commandPaletteOpen: false }),
	openModelPicker: purpose => set({ modelPickerOpen: true, modelPickerPurpose: purpose ?? "session" }),
	closeModelPicker: () => set({ modelPickerOpen: false }),
	openDestination: (destination, section) => {
		if (destination === "settings") get().openSettings(section);
		else if (destination === "agents")
			get().openAgents(section && AGENTS_TABS.includes(section) ? (section as AgentsTab) : undefined);
		else get().openInsights(section && INSIGHTS_TABS.includes(section) ? (section as InsightsTab) : undefined);
	},
	closeDestination: () => set({ destination: "session" }),
	openAgents: tab => set(state => ({ destination: "agents", agentsTab: tab ?? state.agentsTab })),
	openInsights: (tab, scope) =>
		set(state => ({
			destination: "insights",
			insightsTab: tab ?? state.insightsTab,
			insightsStatsScope: scope ?? state.insightsStatsScope,
		})),
	// Without an explicit target, a page that is already open stays on its
	// section: ⌘, pressed again must not bounce the user back to the first one
	// (and wipe the search they typed).
	openSettings: tab =>
		set(state => ({
			destination: "settings",
			settingsTab: tab ?? (state.destination === "settings" ? state.settingsTab : DEFAULT_SETTINGS_TAB),
		})),
	setSettingsSection: tab => set({ settingsTab: tab }),
	openProviders: () => {
		set({ providerForm: null });
		get().openSettings("models:accounts");
	},
	feedbackOpen: false,
	feedbackPrefill: null,
	openFeedback: prefill => set({ feedbackOpen: true, feedbackPrefill: prefill ?? null }),
	closeFeedback: () => set({ feedbackOpen: false, feedbackPrefill: null }),
	benchmarkOpen: false,
	openBenchmark: () => set({ benchmarkOpen: true }),
	closeBenchmark: () => set({ benchmarkOpen: false }),
	modelSetupOpen: false,
	openModelSetup: () => set({ modelSetupOpen: true }),
	closeModelSetup: () => set({ modelSetupOpen: false }),
	themePickerOpen: false,
	openThemePicker: () => set({ themePickerOpen: true }),
	closeThemePicker: () => set({ themePickerOpen: false }),
	modesOpen: false,
	modesTab: "vibe" as const,
	// The mode popover lives on the composer: a request from a page returns to the session.
	openModes: tab => set({ modesOpen: true, modesTab: tab ?? "vibe", destination: "session" }),
	closeModes: () => set({ modesOpen: false }),
	importDialogOpen: false,
	openImportDialog: () => set({ importDialogOpen: true }),
	closeImportDialog: () => set({ importDialogOpen: false }),
	copySelectorOpen: false,
	openCopySelector: () => set({ copySelectorOpen: true }),
	closeCopySelector: () => set({ copySelectorOpen: false }),
	changelogOpen: false,
	openChangelog: () => set({ changelogOpen: true }),
	closeChangelog: () => set({ changelogOpen: false }),
	activeToolsOpen: false,
	openActiveTools: () => set({ activeToolsOpen: true }),
	closeActiveTools: () => set({ activeToolsOpen: false }),
	shareSessionOpen: false,
	openShareSession: () => set({ shareSessionOpen: true }),
	closeShareSession: () => set({ shareSessionOpen: false }),
	openJobs: () => get().setPanelTab("jobs"),
	forceToolOpen: false,
	openForceTool: () => set({ forceToolOpen: true }),
	closeForceTool: () => set({ forceToolOpen: false }),
	btwRequest: null,
	openBtw: question => set({ btwRequest: question }),
	closeBtw: () => set({ btwRequest: null }),
	debugOpen: false,
	openDebug: () => set({ debugOpen: true }),
	closeDebug: () => set({ debugOpen: false }),
	liveOpen: false,
	openLive: () => set({ liveOpen: true }),
	closeLive: () => set({ liveOpen: false }),
	providerForm: null,
	openProviderConfig: editProvider => {
		set({ providerForm: { edit: editProvider ?? null } });
		get().openSettings("models");
	},
	closeProviderForm: () => set({ providerForm: null }),
	renameDialogOpen: false,
	openRenameDialog: () => set({ renameDialogOpen: true }),
	closeRenameDialog: () => set({ renameDialogOpen: false }),
	worktreeDialog: null,
	openWorktreeDialog: context => set({ worktreeDialog: context ?? {} }),
	closeWorktreeDialog: () => set({ worktreeDialog: null }),
	worktreeClosePrompt: null,
	openWorktreeClosePrompt: tabId => set({ worktreeClosePrompt: { tabId } }),
	closeWorktreeClosePrompt: () => set({ worktreeClosePrompt: null }),
	armedCloseTab: null,
	armCloseTab: tabId => set({ armedCloseTab: { tabId } }),
	cancelCloseTab: () => set({ armedCloseTab: null }),
	sessionPickerOpen: false,
	openSessionPicker: () => set({ sessionPickerOpen: true }),
	closeSessionPicker: () => set({ sessionPickerOpen: false }),
	branchPickerOpen: false,
	openBranchPicker: () => set({ branchPickerOpen: true }),
	closeBranchPicker: () => set({ branchPickerOpen: false }),
	openSessionTree: () => get().setPanelTab("tree"),
	sessionSwitchPrompt: null as SessionInfo | null,
	requestSessionSwitch: session => set({ sessionSwitchPrompt: session }),
	closeSessionSwitch: () => set({ sessionSwitchPrompt: null }),
	modelRestorePrompt: null as { session: SessionInfo; missingModel: string } | null,
	requestModelRestore: prompt => set({ modelRestorePrompt: prompt }),
	closeModelRestore: () => set({ modelRestorePrompt: null }),
	closeSessionOverlays: () =>
		set({
			commandPaletteOpen: false,
			modelPickerOpen: false,
			modesOpen: false,
			importDialogOpen: false,
			copySelectorOpen: false,
			activeToolsOpen: false,
			shareSessionOpen: false,
			forceToolOpen: false,
			btwRequest: null,
			debugOpen: false,
			liveOpen: false,
			renameDialogOpen: false,
			worktreeDialog: null,
			worktreeClosePrompt: null,
			armedCloseTab: null,
			filePreviewPath: null,
			filePreviewExpanded: false,
			sessionPickerOpen: false,
			branchPickerOpen: false,
			sessionSwitchPrompt: null,
			modelRestorePrompt: null,
		}),
	sidecarError: null as string | null,
	sidecarRestart: null as SidecarRestartProgress | null,
	sidecarDismissed: false,
	setSidecarError: (error, restart = null) =>
		set({ sidecarError: error, sidecarRestart: restart, sidecarDismissed: false }),
	clearSidecarError: () => set({ sidecarError: null, sidecarRestart: null, sidecarDismissed: false }),
	dismissSidecarBanner: () => set({ sidecarDismissed: true }),
	setTheme: theme => set({ theme }),
	setFontSize: size => set({ fontSize: size }),
	setNotifications: enabled => set({ notifications: enabled }),
	setThinkingExpanded: enabled => set({ thinkingExpanded: enabled }),
	setTranscriptDetail: detail => set({ transcriptDetail: detail }),
	keymapOverrides: {} as KeymapOverrides,
	keymapHydrated: false,
	hydrateKeymap: async () => {
		if (get().keymapHydrated) return;
		try {
			const raw = await window.omp.prefs.get("keymapOverrides");
			set({ keymapOverrides: sanitizeOverrides(KEYMAP_ACTIONS, raw), keymapHydrated: true });
		} catch {
			// prefs IPC unavailable (tests, storybook) — defaults stay in effect.
			set({ keymapHydrated: true });
		}
	},
	setKeymapOverride: (actionId, chords) => {
		// Fresh object per mutation so subscribers (and App's compiled-map memo)
		// see a new reference; untouched overrides keep their identity.
		const next = { ...get().keymapOverrides };
		if (chords.length === 0) delete next[actionId];
		else next[actionId] = chords;
		set({ keymapOverrides: next });
		void window.omp.prefs.set("keymapOverrides", next).catch(() => {});
	},
	resetKeymapOverrides: () => {
		set({ keymapOverrides: {} });
		void window.omp.prefs.set("keymapOverrides", {}).catch(() => {});
	},
}));
