/**
 * A session's family under its sidebar row: the subagents it spawned and the sessions its agent opened (in a worktree
 * or not), one compact line each, one indent level. Only a session open in a tab has a subagent roster (its runtime's
 * subagents store); the opened sessions come from the sidebar (`opened`, built from the tabs' provenance) and show
 * whether or not the opener's runtime exists, so a relaunched family reads the same before anything wakes.
 *
 * The parent row carries one summary chip ("🤖5 · ⑂4", the running count highlighted). The group is collapsed until a
 * child runs or waits, opens by itself then and folds when the last one is done; the person's own toggle stands in
 * between, remembered per session (`stores/sidebar-subagents`). Finished subagents fold into one "n done" row at the
 * end. Rows share one look (`SidebarFamilyRow`), are part of the sidebar's roving list (arrow keys) and a subagent
 * opens its live transcript against the owning tab — not a second sidecar, since the parent's omp is still writing
 * that session file. A subagent row dragged onto a session pane (`omp:subagent-drag`, SplitWorkspace) or "Open in
 * side panel" shows that transcript in the side panel instead. Right-click (or the menu key) offers Stop.
 * Each group subscribes to its own tab's stores, so a progress frame re-renders that group — never the whole sidebar.
 */

import { Bot, ChevronRight, GitBranch } from "lucide-react";
import {
	memo,
	type DragEvent as ReactDragEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { SubagentSnapshot } from "../../../../shared/rpc-types";
import { hideNativeDragImage } from "../../../lib/drag-image";
import { cx, formatTimeAgo, formatTokens } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useNowTick } from "../../../lib/now-tick";
import { type TabRpc, useTabRpc } from "../../../lib/tab-rpc";
import { useSessionStore } from "../../../stores/session";
import {
	SessionRuntimeProvider,
	sessionRuntimeStore,
	useTabSessionRuntime,
} from "../../../stores/session-runtime-context";
import { toggleSidebarSubagents, useSidebarSubagentsStore } from "../../../stores/sidebar-subagents";
import { useSubagentGraphStore } from "../../../stores/subagent-graph";
import { type SubagentsStore, useSubagentsStore } from "../../../stores/subagents";
import { useUiStore } from "../../../stores/ui";
import { anchorFromEvent, ContextMenu, type ContextMenuAnchor } from "../../common";
import { SubagentTranscriptSheet } from "../../panels/SubagentTranscriptSheet";
import { runSubagentAction } from "../../panels/subagent-actions";
import {
	formatElapsed,
	isLiveSubagentStatus,
	statusMeta,
	subagentElapsedMs,
	subagentPrimaryLabel,
} from "../../panels/subagent-graph";
import { FamilyRow, type FamilyRowProps } from "./SidebarFamilyRow";
import {
	buildSubagentFamilyRows,
	countLiveSubagents,
	type FamilyCounts,
	type FamilyState,
	familyCounts,
	subagentFamilyState,
} from "./sidebar-family";

/** A session the agent of this family's parent opened, as the sidebar prepared its row. */
export interface FamilyOpened {
	/** The session's path (its row key). */
	key: string;
	/** A session in a worktree of its own, or a plain one. */
	kind: "worktree" | "session";
	/** Null: merely open, no token. */
	state: FamilyState | null;
	stateLabel: string;
	title: string;
	age?: string;
	tooltip: string;
	selected: boolean;
	onOpen: () => void;
	rowProps?: FamilyRowProps["rowProps"];
	buttonProps?: FamilyRowProps["buttonProps"];
	/** Replaces the row while its title is being renamed. */
	renaming?: ReactNode;
}

const NO_OPENED: readonly FamilyOpened[] = [];
const NO_AGENTS: ReadonlyMap<string, SubagentSnapshot> = new Map();
const NO_OWNERS: ReadonlyMap<string, string> = new Map();

/** What the tab's runtime tells the group; absent runtime (a tab not woken yet) tells it nothing. */
interface AgentSlice {
	subagents: ReadonlyMap<string, SubagentSnapshot>;
	owners: ReadonlyMap<string, string>;
	ready: boolean;
	rpc: TabRpc | null;
}

