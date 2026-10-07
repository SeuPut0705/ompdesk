import { closestCenter, DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
	AlertTriangle,
	ArrowDown,
	ArrowUp,
	BarChart3,
	Bot,
	ChevronDown,
	ChevronRight,
	CircleHelp,
	Columns2,
	Compass,
	ExternalLink,
	Folder,
	FolderOpen,
	FolderPlus,
	GitBranchPlus,
	Info,
	Keyboard,
	MessageCircle,
	MessageSquarePlus,
	MessageSquareWarning,
	MoreHorizontal,
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
	XCircle,
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
} from "react";
import type { SessionInfo } from "../../../shared/ipc-types";
import { useAwaitingConfirmation } from "../../hooks/use-awaiting-confirmation";
import { useSessionList } from "../../hooks/use-session-list";
import { dropSessionNow, requestSessionSwitch } from "../../hooks/use-session-switch";
import { errorDetail } from "../../lib/error-detail";
import { basename, cx, formatTimeAgo } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { actionKbd, onEscape } from "../../lib/keymap";
import { orderProjects, reorderProjects } from "../../lib/project-order";
import { sessionDisplayTitle } from "../../lib/session-title";
import { performTabClose } from "../../lib/tab-close";
import { useTabRpc } from "../../lib/tab-rpc";
import { tabSignalPresentation } from "../../lib/tab-signal";
import { pickWorkspaceDirectory } from "../../lib/workspace-dirs";
import { useComposerStore } from "../../stores/composer";
import { useMessagesStore } from "../../stores/messages";
import { useQueueStore } from "../../stores/queue";
import { type SessionStore, useSessionStore } from "../../stores/session";
import { sessionRuntimeStore } from "../../stores/session-runtime-context";
import { useSidebarPrefs } from "../../stores/sidebar-prefs";
import { useTabsStore } from "../../stores/tabs";
import { toast } from "../../stores/toast";
import { type PageDestination, useUiStore } from "../../stores/ui";
import {
	Badge,
	BrandMark,
	Button,
	type ContextMenuItem,
	EmptyState,
	IconButton,
	Input,
	Kbd,
	ListRow,
	MenuButton,
	SearchField,
	Spinner,
	Tabs,
} from "../common";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { anchorFromEvent, ContextMenu, type ContextMenuAnchor } from "../common/ContextMenu";
import { WorkspaceDialog } from "../dialogs/WorkspaceDialog";
import { SidebarSubagents } from "./SidebarSubagents";
import { SidebarUpdateCard } from "./SidebarUpdateCard";

/**
 * A sidebar row: an indexed session, or one synthesized from an open tab the
 * global index has not listed yet (a brand-new or still-empty session). The
 * sidebar is the only session navigator, so every open tab keeps a row.
 * Live-only rows (`liveTabId` set) have no transcript file yet: nothing to
 * rename, pin, or delete.
 */
type SidebarSession = SessionInfo & { liveTabId?: string };

interface WorkspaceGroup {
	cwd: string;
	name: string;
	sessions: SidebarSession[];
}

/** A delete the row or context menu queued, awaiting the confirmation dialog. */
type PendingDelete = { kind: "session"; session: SidebarSession } | { kind: "group"; group: WorkspaceGroup };

/**
 * Sidebar lanes. Code: project sessions grouped by folder. Chat: conversations
 * without a project — tool-free chats plus agent sessions started in the
 * GUI's default folder.
 */
type SidebarMode = "code" | "chat";

/** Floor for the docked column: the sidebar never folds on its own, so this is what a narrow window keeps. */
const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 420;
const SIDEBAR_DEFAULT = 248;

