/**
 * Sidebar sections for paired hosts (remote devices). Each host gets a header
 * — name, link dot, ⌄ toggle, "Add project" — over its projects and sessions,
 * grouped like the local list (Code: by project folder; Chat: one recency
 * list). An offline host shows one offline line and no sessions; its list is
 * only read while the link is up. Opening a row reuses the tab already
 * attached to it, else opens a remote tab; "Add project" browses the host's
 * disk with the remote folder picker.
 */
import {
	ChevronDown,
	ChevronRight,
	FileArchive,
	Folder,
	FolderMinus,
	FolderOpen,
	FolderPlus,
	MessageCircle,
	Monitor,
	MoreHorizontal,
	Plus,
	Trash2,
	X,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useStore } from "zustand";
import type { HostView, SessionInfo, SessionKind } from "../../../../shared/ipc-types";
import { splitTabIds } from "../../../../shared/split-layout";
import { useSessionList } from "../../../hooks/use-session-list";
import { useShellInput } from "../../../hooks/use-shell-mode";
import { saveDiagnosticBundle } from "../../../lib/diagnostic-bundle";
import { hideNativeDragImage } from "../../../lib/drag-image";
import { basename, cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { inChatLane, sessionDisplayTitle, sessionHasContent } from "../../../lib/session-title";
import { deviceGroupKey, LOCAL_DEVICE } from "../../../lib/sidebar-memory";
import { tabSignalPresentation } from "../../../lib/tab-signal";
import { pickRemoteDirectory } from "../../../stores/remote";
import { sessionListFeed } from "../../../stores/session-list";
import { useSidebarFolds } from "../../../stores/sidebar-folds";
import { useProjectList, useSidebarProjects } from "../../../stores/sidebar-projects";
import { type SessionTab, tabChipLabel, useTabsStore } from "../../../stores/tabs";
import { toast, toastError } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import { Button, IconButton, InlineNotice, ListRow, Spinner } from "../../common";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { anchorFromEvent, ContextMenu, type ContextMenuItem, type MenuSelectModifiers } from "../../common/ContextMenu";
import { TabLiveAge, TabLiveTitle } from "../SessionLiveTitle";
import { useHostWorkspace } from "./host-workspace";
import { useDeviceHeaderHandle } from "./SidebarDeviceSections";

export type SidebarDeviceMode = "code" | "chat";

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
 * the end, the button that opens or makes a project folder on that device. This device's and every host's alike. */
function DeviceHeader({
	deviceId,
	folded,
	name,
	children,
	canAdd = true,
	onAdd,
	local,
}: {
	deviceId: string;
	folded: boolean;
	name: string;
	children?: ReactNode;
	canAdd?: boolean;
	onAdd: () => void;
	/** This device's header (`data-sidebar-device-header="local"`); a host's sits in its `[data-device-state]` section. */
	local?: boolean;
}) {
	const t = useT();
	const handle = useDeviceHeaderHandle();
	const Chevron = folded ? ChevronRight : ChevronDown;
	return (
		<div
			className="group/device flex h-8 items-center rounded-(--sc-radius-md) hover:bg-(--sc-hover)"
			data-sidebar-device-header={local ? "local" : undefined}
		>
			<button
				{...handle}
				aria-expanded={!folded}
				className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-(--sc-radius-md) pr-1 pl-2 text-left text-sc-xs font-medium text-(--sc-text-muted) outline-none select-none [-webkit-touch-callout:none] hover:text-(--sc-text) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--sc-focus-ring)"
				data-roving-item={`device:${deviceId}`}
				data-sidebar-device-toggle={deviceId}
				onClick={() => useSidebarFolds.getState().setDeviceFolded(deviceId, !folded)}
				tabIndex={-1}
				type="button"
			>
				<Monitor aria-hidden className="size-(--sc-icon-sm) shrink-0" />
				<span className="min-w-0 truncate">{name}</span>
				{children}
				<Chevron aria-hidden className="size-(--sc-icon-sm) shrink-0" />
			</button>
			<IconButton
				className="mr-1 text-(--sc-text-subtle) hover:text-(--sc-text)"
				data-sidebar-device-add={deviceId}
				disabled={!canAdd}
				icon={<FolderPlus />}
				label={t("remote.sidebar.addProject", { name })}
				onClick={onAdd}
				size="sm"
				tabIndex={-1}
			/>
		</div>
	);
}

/** The header over this device's own list, shown only once a host is paired: it folds the list and, like a host's
 * header, ends in the button that opens or makes a project folder here (the search row's own button then gives way). */
export function SidebarLocalHeader({ onAddProject }: { onAddProject: () => void }) {
	const t = useT();
	const folded = useSidebarFolds(s => s.devices[LOCAL_DEVICE] === true);
	return (
		<DeviceHeader
			deviceId={LOCAL_DEVICE}
			folded={folded}
			local
			name={t("remote.sidebar.thisDevice")}
			onAdd={onAddProject}
		/>
	);
}

