/**
 * Sidebar sections for paired hosts (remote devices). Each host gets a header
 * — name, link dot, ⌄ toggle, its Add project button — over its projects and then
 * its Chats section, like the local list. An offline host shows one offline line
 * and no sessions; its list is only read while the link is up. Opening a row
 * reuses the tab already attached to it, else opens a remote tab; Add project
 * browses the host's disk with the remote folder picker, the Chats section's
 * button starts a chat on the host.
 */

import { closestCenter, DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
	ArrowDown,
	ArrowUp,
	ChevronDown,
	ChevronRight,
	ExternalLink,
	FileArchive,
	Folder,
	FolderMinus,
	FolderOpen,
	FolderPlus,
	MessageCircle,
	Monitor,
	MoreHorizontal,
	Plus,
	Settings2,
	Trash2,
	X,
} from "lucide-react";
import { Fragment, type ReactNode, useCallback, useMemo, useState } from "react";
import { useStore } from "zustand";
import { reviewUnmerged } from "../../../../shared/agent-control";
import { ipcErrorCode } from "../../../../shared/ipc-error-codes";
import type { HostView, SessionInfo, SessionKind } from "../../../../shared/ipc-types";
import { sessionFinished, sessionProjectKey, tabInUse } from "../../../../shared/sidebar-projects";
import { splitTabIds } from "../../../../shared/split-layout";
import { useSessionList } from "../../../hooks/use-session-list";
import { useShellInput } from "../../../hooks/use-shell-mode";
import { DEVICE_COLORS, type DeviceColorChoice, deviceColorOf } from "../../../lib/device-color";
import { saveDiagnosticBundle } from "../../../lib/diagnostic-bundle";
import { basename, cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { openExternal } from "../../../lib/open-external";
import { CHATS_ORDER_KEY, hostOrderKey, moveInOrder, orderByManual, reorderProjects } from "../../../lib/project-order";
import { isChatSession, sessionDisplayTitle, sessionHasContent } from "../../../lib/session-title";
import { deviceGroupKey, LOCAL_DEVICE } from "../../../lib/sidebar-memory";
import { tabSignalPresentation } from "../../../lib/tab-signal";
import { useAgentReviewStore } from "../../../stores/agent-review";
import { pickRemoteDirectory } from "../../../stores/remote";
import { sessionListFeed } from "../../../stores/session-list";
import { useSidebarFolds } from "../../../stores/sidebar-folds";
import { useSidebarPrefs } from "../../../stores/sidebar-prefs";
import { useProjectList, useSidebarProjects } from "../../../stores/sidebar-projects";
import { type SessionTab, tabChipLabel, useTabsStore } from "../../../stores/tabs";
import { toast, toastError } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import { webPwa } from "../../../web/pwa";
import { Button, IconButton, InlineNotice, ListRow, Spinner } from "../../common";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import {
	anchorFromEvent,
	ContextMenu,
	type ContextMenuItem,
	MenuButton,
	type MenuSelectModifiers,
} from "../../common/ContextMenu";
import { TimeAgo } from "../../common/TimeAgo";
import { TabLiveAge, TabLiveTitle } from "../SessionLiveTitle";
import { useHostWorkspace } from "./host-workspace";
import { SidebarChats } from "./SidebarChats";
import { useDeviceHeaderHandle } from "./SidebarDeviceSections";
import { SidebarFoldButton } from "./SidebarFoldButton";
import { type FamilyOpened, SidebarLooseChildren, SidebarSubagents, SidebarSubagentsToggle } from "./SidebarSubagents";
import { SortableProject } from "./SortableProject";
import { type SessionList, useSessionReorder } from "./session-reorder";
import { CHILD_TOKEN, foldsIntoProject, hostOpenerOfSessions, openedChildStatus } from "./sidebar-family";

const NO_OPENED: readonly FamilyOpened[] = [];

/** A host row: an indexed remote session, or an open remote tab the host has not listed yet. */
type DeviceSession = SessionInfo & { liveTabId?: string };

interface RemoteOpenArgs {
	cwd: string;
	sessionPath?: string;
	kind?: SessionKind;
}

const DOT_CLASS: Record<HostView["state"], string> = {
	online: "bg-(--sc-success)",
	connecting: "bg-(--sc-warning) omp-pulse-dot",
	offline: "bg-(--sc-text-subtle)",
};

/** Stock's `created`: a session's order must not move while a turn rewrites its file. */
function createdAt(session: SessionInfo): number {
	const time = Date.parse(session.created);
	return Number.isNaN(time) ? 0 : time;
}

/** A device section's header: the toggle that folds its list (glyph, name, what follows the name, chevron) and, at
 * the end, the button that opens or makes a project folder on that device (a new chat is its Chats section's). This
 * device's and every host's alike. */
function DeviceHeader({
	deviceId,
	folded,
	name,
	children,
	canAct = true,
	offline = false,
	onAction,
	local,
	extra,
}: {
	deviceId: string;
	folded: boolean;
	name: string;
	children?: ReactNode;
	/** Another button before the project button (a phone's way to the host's own page). */
	extra?: ReactNode;
	canAct?: boolean;
	/** The host is offline: its header drops the project button, which could start nothing there. */
	offline?: boolean;
	onAction: () => void;
	/** This device's header (`data-sidebar-device-header="local"`); a host's sits in its `[data-device-state]` section. */
	local?: boolean;
}) {
	const t = useT();
	const handle = useDeviceHeaderHandle();
	const Chevron = folded ? ChevronRight : ChevronDown;
	const choice = useSidebarFolds(s => s.deviceColors[deviceId]);
	const color = deviceColorOf(deviceId, choice, local === true);
	const pick = (next: DeviceColorChoice | undefined) => useSidebarFolds.getState().setDeviceColor(deviceId, next);
	const colorItems: ContextMenuItem[] = [
		{
			id: "auto",
			label: t("remote.sidebar.color.auto"),
			checked: choice === undefined,
			onSelect: () => pick(undefined),
		},
		...DEVICE_COLORS.map(
			(value, index): ContextMenuItem => ({
				id: value,
				label: t(`remote.sidebar.color.${value}`),
				swatch: value,
				checked: choice === value,
				separatorBefore: index === 0,
				onSelect: () => pick(value),
			}),
		),
		{
			id: "none",
			label: t("remote.sidebar.color.none"),
			swatch: "",
			checked: choice === "none",
			separatorBefore: true,
			onSelect: () => pick("none"),
		},
	];
	return (
		<div
			className="omp-device-header group/device flex h-8 items-center rounded-(--sc-radius-md) hover:bg-(--sc-hover)"
			data-device-color={color ?? undefined}
			data-sidebar-device-header={local ? "local" : undefined}
		>
			<button
				{...handle}
				aria-expanded={!folded}
				className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-(--sc-radius-md) pr-1 pl-2 text-left text-sc-xs font-medium text-(--sc-text-muted) select-none [-webkit-touch-callout:none] hover:text-(--sc-text) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--sc-focus-ring)"
				data-roving-item={`device:${deviceId}`}
				data-sidebar-device-toggle={deviceId}
				onClick={() => useSidebarFolds.getState().setDeviceFolded(deviceId, !folded)}
				tabIndex={-1}
				// The name truncates in a narrow sidebar; hovering names the device whole.
				title={name}
				type="button"
			>
				<Monitor aria-hidden className="size-(--sc-icon-sm) shrink-0" data-device-glyph />
				<span className="min-w-0 truncate">{name}</span>
				{children}
				<Chevron aria-hidden className="size-(--sc-icon-sm) shrink-0" />
			</button>
			{/* At rest with a mouse the gear gives the name its room; hovering or focusing the header, or the open menu,
			    brings it back. A finger has no hover, so it stays. */}
			<span
				className="hidden group-focus-within/device:contents group-hover/device:contents has-[[aria-expanded=true]]:contents [@media(hover:none)]:contents"
				data-sidebar-device-color={deviceId}
			>
				<MenuButton
					className="text-(--sc-text-subtle) hover:text-(--sc-text)"
					icon={<Settings2 />}
					items={colorItems}
					label={t("remote.sidebar.color", { name })}
					size="sm"
					variant="ghost"
				/>
			</span>
			{extra}
			{offline ? (
				// An offline host can start nothing: no dead button takes the name's room (a tablet's sidebar left
				// "Old desktop" 36 px beside its offline badge and the gear).
				<span className="w-1 shrink-0" />
			) : (
				<IconButton
					className="mr-1 text-(--sc-text-subtle) hover:text-(--sc-text)"
					data-sidebar-device-add={deviceId}
					disabled={!canAct}
					icon={<FolderPlus />}
					label={t("remote.sidebar.addProject", { name })}
					onClick={onAction}
					size="sm"
					tabIndex={-1}
				/>
			)}
		</div>
	);
}

