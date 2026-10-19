/**
 * A session's family under its sidebar row: the subagents it spawned and the sessions its agent opened (in a worktree
 * or not), one compact line each, one indent level. Only a session open in a tab has a subagent roster (its runtime's
 * subagents store); the opened sessions come from the sidebar (`opened`, built from the tabs' provenance) and show
 * whether or not the opener's runtime exists, so a relaunched family reads the same before anything wakes.
 *
 * The parent row carries one summary chip ("🤖5 · ⑂4", the running count highlighted, a warning tint while a child waits
 * for the person). The group is folded until the person opens it and never opens or folds by itself, whatever the
 * children do; the toggle is remembered per session (`stores/sidebar-subagents`). The one exception is a child that
 * waits for an answer or approval: a folded group shows that child alone as a row under the parent, the rest stays
 * folded. Finished subagents and finished opened sessions are not listed at all (the Subagent panel and the session
 * picker keep them); only what is live, waits, failed or has work left to review shows. Rows share one look
 * (`SidebarFamilyRow`), are part of the sidebar's roving list (arrow keys) and a subagent
 * opens its live transcript against the owning tab — not a second sidecar, since the parent's omp is still writing
 * that session file. A subagent row dragged onto a session pane (`omp:subagent-drag`, SplitWorkspace) or "Open in
 * side panel" shows that transcript in the side panel instead. Right-click (or the menu key) offers Stop.
 * Each group subscribes to its own tab's stores, so a progress frame re-renders that group — never the whole sidebar.
 */

import { Bot, GitBranch } from "lucide-react";
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
	type ChildStatus,
	countLiveSubagents,
	type FamilyCounts,
	type FamilyState,
	familyCounts,
	isShownOpened,
	subagentFamilyState,
} from "./sidebar-family";