const DETACHED: AgentSlice = { subagents: NO_AGENTS, owners: NO_OWNERS, ready: false, rpc: null };

/** Inside the tab's `SessionRuntimeProvider`. */
function useAgentSlice(): AgentSlice {
	const subagents = useSubagentsStore(s => s.subagents);
	const owners = useSubagentGraphStore(s => s.toolCallOwners);
	const ready = useSessionStore(s => s.status) === "ready";
	const rpc = useTabRpc();
	return useMemo(() => ({ subagents, owners, ready, rpc }), [subagents, owners, ready, rpc]);
}

/** Live subagents of the session open in `tabId`, read once (event handlers). */
export function sidebarSubagentCount(tabId: string): number {
	const store = sessionRuntimeStore<SubagentsStore>(tabId, "subagents");
	return store ? countLiveSubagents(store.getState().subagents) : 0;
}

/** Below this sidebar width (px) the summary chip shrinks to its running-count pill (default width is 248). */
const NARROW_SIDEBAR = 300;

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

function menuKey(event: ReactKeyboardEvent<HTMLButtonElement>): ContextMenuAnchor | null {
	if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return null;
	event.preventDefault();
	const rect = event.currentTarget.getBoundingClientRect();
	return {
		x: Number.isFinite(rect.left) ? rect.left : 8,
		y: (Number.isFinite(rect.bottom) ? rect.bottom : 40) + 4,
	};
}

const SubagentFamilyRow = memo(function SubagentFamilyRow({
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
	const live = isLiveSubagentStatus(agent.status);
	const now = useNowTick(live);
	const elapsed = subagentElapsedMs(agent, now);
	const state = subagentFamilyState(agent.status);
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
	// The one line has no room for any of this: it is all the tooltip.
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
		<div data-subagent-depth={depth}>
			<FamilyRow
				age={elapsed !== null ? formatTimeAgo(new Date(Date.now() - elapsed).toISOString()) : undefined}
				buttonProps={{
					tabIndex: -1,
					"data-roving-item": rovingKey,
					onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
						const anchor = menuKey(event);
						if (anchor) onMenu(agent.id, anchor);
					},
				}}
				connector={depth === 1 ? <Connector depth={1} nested={nested} /> : undefined}
				indent={INDENT[nested ? "nested" : "top"][depth]}
				kind="subagent"
				kindLabel={t("sidebar.family.kind.subagent")}
				onOpen={() => onOpen(agent.id)}
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
					"data-signal": state === "running" ? "running" : undefined,
					"data-status": agent.status,
				}}
				selected={selected}
				state={state}
				stateLabel={statusLabel}
				title={primary}
				tooltip={tooltip}
			/>
		</div>
	);
});

/** The "n done" row: the finished subagents behind it, one click away. */
function DoneFold({
	sessionKey,
	count,
	open,
	nested,
	onToggle,
}: {
	sessionKey: string;
	count: number;
	open: boolean;
	nested: boolean;
	onToggle: () => void;
}) {
	const t = useT();
	return (
		<button
			aria-expanded={open}
			className={cx(
				"omp-family-row flex w-full items-center gap-1.5 rounded-(--sc-radius-md) pr-2.5 text-left text-sc-xs text-(--sc-text-subtle) outline-none hover:bg-(--sc-hover) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--sc-focus-ring)",
				INDENT[nested ? "nested" : "top"][0],
			)}
			data-family-done={sessionKey}
			data-roving-item={`family-done:${sessionKey}`}
			onClick={onToggle}
			tabIndex={-1}
			type="button"
		>
			<ChevronRight
				aria-hidden
				className={cx("size-(--sc-icon-md) shrink-0 transition-transform", open && "rotate-90")}
			/>
			<span className="truncate">{t("sidebar.family.done", { count })}</span>
		</button>
	);
}

/** The family's counts as the chip and the open/closed rule read them. */
function useFamilyCounts(
	sessionKey: string,
	slice: AgentSlice,
	opened: readonly FamilyOpened[],
): { counts: FamilyCounts; hidden: boolean } {
	const hidden = useSidebarSubagentsStore(s => s.hidden.has(sessionKey));
	const counts = useMemo(
		() =>
			familyCounts(
				slice.subagents.values(),
				opened.map(child => ({ state: child.state ?? "idle" })),
				!hidden,
			),
		[slice.subagents, opened, hidden],
	);
	return { counts, hidden };
}