/** The header over this device's own list, shown only once a host is paired: it folds the list and, like a host's
 * header, ends in its project button here (the search row's then gives way). */
export function SidebarLocalHeader({ onAddProject }: { onAddProject: () => void }) {
	const t = useT();
	const folded = useSidebarFolds(s => s.devices[LOCAL_DEVICE] === true);
	return (
		<DeviceHeader
			deviceId={LOCAL_DEVICE}
			folded={folded}
			local
			name={t("remote.sidebar.thisDevice")}
			onAction={onAddProject}
		/>
	);
}

export function SidebarDeviceSection({
	host,
	query,
	nested,
	childForTab,
	pending = false,
	onNewChat,
}: {
	host: HostView;
	query: string;
	/** Tab ids and session files of sessions a session of this computer opened here: they are rows of its family. */
	nested?: ReadonlySet<string>;
	/** The family row of a session here a tab of this computer holds (its live state is the tab's). */
	childForTab: (tab: SessionTab) => FamilyOpened;
	/** A host the last host-list read named, drawn before this launch's first read: still, as it will look. */
	pending?: boolean;
	/** The sidebar's own New chat, started on this host. */
	onNewChat: (device: string) => void;
}) {
	const t = useT();
	const collapsed = useSidebarFolds(s => s.devices[host.deviceId] === true);
	const online = host.state === "online";
	const webPage = webPwa() !== null;
	const stateLabel = t(`remote.state.${host.state}`);
	// While the link comes up the host's last known rows stand in (never read: an unlinked host is not asked), so the
	// rows are already in place when it connects and nothing below them moves.
	const hasLastKnownRows = useStore(sessionListFeed("global", host.deviceId).store, s => s.sessions.length > 0);
	const showRows = online || (host.state === "connecting" && hasLastKnownRows);

	const openRemote = async (args: RemoteOpenArgs) => {
		useUiStore.getState().closeDestination();
		await useTabsStore.getState().openTab({ ...args, device: host.deviceId });
	};

	return (
		<section
			aria-label={host.name}
			data-device-pending={pending ? "" : undefined}
			data-device-state={host.state}
			data-sidebar-device={host.deviceId}
		>
			<DeviceHeader
				canAct={online}
				offline={host.state === "offline"}
				deviceId={host.deviceId}
				extra={
					// On a phone or tablet page: the host's own page, which this computer's paired host shares (the phone
					// then talks to the host directly instead of through this computer).
					webPage && online && host.webUrl ? (
						<IconButton
							className="text-(--sc-text-subtle) hover:text-(--sc-text)"
							data-sidebar-device-web={host.deviceId}
							icon={<ExternalLink />}
							label={t("remote.sidebar.openWebPage", { name: host.name })}
							onClick={() => openExternal(host.webUrl ?? "")}
							size="sm"
							tabIndex={-1}
						/>
					) : undefined
				}
				folded={collapsed}
				name={host.name}
				onAction={() =>
					void pickRemoteDirectory(host.deviceId).then(path => {
						if (path) void openRemote({ cwd: path, kind: "agent" });
					})
				}
			>
				<span
					aria-hidden
					className={cx(
						"size-1.5 shrink-0 rounded-full",
						pending && host.state !== "offline" ? "bg-(--sc-text-subtle)" : DOT_CLASS[host.state],
					)}
				/>
				{host.state === "offline" ? (
					<span
						className="shrink-0 rounded-(--sc-radius-sm) bg-(--sc-hover) px-1 text-sc-xs text-(--sc-text-secondary)"
						data-device-offline
						title={t("remote.sidebar.offline")}
					>
						{stateLabel}
					</span>
				) : (
					<span className="sr-only">, {stateLabel}</span>
				)}
			</DeviceHeader>
			{!collapsed &&
				(showRows ? (
					<DeviceSessions
						childForTab={childForTab}
						host={host}
						nested={nested}
						onNewChat={() => onNewChat(host.deviceId)}
						onOpen={openRemote}
						query={query}
						read={online}
					/>
				) : host.state === "connecting" ? (
					<p className="flex items-center gap-2 px-2.5 py-1.5 text-sc-xs text-(--sc-text-muted)">
						<Spinner size="sm" />
						{stateLabel}
					</p>
				) : null)}
		</section>
	);
}