/** A session the agent of this family's parent opened, as the sidebar prepared its row. */
export interface FamilyOpened {
	/** The session's path (its row key). */
	key: string;
	/** A session in a worktree of its own, or a plain one. */
	kind: "worktree" | "session";
	/** What the session is (`openedChildStatus`): a "done" one is not listed; null while it has not run. */
	status: ChildStatus | null;
	/** The status as the token the row shows. */
	state: FamilyState | null;
	stateLabel: string;
	title: string;
	age?: string;
	/** The paired device it runs on, by name; absent = this computer. */
	device?: string;
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
 * A session row has no leading slot: its title starts at the row's 8 px padding (sidebar.css), nested in a project
 * or not. A child's connector runs down 2 px left of that title edge and the child's glyph starts 6 px right of it,
 * so the child's title sits one step in; a sub-subagent is one more 16 px step in, with its own connector under the
 * child's glyph. (Before the leading slot went, the same relations were measured from a title 30 px further right.)
 */
const INDENT = ["pl-3.5", "pl-7.5"] as const;
const CONNECTOR = ["left-1.5", "left-5.5"] as const;

function Connector({ depth }: { depth: 0 | 1 }) {
	return (
		<span
			aria-hidden
			className={cx(
				"pointer-events-none absolute top-0 -bottom-px z-(--sc-z-raised) w-px bg-(--sc-border-subtle)",
				CONNECTOR[depth],
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
	selected,
	rovingKey,
	onOpen,
	onMenu,
}: {
	agent: SubagentSnapshot;
	tabId: string;
	depth: 0 | 1;
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
				connector={depth === 1 ? <Connector depth={1} /> : undefined}
				indent={INDENT[depth]}
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

/** The family's shown opened sessions and counts, as the chip and the open/closed rule read them. */
function useFamilyCounts(
	sessionKey: string,
	slice: AgentSlice,
	opened: readonly FamilyOpened[],
): { counts: FamilyCounts; hidden: boolean; kids: readonly FamilyOpened[] } {
	const hidden = useSidebarSubagentsStore(s => s.hidden.has(sessionKey));
	// A finished opened session that landed clean is not part of the family (see `isShownOpened`).
	const kids = useMemo(() => opened.filter(isShownOpened), [opened]);
	const counts = useMemo(
		() =>
			familyCounts(
				slice.subagents.values(),
				kids.map(child => ({ state: child.state ?? "idle" })),
				!hidden,
			),
		[slice.subagents, kids, hidden],
	);
	return { counts, hidden, kids };
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
		counts.waiting > 0 ? t("sidebar.family.waiting", { count: counts.waiting }) : "",
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
				className={cx(
					"omp-family-chip flex h-(--sc-hit-min) items-center gap-0.5 rounded-(--sc-radius-sm) px-1 text-sc-xs tabular-nums outline-none hover:bg-(--sc-hover) hover:text-(--sc-text) aria-expanded:bg-(--sc-hover) focus-visible:outline-2 focus-visible:outline-(--sc-focus-ring)",
					counts.waiting > 0 ? "text-(--sc-warning)" : "text-(--sc-text-muted)",
				)}
				data-family-waiting={counts.waiting > 0 ? counts.waiting : undefined}
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
				{/* The count shows once. Some running: one filled accent pill, the kind glyph(s) and the running count,
				    still (nothing breathes in the sidebar). None running: the plain muted counts per kind. */}
				{counts.running > 0 ? (
					<span
						className="inline-flex min-w-4 items-center justify-center gap-0.5 rounded-(--sc-radius-full) bg-(--sc-accent) px-1.5 text-(--sc-accent-fg)"
						data-family-running={counts.running}
					>
						{counts.agents > 0 && <Bot aria-hidden className="size-(--sc-icon-sm)" />}
						{counts.sessions > 0 && <GitBranch aria-hidden className="size-(--sc-icon-sm)" />}
						{counts.running}
					</span>
				) : (
					<>
						{counts.agents > 0 && (
							<span className="inline-flex items-center gap-0.5" data-family-agents={counts.agents}>
								<Bot aria-hidden className="size-(--sc-icon-sm)" />
								{counts.agents}
							</span>
						)}
						{counts.agents > 0 && counts.sessions > 0 && <span aria-hidden>·</span>}
						{counts.sessions > 0 && (
							<span className="inline-flex items-center gap-0.5" data-family-sessions={counts.sessions}>
								<GitBranch aria-hidden className="size-(--sc-icon-sm)" />
								{counts.sessions}
							</span>
						)}
					</>
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

/** One session an agent opened, as a one-line child. */
function OpenedRow({ child }: { child: FamilyOpened }) {
	const t = useT();
	if (child.renaming) return <div>{child.renaming}</div>;
	return (
		<FamilyRow
			age={child.age}
			buttonProps={child.buttonProps}
			device={child.device}
			indent={INDENT[0]}
			kind={child.kind}
			kindLabel={t(child.kind === "worktree" ? "sidebar.family.kind.worktree" : "sidebar.family.kind.session")}
			onOpen={child.onOpen}
			rowProps={child.rowProps}
			selected={child.selected}
			state={child.state}
			stateLabel={child.stateLabel}
			title={child.title}
			tooltip={child.tooltip}
		/>
	);
}

function FamilyGroup({
	tabId,
	sessionKey,
	opened,
	slice,
}: {
	tabId: string;
	sessionKey: string;
	opened: readonly FamilyOpened[];
	slice: AgentSlice;
}) {
	const t = useT();
	const { subagents, owners, ready, rpc } = slice;
	const model = useMemo(() => buildSubagentFamilyRows(subagents, owners), [subagents, owners]);
	const { hidden, kids } = useFamilyCounts(sessionKey, slice, opened);
	const reveal = useSidebarSubagentsStore(s => s.reveal);
	const expanded = useSidebarSubagentsStore(s => s.expanded.has(sessionKey));
	const [viewingId, setViewingId] = useState<string | null>(null);
	// The side panel's Subagent view showing one of this tab's agents marks its row selected.
	const panelId = useUiStore(s =>
		s.panelVisible && s.panelTab === "subagent" && s.panelSubagent?.tabId === tabId ? s.panelSubagent.agentId : null,
	);
	const [menu, setMenu] = useState<{ id: string; anchor: ContextMenuAnchor } | null>(null);
	const groupRef = useRef<HTMLDivElement>(null);
	const rows = hidden ? [] : model.rows;
	const total = rows.length + kids.length;
	// A folded family surfaces only what waits for the person, flat, under the parent.
	const shownRows = expanded
		? rows
		: rows
				.filter(row => subagentFamilyState(row.agent.status) === "waiting")
				.map(row => ({ ...row, depth: 0 as const }));
	const shownOpened = expanded ? kids : kids.filter(child => child.status === "waiting");
	const surfaced = !expanded && shownRows.length + shownOpened.length > 0;

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

	// No child left: forget the expanded state so the next fan-out starts collapsed. A remembered open family
	// (restored from the saved pref) has no children until its tab's agents report: only a family seen with children
	// can lose them.
	const hadChildren = useRef(false);
	useEffect(() => {
		if (total > 0) hadChildren.current = true;
		else if (hadChildren.current && expanded) useSidebarSubagentsStore.getState().setExpanded(sessionKey, false);
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
			onMenu={openMenu}
			onOpen={openAgent}
			rovingKey={`subagent:${tabId}:${agent.id}`}
			selected={agent.id === viewingId || agent.id === panelId}
			tabId={tabId}
		/>
	);
	const openedRow = (child: FamilyOpened) => <OpenedRow child={child} key={child.key} />;

	return (
		<>
			{((expanded && total > 0) || surfaced) && (
				<div
					aria-label={t("sidebar.family.group")}
					className="relative space-y-px"
					data-sidebar-family={sessionKey}
					data-sidebar-subagents={expanded ? sessionKey : undefined}
					data-sidebar-surfaced={surfaced ? sessionKey : undefined}
					ref={groupRef}
					role="group"
				>
					<Connector depth={0} />
					{shownRows.map(row => agentRow(row.agent, row.depth))}
					{shownOpened.map(openedRow)}
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
function AttachedGroup(props: { tabId: string; sessionKey: string; opened: readonly FamilyOpened[] }) {
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
	opened = NO_OPENED,
}: {
	tabId: string | null;
	sessionKey: string;
	opened?: readonly FamilyOpened[];
}) {
	const runtime = useTabSessionRuntime(tabId);
	// A stored opener (no tab) still holds the sessions it opened: no roster, no runtime, `""` names no tab.
	if (!runtime) return <FamilyGroup opened={opened} sessionKey={sessionKey} slice={DETACHED} tabId={tabId ?? ""} />;
	return (
		<SessionRuntimeProvider runtime={runtime}>
			<AttachedGroup opened={opened} sessionKey={sessionKey} tabId={tabId ?? ""} />
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
	tabId: string | null;
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

/**
 * The sessions an agent opened that no opener row holds (closed, from before provenance, opener gone), closing a
 * project's group (or the recent list). Finished ones that landed clean are not listed at all (they stay in the session
 * picker); the ones that need a look (failed, unmerged work) are plain rows.
 */
export function SidebarLooseChildren({ foldKey, opened }: { foldKey: string; opened: readonly FamilyOpened[] }) {
	const t = useT();
	const shown = opened.filter(isShownOpened);
	if (shown.length === 0) return null;
	return (
		<div
			aria-label={t("sidebar.family.group")}
			className="space-y-px"
			data-sidebar-loose-children={foldKey}
			role="group"
		>
			{shown.map(child => (
				<OpenedRow child={child} key={child.key} />
			))}
		</div>
	);
}