/**
 * Summary chip on the session row: the subagents, the opened sessions and, in a filled pill, how many of them run.
 * Toggles the child rows without navigating. Right-click offers expand/collapse every session's rows, hiding this
 * session's subagents, and bringing hidden ones back.
 */
function FamilyChip({
	sessionKey,
	slice,
	opened,
}: {
	sessionKey: string;
	slice: AgentSlice;
	opened: readonly FamilyOpened[];
}) {
	const t = useT();
	const { counts } = useFamilyCounts(sessionKey, slice, opened);
	const expanded = useSidebarSubagentsStore(s => s.expanded.has(sessionKey));
	const anyHidden = useSidebarSubagentsStore(s => s.hidden.size > 0);
	const [menuAt, setMenuAt] = useState<ContextMenuAnchor | null>(null);
	const chipRef = useRef<HTMLButtonElement>(null);
	const [narrow, setNarrow] = useState(false);
	const present = counts.agents + counts.sessions > 0;
	useEffect(() => {
		const sidebar = chipRef.current?.closest(".omp-session-sidebar");
		if (!present || !sidebar) return;
		const measure = () => {
			const width = sidebar.getBoundingClientRect().width;
			setNarrow(width > 0 && width < NARROW_SIDEBAR);
		};
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(sidebar);
		return () => observer.disconnect();
	}, [present]);
	if (counts.agents + counts.sessions === 0) return null;
	// A narrow sidebar has no room for the counts beside the title: only the running pill stays, the tooltip and
	// the accessible name keep the whole summary.
	const compact = narrow && counts.running > 0;
	const summary = [
		counts.agents > 0 ? t("sidebar.family.agents", { count: counts.agents }) : "",
		counts.sessions > 0 ? t("sidebar.family.sessions", { count: counts.sessions }) : "",
		counts.running > 0 ? t("sidebar.family.running", { count: counts.running }) : "",
	]
		.filter(Boolean)
		.join(", ");
	const label = t(expanded ? "sidebar.family.hide" : "sidebar.family.show", { summary });
	const store = useSidebarSubagentsStore.getState;
	return (
		<>
			<button
				aria-expanded={expanded}
				aria-label={label}
				className="omp-family-chip flex h-(--sc-hit-min) items-center gap-0.5 rounded-(--sc-radius-sm) px-1 text-sc-xs tabular-nums text-(--sc-text-muted) outline-none hover:bg-(--sc-hover) hover:text-(--sc-text) aria-expanded:bg-(--sc-hover) focus-visible:outline-2 focus-visible:outline-(--sc-focus-ring)"
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
				data-family-compact={compact || undefined}
				ref={chipRef}
			>
				{counts.agents > 0 && !compact && (
					<span className="inline-flex items-center gap-0.5" data-family-agents={counts.agents}>
						<Bot aria-hidden className="size-(--sc-icon-sm)" />
						{counts.agents}
					</span>
				)}
				{counts.agents > 0 && counts.sessions > 0 && !compact && <span aria-hidden>·</span>}
				{counts.sessions > 0 && !compact && (
					<span className="inline-flex items-center gap-0.5" data-family-sessions={counts.sessions}>
						<GitBranch aria-hidden className="size-(--sc-icon-sm)" />
						{counts.sessions}
					</span>
				)}
				{/* The running count, highlighted. A folded group still says its children are at work: the pill
				    pulses on an HTML element (Chromium runs no SVG element's animation on the compositor). */}
				{counts.running > 0 && (
					<span
						className={cx(
							"ml-0.5 min-w-4 rounded-(--sc-radius-full) bg-(--sc-accent) px-1 text-center text-(--sc-accent-fg)",
							!expanded && "omp-pulse-dot",
						)}
						data-family-running={counts.running}
					>
						{counts.running}
					</span>
				)}
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

function FamilyGroup({
	tabId,
	sessionKey,
	nested,
	opened,
	slice,
}: {
	tabId: string;
	sessionKey: string;
	nested: boolean;
	opened: readonly FamilyOpened[];
	slice: AgentSlice;
}) {
	const t = useT();
	const { subagents, owners, ready, rpc } = slice;
	const model = useMemo(() => buildSubagentFamilyRows(subagents, owners), [subagents, owners]);
	const { counts, hidden } = useFamilyCounts(sessionKey, slice, opened);
	const reveal = useSidebarSubagentsStore(s => s.reveal);
	const expanded = useSidebarSubagentsStore(s => s.expanded.has(sessionKey));
	const [viewingId, setViewingId] = useState<string | null>(null);
	const [doneOpen, setDoneOpen] = useState(false);
	// The side panel's Subagent view showing one of this tab's agents marks its row selected.
	const panelId = useUiStore(s =>
		s.panelVisible && s.panelTab === "subagent" && s.panelSubagent?.tabId === tabId ? s.panelSubagent.agentId : null,
	);
	const [menu, setMenu] = useState<{ id: string; anchor: ContextMenuAnchor } | null>(null);
	const groupRef = useRef<HTMLDivElement>(null);
	const rows = hidden ? [] : model.rows;
	const done = hidden ? [] : model.done;
	const total = rows.length + done.length + opened.length;
	const active = counts.active > 0;

	// The transcript stays open when its agent finishes;
	// sheet and menu close only when the agent leaves the roster.
	const viewing = viewingId !== null ? (subagents.get(viewingId) ?? null) : null;
	const menuAgent = menu ? (subagents.get(menu.id) ?? null) : null;
	useEffect(() => {
		if (viewingId !== null && !subagents.has(viewingId)) setViewingId(null);
	}, [viewingId, subagents]);

	// Whether the session has a family at all: "expand all" and the dock's reveal need to know.
	useEffect(() => {
		useSidebarSubagentsStore.getState().setPresent(sessionKey, total > 0);
		return () => useSidebarSubagentsStore.getState().setPresent(sessionKey, false);
	}, [sessionKey, total]);

	// Open while a child runs or waits, fold when the last one is done; the person's toggle stands in between.
	useEffect(() => {
		useSidebarSubagentsStore.getState().noteFamilyActive(sessionKey, active);
	}, [sessionKey, active]);

	// No child left: forget the expanded state so the next fan-out starts collapsed.
	useEffect(() => {
		if (total === 0 && expanded) useSidebarSubagentsStore.getState().setExpanded(sessionKey, false);
	}, [total, expanded, sessionKey]);

	// Reveal (dock chip): un-hide and expand first, then focus the first row once it renders.
	useEffect(() => {
		if (!reveal || reveal.tabId !== tabId) return;
		if (hidden) {
			useSidebarSubagentsStore.getState().setHidden(sessionKey, false);
			return;
		}
		if (total > 0 && !expanded) {
			useSidebarSubagentsStore.getState().setExpanded(sessionKey, true);
			return;
		}
		useSidebarSubagentsStore.getState().consumeReveal(reveal.seq);
		const first = groupRef.current?.querySelector<HTMLElement>("[data-roving-item]");
		first?.scrollIntoView?.({ block: "nearest" });
		first?.focus();
	}, [reveal, tabId, total, expanded, hidden, sessionKey]);

	const openAgent = useCallback((id: string) => setViewingId(id), []);
	const openMenu = useCallback((id: string, anchor: ContextMenuAnchor) => setMenu({ id, anchor }), []);
	const openInPanel = (id: string) => useUiStore.getState().openSubagentPanel({ tabId, agentId: id });

	const stoppable = menuAgent !== null && isLiveSubagentStatus(menuAgent.status) && menuAgent.kind !== "advisor";
	const agentRow = (agent: SubagentSnapshot, depth: 0 | 1) => (
		<SubagentFamilyRow
			agent={agent}
			depth={depth}
			key={agent.id}
			nested={nested}
			onMenu={openMenu}
			onOpen={openAgent}
			rovingKey={`subagent:${tabId}:${agent.id}`}
			selected={agent.id === viewingId || agent.id === panelId}
			tabId={tabId}
		/>
	);

	return (
		<>
			{expanded && total > 0 && (
				<div
					aria-label={t("sidebar.family.group")}
					className="relative space-y-px"
					data-sidebar-family={sessionKey}
					data-sidebar-subagents={sessionKey}
					ref={groupRef}
					role="group"
				>
					<Connector depth={0} nested={nested} />
					{rows.map(row => agentRow(row.agent, row.depth))}
					{opened.map(child =>
						child.renaming ? (
							<div key={child.key}>{child.renaming}</div>
						) : (
							<FamilyRow
								age={child.age}
								buttonProps={child.buttonProps}
								indent={INDENT[nested ? "nested" : "top"][0]}
								key={child.key}
								kind={child.kind}
								kindLabel={t(
									child.kind === "worktree" ? "sidebar.family.kind.worktree" : "sidebar.family.kind.session",
								)}
								onOpen={child.onOpen}
								rowProps={child.rowProps}
								selected={child.selected}
								state={child.state}
								stateLabel={child.stateLabel}
								title={child.title}
								tooltip={child.tooltip}
							/>
						),
					)}
					{done.length > 0 && (
						<>
							<DoneFold
								count={done.length}
								nested={nested}
								onToggle={() => setDoneOpen(open => !open)}
								open={doneOpen}
								sessionKey={sessionKey}
							/>
							{doneOpen && done.map(agent => agentRow(agent, 0))}
						</>
					)}
				</div>
			)}
			{rpc && <SubagentTranscriptSheet agent={viewing} onClose={() => setViewingId(null)} />}
			{rpc && menu && menuAgent && (
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
					].map(item => ({
						...item,
						// Picking a row action dismisses the menu (a menu that stayed open hung over the panel it opened).
						onSelect: () => {
							setMenu(null);
							item.onSelect();
						},
					}))}
					onClose={() => setMenu(null)}
					x={menu.anchor.x}
					y={menu.anchor.y}
				/>
			)}
		</>
	);
}

