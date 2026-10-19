import { ChevronRight, Columns2, Rows2, X, XCircle } from "lucide-react";
import { type CSSProperties, type DragEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { worktreeLabel } from "../../../shared/project-origin";
import { type SplitNode, splitTabIds } from "../../../shared/split-layout";
import { useSessionList } from "../../hooks/use-session-list";
import { isDrawerMode, maxSplitPanes, useShellMode } from "../../hooks/use-shell-mode";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useProjectNames, useWorktreeKindLabels } from "../../lib/project-origin";
import { SessionRuntimeProvider } from "../../stores/session-runtime-context";
import { useSidebarPrefs } from "../../stores/sidebar-prefs";
import { ensureTabRuntime } from "../../stores/tab-runtime";
import { type SessionTab, type SplitAxis, type SplitPlacement, tabDisplayTitle, useTabsStore } from "../../stores/tabs";
import { type PanelSubagent, useUiStore } from "../../stores/ui";
import { ChatStream } from "../chat/ChatStream";
import { WorkspaceDock } from "../chat/dock/WorkspaceDock";
import { IconButton, LiveEdge, Spinner } from "../common";
import { DeviceChip } from "../remote/DeviceChip";
import { RemoteTabBanner } from "../remote/RemoteTabBanner";
import { InputArea } from "./composer/InputArea";
import { SidecarBanner } from "./SidecarBanner";
import { WorkBoardHost } from "./work-board/WorkBoard";

const DIVIDER_SIZE = 5;
const RATIO_STEP = 0.05;

/** `omp:subagent-drag` detail (SidebarSubagents rows); null when the drag ends. */
type SubagentDrag = PanelSubagent & { label: string };

function placementFromPointer(event: DragEvent<HTMLDivElement>): SplitPlacement {
	const bounds = event.currentTarget.getBoundingClientRect();
	const x = (event.clientX - bounds.left) / bounds.width;
	const y = (event.clientY - bounds.top) / bounds.height;
	return Math.min(x, 1 - x) < Math.min(y, 1 - y) ? (x < 0.5 ? "left" : "right") : y < 0.5 ? "top" : "bottom";
}

// Where the dropped session lands: the half the new pane will occupy, inset
// from the workspace edge so it reads as a floating panel, and the half the
// current view is pushed into. Both morph between zones (inset transitions).
const GHOST_INSET: Record<SplitPlacement, string> = {
	left: "var(--sc-space-2) calc(50% + var(--sc-space-1)) var(--sc-space-2) var(--sc-space-2)",
	right: "var(--sc-space-2) var(--sc-space-2) var(--sc-space-2) calc(50% + var(--sc-space-1))",
	top: "var(--sc-space-2) var(--sc-space-2) calc(50% + var(--sc-space-1)) var(--sc-space-2)",
	bottom: "calc(50% + var(--sc-space-1)) var(--sc-space-2) var(--sc-space-2) var(--sc-space-2)",
};
const PUSHED_INSET: Record<SplitPlacement, string> = {
	left: "0 0 0 50%",
	right: "0 50% 0 0",
	top: "50% 0 0 0",
	bottom: "0 0 50% 0",
};

function SplitDropPreview({ placement, replace }: { placement: SplitPlacement; replace: boolean }) {
	const morph = "absolute transition-[inset] duration-(--sc-duration-fast) ease-(--sc-ease-standard)";
	return (
		<div aria-hidden className="omp-fade-in pointer-events-none absolute inset-0 z-(--sc-z-drawer)">
			{!replace && (
				<div className={cx(morph, "bg-(--sc-bg) opacity-50")} style={{ inset: PUSHED_INSET[placement] }} />
			)}
			<div
				data-split-ghost={placement}
				className={cx(
					morph,
					"rounded-(--sc-radius-lg) border border-(--sc-accent-border) bg-(--sc-accent-soft) shadow-(--sc-shadow-md)",
				)}
				style={{ inset: replace ? "var(--sc-space-2)" : GHOST_INSET[placement] }}
			/>
		</div>
	);
}

