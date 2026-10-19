import { closestCenter, DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
	AlertTriangle,
	Archive,
	ArchiveRestore,
	ArrowDown,
	ArrowUp,
	BarChart3,
	Bot,
	ChevronDown,
	ChevronRight,
	CircleHelp,
	Columns2,
	Compass,
	Copy,
	Download,
	ExternalLink,
	Eye,
	EyeOff,
	Folder,
	FolderInput,
	FolderOpen,
	FolderPlus,
	FolderSearch,
	GitBranch,
	GitBranchPlus,
	GitFork,
	History,
	Info,
	Keyboard,
	MessageCircle,
	MessageSquarePlus,
	MessageSquareWarning,
	MoreHorizontal,
	PanelLeft,
	PanelLeftClose,
	PanelRightClose,
	Pencil,
	Pin,
	PinOff,
	Plus,
	RefreshCw,
	Rows2,
	Search,
	SearchX,
	Settings,
	Sparkles,
	SquarePen,
	SquareTerminal,
	Trash2,
	X,
} from "lucide-react";
import {
	Fragment,
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { agentMessageSender } from "../../../../shared/agent-control";
import type { IpcHostedSession, SessionInfo } from "../../../../shared/ipc-types";
import { autopilotRunOf, type ProjectOrigin, worktreeLabel } from "../../../../shared/project-origin";
import { splitTabIds } from "../../../../shared/split-layout";
import { useAwaitedInput } from "../../../hooks/use-awaited-input";
import { useSessionList } from "../../../hooks/use-session-list";
import { requestSessionSwitch } from "../../../hooks/use-session-switch";
import { useShellInput } from "../../../hooks/use-shell-mode";
import { activeComposerInput } from "../../../lib/composer-focus";
import { hideNativeDragImage } from "../../../lib/drag-image";
import { copyText, cx, formatTimeAgo } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { isImeKeyEvent } from "../../../lib/ime";
import { actionKbd, onEscape } from "../../../lib/keymap";
import { orderProjects, reorderProjects } from "../../../lib/project-order";
import { type ProjectName, useProjectNames, useWorktreeKindLabels } from "../../../lib/project-origin";
import { sessionForkOrigin } from "../../../lib/session-fork";
import { sessionDisplayTitle, sessionHasContent } from "../../../lib/session-title";
import { isRememberedSession, LOCAL_DEVICE } from "../../../lib/sidebar-memory";
import { clampSidebarWidth, readSidebarWidth, writeSidebarWidth } from "../../../lib/sidebar-width";
import { performTabClose } from "../../../lib/tab-close";
import { useTabRpc } from "../../../lib/tab-rpc";
import { tabSignalPresentation } from "../../../lib/tab-signal";
import { pickWorkspaceDirectory } from "../../../lib/workspace-dirs";
import { ensureAgentReviewSubscription, useAgentReviewStore } from "../../../stores/agent-review";
import { ensureClosedChildren, useClosedChildrenStore } from "../../../stores/closed-children";
import { useComposerStore } from "../../../stores/composer";
import { useHostedSessionsStore } from "../../../stores/hosted-sessions";
import { useMessagesStore } from "../../../stores/messages";
import { useQueueStore } from "../../../stores/queue";
import { usePairedHosts, useRemoteStore } from "../../../stores/remote";
import { type SessionStore, useSessionStore } from "../../../stores/session";
import { sessionRuntimeStore } from "../../../stores/session-runtime-context";
import { useSidebarFolds } from "../../../stores/sidebar-folds";
import { RAIL_PIN_LABEL_KEYS, type RailPin, useSidebarPrefs } from "../../../stores/sidebar-prefs";
import { toggleSidebarSubagents, useSidebarSubagentsStore } from "../../../stores/sidebar-subagents";
import { useTabsStore } from "../../../stores/tabs";
import { toast, toastError } from "../../../stores/toast";
import { type PageDestination, type PanelTab, useUiStore } from "../../../stores/ui";
import { startInstall, useInstallOffered } from "../../../web/install-ui";
import {
	Badge,
	BrandMark,
	Button,
	type ContextMenuItem,
	EmptyState,
	ErrorDetail,
	IconButton,
	Input,
	Kbd,
	ListRow,
	MenuButton,
	SearchField,
	SkeletonRows,
	Spinner,
	Tabs,
} from "../../common";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { anchorFromEvent, ContextMenu, type ContextMenuAnchor } from "../../common/ContextMenu";
import { SwapText } from "../../common/SwapText";
import { WorkspaceDialog } from "../../dialogs/WorkspaceDialog";
import { StarterGuide } from "../../onboarding/StarterGuide";
import { ForkParent } from "../ForkParent";
import { RAIL_PIN_ICONS } from "./rail-pin-icons";
import { SidebarDeviceSection, SidebarLocalHeader } from "./SidebarDevices";
import { SidebarRenameField } from "./SidebarRenameField";
import {
	type FamilyOpened,
	SidebarLooseChildren,
	SidebarSubagents,
	SidebarSubagentsToggle,
	sidebarSubagentCount,
} from "./SidebarSubagents";
import { SidebarUpdateCard } from "./SidebarUpdateCard";
import { SidebarUsage } from "./SidebarUsage";
import { CHILD_TOKEN, isShownOpened, openedChildStatus, openerOfSessions } from "./sidebar-family";
import "../../../styles/sidebar.css";

/**
 * A sidebar row: an indexed session, or one synthesized from an open tab the
 * global index has not listed yet (a brand-new or still-empty session). The
 * sidebar is the only session navigator, so every open tab keeps a row.
 * Live-only rows (`liveTabId` set) have no transcript file yet: nothing to
 * rename, pin, or delete.
 */
type SidebarSession = SessionInfo & { liveTabId?: string };

interface WorkspaceGroup {
	/** The group's id: its folder, or `<project>#agent` for the parallel children of one project. */
	cwd: string;
	/** Every folder whose sessions the group holds. */
	members: string[];
	/** Where "new session here" starts: the group's folder, or the project for a parallel group. */
	newCwd: string;
	name: string;
	/** The full path (for a linked worktree also its project): the group header's tooltip. */
	tooltip: string;
	/** The main checkout the folder belongs to (the folder itself when git says nothing else). */
	root: string;
	/** Set when the folder is a linked worktree: where it comes from and what it is for. */
	worktree: ProjectOrigin | null;
	/** A worktree group shown right under its project's group. */
	attached?: boolean;
	sessions: SidebarSession[];
	/** Sessions an agent opened that no opener row holds (closed, from before provenance, opener gone): listed only while they need a look. */
	folded: SidebarSession[];
}

/** A delete the row or context menu queued, awaiting the confirmation dialog. */
type PendingDelete =
	| { kind: "session"; session: SidebarSession }
	| { kind: "group"; group: WorkspaceGroup }
	| { kind: "archived"; sessions: SidebarSession[] };

/**
 * Sidebar lanes. Code: project sessions grouped by folder. Chat: conversations
 * without a project — chat tabs plus agent sessions started in the GUI's
 * default folder.
 */
type SidebarMode = "code" | "chat";

/** Floor for the docked column: the sidebar never folds on its own, so this is what a narrow window keeps. */

/** Stock's own `created` (the session header's timestamp): fixed for a session's life, unlike `modified`. */
function createdAt(session: SessionInfo): number {
	const timestamp = Date.parse(session.created);
	return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * The focused tab is still the untouched landing surface: no transcript, no
 * draft, nothing queued or running. Opening a session or a project there
 * replaces it instead of leaving an empty tab behind.
 */
function activeTabUntouched(): boolean {
	const tabs = useTabsStore.getState();
	// A pane of a split is never re-rooted by opening a session or project: that opens it alone.
	if (tabs.split) return false;
	const tab = tabs.tabs.find(entry => entry.id === tabs.activeTabId);
	// A remote tab runs on its host: it can never be re-rooted to this device's sessions or folders.
	if (!tab || tab.device !== undefined || tab.worktree || tab.status === "running" || tab.compacting) return false;
	const session = useSessionStore.getState();
	const composer = useComposerStore.getState();
	const queue = useQueueStore.getState();
	return (
		!session.isStreaming &&
		!session.isCompacting &&
		session.messageCount === 0 &&
		useMessagesStore.getState().messages.length === 0 &&
		queue.steering.length === 0 &&
		queue.followUp.length === 0 &&
		composer.draft.trim().length === 0 &&
		composer.images.length === 0
	);
}

function focusComposer(): void {
	requestAnimationFrame(() => activeComposerInput()?.focus());
}

/** Destinations in the sidebar footer (design-spec §2.1): the only three. */
const DESTINATIONS: { id: PageDestination; labelKey: string; icon: typeof Bot }[] = [
	{ id: "agents", labelKey: "destination.agents", icon: Bot },
	{ id: "insights", labelKey: "destination.insights", icon: BarChart3 },
	{ id: "settings", labelKey: "destination.settings", icon: Settings },
];

/** A pinned side panel view: back to the session (a page hides the panel) with that view open. */
function showPanelView(tab: PanelTab): void {
	const ui = useUiStore.getState();
	if (ui.destination !== "session") ui.closeDestination();
	ui.setPanelTab(tab);
}

/** Footer shortcuts the user pins in Settings › General (usage renders as bars, the rest as rows). */
const RAIL_PIN_ROWS: Record<Exclude<RailPin, "usage" | "agents" | "stats">, { icon: typeof Bot; open: () => void }> = {
	terminal: { icon: RAIL_PIN_ICONS.terminal, open: () => showPanelView("terminal") },
	diff: { icon: RAIL_PIN_ICONS.diff, open: () => showPanelView("diff") },
	preview: { icon: RAIL_PIN_ICONS.preview, open: () => showPanelView("preview") },
	files: { icon: RAIL_PIN_ICONS.files, open: () => showPanelView("files") },
	jobs: { icon: RAIL_PIN_ICONS.jobs, open: () => showPanelView("jobs") },
	schedules: { icon: RAIL_PIN_ICONS.schedules, open: () => useUiStore.getState().openSettings("schedules") },
};

function useHelpItems(): ContextMenuItem[] {
	const t = useT();
	const keymapOverrides = useUiStore(s => s.keymapOverrides);
	const installOffered = useInstallOffered();
	return [
		...(installOffered
			? [{ id: "help-install", label: t("web.install.menu"), icon: Download, onSelect: startInstall }]
			: []),
		{
			id: "help-shortcuts",
			label: t("help.shortcuts"),
			icon: Keyboard,
			shortcut: actionKbd("hotkeys", keymapOverrides),
			onSelect: () => useUiStore.getState().openSettings("keyboard"),
		},
		{
			id: "help-palette",
			label: t("help.palette"),
			icon: Search,
			shortcut: actionKbd("palette", keymapOverrides),
			onSelect: () => useUiStore.getState().openCommandPalette(),
		},
		{
			id: "help-features",
			label: t("help.features"),
			icon: Compass,
			separatorBefore: true,
			onSelect: () => useUiStore.getState().openSettings("agent"),
		},
		{
			id: "help-whats-new",
			label: t("help.whatsNew"),
			icon: Sparkles,
			onSelect: () => useUiStore.getState().openChangelog(),
		},
		{
			id: "help-feedback",
			label: t("help.feedback"),
			icon: MessageSquareWarning,
			separatorBefore: true,
			onSelect: () => useUiStore.getState().openFeedback(),
		},
		{
			id: "help-about",
			label: t("help.about"),
			icon: Info,
			onSelect: () => useUiStore.getState().openSettings("updates"),
		},
		{
			// The pins themselves are Settings switches, so search finds them too.
			id: "help-customize-sidebar",
			label: t("help.customizeSidebar"),
			icon: PanelLeft,
			separatorBefore: true,
			onSelect: () => useUiStore.getState().openSettings("general:setting-gui-railPins"),
		},
	];
}

/**
 * A project group the user can drag to a new place. Pointer-only, armed after a
 * short move so a plain click still toggles the group; the group menu's
 * "위로/아래로 이동" is the keyboard path.
 */
function SortableProject({
	id,
	disabled,
	children,
}: {
	id: string;
	disabled: boolean;
	children: (dragHandle: Record<string, unknown>) => ReactNode;
}) {
	const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id, disabled });
	return (
		<div
			className={cx("mt-2 first:mt-0", isDragging && "relative z-(--sc-z-raised) opacity-80")}
			data-dragging={isDragging || undefined}
			ref={setNodeRef}
			style={{ transform: CSS.Translate.toString(transform), transition }}
		>
			{children(listeners ?? {})}
		</div>
	);
}

