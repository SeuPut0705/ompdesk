import { Columns2, Rows2, X, XCircle } from "lucide-react";
import {
	type CSSProperties,
	type DragEvent,
	type KeyboardEvent,
	type PointerEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { useSessionList } from "../../hooks/use-session-list";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { SessionRuntimeProvider } from "../../stores/session-runtime-context";
import { ensureTabRuntime } from "../../stores/tab-runtime";
import { type SplitAxis, type SplitPlacement, tabDisplayTitle, useTabsStore } from "../../stores/tabs";
import { ChatStream } from "../chat/ChatStream";
import { WorkspaceDock } from "../chat/dock/WorkspaceDock";
import { IconButton, Spinner } from "../common";
import { DeviceChip } from "../remote/DeviceChip";
import { RemoteTabBanner } from "../remote/RemoteTabBanner";
import { InputArea } from "./InputArea";

const DIVIDER_SIZE = 5;
const RATIO_STEP = 0.05;

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

function SplitDropPreview({ placement }: { placement: SplitPlacement }) {
	const morph = "absolute transition-[inset] duration-(--sc-duration-fast) ease-(--sc-ease-standard)";
	return (
		<div aria-hidden className="omp-fade-in pointer-events-none absolute inset-0 z-(--sc-z-drawer)">
			<div className={cx(morph, "bg-(--sc-bg) opacity-50")} style={{ inset: PUSHED_INSET[placement] }} />
			<div
				data-split-ghost={placement}
				className={cx(
					morph,
					"rounded-(--sc-radius-lg) border border-(--sc-accent-border) bg-(--sc-accent-soft) shadow-(--sc-shadow-md)",
				)}
				style={{ inset: GHOST_INSET[placement] }}
			/>
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

function SessionPane({ tabId, split, label }: { tabId: string; split: boolean; label: string }) {
	const t = useT();
	const runtime = ensureTabRuntime(tabId);
	const tab = useTabsStore(state => state.tabs.find(entry => entry.id === tabId));
	const active = useTabsStore(state => state.activeTabId === tabId);
	const switchTab = useTabsStore(state => state.switchTab);
	const unsplit = useTabsStore(state => state.unsplit);
	if (!tab) return null;
	const busy =
		tab.status === "running" || tab.compacting === true || tab.status === "starting" || tab.status === "restarting";
	const failed = tab.status === "error" || tab.status === "exited";

	return (
		<SessionRuntimeProvider runtime={runtime}>
			<section
				aria-label={t("split.paneLabel", { title: label })}
				data-active={active ? "true" : "false"}
				onPointerDownCapture={() => {
					if (!active) void switchTab(tabId);
				}}
				className={cx(
					"omp-session-pane relative flex min-h-0 min-w-0 flex-col overflow-hidden",
					active && split && "omp-session-pane--active",
				)}
			>
				{split && (
					<header className="relative flex h-9 shrink-0 items-center gap-2 border-b border-(--sc-divider) pr-1 pl-3 text-sc-sm">
						{busy ? (
							<span aria-hidden className="inline-flex">
								<Spinner size="sm" />
							</span>
						) : failed ? (
							<XCircle aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-danger)" />
						) : null}
						<span className="min-w-0 flex-1 truncate font-medium text-(--sc-text)">{label}</span>
						{tab.device !== undefined && <DeviceChip deviceId={tab.device} />}
						<span className="omp-session-pane-cwd max-w-[45%] truncate font-mono text-sc-xs text-(--sc-text-muted)">
							{tab.cwd}
						</span>
						<IconButton
							icon={<X />}
							label={t("split.removePane")}
							onClick={() => void unsplit(tabId)}
							size="sm"
						/>
					</header>
				)}
				{tab.device !== undefined && <RemoteTabBanner deviceId={tab.device} />}
				<div className="relative flex min-h-0 flex-1 flex-col">
					<ChatStream />
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
		? { gridTemplateColumns: `${ratio}fr ${DIVIDER_SIZE}px ${1 - ratio}fr`, gridTemplateRows: "minmax(0, 1fr)" }
		: { gridTemplateColumns: "minmax(0, 1fr)", gridTemplateRows: `${ratio}fr ${DIVIDER_SIZE}px ${1 - ratio}fr` };
}

export function SplitWorkspace() {
	const t = useT();
	const { sessions } = useSessionList("global");
	const tabs = useTabsStore(state => state.tabs);
	const activeTabId = useTabsStore(state => state.activeTabId);
	const split = useTabsStore(state => state.split);
	const splitTab = useTabsStore(state => state.splitTab);
	const setSplitRatio = useTabsStore(state => state.setSplitRatio);
	const rootRef = useRef<HTMLDivElement>(null);
	const draggingRef = useRef(false);
	const pendingRatioRef = useRef<number | null>(null);
	const frameRef = useRef<number | null>(null);
	const [dragTabId, setDragTabId] = useState<string | null>(null);
	// Null until the drag is over the workspace: the ghost shows only where a drop would land.
	const [dropPlacement, setDropPlacement] = useState<SplitPlacement | null>(null);
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

	useEffect(
		() => () => {
			if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
		},
		[],
	);
	useEffect(() => {
		const onTabDrag = (event: Event) => {
			setDragTabId((event as CustomEvent<{ tabId: string | null }>).detail.tabId);
			setDropPlacement(null);
		};
		window.addEventListener("omp:tab-drag", onTabDrag);
		return () => window.removeEventListener("omp:tab-drag", onTabDrag);
	}, []);

	if (!activeTabId) return null;
	// A tab already occupying a pane is not a valid drop target — re-dropping
	// it would silently reset the ratio/axis (splitTab refuses it anyway; the
	// overlay must not invite the gesture).
	const canDrop =
		dragTabId !== null &&
		dragTabId !== activeTabId &&
		!(split && (split.firstTabId === dragTabId || split.secondTabId === dragTabId));
	const dropProps = {
		onDragOver: (event: DragEvent<HTMLDivElement>) => {
			if (!canDrop) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "move";
			setDropPlacement(placementFromPointer(event));
		},
		onDragLeave: (event: DragEvent<HTMLDivElement>) => {
			// dragleave also fires when crossing into a child; only leaving the workspace clears the ghost.
			const bounds = event.currentTarget.getBoundingClientRect();
			const inside =
				event.clientX > bounds.left &&
				event.clientX < bounds.right &&
				event.clientY > bounds.top &&
				event.clientY < bounds.bottom;
			if (!inside) setDropPlacement(null);
		},
		onDrop: (event: DragEvent<HTMLDivElement>) => {
			if (!canDrop || !dragTabId) return;
			event.preventDefault();
			void splitTab(dragTabId, placementFromPointer(event));
			setDragTabId(null);
			setDropPlacement(null);
		},
	};
	const dragLabel = dragTabId === null ? null : labelFor(dragTabId);
	const dragFeedback = (
		<>
			{canDrop && dropPlacement !== null && <SplitDropPreview placement={dropPlacement} />}
			{dragLabel !== null && <DragChip title={dragLabel} />}
		</>
	);
	if (!split) {
		return (
			<div ref={rootRef} className="omp-split-workspace relative grid min-h-0 flex-1" {...dropProps}>
				{pane(activeTabId, false)}
				{dragFeedback}
			</div>
		);
	}

	const applyRatio = (ratio: number) => {
		pendingRatioRef.current = ratio;
		if (frameRef.current !== null) return;
		frameRef.current = requestAnimationFrame(() => {
			frameRef.current = null;
			if (!rootRef.current || pendingRatioRef.current === null) return;
			Object.assign(rootRef.current.style, splitGrid(split.axis, pendingRatioRef.current));
		});
	};
	const ratioFromPointer = (event: PointerEvent<HTMLDivElement>) => {
		const bounds = rootRef.current?.getBoundingClientRect();
		if (!bounds) return split.ratio;
		const raw =
			split.axis === "columns"
				? (event.clientX - bounds.left) / bounds.width
				: (event.clientY - bounds.top) / bounds.height;
		return Math.min(0.8, Math.max(0.2, raw));
	};
	const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
		if (!draggingRef.current) return;
		draggingRef.current = false;
		event.currentTarget.releasePointerCapture(event.pointerId);
		const ratio = pendingRatioRef.current ?? split.ratio;
		pendingRatioRef.current = null;
		setSplitRatio(ratio);
	};
	const adjustFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
		const decrement = split.axis === "columns" ? event.key === "ArrowLeft" : event.key === "ArrowUp";
		const increment = split.axis === "columns" ? event.key === "ArrowRight" : event.key === "ArrowDown";
		if (!decrement && !increment) return;
		event.preventDefault();
		setSplitRatio(split.ratio + (increment ? RATIO_STEP : -RATIO_STEP));
	};

	return (
		<div
			ref={rootRef}
			className="omp-split-workspace relative grid min-h-0 flex-1"
			style={splitGrid(split.axis, split.ratio)}
			{...dropProps}
		>
			{pane(split.firstTabId, true)}
			<div
				role="separator"
				tabIndex={0}
				aria-label={t("split.resize")}
				aria-orientation={split.axis === "columns" ? "vertical" : "horizontal"}
				aria-valuemin={20}
				aria-valuemax={80}
				aria-valuenow={Math.round(split.ratio * 100)}
				onKeyDown={adjustFromKeyboard}
				onPointerDown={event => {
					draggingRef.current = true;
					pendingRatioRef.current = split.ratio;
					event.currentTarget.setPointerCapture(event.pointerId);
				}}
				onPointerMove={event => {
					if (draggingRef.current) applyRatio(ratioFromPointer(event));
				}}
				onPointerUp={finishDrag}
				onPointerCancel={finishDrag}
				className={cx(
					"omp-split-divider group relative z-(--sc-z-raised) touch-none bg-(--sc-divider) focus-visible:bg-(--sc-accent)",
					split.axis === "columns" ? "cursor-col-resize" : "cursor-row-resize",
				)}
			>
				<span className="pointer-events-none absolute inset-0 m-auto flex size-5 items-center justify-center rounded-full bg-(--sc-elevated) text-(--sc-text-muted) opacity-0 shadow-(--sc-shadow-sm) transition-opacity duration-(--sc-duration-fast) group-hover:opacity-100 group-focus-visible:opacity-100">
					{split.axis === "columns" ? (
						<Columns2 className="size-3" aria-hidden />
					) : (
						<Rows2 className="size-3" aria-hidden />
					)}
				</span>
			</div>
			{pane(split.secondTabId, true)}
			{dragFeedback}
		</div>
	);
}
