/**
 * Live subagents as child rows directly under their sidebar session row. Only
 * a session open in a tab has a roster (its runtime's subagents store);
 * closed sessions render nothing. Each group subscribes to its own tab's
 * stores, so a progress frame re-renders that group — never the whole sidebar.
 *
 * Only live subagents (running, pending, parked/idle) are listed: a row
 * disappears as soon as its subagent reaches a terminal state. The rows are
 * collapsed by default: the session row carries a disclosure (chevron + live
 * count) and the expanded state lives per session in the sidebar-subagents
 * store until the session has no live subagents left. Expanded rows hang off
 * a tree connector under the session icon, share the session row's look
 * (ListRow), are part of the sidebar's roving list (arrow keys) and open the
 * subagent's live transcript against the owning tab — not a second sidecar,
 * since the parent's omp is still writing that session file. A row dragged
 * onto a session pane (`omp:subagent-drag`, SplitWorkspace) or "Open in side
 * panel" shows that transcript in the side panel instead. Right-click (or
 * the menu key) offers Stop.
 */

import { Bot, ChevronRight, Pause } from "lucide-react";
import {
	memo,
	type DragEvent as ReactDragEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { SubagentSnapshot } from "../../../shared/rpc-types";
import { hideNativeDragImage } from "../../lib/drag-image";
import { cx, formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useNowTick } from "../../lib/now-tick";
import { useTabRpc } from "../../lib/tab-rpc";
import { useSessionStore } from "../../stores/session";
import {
	SessionRuntimeProvider,
	sessionRuntimeStore,
	useTabSessionRuntime,
} from "../../stores/session-runtime-context";
import { toggleSidebarSubagents, useSidebarSubagentsStore } from "../../stores/sidebar-subagents";
import { useSubagentGraphStore } from "../../stores/subagent-graph";
import { type SubagentsStore, useSubagentsStore } from "../../stores/subagents";
import { useUiStore } from "../../stores/ui";
import { anchorFromEvent, ContextMenu, type ContextMenuAnchor, ListRow, Spinner } from "../common";
import { SubagentTranscriptSheet } from "../panels/SubagentTranscriptSheet";
import { runSubagentAction } from "../panels/subagent-actions";
import {
	formatElapsed,
	isLiveSubagentStatus,
	statusMeta,
	subagentElapsedMs,
	subagentPrimaryLabel,
} from "../panels/subagent-graph";

interface SubagentRowModel {
	agent: SubagentSnapshot;
	/** 0 = spawned by the session, 1 = spawned by a subagent (deeper clamps to 1). */
	depth: 0 | 1;
}

/**
 * Live subagents (working or waiting; never a finished, failed or aborted one)
 * as a pre-order spawn tree in spawn order. Parent: the explicit wire link, else
 * the subagent whose transcript owns the spawning `task` call; a parent that is
 * not listed, unresolved or cyclic makes the agent a top-level spawn of the session.
 */
function buildSidebarSubagentRows(
	subagents: ReadonlyMap<string, SubagentSnapshot>,
	toolCallOwners: ReadonlyMap<string, string>,
): SubagentRowModel[] {
	const live = new Map<string, SubagentSnapshot>();
	for (const agent of subagents.values()) if (isLiveSubagentStatus(agent.status)) live.set(agent.id, agent);
	const agents = [...live.values()].sort((a, b) => a.index - b.index);
	const children = new Map<string, SubagentSnapshot[]>();
	const roots: SubagentSnapshot[] = [];
	for (const agent of agents) {
		const linked = agent.parentSubagentId;
		const owner = agent.parentToolCallId ? toolCallOwners.get(agent.parentToolCallId) : undefined;
		const parentId =
			linked && linked !== agent.id && live.has(linked)
				? linked
				: owner && owner !== agent.id && live.has(owner)
					? owner
					: undefined;
		if (!parentId) {
			roots.push(agent);
			continue;
		}
		const siblings = children.get(parentId);
		if (siblings) siblings.push(agent);
		else children.set(parentId, [agent]);
	}

	const rows: SubagentRowModel[] = [];
	const visited = new Set<string>();
	const visit = (agent: SubagentSnapshot, level: number) => {
		if (visited.has(agent.id)) return;
		visited.add(agent.id);
		rows.push({ agent, depth: level === 0 ? 0 : 1 });
		for (const child of children.get(agent.id) ?? []) visit(child, level + 1);
	};
	for (const root of roots) visit(root, 0);
	// A parent cycle leaves members unreached from any root: show them flat.
	for (const agent of agents) visit(agent, 0);
	return rows;
}

/** Live but waiting rather than working: paused glyph instead of a spinner. */
const WAITING_STATUSES: Record<string, true> = { parked: true, idle: true };

function StatusGlyph({ status }: { status: string }) {
	if (WAITING_STATUSES[status]) return <Pause aria-hidden className="text-(--sc-text-subtle)" />;
	return (
		<span aria-hidden className="inline-flex size-(--sc-icon-md) items-center justify-center">
			<Spinner size="sm" />
		</span>
	);
}

/** Live subagents in a roster. */
function countLiveSubagents(subagents: ReadonlyMap<string, SubagentSnapshot>): number {
	let count = 0;
	for (const agent of subagents.values()) if (isLiveSubagentStatus(agent.status)) count++;
	return count;
}

/** Live subagents of the session open in `tabId`, read once (event handlers). */
export function sidebarSubagentCount(tabId: string): number {
	const store = sessionRuntimeStore<SubagentsStore>(tabId, "subagents");
	return store ? countLiveSubagents(store.getState().subagents) : 0;
}

/** Elapsed time for the row meta: whole units only ("12s", "10m", "2h"); the tooltip keeps the full value. */
export function formatCompactElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h`;
}

/**
 * A session row's icon sits at pl-2.5 (nested sessions use 28px)
 * and is --sc-icon-md (16px) wide, so its center is 8px further in.
 * The connector runs down from that center; child icons start one icon step
 * (16px) right of the parent icon, sub-subagents one more step, with their
 * own connector under the child icon.
 */
const INDENT = {
	top: ["pl-6.5", "pl-10.5"],
	nested: ["pl-11", "pl-15"],
} as const;
const CONNECTOR = {
	top: ["left-4.5", "left-8.5"],
	nested: ["left-9", "left-13"],
} as const;

function Connector({ nested, depth }: { nested: boolean; depth: 0 | 1 }) {
	return (
		<span
			aria-hidden
			className={cx(
				"pointer-events-none absolute top-0 -bottom-px z-(--sc-z-raised) w-px bg-(--sc-border-subtle)",
				CONNECTOR[nested ? "nested" : "top"][depth],
			)}
			data-sidebar-subagents-connector={depth}
		/>
	);
}

const SubagentRow = memo(function SubagentRow({
	agent,
	tabId,
	depth,
	nested,
	selected,
	rovingKey,
	onOpen,
	onMenu,
}: {
	agent: SubagentSnapshot;
	tabId: string;
	depth: 0 | 1;
	nested: boolean;
	selected: boolean;
	rovingKey: string;
	onOpen: (id: string) => void;
	onMenu: (id: string, anchor: ContextMenuAnchor) => void;
}) {
	const t = useT();
	const now = useNowTick(true);
	const elapsed = subagentElapsedMs(agent, now);
	const statusLabel = t(statusMeta(agent.status).labelKey);
	const primary = subagentPrimaryLabel(agent);
	const showRole = primary !== agent.agent;
	const progress = agent.progress;
	const note = progress?.lastIntent ?? progress?.currentTool;
	// Stock's progress tally: "128.4k tokens · 48 tool calls".
	const usage =
		progress && (progress.tokens > 0 || progress.toolCount > 0)
			? t("sidebar.subagents.usage", { tokens: formatTokens(progress.tokens), tools: progress.toolCount })
			: null;
	const tooltip = [
		showRole ? `${agent.agent} · ${subagentPrimaryLabel(agent, Number.POSITIVE_INFINITY)}` : agent.agent,
		elapsed !== null ? `${statusLabel} · ${formatElapsed(elapsed)}` : statusLabel,
		progress?.resolvedModel,
		usage,
		note,
	]
		.filter(Boolean)
		.join("\n");
	return (
		<div className="relative" data-subagent-depth={depth}>
			{depth === 1 && <Connector depth={1} nested={nested} />}
			<ListRow
				buttonProps={{
					tabIndex: -1,
					"data-roving-item": rovingKey,
					onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
						if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
						event.preventDefault();
						const rect = event.currentTarget.getBoundingClientRect();
						onMenu(agent.id, {
							x: Number.isFinite(rect.left) ? rect.left : 8,
							y: (Number.isFinite(rect.bottom) ? rect.bottom : 40) + 4,
						});
					},
				}}
				className={cx("omp-sidebar-session-row", INDENT[nested ? "nested" : "top"][depth])}
				description={note ?? usage ?? undefined}
				leading={<StatusGlyph status={agent.status} />}
				// A listed subagent is always working or waiting: its meta is the elapsed time.
				meta={elapsed !== null ? formatCompactElapsed(elapsed) : undefined}
				onClick={() => onOpen(agent.id)}
				rowProps={{
					// Onto a session pane: opens in the side panel (SplitWorkspace takes the drop).
					draggable: true,
					onDragStart: (event: ReactDragEvent<HTMLDivElement>) => {
						event.dataTransfer.effectAllowed = "move";
						hideNativeDragImage(event.dataTransfer);
						window.dispatchEvent(
							new CustomEvent("omp:subagent-drag", { detail: { tabId, agentId: agent.id, label: primary } }),
						);
					},
					onDragEnd: () => window.dispatchEvent(new CustomEvent("omp:subagent-drag", { detail: null })),
					onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => {
						event.preventDefault();
						onMenu(agent.id, anchorFromEvent(event));
					},
					"data-active": selected,
					"data-sidebar-subagent": agent.id,
					"data-status": agent.status,
				}}
				selected={selected}
				title={
					// Quieter than the session row. The role stays in the tooltip: in a
					// sidebar-width row it only ever truncated to a stub ("ta…").
					<span className="flex min-w-0 text-sc-sm text-(--sc-text-muted)">
						<span className="min-w-0 truncate">{primary}</span>
						<span className="sr-only">, {statusLabel}</span>
					</span>
				}
				titleText={tooltip}
			/>
		</div>
	);
});

/**
 * Disclosure on the session row: chevron + count; toggles the child rows
 * without navigating. Right-click offers expand/collapse every session's rows,
 * hiding this session's rows, and bringing hidden ones back.
 */
function SubagentDisclosure({ sessionKey }: { sessionKey: string }) {
	const t = useT();
	const count = useSubagentsStore(s => countLiveSubagents(s.subagents));
	const expanded = useSidebarSubagentsStore(s => s.expanded.has(sessionKey));
	const hidden = useSidebarSubagentsStore(s => s.hidden.has(sessionKey));
	const anyHidden = useSidebarSubagentsStore(s => s.hidden.size > 0);
	const working = useSubagentsStore(s => countLiveSubagents(s.subagents) > 0);
	const [menuAt, setMenuAt] = useState<ContextMenuAnchor | null>(null);
	useEffect(() => {
		useSidebarSubagentsStore.getState().setPresent(sessionKey, count > 0);
		return () => useSidebarSubagentsStore.getState().setPresent(sessionKey, false);
	}, [sessionKey, count]);
	if (count === 0 || hidden) return null;
	const label = t(expanded ? "sidebar.subagents.hide" : "sidebar.subagents.show", { count });
	const store = useSidebarSubagentsStore.getState;
	return (
		<>
			<button
				aria-expanded={expanded}
				aria-label={label}
				className="flex h-(--sc-hit-min) items-center gap-0.5 rounded-(--sc-radius-sm) px-1 text-sc-xs tabular-nums text-(--sc-text-muted) outline-none hover:bg-(--sc-hover) hover:text-(--sc-text) focus-visible:outline-2 focus-visible:outline-(--sc-focus-ring)"
				data-sidebar-subagents-toggle={sessionKey}
				onClick={() => toggleSidebarSubagents(sessionKey)}
				onContextMenu={event => {
					event.preventDefault();
					event.stopPropagation();
					setMenuAt(anchorFromEvent(event));
				}}
				tabIndex={-1}
				title={label}
				type="button"
			>
				<ChevronRight
					aria-hidden
					className={cx(
						"size-(--sc-icon-sm) motion-safe:transition-transform duration-(--sc-duration-fast)",
						expanded && "rotate-90",
					)}
				/>
				{/* A folded group still says its agents are at work. The pulse sits on an
				    HTML wrapper: Chromium runs no SVG element's animation on the
				    compositor, so on the icon it restyled and repainted every frame. */}
				<span
					className={cx("inline-flex", working && !expanded && "omp-pulse-dot")}
					data-working={(working && !expanded) || undefined}
				>
					<Bot aria-hidden className="size-(--sc-icon-sm)" />
				</span>
				{count}
			</button>
			{menuAt && (
				<ContextMenu
					ariaLabel={t("sidebar.subagents.groupMenu")}
					items={[
						{ id: "expand-all", label: t("sidebar.subagents.expandAll"), onSelect: () => store().expandAll() },
						{
							id: "collapse-all",
							label: t("sidebar.subagents.collapseAll"),
							onSelect: () => store().collapseAll(),
						},
						{
							id: "hide-group",
							label: t("sidebar.subagents.hideGroup"),
							separatorBefore: true,
							onSelect: () => store().setHidden(sessionKey, true),
						},
						...(anyHidden
							? [
									{
										id: "show-hidden",
										label: t("sidebar.subagents.showHidden"),
										onSelect: () => store().showAll(),
									},
								]
							: []),
					].map(item => ({
						...item,
						onSelect: () => {
							setMenuAt(null);
							item.onSelect();
						},
					}))}
					onClose={() => setMenuAt(null)}
					x={menuAt.x}
					y={menuAt.y}
				/>
			)}
		</>
	);
}

function SubagentGroup({ tabId, sessionKey, nested }: { tabId: string; sessionKey: string; nested: boolean }) {
	const t = useT();
	const rpc = useTabRpc();
	const ready = useSessionStore(s => s.status) === "ready";
	const subagents = useSubagentsStore(s => s.subagents);
	const toolCallOwners = useSubagentGraphStore(s => s.toolCallOwners);
	const rows = useMemo(() => buildSidebarSubagentRows(subagents, toolCallOwners), [subagents, toolCallOwners]);
	const reveal = useSidebarSubagentsStore(s => s.reveal);
	const expanded = useSidebarSubagentsStore(s => s.expanded.has(sessionKey));
	const hidden = useSidebarSubagentsStore(s => s.hidden.has(sessionKey));
	const [viewingId, setViewingId] = useState<string | null>(null);
	// The side panel's Subagent view showing one of this tab's agents marks its row selected.
	const panelId = useUiStore(s =>
		s.panelVisible && s.panelTab === "subagent" && s.panelSubagent?.tabId === tabId ? s.panelSubagent.agentId : null,
	);
	const [menu, setMenu] = useState<{ id: string; anchor: ContextMenuAnchor } | null>(null);
	const groupRef = useRef<HTMLDivElement>(null);

	// The transcript stays open when its agent finishes;
	// sheet and menu close only when the agent leaves the roster.
	const viewing = viewingId !== null ? (subagents.get(viewingId) ?? null) : null;
	const menuAgent = menu ? (subagents.get(menu.id) ?? null) : null;
	useEffect(() => {
		if (viewingId !== null && !subagents.has(viewingId)) setViewingId(null);
	}, [viewingId, subagents]);

	// No rows left: forget the expanded state so the next fan-out starts collapsed.
	useEffect(() => {
		if (rows.length === 0 && expanded) useSidebarSubagentsStore.getState().setExpanded(sessionKey, false);
	}, [rows.length, expanded, sessionKey]);

	// Reveal (dock chip): un-hide and expand first, then focus the first row once it renders.
	useEffect(() => {
		if (!reveal || reveal.tabId !== tabId) return;
		if (hidden) {
			useSidebarSubagentsStore.getState().setHidden(sessionKey, false);
			return;
		}
		if (rows.length > 0 && !expanded) {
			useSidebarSubagentsStore.getState().setExpanded(sessionKey, true);
			return;
		}
		useSidebarSubagentsStore.getState().consumeReveal(reveal.seq);
		const first = groupRef.current?.querySelector<HTMLElement>("[data-roving-item]");
		first?.scrollIntoView?.({ block: "nearest" });
		first?.focus();
	}, [reveal, tabId, rows.length, expanded, hidden, sessionKey]);

	const openAgent = useCallback((id: string) => setViewingId(id), []);
	const openMenu = useCallback((id: string, anchor: ContextMenuAnchor) => setMenu({ id, anchor }), []);
	const openInPanel = (id: string) => useUiStore.getState().openSubagentPanel({ tabId, agentId: id });

	const stoppable = menuAgent !== null && isLiveSubagentStatus(menuAgent.status) && menuAgent.kind !== "advisor";

	return (
		<>
			{expanded && !hidden && rows.length > 0 && (
				<div
					aria-label={t("sidebar.subagents.group")}
					className="relative space-y-px"
					data-sidebar-subagents={sessionKey}
					ref={groupRef}
					role="group"
				>
					<Connector depth={0} nested={nested} />
					{rows.map(row => (
						<SubagentRow
							agent={row.agent}
							tabId={tabId}
							depth={row.depth}
							key={row.agent.id}
							nested={nested}
							onMenu={openMenu}
							onOpen={openAgent}
							rovingKey={`subagent:${tabId}:${row.agent.id}`}
							selected={row.agent.id === viewingId || row.agent.id === panelId}
						/>
					))}
				</div>
			)}
			<SubagentTranscriptSheet agent={viewing} onClose={() => setViewingId(null)} />
			{menu && menuAgent && (
				<ContextMenu
					ariaLabel={t("sidebar.subagents.menu")}
					items={[
						{ id: "subagent-open", label: t("sidebar.subagents.open"), onSelect: () => openAgent(menu.id) },
						{
							id: "subagent-open-panel",
							label: t("sidebar.subagents.openInPanel"),
							onSelect: () => openInPanel(menu.id),
						},
						...(stoppable
							? [
									{
										id: "subagent-stop",
										label: t("sidebar.subagents.stop"),
										danger: true,
										disabled: !ready,
										disabledReason: ready ? undefined : t("agentHub.notConnected"),
										onSelect: () => {
											void runSubagentAction(rpc, menu.id, "abort", t).then(ok => {
												if (ok)
													void sessionRuntimeStore<SubagentsStore>(tabId, "subagents")
														?.getState()
														.refresh();
											});
										},
										separatorBefore: true,
									},
								]
							: []),
					]}
					onClose={() => setMenu(null)}
					x={menu.anchor.x}
					y={menu.anchor.y}
				/>
			)}
		</>
	);
}

/**
 * Mount point under a sidebar session row whose session is open in `tabId`.
 * Primitive props + memo: the sidebar's own re-renders don't reach the group.
 */
export const SidebarSubagents = memo(function SidebarSubagents({
	tabId,
	sessionKey,
	nested = false,
}: {
	tabId: string;
	sessionKey: string;
	nested?: boolean;
}) {
	const runtime = useTabSessionRuntime(tabId);
	// The tab closed: no live subagents left, so the expanded state goes too.
	useEffect(() => {
		if (!runtime) useSidebarSubagentsStore.getState().setExpanded(sessionKey, false);
	}, [runtime, sessionKey]);
	if (!runtime) return null;
	return (
		<SessionRuntimeProvider runtime={runtime}>
			<SubagentGroup nested={nested} sessionKey={sessionKey} tabId={tabId} />
		</SessionRuntimeProvider>
	);
});

/**
 * Disclosure for the session row's `trailing` slot (session open in `tabId`):
 * renders nothing while the session has no live subagents.
 */
export const SidebarSubagentsToggle = memo(function SidebarSubagentsToggle({
	tabId,
	sessionKey,
}: {
	tabId: string;
	sessionKey: string;
}) {
	const runtime = useTabSessionRuntime(tabId);
	if (!runtime) return null;
	return (
		<SessionRuntimeProvider runtime={runtime}>
			<SubagentDisclosure sessionKey={sessionKey} />
		</SessionRuntimeProvider>
	);
});
