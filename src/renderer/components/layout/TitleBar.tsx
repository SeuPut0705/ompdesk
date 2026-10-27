import {
	AlertTriangle,
	BarChart3,
	ChevronRight,
	Circle,
	FolderOpen,
	GitBranch,
	GitFork,
	Info,
	ListTree,
	Menu,
	MoreHorizontal,
	PanelLeft,
	PanelRight,
	Pencil,
	Rocket,
	Share2,
	Wrench,
	XCircle,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import type { SessionInfo } from "../../../shared/ipc-types";
import { worktreeLabel } from "../../../shared/project-origin";
import type { SessionStats } from "../../../shared/rpc-types";
import { useAutoTitle } from "../../hooks/use-auto-title";
import { useCurrentSessionTitle } from "../../hooks/use-current-session-title";
import { useSessionAttention } from "../../hooks/use-session-attention";
import { useSessionList } from "../../hooks/use-session-list";
import { useDrawerMode } from "../../hooks/use-shell-mode";
import { ATTENTION_LABEL_KEY, sessionWorking } from "../../lib/attention";
import { cx, formatCost, formatDuration, formatPercent, formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { actionKbd, onEscape } from "../../lib/keymap";
import { useNowTick } from "../../lib/now-tick";
import { useProjectNames, useWorktreeKindLabels } from "../../lib/project-origin";
import { sessionForkOrigin } from "../../lib/session-fork";
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
import { AutoTitleButton } from "../common/AutoTitleButton";
import { SwapText } from "../common/SwapText";
import { WorkspaceDialog } from "../dialogs/WorkspaceDialog";
import { DeviceChip } from "../remote/DeviceChip";
import { ForkParent } from "./ForkParent";
import { sessionCacheHitPercent, sessionExecutionDurationMs } from "./session-metrics";

/** `pending`: the connection is coming up or back (starting, waiting, reconnecting): a still hollow dot, never a spinner. */
type StatusTone = "ready" | "busy" | "pending" | "attention" | "error";

function StatusIcon({ tone }: { tone: StatusTone }) {
	if (tone === "busy")
		return (
			<span aria-hidden className="inline-flex">
				<Spinner size="sm" spin />
			</span>
		);
	if (tone === "pending")
		return <Circle aria-hidden className="size-2 fill-transparent text-(--sc-text-muted)" strokeWidth={3} />;
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
	// Only live (pending/running) calls keep the clock alive; history-aborted
	// calls never end and are finished entries.
	const now = useNowTick(isStreaming || liveTools.size > 0);
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
 * Title bar of the session view: sidebar toggle (when the
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
	const attention = useSessionAttention();
	const isChat = useActiveTabKind() === "chat";
	// A remote tab names its host; while the link is down the tab is reconnecting,
	// not failed. A host that is gone from the device list (unpaired) never comes back.
	const device = useTabsStore(s => s.tabs.find(tab => tab.id === tabId)?.device);
	const host = useHostView(device);
	const remoteLoaded = useRemoteStore(s => s.state !== null);
	// Unknown before the device list loads: no host is not "removed" and not "reconnecting" yet. The chip is
	// a pending state, not an alarm, so it names a dropped link at once (the pane's banner waits out the grace).
	const unpaired = device !== undefined && remoteLoaded && host === undefined;
	const reconnecting = host !== undefined && host.state !== "online";
	const statsMessageCount = useMessagesStore(s => s.messages.length);
	const sidebarVisible = useUiStore(s => s.sidebarVisible);
	const drawer = useDrawerMode();
	const panelVisible = useUiStore(s => s.panelVisible);
	const keymapOverrides = useUiStore(s => s.keymapOverrides);
	const groupAliases = useSidebarPrefs(s => s.groupAliases);
	// Global, not "local": the row is found by id either way, and sharing the
	// sidebar's feed saves a second sessions.list per change. "local" filters by
	// the focused tab's cwd, which a split pane in another project doesn't share.
	const { sessions } = useSessionList("global");
	// A paired host's folders are not on this computer: git here cannot tell about them.
	const projectNameOf = useProjectNames(
		useMemo(() => (!isChat && cwd && device === undefined ? [cwd] : []), [isChat, cwd, device]),
	);
	const kindLabels = useWorktreeKindLabels();
	const shown = projectNameOf(!isChat && cwd ? cwd : "");
	const worktreeLabelText = shown.worktree ? worktreeLabel(shown.worktree, kindLabels) : null;
	const projectName =
		!isChat && cwd ? (groupAliases[cwd] ?? shown.worktree?.project ?? shown.name) : t("sidebar.chats");

	const [editingName, setEditingName] = useState(false);
	const workspaceOpen = useUiStore(s => s.projectPickerOpen);
	const [statusOpen, setStatusOpen] = useState(false);
	const [draft, setDraft] = useState("");
	const [stats, setStats] = useState<SessionStats | null>(null);
	const nameInputRef = useRef<HTMLInputElement>(null);
	const autoTitle = useAutoTitle(tabRpc.regenerateSessionTitle);
	const autoTitleErrorId = useId();
	const generated = useRef(false);
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
	// A fork says where it came from beside its name (stock's `parentSession`), like its sidebar row.
	const sessionsByPathOrId = useMemo(() => {
		const index = new Map<string, SessionInfo>();
		for (const session of sessions) {
			index.set(session.path, session);
			index.set(session.id, session);
		}
		return index;
	}, [sessions]);
	const fork = current ? sessionForkOrigin(current, sessionsByPathOrId) : null;
	const displayName = useCurrentSessionTitle();
	const visibleStats = stats?.sessionId === sessionId ? stats : null;
	const cost = visibleStats ? (visibleStats.history?.cost ?? visibleStats.cost) : null;
	const tokens = visibleStats ? (visibleStats.history?.totalTokens ?? visibleStats.tokens.total) : null;
	const cacheHit = sessionCacheHitPercent(visibleStats);

	const commitName = () => {
		// The omp saved a generated title: a blur on the field's way out must not save the draft over it.
		if (generated.current) return;
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
		autoTitle.clearError();
		generated.current = false;
		setEditingName(true);
	};
	// The omp saves the title it makes; the title bar only shows it and leaves the editor.
	const regenerateName = async () => {
		const originSession = sessionRuntimeStore<SessionStore>(tabId, "session") ?? useSessionStore;
		const originId = originSession.getState().sessionId;
		const title = await autoTitle.run();
		if (!title) return;
		if (originSession.getState().sessionId === originId) originSession.setState({ sessionName: title });
		setDraft(title);
		generated.current = true;
		setEditingName(false);
	};

	const working = useSessionStore(sessionWorking);
	// Another omp still holds the session: the tab opens it by itself, a wait like connecting, not a failure.
	const sessionHeld = useSessionStore(s => s.sidecarHeld);
	// The session's own state (connecting, restarting, failed, exited) outranks what it needs from the person: a
	// question on a session that is not up cannot be answered there, as the tray already says.
	const [tone, statusLabel]: [StatusTone, string] = unpaired
		? ["error", t("remote.tab.statusRemoved")]
		: reconnecting
			? ["pending", t("remote.tab.statusReconnecting")]
			: status === "starting"
				? ["pending", t("titlebar.status.connecting")]
				: status === "waiting"
					? ["pending", t("titlebar.status.waiting")]
					: status === "restarting"
						? ["pending", t("titlebar.status.restarting")]
						: status === "error" && sessionHeld
							? ["pending", t("titlebar.status.sessionHeld")]
							: status === "error" || status === "exited"
								? ["error", t(`titlebar.status.${status}`)]
								: attention
									? ["attention", t(ATTENTION_LABEL_KEY[attention.kind])]
									: working
										? ["busy", t("titlebar.status.working")]
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
					icon={drawer ? <Menu /> : <PanelLeft />}
					label={t(drawer ? "shell.openMenu" : "titlebar.toggleSidebar")}
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
					content={
						cwd && !isChat ? `${t("titlebar.switchProject")} · ${shown.tooltip}` : t("titlebar.switchProject")
					}
					describe={false}
					side="bottom"
				>
					<Button
						className="omp-titlebar-project min-w-12 max-w-48 shrink-[4]! px-2 font-normal text-(--sc-text-muted) hover:text-(--sc-text)"
						disabled={isStreaming}
						onClick={() => useUiStore.getState().openProjectPicker()}
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
				{worktreeLabelText !== null && (
					<>
						{/* A worktree reads as its project › what it is for (the folder name never shows). */}
						<Tooltip content={shown.tooltip} describe={false} side="bottom">
							<span
								className="omp-titlebar-worktree flex min-w-0 max-w-40 shrink-[3] items-center gap-1 px-1 text-sc-sm text-(--sc-text-muted)"
								data-titlebar-worktree=""
							>
								{/* An Autopilot run is its rocket alone (the user's call, 23 Oct 2026), its word for screen readers. */}
								{shown.worktree?.worktree?.kind === "autopilot" ? (
									<>
										<Rocket aria-hidden className="size-(--sc-icon-sm) shrink-0" />
										<span className="sr-only">{worktreeLabelText}</span>
									</>
								) : (
									<>
										<GitBranch aria-hidden className="size-(--sc-icon-sm) shrink-0" />
										<span className="truncate">{worktreeLabelText}</span>
									</>
								)}
							</span>
						</Tooltip>
						<ChevronRight
							aria-hidden
							className="omp-titlebar-crumb-sep size-(--sc-icon-sm) shrink-0 text-(--sc-text-subtle)"
						/>
					</>
				)}
				{/* The window's main heading for a screen reader's heading navigation: the session's name (the visible name is
				    the rename button, whose accessible name says so). */}
				<h1 className="sr-only" data-titlebar-heading="">
					{displayName}
				</h1>
				{editingName ? (
					<div className="relative w-72 min-w-0">
						<Input
							aria-describedby={autoTitle.error ? autoTitleErrorId : undefined}
							aria-invalid={autoTitle.error ? true : undefined}
							aria-label={t("titlebar.rename")}
							controlSize="sm"
							onBlur={commitName}
							onChange={event => {
								setDraft(event.target.value);
								autoTitle.clearError();
							}}
							onKeyDown={event => {
								if (isImeKeyEvent(event)) return;
								if (event.key === "Enter") commitName();
								onEscape(event, () => setEditingName(false));
							}}
							readOnly={autoTitle.pending}
							ref={nameInputRef}
							trailing={
								<AutoTitleButton
									onClick={() => void regenerateName()}
									pending={autoTitle.pending}
									unavailableReason={status === "ready" ? undefined : t("sidecar.notResponding")}
								/>
							}
							value={draft}
						/>
						{autoTitle.error && (
							// Under the field, over the page: the bar keeps its height.
							<p
								className="absolute top-full left-0 z-20 mt-1 max-w-full rounded-(--sc-radius-sm) border border-(--sc-border-subtle) bg-(--sc-elevated) px-2 py-1 text-sc-sm text-(--sc-danger) shadow-(--sc-shadow-md)"
								data-auto-title-error=""
								id={autoTitleErrorId}
								role="alert"
							>
								{autoTitle.error}
							</p>
						)}
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
							<SwapText className="truncate text-sc-md" scope={sessionId ?? ""}>
								{displayName}
							</SwapText>
						</Button>
					</Tooltip>
				)}
				{fork && !editingName && (
					<Tooltip content={fork.tooltip} describe={false} side="bottom">
						<span
							aria-label={fork.tooltip}
							className="flex min-w-0 max-w-64 shrink items-center text-(--sc-text-subtle) [&>svg]:size-(--sc-icon-sm) [&>svg]:shrink-0"
							data-titlebar-fork=""
							role="note"
							tabIndex={-1}
						>
							<GitFork aria-hidden />
							{fork.parentTitle && <ForkParent name={fork.parentTitle} />}
						</span>
					</Tooltip>
				)}
			</nav>

			<div
				aria-live="polite"
				className="omp-titlebar-status no-drag flex min-w-0 shrink-0 items-center px-1.5"
				data-tone={tone}
				aria-label={statusLabel}
				role="status"
				title={statusLabel}
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
					data-tour="panel"
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
			<WorkspaceDialog onClose={() => useUiStore.getState().closeProjectPicker()} open={workspaceOpen} />
		</header>
	);
}
