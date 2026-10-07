/**
 * Live subagents as child rows directly under their sidebar session row. Only
 * a session open in a tab has a roster (its runtime's subagents store);
 * closed sessions render nothing. Each group subscribes to its own tab's
 * stores, so a progress frame re-renders that group — never the whole sidebar.
 *
 * Only live subagents (running, pending, parked/idle) are listed: a row
 * disappears as soon as its subagent reaches a terminal state. Rows share the
 * session row's look (ListRow), are part of the sidebar's roving list (arrow
 * keys) and open the subagent's live transcript against the owning tab — not
 * a second sidecar, since the parent's omp is still writing that session
 * file. Right-click (or the menu key) offers Stop.
 */

import { Pause } from "lucide-react";
import {
	memo,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useEffect,
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
import { anchorFromEvent, ContextMenu, type ContextMenuAnchor, ListRow, Spinner } from "../common";
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

interface SubagentRowModel {
	agent: SubagentSnapshot;
	/** 0 = spawned by the session, 1 = spawned by a subagent (deeper clamps to 1). */
	depth: 0 | 1;
}

/**
 * Live subagents as a pre-order spawn tree in spawn order. Parent: the
 * explicit wire link, else the subagent whose transcript owns the spawning
 * `task` call; a parent that is finished (hence not listed), unresolved or
 * cyclic makes the agent a top-level spawn of the session.
 */
export function buildSidebarSubagentRows(
	subagents: ReadonlyMap<string, SubagentSnapshot>,
	toolCallOwners: ReadonlyMap<string, string>,
): SubagentRowModel[] {
	const live = new Map<string, SubagentSnapshot>();
	for (const agent of subagents.values()) if (isLiveSubagentStatus(agent.status)) live.set(agent.id, agent);
	const agents = [...live.values()].sort((a, b) => a.index - b.index);
	const children = new Map<string, SubagentSnapshot[]>();
	const roots: SubagentSnapshot[] = [];
	for (const agent of agents) {
		const linked = parentSubagentIdOf(agent);
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

/**
 * Child rows line their glyph up under the session title (session rows sit at
 * pl-2.5, nested sessions at pl-5.5); sub-subagents go one step further in.
 */
const INDENT = {
	top: ["pl-9", "pl-13"],
	nested: ["pl-12", "pl-16"],
} as const;

const SubagentRow = memo(function SubagentRow({
	agent,
	depth,
	nested,
	selected,
	rovingKey,
	onOpen,
	onMenu,
}: {
	agent: SubagentSnapshot;
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
	const note = agent.progress?.lastIntent ?? agent.progress?.currentTool;
	const tooltip = [
		showRole ? `${agent.agent} · ${subagentPrimaryLabel(agent, Number.POSITIVE_INFINITY)}` : agent.agent,
		statusLabel,
		note,
	]
		.filter(Boolean)
		.join("\n");
	return (
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
			description={note}
			leading={<StatusGlyph status={agent.status} />}
			meta={elapsed !== null ? formatElapsed(elapsed) : undefined}
			onClick={() => onOpen(agent.id)}
			rowProps={{
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
				<>
					{showRole && <span className="text-(--sc-text-subtle)">{agent.agent} · </span>}
					{primary}
					<span className="sr-only">, {statusLabel}</span>
				</>
			}
			titleText={tooltip}
		/>
	);
});

function SubagentGroup({ tabId, sessionKey, nested }: { tabId: string; sessionKey: string; nested: boolean }) {
	const t = useT();
	const rpc = useTabRpc();
	const ready = useSessionStore(s => s.status) === "ready";
	const subagents = useSubagentsStore(s => s.subagents);
	const toolCallOwners = useSubagentGraphStore(s => s.toolCallOwners);
	const rows = useMemo(() => buildSidebarSubagentRows(subagents, toolCallOwners), [subagents, toolCallOwners]);
	const reveal = useSidebarSubagentsStore(s => s.reveal);
	const [viewingId, setViewingId] = useState<string | null>(null);
	const [menu, setMenu] = useState<{ id: string; anchor: ContextMenuAnchor } | null>(null);
	const groupRef = useRef<HTMLDivElement>(null);

	// The transcript stays open when its agent finishes (the row goes away);
	// sheet and menu close only when the agent leaves the roster.
	const viewing = viewingId !== null ? (subagents.get(viewingId) ?? null) : null;
	const menuAgent = menu ? (subagents.get(menu.id) ?? null) : null;
	useEffect(() => {
		if (viewingId !== null && !subagents.has(viewingId)) setViewingId(null);
	}, [viewingId, subagents]);

	useEffect(() => {
		if (!reveal || reveal.tabId !== tabId) return;
		useSidebarSubagentsStore.getState().consumeReveal(reveal.seq);
		const first = groupRef.current?.querySelector<HTMLElement>("[data-roving-item]");
		first?.scrollIntoView?.({ block: "nearest" });
		first?.focus();
	}, [reveal, tabId]);

	const openAgent = useCallback((id: string) => setViewingId(id), []);
	const openMenu = useCallback((id: string, anchor: ContextMenuAnchor) => setMenu({ id, anchor }), []);

	const stoppable = menuAgent !== null && isLiveSubagentStatus(menuAgent.status) && menuAgent.kind !== "advisor";

	return (
		<>
			{rows.length > 0 && (
				<div
					aria-label={t("sidebar.subagents.group")}
					className="space-y-px"
					data-sidebar-subagents={sessionKey}
					ref={groupRef}
					role="group"
				>
					{rows.map(row => (
						<SubagentRow
							agent={row.agent}
							depth={row.depth}
							key={row.agent.id}
							nested={nested}
							onMenu={openMenu}
							onOpen={openAgent}
							rovingKey={`subagent:${tabId}:${row.agent.id}`}
							selected={row.agent.id === viewingId}
						/>
					))}
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
	if (!runtime) return null;
	return (
		<SessionRuntimeProvider runtime={runtime}>
			<SubagentGroup nested={nested} sessionKey={sessionKey} tabId={tabId} />
		</SessionRuntimeProvider>
	);
});
