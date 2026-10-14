import {
	AlertTriangle,
	BarChart3,
	ChevronRight,
	Circle,
	FolderOpen,
	GitBranch,
	Info,
	ListTree,
	MoreHorizontal,
	PanelLeft,
	PanelRight,
	Pencil,
	Share2,
	Wrench,
	XCircle,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { SessionStats } from "../../../shared/rpc-types";
import { useAwaitedInput } from "../../hooks/use-awaited-input";
import { useSessionList } from "../../hooks/use-session-list";
import { basename, cx, formatCost, formatDuration, formatPercent, formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { actionKbd, onEscape } from "../../lib/keymap";
import { useTabRpc } from "../../lib/tab-rpc";
import { useMessagesStore } from "../../stores/messages";
import { useHostView, useRemoteStore } from "../../stores/remote";
import { type SessionStore, useSessionStore } from "../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../stores/session-runtime-context";
import { useSidebarPrefs } from "../../stores/sidebar-prefs";
import { useActiveTabKind, useTabsStore } from "../../stores/tabs";
import { toastError } from "../../stores/toast";
import { useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import {
	Badge,
	Button,
	type ContextMenuItem,
	IconButton,
	Input,
	MenuButton,
	Popover,
	Spinner,
	Tooltip,
} from "../common";
import { WorkspaceDialog } from "../dialogs/WorkspaceDialog";
import { DeviceChip } from "../remote/DeviceChip";
import { sessionCacheHitPercent, sessionExecutionDurationMs } from "./session-metrics";

type StatusTone = "ready" | "busy" | "attention" | "error";

function StatusIcon({ tone }: { tone: StatusTone }) {
	if (tone === "busy")
		return (
			<span aria-hidden className="inline-flex">
				<Spinner size="sm" />
			</span>
		);
	if (tone === "attention") return <AlertTriangle aria-hidden className="size-(--sc-icon-sm) text-(--sc-warning)" />;
	if (tone === "error") return <XCircle aria-hidden className="size-(--sc-icon-sm) text-(--sc-danger)" />;
	return <Circle aria-hidden className="size-2 fill-current text-(--sc-success)" />;
}

/**
 * The session's state beside its name, spelled like the sidebar row: needs
 * approval and failures are the same warning/danger badges the row shows;
 * working keeps the row's spinner; ready stays quiet (dot + muted word).
 */
function StatusPill({ tone, label }: { tone: StatusTone; label: string }) {
	if (tone === "attention" || tone === "error") {
		return (
			<Badge className="omp-titlebar-status-badge gap-1" variant={tone === "attention" ? "warning" : "error"}>
				<StatusIcon tone={tone} />
				<span className="omp-titlebar-status-label">{label}</span>
			</Badge>
		);
	}
	return (
		<span
			className={cx(
				"flex items-center gap-1.5 text-sc-sm",
				tone === "busy" ? "text-(--sc-text-secondary)" : "text-(--sc-text-muted)",
			)}
		>
			<StatusIcon tone={tone} />
			<span className="omp-titlebar-status-label">{label}</span>
		</span>
	);
}

function StatRow({ label, hint, value }: { label: string; hint?: string; value: ReactNode }) {
	return (
		<div className="flex items-baseline justify-between gap-6 py-1.5">
			<dt className="min-w-0">
				<span className="block text-sc-sm text-(--sc-text-secondary)">{label}</span>
				{hint && <span className="block text-sc-xs text-(--sc-text-muted)">{hint}</span>}
			</dt>
			<dd className="shrink-0 text-sc-sm font-medium tabular-nums text-(--sc-text)">{value}</dd>
		</div>
	);
}

/**
 * Execution time of the session. Mounted only while the status popover is
 * open (Popover unmounts closed content), so the bar itself never subscribes
 * to the tools store or re-runs the range merge on every tool event.
 */
function ExecutionDurationRow() {
	const t = useT();
	const isStreaming = useSessionStore(s => s.isStreaming);
	const awaitingModelSince = useSessionStore(s => s.awaitingModelSince);
	const messages = useMessagesStore(s => s.messages);
	const streamingMessage = useMessagesStore(s => s.streamingMessage);
	const liveTools = useToolsStore(s => s.liveTools);
	const finishedTools = useToolsStore(s => s.finishedTools);
	const finishedVersion = useToolsStore(s => s.finishedVersion);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the finished map changes in place; its version marks each change.
	const tools = useMemo(
		() => [...liveTools.values(), ...finishedTools.values()],
		[liveTools, finishedTools, finishedVersion],
	);
	const [now, setNow] = useState(() => Date.now());
	// Only live (pending/running) calls keep the clock alive; history-aborted
	// calls never end and are finished entries.
	const hasRunningTool = liveTools.size > 0;
	const ticking = isStreaming || hasRunningTool;
	useEffect(() => {
		setNow(Date.now());
		if (!ticking) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [ticking]);
	const executionDuration = sessionExecutionDurationMs({
		messages,
		streamingMessage,
		tools,
		awaitingModelSince,
		isStreaming,
		now,
	});
	return (
		<StatRow
			label={t("sessionStatus.duration")}
			value={executionDuration > 0 ? formatDuration(executionDuration) : t("time.secondsShort", { count: 0 })}
		/>
	);
}

/**
 * Title bar of the session view (design-spec §2.3): sidebar toggle (when the
 * sidebar is hidden) · project / session breadcrumb with inline rename ·
 * status as text · Session status popover · session menu · side panel toggle.
 * Model and run controls live beside the composer, where they affect the
 * next message.
 */
export function TitleBar() {
	const tabRpc = useTabRpc();
	const t = useT();
	const tabId = useRuntimeTabId();
	const sessionId = useSessionStore(s => s.sessionId);
	const sessionName = useSessionStore(s => s.sessionName);
	const cwd = useSessionStore(s => s.cwd);
	const status = useSessionStore(s => s.status);
	const isStreaming = useSessionStore(s => s.isStreaming);
	const isCompacting = useSessionStore(s => s.isCompacting);
	const statsPulse = useSessionStore(s => s.statsPulse);
	const awaiting = useAwaitedInput();
	const isChat = useActiveTabKind() === "chat";
	// A remote tab names its host; while the link is down the tab is reconnecting,
	// not failed. A host that is gone from the device list (unpaired) never comes back.
	const device = useTabsStore(s => s.tabs.find(tab => tab.id === tabId)?.device);
	const host = useHostView(device);
	const remoteLoaded = useRemoteStore(s => s.state !== null);
	// Same rule as the pane's RemoteTabBanner: unknown before the device list loads.
	const unpaired = device !== undefined && remoteLoaded && host === undefined;
	const reconnecting = device !== undefined && !unpaired && host?.state !== "online";
	const statsMessageCount = useMessagesStore(s => s.messages.length);
	const sidebarVisible = useUiStore(s => s.sidebarVisible);
	const panelVisible = useUiStore(s => s.panelVisible);
	const keymapOverrides = useUiStore(s => s.keymapOverrides);
	const groupAliases = useSidebarPrefs(s => s.groupAliases);
	// Global, not "local": the row is found by id either way, and sharing the
	// sidebar's feed saves a second sessions.list per change. "local" filters by
	// the focused tab's cwd, which a split pane in another project doesn't share.
	const { sessions } = useSessionList("global");
	const projectName = !isChat && cwd ? (groupAliases[cwd] ?? basename(cwd)) : t("sidebar.chats");

	const [editingName, setEditingName] = useState(false);
	const [workspaceOpen, setWorkspaceOpen] = useState(false);
	const [statusOpen, setStatusOpen] = useState(false);
	const [draft, setDraft] = useState("");
	const [stats, setStats] = useState<SessionStats | null>(null);
	const nameInputRef = useRef<HTMLInputElement>(null);
	const statusAnchorRef = useRef<HTMLButtonElement>(null);
	// A settled transcript append and a fresh sidecar snapshot are the two things
	// that can move these figures. Mid-run appends come several times a turn, so
	// only the pulse may re-queue a stats command there — the serial command queue
	// has to stay free for the agent's own traffic.
	const statsTrigger = isStreaming ? `streaming:${statsPulse}` : `idle:${statsMessageCount}:${statsPulse}`;
	const prevSessionRef = useRef<string | null>(null);

	useEffect(() => {
		if (editingName) nameInputRef.current?.select();
	}, [editingName]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the settled transcript and the snapshot pulse both refresh the cost figures even when the session ID is stable.
	useEffect(() => {
		if (!sessionId || status !== "ready") {
			setStats(null);
			prevSessionRef.current = null;
			return;
		}
		// Cross-session staleness is the bug: session A's tokens/cost must never
		// display over session B. Within ONE session, keeping the previous read
		// while the refetch is in flight beats a clear-refetch flicker on every
		// message append; the session-id guard rejects mismatched responses.
		if (prevSessionRef.current !== sessionId) setStats(null);
		prevSessionRef.current = sessionId;
		// Compaction rewrites the journal, so a reading taken mid-shake is noise.
		if (isCompacting) return;
		let cancelled = false;
		const requestedSessionId = sessionId;
		const originSession = sessionRuntimeStore<SessionStore>(tabId, "session") ?? useSessionStore;
		void tabRpc
			.getSessionStats()
			.then(response => {
				if (!cancelled && response.success && originSession.getState().sessionId === requestedSessionId) {
					setStats(response.data as SessionStats);
				}
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [sessionId, statsTrigger, status, tabRpc.getSessionStats, tabId, isCompacting]);

	const current = sessions.find(s => s.id === sessionId);
	// `||` everywhere: empty-string titles (never-generated auto-title slot)
	// fall through like null, ending at the "New session" placeholder.
	const displayName = sessionName || current?.title || t("sidebar.newSession");
	const visibleStats = stats?.sessionId === sessionId ? stats : null;
	const cost = visibleStats ? (visibleStats.history?.cost ?? visibleStats.cost) : null;
	const tokens = visibleStats ? (visibleStats.history?.totalTokens ?? visibleStats.tokens.total) : null;
	const cacheHit = sessionCacheHitPercent(visibleStats);

	const commitName = () => {
		const name = draft.trim();
		setEditingName(false);
		if (!name || name === displayName) return;
		const originSession = sessionRuntimeStore<SessionStore>(tabId, "session") ?? useSessionStore;
		const originId = originSession.getState().sessionId;
		void tabRpc
			.setSessionName(name)
			.then(response => {
				if (response.success) {
					if (originSession.getState().sessionId === originId) originSession.setState({ sessionName: name });
				} else renameFailed(response.error);
			})
			.catch(renameFailed);
	};
	const renameFailed = (cause: unknown) => {
		toastError({ title: t("titlebar.renameFailed"), error: cause });
	};
	const startRename = () => {
		setDraft(sessionName ?? current?.title ?? "");
		setEditingName(true);
	};

	const working = isStreaming || isCompacting;
	const [tone, statusLabel]: [StatusTone, string] = unpaired
		? ["error", t("remote.tab.statusRemoved")]
		: reconnecting
			? ["busy", t("remote.tab.statusReconnecting")]
			: awaiting
				? ["attention", t(awaiting === "approval" ? "titlebar.status.needsApproval" : "titlebar.status.needsInput")]
				: working
					? ["busy", t("titlebar.status.working")]
					: status === "ready"
						? ["ready", t("titlebar.status.ready")]
						: status === "starting"
							? ["busy", t("titlebar.status.connecting")]
							: status === "restarting"
								? ["busy", t("titlebar.status.restarting")]
								: status === "error" || status === "exited"
									? ["error", t(`titlebar.status.${status}`)]
									: ["ready", t(`titlebar.status.${status}`)];

	const ui = useUiStore.getState;
	const sessionMenuItems: ContextMenuItem[] = [
		{ id: "rename", label: t("titlebar.rename"), icon: Pencil, onSelect: startRename },
		{
			id: "branch",
			label: t("cmd.branch"),
			description: t("cmd.branch.desc"),
			icon: GitBranch,
			onSelect: () => ui().openBranchPicker(),
		},
		{
			id: "tree",
			label: t("cmd.tree"),
			description: t("cmd.tree.desc"),
			icon: ListTree,
			onSelect: () => ui().openSessionTree(),
		},
		{
			id: "share",
			label: t("cmd.share"),
			description: t("cmd.share.desc"),
			icon: Share2,
			onSelect: () => ui().openShareSession(),
		},
		{
			id: "tools",
			label: t("cmd.tools"),
			description: t("cmd.tools.desc"),
			icon: Wrench,
			onSelect: () => ui().openActiveTools(),
		},
		{
			id: "import",
			label: t("cmd.import"),
			description: t("cmd.import.desc"),
			icon: FolderOpen,
			onSelect: () => ui().openImportDialog(),
		},
		{
			id: "insights",
			label: t("sessionStatus.openInsights"),
			icon: BarChart3,
			onSelect: () => ui().openInsights("stats", "session"),
		},
	];

	return (
		<header className="omp-titlebar omp-topbar drag-region flex h-12 min-w-0 shrink-0 items-center gap-1 px-3">
			{!sidebarVisible && (
				<IconButton
					className="no-drag"
					icon={<PanelLeft />}
					label={t("titlebar.toggleSidebar")}
					onClick={() => ui().toggleSidebar()}
					shortcut={actionKbd("sidebar.toggle", keymapOverrides)}
				/>
			)}

			<nav aria-label={t("titlebar.breadcrumb")} className="omp-titlebar-identity no-drag flex min-w-0 items-center">
				{device !== undefined && (
					<span className="mr-1 flex shrink-0 items-center">
						<DeviceChip deviceId={device} />
					</span>
				)}
				<Tooltip
					content={cwd && !isChat ? `${t("titlebar.switchProject")} · ${cwd}` : t("titlebar.switchProject")}
					describe={false}
					side="bottom"
				>
					<Button
						className="omp-titlebar-project min-w-12 max-w-48 shrink-[4]! px-2 font-normal text-(--sc-text-muted) hover:text-(--sc-text)"
						disabled={isStreaming}
						onClick={() => setWorkspaceOpen(true)}
						size="sm"
						title={isStreaming ? t("titlebar.abortHint") : undefined}
						variant="ghost"
					>
						<span className="truncate">{projectName}</span>
					</Button>
				</Tooltip>
				<ChevronRight
					aria-hidden
					className="omp-titlebar-crumb-sep size-(--sc-icon-sm) shrink-0 text-(--sc-text-subtle)"
				/>
				{editingName ? (
					<div className="w-72 min-w-0">
						<Input
							aria-label={t("titlebar.rename")}
							controlSize="sm"
							onBlur={commitName}
							onChange={event => setDraft(event.target.value)}
							onKeyDown={event => {
								if (isImeKeyEvent(event)) return;
								if (event.key === "Enter") commitName();
								onEscape(event, () => setEditingName(false));
							}}
							ref={nameInputRef}
							value={draft}
						/>
					</div>
				) : (
					<Tooltip content={`${displayName} · ${t("titlebar.rename")}`} describe={false} side="bottom">
						<Button
							className="min-w-0 max-w-96 shrink! px-2 font-semibold text-(--sc-text)"
							data-titlebar-session-name=""
							aria-label={`${t("titlebar.rename")}: ${displayName}`}
							onClick={startRename}
							size="sm"
							variant="ghost"
						>
							<span className="truncate text-sc-md">{displayName}</span>
						</Button>
					</Tooltip>
				)}
			</nav>

			<div
				aria-live="polite"
				className="omp-titlebar-status no-drag flex min-w-0 shrink-0 items-center px-1.5"
				data-tone={tone}
				role="status"
			>
				<StatusPill label={statusLabel} tone={tone} />
			</div>

			<div className="flex-1" />

			<div className="no-drag flex shrink-0 items-center gap-0.5">
				<Button
					aria-expanded={statusOpen}
					aria-haspopup="dialog"
					aria-label={t("sessionStatus.trigger", { cost: formatCost(cost, 2) })}
					className="omp-session-status-trigger gap-1.5 px-2 font-normal text-(--sc-text-muted) tabular-nums hover:text-(--sc-text)"
					icon={<Info />}
					onClick={() => setStatusOpen(open => !open)}
					ref={statusAnchorRef}
					size="sm"
					variant="ghost"
				>
					{/* A zero or unknown spend is noise in the bar; the popover still spells it out. */}
					{cost ? <span className="omp-session-status-cost">{formatCost(cost, 2)}</span> : null}
				</Button>
				<MenuButton align="end" icon={<MoreHorizontal />} items={sessionMenuItems} label={t("titlebar.actions")} />
				<IconButton
					icon={<PanelRight />}
					label={t("titlebar.sidePanel")}
					onClick={() => ui().togglePanel()}
					pressed={panelVisible}
					shortcut={actionKbd("panel.toggle", keymapOverrides)}
				/>
			</div>

			<Popover
				anchorRef={statusAnchorRef}
				ariaLabel={t("sessionStatus.title")}
				className="w-80 max-w-[calc(100vw-2rem)] p-4"
				onClose={() => setStatusOpen(false)}
				open={statusOpen}
				placement="bottom-end"
			>
				<div className="flex items-center justify-between gap-3 pb-3">
					<span className="text-sc-md font-semibold text-(--sc-text)">{t("sessionStatus.title")}</span>
					<StatusPill tone={tone} label={statusLabel} />
				</div>
				{visibleStats ? (
					<dl className="border-y border-(--sc-divider) py-1">
						<StatRow
							hint={visibleStats.history ? t("sessionStatus.historyHint") : undefined}
							label={t("sessionStatus.tokens")}
							value={formatTokens(tokens)}
						/>
						<StatRow label={t("sessionStatus.cost")} value={formatCost(cost, 4)} />
						<StatRow label={t("sessionStatus.cache")} value={formatPercent(cacheHit, 0)} />
						<ExecutionDurationRow />
					</dl>
				) : (
					<p className="border-y border-(--sc-divider) py-3 text-sc-sm text-(--sc-text-muted)">
						{t("sessionStatus.unavailable")}
					</p>
				)}
				<Button
					className="mt-3 w-full justify-start"
					icon={<BarChart3 />}
					onClick={() => {
						setStatusOpen(false);
						ui().openInsights("stats", "session");
					}}
					size="sm"
					variant="ghost"
				>
					{t("sessionStatus.openInsights")}
				</Button>
			</Popover>
			<WorkspaceDialog onClose={() => setWorkspaceOpen(false)} open={workspaceOpen} />
		</header>
	);
}