/** A dragged subagent row over a pane: the ghost sits where the side panel will open. */
function SubagentDropPreview({ name }: { name: string }) {
	const t = useT();
	const side = useUiStore(state => state.panelSide);
	return (
		<div aria-hidden className="omp-fade-in pointer-events-none absolute inset-0 z-(--sc-z-drawer)">
			<div
				data-subagent-ghost={side}
				className="absolute flex items-center justify-center rounded-(--sc-radius-lg) border border-(--sc-accent-border) bg-(--sc-accent-soft) p-4 text-center text-sc-sm text-(--sc-text) shadow-(--sc-shadow-md)"
				style={{
					inset:
						side === "left"
							? "var(--sc-space-2) 60% var(--sc-space-2) var(--sc-space-2)"
							: "var(--sc-space-2) var(--sc-space-2) var(--sc-space-2) 60%",
				}}
			>
				{t("panel.subagent.drop", { name })}
			</div>
		</div>
	);
}

/** Gap between the cursor and the chip, and the chip's minimum distance from the window edge. */
const CHIP_OFFSET = 14;
const CHIP_MARGIN = 8;

/** The dragged session's title, following the cursor in place of the native drag image. */
function DragChip({ title }: { title: string }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const follow = (event: globalThis.DragEvent) => {
			const chip = ref.current;
			if (!chip) return;
			// Near the right or bottom edge the chip flips to the cursor's other side instead of clipping.
			const fitsRight = event.clientX + CHIP_OFFSET + chip.offsetWidth + CHIP_MARGIN <= window.innerWidth;
			const fitsBelow = event.clientY + CHIP_OFFSET + chip.offsetHeight + CHIP_MARGIN <= window.innerHeight;
			const x = fitsRight ? event.clientX + CHIP_OFFSET : event.clientX - CHIP_OFFSET - chip.offsetWidth;
			const y = fitsBelow ? event.clientY + CHIP_OFFSET : event.clientY - CHIP_OFFSET - chip.offsetHeight;
			chip.style.transform = `translate3d(${Math.max(CHIP_MARGIN, x)}px, ${Math.max(CHIP_MARGIN, y)}px, 0)`;
			chip.style.opacity = "1";
		};
		// dragover is throttled; dragenter adds a position at every element crossing.
		window.addEventListener("dragenter", follow, true);
		window.addEventListener("dragover", follow, true);
		return () => {
			window.removeEventListener("dragenter", follow, true);
			window.removeEventListener("dragover", follow, true);
		};
	}, []);
	return createPortal(
		<div
			ref={ref}
			aria-hidden
			data-split-drag-chip
			className="pointer-events-none fixed top-0 left-0 z-(--sc-z-tooltip) max-w-60 truncate rounded-(--sc-radius-full) border border-(--sc-border-subtle) bg-(--sc-elevated) px-2.5 py-1 text-sc-xs font-medium text-(--sc-text) opacity-0 shadow-(--sc-shadow-md) transition-opacity duration-(--sc-duration-fast)"
		>
			{title}
		</div>,
		document.body,
	);
}