/** Footer: Agents · Stats (each shown only while pinned) · Settings, with the help menu closing the Settings row. */
function SidebarFooter() {
	const t = useT();
	const destination = useUiStore(s => s.destination);
	const keymapOverrides = useUiStore(s => s.keymapOverrides);
	const helpItems = useHelpItems();
	const railPins = useSidebarPrefs(s => s.railPins);
	const shortcutFor = (id: PageDestination) =>
		id === "agents"
			? actionKbd("agents.hub", keymapOverrides)
			: id === "settings"
				? actionKbd("settings", keymapOverrides)
				: undefined;
	const open = (id: PageDestination) => {
		const ui = useUiStore.getState();
		if (id === "agents") ui.openAgents();
		else if (id === "insights") ui.openInsights();
		else ui.openSettings();
	};
	return (
		<nav
			aria-label={t("sidebar.destinations")}
			className="flex shrink-0 flex-col gap-px border-t border-(--sc-divider) p-2"
			data-sidebar-destinations
		>
			{railPins.map(pin => {
				if (pin === "usage") return <SidebarUsage key={pin} />;
				// Agents and Stats are the destination rows below, shown only while pinned.
				if (pin === "agents" || pin === "stats") return null;
				const { icon: Icon, open: openPin } = RAIL_PIN_ROWS[pin];
				return (
					<Button
						className="omp-sidebar-destination w-full min-w-0 justify-start gap-2.5 px-2.5 text-(--sc-text-secondary)"
						data-rail-pin={pin}
						icon={<Icon />}
						key={pin}
						onClick={openPin}
						variant="ghost"
					>
						<span className="min-w-0 flex-1 truncate text-left">{t(RAIL_PIN_LABEL_KEYS[pin])}</span>
					</Button>
				);
			})}
			{DESTINATIONS.filter(
				({ id }) => id === "settings" || railPins.includes(id === "agents" ? "agents" : "stats"),
			).map(({ id, labelKey, icon: Icon }) => {
				const current = destination === id;
				const shortcut = shortcutFor(id);
				const row = (
					<Button
						aria-current={current ? "page" : undefined}
						className={cx(
							"omp-sidebar-destination w-full min-w-0 justify-start gap-2.5 px-2.5",
							current ? "bg-(--sc-selected) text-(--sc-text)" : "text-(--sc-text-secondary)",
						)}
						data-destination={id}
						icon={<Icon />}
						key={id}
						onClick={() => open(id)}
						variant="ghost"
					>
						<span className="min-w-0 flex-1 truncate text-left">{t(labelKey)}</span>
						{shortcut && <Kbd className="omp-sidebar-kbd" shortcut={shortcut} />}
					</Button>
				);
				if (id !== "settings") return row;
				// Help closes the last row: one footer, no orphaned icon underneath.
				return (
					<div className="flex min-w-0 items-center gap-1" key={id}>
						<div className="flex min-w-0 flex-1">{row}</div>
						<MenuButton
							align="end"
							className="text-(--sc-text-secondary)"
							icon={<CircleHelp />}
							items={helpItems}
							label={t("help.menu")}
							variant="ghost"
						/>
					</div>
				);
			})}
		</nav>
	);
}

/**
 * Focus a roving item and bring its whole row into view. focus() alone reveals
 * only the row's title button, while the focus ring (the button's ::after) spans
 * the row, so a row reached at the list's edge stayed cut off under it.
 */
function focusRovingItem(item: HTMLElement) {
	item.focus({ preventScroll: true });
	(item.closest(".omp-sidebar-session-row") ?? item).scrollIntoView?.({ block: "nearest" });
}

function subscribeVisibility(listener: () => void): () => void {
	document.addEventListener("visibilitychange", listener);
	return () => document.removeEventListener("visibilitychange", listener);
}

/**
 * Sessions-first sidebar (design-spec §2.1) and the app's only session
 * navigator: Code/Work lanes, New session, a filter, sessions grouped by
 * project (newest first, status as icon + text; every open tab keeps a row),
 * and a footer with the three destinations plus help.
 */
