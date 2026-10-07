/**
 * Subagents nested under a sidebar session row. Only a session open in a tab
 * has a roster (its runtime's subagents store); closed sessions render
 * nothing. Each group subscribes to its own tab's stores, so a progress frame
 * re-renders that group — never the whole sidebar.
 *
 * Disclosure "Subagents N" follows liveness (open while any child runs)
 * until the user toggles it; the choice is remembered per session. Rows are
 * part of the sidebar's roving list (arrow keys) and open the subagent's
 * transcript in the same sheet as Agents › Live; right-click (or the menu
 * key) offers Stop for live ones. With more than FINISHED_COLLAPSE_AT rows,
 * fully finished spawn trees fold into a quiet "Done N" summary.
 */

import { Ban, Check, ChevronRight, CircleDashed, Pause, X } from "lucide-react";
import {
	memo,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import type { SubagentSnapshot } from "../../../shared/rpc-types";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useNowTick } from "../../lib/now-tick";
import { useTabRpc } from "../../lib/tab-rpc";
import { useSessionStore } from "../../stores/session";
import {
	SessionRuntimeProvider,
	sessionRuntimeStore,
	useTabSessionRuntime,
} from "../../stores/session-runtime-context";
import { useSidebarSubagentsStore } from "../../stores/sidebar-subagents";
import { useSubagentGraphStore } from "../../stores/subagent-graph";
import { type SubagentsStore, useSubagentsStore } from "../../stores/subagents";
import { anchorFromEvent, ContextMenu, type ContextMenuAnchor, Spinner } from "../common";
import { SubagentTranscriptSheet } from "../panels/SubagentTranscriptSheet";
import { runSubagentAction } from "../panels/subagent-actions";
import {
	formatElapsed,
	isLiveSubagentStatus,
	parentSubagentIdOf,
	statusMeta,
	subagentElapsedMs,
	subagentPrimaryLabel,
} from "../panels/subagent-graph";

/** Above this many rows, finished spawn trees fold into the "Done N" summary. */
const FINISHED_COLLAPSE_AT = 5;

interface SubagentRowModel {
	agent: SubagentSnapshot;
	/** 0 = spawned by the session, 1 = spawned by a subagent (deeper clamps to 1). */
	depth: 0 | 1;
	/** Every agent in this row's top-level spawn tree is terminal. */
	finishedTree: boolean;
}

/**
 * Pre-order spawn tree in spawn order. Parent: the explicit wire link, else
 * the subagent whose transcript owns the spawning `task` call; anything
 * unresolved (or cyclic) is a top-level spawn of the session.
 */