function modifiedAt(session: SessionInfo): number {
	const timestamp = Date.parse(session.modified);
	return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * The focused tab is still the untouched landing surface: no transcript, no
 * draft, nothing queued or running. Opening a session or a project there
 * replaces it instead of leaving an empty tab behind.
 */
function activeTabUntouched(): boolean {
	const tabs = useTabsStore.getState();
	const tab = tabs.tabs.find(entry => entry.id === tabs.activeTabId);
	if (!tab || tab.worktree || tab.status === "running" || tab.compacting) return false;
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
	requestAnimationFrame(() =>
		document.querySelector<HTMLTextAreaElement>('.omp-session-pane[data-active="true"] textarea')?.focus(),
	);
}

/** Destinations in the sidebar footer (design-spec §2.1): the only three. */
const DESTINATIONS: { id: PageDestination; labelKey: string; icon: typeof Bot }[] = [
	{ id: "agents", labelKey: "destination.agents", icon: Bot },
	{ id: "insights", labelKey: "destination.insights", icon: BarChart3 },
	{ id: "settings", labelKey: "destination.settings", icon: Settings },
];

function useHelpItems(): ContextMenuItem[] {
	const t = useT();
	const keymapOverrides = useUiStore(s => s.keymapOverrides);
	return [
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
			onSelect: () => useUiStore.getState().openSettings("features"),
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

/** Footer: Agents · Stats · Settings, with the help menu closing the Settings row. */
function SidebarFooter() {
	const t = useT();
	const destination = useUiStore(s => s.destination);
	const keymapOverrides = useUiStore(s => s.keymapOverrides);
	const helpItems = useHelpItems();
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
			{DESTINATIONS.map(({ id, labelKey, icon: Icon }) => {
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
 * Sessions-first sidebar (design-spec §2.1) and the app's only session
 * navigator: Code/Work lanes, New session, a filter, sessions grouped by
 * project (newest first, status as icon + text; every open tab keeps a row),
 * and a footer with the three destinations plus help.
 */
export function Sidebar() {
	const tabRpc = useTabRpc();
	const t = useT();
	const keymapOverrides = useUiStore(state => state.keymapOverrides);
	const [mode, setMode] = useState<SidebarMode>("code");
	const [defaultWorkspace, setDefaultWorkspace] = useState<string | null>(null);
	const [filter, setFilter] = useState("");
	const switchPendingTo = useSessionStore(s => s.switchPending?.toId ?? null);
	// Resizable docked column; the width persists like every other chrome pref.
	const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
	const sidebarWidthRef = useRef(SIDEBAR_DEFAULT);
	useEffect(() => {
		void window.omp.prefs
			.get("sidebarWidth")
			.then(value => {
				if (typeof value !== "number" || !Number.isFinite(value)) return;
				const clamped = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, value));
				sidebarWidthRef.current = clamped;
				setSidebarWidth(clamped);
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
		const clamped = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, e.clientX - hostRect.left));
		sidebarWidthRef.current = clamped;
		setSidebarWidth(clamped);
	}, []);
	const endSidebarDrag = useCallback(() => {
		sidebarDragging.current = false;
		void window.omp.prefs.set("sidebarWidth", sidebarWidthRef.current).catch(() => {});
	}, []);
	const [deleting, setDeleting] = useState(false);
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
	// Deleting a session hard-deletes its transcript file, so the row and menu
	// clicks only queue it: the dialog names the target and states the
	// consequence before anything is removed.
	const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
	const [renamingSessionPath, setRenamingSessionPath] = useState<string | null>(null);
	const [workspaceDialog, setWorkspaceDialog] = useState<"switch" | "new-session" | null>(null);
	const [renameDraft, setRenameDraft] = useState("");
	const [groupMenu, setGroupMenu] = useState<{ anchor: ContextMenuAnchor; group: WorkspaceGroup } | null>(null);
	const [sessionMenu, setSessionMenu] = useState<{ anchor: ContextMenuAnchor; session: SidebarSession } | null>(null);
	// Project display alias rename (group header inline input).
	const [renamingGroupCwd, setRenamingGroupCwd] = useState<string | null>(null);
	const [groupRenameDraft, setGroupRenameDraft] = useState("");
	// Roving focus: the session list is one tab stop; arrows move inside it.
	const [focusKey, setFocusKey] = useState<string | null>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const openTab = useTabsStore(s => s.openTab);
	const tabs = useTabsStore(s => s.tabs);
	const activeTabId = useTabsStore(s => s.activeTabId);
	const activeTab = tabs.find(tab => tab.id === activeTabId);
	const activeTabKind = activeTab?.kind;
	const pinnedGroups = useSidebarPrefs(s => s.pinnedGroups);
	const groupOrder = useSidebarPrefs(s => s.groupOrder);
	const pinnedSessions = useSidebarPrefs(s => s.pinnedSessions);
	const groupAliases = useSidebarPrefs(s => s.groupAliases);
	const { sessions, isLoading, error: listError, refresh, deleteSession, renameSession } = useSessionList("global");
	const sessionId = useSessionStore(s => s.sessionId);
	const sessionName = useSessionStore(s => s.sessionName);
	const sessionFile = useSessionStore(s => s.sessionFile);
	const cwd = useSessionStore(s => s.cwd);
	const isStreaming = useSessionStore(s => s.isStreaming);
	const isCompacting = useSessionStore(s => s.isCompacting);
	const destination = useUiStore(s => s.destination);
	// A blocking confirmation (plan approval / ask / permission) on the
	// attached session outranks "running": it needs the user, not just time.
	const awaitingConfirmation = useAwaitingConfirmation();

	useEffect(() => {
		void window.omp.sidecar
			.defaultWorkspace()
			.then(workspace => {
				setDefaultWorkspace(workspace);
				const tabState = useTabsStore.getState();
				const activeKind = tabState.tabs.find(tab => tab.id === tabState.activeTabId)?.kind;
				if (activeKind === "chat" || useSessionStore.getState().cwd === workspace) setMode("chat");
			})
			.catch(() => {});
	}, []);

	// Opening a session from search or the palette keeps the lane honest.
	useEffect(() => {
		if (!defaultWorkspace || !cwd) return;
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
	// Sessions sort by their last real activity (the transcript file's mtime),
	// never by when they were last clicked, so opening a row keeps its place.
	const byPinThenRecency = useCallback(
		(a: SessionInfo, b: SessionInfo) => {
			const aPinned = pinnedSessions.includes(a.path) ? 0 : 1;
			const bPinned = pinnedSessions.includes(b.path) ? 0 : 1;
			if (aPinned !== bPinned) return aPinned - bPinned;
			return modifiedAt(b) - modifiedAt(a);
		},
		[pinnedSessions],
	);
	// Every open tab keeps a row even before the index lists its session (a
	// brand-new session has no file yet): synthesize it from the tab and, for
	// the focused tab, the attached session's live identity.
	const liveSessions = useMemo<SidebarSession[]>(() => {
		const listedIds = new Set(sessions.map(session => session.id));
		const listedPaths = new Set(sessions.map(session => session.path));
		const now = new Date().toISOString();
		const rows: SidebarSession[] = [];
		for (const tab of tabs) {
			const focused = tab.id === activeTabId;
			const id = (focused ? sessionId : "") || tab.sessionId || "";
			const path = (focused ? sessionFile : null) ?? tab.sessionPath ?? "";
			if ((id && listedIds.has(id)) || (path && listedPaths.has(path))) continue;
			rows.push({
				path: path || `tab:${tab.id}`,
				id: id || `tab:${tab.id}`,
				title: tab.title ?? (focused ? sessionName : null),
				cwd: tab.cwd || (focused ? cwd : ""),
				created: now,
				modified: now,
				messageCount: 0,
				size: 0,
				status: "unknown",
				...(tab.kind === "chat" ? { kind: "chat" as const } : {}),
				firstMessage: "",
				liveTabId: tab.id,
			});
		}
		return rows;
	}, [sessions, tabs, activeTabId, sessionId, sessionFile, sessionName, cwd]);
	const allSessions = useMemo<SidebarSession[]>(
		() => (liveSessions.length === 0 ? sessions : [...sessions, ...liveSessions]),
		[sessions, liveSessions],
	);
	const agentSessions = useMemo(() => allSessions.filter(session => session.kind !== "chat"), [allSessions]);
	const codeSessions = useMemo(
		() => agentSessions.filter(session => !defaultWorkspace || session.cwd !== defaultWorkspace),
		[agentSessions, defaultWorkspace],
	);
	// Chat lane: tool-free chats and no-project sessions, one recency-ordered list.
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
		const byCwd = new Map<string, SidebarSession[]>();
		for (const session of codeSessions) {
			const list = byCwd.get(session.cwd) ?? [];
			list.push(session);
			byCwd.set(session.cwd, list);
		}
		const result: WorkspaceGroup[] = [...byCwd.entries()].map(([groupCwd, groupSessions]) => ({
			cwd: groupCwd,
			name: groupAliases[groupCwd] ?? (basename(groupCwd) || groupCwd),
			sessions: groupSessions.toSorted(byPinThenRecency),
		}));
		return orderProjects(result, {
			pinned: pinnedGroups,
			manual: groupOrder,
			recency: group => Math.max(...group.sessions.map(modifiedAt)),
		});
	}, [codeSessions, groupAliases, pinnedGroups, groupOrder, byPinThenRecency]);
	const groups = useMemo(
		() =>
			query
				? allGroups
						.map(group => ({
							...group,
							sessions: group.name.toLocaleLowerCase().includes(query)
								? group.sessions
								: group.sessions.filter(matchesFilter),
						}))
						.filter(group => group.sessions.length > 0)
				: allGroups,
		[allGroups, matchesFilter, query],
	);
	const totalCount = mode === "chat" ? chatLaneSessions.length : groups.length;
	// An empty lane must not read as "no sessions at all" while the other lane
	// holds some (e.g. the open code session while 채팅 is selected).
	const codeTotal = codeSessions.length;
	const otherModeCount = mode === "chat" ? codeTotal : allSessions.length - codeTotal;
	const visibleGroups = mode === "code" ? groups : [];
	// Projects with an open tab start expanded so every open session is in view.
	const openTabCwds = useMemo(() => new Set(tabs.filter(tab => tab.kind !== "chat").map(tab => tab.cwd)), [tabs]);

	const isCollapsed = (groupCwd: string) => {
		// A filter shows every match.
		if (query) return false;
		if (groupCwd in collapsed) return collapsed[groupCwd];
		// Default: the current project and projects with open tabs expanded, others collapsed.
		return groupCwd !== cwd && !openTabCwds.has(groupCwd);
	};
	const toggleGroup = (groupCwd: string) => {
		setCollapsed(prev => ({ ...prev, [groupCwd]: !isCollapsed(groupCwd) }));
	};
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
	const isCurrentSession = (session: SidebarSession) =>
		session.id === sessionId || (session.liveTabId !== undefined && session.liveTabId === activeTabId);
	const tabForSession = (session: SidebarSession) =>
		(session.liveTabId ? tabs.find(tab => tab.id === session.liveTabId) : undefined) ??
		tabs.find(tab => tab.sessionId === session.id) ??
		(isCurrentSession(session) ? activeTab : undefined);
	const sessionTabSignal = (session: SidebarSession) => {
		const tab = tabForSession(session);
		return tab ? tabSignalPresentation(tab, isCurrentSession(session) && (isStreaming || isCompacting)) : null;
	};
	const isSessionBusy = (session: SidebarSession) => {
		if (isCurrentSession(session) && awaitingConfirmation) return true;
		const signal = sessionTabSignal(session);
		if (signal) return signal.active;
		if (isCurrentSession(session) && (isStreaming || isCompacting)) return true;
		return session.status === "pending";
	};

	const openSession = (session: SidebarSession) => {
		useUiStore.getState().closeDestination();
		if (isCurrentSession(session)) return;
		// Already open in a tab: go there. An untouched empty tab is replaced
		// instead of left behind; anything else keeps its tab and the session
		// opens next to it.
		const owner = tabs.find(
			tab => tab.id === session.liveTabId || tab.sessionId === session.id || tab.sessionPath === session.path,
		);
		if (owner) {
			void useTabsStore.getState().switchTab(owner.id);
			return;
		}
		if (activeTabUntouched()) {
			requestSessionSwitch(session);
			return;
		}
		void openTab({ cwd: session.cwd, sessionPath: session.path, kind: session.kind ?? "agent" });
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
			toast({
				variant: "error",
				title: t("titlebar.openProjectFailed"),
				message: t("toast.failedRetry"),
				detail: errorDetail(error),
			});
		}
	};
	// Explicit parallel action: open this session in a NEW window with its own
	// sidecar, leaving the current window's running session untouched.
	const openSessionInNewWindow = async (session: SessionInfo) => {
		const ok = await window.omp.sessions.openInNewWindow({ sessionPath: session.path, cwd: session.cwd });
		if (!ok) {
			toast({ variant: "warning", message: t("sidebar.parallelCap") });
			return;
		}
	};

	const startRename = (session: SessionInfo) => {
		setRenameDraft(session.title || session.firstMessage || "");
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
			.catch(error =>
				toast({
					variant: "error",
					title: t("sidebar.renameFailed"),
					message: t("toast.failedRetry"),
					detail: errorDetail(error),
				}),
			);
	};

	const confirmDeleteSession = async (session: SessionInfo) => {
		if (isSessionBusy(session)) {
			toast({ variant: "warning", message: t("sidebar.menu.taskRunning") });
			setPendingDelete(null);
			return;
		}
		setDeleting(true);
		try {
			if (session.id === sessionId) {
				await dropSessionNow();
			} else {
				await deleteSession(session.path);
			}
			setPendingDelete(null);
		} catch (error) {
			toast({
				variant: "error",
				title: t("sidebar.deleteFailed"),
				message: t("toast.failedRetry"),
				detail: errorDetail(error),
			});
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
			const tabsStore = useTabsStore.getState();
			const projectTabs = tabsStore.tabs.filter(
				tab =>
					tab.kind !== "chat" &&
					(tab.cwd === group.cwd ||
						(tab.sessionPath !== undefined && paths.has(tab.sessionPath)) ||
						(tab.sessionId !== undefined && ids.has(tab.sessionId))),
			);
			// The window keeps at least one tab: give it a home outside this project.
			if (projectTabs.length > 0 && projectTabs.length === tabsStore.tabs.length) {
				const fallback = allGroups.find(item => item.cwd !== group.cwd)?.cwd;
				if (!(await tabsStore.openTab(fallback ? { cwd: fallback } : { work: true }))) return;
			}
			for (const tab of projectTabs) {
				// eslint-disable-next-line no-await-in-loop -- each close switches the active tab
				await useTabsStore.getState().closeTab(tab.id);
			}
			// Then delete every session file in the project. Live-only rows have no file.
			for (const session of group.sessions.filter(entry => entry.liveTabId === undefined)) {
				// eslint-disable-next-line no-await-in-loop -- sequential, keep FS load bounded
				await deleteSession(session.path);
			}
			setPendingDelete(null);
		} catch (error) {
			toast({
				variant: "error",
				title: t("sidebar.deleteFailed"),
				message: t("toast.failedRetry"),
				detail: errorDetail(error),
			});
		} finally {
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
		items[next]?.focus();
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

	const renderSessionRow = (session: SidebarSession, nested = false) => {
		const key = `session:${session.path}`;
		const isCurrent = isCurrentSession(session);
		const active = isCurrent && destination === "session";
		const indexed = session.liveTabId === undefined;
		const tab = tabForSession(session);
		const tabSignal = sessionTabSignal(session);
		const waiting = isCurrent && awaitingConfirmation;
		const running = !waiting && (tabSignal?.running === true || (tabSignal === null && isSessionBusy(session)));
		const failed =
			!waiting &&
			!running &&
			(tabSignal ? tabSignal.labelKey === "titlebar.status.error" : session.status === "error");
		const done = !waiting && !running && !failed && tabSignal?.labelKey === "tabs.done";
		const openElsewhere = tab !== undefined && !isCurrent;
		const busy = waiting || running || tabSignal?.active === true;
		const statusLabel = waiting
			? t("sidebar.row.needsApproval")
			: running
				? t("sidebar.signal.running")
				: failed
					? t("sidebar.row.failed")
					: done
						? t("tabs.done")
						: openElsewhere
							? t("sidebar.row.open")
							: null;
		const title = sessionDisplayTitle(session, indexed ? t("sidebar.untitled") : t("sidebar.newSession"));
		const pinned = pinnedSessions.includes(session.path);
		// Renaming is safe mid-run (stock applies it live); deleting is not.
		const deletable = indexed && !busy;
		const tabIndex = -1;
		if (renamingSessionPath === session.path) {
			return (
				<div className={cx("py-0.5 pr-1", nested ? "pl-5.5" : "pl-1")} key={session.path}>
					<Input
						aria-label={t("sidebar.rename")}
						autoFocus
						controlSize="sm"
						onBlur={event => commitRename(session, event.currentTarget.value)}
						onChange={event => setRenameDraft(event.target.value)}
						onFocus={event => event.currentTarget.select()}
						onKeyDown={event => {
							if (isImeKeyEvent(event)) return;
							if (event.key === "Enter") commitRename(session, event.currentTarget.value);
							onEscape(event, () => setRenamingSessionPath(null));
						}}
						value={renameDraft}
					/>
				</div>
			);
		}
		const leading: ReactNode = waiting ? (
			<AlertTriangle aria-hidden className="text-(--sc-warning)" />
		) : running ? (
			<span aria-hidden className="inline-flex">
				<Spinner size="sm" />
			</span>
		) : failed ? (
			<XCircle aria-hidden className="text-(--sc-danger)" />
		) : session.kind === "chat" && !done ? (
			<MessageCircle aria-hidden data-sidebar-session-icon />
		) : pinned && !done ? (
			<Pin aria-label={t("sidebar.pinned")} />
		) : (
			<span aria-hidden className="flex size-(--sc-icon-md) items-center justify-center" data-sidebar-session-icon>
				{done ? (
					<span className="size-2 rounded-(--sc-radius-full) bg-(--sc-success)" data-sidebar-done />
				) : (
					openElsewhere && (
						<span className="size-1.5 rounded-(--sc-radius-full) bg-(--sc-text-subtle)" data-sidebar-open-tab />
					)
				)}
			</span>
		);
		const openTabId = tab?.id;
		return (
			<Fragment key={session.path}>
				<ListRow
					actions={
						indexed ? (
							<>
								<IconButton
									icon={<Pencil />}
									label={t("sidebar.rename")}
									onClick={() => startRename(session)}
									size="sm"
									tabIndex={-1}
								/>
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
							}
						},
					}}
					className={cx("omp-sidebar-session-row", nested && "pl-5.5")}
					leading={leading}
					meta={
						waiting ? (
							<Badge variant="warning">{t("sidebar.row.needsApproval")}</Badge>
						) : indexed ? (
							<time className="text-(--sc-text-subtle)" dateTime={session.modified}>
								{formatTimeAgo(session.modified)}
							</time>
						) : undefined
					}
					onClick={() => openSession(session)}
					rowProps={{
						draggable: openTabId !== undefined && !isCurrent,
						onDragStart: event => {
							if (!openTabId) return;
							event.dataTransfer.effectAllowed = "move";
							window.dispatchEvent(new CustomEvent("omp:tab-drag", { detail: { tabId: openTabId } }));
						},
						onDragEnd: () => window.dispatchEvent(new CustomEvent("omp:tab-drag", { detail: { tabId: null } })),
						onContextMenu: event => setSessionMenu({ anchor: anchorFromEvent(event), session }),
						"data-active": active,
						"data-current": isCurrent || undefined,
						"data-live": indexed ? undefined : true,
						"data-switch-pending": switchPendingTo === session.id || undefined,
						"data-session-kind": session.kind ?? "agent",
						"data-session-path": session.path,
					}}
					selected={active}
					title={
						<>
							{title}
							{statusLabel && <span className="sr-only">, {statusLabel}</span>}
						</>
					}
					titleText={title}
				/>
				{openTabId && <SidebarSubagents nested={nested} sessionKey={session.path} tabId={openTabId} />}
			</Fragment>
		);
	};

	const renderGroup = (group: WorkspaceGroup) => {
		const key = `group:${group.cwd}`;
		const groupCollapsed = isCollapsed(group.cwd);
		const isCurrentProject = group.cwd === cwd && activeTabKind !== "chat";
		const tabIndex = -1;
		const pinned = pinnedGroups.includes(group.cwd);
		// A collapsed project still says when something inside it is working.
		const groupBusy = groupCollapsed && group.sessions.some(isSessionBusy);
		const FolderIcon = groupCollapsed ? Folder : FolderOpen;
		return (
			<SortableProject disabled={query.length > 0 || renamingGroupCwd !== null} id={group.cwd} key={group.cwd}>
				{dragHandle => (
					<>
						<div
							className="group/head relative flex h-8 cursor-default items-center rounded-(--sc-radius-md) hover:bg-(--sc-hover)"
							data-workspace-group={group.cwd}
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
												useSidebarPrefs.getState().setGroupAlias(group.cwd, groupRenameDraft);
												setRenamingGroupCwd(null);
											}
											onEscape(event, () => setRenamingGroupCwd(null));
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
									onClick={() => toggleGroup(group.cwd)}
									onFocus={() => setFocusKey(key)}
									onKeyDown={event => {
										if (opensMenu(event)) {
											event.preventDefault();
											setGroupMenu({ anchor: anchorBelow(event.currentTarget), group });
										} else if (event.key === "ArrowRight" && groupCollapsed) {
											event.preventDefault();
											toggleGroup(group.cwd);
										} else if (event.key === "ArrowLeft" && !groupCollapsed) {
											event.preventDefault();
											toggleGroup(group.cwd);
										}
									}}
									tabIndex={tabIndex}
									title={group.cwd}
									type="button"
								>
									{groupCollapsed ? (
										<ChevronRight aria-hidden className="size-(--sc-icon-sm) shrink-0" />
									) : (
										<ChevronDown aria-hidden className="size-(--sc-icon-sm) shrink-0" />
									)}
									<FolderIcon
										aria-hidden
										className="size-(--sc-icon-sm) shrink-0"
										data-sidebar-workspace-icon
									/>
									<span className="min-w-0 flex-1 truncate">{group.name}</span>
									{pinned && <Pin aria-label={t("sidebar.pinned")} className="size-3 shrink-0" />}
									{groupBusy && (
										<span className="flex shrink-0 items-center">
											<span aria-hidden className="inline-flex">
												<Spinner size="sm" />
											</span>
											<span className="sr-only">, {t("sidebar.signal.running")}</span>
										</span>
									)}
								</button>
							)}
							{renamingGroupCwd !== group.cwd && (
								<span className="flex shrink-0 items-center gap-0.5 pr-1">
									<IconButton
										className="pointer-events-none opacity-0 transition-opacity duration-(--sc-duration-fast) group-focus-within/head:pointer-events-auto group-focus-within/head:opacity-100 group-hover/head:pointer-events-auto group-hover/head:opacity-100"
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
											void openTab({ cwd: group.cwd });
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

				<div className="flex shrink-0 flex-col gap-2 px-2 pt-1 pb-2">
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
							variant="secondary"
						>
							<span className="min-w-0 flex-1 truncate text-left">
								{mode === "chat" ? t("sidebar.newChat") : t("sidebar.newSession")}
							</span>
						</Button>
						{mode === "code" && (
							<IconButton
								data-sidebar-open-project
								icon={<FolderPlus />}
								label={t("sidebar.project.newFolder")}
								onClick={() => void openProjectFolder()}
								variant="secondary"
							/>
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
					className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pb-2 [overflow-anchor:none]"
					onKeyDown={onListKeyDown}
					ref={listRef}
					role="group"
				>
					{listError &&
						(allSessions.length > 0 ? (
							<div
								className="mx-1 mb-2 flex flex-col items-start gap-1.5 rounded-(--sc-radius-md) bg-(--sc-danger-soft) px-2.5 py-2 text-sc-xs"
								role="alert"
							>
								<p className="flex items-center gap-1.5 font-medium text-(--sc-text)">
									<AlertTriangle aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-danger)" />
									{sessions.length > 0 ? t("sidebar.stale") : t("sidebar.loadFailed")}
								</p>
								<p className="break-words text-(--sc-text-muted)">{listError}</p>
								<Button icon={<RefreshCw />} onClick={() => refresh(true)} size="sm" variant="ghost">
									{t("common.retry")}
								</Button>
							</div>
						) : (
							<EmptyState
								actions={
									<Button icon={<RefreshCw />} onClick={() => refresh(true)} size="sm" variant="secondary">
										{t("common.retry")}
									</Button>
								}
								className="omp-sidebar-empty"
								description={<span className="break-words">{listError}</span>}
								icon={<AlertTriangle />}
								size="sm"
								title={t("sidebar.loadFailed")}
							/>
						))}
					{isLoading && !listError && allSessions.length === 0 && (
						<div aria-label={t("sidebar.loading")} className="space-y-px" role="status">
							{[72, 54, 64, 46].map(width => (
								<div aria-hidden className="flex h-8 items-center gap-2.5 px-2.5" key={width}>
									<span className="size-3.5 shrink-0 rounded-(--sc-radius-xs) bg-(--sc-surface-3) motion-safe:animate-pulse" />
									<span
										className="h-2.5 rounded-(--sc-radius-full) bg-(--sc-surface-3) motion-safe:animate-pulse"
										style={{ width: `${width}%` }}
									/>
								</div>
							))}
						</div>
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
								description={t("sidebar.noMatchHint")}
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
											{t("sidebar.emptyCodeHint")} {t("sidebar.otherMode.chat", { count: otherModeCount })}
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
										<Button icon={<MessageSquarePlus />} onClick={startChat} size="sm" variant="secondary">
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
											{t("sidebar.emptyChatHint")} {t("sidebar.otherMode.code", { count: otherModeCount })}
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
						<DndContext collisionDetection={closestCenter} onDragEnd={onProjectDragEnd} sensors={projectSensors}>
							<SortableContext
								items={visibleGroups.map(group => group.cwd)}
								strategy={verticalListSortingStrategy}
							>
								{visibleGroups.map(renderGroup)}
							</SortableContext>
						</DndContext>
					)}
				</div>

				<SidebarUpdateCard />
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
										void openTab({ cwd: groupMenu.group.cwd });
									},
								},
								{
									id: "group-new-worktree",
									label: t("sidebar.menu.newWorktreeHere"),
									icon: GitBranchPlus,
									onSelect: () => {
										setGroupMenu(null);
										useUiStore.getState().openWorktreeDialog({ baseCwd: groupMenu.group.cwd });
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
					const inSplit =
						targetTab && split && (split.firstTabId === targetTab.id || split.secondTabId === targetTab.id);
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

			<ConfirmDialog
				open={pendingDelete !== null}
				title={pendingDelete?.kind === "group" ? t("sidebar.deleteGroupConfirm") : t("sidebar.deleteConfirm")}
				message={
					pendingDelete?.kind === "group"
						? t("sidebar.deleteGroupMessage", {
								name: pendingDelete.group.name,
								count: pendingDelete.group.sessions.filter(session => session.liveTabId === undefined).length,
							})
						: pendingDelete?.kind === "session"
							? t("sidebar.deleteMessage", {
									name: sessionDisplayTitle(pendingDelete.session, t("sidebar.untitled")),
								})
							: ""
				}
				warning={pendingDelete?.kind === "group" ? t("sidebar.deleteGroupWarning") : undefined}
				busy={deleting}
				onConfirm={() => {
					if (pendingDelete?.kind === "group") void confirmDeleteGroup(pendingDelete.group);
					else if (pendingDelete) void confirmDeleteSession(pendingDelete.session);
				}}
				onCancel={() => setPendingDelete(null)}
			/>
		</>
	);
}