export function Sidebar() {
	const tabRpc = useTabRpc();
	const t = useT();
	const keymapOverrides = useUiStore(state => state.keymapOverrides);
	// The lane last shown comes back; with none saved (or once the open session moves) the open session picks it.
	const rememberedLane = useRef(useSidebarFolds.getState().lane);
	const laneSettled = useRef(false);
	const [mode, setMode] = useState<SidebarMode>(rememberedLane.current ?? "code");
	const shownLane = useRef(mode);
	useEffect(() => {
		if (shownLane.current === mode) return;
		shownLane.current = mode;
		useSidebarFolds.getState().setLane(mode);
	}, [mode]);
	const [defaultWorkspace, setDefaultWorkspace] = useState<string | null>(null);
	const [filter, setFilter] = useState("");
	const switchPendingTo = useSessionStore(s => s.switchPending?.toId ?? null);
	// Resizable docked column; the width persists like every other chrome pref.
	const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
	const sidebarWidthRef = useRef(sidebarWidth);
	useEffect(() => {
		void window.omp.prefs
			.get("sidebarWidth")
			.then(value => {
				if (typeof value !== "number" || !Number.isFinite(value)) return;
				const clamped = clampSidebarWidth(value);
				sidebarWidthRef.current = clamped;
				setSidebarWidth(clamped);
				writeSidebarWidth(clamped);
			})
			.catch(() => {});
	}, []);
	const sidebarDragging = useRef(false);
	const startSidebarDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
		sidebarDragging.current = true;
		e.currentTarget.setPointerCapture(e.pointerId);
	}, []);
	const onSidebarDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
		if (!sidebarDragging.current) return;
		// Sidebar is left-anchored: dragging right grows it.
		const host = e.currentTarget.parentElement;
		if (!host) return;
		const hostRect = host.getBoundingClientRect();
		const clamped = clampSidebarWidth(e.clientX - hostRect.left);
		sidebarWidthRef.current = clamped;
		setSidebarWidth(clamped);
	}, []);
	const endSidebarDrag = useCallback(() => {
		sidebarDragging.current = false;
		writeSidebarWidth(sidebarWidthRef.current);
		void window.omp.prefs.set("sidebarWidth", sidebarWidthRef.current).catch(() => {});
	}, []);
	const [deleting, setDeleting] = useState(false);
	const groupFolds = useSidebarFolds(s => s.groups);
	// Deleting a session hard-deletes its transcript file, so the row and menu
	// clicks only queue it: the dialog names the target and states the
	// consequence before anything is removed.
	const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
	const [renamingSessionPath, setRenamingSessionPath] = useState<string | null>(null);
	const [workspaceDialog, setWorkspaceDialog] = useState<"switch" | "new-session" | null>(null);
	const [renameDraft, setRenameDraft] = useState("");
	const [groupMenu, setGroupMenu] = useState<{ anchor: ContextMenuAnchor; group: WorkspaceGroup } | null>(null);
	const [sessionMenu, setSessionMenu] = useState<{ anchor: ContextMenuAnchor; session: SidebarSession } | null>(null);
	// Under touch there is no hover to reveal a row's actions, so the open row would always show its rename,
	// archive and delete buttons and the title would lose their width: one ⋯ opens the row's action sheet instead.
	const touchInput = useShellInput() === "touch";
	// Hidden window: the running rows' edge light rests (sidebar.css `[data-paused]`).
	const windowVisible = useSyncExternalStore(
		subscribeVisibility,
		() => document.visibilityState !== "hidden",
		() => true,
	);
	// "Move to project…": the second menu listing the projects a stored session can go to.
	const [moveMenu, setMoveMenu] = useState<{ anchor: ContextMenuAnchor; session: SidebarSession } | null>(null);
	// The Archived section starts folded: archived sessions are out of the way by design.
	const archivedOpen = useSidebarFolds(s => s.archivedOpen);
	const setArchivedOpen = useSidebarFolds.getState().setArchivedOpen;
	const archivedRef = useRef<HTMLElement>(null);
	// The section sits at the end of the list: opening it brings it to the top, or its rows stay below the fold.
	useEffect(() => {
		if (archivedOpen) archivedRef.current?.scrollIntoView?.({ block: "start" });
	}, [archivedOpen]);
	const [archivedMenu, setArchivedMenu] = useState<ContextMenuAnchor | null>(null);
	// Project display alias rename (group header inline input).
	const [renamingGroupCwd, setRenamingGroupCwd] = useState<string | null>(null);
	const [groupRenameDraft, setGroupRenameDraft] = useState("");
	// Roving focus: the session list is one tab stop; arrows move inside it.
	const [focusKey, setFocusKey] = useState<string | null>(null);
	const listRef = useRef<HTMLDivElement>(null);
	/** A row to focus after the next render, if focus is lost or still on the row `leaving`. */
	const refocusRow = useRef<{ key: string; leaving?: string } | null>(null);
	const openTab = useTabsStore(s => s.openTab);
	const tabs = useTabsStore(s => s.tabs);
	const activeTabId = useTabsStore(s => s.activeTabId);
	const split = useTabsStore(s => s.split);
	const splitIds = useMemo(() => (split ? new Set(splitTabIds(split)) : null), [split]);
	const activeTab = tabs.find(tab => tab.id === activeTabId);
	const activeTabKind = activeTab?.kind;
	// Remote tabs (a paired host's sessions) live in their device sections; this list is this device's.
	const localTabs = useMemo(() => tabs.filter(tab => tab.device === undefined), [tabs]);
	const activeTabRemote = activeTab?.device !== undefined;
	// Sessions paired devices' tabs run on this computer: rows of this device's list with that tab's live state.
	const hostedSessions = useHostedSessionsStore(s => s.sessions);
	const hostedByKey = useMemo(() => {
		const index = new Map<string, IpcHostedSession>();
		for (const hosted of hostedSessions) {
			index.set(hosted.sessionPath, hosted);
			if (hosted.sessionId) index.set(hosted.sessionId, hosted);
		}
		return index;
	}, [hostedSessions]);
	const hosts = usePairedHosts();
	const pinnedGroups = useSidebarPrefs(s => s.pinnedGroups);
	const groupOrder = useSidebarPrefs(s => s.groupOrder);
	const pinnedSessions = useSidebarPrefs(s => s.pinnedSessions);
	const agentHidden = useSidebarPrefs(s => s.agentHidden);
	const groupAliases = useSidebarPrefs(s => s.groupAliases);
	const archivedSessions = useSidebarPrefs(s => s.archivedSessions);
	const grouping = useSidebarPrefs(s => s.grouping);
	const {
		sessions,
		isLoading,
		live: listLive,
		error: listError,
		refresh,
		deleteSession,
		renameSession,
	} = useSessionList("global");
	// Stock lists a fork under its parent's title and marks it (`fork`, "Forked from …"); a fork's
	// `parentSessionPath` holds the parent's file path or, after a move, its id.
	const sessionsByPathOrId = useMemo(() => {
		const index = new Map<string, SessionInfo>();
		for (const session of sessions) {
			index.set(session.path, session);
			index.set(session.id, session);
		}
		return index;
	}, [sessions]);
	const sessionId = useSessionStore(s => s.sessionId);
	const sessionName = useSessionStore(s => s.sessionName);
	const sessionFile = useSessionStore(s => s.sessionFile);
	const cwd = useSessionStore(s => s.cwd);
	const isStreaming = useSessionStore(s => s.isStreaming);
	const isCompacting = useSessionStore(s => s.isCompacting);
	const destination = useUiStore(s => s.destination);
	// A blocking confirmation (plan approval / ask / permission) on the
	// attached session outranks "running": it needs the user, not just time.
	const awaitedInput = useAwaitedInput();

	useEffect(() => {
		void window.omp.sidecar
			.defaultWorkspace()
			.then(workspace => {
				setDefaultWorkspace(workspace);
				const tabState = useTabsStore.getState();
				const activeKind = tabState.tabs.find(tab => tab.id === tabState.activeTabId)?.kind;
				if (
					rememberedLane.current === null &&
					(activeKind === "chat" || useSessionStore.getState().cwd === workspace)
				)
					setMode("chat");
			})
			.catch(() => {});
	}, []);

	// Opening a session from search or the palette keeps the lane honest.
	useEffect(() => {
		if (!defaultWorkspace || !cwd) return;
		// The first open session at launch does not override the lane that was left.
		const settled = laneSettled.current;
		laneSettled.current = true;
		if (!settled && rememberedLane.current !== null) return;
		setMode(activeTabKind === "chat" || cwd === defaultWorkspace ? "chat" : "code");
	}, [activeTabKind, cwd, defaultWorkspace]);

	const query = filter.trim().toLocaleLowerCase();
	const matchesFilter = useCallback(
		(session: SessionInfo) =>
			!query ||
			sessionDisplayTitle(session, "").toLocaleLowerCase().includes(query) ||
			session.cwd.toLocaleLowerCase().includes(query),
		[query],
	);
	// Sessions sort by when they were created, newest first (stock's `created`), never by activity: a streaming
	// turn rewrites the transcript, so its mtime would move rows while the user watches. Pinned ones come first;
	// equal times break by path so the order never flickers.
	const byPinThenRecency = useCallback(
		(a: SessionInfo, b: SessionInfo) => {
			const aPinned = pinnedSessions.includes(a.path) ? 0 : 1;
			const bPinned = pinnedSessions.includes(b.path) ? 0 : 1;
			if (aPinned !== bPinned) return aPinned - bPinned;
			return createdAt(b) - createdAt(a) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
		},
		[pinnedSessions],
	);
	// Stock can write a session file before its first message (a header and
	// settings entries, e.g. the one stock `new_session` writes at once). Such a file
	// is not a conversation yet: an open tab that owns it keeps its live "new
	// session" row (not deletable), and an orphaned one is not listed at all —
	// otherwise deleting the last chat leaves an "Untitled" row whose deletion
	// starts the next one.
	// Archived sessions leave the lists for the Archived section, except one an
	// open tab holds: every open tab keeps its row.
	const heldByTab = useMemo(() => {
		const held = new Set<string>();
		for (const tab of localTabs) {
			if (tab.sessionPath) held.add(tab.sessionPath);
			if (tab.sessionId) held.add(tab.sessionId);
		}
		// A paired device's tab here holds its session as an open tab does: never folded away or archived out.
		for (const key of hostedByKey.keys()) held.add(key);
		if (!activeTabRemote) {
			if (sessionFile) held.add(sessionFile);
			if (sessionId) held.add(sessionId);
		}
		return held;
	}, [localTabs, hostedByKey, activeTabRemote, sessionFile, sessionId]);
	const archivedIds = useMemo(() => new Set(archivedSessions), [archivedSessions]);
	const listedSessions = useMemo(
		() =>
			sessions.filter(
				session =>
					sessionHasContent(session) &&
					(!archivedIds.has(session.id) || heldByTab.has(session.path) || heldByTab.has(session.id)),
			),
		[sessions, archivedIds, heldByTab],
	);
	// Every open tab keeps a row even before the index lists its session (a
	// brand-new session has no file yet): synthesize it from the tab and, for
	// the focused tab, the attached session's live identity. The empty start
	// tab (`placeholder`: startup, or what a deleted session's last tab gives
	// way to) is no session until its first run, so it has no row until then.
	// Such a row's `created` is when this sidebar first saw the tab, kept per tab
	// (later tabs of one render a millisecond apart): one shared "now" tied every
	// live row, so they sorted by path, oldest first, and flipped to newest first
	// once the index listed them.
	const liveSince = useRef(new Map<string, string>());
	const liveSessions = useMemo<SidebarSession[]>(() => {
		const listedIds = new Set(listedSessions.map(session => session.id));
		const listedPaths = new Set(listedSessions.map(session => session.path));
		const since = liveSince.current;
		const open = new Set([
			...localTabs.map(tab => tab.id),
			...hostedSessions.map(hosted => `hosted:${hosted.sessionPath}`),
		]);
		for (const id of since.keys()) if (!open.has(id)) since.delete(id);
		let stamp = Date.now();
		const rows: SidebarSession[] = [];
		for (const tab of localTabs) {
			if (tab.placeholder === true) continue;
			const focused = tab.id === activeTabId;
			const id = (focused ? sessionId : "") || tab.sessionId || "";
			const path = (focused ? sessionFile : null) ?? tab.sessionPath ?? "";
			if ((id && listedIds.has(id)) || (path && listedPaths.has(path))) continue;
			let created = since.get(tab.id);
			if (!created) {
				created = new Date(stamp++).toISOString();
				since.set(tab.id, created);
			}
			rows.push({
				path: path || `tab:${tab.id}`,
				id: id || `tab:${tab.id}`,
				// An agent-opened session reads as its task until stock names it.
				title: tab.title || tab.task || (focused ? sessionName : null) || null,
				cwd: tab.cwd || (focused ? cwd : ""),
				created,
				modified: created,
				messageCount: 0,
				size: 0,
				status: "unknown",
				...(tab.kind === "chat" ? { kind: "chat" as const } : {}),
				firstMessage: "",
				liveTabId: tab.id,
			});
		}
		// A paired device's tab here keeps its row too, before the index lists its session.
		for (const hosted of hostedSessions) {
			if (listedPaths.has(hosted.sessionPath) || (hosted.sessionId && listedIds.has(hosted.sessionId))) continue;
			if (localTabs.some(tab => tab.sessionPath === hosted.sessionPath)) continue;
			const key = `hosted:${hosted.sessionPath}`;
			let created = since.get(key);
			if (!created) {
				created = new Date(stamp++).toISOString();
				since.set(key, created);
			}
			rows.push({
				path: hosted.sessionPath,
				id: hosted.sessionId || key,
				title: hosted.title || null,
				cwd: hosted.cwd,
				created,
				modified: created,
				messageCount: 0,
				size: 0,
				status: "unknown",
				...(hosted.kind === "chat" ? { kind: "chat" as const } : {}),
				firstMessage: "",
				liveTabId: key,
			});
		}
		return rows;
	}, [listedSessions, localTabs, hostedSessions, activeTabId, sessionId, sessionFile, sessionName, cwd]);
	const allSessions = useMemo<SidebarSession[]>(
		() => (liveSessions.length === 0 ? listedSessions : [...listedSessions, ...liveSessions]),
		[listedSessions, liveSessions],
	);
	const agentSessions = useMemo(() => allSessions.filter(session => session.kind !== "chat"), [allSessions]);
	const codeSessions = useMemo(
		() => agentSessions.filter(session => !defaultWorkspace || session.cwd !== defaultWorkspace),
		[agentSessions, defaultWorkspace],
	);
	const projectName = useProjectNames(
		useMemo(() => codeSessions.map(session => session.cwd), [codeSessions]),
		sessions,
	);
	const kindLabels = useWorktreeKindLabels();
	// An Autopilot run opens a child session per item of a cycle (`autopilot/<run>-c<N>-<area>`, each in a worktree
	// of its own): its row goes under the run's own row, never a group per child (a list of folders each holding one
	// "New session"). Session path → the run's worktree folder. Run and child meet by the main checkout and the run's
	// name: git's answer for the folder, or, while git cannot place a worktree being made, the tab's own binding
	// (`worktree_create` reports the main checkout as `baseCwd`).
	const runParentOf = useMemo(() => {
		const runOf = (session: SidebarSession) => {
			const origin = projectName(session.cwd).worktree;
			const fromGit = autopilotRunOf(origin?.worktree?.branch ?? null);
			if (origin && fromGit) return { ...fromGit, key: `${origin.root}\n${fromGit.run}` };
			const tab = localTabs.find(
				entry =>
					entry.id === session.liveTabId ||
					(entry.sessionPath !== undefined && entry.sessionPath === session.path),
			);
			const fromTab = autopilotRunOf(tab?.worktree?.branch ?? null);
			return tab?.worktree && fromTab ? { ...fromTab, key: `${tab.worktree.baseCwd}\n${fromTab.run}` } : null;
		};
		const runs = new Map<string, string>();
		const children: Array<{ path: string; key: string }> = [];
		for (const session of codeSessions) {
			const run = runOf(session);
			if (!run) continue;
			if (run.child) children.push({ path: session.path, key: run.key });
			else runs.set(run.key, session.cwd);
		}
		const parents = new Map<string, string>();
		for (const child of children) {
			const parent = runs.get(child.key);
			if (parent) parents.set(child.path, parent);
		}
		return parents;
	}, [codeSessions, localTabs, projectName]);
	// A session another session's agent opened (`ompdesk_session_open`, a worktree or not) nests under its opener, one
	// level in like a subagent, whatever its folder: opened-session path → the session that started the chain.
	const closedChildren = useClosedChildrenStore(s => s.rows);
	const closedOpeners = useMemo(
		() => new Map(closedChildren.map(row => [row.path, row.openedBySession])),
		[closedChildren],
	);
	const closedTitleOf = useMemo(() => new Map(closedChildren.map(row => [row.path, row.title])), [closedChildren]);
	const closedCwdOf = useMemo(
		() => new Map(closedChildren.flatMap(row => (row.cwd ? [[row.path, row.cwd] as const] : []))),
		[closedChildren],
	);
	const reviewByTab = useAgentReviewStore(s => s.byTab);
	const reviewOf = useMemo(
		() => new Map(Object.values(reviewByTab).flatMap(items => items.map(item => [item.tabId, item]))),
		[reviewByTab],
	);
	useEffect(() => {
		ensureClosedChildren();
		ensureAgentReviewSubscription();
	}, []);
	const familyRootOf = useMemo(() => {
		const roots = openerOfSessions(
			localTabs,
			codeSessions.map(session => ({
				path: session.path,
				id: session.id,
				liveTabId: session.liveTabId,
				title: sessionDisplayTitle(session, ""),
				firstMessage: session.firstMessage,
				created: session.created,
			})),
			closedOpeners,
		);
		// An Autopilot child keeps its run's row, whoever its brief names.
		for (const path of runParentOf.keys()) roots.delete(path);
		return roots;
	}, [localTabs, codeSessions, closedOpeners, runParentOf]);
	// A closed session an agent opened, whose opener row is not in the list, still is no row of its own and no
	// "parallel work" group: it folds into its project's group. Session path → that project's main checkout. The agent
	// brief and the record are what tell; an `omp/agent/…` worktree is the last resort for a file with neither.
	const foldedRootOf = useMemo(() => {
		const roots = new Map<string, string>();
		for (const session of codeSessions) {
			if (familyRootOf.has(session.path) || runParentOf.has(session.path)) continue;
			if (session.liveTabId !== undefined || heldByTab.has(session.path) || heldByTab.has(session.id)) continue;
			const recorded = closedCwdOf.get(session.path);
			const gone = projectName(session.cwd).gone;
			// A discarded worktree's stored sessions go with it, unless main recorded the work as landed.
			if (gone && recorded === undefined) continue;
			const origin = projectName(gone && recorded !== undefined ? recorded : session.cwd);
			if (
				closedOpeners.has(session.path) ||
				agentMessageSender(session.firstMessage) !== null ||
				origin.worktree?.worktree?.kind === "agent"
			)
				roots.set(session.path, origin.root);
		}
		return roots;
	}, [codeSessions, familyRootOf, runParentOf, heldByTab, closedCwdOf, closedOpeners, projectName]);
	// The opener's path → what it opened, in the order it opened them.
	const familyChildrenOf = useMemo(() => {
		const byRoot = new Map<string, SidebarSession[]>();
		for (const session of codeSessions) {
			const root = familyRootOf.get(session.path);
			if (root === undefined) continue;
			const siblings = byRoot.get(root);
			if (siblings) siblings.push(session);
			else byRoot.set(root, [session]);
		}
		for (const siblings of byRoot.values())
			siblings.sort((a, b) => createdAt(a) - createdAt(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		return byRoot;
	}, [codeSessions, familyRootOf]);
	// Chat lane: chats and other no-project sessions, one recency-ordered list.
	const chatLaneSessions = useMemo(
		() =>
			allSessions
				.filter(
					session => session.kind === "chat" || (defaultWorkspace !== null && session.cwd === defaultWorkspace),
				)
				.filter(matchesFilter)
				.toSorted(byPinThenRecency),
		[allSessions, defaultWorkspace, matchesFilter, byPinThenRecency],
	);

	// Code sessions stay grouped by project: pinned first, then the order the user
	// dragged, with projects they never placed on top by recency.
	const allGroups = useMemo<WorkspaceGroup[]>(() => {
		const byKey = new Map<
			string,
			Omit<WorkspaceGroup, "name" | "tooltip" | "root" | "worktree"> & { shown: ProjectName }
		>();
		for (const session of codeSessions) {
			// A discarded worktree's stored sessions go with it (the folder is gone; the session picker still finds them).
			if (projectName(session.cwd).gone && session.liveTabId === undefined) continue;
			// A session another session's agent opened lives in that session's family, whatever its folder.
			if (familyRootOf.has(session.path)) continue;
			// One no opener holds folds into its project's group, below.
			if (foldedRootOf.has(session.path)) continue;
			const runCwd = runParentOf.get(session.path);
			const shown = projectName(runCwd ?? session.cwd);
			// The parallel children of one project share ONE group; a run of Autopilot keeps its own, children included.
			const merged = runCwd === undefined && shown.worktree?.worktree?.kind === "agent";
			const key = runCwd ?? (merged ? `${shown.root}#agent` : session.cwd);
			let entry = byKey.get(key);
			if (!entry) {
				entry = { cwd: key, members: [], newCwd: merged ? shown.root : key, sessions: [], folded: [], shown };
				byKey.set(key, entry);
			}
			if (!entry.members.includes(session.cwd)) entry.members.push(session.cwd);
			entry.sessions.push(session);
		}
		for (const session of codeSessions) {
			const root = foldedRootOf.get(session.path);
			if (root === undefined) continue;
			let entry = byKey.get(root);
			if (!entry) {
				entry = { cwd: root, members: [root], newCwd: root, sessions: [], folded: [], shown: projectName(root) };
				byKey.set(root, entry);
			}
			entry.folded.push(session);
		}
		// A linked worktree reads as its project + what it is for; the folder name (`gui-<name>-<hash>`) never shows.
		const result: WorkspaceGroup[] = [...byKey.values()].map(({ shown, ...entry }) => ({
			...entry,
			name: groupAliases[entry.cwd] ?? shown.name,
			tooltip: entry.cwd === entry.newCwd || !shown.worktree ? shown.tooltip : shown.worktree.root,
			root: shown.root,
			worktree: shown.worktree,
			// The run's own rows first, then its children (one step further in).
			sessions: entry.sessions.toSorted(
				(a, b) => Number(runParentOf.has(a.path)) - Number(runParentOf.has(b.path)) || byPinThenRecency(a, b),
			),
			folded: entry.folded.toSorted((a, b) => createdAt(a) - createdAt(b) || (a.path < b.path ? -1 : 1)),
		}));
		const ordered = orderProjects(result, {
			pinned: pinnedGroups,
			manual: groupOrder,
			recency: group => Math.max(...[...group.sessions, ...group.folded].map(createdAt)),
		});
		// A worktree's group sits right under its project's group when that one is listed.
		const mainRoots = new Set(ordered.filter(group => !group.worktree).map(group => group.root));
		const placed = new Set<string>();
		return ordered.flatMap(group => {
			if (group.worktree) return mainRoots.has(group.root) ? [] : [group];
			if (placed.has(group.root)) return [group];
			placed.add(group.root);
			const attached = ordered
				.filter(other => other.worktree && other.root === group.root)
				// Under its project the group only needs what the worktree is for; elsewhere it names the project too.
				.map(other => ({
					...other,
					attached: true,
					name:
						groupAliases[other.cwd] ??
						(other.worktree ? worktreeLabel(other.worktree, kindLabels) : null) ??
						other.name,
				}));
			return [group, ...attached];
		});
	}, [
		codeSessions,
		groupAliases,
		pinnedGroups,
		groupOrder,
		byPinThenRecency,
		projectName,
		kindLabels,
		runParentOf,
		familyRootOf,
		foldedRootOf,
	]);
	// A session matches when it does or when something it opened does: its family shows with it.
	const matchesFamilyFilter = useCallback(
		(session: SidebarSession) =>
			matchesFilter(session) || (familyChildrenOf.get(session.path) ?? []).some(child => matchesFilter(child)),
		[matchesFilter, familyChildrenOf],
	);
	const groups = useMemo(
		() =>
			query
				? allGroups
						.map(group => {
							const named = group.name.toLocaleLowerCase().includes(query);
							return {
								...group,
								sessions: named ? group.sessions : group.sessions.filter(matchesFamilyFilter),
								folded: named ? group.folded : group.folded.filter(matchesFilter),
							};
						})
						.filter(group => group.sessions.length + group.folded.length > 0)
				: allGroups,
		[allGroups, matchesFamilyFilter, matchesFilter, query],
	);
	// Recent grouping: the Code lane as one list by last activity, project shown per row. A session another one
	// opened is in that one's family, not a row of its own; one no opener holds is listed only while it needs a look.
	const recentCodeSessions = useMemo(
		() =>
			grouping === "recent"
				? codeSessions
						.filter(
							session =>
								!familyRootOf.has(session.path) &&
								!foldedRootOf.has(session.path) &&
								matchesFamilyFilter(session),
						)
						.toSorted(byPinThenRecency)
				: [],
		[grouping, codeSessions, familyRootOf, foldedRootOf, matchesFamilyFilter, byPinThenRecency],
	);
	const recentFolded = useMemo(
		() =>
			grouping === "recent"
				? codeSessions
						.filter(session => foldedRootOf.has(session.path) && matchesFilter(session))
						.toSorted((a, b) => createdAt(a) - createdAt(b) || (a.path < b.path ? -1 : 1))
				: [],
		[grouping, codeSessions, foldedRootOf, matchesFilter],
	);
	// Archived sessions of this lane that no tab holds, newest first.
	const archivedRows = sessions
		.filter(
			session =>
				archivedIds.has(session.id) &&
				sessionHasContent(session) &&
				!heldByTab.has(session.path) &&
				!heldByTab.has(session.id) &&
				(session.kind === "chat" || (defaultWorkspace !== null && session.cwd === defaultWorkspace)) ===
					(mode === "chat"),
		)
		.filter(matchesFilter)
		.toSorted((a, b) => createdAt(b) - createdAt(a));
	const totalCount =
		mode === "chat"
			? chatLaneSessions.length
			: grouping === "recent"
				? recentCodeSessions.length + recentFolded.length
				: groups.length;
	// An empty lane must not read as "no sessions at all" while the other lane
	// holds some (e.g. the open code session while 채팅 is selected).
	const codeTotal = codeSessions.length;
	const otherModeCount = mode === "chat" ? codeTotal : allSessions.length - codeTotal;
	const visibleGroups = mode === "code" && grouping === "projects" ? groups : [];
	// Projects with an open tab, or one a paired device's tab here works in, start expanded so every open session is
	// in view.
	const openTabCwds = useMemo(
		() =>
			new Set([
				...localTabs.filter(tab => tab.kind !== "chat").map(tab => tab.cwd),
				...hostedSessions.filter(hosted => hosted.kind !== "chat").map(hosted => hosted.cwd),
			]),
		[localTabs, hostedSessions],
	);

	const isCollapsed = (group: Pick<WorkspaceGroup, "cwd" | "members">) => {
		// A filter shows every match.
		if (query) return false;
		if (group.cwd in groupFolds) return groupFolds[group.cwd];
		// Default: the current project and projects with open tabs expanded, others collapsed.
		return !group.members.some(member => member === cwd || openTabCwds.has(member));
	};
	const toggleGroup = (group: Pick<WorkspaceGroup, "cwd" | "members">) => {
		useSidebarFolds.getState().setGroupFolded(group.cwd, !isCollapsed(group));
	};
	// The folds and the open families as they were left: the mirror painted the first frame, the saved pref is read
	// again here and wins when it differs.
	useEffect(() => {
		void useSidebarFolds.getState().hydrate();
		void useSidebarSubagentsStore.getState().hydrate();
	}, []);
	// Forget the folds of folders, hosts and sessions that are gone. Only a live read (not the last-known snapshot,
	// which holds the newest rows only) and a loaded host list say what still exists.
	useEffect(() => {
		if (!listLive) return;
		const folders = new Set<string>();
		for (const group of allGroups) {
			folders.add(group.cwd);
			folders.add(group.root);
			folders.add(group.newCwd);
			for (const member of group.members) folders.add(member);
		}
		for (const session of sessions) if (!projectName(session.cwd).gone) folders.add(session.cwd);
		useSidebarFolds.getState().pruneGroups(key => folders.has(key) || folders.has(key.replace(/#agent$/, "")));
		// A session an open tab holds stays known even before the index lists its file.
		const known = new Set([...sessions.map(session => session.path), ...heldByTab]);
		useSidebarSubagentsStore.getState().pruneFamilies(key => !isRememberedSession(key) || known.has(key));
	}, [listLive, allGroups, sessions, heldByTab, projectName]);
	const hostsLoaded = useRemoteStore(s => s.state !== null);
	useEffect(() => {
		if (hostsLoaded) useSidebarFolds.getState().pruneDevices(new Set(hosts.map(host => host.deviceId)));
	}, [hostsLoaded, hosts]);
	// This device's own list folds under its header once a host is paired; a filter shows every match.
	const localFoldedPref = useSidebarFolds(s => s.devices[LOCAL_DEVICE] === true);
	const localFolded = localFoldedPref && hosts.length > 0 && query.length === 0;
	// A drag arms only after 6px of movement, so clicking a project still toggles it.
	const projectSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
	const onProjectDragEnd = ({ active, over }: DragEndEvent) => {
		if (!over || active.id === over.id) return;
		void useSidebarPrefs.getState().setGroupOrder(
			reorderProjects(
				allGroups.map(group => group.cwd),
				String(active.id),
				String(over.id),
			),
		);
	};
	// The tab's file names its row before the session store has an id (a tab restored from the tab snapshot, a start
	// whose omp is not ready): the selection is on the first frame, not after the first read.
	const isCurrentSession = (session: SidebarSession) =>
		!activeTabRemote &&
		(session.id === sessionId ||
			(session.liveTabId !== undefined && session.liveTabId === activeTabId) ||
			(activeTab?.sessionPath !== undefined && activeTab.sessionPath === session.path));
	// Main reports a tab's file (get_state → sessionPath) reliably; the session id
	// only arrives with stock's rare session_info_update, so match the path first.
	const tabForSession = (session: SidebarSession) =>
		(session.liveTabId ? localTabs.find(tab => tab.id === session.liveTabId) : undefined) ??
		localTabs.find(tab => tab.sessionPath === session.path) ??
		localTabs.find(tab => tab.sessionId === session.id) ??
		(isCurrentSession(session) ? activeTab : undefined);
	/** The paired device's tab on this computer that runs the session (its live state when no tab here shows it). */
	const hostedFor = (session: SidebarSession) => hostedByKey.get(session.path) ?? hostedByKey.get(session.id);
	const sessionTabSignal = (session: SidebarSession) => {
		const tab = tabForSession(session);
		if (tab) return tabSignalPresentation(tab, isCurrentSession(session) && (isStreaming || isCompacting));
		const hosted = hostedFor(session);
		return hosted
			? tabSignalPresentation({
					status: hosted.status,
					awaitingInput: hosted.awaitingInput ? "input" : undefined,
					unreadDone: false,
				})
			: null;
	};
	const isSessionBusy = (session: SidebarSession) => {
		if (isCurrentSession(session) && awaitedInput) return true;
		const signal = sessionTabSignal(session);
		if (signal) return signal.active;
		if (isCurrentSession(session) && (isStreaming || isCompacting)) return true;
		return session.status === "pending";
	};

	const openSession = (session: SidebarSession) => {
		useUiStore.getState().closeDestination();
		if (isCurrentSession(session)) return;
		// A session main closed after its work landed may have lost its worktree: it reopens in the checkout it came from.
		const recordedCwd = closedCwdOf.get(session.path);
		const reopened =
			recordedCwd && projectName(session.cwd).gone && session.liveTabId === undefined
				? { ...session, cwd: recordedCwd }
				: session;
		// Already open in a tab: go there. An untouched empty tab is replaced
		// instead of left behind; anything else keeps its tab and the session
		// opens next to it.
		const owner = tabForSession(session);
		if (owner) {
			void useTabsStore.getState().switchTab(owner.id);
			return;
		}
		if (activeTabUntouched()) {
			requestSessionSwitch(reopened);
			return;
		}
		void openTab({ cwd: reopened.cwd, sessionPath: reopened.path, kind: reopened.kind ?? "agent" });
	};
	/** Start in `target`: re-root the untouched tab, else open a new one. */
	const goToProject = async (target: string) => {
		useUiStore.getState().closeDestination();
		if (activeTabUntouched() && activeTab?.kind !== "chat") {
			if (target === cwd) {
				focusComposer();
				return;
			}
			try {
				if (await window.omp.sidecar.setProject(target)) return;
			} catch {
				// Fall through to a fresh tab.
			}
		}
		await openTab({ cwd: target, kind: "agent" });
	};
	const startNew = () => {
		if (mode === "chat") {
			startChat();
			return;
		}
		// A remote tab's folder is on its host: the new session opens there too.
		if (activeTab?.device !== undefined && activeTab.kind !== "chat") {
			useUiStore.getState().closeDestination();
			void openTab({ device: activeTab.device });
			return;
		}
		const target = activeTab?.kind === "chat" ? null : cwd;
		if (!target) {
			setWorkspaceDialog("new-session");
			return;
		}
		if (activeTabUntouched() && activeTab?.kind !== "chat") {
			useUiStore.getState().closeDestination();
			focusComposer();
			return;
		}
		void goToProject(target);
	};
	const startChat = () => {
		useUiStore.getState().closeDestination();
		void openTab({ kind: "chat" });
	};
	/** Pick an existing folder or make one in the native panel ("New Folder"), then start a session there. */
	const openProjectFolder = async () => {
		try {
			const picked = await pickWorkspaceDirectory({
				title: t("sidebar.project.newFolderTitle"),
				buttonLabel: t("sidebar.project.newFolderButton"),
			});
			if (!picked) return;
			setMode("code");
			await goToProject(picked);
		} catch (error) {
			toastError({ title: t("titlebar.openProjectFailed"), error });
		}
	};
	// Explicit parallel action: open this session in a NEW window with its own
	// sidecar, leaving the current window's running session untouched.
	const openSessionInNewWindow = async (session: SessionInfo) => {
		const ok = await window.omp.sessions.openInNewWindow({ sessionPath: session.path, cwd: session.cwd });
		if (!ok) {
			toast({ variant: "error", message: t("sidebar.openFailed") });
			return;
		}
	};
	/** Open a stored session in a new tab placed beside the focused one. */
	const openSessionInSplit = async (session: SessionInfo) => {
		useUiStore.getState().closeDestination();
		const anchorTabId = useTabsStore.getState().activeTabId;
		const opened = await openTab({ cwd: session.cwd, sessionPath: session.path, kind: session.kind ?? "agent" });
		if (!opened || !anchorTabId || opened === anchorTabId) return;
		// openTab focused the new tab: bring the previous one back, then split the new one in beside it.
		await useTabsStore.getState().switchTab(anchorTabId);
		await useTabsStore.getState().splitTab(opened, "right");
	};
	/** Archive or restore sessions (prefs only: the files stay); a row that leaves hands focus to its neighbor. */
	const setArchived = (rows: readonly SidebarSession[], archived: boolean) => {
		const items = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-roving-item]") ?? [])];
		const leaving = items.find(item => item === document.activeElement)?.dataset.rovingItem;
		if (leaving && rows.some(row => `session:${row.path}` === leaving)) {
			const index = items.findIndex(item => item.dataset.rovingItem === leaving);
			const neighbor = (items[index + 1] ?? items[index - 1])?.dataset.rovingItem;
			if (neighbor) refocusRow.current = { key: neighbor, leaving };
		}
		void useSidebarPrefs.getState().setSessionsArchived(
			rows.map(row => row.id),
			archived,
		);
	};
	/** Move a stored session's file to another project folder (stock SessionManager.moveTo in main). */
	const moveStoredSession = async (session: SidebarSession, target: string) => {
		setMoveMenu(null);
		try {
			const movedPath = await window.omp.sessions.move(session.path, target);
			// Pins are kept by file path, which the move changed.
			if (movedPath !== session.path && useSidebarPrefs.getState().pinnedSessions.includes(session.path)) {
				await useSidebarPrefs.getState().toggleSessionPin(session.path);
				await useSidebarPrefs.getState().toggleSessionPin(movedPath);
			}
			toast({
				variant: "success",
				message: t("sidebar.moved", { name: groupAliases[target] ?? projectName(target).name }),
			});
		} catch (error) {
			toastError({ title: t("sidebar.moveFailed"), error });
		}
	};
	const moveToOtherFolder = async (session: SidebarSession) => {
		setMoveMenu(null);
		try {
			const picked = await pickWorkspaceDirectory({
				title: t("sidebar.move.pickTitle"),
				buttonLabel: t("sidebar.move.pickButton"),
			});
			if (picked && picked !== session.cwd) await moveStoredSession(session, picked);
		} catch (error) {
			toastError({ title: t("sidebar.moveFailed"), error });
		}
	};
	const copySessionPath = async (session: SessionInfo) => {
		if (await copyText(session.path)) toast({ variant: "success", message: t("sidebar.pathCopied") });
		else toast({ variant: "error", message: t("sidebar.copyPathFailed") });
	};
	const revealSession = async (session: SessionInfo) => {
		try {
			const result = await window.omp.system.revealPath(session.path);
			if (!result.ok) toastError({ title: t("sidebar.revealFailed"), error: result.error ? result : session.path });
		} catch (error) {
			toastError({ title: t("sidebar.revealFailed"), error });
		}
	};

	const startRename = (session: SessionInfo) => {
		setRenameDraft(sessionDisplayTitle(session, ""));
		setRenamingSessionPath(session.path);
	};
	const commitRename = (session: SessionInfo, value = renameDraft) => {
		setRenamingSessionPath(null);
		const name = value.trim();
		if (!name || name === session.title) return;
		void renameSession(session.path, name)
			.then(() => {
				// The owning tab's store — a split pane or the focused one — so a
				// running session's own title bar follows without waiting for a refresh.
				const tabId = tabForSession(session)?.id ?? null;
				const store =
					sessionRuntimeStore<SessionStore>(tabId, "session") ??
					(session.id === sessionId ? useSessionStore : null);
				if (store?.getState().sessionId === session.id) store.setState({ sessionName: name });
			})
			.catch(error => toastError({ title: t("sidebar.renameFailed"), error }));
	};

	const confirmDeleteSession = async (session: SessionInfo) => {
		if (isSessionBusy(session)) {
			toast({ variant: "warning", message: t("sidebar.menu.taskRunning") });
			setPendingDelete(null);
			return;
		}
		setDeleting(true);
		// The row's neighbor (below, else above) takes focus once it is gone.
		const items = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-roving-item]") ?? [])];
		const leaving = `session:${session.path}`;
		const index = items.findIndex(item => item.dataset.rovingItem === leaving);
		const neighbor = index === -1 ? undefined : (items[index + 1] ?? items[index - 1])?.dataset.rovingItem;
		try {
			// The tab showing the session closes as closing a tab does (the window's last tab gives way to the
			// empty start tab); no session replaces it. A tab whose unsaved Files edits ask first stays, and the
			// session with it.
			if (!(await useTabsStore.getState().closeDeletedSession(session.path, tabForSession(session)?.id))) {
				setPendingDelete(null);
				return;
			}
			// Main waits for that tab's omp to exit, then deletes the stored file (session-mutations.ts).
			await deleteSession(session.path);
			if (neighbor) refocusRow.current = { key: neighbor, leaving };
			setPendingDelete(null);
		} catch (error) {
			toastError({ title: t("sidebar.deleteFailed"), error });
		} finally {
			setDeleting(false);
		}
	};

	const confirmDeleteGroup = async (group: WorkspaceGroup) => {
		if (group.sessions.some(isSessionBusy)) {
			toast({ variant: "warning", message: t("sidebar.deleteGroupStreaming") });
			setPendingDelete(null);
			return;
		}
		setDeleting(true);
		try {
			// Close the project's open tabs first: a tab keeps a row (and so the
			// project) in the list, and closing it releases its session file.
			const paths = new Set(group.sessions.map(session => session.path));
			const ids = new Set(group.sessions.map(session => session.id));
			const projectTabs = useTabsStore
				.getState()
				.tabs.filter(
					tab =>
						tab.kind !== "chat" &&
						tab.device === undefined &&
						(group.members.includes(tab.cwd) ||
							(tab.sessionPath !== undefined && paths.has(tab.sessionPath)) ||
							(tab.sessionId !== undefined && ids.has(tab.sessionId))),
				);
			// Each closes as a deleted session's tab does: the window's last one gives way to the empty start
			// tab, never to a new session somewhere else.
			for (const tab of projectTabs) {
				// eslint-disable-next-line no-await-in-loop -- each close switches the active tab
				if (!(await useTabsStore.getState().closeDeletedSession(tab.sessionPath ?? "", tab.id))) {
					setPendingDelete(null);
					return;
				}
			}
			// Then delete every session file in the project. Live-only rows have no file.
			for (const session of group.sessions.filter(entry => entry.liveTabId === undefined)) {
				// eslint-disable-next-line no-await-in-loop -- sequential, keep FS load bounded
				await useTabsStore.getState().closeDeletedSession(session.path, undefined);
				// eslint-disable-next-line no-await-in-loop -- sequential, keep FS load bounded
				await deleteSession(session.path);
			}
			setPendingDelete(null);
		} catch (error) {
			toastError({ title: t("sidebar.deleteFailed"), error });
		} finally {
			setDeleting(false);
		}
	};

	const confirmDeleteArchived = async (rows: readonly SidebarSession[]) => {
		setDeleting(true);
		const deleted: string[] = [];
		try {
			for (const session of rows) {
				// eslint-disable-next-line no-await-in-loop -- sequential, keep FS load bounded
				await useTabsStore.getState().closeDeletedSession(session.path, undefined);
				// eslint-disable-next-line no-await-in-loop -- sequential, keep FS load bounded
				await deleteSession(session.path);
				deleted.push(session.id);
			}
			setPendingDelete(null);
		} catch (error) {
			toastError({ title: t("sidebar.deleteFailed"), error });
		} finally {
			// Forget the ids whose files are gone, also when a later delete failed.
			if (deleted.length > 0) void useSidebarPrefs.getState().setSessionsArchived(deleted, false);
			setDeleting(false);
		}
	};

	/** Context-menu position for a keyboard-opened menu: under the focused element. */
	const anchorBelow = (element: HTMLElement): ContextMenuAnchor => {
		const rect = element.getBoundingClientRect();
		return {
			x: Number.isFinite(rect.left) ? rect.left : 8,
			y: (Number.isFinite(rect.bottom) ? rect.bottom : 40) + 4,
		};
	};
	const opensMenu = (event: ReactKeyboardEvent) =>
		event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);

	// Roving focus: items render with tabIndex -1; the effect below makes the
	// remembered (else current, else first) item the list's single tab stop.
	const activeSessionKey = allSessions.find(isCurrentSession)?.path;
	const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
		const items = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-roving-item]") ?? [])];
		const index = items.indexOf(document.activeElement as HTMLElement);
		if (index === -1) return;
		event.preventDefault();
		const next =
			event.key === "Home"
				? 0
				: event.key === "End"
					? items.length - 1
					: Math.min(items.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
		const item = items[next];
		if (item) focusRovingItem(item);
	};
	// After render, exactly one roving item is tabbable: the remembered one,
	// else the current session, else the first row.
	useEffect(() => {
		const items = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-roving-item]") ?? [])];
		if (items.length === 0) return;
		const preferred =
			items.find(item => item.dataset.rovingItem === focusKey) ??
			items.find(item => item.dataset.rovingItem === `session:${activeSessionKey}`) ??
			items[0];
		for (const item of items) item.tabIndex = item === preferred ? 0 : -1;
	});
	// Hand focus back to the list when the focused control goes away: a rename
	// field ended by keyboard (back to its row), or a deleted row (on to its
	// neighbor; the confirm dialog hands focus back to the row it is removing).
	useEffect(() => {
		const pending = refocusRow.current;
		if (!pending || renamingSessionPath !== null || renamingGroupCwd !== null || pendingDelete !== null) return;
		refocusRow.current = null;
		const active = document.activeElement;
		const leaving = active instanceof HTMLElement && active.dataset.rovingItem === pending.leaving;
		if (active && active !== document.body && !leaving) return;
		const target = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-roving-item]") ?? [])].find(
			item => item.dataset.rovingItem === pending.key,
		);
		if (target) focusRovingItem(target);
	});

	/** What a session row says about the session's run: one computation for a row and for a child of its family. */
	const sessionRowState = (session: SidebarSession) => {
		const isCurrent = isCurrentSession(session);
		const tab = tabForSession(session);
		// Every pane of the split on screen reads as selected; the focused one adds a cue (data-pane-focus).
		const inVisibleSplit = !isCurrent && tab !== undefined && splitIds?.has(tab.id) === true;
		const active = (isCurrent || inVisibleSplit) && destination === "session";
		const indexed = session.liveTabId === undefined;
		const tabSignal = sessionTabSignal(session);
		// Background tabs park their dialogs in their own runtime; the tab entry carries the flag. A paired device's
		// tab here that no tab of this window shows says it through its hosted state.
		const hosted = tab === undefined ? hostedFor(session) : undefined;
		const waiting =
			(isCurrent ? awaitedInput : null) ?? tab?.awaitingInput ?? (hosted?.awaitingInput ? "input" : undefined);
		const running = !waiting && (tabSignal?.running === true || (tabSignal === null && isSessionBusy(session)));
		const failed =
			!waiting &&
			!running &&
			(tabSignal ? tabSignal.labelKey === "titlebar.status.error" : session.status === "error");
		const done = !waiting && !running && !failed && tabSignal?.labelKey === "tabs.done";
		const openElsewhere = tab !== undefined && !isCurrent && !inVisibleSplit;
		const busy = waiting !== undefined || running || tabSignal?.active === true;
		const waitingLabel = waiting
			? t(waiting === "approval" ? "sidebar.row.needsApproval" : "sidebar.row.needsInput")
			: null;
		const statusLabel =
			waitingLabel ??
			(running
				? t("sidebar.signal.running")
				: failed
					? t("sidebar.row.failed")
					: done
						? t("tabs.done")
						: openElsewhere
							? t("sidebar.row.open")
							: null);
		return {
			isCurrent,
			tab,
			hosted,
			active,
			indexed,
			waiting,
			running,
			failed,
			done,
			openElsewhere,
			busy,
			waitingLabel,
			statusLabel,
		};
	};
	const renderRenameField = (session: SidebarSession, key: string, tabId: string | undefined, indent: string) => (
		<div className={cx("omp-sidebar-session-rename grid content-center py-0.5 pr-1", indent)} key={session.path}>
			<SidebarRenameField
				onCancel={() => {
					refocusRow.current = { key };
					setRenamingSessionPath(null);
				}}
				onChange={setRenameDraft}
				onCommit={(value, via) => {
					if (via === "enter") refocusRow.current = { key };
					commitRename(session, value);
				}}
				onGenerated={title => {
					// The omp saved it: show it in the owning tab's title bar and close the field.
					const store = sessionRuntimeStore<SessionStore>(tabId ?? null, "session");
					if (store?.getState().sessionId === session.id) store.setState({ sessionName: title });
					setRenamingSessionPath(null);
					refocusRow.current = { key };
				}}
				tabId={tabId}
				value={renameDraft}
			/>
		</div>
	);
	/** One session its agent opened, as a one-line child under the session that opened it. */
	const familyChildFor = (child: SidebarSession, nested: boolean): FamilyOpened => {
		const key = `session:${child.path}`;
		const row = sessionRowState(child);
		const origin = projectName(child.cwd);
		const openTabId = row.tab?.id;
		// An opened session reads as its task until it has a title, even when the index lists it without its first
		// message yet; a closed one keeps the title main recorded.
		const title =
			sessionDisplayTitle(child, "") ||
			row.tab?.task ||
			closedTitleOf.get(child.path) ||
			t(row.indexed ? "sidebar.untitled" : "sidebar.newSession");
		const deletable = row.indexed && !row.busy;
		const lastRun = row.tab?.lastRun;
		const review = openTabId ? reviewOf.get(openTabId) : undefined;
		const failed =
			row.failed || review?.failed === true || lastRun?.stopReason === "error" || lastRun?.stopReason === "aborted";
		const status = openedChildStatus({
			waiting: row.waiting !== undefined,
			running: row.running,
			finished:
				lastRun !== undefined ||
				closedTitleOf.has(child.path) ||
				(row.tab === undefined && row.hosted === undefined) ||
				(!row.busy && child.messageCount >= 2),
			failed,
			unmerged:
				review?.branch !== undefined &&
				review.state !== "running" &&
				(review.commitsAhead > 0 || review.uncommitted > 0),
		});
		const statusLabel =
			status === "problem"
				? t(failed ? "sidebar.row.failed" : "sidebar.family.unmerged")
				: status === "done"
					? t("tabs.done")
					: (row.statusLabel ?? "");
		return {
			key: child.path,
			kind: row.tab?.worktree !== undefined || origin.worktree ? "worktree" : "session",
			status,
			state: status ? CHILD_TOKEN[status] : null,
			stateLabel: statusLabel,
			title,
			age: row.indexed ? formatTimeAgo(child.modified) : undefined,
			// The one line has no room for the status in words or the folder: they are the tooltip.
			tooltip: [title, statusLabel, origin.tooltip].filter(Boolean).join("\n"),
			selected: row.active,
			onOpen: () => openSession(child),
			renaming:
				renamingSessionPath === child.path
					? renderRenameField(child, key, openTabId, nested ? "pl-11" : "pl-6.5")
					: undefined,
			buttonProps: {
				tabIndex: -1,
				"data-roving-item": key,
				onFocus: () => setFocusKey(key),
				onKeyDown: event => {
					if (opensMenu(event)) {
						event.preventDefault();
						setSessionMenu({ anchor: anchorBelow(event.currentTarget), session: child });
					} else if (event.key === "F2" && row.indexed) {
						event.preventDefault();
						startRename(child);
					} else if (event.key === "Delete" && deletable) {
						event.preventDefault();
						setPendingDelete({ kind: "session", session: child });
					}
				},
			},
			rowProps: {
				draggable: openTabId !== undefined && !row.isCurrent,
				onDragStart: event => {
					if (!openTabId) return;
					event.dataTransfer.effectAllowed = "move";
					hideNativeDragImage(event.dataTransfer);
					window.dispatchEvent(new CustomEvent("omp:tab-drag", { detail: { tabId: openTabId } }));
				},
				onDragEnd: () => window.dispatchEvent(new CustomEvent("omp:tab-drag", { detail: { tabId: null } })),
				onContextMenu: event => setSessionMenu({ anchor: anchorFromEvent(event), session: child }),
				"data-active": row.active,
				"data-current": row.isCurrent || undefined,
				"data-live": row.indexed ? undefined : true,
				"data-session-kind": child.kind ?? "agent",
				"data-session-path": child.path,
				"data-sidebar-opened-session": true,
				"data-signal": row.waiting
					? "waiting"
					: row.running
						? "running"
						: status === "problem"
							? "error"
							: undefined,
				"data-child-status": status ?? undefined,
			},
		};
	};

	/** `archived`: a row of the Archived section; `recent`: a row of the flat recent list, which names its project. */
	const renderSessionRow = (session: SidebarSession, nested = false, variant?: "archived" | "recent") => {
		const key = `session:${session.path}`;
		const {
			isCurrent,
			tab,
			active,
			indexed,
			waiting,
			running,
			failed,
			done,
			openElsewhere,
			busy,
			waitingLabel,
			statusLabel,
		} = sessionRowState(session);
		// An Autopilot child sits under its run's row inside the run's group (`runParentOf`).
		const runChild = nested && variant === undefined && runParentOf.has(session.path);
		// The sessions this one's agent opened nest under it, one indent level in, like its subagents.
		const opened =
			variant === "archived"
				? []
				: (familyChildrenOf.get(session.path) ?? []).map(child => familyChildFor(child, nested));
		const title =
			sessionDisplayTitle(session, "") || tab?.task || (indexed ? t("sidebar.untitled") : t("sidebar.newSession"));
		const fork = sessionForkOrigin(session, sessionsByPathOrId);
		const pinned = pinnedSessions.includes(session.path);
		// Renaming is safe mid-run (stock applies it live); deleting is not.
		const deletable = indexed && !busy;
		// Archiving hides a stored session no tab holds (an open tab always keeps its row).
		const archivable = indexed && tab === undefined && variant !== "archived";
		const tabIndex = -1;
		if (renamingSessionPath === session.path)
			return renderRenameField(session, key, tab?.id, nested ? "omp-sidebar-session-rename-nested" : "pl-1");
		// The state is drawn on the row's left edge (sidebar.css `data-signal`), not as a leading glyph.
		const signal = waiting ? "waiting" : running ? "running" : failed ? "error" : undefined;
		const leading: ReactNode =
			session.kind === "chat" && !done ? (
				<MessageCircle aria-hidden data-sidebar-session-icon />
			) : pinned && !done ? (
				<Pin aria-label={t("sidebar.pinned")} />
			) : fork && !done ? (
				<GitFork aria-hidden data-sidebar-fork />
			) : (
				<span
					aria-hidden
					className="flex size-(--sc-icon-md) items-center justify-center"
					data-sidebar-session-icon
				>
					{done ? (
						<span className="size-2 rounded-(--sc-radius-full) bg-(--sc-success)" data-sidebar-done />
					) : (
						openElsewhere &&
						!signal && (
							<span
								className="size-1.5 rounded-(--sc-radius-full) bg-(--sc-text-subtle)"
								data-sidebar-open-tab
							/>
						)
					)}
				</span>
			);
		const openTabId = tab?.id;
		return (
			<Fragment key={session.path}>
				<ListRow
					actionsAtRest={touchInput}
					actionsOnHover={!touchInput}
					actionCount={
						touchInput ? 1 : [true, archivable, variant === "archived", deletable].filter(Boolean).length
					}
					actions={
						indexed && touchInput ? (
							<IconButton
								data-sidebar-row-menu
								icon={<MoreHorizontal />}
								label={t("sidebar.sessionMenu")}
								onClick={event => setSessionMenu({ anchor: anchorBelow(event.currentTarget), session })}
								size="sm"
								tabIndex={-1}
							/>
						) : indexed ? (
							<>
								<IconButton
									icon={<Pencil />}
									label={t("sidebar.rename")}
									onClick={() => startRename(session)}
									size="sm"
									tabIndex={-1}
								/>
								{archivable && (
									<IconButton
										data-sidebar-archive
										icon={<Archive />}
										label={t("sidebar.menu.archive")}
										onClick={() => setArchived([session], true)}
										size="sm"
										tabIndex={-1}
									/>
								)}
								{variant === "archived" && (
									<IconButton
										data-sidebar-restore
										icon={<ArchiveRestore />}
										label={t("sidebar.menu.restore")}
										onClick={() => setArchived([session], false)}
										size="sm"
										tabIndex={-1}
									/>
								)}
								{deletable && (
									<IconButton
										icon={<Trash2 />}
										label={t("sidebar.delete")}
										onClick={() => setPendingDelete({ kind: "session", session })}
										size="sm"
										tabIndex={-1}
									/>
								)}
							</>
						) : undefined
					}
					buttonProps={{
						tabIndex,
						"data-roving-item": key,
						onFocus: () => setFocusKey(key),
						onKeyDown: event => {
							if (opensMenu(event)) {
								event.preventDefault();
								setSessionMenu({ anchor: anchorBelow(event.currentTarget), session });
							} else if (event.key === "F2" && indexed) {
								event.preventDefault();
								startRename(session);
							} else if (event.key === "Delete" && deletable) {
								event.preventDefault();
								setPendingDelete({ kind: "session", session });
							} else if (
								(event.key === "ArrowRight" || event.key === "ArrowLeft") &&
								sidebarSubagentCount(openTabId ?? "") + opened.length > 0
							) {
								const open = event.key === "ArrowRight";
								const subagents = useSidebarSubagentsStore.getState();
								if (open === subagents.expanded.has(session.path)) return;
								event.preventDefault();
								subagents.setExpanded(session.path, open);
							}
						},
					}}
					className={cx(
						"omp-sidebar-session-row",
						nested && "omp-sidebar-session-nested",
						runChild && "omp-sidebar-session-run-child",
					)}
					description={
						variant === "recent" && session.cwd ? (
							<span data-sidebar-row-project title={projectName(session.cwd).tooltip}>
								{groupAliases[session.cwd] ?? projectName(session.cwd, session.title).name}
							</span>
						) : undefined
					}
					leading={leading}
					meta={
						waiting ? (
							<Badge className="omp-sidebar-approval" variant="warning">
								{waitingLabel}
							</Badge>
						) : indexed ? (
							<time className="text-(--sc-text-subtle)" dateTime={session.modified}>
								{formatTimeAgo(session.modified)}
							</time>
						) : undefined
					}
					onClick={() => {
						// Clicking the session already in view folds/unfolds its family rows.
						if (active && openTabId && sidebarSubagentCount(openTabId) + opened.length > 0)
							toggleSidebarSubagents(session.path);
						openSession(session);
					}}
					rowProps={{
						draggable: openTabId !== undefined && !isCurrent,
						onDragStart: event => {
							if (!openTabId) return;
							event.dataTransfer.effectAllowed = "move";
							hideNativeDragImage(event.dataTransfer);
							window.dispatchEvent(new CustomEvent("omp:tab-drag", { detail: { tabId: openTabId } }));
						},
						onDragEnd: () => window.dispatchEvent(new CustomEvent("omp:tab-drag", { detail: { tabId: null } })),
						onContextMenu: event => setSessionMenu({ anchor: anchorFromEvent(event), session }),
						"data-active": active,
						"data-current": isCurrent || undefined,
						"data-pane-focus": (isCurrent && splitIds !== null) || undefined,
						"data-live": indexed ? undefined : true,
						"data-switch-pending": switchPendingTo === session.id || undefined,
						"data-session-kind": session.kind ?? "agent",
						"data-signal": signal,
						"data-session-path": session.path,
						"data-session-run-child": runChild || undefined,
					}}
					selected={active}
					title={
						<>
							<SwapText scope={session.path}>{title}</SwapText>
							{fork?.parentTitle && <ForkParent name={fork.parentTitle} />}
							{fork && <span className="sr-only">, {fork.label}</span>}
							{statusLabel && <span className="sr-only">, {statusLabel}</span>}
						</>
					}
					titleText={[title, fork?.tooltip, statusLabel].filter(Boolean).join("\n")}
					trailing={
						openTabId || opened.length > 0 ? (
							<SidebarSubagentsToggle opened={opened} sessionKey={session.path} tabId={openTabId ?? null} />
						) : undefined
					}
				/>
				{(openTabId || opened.length > 0) && (
					<SidebarSubagents nested={nested} opened={opened} sessionKey={session.path} tabId={openTabId ?? null} />
				)}
			</Fragment>
		);
	};

	const renderGroup = (group: WorkspaceGroup) => {
		const key = `group:${group.cwd}`;
		const groupCollapsed = isCollapsed(group);
		const isCurrentProject = group.cwd === cwd && activeTabKind !== "chat" && !activeTabRemote;
		const tabIndex = -1;
		const pinned = pinnedGroups.includes(group.cwd);
		// A collapsed project still says when something inside it is working.
		const groupBusy =
			groupCollapsed &&
			group.sessions.some(
				session => isSessionBusy(session) || (familyChildrenOf.get(session.path) ?? []).some(isSessionBusy),
			);
		const FolderIcon = groupCollapsed ? Folder : FolderOpen;
		// Sessions an agent opened that no opener row holds: only the ones that need a look are listed, so a project
		// with nothing else to show has no group at all.
		const loose = group.folded.map(child => familyChildFor(child, false)).filter(isShownOpened);
		if (group.sessions.length === 0 && loose.length === 0) return null;
		return (
			<SortableProject disabled={query.length > 0 || renamingGroupCwd !== null} id={group.cwd} key={group.cwd}>
				{dragHandle => (
					<>
						<div
							className={cx(
								"group/head relative flex h-8 cursor-default items-center rounded-(--sc-radius-md) hover:bg-(--sc-hover)",
								group.attached && "ml-3",
							)}
							data-workspace-group={group.cwd}
							data-worktree-group={group.worktree ? group.worktree.project : undefined}
							onContextMenu={event => setGroupMenu({ anchor: anchorFromEvent(event), group })}
							{...dragHandle}
						>
							{renamingGroupCwd === group.cwd ? (
								<div className="min-w-0 flex-1 pl-1">
									<Input
										aria-label={t("sidebar.menu.rename")}
										autoFocus
										controlSize="sm"
										onBlur={() => {
											useSidebarPrefs.getState().setGroupAlias(group.cwd, groupRenameDraft);
											setRenamingGroupCwd(null);
										}}
										onChange={event => setGroupRenameDraft(event.target.value)}
										onFocus={event => event.currentTarget.select()}
										onKeyDown={event => {
											if (isImeKeyEvent(event)) return;
											if (event.key === "Enter") {
												event.preventDefault();
												refocusRow.current = { key };
												useSidebarPrefs.getState().setGroupAlias(group.cwd, groupRenameDraft);
												setRenamingGroupCwd(null);
											}
											onEscape(event, () => {
												refocusRow.current = { key };
												setRenamingGroupCwd(null);
											});
										}}
										value={groupRenameDraft}
									/>
								</div>
							) : (
								<button
									aria-expanded={!groupCollapsed}
									className={cx(
										"flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-(--sc-radius-md) pr-1 pl-2 text-left text-sc-sm font-medium outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--sc-focus-ring)",
										isCurrentProject ? "text-(--sc-text)" : "text-(--sc-text-muted)",
									)}
									data-roving-item={key}
									onClick={() => toggleGroup(group)}
									onFocus={() => setFocusKey(key)}
									onKeyDown={event => {
										if (opensMenu(event)) {
											event.preventDefault();
											setGroupMenu({ anchor: anchorBelow(event.currentTarget), group });
										} else if (event.key === "ArrowRight" && groupCollapsed) {
											event.preventDefault();
											toggleGroup(group);
										} else if (event.key === "ArrowLeft" && !groupCollapsed) {
											event.preventDefault();
											toggleGroup(group);
										}
									}}
									tabIndex={tabIndex}
									title={group.tooltip}
									type="button"
								>
									{groupCollapsed ? (
										<ChevronRight aria-hidden className="size-(--sc-icon-sm) shrink-0" />
									) : (
										<ChevronDown aria-hidden className="size-(--sc-icon-sm) shrink-0" />
									)}
									{group.worktree ? (
										<GitBranch
											aria-hidden
											className="size-(--sc-icon-sm) shrink-0"
											data-sidebar-workspace-icon
											data-sidebar-worktree-icon
										/>
									) : (
										<FolderIcon
											aria-hidden
											className="size-(--sc-icon-sm) shrink-0"
											data-sidebar-workspace-icon
										/>
									)}
									<span className="min-w-0 flex-1 truncate">{group.name}</span>
									{pinned && (
										<Pin
											aria-label={t("sidebar.pinned")}
											className="size-3 shrink-0 text-(--sc-text-subtle)"
											data-sidebar-group-pin
										/>
									)}
									{groupBusy && (
										<span className="flex shrink-0 items-center">
											<span aria-hidden className="inline-flex">
												<Spinner size="sm" spin />
											</span>
											<span className="sr-only">, {t("sidebar.signal.running")}</span>
										</span>
									)}
								</button>
							)}
							{renamingGroupCwd !== group.cwd && (
								<span className="omp-sidebar-project-actions relative flex shrink-0 items-center pr-1">
									<IconButton
										className="omp-sidebar-project-menu pointer-events-none opacity-0 transition-opacity duration-(--sc-duration-fast) group-focus-within/head:pointer-events-auto group-focus-within/head:opacity-100 group-hover/head:pointer-events-auto group-hover/head:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"
										icon={<MoreHorizontal />}
										label={t("sidebar.groupMenu")}
										onClick={event => setGroupMenu({ anchor: anchorBelow(event.currentTarget), group })}
										size="sm"
										tabIndex={-1}
									/>
									{/* Always visible (Claude-style): a new session in this project, one click. */}
									<IconButton
										className="text-(--sc-text-subtle) hover:text-(--sc-text)"
										data-sidebar-group-new={group.cwd}
										icon={<Plus />}
										label={t("sidebar.menu.newAgentHere")}
										onClick={() => {
											useUiStore.getState().closeDestination();
											void openTab({ cwd: group.newCwd });
										}}
										size="sm"
										tabIndex={-1}
									/>
								</span>
							)}
						</div>
						{/* Collapsed groups render nothing: a long-lived install with
				    hundreds of sessions must not build the full DOM per
				    debounced refresh just to hide it. */}
						{!groupCollapsed && (
							<div className="space-y-px" data-session-group={group.cwd} data-state="expanded">
								{group.sessions.map(session => renderSessionRow(session, true))}
								<SidebarLooseChildren foldKey={`group:${group.cwd}`} opened={loose} />
							</div>
						)}
					</>
				)}
			</SortableProject>
		);
	};

	return (
		<>
			<aside
				aria-label={t("sidebar.label")}
				className="omp-session-sidebar relative flex h-full min-h-0 shrink-0 flex-col border-r border-(--sc-border-subtle) bg-(--sc-surface-1)"
				data-paused={windowVisible ? undefined : ""}
				style={{ width: sidebarWidth }}
			>
				{/* Traffic-light safe (global.css): on macOS the brand yields its
				    slot to the window controls and the collapse toggle follows
				    them; elsewhere the brand leads and the toggle closes the row. */}
				<div className="omp-sidebar-header drag-region flex h-12 shrink-0 items-center gap-1 pr-2">
					<span className="omp-sidebar-brand flex min-w-0 flex-1 items-center gap-2 pl-1.5 text-sc-md font-semibold text-(--sc-text)">
						<BrandMark size={18} />
						<span className="truncate">OMPdesk</span>
					</span>
					<IconButton
						className="omp-sidebar-search no-drag"
						data-command-center-entry
						icon={<Search />}
						label={t("help.palette")}
						onClick={() => useUiStore.getState().openCommandPalette()}
						shortcut={actionKbd("palette", keymapOverrides)}
						size="sm"
					/>
					<IconButton
						className="omp-sidebar-collapse no-drag"
						icon={<PanelLeftClose />}
						label={t("sidebar.collapse")}
						onClick={() => useUiStore.getState().toggleSidebar()}
						shortcut={actionKbd("sidebar.toggle", keymapOverrides)}
						size="sm"
					/>
				</div>

				<div className="omp-sidebar-controls flex shrink-0 flex-col gap-2 px-2 pt-1 pb-2">
					<Tabs
						activeId={mode}
						ariaLabel={t("sidebar.mode.aria")}
						className="flex w-full [&>button]:flex-1 [&>button]:justify-center"
						compact
						onChange={id => setMode(id as SidebarMode)}
						tabs={[
							{ id: "code", label: t("sidebar.mode.code") },
							{ id: "chat", label: t("sidebar.mode.chat") },
						]}
						variant="segmented"
					/>
					<div className="flex items-center gap-1">
						<Button
							className="min-w-0 flex-1 justify-start gap-2.5 px-2.5"
							data-sidebar-new-agent
							icon={mode === "chat" ? <MessageSquarePlus /> : <SquarePen />}
							onClick={startNew}
							variant="ghost"
						>
							<span className="min-w-0 flex-1 truncate text-left">
								{mode === "chat" ? t("sidebar.newChat") : t("sidebar.newSession")}
							</span>
						</Button>
						{mode === "code" && (
							<>
								<IconButton
									data-sidebar-grouping
									icon={<History />}
									label={t("sidebar.grouping.recent")}
									onClick={() =>
										void useSidebarPrefs.getState().setGrouping(grouping === "recent" ? "projects" : "recent")
									}
									pressed={grouping === "recent"}
									variant="ghost"
								/>
								<IconButton
									data-sidebar-open-project
									icon={<FolderPlus />}
									label={t("sidebar.project.newFolder")}
									onClick={() => void openProjectFolder()}
									variant="ghost"
								/>
							</>
						)}
					</div>
					<SearchField
						controlSize="sm"
						label={t("sidebar.filter")}
						onValueChange={setFilter}
						placeholder={t("sidebar.filterPlaceholder")}
						value={filter}
					/>
				</div>

				<div
					aria-label={t("sidebar.sessions")}
					data-tour="sessions"
					className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pb-2 [overflow-anchor:none]"
					onKeyDown={onListKeyDown}
					ref={listRef}
					role="group"
				>
					{hosts.length > 0 && <SidebarLocalHeader />}
					{!localFolded && (
						<>
							{listError &&
								(allSessions.length > 0 ? (
									<div
										className="mx-1 mb-2 flex flex-col items-start gap-1.5 rounded-(--sc-radius-md) bg-(--sc-danger-soft) px-2.5 py-2 text-sc-xs"
										role="alert"
									>
										<p className="flex items-center gap-1.5 font-medium text-(--sc-text)">
											<AlertTriangle
												aria-hidden
												className="size-(--sc-icon-sm) shrink-0 text-(--sc-danger)"
											/>
											{sessions.length > 0 ? t("sidebar.stale") : t("sidebar.loadFailed")}
										</p>
										<ErrorDetail error={listError} />
										<Button icon={<RefreshCw />} onClick={() => refresh(true)} size="sm" variant="ghost">
											{t("common.retry")}
										</Button>
									</div>
								) : (
									<EmptyState
										actions={
											<Button
												icon={<RefreshCw />}
												onClick={() => refresh(true)}
												size="sm"
												variant="secondary"
											>
												{t("common.retry")}
											</Button>
										}
										className="omp-sidebar-empty"
										description={<ErrorDetail error={listError} />}
										icon={<AlertTriangle />}
										size="sm"
										title={t("sidebar.loadFailed")}
									/>
								))}
							{isLoading && !listError && allSessions.length === 0 && (
								<SkeletonRows label={t("sidebar.loading")} widths={[72, 54, 64, 46]} />
							)}
							{!isLoading &&
								!listError &&
								totalCount === 0 &&
								(query ? (
									<EmptyState
										actions={
											<Button onClick={() => setFilter("")} size="sm" variant="ghost">
												{t("sidebar.clearFilter")}
											</Button>
										}
										className="omp-sidebar-empty"
										icon={<SearchX />}
										size="sm"
										title={t("sidebar.noMatch")}
									/>
								) : mode === "code" ? (
									<EmptyState
										actions={
											<>
												<Button
													icon={<FolderOpen />}
													onClick={() => setWorkspaceDialog("new-session")}
													size="sm"
													variant="secondary"
												>
													{t("sidebar.project.open")}
												</Button>
												{otherModeCount > 0 && (
													<Button
														data-sidebar-other-mode
														onClick={() => setMode("chat")}
														size="sm"
														variant="ghost"
													>
														{t("sidebar.otherMode.showChat")}
													</Button>
												)}
											</>
										}
										className="omp-sidebar-empty"
										description={
											otherModeCount > 0 ? (
												<>
													{t("sidebar.emptyCodeHint")}{" "}
													{t("sidebar.otherMode.chat", { count: otherModeCount })}
												</>
											) : (
												t("sidebar.emptyCodeHint")
											)
										}
										icon={<SquareTerminal />}
										size="sm"
										title={t("sidebar.emptyCode")}
									/>
								) : (
									<EmptyState
										actions={
											<>
												<Button
													icon={<MessageSquarePlus />}
													onClick={startChat}
													size="sm"
													variant="secondary"
												>
													{t("sidebar.menu.newChat")}
												</Button>
												{otherModeCount > 0 && (
													<Button
														data-sidebar-other-mode
														onClick={() => setMode("code")}
														size="sm"
														variant="ghost"
													>
														{t("sidebar.otherMode.showCode")}
													</Button>
												)}
											</>
										}
										className="omp-sidebar-empty"
										description={
											otherModeCount > 0 ? (
												<>
													{t("sidebar.emptyChatHint")}{" "}
													{t("sidebar.otherMode.code", { count: otherModeCount })}
												</>
											) : (
												t("sidebar.emptyChatHint")
											)
										}
										icon={<MessageCircle />}
										size="sm"
										title={t("sidebar.emptyChat")}
									/>
								))}
							{mode === "chat" && chatLaneSessions.length > 0 && (
								<div className="space-y-px" data-chat-lane>
									{chatLaneSessions.map(session => renderSessionRow(session))}
								</div>
							)}
							{visibleGroups.length > 0 && (
								<DndContext
									collisionDetection={closestCenter}
									onDragEnd={onProjectDragEnd}
									sensors={projectSensors}
								>
									<SortableContext
										items={visibleGroups.map(group => group.cwd)}
										strategy={verticalListSortingStrategy}
									>
										{visibleGroups.map(renderGroup)}
									</SortableContext>
								</DndContext>
							)}
							{mode === "code" &&
								grouping === "recent" &&
								recentCodeSessions.length + recentFolded.length > 0 && (
									<div className="space-y-px" data-recent-lane>
										{recentCodeSessions.map(session => renderSessionRow(session, false, "recent"))}
										<SidebarLooseChildren
											foldKey="recent"
											opened={recentFolded.map(child => familyChildFor(child, false))}
										/>
									</div>
								)}
							{archivedRows.length > 0 && (
								<section className="mt-3" data-sidebar-archived ref={archivedRef}>
									<div
										className="group/head relative flex h-8 items-center rounded-(--sc-radius-md) hover:bg-(--sc-hover)"
										onContextMenu={event => setArchivedMenu(anchorFromEvent(event))}
									>
										<button
											aria-expanded={archivedOpen || query.length > 0}
											className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-(--sc-radius-md) pr-1 pl-2 text-left text-sc-sm font-medium text-(--sc-text-muted) outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--sc-focus-ring)"
											data-roving-item="archived"
											onClick={() => setArchivedOpen(!archivedOpen)}
											onFocus={() => setFocusKey("archived")}
											onKeyDown={event => {
												if (opensMenu(event)) {
													event.preventDefault();
													setArchivedMenu(anchorBelow(event.currentTarget));
												} else if (event.key === "ArrowRight" && !archivedOpen) {
													event.preventDefault();
													setArchivedOpen(true);
												} else if (event.key === "ArrowLeft" && archivedOpen) {
													event.preventDefault();
													setArchivedOpen(false);
												}
											}}
											tabIndex={-1}
											type="button"
										>
											{archivedOpen || query ? (
												<ChevronDown aria-hidden className="size-(--sc-icon-sm) shrink-0" />
											) : (
												<ChevronRight aria-hidden className="size-(--sc-icon-sm) shrink-0" />
											)}
											<Archive aria-hidden className="size-(--sc-icon-sm) shrink-0" />
											<span className="min-w-0 flex-1 truncate">
												{t("sidebar.archived", { count: archivedRows.length })}
											</span>
										</button>
										<span className="relative flex shrink-0 items-center pr-1">
											<IconButton
												className="pointer-events-none opacity-0 transition-opacity duration-(--sc-duration-fast) group-focus-within/head:pointer-events-auto group-focus-within/head:opacity-100 group-hover/head:pointer-events-auto group-hover/head:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"
												icon={<MoreHorizontal />}
												label={t("sidebar.archivedMenu")}
												onClick={event => setArchivedMenu(anchorBelow(event.currentTarget))}
												size="sm"
												tabIndex={-1}
											/>
										</span>
									</div>
									{(archivedOpen || query.length > 0) && (
										<div className="space-y-px" data-archived-list>
											{archivedRows.map(session => renderSessionRow(session, true, "archived"))}
										</div>
									)}
								</section>
							)}
						</>
					)}
					{hosts.map(host => (
						<SidebarDeviceSection host={host} key={host.deviceId} mode={mode} query={query} />
					))}
				</div>

				<SidebarUpdateCard />
				<StarterGuide projectOpened={codeSessions.length > 0} promptSent={listedSessions.length > 0} />
				<SidebarFooter />
				<div
					aria-hidden
					className="absolute inset-y-0 right-0 z-(--sc-z-raised) w-1 translate-x-1/2 cursor-col-resize transition-colors duration-(--sc-duration-fast) hover:bg-(--sc-accent-border) active:bg-(--sc-accent)"
					onPointerDown={startSidebarDrag}
					onPointerMove={onSidebarDrag}
					onPointerUp={endSidebarDrag}
					role="separator"
				/>
			</aside>
			<WorkspaceDialog
				intent={workspaceDialog ?? "switch"}
				onClose={() => setWorkspaceDialog(null)}
				open={workspaceDialog !== null}
				thisDevice
			/>

			{/* Project menu: rename (alias), new sessions, pin, delete. */}
			{groupMenu &&
				(() => {
					const groupHasBusySession = groupMenu.group.sessions.some(isSessionBusy);
					return (
						<ContextMenu
							ariaLabel={t("sidebar.groupMenu")}
							x={groupMenu.anchor.x}
							y={groupMenu.anchor.y}
							onClose={() => setGroupMenu(null)}
							items={[
								{
									id: "group-new-agent",
									label: t("sidebar.menu.newAgentHere"),
									icon: SquareTerminal,
									onSelect: () => {
										setGroupMenu(null);
										useUiStore.getState().closeDestination();
										void openTab({ cwd: groupMenu.group.newCwd });
									},
								},
								{
									id: "group-new-worktree",
									label: t("sidebar.menu.newWorktreeHere"),
									icon: GitBranchPlus,
									onSelect: () => {
										setGroupMenu(null);
										useUiStore.getState().openWorktreeDialog({ baseCwd: groupMenu.group.newCwd });
									},
								},
								{
									id: "group-rename",
									separatorBefore: true,
									label: t("sidebar.menu.rename"),
									icon: Pencil,
									onSelect: () => {
										setGroupRenameDraft(groupMenu.group.name);
										setRenamingGroupCwd(groupMenu.group.cwd);
										setGroupMenu(null);
									},
								},
								...(() => {
									const index = allGroups.findIndex(item => item.cwd === groupMenu.group.cwd);
									const move = (to: number) => {
										const target = allGroups[to];
										setGroupMenu(null);
										if (!target) return;
										void useSidebarPrefs.getState().setGroupOrder(
											reorderProjects(
												allGroups.map(item => item.cwd),
												groupMenu.group.cwd,
												target.cwd,
											),
										);
									};
									return [
										{
											id: "group-move-up",
											label: t("sidebar.menu.moveUp"),
											icon: ArrowUp,
											disabled: index <= 0,
											onSelect: () => move(index - 1),
										},
										{
											id: "group-move-down",
											label: t("sidebar.menu.moveDown"),
											icon: ArrowDown,
											disabled: index === -1 || index >= allGroups.length - 1,
											onSelect: () => move(index + 1),
										},
									];
								})(),
								{
									id: "group-pin",
									label: pinnedGroups.includes(groupMenu.group.cwd)
										? t("sidebar.menu.unpin")
										: t("sidebar.menu.pin"),
									icon: pinnedGroups.includes(groupMenu.group.cwd) ? PinOff : Pin,
									onSelect: () => {
										useSidebarPrefs.getState().toggleGroupPin(groupMenu.group.cwd);
										setGroupMenu(null);
									},
								},
								(() => {
									const archivable = groupMenu.group.sessions.filter(
										session => session.liveTabId === undefined && tabForSession(session) === undefined,
									);
									return {
										id: "group-archive-all",
										label: t("sidebar.menu.archiveAll"),
										icon: Archive,
										disabled: archivable.length === 0,
										disabledReason: t("sidebar.archiveAllNone"),
										onSelect: () => {
											setGroupMenu(null);
											setArchived(archivable, true);
										},
									};
								})(),
								{
									id: "group-delete",
									separatorBefore: true,
									label: t("common.delete"),
									icon: Trash2,
									danger: true,
									disabled: groupHasBusySession,
									disabledReason: t("sidebar.deleteGroupStreaming"),
									onSelect: () => {
										setPendingDelete({ kind: "group", group: groupMenu.group });
										setGroupMenu(null);
									},
								},
							]}
						/>
					);
				})()}

			{/* Session row menu, grouped: open variants · view (split, close) · rename, pin · delete. */}
			{sessionMenu &&
				(() => {
					const targetBusy = isSessionBusy(sessionMenu.session);
					const targetTab = tabForSession(sessionMenu.session);
					const { split } = useTabsStore.getState();
					const inSplit = targetTab && split && splitTabIds(split).includes(targetTab.id);
					const viewItems: ContextMenuItem[] = !targetTab
						? []
						: [
								...(targetTab.id !== activeTabId && !inSplit
									? (["right", "bottom"] as const).map(placement => ({
											id: `session-split-${placement}`,
											label: t(placement === "right" ? "tabs.menu.splitRight" : "tabs.menu.splitBottom"),
											icon: placement === "right" ? Columns2 : Rows2,
											onSelect: () => {
												setSessionMenu(null);
												useUiStore.getState().closeDestination();
												void useTabsStore.getState().splitTab(targetTab.id, placement);
											},
										}))
									: []),
								...(split
									? [
											{
												id: "session-unsplit",
												label: t("tabs.menu.removeSplit"),
												icon: PanelRightClose,
												onSelect: () => {
													setSessionMenu(null);
													void useTabsStore.getState().unsplit(targetTab.id);
												},
											},
										]
									: []),
								...(tabs.length > 1
									? [
											{
												id: "session-close-tab",
												label: t("sidebar.menu.closeSession"),
												icon: X,
												disabled: targetBusy,
												disabledReason: t("sidebar.menu.taskRunning"),
												onSelect: () => {
													setSessionMenu(null);
													performTabClose(targetTab);
												},
											},
										]
									: []),
							];
					const tabItems = viewItems.map((item, index) =>
						index === 0 ? { ...item, separatorBefore: true } : item,
					);
					return (
						<ContextMenu
							ariaLabel={sessionDisplayTitle(sessionMenu.session, t("sidebar.untitled"))}
							x={sessionMenu.anchor.x}
							y={sessionMenu.anchor.y}
							onClose={() => setSessionMenu(null)}
							items={[
								{
									id: "session-open",
									label: t("sidebar.menu.open"),
									icon: ChevronRight,
									onSelect: () => {
										setSessionMenu(null);
										openSession(sessionMenu.session);
									},
								},
								// File actions need a transcript on disk; live-only rows have none yet.
								...(sessionMenu.session.liveTabId === undefined
									? [
											{
												id: "session-open-tab",
												label: t("sidebar.menu.openNewTab"),
												icon: Plus,
												onSelect: () => {
													setSessionMenu(null);
													useUiStore.getState().closeDestination();
													void openTab({
														cwd: sessionMenu.session.cwd,
														kind: sessionMenu.session.kind ?? "agent",
														sessionPath: sessionMenu.session.path,
													});
												},
											},
											// An open session splits through its tab items below instead.
											...(targetTab === undefined
												? [
														{
															id: "session-open-split",
															label: t("sidebar.menu.openSplit"),
															icon: Columns2,
															onSelect: () => {
																setSessionMenu(null);
																void openSessionInSplit(sessionMenu.session);
															},
														},
													]
												: []),
											{
												id: "session-open-window",
												label: t("sidebar.openInNewWindow"),
												icon: ExternalLink,
												onSelect: () => {
													setSessionMenu(null);
													void openSessionInNewWindow(sessionMenu.session);
												},
											},
										]
									: []),
								...tabItems,
								...(sessionMenu.session.device === undefined
									? [
											{
												id: "session-agent-hidden",
												label: agentHidden.includes(sessionMenu.session.path)
													? t("sidebar.menu.showToAgents")
													: t("sidebar.menu.hideFromAgents"),
												icon: agentHidden.includes(sessionMenu.session.path) ? Eye : EyeOff,
												onSelect: () => {
													void useSidebarPrefs.getState().toggleAgentHidden(sessionMenu.session.path);
													setSessionMenu(null);
												},
											},
										]
									: []),
								...(sessionMenu.session.liveTabId === undefined
									? [
											{
												id: "session-rename",
												separatorBefore: true,
												label: t("sidebar.rename"),
												icon: Pencil,
												onSelect: () => {
													setSessionMenu(null);
													startRename(sessionMenu.session);
												},
											},
											{
												id: "session-pin",
												label: pinnedSessions.includes(sessionMenu.session.path)
													? t("sidebar.menu.unpin")
													: t("sidebar.menu.pin"),
												icon: pinnedSessions.includes(sessionMenu.session.path) ? PinOff : Pin,
												onSelect: () => {
													const pinned = !pinnedSessions.includes(sessionMenu.session.path);
													useSidebarPrefs.getState().toggleSessionPin(sessionMenu.session.path);
													setSessionMenu(null);
													void tabRpc.setSessionPinned(sessionMenu.session.id, pinned).then(response => {
														if (!response.success) {
															toast({ variant: "warning", message: t("sidebar.pinSyncFailed") });
														}
													});
												},
											},
											...(sessionMenu.session.kind === "chat"
												? []
												: [
														{
															id: "session-move",
															label: t("sidebar.menu.moveToProject"),
															icon: FolderInput,
															disabled: targetTab !== undefined,
															disabledReason: t("sidebar.moveOpenTab"),
															onSelect: () => {
																setMoveMenu(sessionMenu);
																setSessionMenu(null);
															},
														},
													]),
											archivedIds.has(sessionMenu.session.id) && targetTab === undefined
												? {
														id: "session-restore",
														label: t("sidebar.menu.restore"),
														icon: ArchiveRestore,
														onSelect: () => {
															setSessionMenu(null);
															setArchived([sessionMenu.session], false);
														},
													}
												: {
														id: "session-archive",
														label: t("sidebar.menu.archive"),
														icon: Archive,
														disabled: targetTab !== undefined,
														disabledReason: t("sidebar.archiveOpenTab"),
														onSelect: () => {
															setSessionMenu(null);
															setArchived([sessionMenu.session], true);
														},
													},
											{
												id: "session-copy-path",
												separatorBefore: true,
												label: t("sidebar.menu.copyPath"),
												icon: Copy,
												onSelect: () => {
													setSessionMenu(null);
													void copySessionPath(sessionMenu.session);
												},
											},
											{
												id: "session-reveal",
												label: t("sidebar.menu.reveal"),
												icon: FolderSearch,
												onSelect: () => {
													setSessionMenu(null);
													void revealSession(sessionMenu.session);
												},
											},
											{
												id: "session-delete",
												separatorBefore: true,
												label: t("common.delete"),
												icon: Trash2,
												danger: true,
												disabled: targetBusy,
												disabledReason: t("sidebar.menu.taskRunning"),
												onSelect: () => {
													setPendingDelete({ kind: "session", session: sessionMenu.session });
													setSessionMenu(null);
												},
											},
										]
									: []),
							]}
						/>
					);
				})()}

			{/* Move to project: every other project in the list, then any folder. */}
			{moveMenu && (
				<ContextMenu
					ariaLabel={t("sidebar.menu.moveToProject")}
					x={moveMenu.anchor.x}
					y={moveMenu.anchor.y}
					onClose={() => setMoveMenu(null)}
					items={[
						...allGroups
							.filter(group => group.cwd !== moveMenu.session.cwd)
							.map(group => ({
								id: `move-${group.cwd}`,
								label: group.name,
								icon: Folder,
								onSelect: () => void moveStoredSession(moveMenu.session, group.cwd),
							})),
						{
							id: "move-other",
							separatorBefore: true,
							label: t("sidebar.move.otherFolder"),
							icon: FolderOpen,
							onSelect: () => void moveToOtherFolder(moveMenu.session),
						},
					]}
				/>
			)}

			{archivedMenu && (
				<ContextMenu
					ariaLabel={t("sidebar.archivedMenu")}
					x={archivedMenu.x}
					y={archivedMenu.y}
					onClose={() => setArchivedMenu(null)}
					items={[
						{
							id: "archived-restore-all",
							label: t("sidebar.menu.restoreAll"),
							icon: ArchiveRestore,
							onSelect: () => {
								setArchivedMenu(null);
								setArchived(archivedRows, false);
							},
						},
						{
							id: "archived-delete-all",
							separatorBefore: true,
							label: t("sidebar.menu.deleteArchived"),
							icon: Trash2,
							danger: true,
							onSelect: () => {
								setArchivedMenu(null);
								setPendingDelete({ kind: "archived", sessions: archivedRows });
							},
						},
					]}
				/>
			)}

			<ConfirmDialog
				open={pendingDelete !== null}
				title={
					pendingDelete?.kind === "group"
						? t("sidebar.deleteGroupConfirm")
						: pendingDelete?.kind === "archived"
							? t("sidebar.deleteArchivedConfirm")
							: t("sidebar.deleteConfirm")
				}
				message={
					pendingDelete?.kind === "group"
						? t("sidebar.deleteGroupMessage", {
								name: pendingDelete.group.name,
								count: pendingDelete.group.sessions.filter(session => session.liveTabId === undefined).length,
							})
						: pendingDelete?.kind === "archived"
							? t("sidebar.deleteArchivedMessage", { count: pendingDelete.sessions.length })
							: pendingDelete?.kind === "session"
								? t("sidebar.deleteMessage", {
										name: sessionDisplayTitle(pendingDelete.session, t("sidebar.untitled")),
									})
								: ""
				}
				warning={pendingDelete && pendingDelete.kind !== "session" ? t("sidebar.deleteGroupWarning") : undefined}
				busy={deleting}
				onConfirm={() => {
					if (pendingDelete?.kind === "group") void confirmDeleteGroup(pendingDelete.group);
					else if (pendingDelete?.kind === "archived") void confirmDeleteArchived(pendingDelete.sessions);
					else if (pendingDelete) void confirmDeleteSession(pendingDelete.session);
				}}
				onCancel={() => setPendingDelete(null)}
			/>
		</>
	);
}
