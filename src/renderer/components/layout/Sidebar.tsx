import {
	AlertTriangle,
	BarChart3,
	Bot,
	BriefcaseBusiness,
	ChevronDown,
	ChevronRight,
	CircleHelp,
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
	Pencil,
	Pin,
	PinOff,
	Plus,
	RefreshCw,
	Search,
	Settings,
	Sparkles,
	SquarePen,
	SquareTerminal,
	Trash2,
	XCircle,
} from "lucide-react";
import {
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
import { basename, cx, formatTimeAgo } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { actionKbd, onEscape } from "../../lib/keymap";
import { sessionDisplayTitle } from "../../lib/session-title";
import { useTabRpc } from "../../lib/tab-rpc";
import { tabSignalPresentation } from "../../lib/tab-signal";
import { pickWorkspaceDirectory } from "../../lib/workspace-dirs";
import { useComposerStore } from "../../stores/composer";
import { useMessagesStore } from "../../stores/messages";
import { useQueueStore } from "../../stores/queue";
import { useSessionStore } from "../../stores/session";
import { useSidebarPrefs } from "../../stores/sidebar-prefs";
import { useTabsStore } from "../../stores/tabs";
import { toast } from "../../stores/toast";
import { type PageDestination, useUiStore } from "../../stores/ui";
import {
	Badge,
	BrandMark,
	Button,
	type ContextMenuItem,
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

interface WorkspaceGroup {
	cwd: string;
	name: string;
	sessions: SessionInfo[];
}

/** A delete the row or context menu queued, awaiting the confirmation dialog. */
type PendingDelete = { kind: "session"; session: SessionInfo } | { kind: "group"; group: WorkspaceGroup };

type SidebarMode = "code" | "work";

/** Floor for the docked column: the sidebar never folds on its own, so this is what a narrow window keeps. */
const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 420;
const SIDEBAR_DEFAULT = 248;
/** Recent projects offered directly in the project menu (the rest: "All projects…"). */
const RECENT_PROJECTS = 5;

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
			icon: Sparkles,
			onSelect: () => useUiStore.getState().openSettings("features"),
		},
		{
			id: "help-feedback",
			label: t("help.feedback"),
			icon: MessageSquareWarning,
			onSelect: () => useUiStore.getState().openFeedback(),
		},
		{
			id: "help-whats-new",
			label: t("help.whatsNew"),
			icon: Sparkles,
			onSelect: () => useUiStore.getState().openChangelog(),
		},
		{
			id: "help-about",
			label: t("help.about"),
			icon: Info,
			onSelect: () => useUiStore.getState().openSettings("updates"),
		},
	];
}

/** Footer: Agents · Insights · Settings and the help menu, always visible. */
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
			className="flex shrink-0 flex-col gap-0.5 border-t border-(--sc-divider) p-2"
			data-sidebar-destinations
		>
			{DESTINATIONS.map(({ id, labelKey, icon: Icon }) => {
				const current = destination === id;
				const shortcut = shortcutFor(id);
				return (
					<Button
						aria-current={current ? "page" : undefined}
						className={cx(
							"w-full justify-start gap-2.5 px-2.5",
							current ? "bg-(--sc-selected) text-(--sc-text)" : "text-(--sc-text-secondary)",
						)}
						data-destination={id}
						icon={<Icon />}
						key={id}
						onClick={() => open(id)}
						variant="ghost"
					>
						<span className="min-w-0 flex-1 truncate text-left">{t(labelKey)}</span>
						{shortcut && <Kbd shortcut={shortcut} />}
					</Button>
				);
			})}
			<div className="flex items-center">
				<MenuButton align="start" icon={<CircleHelp />} items={helpItems} label={t("help.menu")} variant="ghost" />
			</div>
		</nav>
	);
}

