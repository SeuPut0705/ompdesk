import { ChevronDown, Files, GitCompareArrows, GitFork, Hourglass, ListOrdered, ScrollText, X } from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useActiveTabRouteReady } from "../../hooks/use-active-tab-route";
import { useMediaQuery } from "../../hooks/use-media-query";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { actionShortcut } from "../../lib/keymap";
import { useQueueStore } from "../../stores/queue";
import { useTabsStore } from "../../stores/tabs";
import { COMPACT_SHELL_QUERY, type PanelTab, useUiStore } from "../../stores/ui";
import { IconButton, MenuButton, PanelErrorBoundary, Sheet } from "../common";
import { DiffPanel } from "../panels/DiffPanel";
import { FilesPanel } from "../panels/FilesPanel";
import { JobsPanel } from "../panels/JobsPanel";
import { LogPanel } from "../panels/LogPanel";
import { PanelActionsContext } from "../panels/PanelChrome";
import { QueuePanel } from "../panels/QueuePanel";
import { SessionTreePanel } from "../panels/SessionTreePanel";

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
	{ id: "diff", labelKey: "panel.tabs.diff", icon: GitCompareArrows },
	{ id: "files", labelKey: "panel.tabs.files", icon: Files },
	{ id: "logs", labelKey: "panel.tabs.logs", icon: ScrollText },
	{ id: "queue", labelKey: "panel.tabs.queue", icon: ListOrdered },
	{ id: "tree", labelKey: "panel.tabs.tree", icon: GitFork },
	{ id: "jobs", labelKey: "panel.tabs.jobs", icon: Hourglass },
] satisfies { id: PanelTab; labelKey: string; icon: typeof Files }[];

function PanelHeader({ actionRef }: { actionRef: (element: HTMLDivElement | null) => void }) {
	const t = useT();
	const panelTab = useUiStore(s => s.panelTab);
	const setPanelTab = useUiStore(s => s.setPanelTab);
	const togglePanel = useUiStore(s => s.togglePanel);
	const queued = useQueueStore(s => s.steering.length + s.followUp.length);
	const current = VIEWS.find(view => view.id === panelTab) ?? VIEWS[0];
	const Icon = current.icon;
	return (
		<div className="omp-panel-topbar drag-region flex min-h-(--sc-space-12) shrink-0 items-center gap-1 px-3">
			<MenuButton
				className="no-drag min-w-0"
				icon={<Icon />}
				label={t("panel.switchView")}
				variant="ghost"
				size="sm"
				items={VIEWS.map(view => ({
					id: view.id,
					label: t(view.labelKey),
					icon: view.icon,
					checked: panelTab === view.id,
					onSelect: () => setPanelTab(view.id),
				}))}
			>
				<span className="truncate">{t(current.labelKey)}</span>
				{panelTab === "queue" && queued > 0 && <span className="text-sc-xs text-(--sc-text-muted)">{queued}</span>}
				<ChevronDown className="size-(--sc-icon-sm) text-(--sc-text-subtle)" />
			</MenuButton>
			<div className="no-drag flex shrink-0 items-center" aria-label={t("panel.primaryViews")}>
				{VIEWS.slice(0, 2)
					.filter(view => view.id !== panelTab)
					.map(view => (
						<IconButton
							key={view.id}
							icon={<view.icon />}
							label={t(view.labelKey)}
							onClick={() => setPanelTab(view.id)}
							size="sm"
						/>
					))}
			</div>
			<div className="ml-auto flex min-w-0 items-center" ref={actionRef} />
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

function SidePanelViews() {
	const panelTab = useUiStore(s => s.panelTab);
	const activeTabId = useTabsStore(s => s.activeTabId);
	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
			<PanelErrorBoundary key={`${activeTabId ?? "no-tab"}:${panelTab}`}>
				{panelTab === "diff" && <DiffPanel />}
				{panelTab === "files" && <FilesPanel />}
				{panelTab === "logs" && <LogPanel />}
				{panelTab === "queue" && <QueuePanel />}
				{panelTab === "tree" && <SessionTreePanel />}
				{panelTab === "jobs" && <JobsPanel />}
			</PanelErrorBoundary>
		</div>
	);
}

/**
 * Side panel: contextual detail for the open session — Changes, Files, Logs,
 * Queue, Tree, Jobs. Docked (non-modal, resizable) at ≥ 1000px; below that it
 * is a right Sheet with a scrim (design-spec §3, §8). In a split view it
 * floats over the panes instead of squeezing both.
 */
export function PanelContainer() {
	const t = useT();
	const togglePanel = useUiStore(s => s.togglePanel);
	const split = useTabsStore(s => s.split);
	const routeReady = useActiveTabRouteReady();
	const compact = useMediaQuery(COMPACT_SHELL_QUERY);

	const [width, setWidth] = useState(defaultPanelWidth);
	const viewerExpanded = useUiStore(
		s => s.filePreviewExpanded && s.filePreviewPath !== null && s.panelTab === "files",
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
		// Panel is right-anchored: dragging left grows it.
		const hostLimit = Math.min(MAX_WIDTH, Math.round(window.innerWidth * 0.55));
		const next = Math.min(hostLimit, Math.max(MIN_WIDTH, window.innerWidth - e.clientX));
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
				side="right"
				size="md"
				title={t("panel.title")}
				header={<PanelHeader actionRef={setActionsTarget} />}
			>
				<div
					className={cx("flex min-h-0 flex-1 flex-col", !routeReady && "pointer-events-none")}
					aria-busy={!routeReady}
				>
					<PanelActionsContext.Provider value={actionsTarget}>
						<SidePanelViews />
					</PanelActionsContext.Provider>
				</div>
			</Sheet>
		);
	}

	return (
		<aside
			aria-busy={!routeReady}
			aria-label={t("panel.title")}
			className={cx(
				"omp-inspector relative flex h-full flex-col border-l border-(--sc-border-subtle) bg-(--sc-surface-1)",
				split ? "absolute inset-y-0 right-0 z-(--sc-z-drawer) shadow-(--sc-shadow-lg)" : "shrink-0",
				!routeReady && "pointer-events-none",
			)}
			data-docked={split ? "floating" : "docked"}
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
			<PanelHeader actionRef={setActionsTarget} />
			<PanelActionsContext.Provider value={actionsTarget}>
				<SidePanelViews />
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
								: Math.min(max, Math.max(MIN_WIDTH, current + (event.key === "ArrowLeft" ? 24 : -24))),
					);
				}}
				className="absolute inset-y-0 left-0 z-(--sc-z-raised) w-1 -translate-x-1/2 cursor-col-resize transition-colors duration-(--sc-duration-fast) hover:bg-(--sc-accent-border) focus-visible:bg-(--sc-accent) active:bg-(--sc-accent)"
			/>
		</aside>
	);
}