/** The host's list. Read only while the link is up (`read`), so an unlinked host is never asked: before that its last
 * known rows show. */
function DeviceSessions({
	host,
	query,
	nested,
	childForTab,
	onNewChat,
	onOpen,
	read,
}: {
	host: HostView;
	query: string;
	nested: ReadonlySet<string> | undefined;
	childForTab: (tab: SessionTab) => FamilyOpened;
	onNewChat: () => void;
	onOpen: (args: RemoteOpenArgs) => Promise<void>;
	read: boolean;
}) {
	const t = useT();
	const { sessions, isLoading, error, refresh, deleteSession } = useSessionList("global", host.deviceId, { read });
	const [pendingDelete, setPendingDelete] = useState<DeviceSession | null>(null);
	const [deleting, setDeleting] = useState(false);
	// A finger has no hover, so Close and Delete would sit on every row for good: one ⋯ opens them as an action sheet
	// instead, as on this computer's own rows (Sidebar.tsx).
	const touchInput = useShellInput() === "touch";
	const [rowMenu, setRowMenu] = useState<{ x: number; y: number; items: ContextMenuItem[]; label: string } | null>(
		null,
	);
	const allTabs = useTabsStore(state => state.tabs);
	const activeTabId = useTabsStore(state => state.activeTabId);
	const destination = useUiStore(state => state.destination);
	const split = useTabsStore(state => state.split);
	const splitIds = useMemo(() => (split ? new Set(splitTabIds(split)) : null), [split]);
	const deviceGroupFolds = useSidebarFolds(s => s.deviceGroups);
	// The order the person set for this host's projects and each of its lists, kept with this computer's own.
	const groupOrder = useSidebarPrefs(s => s.groupOrder);
	const sessionOrder = useSidebarPrefs(s => s.sessionOrder);
	const deviceTabs = useMemo(() => allTabs.filter(tab => tab.device === host.deviceId), [allTabs, host.deviceId]);
	const hostTabs = useMemo(() => deviceTabs.filter(tab => !nested?.has(tab.id)), [deviceTabs, nested]);

	// The host's own rule (Sidebar.tsx): a session in its no-project workspace (`~/.omp/work`, where a session opened
	// there without a folder starts) is one of its chats, so it is here too.
	const hostWorkspace = useHostWorkspace(host.deviceId, read);
	// The host's own project list: its empty projects show here too, and one removed there (or here) is gone from both.
	const projectList = useProjectList(host.deviceId, read);

	/** Every session the host's list holds, before the families and the filter take theirs. */
	const hostRows = useMemo<DeviceSession[]>(() => {
		// A file stock wrote before the first message is not a conversation yet (see Sidebar).
		const listed = sessions.filter(session => sessionHasContent(session) && !nested?.has(session.path));
		const listedPaths = new Set(listed.map(session => session.path));
		const listedIds = new Set(listed.map(session => session.id));
		const now = new Date().toISOString();
		const live: DeviceSession[] = hostTabs
			.filter(
				tab =>
					// A new session nobody wrote to yet is no row (see Sidebar).
					tab.unstarted !== true &&
					!(tab.sessionPath && listedPaths.has(tab.sessionPath)) &&
					!(tab.sessionId && listedIds.has(tab.sessionId)),
			)
			.map(tab => ({
				path: tab.sessionPath ?? `tab:${tab.id}`,
				id: tab.sessionId ?? `tab:${tab.id}`,
				title: tab.title ?? tabChipLabel(tab, hostTabs),
				cwd: tab.cwd,
				created: now,
				modified: now,
				messageCount: 0,
				size: 0,
				status: "unknown",
				...(tab.kind === "chat" ? { kind: "chat" as const } : {}),
				firstMessage: "",
				device: host.deviceId,
				liveTabId: tab.id,
			}));
		return [...listed, ...live];
	}, [sessions, hostTabs, host.deviceId, nested]);
	// A session the host's own agent opened is a row of its opener's family, as on the host (Sidebar.tsx): the
	// opener's row key → what it opened, in the order it opened them.
	const familyRootOf = useMemo(
		() =>
			hostOpenerOfSessions(
				deviceTabs,
				hostRows.map(row => ({ ...row, title: sessionDisplayTitle(row, "") })),
			),
		[deviceTabs, hostRows],
	);
	const gone = useMemo(() => new Set(projectList.gone ?? []), [projectList.gone]);
	// A tab here the person uses (`tabInUse`: not one a relaunch restored asleep, nor a ghost); the host's own holders
	// are in use there (`heldOnHost`: it closes a tab it restored asleep on a finished worktree).
	const sessionInUse = useMemo(() => {
		const inUse = new Set(
			deviceTabs.filter(tabInUse).flatMap(tab => [tab.id, tab.sessionPath, tab.sessionId].filter(Boolean)),
		);
		return (session: DeviceSession) =>
			session.heldOnHost === true ||
			inUse.has(session.path) ||
			inUse.has(session.id) ||
			(session.liveTabId !== undefined && inUse.has(session.liveTabId));
	}, [deviceTabs]);
	// A child that ran in a finished worktree is no row under its opener either, unless a tab the person uses holds it
	// (`sessionFinished`, the rule the host's own sidebar and the project groups follow).
	const familyChildrenOf = useMemo(() => {
		const byRoot = new Map<string, DeviceSession[]>();
		for (const row of hostRows.toSorted((a, b) => createdAt(a) - createdAt(b))) {
			const root = familyRootOf.get(row.path);
			if (root === undefined) continue;
			if (sessionFinished({ cwd: row.cwd, gone: gone.has(row.cwd), inUse: sessionInUse(row) })) continue;
			byRoot.set(root, [...(byRoot.get(root) ?? []), row]);
		}
		return byRoot;
	}, [hostRows, familyRootOf, gone, sessionInUse]);
	// A closed session the host's own agent opened whose opener the host knows of no row for (it says `null`: no tab,
	// no closed record; its brief names a title no row has since the opener retitled itself) is no row of its own on
	// the host: it folds into its project's group, listed there only while it needs a look (Sidebar.tsx
	// `foldedRootOf`). One a tab here or on the host holds (`heldOnHost`), or that the host works on, keeps its row. An
	// older host names no opener of any row (`openedBySession` absent), so its rows list as before.
	const folded = useMemo(() => {
		const live = new Set(host.live?.map(session => session.sessionPath));
		const held = new Set(deviceTabs.flatMap(tab => [tab.sessionPath, tab.sessionId].filter(Boolean)));
		return new Set(
			hostRows.flatMap(row =>
				row.openedBySession === null &&
				!familyRootOf.has(row.path) &&
				// A chat is the host's chat list's, which folds nothing (Sidebar.tsx folds code sessions only).
				!isChatSession(row, hostWorkspace) &&
				row.liveTabId === undefined &&
				!held.has(row.path) &&
				!held.has(row.id) &&
				row.heldOnHost !== true &&
				!live.has(row.path) &&
				foldsIntoProject(row, { agentWorktree: projectList.worktreeKinds?.[row.cwd] === "agent" })
					? [row.path]
					: [],
			),
		);
	}, [hostRows, familyRootOf, hostWorkspace, deviceTabs, host.live, projectList.worktreeKinds]);
	const matches = useCallback(
		(session: DeviceSession) => {
			const needle = query.toLocaleLowerCase();
			return (
				!needle ||
				sessionDisplayTitle(session, "").toLocaleLowerCase().includes(needle) ||
				session.cwd.toLocaleLowerCase().includes(needle)
			);
		},
		[query],
	);
	const rows = useMemo<DeviceSession[]>(
		() =>
			hostRows
				.filter(session => !familyRootOf.has(session.path) && !folded.has(session.path) && matches(session))
				.toSorted((a, b) => createdAt(b) - createdAt(a)),
		[hostRows, familyRootOf, folded, matches],
	);
	/** A list's sessions in the order the person set, newest first for the ones never placed (as before any move). */
	const ordered = useMemo(() => {
		const key = (session: DeviceSession) => session.path;
		return (sessions: readonly DeviceSession[], list: string) => {
			const manual = sessionOrder[hostOrderKey(host.deviceId, list)];
			if (!manual) return [...sessions];
			const at = new Map(sessions.map((session, index) => [session.path, index]));
			return orderByManual(sessions, key, { pinned: [], manual, recency: session => -(at.get(session.path) ?? 0) });
		};
	}, [sessionOrder, host.deviceId]);
	const chats = useMemo(
		() =>
			ordered(
				rows.filter(session => isChatSession(session, hostWorkspace)),
				CHATS_ORDER_KEY,
			),
		[rows, hostWorkspace, ordered],
	);

	const groups = useMemo(() => {
		const removed = new Set(projectList.removed);
		const held = new Set(hostTabs.flatMap(tab => [tab.sessionPath, tab.sessionId].filter(Boolean)));
		const byCwd = new Map<string, { sessions: DeviceSession[]; folded: DeviceSession[] }>();
		const groupFor = (project: string) => {
			const entry = byCwd.get(project) ?? { sessions: [], folded: [] };
			byCwd.set(project, entry);
			return entry;
		};
		for (const session of rows) {
			if (isChatSession(session, hostWorkspace)) continue;
			// The host's own rule (`sessionProjectKey`): a linked worktree's session is a row of its project (the host's git
			// says which, a removed one's too while the host still names it), never a project of its own; a removed
			// worktree's sessions are finished and leave unless a tab the person uses holds one, here or on the host (a
			// tab restored asleep here never brings one back); a removed project's leave unless any tab holds one; a
			// gone folder that is a project stays with its sessions.
			const key = sessionProjectKey(
				{
					cwd: session.cwd,
					gone: gone.has(session.cwd),
					project: projectList.worktrees[session.cwd],
					held:
						session.liveTabId !== undefined ||
						session.heldOnHost === true ||
						held.has(session.path) ||
						held.has(session.id),
					inUse: sessionInUse(session),
				},
				removed,
			);
			if (key !== null) groupFor(key).sessions.push(session);
		}
		for (const session of hostRows.toSorted((a, b) => createdAt(a) - createdAt(b))) {
			if (!folded.has(session.path) || !matches(session)) continue;
			const key = sessionProjectKey(
				{
					cwd: session.cwd,
					gone: gone.has(session.cwd),
					project: projectList.worktrees[session.cwd],
					held: false,
					inUse: false,
				},
				removed,
			);
			if (key !== null) groupFor(key).folded.push(session);
		}
		// A new, still empty tab has no row (see Sidebar), but its folder keeps its group.
		for (const tab of hostTabs) {
			if (tab.unstarted !== true || isChatSession(tab, hostWorkspace)) continue;
			const project = projectList.worktrees[tab.cwd] ?? tab.cwd;
			if (!removed.has(project)) groupFor(project);
		}
		const result = [...byCwd.entries()].map(([cwd, entry]) => ({
			cwd,
			sessions: ordered(entry.sessions, cwd),
			folded: entry.folded,
			missing: false,
		}));
		const needle = query.toLocaleLowerCase();
		// The list's projects with no session to show, newest first after the ones that have; a filter keeps one whose
		// folder name matches.
		for (const project of projectList.projects.toSorted((a, b) => b.addedAt - a.addedAt)) {
			const shown = result.find(group => group.cwd === project.path);
			if (shown) shown.missing = project.missing === true;
			else if (!needle || project.path.toLocaleLowerCase().includes(needle))
				result.push({ cwd: project.path, sessions: [], folded: [], missing: project.missing === true });
		}
		// The order the person set (by its host-scoped key); a project never placed keeps today's place, on top.
		const at = new Map(result.map((group, index) => [group.cwd, index]));
		const prefix = hostOrderKey(host.deviceId, "");
		const manual = groupOrder.filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
		return orderByManual(result, group => group.cwd, {
			pinned: [],
			manual,
			recency: group => -(at.get(group.cwd) ?? 0),
		});
	}, [
		rows,
		hostRows,
		folded,
		matches,
		projectList,
		gone,
		sessionInUse,
		query,
		hostTabs,
		hostWorkspace,
		ordered,
		groupOrder,
		host.deviceId,
	]);

	/** Moves a project of this host up or down; the other projects of every device keep their order. */
	const saveGroupOrder = (next: readonly string[]) => {
		const prefix = hostOrderKey(host.deviceId, "");
		const others = useSidebarPrefs.getState().groupOrder.filter(key => !key.startsWith(prefix));
		void useSidebarPrefs
			.getState()
			.setGroupOrder([...others, ...next.map(item => hostOrderKey(host.deviceId, item))]);
	};
	const moveGroup = (cwd: string, delta: number) => {
		const next = moveInOrder(
			groups.map(group => group.cwd),
			cwd,
			delta,
		);
		if (next) saveGroupOrder(next);
	};
	// Dragging a project header moves it, as on this computer's own list (a 6 px move arms it, so a click still folds).
	const groupSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
	const onGroupDragEnd = ({ active, over }: DragEndEvent) => {
		if (!over || active.id === over.id) return;
		saveGroupOrder(
			reorderProjects(
				groups.map(group => group.cwd),
				String(active.id),
				String(over.id),
			),
		);
	};
	/** The list a session row sits in (its project, or the Chats section) and that list's visible order. */
	const listOf = (session: DeviceSession): SessionList | null => {
		// A filtered list shows only some rows: a move there would forget where the hidden ones were.
		if (query || session.liveTabId !== undefined) return null;
		// A row the host has no file for yet (a new tab's) has no place to keep.
		const stored = (list: readonly DeviceSession[]) =>
			list.filter(row => row.liveTabId === undefined).map(row => row.path);
		if (chats.some(item => item.path === session.path)) return { key: CHATS_ORDER_KEY, paths: stored(chats) };
		const group = groups.find(item => item.sessions.some(row => row.path === session.path));
		return group ? { key: group.cwd, paths: stored(group.sessions) } : null;
	};
	// Kept in this computer's prefs under the host's id, so this computer's own lists never move with it.
	const reorder = useSessionReorder({
		titleOf: path => {
			const found = rows.find(session => session.path === path);
			return found ? sessionDisplayTitle(found, "") : "";
		},
		save: (list, next) =>
			void useSidebarPrefs.getState().setSessionOrder(hostOrderKey(host.deviceId, list.key), [...next]),
	});
	const moveSession = (session: DeviceSession, delta: number): boolean => {
		const list = listOf(session);
		const next = list && moveInOrder(list.paths, session.path, delta);
		if (!list || !next) return false;
		reorder.move(list, session.path, next, sessionDisplayTitle(session, ""));
		return true;
	};

	// What the host works on now (its windows' tabs, the tabs it runs for any device): a row no tab here holds still
	// wears the working cue, without a tap to open it first.
	const hostLive = useMemo(
		() => new Map(host.live?.map(session => [session.sessionPath, session.state])),
		[host.live],
	);
	// A window viewing an opener here hears main's review list of what its agent opened (Sidebar.tsx): the child's
	// state when no tab here holds it. Child session file → its item.
	const reviewByTab = useAgentReviewStore(s => s.byTab);
	const reviewOfPath = useMemo(
		() =>
			new Map(
				Object.values(reviewByTab).flatMap(items =>
					items.flatMap(item =>
						item.device === host.deviceId && item.sessionPath ? [[item.sessionPath, item] as const] : [],
					),
				),
			),
		[reviewByTab, host.deviceId],
	);

	const tabFor = (session: DeviceSession): SessionTab | undefined =>
		hostTabs.find(
			tab => tab.id === session.liveTabId || tab.sessionPath === session.path || tab.sessionId === session.id,
		);

	const openSession = (session: DeviceSession) => {
		const owner = tabFor(session);
		if (owner) {
			useUiStore.getState().closeDestination();
			void useTabsStore.getState().switchTab(owner.id);
			return;
		}
		// openTab reports its own failures (toast) and resolves null.
		void onOpen({ cwd: session.cwd, sessionPath: session.path, kind: session.kind ?? "agent" });
	};

	/**
	 * A session the host's own agent opened, as a one-line child under its opener: the tab here when one holds it,
	 * else what the host says of it (its working cue, its review list's verdict on the row, the review list here when
	 * this window views the opener, the indexed failure), by the local rows' status rule (Sidebar.tsx).
	 */
	const familyChildFor = (child: DeviceSession): FamilyOpened => {
		// An asleep tab knows nothing of the host's run (renderRow): the host's list says it.
		const tab = tabFor(child);
		if (tab && tab.status !== "asleep") return childForTab(tab);
		const live = hostLive.get(child.path);
		const review = reviewOfPath.get(child.path);
		const failed = review?.failed === true || child.childProblem === "failed" || child.status === "error";
		const running = live === "turn" || live === "background" || review?.state === "running";
		const status = openedChildStatus({
			waiting: live === "waiting" || review?.waiting === true,
			running,
			finished: !running,
			failed,
			unmerged: reviewUnmerged(review) || child.childProblem === "unmerged",
		});
		const title = sessionDisplayTitle(child, t("sidebar.untitled"));
		const statusLabel =
			status === "problem"
				? t(failed ? "sidebar.row.failed" : "sidebar.family.unmerged")
				: status === "waiting"
					? t("sidebar.row.needsInput")
					: status === "running"
						? t("sidebar.signal.running")
						: status === "done"
							? t("tabs.done")
							: "";
		const id = `device:${host.deviceId}:${child.path}`;
		const key = `session:${id}`;
		return {
			key: id,
			kind: review?.branch !== undefined || projectList.worktrees[child.cwd] !== undefined ? "worktree" : "session",
			status,
			state: status ? CHILD_TOKEN[status] : null,
			stateLabel: statusLabel,
			title,
			age: status !== "running" ? <TimeAgo className="text-(--sc-text-subtle)" iso={child.modified} /> : undefined,
			device: host.name,
			tooltip: [title, statusLabel, `${host.name} · ${child.cwd}`].filter(Boolean).join("\n"),
			selected: false,
			onOpen: () => openSession(child),
			buttonProps: { tabIndex: -1, "data-roving-item": key },
			rowProps: {
				"data-session-path": child.path,
				"data-sidebar-opened-session": true,
				"data-device": host.deviceId,
				"data-signal":
					status === "waiting"
						? "waiting"
						: status === "running"
							? "running"
							: status === "problem"
								? "error"
								: undefined,
				"data-child-status": status ?? undefined,
			},
		};
	};

	/**
	 * A delete a turn running on the host refused (in a tab here, a host window's or another device's): one action
	 * stops every turn on the session there (the host answers once their runs ended) and runs the same delete again,
	 * which the person already confirmed.
	 */
	const refuseRunning = (session: DeviceSession) => {
		setPendingDelete(null);
		toast({
			variant: "warning",
			message: t("remote.sidebar.deleteRunning", { device: host.name }),
			action: {
				label: t("sidebar.stopAndDelete"),
				run: () =>
					void window.omp.sessions.stop(session.path, host.deviceId).then(
						() => confirmDelete(session),
						error => toastError({ title: t("remote.sidebar.stopFailed", { device: host.name }), error }),
					),
			},
			durationMs: 15_000,
		});
	};

	// Like the local list (Sidebar.tsx): the tab showing the session closes first, then main waits for the host's
	// omp to let go of the file and the host deletes it (its own `sessions.delete`). A turn running there, in a tab
	// here or one the device cannot see (a host window's, another device's), refuses it and offers Stop and delete.
	const confirmDelete = async (session: DeviceSession) => {
		if (tabFor(session)?.status === "running") {
			refuseRunning(session);
			return;
		}
		setDeleting(true);
		try {
			if (!(await useTabsStore.getState().closeDeletedSession(session.path, tabFor(session)?.id))) {
				setPendingDelete(null);
				return;
			}
			await deleteSession(session.path);
			setPendingDelete(null);
		} catch (cause) {
			if (ipcErrorCode(cause) === "session_running") refuseRunning(session);
			else toastError({ title: t("sidebar.deleteFailed"), error: cause });
		} finally {
			setDeleting(false);
		}
	};

	const renderRow = (session: DeviceSession) => {
		const tab = tabFor(session);
		// A tab restored asleep when this computer launched (no omp attached until it is shown) has heard nothing of the
		// host's run: the host's live list says it instead.
		const known = tab?.status === "asleep" ? undefined : tab;
		const signal = known ? tabSignalPresentation(known) : null;
		const live = known ? undefined : hostLive.get(session.path);
		const waiting = known ? known.awaitingInput !== undefined : live === "waiting";
		const running = known ? signal?.running === true && !waiting : live === "turn" || live === "background";
		const settling = known ? known.settling === true : live === "background";
		const working = signal?.running === true || running;
		const current = tab !== undefined && tab.id === activeTabId;
		// Every pane of the split on screen reads as selected, like the local list (Sidebar.tsx); the focused one adds data-pane-focus.
		const inVisibleSplit = !current && tab !== undefined && splitIds?.has(tab.id) === true;
		const active = (current || inVisibleSplit) && destination === "session";
		const indexed = session.liveTabId === undefined;
		const title = sessionDisplayTitle(session, indexed ? t("sidebar.untitled") : t("sidebar.newSession"));
		// No leading slot (the local rows' rule, Sidebar.tsx): the title starts at the group's content edge, a chat's
		// glyph sits at the end before the age, and a tab open elsewhere is said in words only.
		const openElsewhere = tab !== undefined && !current && !inVisibleSplit;
		const chat = session.kind === "chat" ? <MessageCircle aria-hidden className="size-(--sc-icon-sm)" /> : null;
		const age = (
			<TabLiveAge
				iso={indexed ? session.modified : null}
				running={running}
				settling={settling}
				tabId={tab?.id ?? null}
				waiting={waiting}
			/>
		);
		// A row the host has not written to disk yet has no file to delete; closing its tab is all there is.
		const deletable = !session.path.startsWith("tab:") && !signal?.running;
		const closeSession = () => {
			if (tab) void useTabsStore.getState().closeTab(tab.id);
		};
		const list = listOf(session);
		const index = list ? list.paths.indexOf(session.path) : -1;
		const menuItems: ContextMenuItem[] = [
			...(tab ? [{ id: "close", label: t("sidebar.menu.closeSession"), icon: X, onSelect: closeSession }] : []),
			...(list
				? [
						{
							id: "move-up",
							label: t("sidebar.menu.moveUp"),
							icon: ArrowUp,
							disabled: index <= 0,
							onSelect: () => moveSession(session, -1),
						},
						{
							id: "move-down",
							label: t("sidebar.menu.moveDown"),
							icon: ArrowDown,
							disabled: index === -1 || index >= list.paths.length - 1,
							onSelect: () => moveSession(session, 1),
						},
					]
				: []),
			// Stock's `/dump` runs in the omp the tab drives, on the host: a session no tab holds has nothing to dump.
			...[false, true].map(anonymizedItem => ({
				id: anonymizedItem ? "dump-bundle-anonymized" : "dump-bundle",
				separatorBefore: !anonymizedItem,
				label: t(anonymizedItem ? "diagnosticBundle.saveAnonymized" : "diagnosticBundle.save"),
				icon: FileArchive,
				disabled: tab === undefined,
				disabledReason: t("diagnosticBundle.needsOpenTab"),
				onSelect: (modifiers?: MenuSelectModifiers) => {
					if (tab)
						void saveDiagnosticBundle({ tabId: tab.id, title }, anonymizedItem || modifiers?.altKey === true);
				},
			})),
			...(deletable
				? [
						{
							id: "delete",
							label: t("sidebar.delete"),
							icon: Trash2,
							danger: true,
							onSelect: () => setPendingDelete(session),
						},
					]
				: []),
		];
		// Its family, as a local row's (Sidebar.tsx): the tab's subagents and the sessions its agent opened on this host.
		const children = familyChildrenOf.get(session.path);
		const opened = children ? children.map(familyChildFor) : NO_OPENED;
		const family = tab !== undefined || opened.length > 0;
		// Its own key: two hosts may keep a session at the same path, and this computer's prune never sees host rows.
		const familyKey = `device:${host.deviceId}:${session.path}`;
		return (
			<Fragment key={session.path}>
				<ListRow
					// One ⋯ on every input, so the title keeps its width; at rest under touch, on hover or focus elsewhere.
					actions={
						menuItems.length > 0 && (
							<IconButton
								data-sidebar-row-menu
								icon={<MoreHorizontal />}
								label={t("sidebar.sessionMenu")}
								onClick={event => {
									const rect = event.currentTarget.getBoundingClientRect();
									setRowMenu({ x: rect.left, y: rect.bottom + 4, items: menuItems, label: title });
								}}
								size="sm"
								tabIndex={-1}
							/>
						)
					}
					actionCount={1}
					actionsAtRest={touchInput}
					actionsOnHover={!touchInput}
					buttonProps={{
						tabIndex: -1,
						"data-roving-item": `device-session:${host.deviceId}:${session.path}`,
						onKeyDown: event => {
							// Alt+↑/↓ moves the row in its list, as on this computer's own rows.
							if (
								event.altKey &&
								(event.key === "ArrowUp" || event.key === "ArrowDown") &&
								moveSession(session, event.key === "ArrowUp" ? -1 : 1)
							)
								event.preventDefault();
						},
					}}
					className="omp-sidebar-session-row"
					key={session.path}
					meta={
						chat || age ? (
							<span className="inline-flex items-center gap-1.5">
								{chat}
								{age}
							</span>
						) : undefined
					}
					onClick={() => openSession(session)}
					rowProps={{
						// Dragged onto a session pane, the open tab joins the split there (SplitWorkspace takes `omp:tab-drag`);
						// dropped on a row of its own list it moves there.
						...reorder.rowDrag(session.path, list, tab ? { id: tab.id, shown: current } : undefined),
						"data-device-session": session.path,
						onContextMenu: event => {
							const anchor = anchorFromEvent(event);
							setRowMenu({ ...anchor, items: menuItems, label: title });
						},
						"data-active": active,
						"data-current": current || undefined,
						"data-pane-focus": (current && splitIds !== null) || undefined,
						"data-live": indexed ? undefined : true,
					}}
					selected={active}
					title={
						<>
							<TabLiveTitle
								running={running}
								settling={settling}
								tabId={tab?.id ?? null}
								text={title}
								waiting={waiting}
							/>
							{working && <span className="sr-only">, {t("sidebar.signal.running")}</span>}
							{openElsewhere && !working && <span className="sr-only">, {t("sidebar.row.open")}</span>}
						</>
					}
					titleText={[title, openElsewhere && !working ? t("sidebar.row.open") : null].filter(Boolean).join("\n")}
					trailing={
						family ? (
							<SidebarSubagentsToggle opened={opened} sessionKey={familyKey} tabId={tab?.id ?? null} />
						) : undefined
					}
				/>
				{family && <SidebarSubagents opened={opened} sessionKey={familyKey} tabId={tab?.id ?? null} />}
			</Fragment>
		);
	};

	if (error && rows.length === 0) {
		return (
			<InlineNotice
				action={
					<Button onClick={() => refresh(true)} size="sm" variant="ghost">
						{t("common.retry")}
					</Button>
				}
				className="px-2.5 py-1.5"
				detail={error}
				live
				title={t("sidebar.loadFailed")}
				tone="danger"
			/>
		);
	}
	if (isLoading && rows.length === 0) {
		return (
			<div aria-label={t("sidebar.loading")} className="flex justify-center py-2" role="status">
				<Spinner size="sm" />
			</div>
		);
	}
	if (rows.length === 0 && groups.length === 0) {
		return (
			<p className="px-2.5 py-1.5 text-sc-xs text-(--sc-text-muted)" data-device-empty>
				{query ? t("sidebar.noMatch") : t("remote.sidebar.empty")}
			</p>
		);
	}
	const dialog = (
		<>
			<ConfirmDialog
				busy={deleting}
				message={
					pendingDelete
						? t("remote.sidebar.deleteMessage", {
								name: sessionDisplayTitle(pendingDelete, t("sidebar.untitled")),
								device: host.name,
							})
						: ""
				}
				onCancel={() => setPendingDelete(null)}
				onConfirm={() => {
					if (pendingDelete) void confirmDelete(pendingDelete);
				}}
				open={pendingDelete !== null}
				title={t("sidebar.deleteConfirm")}
			/>
			{rowMenu && (
				<ContextMenu
					ariaLabel={rowMenu.label}
					items={rowMenu.items.map(item => ({
						...item,
						onSelect: modifiers => {
							setRowMenu(null);
							item.onSelect(modifiers);
						},
					}))}
					onClose={() => setRowMenu(null)}
					x={rowMenu.x}
					y={rowMenu.y}
				/>
			)}
		</>
	);
	return (
		<div className="space-y-px">
			{reorder.status}
			{dialog}
			<DndContext collisionDetection={closestCenter} onDragEnd={onGroupDragEnd} sensors={groupSensors}>
				<SortableContext items={groups.map(group => group.cwd)} strategy={verticalListSortingStrategy}>
					{groups.map(group => {
						const groupCollapsed = !query && deviceGroupFolds[deviceGroupKey(host.deviceId, group.cwd)] === true;
						const FolderIcon = groupCollapsed ? Folder : FolderOpen;
						const name = basename(group.cwd) || group.cwd;
						const groupIndex = query ? -1 : groups.indexOf(group);
						const groupItems: ContextMenuItem[] = [
							...(groupIndex === -1
								? []
								: [
										{
											id: "group-move-up",
											label: t("sidebar.menu.moveUp"),
											icon: ArrowUp,
											disabled: groupIndex <= 0,
											onSelect: () => moveGroup(group.cwd, -1),
										},
										{
											id: "group-move-down",
											label: t("sidebar.menu.moveDown"),
											icon: ArrowDown,
											disabled: groupIndex >= groups.length - 1,
											onSelect: () => moveGroup(group.cwd, 1),
										},
									]),
							{
								id: "remove",
								separatorBefore: groupIndex !== -1,
								label: t("sidebar.menu.removeProject"),
								icon: FolderMinus,
								onSelect: () => void useSidebarProjects.getState().remove(host.deviceId, group.cwd),
							},
						];
						return (
							<SortableProject className="" disabled={query.length > 0} id={group.cwd} key={group.cwd}>
								{dragHandle => (
									<div data-device-group={group.cwd} data-project-missing={group.missing ? "" : undefined}>
										<div
											className="group/head flex h-8 items-center rounded-(--sc-radius-md) hover:bg-(--sc-hover)"
											onContextMenu={event =>
												setRowMenu({ ...anchorFromEvent(event), items: groupItems, label: name })
											}
											{...dragHandle}
										>
											<SidebarFoldButton
												className={group.missing ? "text-(--sc-text-subtle)" : "text-(--sc-text-muted)"}
												data-roving-item={`device-group:${host.deviceId}:${group.cwd}`}
												onClick={() =>
													useSidebarFolds
														.getState()
														.setDeviceGroupFolded(host.deviceId, group.cwd, !groupCollapsed)
												}
												tabIndex={-1}
												title={group.missing ? `${group.cwd}\n${t("sidebar.project.missing")}` : group.cwd}
												folded={groupCollapsed}
												icon={<FolderIcon aria-hidden className="size-(--sc-icon-sm) shrink-0" />}
											>
												<span className="min-w-0 flex-1 truncate">{name}</span>
												{group.missing && <span className="sr-only">, {t("sidebar.project.missing")}</span>}
											</SidebarFoldButton>
											<IconButton
												className="omp-sidebar-project-menu pointer-events-none text-(--sc-text-subtle) opacity-0 transition-opacity duration-(--sc-duration-fast) group-focus-within/head:pointer-events-auto group-focus-within/head:opacity-100 group-hover/head:pointer-events-auto group-hover/head:opacity-100 hover:text-(--sc-text) [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"
												icon={<MoreHorizontal />}
												label={t("sidebar.groupMenu")}
												onClick={event => {
													const rect = event.currentTarget.getBoundingClientRect();
													setRowMenu({ x: rect.left, y: rect.bottom + 4, items: groupItems, label: name });
												}}
												size="sm"
												tabIndex={-1}
											/>
											<IconButton
												className="mr-1 text-(--sc-text-subtle) hover:text-(--sc-text)"
												data-device-group-new={group.cwd}
												disabled={group.missing}
												icon={<Plus />}
												label={t("sidebar.menu.newAgentHere")}
												onClick={() => void onOpen({ cwd: group.cwd, kind: "agent" })}
												size="sm"
												tabIndex={-1}
											/>
										</div>
										{!groupCollapsed && (
											<div className="space-y-px">
												{group.sessions.map(session => renderRow(session))}
												<SidebarLooseChildren
													foldKey={`device-group:${host.deviceId}:${group.cwd}`}
													opened={group.folded.map(familyChildFor)}
												/>
											</div>
										)}
									</div>
								)}
							</SortableProject>
						);
					})}
				</SortableContext>
			</DndContext>
			{(chats.length > 0 || !query) && (
				<SidebarChats
					canAdd={read}
					count={chats.length}
					deviceId={host.deviceId}
					filtering={query.length > 0}
					label={t("sidebar.chatsOn", { name: host.name })}
					newChatData={{ "data-sidebar-device-new-chat": host.deviceId }}
					newChatLabel={t("remote.sidebar.newChat", { name: host.name })}
					onNewChat={onNewChat}
				>
					{chats.map(session => renderRow(session))}
				</SidebarChats>
			)}
		</div>
	);
}