/**
 * Sessions-first sidebar (design-spec §2.1): project switcher, New session,
 * a filter, sessions grouped by project (newest first, status as text/icon),
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
	const [sessionMenu, setSessionMenu] = useState<{ anchor: ContextMenuAnchor; session: SessionInfo } | null>(null);
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
	const pinnedSessions = useSidebarPrefs(s => s.pinnedSessions);
	const groupAliases = useSidebarPrefs(s => s.groupAliases);
	const workspaceLastUsed = useSidebarPrefs(s => s.workspaceLastUsed);
	const sessionLastUsed = useSidebarPrefs(s => s.sessionLastUsed);
	const touchSession = useSidebarPrefs(s => s.touchSession);
	const { sessions, isLoading, error: listError, refresh, deleteSession, renameSession } = useSessionList("global");
	const sessionId = useSessionStore(s => s.sessionId);
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
				if (activeKind !== "chat" && useSessionStore.getState().cwd === workspace) setMode("work");
			})
			.catch(() => {});
	}, []);

	// Opening a session from search or the palette keeps the lane honest.
	useEffect(() => {
		if (!defaultWorkspace || !cwd) return;
		setMode(activeTabKind === "chat" ? "code" : cwd === defaultWorkspace ? "work" : "code");
	}, [activeTabKind, cwd, defaultWorkspace]);

	const query = filter.trim().toLocaleLowerCase();
	const matchesFilter = useCallback(
		(session: SessionInfo) =>
			!query ||
			sessionDisplayTitle(session, "").toLocaleLowerCase().includes(query) ||
			session.cwd.toLocaleLowerCase().includes(query),
		[query],
	);
	const recencyForSession = useCallback(
		(session: SessionInfo) => sessionLastUsed[session.path] ?? modifiedAt(session),
		[sessionLastUsed],
	);
	const byPinThenRecency = useCallback(
		(a: SessionInfo, b: SessionInfo) => {
			const aPinned = pinnedSessions.includes(a.path) ? 0 : 1;
			const bPinned = pinnedSessions.includes(b.path) ? 0 : 1;
			if (aPinned !== bPinned) return aPinned - bPinned;
			return recencyForSession(b) - recencyForSession(a);
		},
		[pinnedSessions, recencyForSession],
	);
	const agentSessions = useMemo(() => sessions.filter(session => session.kind !== "chat"), [sessions]);
	const codeSessions = useMemo(
		() => agentSessions.filter(session => !defaultWorkspace || session.cwd !== defaultWorkspace),
		[agentSessions, defaultWorkspace],
	);
	const workSessions = useMemo(
		() =>
			agentSessions
				.filter(session => defaultWorkspace !== null && session.cwd === defaultWorkspace)
				.filter(matchesFilter)
				.toSorted(byPinThenRecency),
		[agentSessions, defaultWorkspace, matchesFilter, byPinThenRecency],
	);
	const chatSessions = useMemo(
		() =>
			sessions
				.filter(session => session.kind === "chat")
				.filter(matchesFilter)
				.toSorted(byPinThenRecency),
		[sessions, matchesFilter, byPinThenRecency],
	);

	// Code sessions stay grouped by project. Pins remain a priority partition,
	// with MRU inside it.
	const allGroups = useMemo<WorkspaceGroup[]>(() => {
		const byCwd = new Map<string, SessionInfo[]>();
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
		result.sort((a, b) => {
			const aPinned = pinnedGroups.includes(a.cwd) ? 0 : 1;
			const bPinned = pinnedGroups.includes(b.cwd) ? 0 : 1;
			if (aPinned !== bPinned) return aPinned - bPinned;
			const aRecency = Math.max(workspaceLastUsed[a.cwd] ?? 0, ...a.sessions.map(recencyForSession));
			const bRecency = Math.max(workspaceLastUsed[b.cwd] ?? 0, ...b.sessions.map(recencyForSession));
			return bRecency - aRecency;
		});
		return result;
	}, [codeSessions, groupAliases, pinnedGroups, byPinThenRecency, recencyForSession, workspaceLastUsed]);
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
	const totalCount = mode === "work" ? workSessions.length : groups.length + chatSessions.length;
	const visibleGroups = mode === "code" ? groups : [];
	const chatsCollapsed = !query && (collapsed.__chats__ ?? false);

	const isCollapsed = (groupCwd: string) => {
		// A filter shows every match.
		if (query) return false;
		if (groupCwd in collapsed) return collapsed[groupCwd];
		// Default: current project expanded, others collapsed.
		return groupCwd !== cwd;
	};
	const toggleGroup = (groupCwd: string) => {
		setCollapsed(prev => ({ ...prev, [groupCwd]: !isCollapsed(groupCwd) }));
	};
	const tabForSession = (session: SessionInfo) =>
		tabs.find(tab => tab.sessionId === session.id) ?? (session.id === sessionId ? activeTab : undefined);
	const sessionTabSignal = (session: SessionInfo) => {
		const tab = tabForSession(session);
		return tab ? tabSignalPresentation(tab, session.id === sessionId && (isStreaming || isCompacting)) : null;
	};
	const isSessionBusy = (session: SessionInfo) => {
		if (session.id === sessionId && awaitingConfirmation) return true;
		const signal = sessionTabSignal(session);
		if (signal) return signal.active;
		if (session.id === sessionId && (isStreaming || isCompacting)) return true;
		return session.status === "pending";
	};

	const openSession = (session: SessionInfo) => {
		useUiStore.getState().closeDestination();
		if (session.id === sessionId) return;
		// Already open in a tab: go there. An untouched empty tab is replaced
		// instead of left behind; anything else keeps its tab and the session
		// opens next to it.
		const owner = tabs.find(tab => tab.sessionId === session.id || tab.sessionPath === session.path);
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
		if (mode === "work") {
			useUiStore.getState().closeDestination();
			void openTab({ kind: "agent", work: true });
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
	// Explicit parallel action: open this session in a NEW window with its own
	// sidecar, leaving the current window's running session untouched.
	const openSessionInNewWindow = async (session: SessionInfo) => {
		const ok = await window.omp.sessions.openInNewWindow({ sessionPath: session.path, cwd: session.cwd });
		if (!ok) {
			toast({ variant: "warning", message: t("sidebar.parallelCap") });
			return;
		}
		touchSession(session.path, session.kind === "chat" ? undefined : session.cwd);
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
				if (session.id === sessionId) useSessionStore.setState({ sessionName: name });
			})
			.catch(error => toast({ variant: "error", title: t("sidebar.renameFailed"), message: String(error) }));
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
			toast({ variant: "error", title: t("sidebar.deleteFailed"), message: String(error) });
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
			// Delete every session file in this project, then dismiss the group.
			for (const session of group.sessions) {
				// eslint-disable-next-line no-await-in-loop -- sequential, keep FS load bounded
				if (session.id === sessionId) await dropSessionNow();
				else await deleteSession(session.path);
			}
			setPendingDelete(null);
		} catch (error) {
			toast({ variant: "error", title: t("sidebar.deleteFailed"), message: String(error) });
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
	const activeSessionKey = sessionId ? sessions.find(session => session.id === sessionId)?.path : undefined;
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

	const renderSessionRow = (session: SessionInfo, nested = false) => {
		const key = `session:${session.path}`;
		const active = session.id === sessionId && destination === "session";
		const isCurrent = session.id === sessionId;
		const tabSignal = sessionTabSignal(session);
		const waiting = isCurrent && awaitingConfirmation;
		const running = !waiting && (tabSignal?.running === true || (tabSignal === null && isSessionBusy(session)));
		const failed =
			!waiting &&
			!running &&
			(tabSignal ? tabSignal.labelKey === "titlebar.status.error" : session.status === "error");
		const busy = waiting || running || tabSignal?.active === true;
		const statusLabel = waiting
			? t("sidebar.row.needsApproval")
			: running
				? t("sidebar.signal.running")
				: failed
					? t("sidebar.row.failed")
					: null;
		const title = sessionDisplayTitle(session, t("sidebar.untitled"));
		const pinned = pinnedSessions.includes(session.path);
		const tabIndex = -1;
		if (renamingSessionPath === session.path) {
			return (
				<div className={cx("py-0.5 pr-1", nested ? "pl-6" : "pl-1")} key={session.path}>
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
		) : session.kind === "chat" ? (
			<MessageCircle aria-hidden data-sidebar-session-icon />
		) : pinned ? (
			<Pin aria-label={t("sidebar.pinned")} />
		) : (
			<span aria-hidden className="size-(--sc-icon-md)" data-sidebar-session-icon />
		);
		return (
			<ListRow
				actions={
					busy ? undefined : (
						<>
							<IconButton
								icon={<Pencil />}
								label={t("sidebar.rename")}
								onClick={() => startRename(session)}
								size="sm"
								tabIndex={-1}
							/>
							<IconButton
								icon={<Trash2 />}
								label={t("sidebar.delete")}
								onClick={() => setPendingDelete({ kind: "session", session })}
								size="sm"
								tabIndex={-1}
							/>
						</>
					)
				}
				buttonProps={{
					tabIndex,
					"data-roving-item": key,
					onFocus: () => setFocusKey(key),
					onKeyDown: event => {
						if (opensMenu(event)) {
							event.preventDefault();
							setSessionMenu({ anchor: anchorBelow(event.currentTarget), session });
						} else if (event.key === "F2" && !busy) {
							event.preventDefault();
							startRename(session);
						} else if (event.key === "Delete" && !busy) {
							event.preventDefault();
							setPendingDelete({ kind: "session", session });
						}
					},
				}}
				className={cx("omp-sidebar-session-row", nested && "pl-6")}
				key={session.path}
				leading={leading}
				meta={
					waiting ? (
						<Badge variant="warning">{t("sidebar.row.needsApproval")}</Badge>
					) : (
						<time dateTime={session.modified}>{formatTimeAgo(session.modified)}</time>
					)
				}
				onClick={() => openSession(session)}
				rowProps={{
					onContextMenu: event => setSessionMenu({ anchor: anchorFromEvent(event), session }),
					"data-active": active,
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
		);
	};

	const renderGroup = (group: WorkspaceGroup) => {
		const key = `group:${group.cwd}`;
		const groupCollapsed = isCollapsed(group.cwd);
		const isCurrentProject = group.cwd === cwd && activeTabKind !== "chat";
		const tabIndex = -1;
		const pinned = pinnedGroups.includes(group.cwd);
		return (
			<div className="mt-1 first:mt-0" key={group.cwd}>
				<div
					className="group/head relative flex h-8 items-center gap-1 rounded-(--sc-radius-md) pr-1 hover:bg-(--sc-hover)"
					data-workspace-group={group.cwd}
					onContextMenu={event => setGroupMenu({ anchor: anchorFromEvent(event), group })}
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
								"flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-(--sc-radius-md) pl-2 text-left text-sc-sm font-medium outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--sc-focus-ring)",
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
							<Folder aria-hidden className="size-(--sc-icon-sm) shrink-0" data-sidebar-workspace-icon />
							<span className="min-w-0 flex-1 truncate">{group.name}</span>
							{pinned && <Pin aria-label={t("sidebar.pinned")} className="size-3 shrink-0" />}
							<span className="shrink-0 text-sc-xs font-normal tabular-nums text-(--sc-text-subtle) group-focus-within/head:hidden group-hover/head:hidden">
								{group.sessions.length}
							</span>
						</button>
					)}
					{renamingGroupCwd !== group.cwd && (
						<span className="flex shrink-0 items-center opacity-0 transition-opacity duration-(--sc-duration-fast) group-focus-within/head:opacity-100 group-hover/head:opacity-100">
							<IconButton
								icon={<Plus />}
								label={t("sidebar.menu.newAgentHere")}
								onClick={() => {
									useUiStore.getState().closeDestination();
									void openTab({ cwd: group.cwd });
								}}
								size="sm"
								tabIndex={-1}
							/>
							<IconButton
								icon={<MoreHorizontal />}
								label={t("sidebar.groupMenu")}
								onClick={event => setGroupMenu({ anchor: anchorBelow(event.currentTarget), group })}
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
			</div>
		);
	};

	const currentProjectName =
		mode === "work"
			? t("sidebar.mode.work")
			: activeTabKind !== "chat" && cwd
				? (groupAliases[cwd] ?? (basename(cwd) || cwd))
				: t("sidebar.project.none");
	const projectItems: ContextMenuItem[] = [
		...allGroups
			.filter(group => group.cwd !== cwd)
			.slice(0, RECENT_PROJECTS)
			.map(group => ({
				id: `project:${group.cwd}`,
				label: group.name,
				description: group.cwd,
				icon: Folder,
				onSelect: () => {
					setMode("code");
					void goToProject(group.cwd);
				},
			})),
		{
			id: "project-all",
			label: t("sidebar.project.all"),
			icon: FolderOpen,
			onSelect: () => setWorkspaceDialog("switch"),
		},
		{
			id: "project-open",
			label: t("sidebar.project.open"),
			icon: FolderPlus,
			onSelect: () => {
				void pickWorkspaceDirectory()
					.then(picked => {
						if (!picked) return;
						setMode("code");
						return goToProject(picked);
					})
					.catch(error =>
						toast({ variant: "error", title: t("titlebar.openProjectFailed"), message: String(error) }),
					);
			},
		},
	];

	return (
		<>
			<aside
				aria-label={t("sidebar.label")}
				className="omp-session-sidebar relative flex h-full min-h-0 shrink-0 flex-col border-r border-(--sc-border-subtle) bg-(--sc-surface-1)"
				style={{ width: sidebarWidth }}
			>
				<div className="omp-sidebar-header drag-region flex h-12 shrink-0 items-center gap-1 pr-2 pl-3">
					<span className="flex min-w-0 flex-1 items-center gap-2 text-sc-md font-semibold text-(--sc-text)">
						<BrandMark size={18} />
						<span className="truncate">seucode</span>
					</span>
					<IconButton
						className="no-drag"
						data-command-center-entry
						icon={<Search />}
						label={t("help.palette")}
						onClick={() => useUiStore.getState().openCommandPalette()}
						shortcut={actionKbd("palette", keymapOverrides)}
						size="sm"
					/>
					<IconButton
						className="no-drag"
						icon={<PanelLeftClose />}
						label={t("sidebar.collapse")}
						onClick={() => useUiStore.getState().toggleSidebar()}
						shortcut={actionKbd("sidebar.toggle", keymapOverrides)}
						size="sm"
					/>
				</div>

				<div className="flex shrink-0 flex-col gap-2 px-2 pt-2 pb-2">
					<Tabs
						activeId={mode}
						ariaLabel={t("sidebar.mode.aria")}
						className="flex w-full [&>button]:flex-1 [&>button]:justify-center"
						compact
						onChange={id => setMode(id as SidebarMode)}
						tabs={[
							{ id: "code", label: t("sidebar.mode.code") },
							{ id: "work", label: t("sidebar.mode.work") },
						]}
						variant="segmented"
					/>
					<MenuButton
						className="w-full justify-start gap-2 px-2.5 text-(--sc-text)"
						icon={mode === "work" ? <BriefcaseBusiness /> : <Folder />}
						items={projectItems}
						label={t("sidebar.project.menu")}
						variant="ghost"
					>
						<span className="min-w-0 flex-1 truncate text-left" data-sidebar-project>
							{currentProjectName}
						</span>
						<ChevronDown aria-hidden className="text-(--sc-text-subtle)" />
					</MenuButton>
					<div className="flex items-center gap-1">
						<Button
							className="min-w-0 flex-1 justify-start gap-2.5 px-2.5"
							data-sidebar-new-agent
							icon={<SquarePen />}
							onClick={startNew}
							variant="secondary"
						>
							<span className="min-w-0 flex-1 truncate text-left">{t("sidebar.newSession")}</span>
						</Button>
						{mode === "code" && (
							<IconButton
								data-sidebar-new-chat
								icon={<MessageSquarePlus />}
								label={t("sidebar.menu.newChat")}
								onClick={startChat}
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
					className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 [overflow-anchor:none]"
					onKeyDown={onListKeyDown}
					ref={listRef}
					role="group"
				>
					{listError && sessions.length > 0 && (
						<p className="mx-2 mb-1 break-words text-sc-xs text-(--sc-danger)" role="alert">
							{t("sidebar.stale")}: {listError}
						</p>
					)}
					{isLoading && sessions.length === 0 && (
						<div className="flex justify-center px-3 py-6">
							<Spinner label={t("sidebar.loading")} />
						</div>
					)}
					{listError && sessions.length === 0 && (
						<div className="mx-1 mt-2 flex flex-col items-center gap-2 px-4 py-6 text-center">
							<div className="text-sc-md font-medium text-(--sc-danger)">{t("sidebar.loadFailed")}</div>
							<div className="break-words text-sc-xs text-(--sc-text-muted)">{listError}</div>
							<Button icon={<RefreshCw />} onClick={() => refresh(true)} size="sm" variant="secondary">
								{t("common.retry")}
							</Button>
						</div>
					)}
					{!isLoading && !listError && totalCount === 0 && (
						<p className="px-3 py-6 text-center text-sc-sm text-(--sc-text-muted)">
							{query ? t("sidebar.noMatch") : mode === "code" ? t("sidebar.emptyCode") : t("sidebar.emptyWork")}
						</p>
					)}
					{mode === "work" && workSessions.length > 0 && (
						<div className="space-y-px" data-work-section>
							{workSessions.map(session => renderSessionRow(session))}
						</div>
					)}
					{mode === "code" && chatSessions.length > 0 && (
						<div className="mb-1" data-chat-section>
							<button
								aria-expanded={!chatsCollapsed}
								className="flex h-8 w-full min-w-0 items-center gap-1.5 rounded-(--sc-radius-md) pl-2 text-left text-sc-sm font-medium text-(--sc-text-muted) outline-none hover:bg-(--sc-hover) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--sc-focus-ring)"
								data-roving-item="group:__chats__"
								onClick={() => setCollapsed(prev => ({ ...prev, __chats__: !chatsCollapsed }))}
								onFocus={() => setFocusKey("group:__chats__")}
								tabIndex={-1}
								type="button"
							>
								{chatsCollapsed ? (
									<ChevronRight aria-hidden className="size-(--sc-icon-sm) shrink-0" />
								) : (
									<ChevronDown aria-hidden className="size-(--sc-icon-sm) shrink-0" />
								)}
								<MessageCircle aria-hidden className="size-(--sc-icon-sm) shrink-0" />
								<span className="min-w-0 flex-1 truncate">{t("sidebar.chats")}</span>
								<span className="shrink-0 pr-2 text-sc-xs font-normal tabular-nums text-(--sc-text-subtle)">
									{chatSessions.length}
								</span>
							</button>
							{!chatsCollapsed && (
								<div className="space-y-px" data-session-group="__chats__" data-state="expanded">
									{chatSessions.map(session => renderSessionRow(session, true))}
								</div>
							)}
						</div>
					)}
					{visibleGroups.map(renderGroup)}
				</div>

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
									label: t("sidebar.menu.rename"),
									icon: Pencil,
									onSelect: () => {
										setGroupRenameDraft(groupMenu.group.name);
										setRenamingGroupCwd(groupMenu.group.cwd);
										setGroupMenu(null);
									},
								},
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

			{/* Session row menu: open variants, rename, pin, and delete. */}
			{sessionMenu &&
				(() => {
					const targetBusy = isSessionBusy(sessionMenu.session);
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
								{
									id: "session-rename",
									label: t("sidebar.rename"),
									icon: Pencil,
									disabled: targetBusy,
									disabledReason: t("sidebar.menu.taskRunning"),
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
								count: pendingDelete.group.sessions.length,
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