/** The group reading the tab's runtime; only ever rendered inside that runtime's provider. */
function AttachedGroup(props: { tabId: string; sessionKey: string; nested: boolean; opened: readonly FamilyOpened[] }) {
	return <FamilyGroup {...props} slice={useAgentSlice()} />;
}

function AttachedChip(props: { sessionKey: string; opened: readonly FamilyOpened[] }) {
	return <FamilyChip {...props} slice={useAgentSlice()} />;
}

/**
 * Mount point under a sidebar session row whose session is open in `tabId`. `opened` are the sessions its agent
 * opened (the sidebar builds their rows); the subagents come from the tab's runtime, when it has one.
 * Primitive props + memo: the sidebar's own re-renders reach the group only when `opened` changes.
 */
export const SidebarSubagents = memo(function SidebarSubagents({
	tabId,
	sessionKey,
	nested = false,
	opened = NO_OPENED,
}: {
	tabId: string;
	sessionKey: string;
	nested?: boolean;
	opened?: readonly FamilyOpened[];
}) {
	const runtime = useTabSessionRuntime(tabId);
	if (!runtime)
		return <FamilyGroup nested={nested} opened={opened} sessionKey={sessionKey} slice={DETACHED} tabId={tabId} />;
	return (
		<SessionRuntimeProvider runtime={runtime}>
			<AttachedGroup nested={nested} opened={opened} sessionKey={sessionKey} tabId={tabId} />
		</SessionRuntimeProvider>
	);
});

/**
 * The summary chip for the session row's `trailing` slot (session open in `tabId`): renders nothing while the
 * session has neither subagents nor opened sessions.
 */
export const SidebarSubagentsToggle = memo(function SidebarSubagentsToggle({
	tabId,
	sessionKey,
	opened = NO_OPENED,
}: {
	tabId: string;
	sessionKey: string;
	opened?: readonly FamilyOpened[];
}) {
	const runtime = useTabSessionRuntime(tabId);
	if (!runtime) return <FamilyChip opened={opened} sessionKey={sessionKey} slice={DETACHED} />;
	return (
		<SessionRuntimeProvider runtime={runtime}>
			<AttachedChip opened={opened} sessionKey={sessionKey} />
		</SessionRuntimeProvider>
	);
});
