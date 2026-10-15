import {
	Bot,
	Brain,
	ClipboardList,
	Files,
	GitCompareArrows,
	GitFork,
	Globe,
	Hourglass,
	ListOrdered,
	MoreVertical,
	ScrollText,
	Terminal,
	X,
} from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useActiveTabRouteReady } from "../../hooks/use-active-tab-route";
import { useMediaQuery } from "../../hooks/use-media-query";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { actionShortcut } from "../../lib/keymap";
import { useTabsStore } from "../../stores/tabs";
import { COMPACT_SHELL_QUERY, type PanelTab, useUiStore } from "../../stores/ui";
import { IconButton, MenuButton, PanelErrorBoundary, Sheet } from "../common";
import { DiffPanel } from "../panels/DiffPanel";
import { FilesPanel } from "../panels/FilesPanel";
import { JobsPanel } from "../panels/JobsPanel";
import { LogPanel } from "../panels/LogPanel";
import { MemoryPanel } from "../panels/MemoryPanel";
import { PanelActionsContext } from "../panels/PanelChrome";
import { PlanPanel } from "../panels/PlanPanel";
import { PreviewPanel } from "../panels/PreviewPanel";
import { QueuePanel } from "../panels/QueuePanel";
import { SessionTreePanel } from "../panels/SessionTreePanel";
import { SubagentPanel } from "../panels/SubagentPanel";
import { TerminalPanel } from "../panels/TerminalPanel";

const MIN_WIDTH = 360;
const MAX_WIDTH = 840;
/** Docked default range (design-spec §8: 360–460px); dragging may widen it for diffs. */
const DEFAULT_MAX_WIDTH = 460;
const PANEL_WIDTH_PREF = "gui.panelWidth";
/** Share of the window an expanded file viewer takes (never narrower than the dragged width). */
const EXPANDED_VIEWPORT_SHARE = 0.55;

function defaultPanelWidth(): number {
	const viewportWidth = Number.isFinite(window.innerWidth) && window.innerWidth > 0 ? window.innerWidth : 1440;
	return Math.min(DEFAULT_MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(viewportWidth * 0.28)));
}

const VIEWS = [
	{ id: "terminal", labelKey: "panel.tabs.terminal", icon: Terminal },
	{ id: "diff", labelKey: "panel.tabs.diff", icon: GitCompareArrows },
	{ id: "preview", labelKey: "panel.tabs.preview", icon: Globe },
	{ id: "files", labelKey: "panel.tabs.files", icon: Files },
	{ id: "jobs", labelKey: "panel.tabs.jobs", icon: Hourglass },
	{ id: "plan", labelKey: "panel.tabs.plan", icon: ClipboardList },
	{ id: "logs", labelKey: "panel.tabs.logs", icon: ScrollText },
	{ id: "queue", labelKey: "panel.tabs.queue", icon: ListOrdered },
	{ id: "tree", labelKey: "panel.tabs.tree", icon: GitFork },
	{ id: "memory", labelKey: "panel.tabs.memory", icon: Brain },
] satisfies { id: PanelTab; labelKey: string; icon: typeof Files }[];
/** Not one of the switchable views: a dragged or menu-opened subagent row puts it in the panel. */
const SUBAGENT_VIEW = { id: "subagent", labelKey: "panel.tabs.subagent", icon: Bot } as const;

function PanelHeader() {
	const t = useT();
	const panelTab = useUiStore(s => s.panelTab);
	const setPanelTab = useUiStore(s => s.setPanelTab);
	const togglePanel = useUiStore(s => s.togglePanel);
	const current = panelTab === "subagent" ? SUBAGENT_VIEW : (VIEWS.find(view => view.id === panelTab) ?? VIEWS[0]);
	return (
		<div className="omp-panel-topbar drag-region flex min-h-(--sc-space-12) shrink-0 flex-wrap items-center gap-x-1 px-3">
			<span title={t(current.labelKey)} className="min-w-24 flex-1 truncate text-sc-sm font-medium text-(--sc-text)">
				{t(current.labelKey)}
			</span>
			<div className="no-drag flex shrink-0 items-center" aria-label={t("panel.primaryViews")}>
				{VIEWS.slice(0, 4).map(view => (
					<IconButton
						key={view.id}
						icon={<view.icon />}
						label={t(view.labelKey)}
						aria-pressed={panelTab === view.id}
						onClick={() => setPanelTab(view.id)}
						size="sm"
					/>
				))}
			</div>
			<MenuButton
				className="no-drag shrink-0"
				icon={<MoreVertical />}
				label={t("panel.viewOptions")}
				size="sm"
				align="end"
				items={VIEWS.slice(4).map(view => ({
					id: view.id,
					label: t(view.labelKey),
					icon: view.icon,
					checked: panelTab === view.id,
					onSelect: () => setPanelTab(view.id),
				}))}
			/>
			<IconButton
				className="no-drag shrink-0"
				icon={<X />}
				label={t("panel.close")}
				onClick={togglePanel}
				shortcut={actionShortcut("panel.toggle")}
				size="sm"
			/>
		</div>
	);
}

