/**
 * Sidebar sections for paired hosts (remote devices). Each host gets a header
 * — name, link dot, ⌄ toggle, "Add project" — over its projects and sessions,
 * grouped like the local list (Code: by project folder; Chat: one recency
 * list). An offline host shows one offline line and no sessions; its list is
 * only read while the link is up. Opening a row reuses the tab already
 * attached to it, else opens a remote tab; "Add project" browses the host's
 * disk with the remote folder picker.
 */
import { ChevronDown, ChevronRight, Folder, FolderOpen, FolderPlus, MessageCircle, Monitor, Plus } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import type { HostView, SessionInfo, SessionKind } from "../../../../shared/ipc-types";
import { splitTabIds } from "../../../../shared/split-layout";
import { useSessionList } from "../../../hooks/use-session-list";
import { hideNativeDragImage } from "../../../lib/drag-image";
import { basename, cx, formatTimeAgo } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { sessionDisplayTitle, sessionHasContent } from "../../../lib/session-title";
import { tabSignalPresentation } from "../../../lib/tab-signal";
import { pickRemoteDirectory } from "../../../stores/remote";
import { type SessionTab, tabChipLabel, useTabsStore } from "../../../stores/tabs";
import { useUiStore } from "../../../stores/ui";
import { Button, IconButton, InlineNotice, ListRow, Spinner } from "../../common";

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

/** Local header over this device's own list, shown only once a host is paired. */
export function SidebarLocalHeader() {
	const t = useT();
	return (
		<h2
			className="flex h-7 items-center gap-1.5 px-2 text-sc-xs font-medium text-(--sc-text-muted)"
			data-sidebar-device-header="local"
		>
			<Monitor aria-hidden className="size-(--sc-icon-sm) shrink-0" />
			<span className="truncate">{t("remote.sidebar.thisDevice")}</span>
		</h2>
	);
}

export function SidebarDeviceSection({
	host,
	mode,
	query,
}: {
	host: HostView;
	mode: SidebarDeviceMode;
	query: string;
}) {
	const t = useT();
	const [collapsed, setCollapsed] = useState(false);
	const online = host.state === "online";
	const stateLabel = t(`remote.state.${host.state}`);

	const openRemote = async (args: RemoteOpenArgs) => {
		useUiStore.getState().closeDestination();
		await useTabsStore.getState().openTab({ ...args, device: host.deviceId });
	};

	return (
		<section
			aria-label={host.name}
			className="mt-3"
			data-device-state={host.state}
			data-sidebar-device={host.deviceId}
		>
			<div className="group/device flex h-8 items-center rounded-(--sc-radius-md) hover:bg-(--sc-hover)">
				<button
					aria-expanded={!collapsed}
					className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-(--sc-radius-md) pr-1 pl-2 text-left text-sc-xs font-medium text-(--sc-text-muted) outline-none hover:text-(--sc-text) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--sc-focus-ring)"
					data-roving-item={`device:${host.deviceId}`}
					data-sidebar-device-toggle={host.deviceId}
					onClick={() => setCollapsed(value => !value)}
					tabIndex={-1}
					type="button"
				>
					<Monitor aria-hidden className="size-(--sc-icon-sm) shrink-0" />
					<span className="min-w-0 truncate">{host.name}</span>
					<span aria-hidden className={cx("size-1.5 shrink-0 rounded-full", DOT_CLASS[host.state])} />
					<span className="sr-only">, {stateLabel}</span>
					{collapsed ? (
						<ChevronRight aria-hidden className="size-(--sc-icon-sm) shrink-0" />
					) : (
						<ChevronDown aria-hidden className="size-(--sc-icon-sm) shrink-0" />
					)}
				</button>
				<IconButton
					className="mr-1 text-(--sc-text-subtle) hover:text-(--sc-text)"
					data-sidebar-device-add={host.deviceId}
					disabled={!online}
					icon={<FolderPlus />}
					label={t("remote.sidebar.addProject", { name: host.name })}
					onClick={() =>
						void pickRemoteDirectory(host.deviceId).then(path => {
							if (path) void openRemote({ cwd: path, kind: "agent" });
						})
					}
					size="sm"
					tabIndex={-1}
				/>
			</div>
			{!collapsed &&
				(online ? (
					<DeviceSessions host={host} mode={mode} onOpen={openRemote} query={query} />
				) : (
					<p
						className="flex items-center gap-2 px-2.5 py-1.5 text-sc-xs text-(--sc-text-muted)"
						data-device-offline
					>
						{host.state === "connecting" ? (
							<>
								<Spinner size="sm" />
								{stateLabel}
							</>
						) : (
							t("remote.sidebar.offline")
						)}
					</p>
				))}
		</section>
	);
}

