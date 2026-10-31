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
	Archive,
	ArrowDown,
	ArrowUp,
	ChevronDown,
	ChevronRight,
	ExternalLink,
	Folder,
	FolderMinus,
	FolderOpen,
	FolderPlus,
	MessageCircle,
	Monitor,
	MoreHorizontal,
	Pin,
	Plus,
	Settings2,
} from "lucide-react";
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { reviewUnmerged } from "../../../../shared/agent-control";
import { openBotDecisions } from "../../../../shared/bot-desk";
import { ipcErrorCode } from "../../../../shared/ipc-error-codes";
import type { HostView, SessionKind } from "../../../../shared/ipc-types";
import { CHATS_ORDER_KEY, type RowSession, sidebarRows } from "../../../../shared/sidebar-rows";
import { splitTabIds } from "../../../../shared/split-layout";
import { useSessionList } from "../../../hooks/use-session-list";
import { useShellInput } from "../../../hooks/use-shell-mode";
import { DEVICE_COLORS, type DeviceColorChoice, deviceColorOf } from "../../../lib/device-color";
import { saveDiagnosticBundle } from "../../../lib/diagnostic-bundle";
import { basename, cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { openExternal } from "../../../lib/open-external";
import { hostOrderKey, moveInOrder, reorderProjects } from "../../../lib/project-order";
import { botDisplayName, sessionDisplayTitle, sessionHasContent } from "../../../lib/session-title";
import { deviceGroupKey, LOCAL_DEVICE } from "../../../lib/sidebar-memory";
import { tabSignalPresentation } from "../../../lib/tab-signal";
import { pickWorkspaceDirectory } from "../../../lib/workspace-dirs";
import { useAgentReviewStore } from "../../../stores/agent-review";
import { ensureBotDesk, releaseBotDesk, useBotDesk } from "../../../stores/bot-desk";
import { pickRemoteDirectory } from "../../../stores/remote";
import type { SessionStore } from "../../../stores/session";
import { sessionListFeed } from "../../../stores/session-list";
import { sessionRuntimeStore } from "../../../stores/session-runtime-context";
import { useSidebarFolds } from "../../../stores/sidebar-folds";
import { useSidebarPrefs } from "../../../stores/sidebar-prefs";
import { useProjectList, useSidebarProjects } from "../../../stores/sidebar-projects";
import { type SessionTab, tabChipLabel, useTabsStore } from "../../../stores/tabs";
import { toast, toastError } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import { webPwa } from "../../../web/pwa";
import { BotAvatar } from "../../bot/BotAvatar";
import { BotDecisionsBadge } from "../../bot/BotDecisionsBadge";
import { Button, IconButton, InlineNotice, ListRow, Spinner } from "../../common";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { anchorFromEvent, ContextMenu, type ContextMenuItem, MenuButton } from "../../common/ContextMenu";
import { TimeAgo } from "../../common/TimeAgo";
import { TabLiveAge, TabLiveTitle } from "../SessionLiveTitle";
import { useHostWorkspace } from "./host-workspace";
import { SidebarChats } from "./SidebarChats";
import { useDeviceHeaderHandle } from "./SidebarDeviceSections";
import { SidebarFoldButton } from "./SidebarFoldButton";
import { SidebarRenameField } from "./SidebarRenameField";
import { type FamilyOpened, SidebarLooseChildren, SidebarSubagents, SidebarSubagentsToggle } from "./SidebarSubagents";
import { SortableProject } from "./SortableProject";
import { sessionMenuItems } from "./session-menu";
import { canMoveWithin, type SessionList, useSessionReorder } from "./session-reorder";
import { CHILD_TOKEN, openedChildStatus } from "./sidebar-family";

const NO_OPENED: readonly FamilyOpened[] = [];

/** A host row: an indexed remote session, or an open remote tab the host has not listed yet. */
type DeviceSession = RowSession;

const NO_PATHS: ReadonlySet<string> = new Set();

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
	badge,
}: {
	deviceId: string;
	folded: boolean;
	name: string;
	children?: ReactNode;
	/** The host's state dot, drawn on the glyph's corner. */
	badge?: ReactNode;
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
				{/* The state dot rides the glyph's corner: beside the name it cost the name ~14 px and "Build server in the
				    office closet" lost its last word at rest. */}
				<span className="relative flex shrink-0">
					<Monitor aria-hidden className="size-(--sc-icon-sm) shrink-0" data-device-glyph />
					{badge}
				</span>
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
				// A host's name ("Build server in the office") is longer than "This device": with a mouse its project
				// button shows with the gear, so the name keeps the room at rest. This device's stays, the only
				// project button once a host is paired.
				<span
					className={
						local
							? "contents"
							: "hidden group-focus-within/device:contents group-hover/device:contents [@media(hover:none)]:contents"
					}
				>
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
				</span>
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
		return useTabsStore.getState().openTab({ ...args, device: host.deviceId });
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
				badge={
					<span
						aria-hidden
						className={cx(
							"absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-(--omp-sidebar-bg)",
							pending && host.state !== "offline" ? "bg-(--sc-text-subtle)" : DOT_CLASS[host.state],
						)}
						data-device-dot
					/>
				}
				folded={collapsed}
				name={host.name}
				onAction={() =>
					void pickRemoteDirectory(host.deviceId).then(path => {
						if (path) void openRemote({ cwd: path, kind: "agent" });
					})
				}
			>
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
	onOpen: (args: RemoteOpenArgs) => Promise<string | null>;
	read: boolean;
}) {
	const t = useT();
	const { sessions, isLoading, error, refresh, deleteSession, renameSession } = useSessionList(
		"global",
		host.deviceId,
		{
			read,
		},
	);
	const [pendingDelete, setPendingDelete] = useState<DeviceSession | null>(null);
	const [deleting, setDeleting] = useState(false);
	// A finger has no hover, so Close and Delete would sit on every row for good: one ⋯ opens them as an action sheet
	// instead, as on this computer's own rows (Sidebar.tsx).
	const touchInput = useShellInput() === "touch";
	const [rowMenu, setRowMenu] = useState<{ x: number; y: number; items: ContextMenuItem[]; label: string } | null>(
		null,
	);
	// Where the open row menu stood: the Move to project… list opens in its place.
	const menuAnchor = useRef({ x: 0, y: 0 });
	const [moveMenu, setMoveMenu] = useState<{ session: DeviceSession; x: number; y: number } | null>(null);
	const [renamingPath, setRenamingPath] = useState<string | null>(null);
	const [renameDraft, setRenameDraft] = useState("");
	const allTabs = useTabsStore(state => state.tabs);
	const activeTabId = useTabsStore(state => state.activeTabId);
	const destination = useUiStore(state => state.destination);
	const split = useTabsStore(state => state.split);
	const splitIds = useMemo(() => (split ? new Set(splitTabIds(split)) : null), [split]);
	const deviceGroupFolds = useSidebarFolds(s => s.deviceGroups);
	// The order the person set for this host's projects and each of its lists, kept with this computer's own.
	const groupOrder = useSidebarPrefs(s => s.groupOrder);
	const sessionOrder = useSidebarPrefs(s => s.sessionOrder);
	// This host's pins and archive, kept in this computer's prefs under the host's id (`hostOrderKey`) beside the
	// order, so this computer's own pins and archive never move with it. The local pin's omp resume-list sync does
	// not apply to a host.
	const pinnedSessions = useSidebarPrefs(s => s.pinnedSessions);
	const archivedSessions = useSidebarPrefs(s => s.archivedSessions);
	const prefix = hostOrderKey(host.deviceId, "");
	const hostPins = useMemo(
		() => pinnedSessions.filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length)),
		[pinnedSessions, prefix],
	);
	const hostArchived = useMemo(
		() => new Set(archivedSessions.filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length))),
		[archivedSessions, prefix],
	);
	const deviceTabs = useMemo(() => allTabs.filter(tab => tab.device === host.deviceId), [allTabs, host.deviceId]);
	const hostTabs = useMemo(() => deviceTabs.filter(tab => !nested?.has(tab.id)), [deviceTabs, nested]);
	// The host's bot, marked in its list on or off: while on, one fixed row first, as on the host; on or off, never one
	// of the lists' rows, nor is a tab here holding it (it would come back as a plain chat once the host's bot is off).
	const hostBot = useMemo(() => sessions.find(session => session.bot === "on"), [sessions]);
	const botFiles = useMemo(
		() => new Set(sessions.flatMap(session => (session.bot === undefined ? [] : [session.path]))),
		[sessions],
	);
	const listed = useMemo(() => sessions.filter(session => !botFiles.has(session.path)), [sessions, botFiles]);
	// The host's desk gives its bot's row the count of decisions waiting; read once its link is up and its bot is on, and
	// again after each link loss, as a push sent meanwhile was missed.
	const hostBotOn = hostBot !== undefined;
	const hostDesk = useBotDesk(host.deviceId).desk;
	const hostDecisions = openBotDecisions(hostDesk).length;
	useEffect(() => {
		if (!read || !hostBotOn) return;
		ensureBotDesk(host.deviceId);
		return () => releaseBotDesk(host.deviceId);
	}, [read, hostBotOn, host.deviceId]);

	// The host's own rule (Sidebar.tsx): a session in its no-project workspace (`~/.omp/work`, where a session opened
	// there without a folder starts) is one of its chats, so it is here too.
	const hostWorkspace = useHostWorkspace(host.deviceId, read);
	// The host's own project list: its empty projects show here too, and one removed there (or here) is gone from both.
	const projectList = useProjectList(host.deviceId, read);

	// The host's rows by the host's own rule (`sidebarRows`): what the host says beside each row (`openedBySession`,
	// `heldOnHost`), what it works on now, its project list and what its git said of each folder (`worktrees`,
	// `worktreeKinds`, `autopilotRuns`, `gone`), and this computer's tabs on it. A device cannot ask the host's git or records. A row made
	// from a tab before the host lists its session keeps the time this section first saw the tab, as on the host.
	const liveSince = useRef(new Map<string, string>());
	const tree = useMemo(() => {
		const gone = new Set(projectList.gone ?? []);
		const since = liveSince.current;
		for (const id of since.keys()) if (!deviceTabs.some(tab => tab.id === id)) since.delete(id);
		let stamp = Date.now();
		return sidebarRows({
			sessions: listed,
			tabs: deviceTabs
				.filter(tab => !tab.sessionPath || !botFiles.has(tab.sessionPath))
				.map(tab => {
					let seenAt = since.get(tab.id);
					if (!seenAt) {
						seenAt = new Date(stamp++).toISOString();
						since.set(tab.id, seenAt);
					}
					return { ...tab, title: tab.title ?? tabChipLabel(tab, hostTabs), seenAt };
				}),
			usedThere: new Set(host.live?.map(session => session.sessionPath)),
			// The host names an opener beside a row its windows' tabs hold (then `heldOnHost`) or that its records say it
			// closed: a row no tab holds that names one is a closed child.
			closed: new Set(
				sessions.flatMap(session => (typeof session.openedBySession === "string" ? [session.path] : [])),
			),
			projects: projectList.projects,
			removed: projectList.removed,
			folder: cwd => {
				const project = projectList.worktrees[cwd];
				const kind = projectList.worktreeKinds?.[cwd];
				return {
					...(project === undefined ? {} : { project }),
					...(kind === undefined ? {} : { kind }),
					gone: gone.has(cwd),
				};
			},
			workspace: hostWorkspace,
			titleOf: session => sessionDisplayTitle(session, ""),
			hasContent: sessionHasContent,
			// The host's own reading of each worktree's branch: a run's children follow the run's row, keyed by the
			// main checkout and the run's name as on the host.
			runOf: session => {
				const run = projectList.autopilotRuns?.[session.cwd];
				const project = projectList.worktrees[session.cwd];
				return run && project ? { child: run.child, key: `${project}\n${run.run}` } : null;
			},
			archived: hostArchived,
			nested: nested ?? NO_PATHS,
			// Kept in this computer's prefs under the host's id, so this computer's own lists never move with it.
			order: {
				pinnedSessions: hostPins,
				pinnedGroups: [],
				groupOrder: groupOrder.filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length)),
				sessionOrder: list => sessionOrder[hostOrderKey(host.deviceId, list)],
			},
			query,
			nameOf: cwd => basename(cwd) || cwd,
		});
	}, [
		sessions,
		listed,
		botFiles,
		deviceTabs,
		hostTabs,
		host.live,
		host.deviceId,
		projectList,
		hostWorkspace,
		nested,
		groupOrder,
		sessionOrder,
		hostPins,
		hostArchived,
		prefix,
		query,
	]);
	const { chats, groups, children: familyChildrenOf, archived: archivedRows } = tree;
	const archivedOpen = useSidebarFolds(s => s.deviceArchived[host.deviceId] === true);
	const archivedShown = archivedOpen || query.length > 0;

	/** Moves a project of this host up or down; the other projects of every device keep their order. */
	const saveGroupOrder = (next: readonly string[]) => {
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
		if (chats.some(item => item.path === session.path))
			return { key: CHATS_ORDER_KEY, paths: stored(chats), pinned: hostPins };
		const group = groups.find(item => item.sessions.some(row => row.path === session.path));
		return group ? { key: group.cwd, paths: stored(group.sessions), pinned: hostPins } : null;
	};
	// Kept in this computer's prefs under the host's id, so this computer's own lists never move with it.
	const reorder = useSessionReorder({
		titleOf: path => {
			const found = tree.sessions.find(session => session.path === path);
			return found ? sessionDisplayTitle(found, "") : "";
		},
		save: (list, next) =>
			void useSidebarPrefs.getState().setSessionOrder(hostOrderKey(host.deviceId, list.key), [...next]),
	});
	const moveSession = (session: DeviceSession, delta: -1 | 1): boolean => {
		const list = listOf(session);
		const next = canMoveWithin(list, session.path, delta) && list && moveInOrder(list.paths, session.path, delta);
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
			status === "failed"
				? t("sidebar.row.failed")
				: status === "unmerged"
					? t("sidebar.family.readyToMerge")
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
							: status === "failed"
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

	/** Shows a new name in the title bar of the tab that holds the session, without waiting for the list to refresh. */
	const showName = (session: DeviceSession, name: string) => {
		const store = sessionRuntimeStore<SessionStore>(tabFor(session)?.id ?? null, "session");
		if (store?.getState().sessionId === session.id) store.setState({ sessionName: name });
	};
	const startRename = (session: DeviceSession) => {
		setRenameDraft(sessionDisplayTitle(session, ""));
		setRenamingPath(session.path);
	};
	const commitRename = (session: DeviceSession, value: string) => {
		setRenamingPath(null);
		const name = value.trim();
		if (!name || name === session.title) return;
		renameSession(session.path, name).then(
			() => showName(session, name),
			error => toastError({ title: t("sidebar.renameFailed"), error }),
		);
	};

	/** Open a stored session in a new tab placed beside the focused one (this computer's rule, Sidebar.tsx). */
	const openInSplit = async (session: DeviceSession) => {
		const anchorTabId = useTabsStore.getState().activeTabId;
		const opened = await onOpen({ cwd: session.cwd, sessionPath: session.path, kind: session.kind ?? "agent" });
		if (!opened || !anchorTabId || opened === anchorTabId) return;
		// openTab focused the new tab: bring the previous one back, then split the new one in beside it.
		await useTabsStore.getState().switchTab(anchorTabId);
		await useTabsStore.getState().splitTab(opened, "right");
	};

	/** Move a stored session's file to another project folder of the host (stock SessionManager.moveTo there). */
	const moveStoredSession = async (session: DeviceSession, target: string) => {
		setMoveMenu(null);
		try {
			const movedPath = await window.omp.sessions.move(session.path, target, host.deviceId);
			// Pins are kept by file path, which the move changed.
			const prefs = useSidebarPrefs.getState();
			const pinKey = hostOrderKey(host.deviceId, session.path);
			if (movedPath !== session.path && prefs.pinnedSessions.includes(pinKey)) {
				await prefs.toggleSessionPin(pinKey);
				await prefs.toggleSessionPin(hostOrderKey(host.deviceId, movedPath));
			}
			toast({ variant: "success", message: t("sidebar.moved", { name: basename(target) || target }) });
			refresh();
		} catch (error) {
			toastError({ title: t("sidebar.moveFailed"), error });
		}
	};
	const moveToOtherFolder = async (session: DeviceSession) => {
		try {
			const picked = await pickWorkspaceDirectory({
				title: t("sidebar.move.pickTitle"),
				buttonLabel: t("sidebar.move.pickButton"),
				device: host.deviceId,
			});
			if (picked && picked !== session.cwd) await moveStoredSession(session, picked);
		} catch (error) {
			toastError({ title: t("sidebar.moveFailed"), error });
		}
	};

	/** The row's menu: the one builder this computer's rows use (session-menu.ts), with what a host's row can do. */
	const menuFor = (session: DeviceSession): ContextMenuItem[] => {
		const tab = tabFor(session);
		const list = listOf(session);
		const signal = tab && tab.status !== "asleep" ? tabSignalPresentation(tab) : null;
		return sessionMenuItems({
			facts: {
				// A tab's row whose omp already names its file is the host's session as much as an indexed one: it can be
				// renamed and deleted there; one still on `tab:<id>` has no file.
				stored: !session.path.startsWith("tab:"),
				hasTab: tab !== undefined,
				busy: signal?.active === true,
				tabFocused: tab !== undefined && tab.id === activeTabId,
				tabInSplit: tab !== undefined && splitIds?.has(tab.id) === true,
				splitShown: splitIds !== null,
				canCloseTab: allTabs.length > 1,
				chat: session.kind === "chat",
				pinned: hostPins.includes(session.path),
				archived: hostArchived.has(session.id),
				agentHidden: false,
				canMoveUp: canMoveWithin(list, session.path, -1),
				canMoveDown: canMoveWithin(list, session.path, 1),
			},
			actions: {
				openSplit: () => void openInSplit(session),
				openWindow: () =>
					void window.omp.sessions
						.openInNewWindow({ sessionPath: session.path, cwd: session.cwd, device: host.deviceId })
						.then(
							ok => {
								if (!ok) toast({ variant: "error", message: t("sidebar.openFailed") });
							},
							error => toastError({ title: t("sidebar.openFailed"), error }),
						),
				...(tab
					? {
							splitTab: placement => {
								useUiStore.getState().closeDestination();
								void useTabsStore.getState().splitTab(tab.id, placement);
							},
							unsplit: () => void useTabsStore.getState().unsplit(tab.id),
							closeTab: () => void useTabsStore.getState().closeTab(tab.id),
						}
					: {}),
				rename: () => startRename(session),
				togglePin: () =>
					void useSidebarPrefs.getState().toggleSessionPin(hostOrderKey(host.deviceId, session.path)),
				...(list
					? {
							moveUp: () => void moveSession(session, -1),
							moveDown: () => void moveSession(session, 1),
						}
					: {}),
				moveToProject: () => setMoveMenu({ session, ...menuAnchor.current }),
				toggleArchive: () =>
					void useSidebarPrefs
						.getState()
						.setSessionsArchived([hostOrderKey(host.deviceId, session.id)], !hostArchived.has(session.id)),
				saveBundle: anonymized => {
					if (tab)
						void saveDiagnosticBundle({ tabId: tab.id, title: sessionDisplayTitle(session, "") }, anonymized);
				},
				remove: () => setPendingDelete(session),
			},
			t,
			altHint: !touchInput,
		});
	};

	const renderRow = (session: DeviceSession, bot = false) => {
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
		const title = bot
			? botDisplayName(session, t("sidebar.botBadge"))
			: sessionDisplayTitle(session, indexed ? t("sidebar.untitled") : t("sidebar.newSession"));
		if (renamingPath === session.path) {
			const rovingKey = `device-session:${host.deviceId}:${session.path}`;
			const stopRenaming = () => {
				setRenamingPath(null);
				// The field unmounts: the row takes focus back.
				requestAnimationFrame(() =>
					document.querySelector<HTMLElement>(`[data-roving-item="${CSS.escape(rovingKey)}"]`)?.focus(),
				);
			};
			return (
				<div className="omp-sidebar-session-rename grid content-center py-0.5 pr-1 pl-1" key={session.path}>
					<SidebarRenameField
						onCancel={stopRenaming}
						onChange={setRenameDraft}
						onCommit={(value, via) => {
							commitRename(session, value);
							if (via === "enter") stopRenaming();
						}}
						onGenerated={generated => {
							showName(session, generated);
							stopRenaming();
						}}
						tabId={tab?.id}
						value={renameDraft}
					/>
				</div>
			);
		}
		// No leading slot (the local rows' rule, Sidebar.tsx): the title starts at the group's content edge, a chat's
		// glyph sits at the end before the age, and a tab open elsewhere is said in words only.
		const openElsewhere = tab !== undefined && !current && !inVisibleSplit;
		const chat = session.kind === "chat" ? <MessageCircle aria-hidden className="size-(--sc-icon-sm)" /> : null;
		// This host's open decisions, on its bot's row only (the local row's rule, Sidebar.tsx): the host's own prompt
		// takes the slot first.
		const botDecisions = bot ? hostDecisions : 0;
		const age =
			botDecisions > 0 && !waiting ? (
				<BotDecisionsBadge count={botDecisions} />
			) : (
				<TabLiveAge
					iso={indexed ? session.modified : null}
					running={running}
					settling={settling}
					tabId={tab?.id ?? null}
					waiting={waiting}
				/>
			);
		const list = listOf(session);
		const pinned = hostPins.includes(session.path);
		const marker = bot ? (
			<BotAvatar avatar={hostDesk.identity.avatar} data-sidebar-bot label={t("sidebar.botBadge")} size="inline" />
		) : (
			(chat ?? (pinned ? <Pin aria-label={t("sidebar.pinned")} className="size-(--sc-icon-sm)" /> : null))
		);
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
					// The bot's fixed row has none: no rename, move or delete, as on the host.
					actions={
						bot ? undefined : (
							<IconButton
								data-sidebar-row-menu
								icon={<MoreHorizontal />}
								label={t("sidebar.sessionMenu")}
								onClick={event => {
									const rect = event.currentTarget.getBoundingClientRect();
									setRowMenu({ x: rect.left, y: rect.bottom + 4, items: menuFor(session), label: title });
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
							if (bot) return;
							// Alt+↑/↓ moves the row in its list, as on this computer's own rows.
							if (
								event.altKey &&
								(event.key === "ArrowUp" || event.key === "ArrowDown") &&
								moveSession(session, event.key === "ArrowUp" ? -1 : 1)
							)
								event.preventDefault();
							else if (event.key === "F2" && indexed) {
								event.preventDefault();
								startRename(session);
							}
						},
					}}
					className="omp-sidebar-session-row"
					key={session.path}
					meta={
						marker || age ? (
							<span className="inline-flex min-w-0 items-center gap-1.5">
								{marker}
								{age}
							</span>
						) : undefined
					}
					onClick={() => {
						// The count says a decision waits: its card above the composer opens and flashes.
						if (botDecisions > 0) useUiStore.getState().focusDockCard("decisions");
						openSession(session);
					}}
					rowProps={{
						// Dragged onto a session pane, the open tab joins the split there (SplitWorkspace takes `omp:tab-drag`);
						// dropped on a row of its own list it moves there.
						...(bot ? {} : reorder.rowDrag(session.path, list, tab ? { id: tab.id, shown: current } : undefined)),
						"data-device-session": session.path,
						"data-sidebar-bot-row": bot || undefined,
						"data-bot-decisions": botDecisions > 0 || undefined,
						onContextMenu: bot
							? undefined
							: event => setRowMenu({ ...anchorFromEvent(event), items: menuFor(session), label: title }),
						"data-active": active,
						"data-current": current || undefined,
						"data-pane-focus": (current && splitIds !== null) || undefined,
						"data-pane-shown": (active && !current && splitIds !== null) || undefined,
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
					titleText={[
						title,
						botDecisions > 0 ? t("sidebar.botDecisionsTip", { count: botDecisions }) : null,
						openElsewhere && !working ? t("sidebar.row.open") : null,
					]
						.filter(Boolean)
						.join("\n")}
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

	// The host's bot row, when it shows: a host whose only session is its bot is not empty.
	const botShown =
		hostBot !== undefined &&
		(!query ||
			botDisplayName(hostBot, t("sidebar.botBadge")).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
	if (error && tree.sessions.length === 0 && !botShown) {
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
	if (isLoading && tree.sessions.length === 0 && !botShown) {
		return (
			<div aria-label={t("sidebar.loading")} className="flex justify-center py-2" role="status">
				<Spinner size="sm" />
			</div>
		);
	}
	if (!botShown && chats.length === 0 && groups.length === 0 && archivedRows.length === 0) {
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
							menuAnchor.current = { x: rowMenu.x, y: rowMenu.y };
							setRowMenu(null);
							item.onSelect(modifiers);
						},
					}))}
					onClose={() => setRowMenu(null)}
					x={rowMenu.x}
					y={rowMenu.y}
				/>
			)}
			{moveMenu && (
				<ContextMenu
					ariaLabel={t("sidebar.menu.moveToProject")}
					items={[
						...tree.allGroups
							.filter(group => group.cwd !== moveMenu.session.cwd)
							.map(group => ({
								id: `move-${group.cwd}`,
								label: basename(group.cwd) || group.cwd,
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
					onClose={() => setMoveMenu(null)}
					x={moveMenu.x}
					y={moveMenu.y}
				/>
			)}
		</>
	);
	return (
		<div className="space-y-px">
			{reorder.status}
			{dialog}
			{botShown && hostBot && renderRow(hostBot, true)}
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
			{archivedRows.length > 0 && (
				<section className="mt-1" data-sidebar-archived={host.deviceId}>
					<div className="flex h-8 items-center rounded-(--sc-radius-md) hover:bg-(--sc-hover)">
						<SidebarFoldButton
							className="text-(--sc-text-muted)"
							data-roving-item={`device-archived:${host.deviceId}`}
							folded={!archivedShown}
							icon={<Archive aria-hidden className="size-(--sc-icon-sm) shrink-0" />}
							onClick={() => useSidebarFolds.getState().setDeviceArchivedOpen(host.deviceId, !archivedOpen)}
							tabIndex={-1}
						>
							<span className="min-w-0 flex-1 truncate">
								{t("sidebar.archived", { count: archivedRows.length })}
							</span>
						</SidebarFoldButton>
					</div>
					{archivedShown && (
						<div className="space-y-px" data-archived-list>
							{archivedRows.map(session => renderRow(session))}
						</div>
					)}
				</section>
			)}
		</div>
	);
}