function SidePanelViews({ actionRef }: { actionRef: (element: HTMLDivElement | null) => void }) {
	const panelTab = useUiStore(s => s.panelTab);
	const panelSubagent = useUiStore(s => s.panelSubagent);
	const activeTabId = useTabsStore(s => s.activeTabId);
	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
			{panelTab !== "terminal" && panelTab !== "preview" && (
				<div
					className="flex min-h-(--sc-space-10) shrink-0 items-center justify-end gap-1 border-b border-(--sc-divider) px-3 py-2 empty:hidden"
					data-panel-actions
					ref={actionRef}
				/>
			)}
			<PanelErrorBoundary
				key={
					panelTab === "subagent"
						? `subagent:${panelSubagent?.tabId}:${panelSubagent?.agentId}`
						: `${activeTabId ?? "no-tab"}:${panelTab}`
				}
			>
				{panelTab === "terminal" && <TerminalPanel />}
				{panelTab === "preview" && <PreviewPanel />}
				{panelTab === "plan" && <PlanPanel />}
				{panelTab === "diff" && <DiffPanel />}
				{panelTab === "files" && <FilesPanel />}
				{panelTab === "logs" && <LogPanel />}
				{panelTab === "queue" && <QueuePanel />}
				{panelTab === "tree" && <SessionTreePanel />}
				{panelTab === "memory" && <MemoryPanel />}
				{panelTab === "jobs" && <JobsPanel />}
				{panelTab === "subagent" && <SubagentPanel subagent={panelSubagent} />}
			</PanelErrorBoundary>
		</div>
	);
}

/**
 * Side panel: contextual session detail with primary views and secondary tools.
 * Docked (non-modal, resizable) at ≥ 1000px; below that it
 * is a right Sheet with a scrim (design-spec §3, §8). In a split view it
 * floats over the panes instead of squeezing both.
 */