export function SplitPaneHeader({ tab, label }: { tab: SessionTab; label: string }) {
	const t = useT();
	const removePane = useTabsStore(state => state.removePane);
	const groupAliases = useSidebarPrefs(state => state.groupAliases);
	// A paired host's folders are not on this computer: git here cannot tell about them.
	const projectNameOf = useProjectNames(
		useMemo(
			() => (tab.kind === "chat" || !tab.cwd || tab.device !== undefined ? [] : [tab.cwd]),
			[tab.kind, tab.cwd, tab.device],
		),
	);
	const kindLabels = useWorktreeKindLabels();
	const shown = tab.kind === "chat" || !tab.cwd ? null : projectNameOf(tab.cwd);
	// A running session lights the header's border (the composer's light); a waiting one keeps its warning look
	// elsewhere (the question card), so it never shows the light. Compacting and (re)starting keep the spinner.
	const running = tab.status === "running" && tab.awaitingInput === undefined;
	const busy = tab.compacting === true || tab.status === "starting" || tab.status === "restarting";
	const failed = tab.status === "error" || tab.status === "exited";
	return (
		<header
			className="relative flex h-9 shrink-0 items-center gap-2 border-b border-(--sc-divider) pr-1 pl-3 text-sc-sm"
			data-pane-running={running || undefined}
		>
			{running && <LiveEdge inside />}
			{busy ? (
				<span aria-hidden className="inline-flex">
					<Spinner size="sm" />
				</span>
			) : failed ? (
				<XCircle aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-danger)" />
			) : null}
			<span className="flex min-w-0 flex-1 items-center gap-1">
				<span
					title={shown?.tooltip ?? tab.cwd}
					className="omp-titlebar-project min-w-0 max-w-48 shrink-[4] truncate text-(--sc-text-muted)"
				>
					{shown ? (groupAliases[tab.cwd] ?? shown.worktree?.project ?? shown.name) : t("sidebar.chats")}
				</span>
				{shown?.worktree && (
					<>
						<ChevronRight
							aria-hidden
							className="omp-titlebar-crumb-sep size-(--sc-icon-sm) shrink-0 text-(--sc-text-subtle)"
						/>
						<span
							className="min-w-0 max-w-40 shrink-[3] truncate text-(--sc-text-muted)"
							data-pane-worktree=""
							title={shown.tooltip}
						>
							{worktreeLabel(shown.worktree, kindLabels)}
						</span>
					</>
				)}
				<ChevronRight
					aria-hidden
					className="omp-titlebar-crumb-sep size-(--sc-icon-sm) shrink-0 text-(--sc-text-subtle)"
				/>
				<span className="min-w-0 truncate font-medium text-(--sc-text)">{label}</span>
			</span>
			{tab.device !== undefined && <DeviceChip deviceId={tab.device} />}
			<IconButton icon={<X />} label={t("split.removePane")} onClick={() => void removePane(tab.id)} size="sm" />
		</header>
	);
}

function SessionPane({ tabId, split, label }: { tabId: string; split: boolean; label: string }) {
	const t = useT();
	const runtime = ensureTabRuntime(tabId);
	const tab = useTabsStore(state => state.tabs.find(entry => entry.id === tabId));
	const active = useTabsStore(state => state.activeTabId === tabId);
	const switchTab = useTabsStore(state => state.switchTab);
	if (!tab) return null;

	return (
		<SessionRuntimeProvider runtime={runtime}>
			<section
				aria-label={t("split.paneLabel", { title: label })}
				data-tab-id={tabId}
				data-active={active ? "true" : "false"}
				onPointerDownCapture={() => {
					if (!active) void switchTab(tabId);
				}}
				className={cx(
					"omp-session-pane relative flex min-h-0 min-w-0 flex-col overflow-hidden",
					active && split && "omp-session-pane--active",
				)}
			>
				{split && <SplitPaneHeader tab={tab} label={label} />}
				{tab.device !== undefined && <RemoteTabBanner deviceId={tab.device} />}
				<SidecarBanner />
				<div className="relative flex min-h-0 flex-1 flex-col">
					<ChatStream />
					<WorkBoardHost />
					<div className="omp-composer-region relative shrink-0 bg-transparent pt-2">
						<div className="omp-composer-shell relative w-full">
							<WorkspaceDock />
						</div>
					</div>
				</div>
				<InputArea />
			</section>
		</SessionRuntimeProvider>
	);
}

function splitGrid(axis: SplitAxis, ratio: number): CSSProperties {
	return axis === "columns"
		? {
				gridTemplateColumns: `minmax(0, ${ratio}fr) ${DIVIDER_SIZE}px minmax(0, ${1 - ratio}fr)`,
				gridTemplateRows: "minmax(0, 1fr)",
			}
		: {
				gridTemplateColumns: "minmax(0, 1fr)",
				gridTemplateRows: `minmax(0, ${ratio}fr) ${DIVIDER_SIZE}px minmax(0, ${1 - ratio}fr)`,
			};
}