export function SidebarDeviceSection({
	host,
	mode,
	query,
	nested,
	pending = false,
}: {
	host: HostView;
	mode: SidebarDeviceMode;
	query: string;
	/** Tab ids and session files of sessions a session of this computer opened here: they are rows of its family. */
	nested?: ReadonlySet<string>;
	/** A host the last host-list read named, drawn before this launch's first read: still, as it will look. */
	pending?: boolean;
}) {
	const t = useT();
	const collapsed = useSidebarFolds(s => s.devices[host.deviceId] === true);
	const online = host.state === "online";
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
				canAdd={online}
				deviceId={host.deviceId}
				folded={collapsed}
				name={host.name}
				onAdd={() =>
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
						className="shrink-0 rounded-(--sc-radius-sm) bg-(--sc-hover) px-1 text-sc-2xs text-(--sc-text-subtle)"
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
						host={host}
						mode={mode}
						nested={nested}
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
	mode,
	query,
	nested,
	onOpen,
	read,
}: {
	host: HostView;
	mode: SidebarDeviceMode;
	query: string;
	nested: ReadonlySet<string> | undefined;
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
	const hostTabs = useMemo(
		() => allTabs.filter(tab => tab.device === host.deviceId && !nested?.has(tab.id)),
		[allTabs, host.deviceId, nested],
	);

	// The host's own lane rule (Sidebar.tsx): a session in its no-project workspace (`~/.omp/work`, where a session
	// opened there without a folder starts) sits in its Chat lane, so it does here too.
	const hostWorkspace = useHostWorkspace(host.deviceId, read);
	// The host's own project list: its empty projects show here too, and one removed there (or here) is gone from both.
	const projectList = useProjectList(host.deviceId, read);

	const rows = useMemo<DeviceSession[]>(() => {
		// A file stock wrote before the first message is not a conversation yet (see Sidebar).
		const listed = sessions.filter(session => sessionHasContent(session) && !nested?.has(session.path));
		const listedPaths = new Set(listed.map(session => session.path));
		const listedIds = new Set(listed.map(session => session.id));
		const now = new Date().toISOString();
		const live: DeviceSession[] = hostTabs
			.filter(
				tab =>
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
		const needle = query.toLocaleLowerCase();
		return [...listed, ...live]
			.filter(session => inChatLane(session, hostWorkspace) === (mode === "chat"))
			.filter(
				session =>
					!needle ||
					sessionDisplayTitle(session, "").toLocaleLowerCase().includes(needle) ||
					session.cwd.toLocaleLowerCase().includes(needle),
			)
			.toSorted((a, b) => createdAt(b) - createdAt(a));
	}, [sessions, hostTabs, host.deviceId, mode, query, nested, hostWorkspace]);

	const groups = useMemo(() => {
		if (mode === "chat") return [];
		const removed = new Set(projectList.removed);
		const held = new Set(hostTabs.flatMap(tab => [tab.sessionPath, tab.sessionId].filter(Boolean)));
		const byCwd = new Map<string, DeviceSession[]>();
		for (const session of rows) {
			// A linked worktree's session is a row of its project (the host's git says which), never a project of its own.
			const project = projectList.worktrees[session.cwd] ?? session.cwd;
			// A project removed from the sidebar takes its sessions with it, unless a tab holds one.
			if (
				removed.has(project) &&
				session.liveTabId === undefined &&
				!held.has(session.path) &&
				!held.has(session.id)
			)
				continue;
			const list = byCwd.get(project) ?? [];
			list.push(session);
			byCwd.set(project, list);
		}
		const result = [...byCwd.entries()].map(([cwd, groupSessions]) => ({
			cwd,
			sessions: groupSessions,
			missing: false,
		}));
		const needle = query.toLocaleLowerCase();
		// The list's projects with no session to show, newest first after the ones that have; a filter keeps one whose
		// folder name matches.
		for (const project of projectList.projects.toSorted((a, b) => b.addedAt - a.addedAt)) {
			const shown = result.find(group => group.cwd === project.path);
			if (shown) shown.missing = project.missing === true;
			else if (!needle || project.path.toLocaleLowerCase().includes(needle))
				result.push({ cwd: project.path, sessions: [], missing: project.missing === true });
		}
		return result;
	}, [rows, mode, projectList, query, hostTabs]);

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

	// Like the local list (Sidebar.tsx): the tab showing the session closes first, then main waits for the host's
	// omp to let go of the file and the host deletes it (its own `sessions.delete`).
	const confirmDelete = async (session: DeviceSession) => {
		if (tabFor(session)?.status === "running") {
			toast({ variant: "warning", message: t("sidebar.menu.taskRunning") });
			setPendingDelete(null);
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
			toastError({ title: t("sidebar.deleteFailed"), error: cause });
		} finally {
			setDeleting(false);
		}
	};

	const renderRow = (session: DeviceSession) => {
		const tab = tabFor(session);
		const signal = tab ? tabSignalPresentation(tab) : null;
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
				running={signal?.running === true && tab?.awaitingInput === undefined}
				settling={tab?.settling === true}
				tabId={tab?.id ?? null}
				waiting={tab?.awaitingInput !== undefined}
			/>
		);
		// A row the host has not written to disk yet has no file to delete; closing its tab is all there is.
		const deletable = !session.path.startsWith("tab:") && !signal?.running;
		const closeSession = () => {
			if (tab) void useTabsStore.getState().closeTab(tab.id);
		};
		const menuItems: ContextMenuItem[] = [
			...(tab ? [{ id: "close", label: t("sidebar.menu.closeSession"), icon: X, onSelect: closeSession }] : []),
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
		return (
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
				buttonProps={{ tabIndex: -1, "data-roving-item": `device-session:${host.deviceId}:${session.path}` }}
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
					// Dragged onto a session pane, the open tab joins the split there (SplitWorkspace takes `omp:tab-drag`).
					draggable: tab !== undefined && !current,
					onDragStart: event => {
						if (!tab) return;
						event.dataTransfer.effectAllowed = "move";
						hideNativeDragImage(event.dataTransfer);
						window.dispatchEvent(new CustomEvent("omp:tab-drag", { detail: { tabId: tab.id } }));
					},
					onDragEnd: () => window.dispatchEvent(new CustomEvent("omp:tab-drag", { detail: { tabId: null } })),
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
							running={signal?.running === true && tab?.awaitingInput === undefined}
							settling={tab?.settling === true}
							tabId={tab?.id ?? null}
							text={title}
							waiting={tab?.awaitingInput !== undefined}
						/>
						{signal?.running && <span className="sr-only">, {t("sidebar.signal.running")}</span>}
						{openElsewhere && !signal?.running && <span className="sr-only">, {t("sidebar.row.open")}</span>}
					</>
				}
				titleText={[title, openElsewhere && !signal?.running ? t("sidebar.row.open") : null]
					.filter(Boolean)
					.join("\n")}
			/>
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
	if (mode === "chat") {
		return (
			<div className="space-y-px">
				{rows.map(session => renderRow(session))}
				{dialog}
			</div>
		);
	}
	return (
		<div className="space-y-px">
			{dialog}
			{groups.map(group => {
				const groupCollapsed = !query && deviceGroupFolds[deviceGroupKey(host.deviceId, group.cwd)] === true;
				const FolderIcon = groupCollapsed ? Folder : FolderOpen;
				const name = basename(group.cwd) || group.cwd;
				const groupItems: ContextMenuItem[] = [
					{
						id: "remove",
						label: t("sidebar.menu.removeProject"),
						icon: FolderMinus,
						onSelect: () => void useSidebarProjects.getState().remove(host.deviceId, group.cwd),
					},
				];
				return (
					<div data-device-group={group.cwd} data-project-missing={group.missing ? "" : undefined} key={group.cwd}>
						<div
							className="group/head flex h-8 items-center rounded-(--sc-radius-md) hover:bg-(--sc-hover)"
							onContextMenu={event => setRowMenu({ ...anchorFromEvent(event), items: groupItems, label: name })}
						>
							<button
								aria-expanded={!groupCollapsed}
								className={cx(
									"flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-(--sc-radius-md) pr-1 pl-2 text-left text-sc-sm font-medium outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--sc-focus-ring)",
									group.missing ? "text-(--sc-text-subtle)" : "text-(--sc-text-muted)",
								)}
								data-roving-item={`device-group:${host.deviceId}:${group.cwd}`}
								onClick={() =>
									useSidebarFolds.getState().setDeviceGroupFolded(host.deviceId, group.cwd, !groupCollapsed)
								}
								tabIndex={-1}
								title={group.missing ? `${group.cwd}\n${t("sidebar.project.missing")}` : group.cwd}
								type="button"
							>
								{groupCollapsed ? (
									<ChevronRight aria-hidden className="size-(--sc-icon-sm) shrink-0" />
								) : (
									<ChevronDown aria-hidden className="size-(--sc-icon-sm) shrink-0" />
								)}
								<FolderIcon aria-hidden className="size-(--sc-icon-sm) shrink-0" />
								<span className="min-w-0 flex-1 truncate">{name}</span>
								{group.missing && <span className="sr-only">, {t("sidebar.project.missing")}</span>}
							</button>
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
							<div className="space-y-px">{group.sessions.map(session => renderRow(session))}</div>
						)}
					</div>
				);
			})}
		</div>
	);
}