export function PanelContainer() {
	const t = useT();
	const togglePanel = useUiStore(s => s.togglePanel);
	const split = useTabsStore(s => s.split);
	const panelSide = useUiStore(s => s.panelSide);
	const routeReady = useActiveTabRouteReady();
	const compact = useMediaQuery(COMPACT_SHELL_QUERY);

	const [width, setWidth] = useState(defaultPanelWidth);
	const viewerExpanded = useUiStore(
		s =>
			(s.filePreviewExpanded && s.filePreviewPath !== null && s.panelTab === "files") ||
			(s.terminalExpanded && s.panelTab === "terminal"),
	);
	const [widthHydrated, setWidthHydrated] = useState(false);
	const dragging = useRef(false);
	const [actionsTarget, setActionsTarget] = useState<HTMLDivElement | null>(null);

	useEffect(() => {
		let cancelled = false;
		const prefs = window.omp?.prefs;
		if (typeof prefs?.get !== "function") {
			setWidthHydrated(true);
			return;
		}
		void prefs
			.get(PANEL_WIDTH_PREF)
			.then(value => {
				if (cancelled) return;
				const saved = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
				if (saved !== null) {
					const viewportLimit = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - 56));
					setWidth(Math.min(viewportLimit, Math.max(MIN_WIDTH, saved)));
				}
				setWidthHydrated(true);
			})
			.catch(() => {
				if (!cancelled) setWidthHydrated(true);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!widthHydrated || typeof window.omp?.prefs?.set !== "function") return;
		const timer = window.setTimeout(() => {
			void window.omp.prefs.set(PANEL_WIDTH_PREF, Math.round(width)).catch(() => {});
		}, 150);
		return () => window.clearTimeout(timer);
	}, [width, widthHydrated]);

	useEffect(() => {
		const clampToViewport = () => {
			const viewportLimit = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - 56));
			setWidth(current => Math.min(current, viewportLimit));
		};
		window.addEventListener("resize", clampToViewport);
		return () => window.removeEventListener("resize", clampToViewport);
	}, []);

	const startDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
		dragging.current = true;
		// A manual drag takes over from the viewer's Expand: the drag width rules again.
		if (useUiStore.getState().filePreviewExpanded) useUiStore.setState({ filePreviewExpanded: false });
		e.currentTarget.setPointerCapture(e.pointerId);
	}, []);

	const onDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
		if (!dragging.current) return;
		// A right-docked panel grows as the edge moves left; a left-docked one as it moves right.
		const left = useUiStore.getState().panelSide === "left";
		const anchor = left ? (e.currentTarget.parentElement?.getBoundingClientRect().left ?? 0) : window.innerWidth;
		const hostLimit = Math.min(MAX_WIDTH, Math.round(window.innerWidth * 0.55));
		const next = Math.min(hostLimit, Math.max(MIN_WIDTH, left ? e.clientX - anchor : anchor - e.clientX));
		setWidth(next);
	}, []);

	const endDrag = useCallback(() => {
		dragging.current = false;
	}, []);

	if (compact) {
		return (
			<Sheet
				bodyClassName="flex flex-col"
				onClose={togglePanel}
				open
				size="md"
				title={t("panel.title")}
				header={<PanelHeader />}
			>
				<div
					className={cx("flex min-h-0 flex-1 flex-col", !routeReady && "pointer-events-none")}
					aria-busy={!routeReady}
				>
					<PanelActionsContext.Provider value={actionsTarget}>
						<SidePanelViews actionRef={setActionsTarget} />
					</PanelActionsContext.Provider>
				</div>
			</Sheet>
		);
	}

	// Docked at the left (Settings › General › Window), the panel never floats:
	// over a split it would cover the session list.
	const floating = split !== null && panelSide === "right";
	return (
		<aside
			aria-busy={!routeReady}
			aria-label={t("panel.title")}
			className={cx(
				"omp-inspector relative flex h-full flex-col border-(--sc-border-subtle) bg-(--sc-surface-1)",
				panelSide === "left" ? "border-r" : "border-l",
				floating ? "absolute inset-y-0 right-0 z-(--sc-z-drawer) shadow-(--sc-shadow-lg)" : "shrink-0",
				!routeReady && "pointer-events-none",
			)}
			data-docked={floating ? "floating" : "docked"}
			data-side={panelSide}
			data-expanded={viewerExpanded || undefined}
			style={{
				width: viewerExpanded
					? Math.max(
							width,
							Math.min(window.innerWidth - 56, Math.round(window.innerWidth * EXPANDED_VIEWPORT_SHARE)),
						)
					: width,
			}}
		>
			<PanelHeader />
			<PanelActionsContext.Provider value={actionsTarget}>
				<SidePanelViews actionRef={setActionsTarget} />
			</PanelActionsContext.Provider>
			<div
				role="separator"
				aria-label={t("panel.resize")}
				aria-orientation="vertical"
				aria-valuemin={MIN_WIDTH}
				aria-valuemax={MAX_WIDTH}
				aria-valuenow={Math.round(width)}
				tabIndex={0}
				onPointerDown={startDrag}
				onPointerMove={onDrag}
				onPointerUp={endDrag}
				onKeyDown={event => {
					if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
					event.preventDefault();
					const viewportLimit = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - 56));
					const max = Math.min(MAX_WIDTH, viewportLimit);
					setWidth(current =>
						event.key === "Home"
							? MIN_WIDTH
							: event.key === "End"
								? max
								: Math.min(
										max,
										Math.max(
											MIN_WIDTH,
											current + ((event.key === "ArrowLeft") === (panelSide === "right") ? 24 : -24),
										),
									),
					);
				}}
				className={cx(
					"absolute inset-y-0 z-(--sc-z-raised) w-1 cursor-col-resize transition-colors duration-(--sc-duration-fast) hover:bg-(--sc-accent-border) focus-visible:bg-(--sc-accent) active:bg-(--sc-accent)",
					panelSide === "left" ? "right-0 translate-x-1/2" : "left-0 -translate-x-1/2",
				)}
			/>
		</aside>
	);
}