/** The host's list; mounted only while the link is up, so an offline host is never asked. */
function DeviceSessions({
	host,
	mode,
	query,
	onOpen,
}: {
	host: HostView;
	mode: SidebarDeviceMode;
	query: string;
	onOpen: (args: RemoteOpenArgs) => Promise<void>;
}) {
	const t = useT();
	const { sessions, isLoading, error, refresh } = useSessionList("global", host.deviceId);
	const allTabs = useTabsStore(state => state.tabs);
	const activeTabId = useTabsStore(state => state.activeTabId);
	const destination = useUiStore(state => state.destination);
	const split = useTabsStore(state => state.split);
	const splitIds = useMemo(() => (split ? new Set(splitTabIds(split)) : null), [split]);
	const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
	const hostTabs = useMemo(() => allTabs.filter(tab => tab.device === host.deviceId), [allTabs, host.deviceId]);

	const rows = useMemo<DeviceSession[]>(() => {
		// A file stock wrote before the first message is not a conversation yet (see Sidebar).
		const listed = sessions.filter(sessionHasContent);
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
			.filter(session => (mode === "chat" ? session.kind === "chat" : session.kind !== "chat"))
			.filter(
				session =>
					!needle ||
					sessionDisplayTitle(session, "").toLocaleLowerCase().includes(needle) ||
					session.cwd.toLocaleLowerCase().includes(needle),
			)
			.toSorted((a, b) => createdAt(b) - createdAt(a));
	}, [sessions, hostTabs, host.deviceId, mode, query]);

	const groups = useMemo(() => {
		if (mode === "chat") return [];
		const byCwd = new Map<string, DeviceSession[]>();
		for (const session of rows) {
			const list = byCwd.get(session.cwd) ?? [];
			list.push(session);
			byCwd.set(session.cwd, list);
		}
		return [...byCwd.entries()].map(([cwd, groupSessions]) => ({ cwd, sessions: groupSessions }));
	}, [rows, mode]);

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

	const renderRow = (session: DeviceSession, nested: boolean) => {
		const tab = tabFor(session);
		const signal = tab ? tabSignalPresentation(tab) : null;
		const current = tab !== undefined && tab.id === activeTabId;
		// Every pane of the split on screen reads as selected, like the local list (Sidebar.tsx); the focused one adds data-pane-focus.
		const inVisibleSplit = !current && tab !== undefined && splitIds?.has(tab.id) === true;
		const active = (current || inVisibleSplit) && destination === "session";
		const indexed = session.liveTabId === undefined;
		const title = sessionDisplayTitle(session, indexed ? t("sidebar.untitled") : t("sidebar.newSession"));
		const leading: ReactNode = signal?.running ? (
			<span aria-hidden className="inline-flex">
				<Spinner size="sm" />
			</span>
		) : session.kind === "chat" ? (
			<MessageCircle aria-hidden />
		) : (
			<span aria-hidden className="flex size-(--sc-icon-md) items-center justify-center">
				{tab && !current && !inVisibleSplit && (
					<span className="size-1.5 rounded-(--sc-radius-full) bg-(--sc-text-subtle)" />
				)}
			</span>
		);
		return (
			<ListRow
				buttonProps={{ tabIndex: -1, "data-roving-item": `device-session:${host.deviceId}:${session.path}` }}
				className={cx("omp-sidebar-session-row", nested && "omp-sidebar-session-nested")}
				key={session.path}
				leading={leading}
				meta={
					indexed ? (
						<time className="text-(--sc-text-subtle)" dateTime={session.modified}>
							{formatTimeAgo(session.modified)}
						</time>
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
					"data-active": active,
					"data-current": current || undefined,
					"data-pane-focus": (current && splitIds !== null) || undefined,
					"data-live": indexed ? undefined : true,
				}}
				selected={active}
				title={
					<>
						{title}
						{signal?.running && <span className="sr-only">, {t("sidebar.signal.running")}</span>}
					</>
				}
				titleText={title}
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
	if (rows.length === 0) {
		return (
			<p className="px-2.5 py-1.5 text-sc-xs text-(--sc-text-muted)" data-device-empty>
				{query ? t("sidebar.noMatch") : t("remote.sidebar.empty")}
			</p>
		);
	}
	if (mode === "chat") {
		return <div className="space-y-px">{rows.map(session => renderRow(session, false))}</div>;
	}
	return (
		<div className="space-y-px">
			{groups.map(group => {
				const groupCollapsed = !query && collapsedGroups[group.cwd] === true;
				const FolderIcon = groupCollapsed ? Folder : FolderOpen;
				return (
					<div data-device-group={group.cwd} key={group.cwd}>
						<div className="group/head flex h-8 items-center rounded-(--sc-radius-md) hover:bg-(--sc-hover)">
							<button
								aria-expanded={!groupCollapsed}
								className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-(--sc-radius-md) pr-1 pl-2 text-left text-sc-sm font-medium text-(--sc-text-muted) outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--sc-focus-ring)"
								data-roving-item={`device-group:${host.deviceId}:${group.cwd}`}
								onClick={() => setCollapsedGroups(prev => ({ ...prev, [group.cwd]: !groupCollapsed }))}
								tabIndex={-1}
								title={group.cwd}
								type="button"
							>
								{groupCollapsed ? (
									<ChevronRight aria-hidden className="size-(--sc-icon-sm) shrink-0" />
								) : (
									<ChevronDown aria-hidden className="size-(--sc-icon-sm) shrink-0" />
								)}
								<FolderIcon aria-hidden className="size-(--sc-icon-sm) shrink-0" />
								<span className="min-w-0 flex-1 truncate">{basename(group.cwd) || group.cwd}</span>
							</button>
							<IconButton
								className="mr-1 text-(--sc-text-subtle) hover:text-(--sc-text)"
								data-device-group-new={group.cwd}
								icon={<Plus />}
								label={t("sidebar.menu.newAgentHere")}
								onClick={() => void onOpen({ cwd: group.cwd, kind: "agent" })}
								size="sm"
								tabIndex={-1}
							/>
						</div>
						{!groupCollapsed && (
							<div className="space-y-px">{group.sessions.map(session => renderRow(session, true))}</div>
						)}
					</div>
				);
			})}
		</div>
	);
}