function SplitBranch({
	node,
	path,
	renderPane,
}: {
	node: SplitNode;
	path: ("first" | "second")[];
	renderPane: (tabId: string) => ReactNode;
}) {
	const t = useT();
	const setRatio = useTabsStore(state => state.setSplitRatio);
	const root = useRef<HTMLDivElement>(null);
	const dragging = useRef(false);
	const pending = useRef<number | null>(null);
	if ("tabId" in node) return renderPane(node.tabId);
	const finish = () => {
		if (!dragging.current) return;
		dragging.current = false;
		setRatio(pending.current ?? node.ratio, path);
		pending.current = null;
	};
	return (
		<div ref={root} className="grid min-h-0 min-w-0" style={splitGrid(node.axis, node.ratio)}>
			<SplitBranch node={node.first} path={[...path, "first"]} renderPane={renderPane} />
			<div
				role="separator"
				tabIndex={0}
				aria-label={t("split.resize")}
				aria-orientation={node.axis === "columns" ? "vertical" : "horizontal"}
				aria-valuemin={20}
				aria-valuemax={80}
				aria-valuenow={Math.round(node.ratio * 100)}
				onKeyDown={event => {
					const decrease = node.axis === "columns" ? event.key === "ArrowLeft" : event.key === "ArrowUp";
					const increase = node.axis === "columns" ? event.key === "ArrowRight" : event.key === "ArrowDown";
					if (!decrease && !increase) return;
					event.preventDefault();
					setRatio(node.ratio + (increase ? RATIO_STEP : -RATIO_STEP), path);
				}}
				onPointerDown={event => {
					dragging.current = true;
					pending.current = node.ratio;
					event.currentTarget.setPointerCapture(event.pointerId);
				}}
				onPointerMove={event => {
					if (!dragging.current || !root.current) return;
					const bounds = root.current.getBoundingClientRect();
					const raw =
						node.axis === "columns"
							? (event.clientX - bounds.left) / bounds.width
							: (event.clientY - bounds.top) / bounds.height;
					pending.current = Math.min(0.8, Math.max(0.2, raw));
					Object.assign(root.current.style, splitGrid(node.axis, pending.current));
				}}
				onPointerUp={event => {
					finish();
					event.currentTarget.releasePointerCapture(event.pointerId);
				}}
				onPointerCancel={finish}
				className={cx(
					"omp-split-divider group relative z-(--sc-z-raised) touch-none bg-(--sc-divider) focus-visible:bg-(--sc-accent)",
					node.axis === "columns" ? "cursor-col-resize" : "cursor-row-resize",
				)}
			>
				<span className="pointer-events-none absolute inset-0 m-auto flex size-5 items-center justify-center rounded-full bg-(--sc-elevated) text-(--sc-text-muted) opacity-0 shadow-(--sc-shadow-sm) transition-opacity duration-(--sc-duration-fast) group-hover:opacity-100 group-focus-visible:opacity-100">
					{node.axis === "columns" ? (
						<Columns2 className="size-3" aria-hidden />
					) : (
						<Rows2 className="size-3" aria-hidden />
					)}
				</span>
			</div>
			<SplitBranch node={node.second} path={[...path, "second"]} renderPane={renderPane} />
		</div>
	);
}

