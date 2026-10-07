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
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { SessionStats } from "../../../shared/rpc-types";
import { useAwaitingConfirmation } from "../../hooks/use-awaiting-confirmation";
import { useSessionList } from "../../hooks/use-session-list";
import { errorDetail } from "../../lib/error-detail";
import { basename, cx, formatCost, formatDuration, formatPercent, formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { actionKbd, onEscape } from "../../lib/keymap";
import { useTabRpc } from "../../lib/tab-rpc";
import { useMessagesStore } from "../../stores/messages";
import { type SessionStore, useSessionStore } from "../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../stores/session-runtime-context";
import { useSidebarPrefs } from "../../stores/sidebar-prefs";
import { useActiveTabKind } from "../../stores/tabs";
import { toast } from "../../stores/toast";
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
	const awaitingModelSince = useSessionStore(s => s.awaitingModelSince);
	const awaiting = useAwaitingConfirmation();
	const isChat = useActiveTabKind() === "chat";
	const messages = useMessagesStore(s => s.messages);
	const streamingMessage = useMessagesStore(s => s.streamingMessage);
	const tools = useToolsStore(s => s.activeTools);
	const sidebarVisible = useUiStore(s => s.sidebarVisible);
	const panelVisible = useUiStore(s => s.panelVisible);
	const keymapOverrides = useUiStore(s => s.keymapOverrides);
	const groupAliases = useSidebarPrefs(s => s.groupAliases);
	const { sessions } = useSessionList("local");
	const projectName = !isChat && cwd ? (groupAliases[cwd] ?? basename(cwd)) : t("sidebar.chats");

	const [editingName, setEditingName] = useState(false);
	const [workspaceOpen, setWorkspaceOpen] = useState(false);
	const [statusOpen, setStatusOpen] = useState(false);
	const [draft, setDraft] = useState("");
	const [stats, setStats] = useState<SessionStats | null>(null);
	const [now, setNow] = useState(() => Date.now());
	const nameInputRef = useRef<HTMLInputElement>(null);
	const statusAnchorRef = useRef<HTMLButtonElement>(null);
	const statsMessageCount = messages.length;
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

	const hasRunningTool = [...tools.values()].some(tool => tool.endTime === null);
	useEffect(() => {
		setNow(Date.now());
		if (!statusOpen || (!isStreaming && !hasRunningTool)) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [hasRunningTool, isStreaming, statusOpen]);

	const current = sessions.find(s => s.id === sessionId);
	// `||` everywhere: empty-string titles (never-generated auto-title slot)
	// fall through like null, ending at the "New session" placeholder.
	const displayName = sessionName || current?.title || t("sidebar.newSession");
	const visibleStats = stats?.sessionId === sessionId ? stats : null;
	const cost = visibleStats ? (visibleStats.history?.cost ?? visibleStats.cost) : null;
	const tokens = visibleStats ? (visibleStats.history?.totalTokens ?? visibleStats.tokens.total) : null;
	const cacheHit = sessionCacheHitPercent(visibleStats);
	const executionDuration = sessionExecutionDurationMs({
		messages,
		streamingMessage,
		tools,
		awaitingModelSince,
		isStreaming,
		now,
	});

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
		toast({
			variant: "error",
			title: t("titlebar.renameFailed"),
			message: t("toast.failedRetry"),
			detail: errorDetail(cause),
		});
	};
	const startRename = () => {
		setDraft(sessionName ?? current?.title ?? "");
		setEditingName(true);
	};

	const working = isStreaming || isCompacting;
	const [tone, statusLabel]: [StatusTone, string] = awaiting
		? ["attention", t("titlebar.status.needsApproval")]
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
			disabled: isChat,
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
		<header className="omp-titlebar omp-topbar drag-region flex h-12 min-w-0 shrink-0 items-center gap-1 px-2">
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
				className="w-72 p-3"
				onClose={() => setStatusOpen(false)}
				open={statusOpen}
				placement="bottom-end"
			>
				<div className="flex items-center gap-2 pb-2">
					<StatusIcon tone={tone} />
					<span className="text-sc-md font-semibold text-(--sc-text)">{statusLabel}</span>
				</div>
				{visibleStats ? (
					<dl className="divide-y divide-(--sc-divider) border-y border-(--sc-divider)">
						<StatRow
							hint={visibleStats.history ? t("sessionStatus.historyHint") : undefined}
							label={t("sessionStatus.tokens")}
							value={formatTokens(tokens)}
						/>
						<StatRow label={t("sessionStatus.cost")} value={formatCost(cost, 4)} />
						<StatRow label={t("sessionStatus.cache")} value={formatPercent(cacheHit, 0)} />
						<StatRow
							label={t("sessionStatus.duration")}
							value={
								executionDuration > 0 ? formatDuration(executionDuration) : t("time.secondsShort", { count: 0 })
							}
						/>
					</dl>
				) : (
					<p className="border-y border-(--sc-divider) py-3 text-sc-sm text-(--sc-text-muted)">
						{t("sessionStatus.unavailable")}
					</p>
				)}
				<Button
					className="mt-3 w-full"
					icon={<BarChart3 />}
					onClick={() => {
						setStatusOpen(false);
						ui().openInsights("stats", "session");
					}}
					size="sm"
					variant="secondary"
				>
					{t("sessionStatus.openInsights")}
				</Button>
			</Popover>
			<WorkspaceDialog onClose={() => setWorkspaceOpen(false)} open={workspaceOpen} />
		</header>
	);
}