export function buildSidebarSubagentRows(
	subagents: ReadonlyMap<string, SubagentSnapshot>,
	toolCallOwners: ReadonlyMap<string, string>,
): SubagentRowModel[] {
	const agents = [...subagents.values()].sort((a, b) => a.index - b.index);
	const children = new Map<string, SubagentSnapshot[]>();
	const roots: SubagentSnapshot[] = [];
	for (const agent of agents) {
		const linked = parentSubagentIdOf(agent);
		const owner = agent.parentToolCallId ? toolCallOwners.get(agent.parentToolCallId) : undefined;
		const parentId =
			linked && linked !== agent.id && subagents.has(linked)
				? linked
				: owner && owner !== agent.id && subagents.has(owner)
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
	const visitTree = (root: SubagentSnapshot) => {
		const start = rows.length;
		let finished = true;
		const visit = (agent: SubagentSnapshot, level: number) => {
			if (visited.has(agent.id)) return;
			visited.add(agent.id);
			if (isLiveSubagentStatus(agent.status)) finished = false;
			rows.push({ agent, depth: level === 0 ? 0 : 1, finishedTree: false });
			for (const child of children.get(agent.id) ?? []) visit(child, level + 1);
		};
		visit(root, 0);
		for (let i = start; i < rows.length; i++) rows[i]!.finishedTree = finished;
	};
	for (const root of roots) visitTree(root);
	// A parent cycle leaves members unreached from any root: show them flat.
	for (const agent of agents) if (!visited.has(agent.id)) visitTree(agent);
	return rows;
}

/** Live but waiting rather than working: paused glyph instead of a spinner. */
const WAITING_STATUSES: Record<string, true> = { parked: true, idle: true };

function StatusGlyph({ status }: { status: string }) {
	if (WAITING_STATUSES[status]) return <Pause aria-hidden className="text-(--sc-text-subtle)" />;
	if (isLiveSubagentStatus(status)) return <Spinner size="sm" />;
	if (status === "completed") return <Check aria-hidden className="text-(--sc-success)" />;
	if (status === "failed") return <X aria-hidden className="text-(--sc-danger)" />;
	if (status === "cancelled" || status === "aborted") return <Ban aria-hidden className="text-(--sc-text-subtle)" />;
	return <CircleDashed aria-hidden className="text-(--sc-text-subtle)" />;
}

/** Session rows indent nested sessions to pl-5.5; children sit one level in, grandchildren two. */
const INDENT = {
	top: ["pl-6", "pl-10"],
	nested: ["pl-9", "pl-13"],
} as const;

const ROW_CLASS =
	"relative flex w-full min-w-0 items-center gap-2 rounded-(--sc-radius-md) pr-2 text-left outline-none hover:bg-(--sc-hover) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--sc-focus-ring)";

const SubagentRow = memo(function SubagentRow({
	agent,
	depth,
	nested,
	rovingKey,
	onOpen,
	onMenu,
}: {
	agent: SubagentSnapshot;
	depth: 0 | 1;
	nested: boolean;
	rovingKey: string;
	onOpen: (id: string) => void;
	onMenu: (id: string, anchor: ContextMenuAnchor) => void;
}) {
	const t = useT();
	const live = isLiveSubagentStatus(agent.status);
	const now = useNowTick(live);
	const elapsed = live ? subagentElapsedMs(agent, now) : null;
	const statusLabel = t(statusMeta(agent.status).labelKey);
	const primary = subagentPrimaryLabel(agent);
	const showRole = primary !== agent.agent;
	const note = live ? (agent.progress?.lastIntent ?? agent.progress?.currentTool) : undefined;
	const tooltip = [
		showRole ? `${agent.agent} · ${subagentPrimaryLabel(agent, Number.POSITIVE_INFINITY)}` : agent.agent,
		statusLabel,
		note,
	]
		.filter(Boolean)
		.join("\n");
	return (
		<button
			className={cx(ROW_CLASS, "min-h-7 py-1", INDENT[nested ? "nested" : "top"][depth])}
			data-roving-item={rovingKey}
			data-sidebar-subagent={agent.id}
			data-status={agent.status}
			onClick={() => onOpen(agent.id)}
			onContextMenu={(event: ReactMouseEvent<HTMLButtonElement>) => {
				event.preventDefault();
				onMenu(agent.id, anchorFromEvent(event));
			}}
			onKeyDown={(event: ReactKeyboardEvent<HTMLButtonElement>) => {
				if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
				event.preventDefault();
				const rect = event.currentTarget.getBoundingClientRect();
				onMenu(agent.id, {
					x: Number.isFinite(rect.left) ? rect.left : 8,
					y: (Number.isFinite(rect.bottom) ? rect.bottom : 40) + 4,
				});
			}}
			tabIndex={-1}
			title={tooltip}
			type="button"
		>
			<span className="flex size-(--sc-icon-sm) shrink-0 items-center justify-center self-start pt-0.5 [&>svg]:size-(--sc-icon-sm)">
				<StatusGlyph status={agent.status} />
			</span>
			<span className="min-w-0 flex-1">
				<span className="block truncate text-sc-sm text-(--sc-text-muted)">
					{showRole && <span className="text-(--sc-text-subtle)">{agent.agent} · </span>}
					{primary}
					<span className="sr-only">, {statusLabel}</span>
				</span>
				{note && <span className="block truncate text-sc-xs text-(--sc-text-subtle)">{note}</span>}
			</span>
			{elapsed !== null && (
				<span className="shrink-0 self-start pt-0.5 text-sc-xs tabular-nums text-(--sc-text-subtle)">
					{formatElapsed(elapsed)}
				</span>
			)}
		</button>
	);
});

function SubagentGroup({ tabId, sessionKey, nested }: { tabId: string; sessionKey: string; nested: boolean }) {
	const t = useT();
	const rpc = useTabRpc();
	const groupId = useId();
	const ready = useSessionStore(s => s.status) === "ready";
	const subagents = useSubagentsStore(s => s.subagents);
	const toolCallOwners = useSubagentGraphStore(s => s.toolCallOwners);
	const rows = useMemo(() => buildSidebarSubagentRows(subagents, toolCallOwners), [subagents, toolCallOwners]);
	const liveCount = useMemo(() => rows.filter(row => isLiveSubagentStatus(row.agent.status)).length, [rows]);
	const explicit = useSidebarSubagentsStore(s => s.expanded[sessionKey]);
	const reveal = useSidebarSubagentsStore(s => s.reveal);
	const open = explicit ?? liveCount > 0;
	const [showFinished, setShowFinished] = useState(false);
	const [viewingId, setViewingId] = useState<string | null>(null);
	const [menu, setMenu] = useState<{ id: string; anchor: ContextMenuAnchor } | null>(null);
	const toggleRef = useRef<HTMLButtonElement>(null);

	// The transcript sheet / menu close when their agent leaves the roster.
	const viewing = viewingId !== null ? (subagents.get(viewingId) ?? null) : null;
	const menuAgent = menu ? (subagents.get(menu.id) ?? null) : null;
	useEffect(() => {
		if (viewingId !== null && !subagents.has(viewingId)) setViewingId(null);
	}, [viewingId, subagents]);

	useEffect(() => {
		if (!reveal || reveal.tabId !== tabId) return;
		useSidebarSubagentsStore.getState().setExpanded(sessionKey, true);
		useSidebarSubagentsStore.getState().consumeReveal(reveal.seq);
		toggleRef.current?.scrollIntoView?.({ block: "nearest" });
		toggleRef.current?.focus();
	}, [reveal, tabId, sessionKey]);

	const openAgent = useCallback((id: string) => setViewingId(id), []);
	const openMenu = useCallback((id: string, anchor: ContextMenuAnchor) => setMenu({ id, anchor }), []);

	if (rows.length === 0) return null;

	const foldFinished = rows.length > FINISHED_COLLAPSE_AT;
	const finishedCount = foldFinished ? rows.filter(row => row.finishedTree).length : 0;
	const visibleRows = foldFinished && !showFinished ? rows.filter(row => !row.finishedTree) : rows;
	const indent = INDENT[nested ? "nested" : "top"][0];
	const stoppable =
		menuAgent !== null &&
		(isLiveSubagentStatus(menuAgent.status) || menuAgent.status === "stale") &&
		menuAgent.kind !== "advisor";

	return (
		<div data-sidebar-subagents={sessionKey}>
			<button
				aria-controls={groupId}
				aria-expanded={open}
				className={cx(ROW_CLASS, "h-6 text-sc-xs text-(--sc-text-subtle)", indent)}
				data-roving-item={`subagents:${sessionKey}`}
				onClick={() => useSidebarSubagentsStore.getState().setExpanded(sessionKey, !open)}
				ref={toggleRef}
				tabIndex={-1}
				type="button"
			>
				<ChevronRight
					aria-hidden
					className={cx(
						"size-(--sc-icon-sm) shrink-0 transition-transform duration-(--sc-duration-fast)",
						open && "rotate-90",
					)}
				/>
				<span className="truncate">{t("sidebar.subagents.toggle", { count: rows.length })}</span>
				{!open && liveCount > 0 && (
					<span className="ml-auto flex shrink-0 items-center gap-1">
						<Spinner size="sm" />
						{t("sidebar.subagents.running", { count: liveCount })}
					</span>
				)}
			</button>
			{open && (
				<div aria-label={t("sidebar.subagents.group")} className="space-y-px" id={groupId} role="group">
					{visibleRows.map(row => (
						<SubagentRow
							agent={row.agent}
							depth={row.depth}
							key={row.agent.id}
							nested={nested}
							onMenu={openMenu}
							onOpen={openAgent}
							rovingKey={`subagent:${tabId}:${row.agent.id}`}
						/>
					))}
					{finishedCount > 0 && (
						<button
							aria-expanded={showFinished}
							className={cx(ROW_CLASS, "h-6 text-sc-xs text-(--sc-text-subtle)", indent)}
							data-roving-item={`subagents-done:${sessionKey}`}
							onClick={() => setShowFinished(value => !value)}
							tabIndex={-1}
							type="button"
						>
							<Check aria-hidden className="size-(--sc-icon-sm) shrink-0" />
							<span className="truncate">{t("sidebar.subagents.finished", { count: finishedCount })}</span>
						</button>
					)}
				</div>
			)}
			<SubagentTranscriptSheet agent={viewing} onClose={() => setViewingId(null)} />
			{menu && menuAgent && (
				<ContextMenu
					ariaLabel={t("sidebar.subagents.menu")}
					items={[
						{ id: "subagent-open", label: t("sidebar.subagents.open"), onSelect: () => setViewingId(menu.id) },
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
		</div>
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
	if (!runtime) return null;
	return (
		<SessionRuntimeProvider runtime={runtime}>
			<SubagentGroup nested={nested} sessionKey={sessionKey} tabId={tabId} />
		</SessionRuntimeProvider>
	);
});