export function SplitWorkspace() {
	const t = useT();
	const { sessions } = useSessionList("global");
	const tabs = useTabsStore(state => state.tabs);
	const activeTabId = useTabsStore(state => state.activeTabId);
	const split = useTabsStore(state => state.split);
	const splitTab = useTabsStore(state => state.splitTab);
	const switchTab = useTabsStore(state => state.switchTab);
	const single = isDrawerMode(useShellMode());
	const [dragTabId, setDragTabId] = useState<string | null>(null);
	// A sidebar subagent row in flight: dropping it on any pane opens it in the side panel.
	const [dragSubagent, setDragSubagent] = useState<SubagentDrag | null>(null);
	// Null until the drag is over the workspace: the ghost shows only where a drop would land.
	const [dropTarget, setDropTarget] = useState<{ tabId: string; placement: SplitPlacement } | null>(null);
	const sessionsById = useMemo(() => new Map(sessions.map(session => [session.id, session])), [sessions]);
	const sessionsByPath = useMemo(() => new Map(sessions.map(session => [session.path, session])), [sessions]);
	const labelFor = (tabId: string) => {
		const tab = tabs.find(entry => entry.id === tabId);
		if (!tab) return null;
		// The index lists this device's sessions; a remote tab's path may coincide with one of them.
		const indexedSession =
			tab.device !== undefined
				? undefined
				: ((tab.sessionPath ? sessionsByPath.get(tab.sessionPath) : undefined) ??
					(tab.sessionId ? sessionsById.get(tab.sessionId) : undefined));
		return tabDisplayTitle(tab, tabs, indexedSession, t("sidebar.untitled"));
	};
	const pane = (tabId: string, isSplit: boolean) => {
		const label = labelFor(tabId);
		return label === null ? null : <SessionPane tabId={tabId} split={isSplit} label={label} />;
	};

	useEffect(() => {
		const onTabDrag = (event: Event) => {
			setDragTabId((event as CustomEvent<{ tabId: string | null }>).detail.tabId);
			setDropTarget(null);
		};
		const onSubagentDrag = (event: Event) => {
			setDragSubagent((event as CustomEvent<SubagentDrag | null>).detail);
			setDropTarget(null);
		};
		window.addEventListener("omp:tab-drag", onTabDrag);
		window.addEventListener("omp:subagent-drag", onSubagentDrag);
		return () => {
			window.removeEventListener("omp:tab-drag", onTabDrag);
			window.removeEventListener("omp:subagent-drag", onSubagentDrag);
		};
	}, []);

	if (!activeTabId) return null;
	const visible = split ? splitTabIds(split) : [activeTabId];
	// A finger cannot drag a session onto a pane: no split is made on a phone or a portrait tablet.
	const canDrop = !single && dragTabId !== null && !visible.includes(dragTabId);
	// Every grid around a pane has definite tracks: the pane is a size container
	// (`omp-workspace`), and an auto track laid it out at an indefinite height to
	// size itself first. Its height queries then matched a short pane and unmatched
	// again in the same layout, so every work card in the transcript was restyled
	// twice per frame.
	const renderPane = (tabId: string) => (
		<div
			key={tabId}
			data-split={split && !single ? "pane" : undefined}
			className="relative grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)]"
			onDragOver={event => {
				if (!canDrop && !dragSubagent) return;
				event.preventDefault();
				event.stopPropagation();
				event.dataTransfer.dropEffect = "move";
				setDropTarget({ tabId, placement: placementFromPointer(event) });
			}}
			onDragLeave={event => {
				const bounds = event.currentTarget.getBoundingClientRect();
				if (
					event.clientX <= bounds.left ||
					event.clientX >= bounds.right ||
					event.clientY <= bounds.top ||
					event.clientY >= bounds.bottom
				)
					setDropTarget(current => (current?.tabId === tabId ? null : current));
			}}
			onDrop={event => {
				if (dragSubagent) {
					event.preventDefault();
					event.stopPropagation();
					useUiStore.getState().openSubagentPanel({ tabId: dragSubagent.tabId, agentId: dragSubagent.agentId });
					setDragSubagent(null);
					setDropTarget(null);
					return;
				}
				if (!canDrop || !dragTabId) return;
				event.preventDefault();
				event.stopPropagation();
				void splitTab(dragTabId, placementFromPointer(event), tabId);
				setDragTabId(null);
				setDropTarget(null);
			}}
		>
			{pane(tabId, split !== null && !single)}
			{dragSubagent && dropTarget?.tabId === tabId && <SubagentDropPreview name={dragSubagent.label} />}
			{canDrop && dropTarget?.tabId === tabId && (
				<SplitDropPreview placement={dropTarget.placement} replace={visible.length >= maxSplitPanes()} />
			)}
		</div>
	);
	const dragLabel = dragSubagent ? dragSubagent.label : dragTabId ? labelFor(dragTabId) : null;
	const workspace = (
		<div className="omp-split-workspace relative grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)]">
			<SplitBranch
				node={single ? { tabId: activeTabId } : (split ?? { tabId: activeTabId })}
				path={[]}
				renderPane={renderPane}
			/>
			{dragLabel !== null && <DragChip title={dragLabel} />}
		</div>
	);
	// One pane at a time, whatever split view the window holds: a switcher names the others.
	if (!single || !split) return workspace;
	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			<div aria-label={t("split.switcher")} className="omp-pane-switcher" role="group">
				{splitTabIds(split).map(id => (
					<button aria-pressed={id === activeTabId} key={id} onClick={() => void switchTab(id)} type="button">
						<span className="truncate">{labelFor(id)}</span>
					</button>
				))}
			</div>
			{workspace}
		</div>
	);
}
