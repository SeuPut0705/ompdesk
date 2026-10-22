/**
 * Sidebar sections for paired hosts (remote devices). Each host gets a header
 * — name, link dot, ⌄ toggle, its Add project button — over its projects and then
 * its Chats section, like the local list. An offline host shows one offline line
 * and no sessions; its list is only read while the link is up. Opening a row
 * reuses the tab already attached to it, else opens a remote tab; Add project
 * browses the host's disk with the remote folder picker, the Chats section's
 * button starts a chat on the host.
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
	Settings2,
	Trash2,
	X,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useStore } from "zustand";
import { ipcErrorCode } from "../../../../shared/ipc-error-codes";
import type { HostView, SessionInfo, SessionKind } from "../../../../shared/ipc-types";
import { splitTabIds } from "../../../../shared/split-layout";
import { useSessionList } from "../../../hooks/use-session-list";
import { useShellInput } from "../../../hooks/use-shell-mode";
import { DEVICE_COLORS, type DeviceColorChoice, deviceColorOf } from "../../../lib/device-color";
import { saveDiagnosticBundle } from "../../../lib/diagnostic-bundle";
import { hideNativeDragImage } from "../../../lib/drag-image";
import { basename, cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { isChatSession, sessionDisplayTitle, sessionHasContent } from "../../../lib/session-title";
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
import {
	anchorFromEvent,
	ContextMenu,
	type ContextMenuItem,
	MenuButton,
	type MenuSelectModifiers,
} from "../../common/ContextMenu";
import { TabLiveAge, TabLiveTitle } from "../SessionLiveTitle";
import { useHostWorkspace } from "./host-workspace";
import { SidebarChats } from "./SidebarChats";
import { useDeviceHeaderHandle } from "./SidebarDeviceSections";

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
	onAction,
	local,
}: {
	deviceId: string;
	folded: boolean;
	name: string;
	children?: ReactNode;
	canAct?: boolean;
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
				className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-(--sc-radius-md) pr-1 pl-2 text-left text-sc-xs font-medium text-(--sc-text-muted) outline-none select-none [-webkit-touch-callout:none] hover:text-(--sc-text) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--sc-focus-ring)"
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
	pending = false,
	onNewChat,
}: {
	host: HostView;
	query: string;
	/** Tab ids and session files of sessions a session of this computer opened here: they are rows of its family. */
	nested?: ReadonlySet<string>;
	/** A host the last host-list read named, drawn before this launch's first read: still, as it will look. */
	pending?: boolean;
	/** The sidebar's own New chat, started on this host. */
	onNewChat: (device: string) => void;
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
				canAct={online}
				deviceId={host.deviceId}
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
	onNewChat,
	onOpen,
	read,
}: {
	host: HostView;
	query: string;
	nested: ReadonlySet<string> | undefined;
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
	const hostTabs = useMemo(
		() => allTabs.filter(tab => tab.device === host.deviceId && !nested?.has(tab.id)),
		[allTabs, host.deviceId, nested],
	);

	// The host's own rule (Sidebar.tsx): a session in its no-project workspace (`~/.omp/work`, where a session opened
	// there without a folder starts) is one of its chats, so it is here too.
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
			.filter(
				session =>
					!needle ||
					sessionDisplayTitle(session, "").toLocaleLowerCase().includes(needle) ||
					session.cwd.toLocaleLowerCase().includes(needle),
			)
			.toSorted((a, b) => createdAt(b) - createdAt(a));
	}, [sessions, hostTabs, host.deviceId, query, nested]);
	const chats = useMemo(() => rows.filter(session => isChatSession(session, hostWorkspace)), [rows, hostWorkspace]);

	const groups = useMemo(() => {
		const removed = new Set(projectList.removed);
		const held = new Set(hostTabs.flatMap(tab => [tab.sessionPath, tab.sessionId].filter(Boolean)));
		const byCwd = new Map<string, DeviceSession[]>();
		for (const session of rows) {
			if (isChatSession(session, hostWorkspace)) continue;
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
	}, [rows, projectList, query, hostTabs, hostWorkspace]);

	// What the host works on now (its windows' tabs, the tabs it runs for any device): a row no tab here holds still
	// wears the working cue, without a tap to open it first.
	const hostLive = useMemo(
		() => new Map(host.live?.map(session => [session.sessionPath, session.state])),
		[host.live],
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
		const signal = tab ? tabSignalPresentation(tab) : null;
		const live = tab ? undefined : hostLive.get(session.path);
		const waiting = tab ? tab.awaitingInput !== undefined : live === "waiting";
		const running = tab ? signal?.running === true && !waiting : live === "turn" || live === "background";
		const settling = tab ? tab.settling === true : live === "background";
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
			{(chats.length > 0 || !query) && (
				<SidebarChats
					canAdd={read}
					count={chats.length}
					deviceId={host.deviceId}
					filtering={query.length > 0}
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
